// The CONDUCTOR dispatch. Admission opens the session that SHAPES the story; the «vai» to BUILD is not the admission —
// it is the service's PLAN CRITIC (runner/critics.ts: a clean-context reviewer of acceptance + plan), or the owner's
// «Pode construir» when the board's `spec` box is off (fase 6, owner decision 2).
//
// The linear Kanban stops being the control flow for a conducted story: ONE interactive agent session (the
// `harness-conductor` skill) carries the card through shape → build → verify → publish in one context, and
// the columns become a PROJECTION of its progress. This module is the declarative switch that turns that on:
//
//   board.yaml
//     conductor: { enabled: true, fromStatus: <status id>, maxSessions: 2, model: opus }
//
// THE HYBRID PIPELINE: with the dispatch on, the board runs in the conductor mode (types.ts `pipelineMode`; a board
// may still declare `pipeline: columns`). There the middle columns the conductor makes redundant — the `_base` steps
// marked `autorunOnlyInColumns` — fire no skill. Only where the step also has `autorun: true` (Entrevista, Jornada,
// Telas) does that change anything: their skills stay as manual commands, and a card nobody conducts just passes
// through them (cascade-decision.ts), so a specified story reaches «A fazer» and waits there, in its column order, for
// a slot (a card stuck in one of them is a passage stall — stall-watch.ts). The marked `autorun: false` steps (Dúvidas,
// Pronto p/ dev, Revisão de código) stop for a manual move in both modes.
//
// When a story card ENTERS `fromStatus` (evaluateAutorunOnEntry — the single chokepoint every entry path
// already funnels through: a drag, an MCP move, an accept, the watcher, the cascade forward):
//
//   1. ADMIT   — stamp `routing.driver: conductor` on the card (the SAME per-card lock every writer uses) and
//                append it to a DURABLE queue. From this instant the cascade and the engine are silent for the
//                card (cascade-decision.ts / engine.ts), so no column skill races the conductor into it.
//   2. PUMP    — serialized; for each queued card, in the board's ORDER (a bug's severity first, then the card's position
//                in its column, FIFO on ties — compareConductorQueue), if the board has a free conductor slot (`maxSessions`, live
//                conductors counted per board) spawn the session through the SAME door `claude_new` uses
//                (`spawnWorkSession`: admission + resource probe, worktree, card claim, scoped MCP token,
//                tmux, role `implement`), whose first prompt is `/harness-conductor <board>/<cardId>`.
//                The excess WAITS; the pump runs again on every fleet tick (instrumentation.ts), which is also
//                where a dead conductor is noticed — so a slot freed by a session ending is re-used on the
//                next tick with no extra wiring.
//   2b. ADOPT  — WP5-F2: the pump also admits ORPHANS — story cards already sitting in `fromStatus` with no driver
//                (they were there before the switch, or their entry event was lost), which the entry chokepoint never
//                sees again (isConductorOrphan). Same verdict as the entry, so it is idempotent with it. A card someone
//                is on (a live session of any driver, a claim, a run, a merge) is never adopted (adoptOrphans).
//   3. END     — a conductor whose story is OVER (card delivered/terminal, discontinued, trashed, or no longer
//                conducted) stops holding a slot at once, and — after a short grace, and only when everything
//                it produced is integrated — is asked to `/exit` (in a real case, conductors sat idle
//                in a delivered column for days and the queue waited on them the whole time).
//
// Idempotent end to end: the driver write is a no-op when already set, the queue dedupes by card, the pump
// skips a card that already has a live conductor, and the claim refuses a second implementer anyway.
//
// What this module deliberately does NOT do:
//   • re-dispatch a card whose conductor DIED. The driver stays (no stale column run), the claim is released
//     by the fleet reconcile, and the operator decides: reopen a conductor (`claude_new` with the conductor
//     task) or clear the driver (`set_card_driver`). An automatic respawn loop over a session that keeps dying
//     is the failure mode a human must see, not one to paper over. (A conductor that ENDED on purpose after handing
//     its submission to the merge train — `worktree_discard({…, handoff: true})` — is not a death: conductor-handoff.ts
//     re-admits that card, once per verdict and with a cap on consecutive returns, when the train decides.)
//   • spawn anything while the live master switch is off or the board gate holds (board-pace.ts: the board is
//     disarmed or paused): the queue waits, and resumes by itself when the switch comes back.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { conductorBatchTask, conductorCommand, conductorEntryVerdict, conductorModelCapFor, conductorModelFor, conductorTask, CONDUCTOR_SCOPE_WAIT_KIND, CONDUCTOR_SKILL, isConducted, resolveConductorPolicy } from "@/lib/storymap/driver";
import type { FeatureKey } from "@/lib/storymap/feature-key";
import type { BugSeverity } from "@/lib/storymap/frameworks";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { sessionCardIds, type AgentSession, type SessionWorkVerdict } from "./session-worktree";
import type { SpawnSessionInput, SpawnSessionResult } from "./session-spawn";
import type { GateVerdict } from "./capacity-governor";
import { gateAdmitsCard, gateOf, paceCap, type BoardGate, type BoardGatePort } from "./board-pace";
import { batchable, sharesFeature } from "./conductor-batch";

// ── PURE policy (lives in ../driver.ts — isomorphic, so the move risk class can ask it too) ──────────────
export {
  conductorEntryVerdict,
  conductorModelCapFor,
  conductorModelFor,
  conductorTask,
  CONDUCTOR_DEFAULT_MODEL,
  CONDUCTOR_SCOPE_WAIT_KIND,
  resolveConductorPolicy,
  type ConductorEntryVerdict,
  type ResolvedConductorPolicy,
} from "@/lib/storymap/driver";

/**
 * Is `s` a LIVE conductor session? PURE. A conductor is alive while its tmux answers. When the tmux probe could
 * not answer (`liveTmux === null`) every registered conductor counts as alive — the fail-closed direction for a
 * CAP (the worst case is waiting one more tick, never spawning a third conductor on a full box). A session with
 * no tmux handle (it should not happen for a dispatched conductor) counts by its registry heartbeat.
 *
 * WP5-F2 — o TMUX ZUMBI não é condutor vivo: a árvore de trabalho da linha (worktree/cwd) foi APAGADA e o claude
 * segue no prompt, sem ter onde trabalhar (num caso real, o terminal com cwd «(deleted)» contava como uma das
 * vagas do board enquanto vários cards esperavam). `treeGone` é a prova (IO na borda); ausente ⇒ ninguém é zumbi. Um tmux
 * SEM linha no registro nunca chega aqui — só linhas contam — e o passe de órfãos o encerra.
 */
export function isLiveConductor(
  s: AgentSession,
  liveTmux: ReadonlySet<string> | null,
  heartbeatAlive: (s: AgentSession) => boolean,
  treeGone?: (s: AgentSession) => boolean,
): boolean {
  if (s.driver !== "conductor") return false;
  if (treeGone?.(s)) return false;
  return isLiveSession(s, liveTmux, heartbeatAlive);
}

/**
 * A linha do registro é de uma sessão VIVA, qualquer que seja o driver? PURA — a mesma prova do {@link isLiveConductor}
 * (o tmux responde; sem tmux, o heartbeat; sonda sem resposta ⇒ viva, a direção segura), sem o filtro do zumbi: quem
 * pergunta é a ADOÇÃO de órfãos, que muda o card, e um terminal com a árvore apagada ainda é alguém que o operador vê.
 */
export function isLiveSession(s: AgentSession, liveTmux: ReadonlySet<string> | null, heartbeatAlive: (s: AgentSession) => boolean): boolean {
  if (!s.tmuxSession) return heartbeatAlive(s);
  if (liveTmux === null) return true;
  return liveTmux.has(s.tmuxSession);
}

/**
 * The tmux slug of a conductor dispatch: the card id plus a short per-dispatch suffix, so two dispatches of the
 * same card never share a tmux name (see the spawn site). PURE.
 */
export function conductorSessionSlug(cardId: string, now: number): string {
  return `conductor-${cardId}-${now.toString(36).slice(-4)}`;
}

/**
 * Live conductors per board, counted by the PROCESS that hosts them: rows that name the same tmux session are one
 * conductor (a tmux hosts one `claude`). A row with no tmux (heartbeat-only) counts on its own. PURE.
 */
export function countLiveConductorsByBoard(liveConductors: readonly AgentSession[]): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const s of liveConductors) {
    if (!s.board) continue;
    const key = s.tmuxSession ? `tmux:${s.tmuxSession}` : `session:${s.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(s.board, (out.get(s.board) ?? 0) + 1);
  }
  return out;
}

/** As vagas de condutor de UM board, como o nav e o Kanban as mostram (WP5-F2). */
export interface ConductorSlotFacts {
  board: string;
  /** condutores que OCUPAM vaga agora: vivos, sem zumbi e sem quem já terminou a story. */
  used: number;
  /** o teto do board (`conductor.maxSessions`); 0 = condutor desligado neste board. */
  max: number;
  /** a vaga extra do board agora (para card pequeno) — aberta, ou fechada e por qual trava. */
  extra: { open: boolean; why: string };
  /** entradas da fila deste board, e quantas delas esperam VAGA (as outras esperam conta, orçamento, autorun…). */
  queued: number;
  waitingForSlot: number;
}

/**
 * As vagas de condutor de um board — PURA, a MESMA conta do pump ({@link countLiveConductorsByBoard} sobre os vivos que
 * não terminaram), para o nav nunca dizer um número diferente do que o despacho usa. `liveConductors` já vem filtrado
 * por {@link isLiveConductor}; `extra` é o veredito da vaga extra do board (extra-slot.ts), `null` = não medido.
 */
export function conductorSlotFacts(
  board: string,
  input: {
    config: Pick<BoardConfig, "conductor"> | null;
    liveConductors: readonly AgentSession[];
    finished?: ReadonlySet<string>;
    queue: readonly ConductorQueueEntry[];
    extra: { open: boolean; why: string } | null;
    /** o portão do board (board-pace.ts): pausado ⇒ nenhuma vaga; devagar ⇒ uma, sem a extra. Ausente ⇒ ritmo normal. */
    gate?: Pick<BoardGate, "level" | "held" | "why">;
  },
): ConductorSlotFacts {
  const policy = resolveConductorPolicy(input.config);
  const paced = input.gate && (input.gate.held || input.gate.level === "slow") ? input.gate : null;
  const holding = input.liveConductors.filter((s) => s.board === board && !input.finished?.has(s.sessionId));
  const mine = input.queue.filter((e) => e.board === board);
  return {
    board,
    used: countLiveConductorsByBoard(holding).get(board) ?? 0,
    // o MESMO teto que o pump aplica (paceCap): o nav nunca mostra duas vagas num board que anda um por vez
    max: paced ? paceCap(policy?.maxSessions ?? 0, paced) : (policy?.maxSessions ?? 0),
    extra: paced
      ? { open: false, why: paced.held ? paced.why : "o board está em ritmo devagar (um card por vez)" }
      : input.extra
        ? { open: input.extra.open, why: input.extra.why }
        : { open: false, why: "a vaga extra não foi medida agora" },
    queued: mine.length,
    waitingForSlot: mine.filter((e) => isSlotWait(e.lastWaitKind)).length,
  };
}

/**
 * Why a conductor's story is OVER — or null while it is still the conductor's to carry. PURE. Over = the card is
 * gone (trashed), no longer conducted, being discontinued (`mode: retire`), or in a terminal status (delivered
 * is a subset of terminal). An unreadable board config cannot say "terminal", so it answers null (keeps the slot).
 */
export function conductorDoneReason(card: Card | null, config: BoardConfig | null): string | null {
  if (!card) return "o card não existe mais";
  if (!isConducted(card)) return "o card não tem mais routing.driver: conductor";
  if (card.mode === "retire") return "o card está sendo descontinuado";
  if (card.deferred) return "o card foi adiado (não agora)";
  const def = card.status ? config?.statuses.find((s) => s.id === card.status) : undefined;
  if (def?.delivered) return `o card foi entregue (${card.status})`;
  if (def?.terminal) return `o card está num status terminal (${card.status})`;
  return null;
}

/**
 * The live conductors whose story is over, by sessionId → why. A card that could not be READ (the reader threw)
 * is not "gone": that conductor keeps its slot — the fail-closed direction for a cap.
 */
export async function finishedConductors(
  deps: Pick<ConductorDeps, "readCard" | "readBoardConfig">,
  live: readonly AgentSession[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of live) {
    if (!s.board || !s.cardId) continue;
    const board = s.board;
    const [card, config] = await Promise.all([
      deps.readCard(board, s.cardId).then((c) => c, () => undefined),
      deps.readBoardConfig(board).catch(() => null),
    ]);
    if (card === undefined) continue;
    const why = conductorDoneReason(card, config);
    if (!why) continue;
    // fase 7 — o LOTE: a sessão só acaba quando TODOS os cards dela acabaram. Um líder ENTREGUE com item aberto segura
    // a sessão (o item ainda é dela); um líder que SAIU (lixeira, adiado, sem driver, descontinuado) é um líder
    // derrubado — a sessão acaba e os itens voltam à fila ({@link batchLeadDropped}, no fim da sessão).
    const items = sessionCardIds(s).filter((id) => id !== s.cardId);
    if (items.length && isDeliveredOrTerminal(card, config)) {
      let open = false;
      for (const id of items) {
        const item = await deps.readCard(board, id).then((c) => c, () => undefined);
        if (item === undefined || !conductorDoneReason(item, config)) {
          open = true; // ilegível agora conta como aberto (a direção segura para uma vaga)
          break;
        }
      }
      if (open) continue;
      out.set(s.sessionId, `${why} (e todos os itens do lote acabaram)`);
      continue;
    }
    out.set(s.sessionId, why);
  }
  return out;
}

/** O card acabou por ENTREGA ou status terminal (e não por ter saído do condutor)? PURA. */
function isDeliveredOrTerminal(card: Card | null, config: BoardConfig | null): boolean {
  const def = card?.status ? config?.statuses.find((x) => x.id === card.status) : undefined;
  return !!card && isConducted(card) && card.mode !== "retire" && !card.deferred && !!(def?.delivered || def?.terminal);
}

/**
 * A sessão de LOTE acabou porque o LÍDER saiu (lixeira, adiado, sem driver, descontinuado) com itens ainda dela? Esses
 * itens perdem a marca do lote e voltam à fila normal no fim da sessão (plano §5, «Session end»). PURA.
 */
export function batchLeadDropped(s: Pick<AgentSession, "cardId" | "batch">, lead: Card | null, config: BoardConfig | null): boolean {
  return sessionCardIds(s).length > 1 && !isDeliveredOrTerminal(lead, config);
}

// ── the durable queue ───────────────────────────────────────────────────────────────────────────────────

/** One card waiting for a conductor slot. Durable: a restart must not strand a card that already has the
 *  driver (the cascade is silent for it — a lost queue entry would be a card nobody ever picks up). */
export interface ConductorQueueEntry {
  board: string;
  cardId: string;
  queuedAt: string;
  /** spawn attempts that failed for a reason no slot explains (plumbing) — bounded by {@link CONDUCTOR_MAX_SPAWN_ATTEMPTS}. */
  attempts: number;
  lastError?: string;
  /**
   * POR QUE a entrada está esperando, dito na última passada — e DESDE QUANDO esse motivo vale. A espera era
   * muda: medido na v0.8.0 no ar, um condutor retido pela janela da conta não deixava rastro nenhum (nem log, nem
   * estado, e o painel do governador dizia «retidos: nenhum»). `lastWaitKind` é a classe estável do motivo (o
   * texto traz números que mudam a cada passada): o log sai só quando ELA muda, e `lastWaitAt` é quando começou.
   */
  lastWaitReason?: string;
  lastWaitKind?: string;
  lastWaitAt?: string;
  /**
   * RETOMADA de um card ESTACIONADO (regra: «na frente»): o card já tem trabalho feito e a
   * decisão que ele esperava saiu — terminar o que está quase pronto libera a vaga mais rápido do que começar outro.
   * Uma entrada com esta marca passa na frente de toda a fila; entre retomadas vale FIFO.
   */
  resume?: true;
  /**
   * O card CEDEU a vaga: o condutor dele estacionou por QUIETUDE (conductor-pause.ts) — a vaga foi liberada para quem
   * esperava, e ele volta DEPOIS de todos eles, qualquer tier (revisão do WP5-F2: com o tier dele, o bug alto reconquistava
   * a vaga que acabara de liberar, os tier 0 seguiam esperando e o ciclo de 20 min se repetia). A marca sai na passada
   * que despacha outro card do mesmo board — servida a vez cedida, ele volta a disputar pelo seu tier.
   */
  yielded?: true;
  /**
   * A RETOMADA depois do veredito do merge train (conductor-handoff.ts): o condutor anterior passou a submissão
   * `runId` ao train e encerrou; o train decidiu `status`. Vai na TAREFA da sessão nova (o PRE-VOO passo 9 não depende
   * de a nota do card ter aterrissado) e, num `done`, isenta a entrada do teto de gasto: o código já está em stage e só
   * falta a projeção — segurá-la no teto deixaria o trabalho integrado parado sem ninguém para pedir o aumento.
   */
  handoff?: {
    runId: string;
    status: string;
    /** fase 7: os ITENS do lote que a submissão levou (além do líder) — a retomada pode re-pegá-los (`claim_batch`). */
    batchCardIds?: string[];
    /**
     * fase 7: o serviço DIVIDIU o lote depois de uma devolução do train que não deu para atribuir a um item (ou da
     * segunda devolução do mesmo lote): os itens voltaram à fila sozinhos e o líder retoma só com os commits dele.
     */
    split?: true;
  };
  /**
   * fase 7: o item SAIU de um lote (`batch_drop`) ou o lote foi dividido pelo serviço — ele roda sozinho daqui em diante
   * e nunca volta a entrar num lote.
   */
  solo?: true;
}

/** Quem já conduz uma funcionalidade ({@link conductorFeatureBusy}). */
export interface ConductorFeatureHolder {
  /** a sessão do condutor que segura a funcionalidade (ou a que submeteu, numa entrega ainda no train). */
  sessionId: string;
  /** o card líder dessa sessão / submissão. */
  cardId: string;
  /** `session` = um condutor vivo; `handoff` = uma submissão esperando o veredito do train. */
  via: "session" | "handoff";
}

/**
 * NUNCA DOIS CONDUTORES NA MESMA FUNCIONALIDADE (fase 7, decisão 9): quem já segura a funcionalidade `featureKey` do
 * board — um condutor vivo (por `sessionCardIds`) ou uma entrega dele ainda no train (handoff sem veredito) —, exceto
 * a sessão `exceptSessionId`. Null = livre. «Outros» e grupos `self` nunca ficam ocupados (o chamador não pergunta).
 * Usado pelo pump e pela abertura à mão (`claude_new` implement, `claim_card` implement).
 *
 * STUB do commit de interfaces: a Trilha C implementa.
 */
export async function conductorFeatureBusy(board: string, featureKey: string, exceptSessionId?: string): Promise<ConductorFeatureHolder | null> {
  const { featureHoldersNow } = await import("./conductor-batch-deps");
  return findFeatureHolder(await featureHoldersNow(board), featureKey, exceptSessionId);
}

/** Um ocupante possível de funcionalidade, com as chaves dos cards dele (feature-key.ts `featureKeyOf(...).id`). */
export interface FeatureHolderCandidate extends ConductorFeatureHolder {
  board: string;
  /** as funcionalidades que ele segura (as chaves que formam lote — {@link sharesFeature}). */
  featureKeys: readonly string[];
}

/** Quem segura `featureKey` entre os candidatos (sessões vivas primeiro), exceto a sessão `exceptSessionId`. PURA. */
export function findFeatureHolder(
  candidates: readonly FeatureHolderCandidate[],
  featureKey: string,
  exceptSessionId?: string,
): ConductorFeatureHolder | null {
  const hits = candidates.filter((c) => c.sessionId !== exceptSessionId && c.featureKeys.includes(featureKey));
  const hit = hits.find((c) => c.via === "session") ?? hits[0];
  return hit ? { sessionId: hit.sessionId, cardId: hit.cardId, via: hit.via } : null;
}

/** A frase da espera / da recusa quando a funcionalidade está ocupada. PURA. */
export function featureBusyReason(holder: ConductorFeatureHolder, featureTitle?: string): string {
  const what = featureTitle ? `«${featureTitle}»` : "esta funcionalidade";
  return holder.via === "handoff"
    ? `a entrega de ${holder.cardId} (sessão ${holder.sessionId.slice(0, 8)}) em ${what} ainda está no merge train — outro condutor espera ela assentar`
    : `outro condutor já trabalha em ${what} (sessão ${holder.sessionId.slice(0, 8)}, card ${holder.cardId})`;
}

/** A classe da espera por funcionalidade ocupada (decisão 9 do dono: nunca dois condutores na mesma funcionalidade). */
export const CONDUCTOR_FEATURE_BUSY_WAIT_KIND = "feature-busy";

/**
 * A TAREFA de um condutor que retoma depois do train: a de sempre + o sessionId de quem submeteu e o veredito, para o
 * PRE-VOO passo 9 ler o veredito sem depender da nota do card. PURA.
 */
export function conductorHandoffTask(board: string, cardId: string, handoff: NonNullable<ConductorQueueEntry["handoff"]>): string {
  const items = (handoff.batchCardIds ?? []).filter((id) => /^[A-Za-z0-9_.-]{1,80}$/.test(id));
  const batch = handoff.split
    ? ` — o serviço DIVIDIU o lote (a devolução não deu para atribuir a um item): os itens voltaram à fila sozinhos; ` +
      `refaça o seu branch só com os commits «Card: ${cardId}» e submeta de novo`
    : items.length
      ? ` — a submissão levou um LOTE: re-pegue os itens ${items.join(", ")} com claim_batch antes de seguir`
      : "";
  return (
    `${conductorTask(board, cardId)} — RETOMADA depois do merge train: a submissão do condutor anterior ` +
    `(sessionId ${handoff.runId}) teve veredito «${handoff.status}»; comece pelo PRE-VOO passo 9 ` +
    `(wait_for_submit({sessionId: "${handoff.runId}"}))${batch}`
  );
}

export interface ConductorQueueStore {
  load(): Promise<ConductorQueueEntry[]>;
  persist(entries: ConductorQueueEntry[]): Promise<void>;
}

/** `storymap/.runner/conductor-queue.json` (gitignored with the rest of `.runner/`). */
export function conductorQueuePath(): string {
  return path.join(runnerStateDir(), "conductor-queue.json");
}

/** Disk store — atomic temp+rename; an unreadable file reads as EMPTY (the cards keep their driver, and the
 *  operator sees them as conducted-with-no-session in the fleet view: visible, never silently respawned). */
export function diskConductorQueueStore(file: string = conductorQueuePath()): ConductorQueueStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { entries?: unknown };
        const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
        return list.filter(
          (e): e is ConductorQueueEntry =>
            !!e && typeof e === "object" && typeof (e as ConductorQueueEntry).board === "string" && typeof (e as ConductorQueueEntry).cardId === "string",
        );
      } catch {
        return [];
      }
    },
    async persist(entries) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify({ v: 1, entries }, null, 2));
    },
  };
}

/** A severidade do bug como tier da fila (3 bloqueante → 0 baixa) — urgência do FATO, nunca uma nota. */
const SEVERITY_TIER: Readonly<Record<BugSeverity, number>> = { blocker: 3, high: 2, medium: 1, low: 0 };
/** Rótulos que dizem «segurança ou dados de pessoas» — vocabulário genérico, nunca o nome de um produto. */
const SECURITY_LABEL = /^(?:security|seguran[cç]a|privacy|privacidade|lgpd|gdpr|dados-pessoais|personal-data)$/i;

/**
 * WP5-F2 — o tier que um card ganha dos próprios fatos: a severidade do bug (bloqueante 3, alta 2, média 1, baixa 0)
 * e +1 com rótulo de segurança/dados de pessoas (no máximo 3); só o rótulo, sem severidade, vale 1. `null` = nada a
 * derivar. PURA. Caso real: a fila era FIFO, e um bug ALTO esperou horas atrás de um bug baixo. O tier vem antes da
 * posição na coluna (um card com tier passa à frente de um sem; o mais severo antes) — é fato do card, não uma nota.
 */
export function derivedQueueTier(card: Pick<Card, "bugReport" | "labels">): number | null {
  const sev = card.bugReport?.severity;
  const base = sev && sev in SEVERITY_TIER ? SEVERITY_TIER[sev] : null;
  const sensitive = (card.labels ?? []).some((l) => typeof l === "string" && SECURITY_LABEL.test(l.trim()));
  if (base === null) return sensitive ? 1 : null;
  return Math.min(3, base + (sensitive ? 1 : 0));
}

/**
 * The DISPATCH ORDER of the queue — the ORDER OF THE WORK is the card's POSITION in its column (`card.order`, what
 * the owner arranges with «Fazer antes» / «Pode esperar»); there is no priority score. PURE and total:
 *   0. a RESUME of a parked card (`entry.resume`) goes before everything else — FIFO among resumes;
 *   0b. an entry that YIELDED its slot (`entry.yielded` — parked for being quiet) goes after every entry that did not,
 *      until the pump serves the yielded turn (see {@link ConductorQueueEntry.yielded});
 *   1. the tier DERIVED from the card's facts ({@link derivedQueueTier}, WP5-F2: the bug's severity, +1 for a
 *      security/personal-data label) — a tiered card goes before an untiered one, the more severe first; a fact of
 *      the card, never a score;
 *   2. the card's `order` in its column, top first (an entry whose card could not be read goes after the read ones);
 *   3. FIFO by `queuedAt` for ties — then board/card id, so any permutation of the same queue comes out in the same
 *      order.
 */
export function compareConductorQueue(
  a: { entry: ConductorQueueEntry; card: Card | null },
  b: { entry: ConductorQueueEntry; card: Card | null },
): number {
  if (!!a.entry.resume !== !!b.entry.resume) return a.entry.resume ? -1 : 1;
  if (a.entry.resume && b.entry.resume) {
    const qa = a.entry.queuedAt ?? "";
    const qb = b.entry.queuedAt ?? "";
    if (qa !== qb) return qa < qb ? -1 : 1;
  }
  if (!!a.entry.yielded !== !!b.entry.yielded) return a.entry.yielded ? 1 : -1;
  const ta = (a.card ? derivedQueueTier(a.card) : null) ?? -1;
  const tb = (b.card ? derivedQueueTier(b.card) : null) ?? -1;
  if (ta !== tb) return tb - ta;
  const oa = a.card && Number.isFinite(a.card.order) ? a.card.order : null;
  const ob = b.card && Number.isFinite(b.card.order) ? b.card.order : null;
  if (oa != null && ob != null && oa !== ob) return oa - ob;
  if ((oa == null) !== (ob == null)) return oa == null ? 1 : -1;
  const qa = a.entry.queuedAt ?? ""; // an entry read from disk without it sorts first — the oldest shape
  const qb = b.entry.queuedAt ?? "";
  if (qa !== qb) return qa < qb ? -1 : 1;
  return a.entry.board.localeCompare(b.entry.board) || a.entry.cardId.localeCompare(b.entry.cardId);
}

/** In-memory store (tests). */
export function memoryConductorQueueStore(seed: ConductorQueueEntry[] = []): ConductorQueueStore & { entries: ConductorQueueEntry[] } {
  const box = { entries: seed.map((e) => ({ ...e })) };
  return {
    get entries() {
      return box.entries;
    },
    async load() {
      return box.entries.map((e) => ({ ...e }));
    },
    async persist(entries) {
      box.entries = entries.map((e) => ({ ...e }));
    },
  };
}

// ── the dispatcher ──────────────────────────────────────────────────────────────────────────────────────

/** Plumbing failures (no slot/claim explains them) tolerated before the card is handed to the operator. */
export const CONDUCTOR_MAX_SPAWN_ATTEMPTS = 3;

/** The finding the operator sees when the dispatch gave up spawning (never for waiting or a claim). */
export const CONDUCTOR_DISPATCH_FINDING_ID = "conductor-dispatch";

/**
 * WP5-F1 — por que o card de uma entrada da fila NÃO veio, e o que a fila faz com cada resposta:
 *   • `unreadable` — o card não foi lido AGORA (o arquivo existe mas foi recusado/ilegível, ou nem deu para saber):
 *                    a entrada FICA e a próxima passada tenta de novo;
 *   • `trashed`    — alguém mandou o card para a lixeira: a saída é a decisão de quem apagou;
 *   • `missing`    — ENOENT confirmado, fora da lixeira: o card SUMIU com a fila esperando por ele. Sai da fila, mas
 *                    nunca em silêncio — vira decisão do sistema (`card-missing`) e alerta.
 * Caso real: cards aceitos na triagem foram apagados pelo merge train e a fila os tirou com uma
 * linha de journal («card não existe mais»), sem registro nenhum — um deles era um bug de segurança.
 */
export type QueuedCardMiss =
  | { kind: "unreadable"; detail: string }
  | { kind: "trashed" }
  /**
   * Fase 6 (6D) — o card MUDOU DE BOARD (card-transfer.ts, `transfer_card`): ele existe em `toBoard`. Não é um card que
   * sumiu — a entrada segue o card para o board novo (o pump de lá julga driver, status e o condutor daquele board), sem
   * o alarme «sumiu, recrie» (cinco alarmes falsos num único dia, num caso real).
   */
  | { kind: "transferred"; toBoard: string }
  | { kind: "missing"; lastHop: { from: string | null; to: string; at: string } | null };

/** PURA — o registro durável de um card que sumiu do disco com a fila do condutor esperando por ele. */
export function cardMissingDecision(
  entry: Pick<ConductorQueueEntry, "board" | "cardId" | "queuedAt">,
  miss: Extract<QueuedCardMiss, { kind: "missing" }>,
  at: string,
  id: string,
): SystemDecision {
  const hop = miss.lastHop
    ? `o último salto do ledger foi ${miss.lastHop.from ?? "—"} → ${miss.lastHop.to} (${miss.lastHop.at})`
    : "o ledger de transições não tem salto deste card";
  return {
    v: 1,
    id,
    at,
    board: entry.board,
    cardId: entry.cardId,
    agent: "system",
    kind: "card-missing",
    what: `O card ${entry.cardId} sumiu do disco com a fila do condutor esperando por ele`,
    why:
      `estava na fila desde ${entry.queuedAt}; o arquivo não existe em cards/ nem na lixeira; ${hop}. ` +
      `A entrada saiu da fila — recrie o card pelo caminho oficial (MCP) a partir deste registro e do histórico.`,
  };
}

export interface ConductorDeps {
  queue: ConductorQueueStore;
  /** every registered fleet session (the registry — alive or not). */
  sessions(): Promise<AgentSession[]>;
  /** names of the tmux sessions alive NOW; null = the probe did not answer (see {@link isLiveConductor}). */
  liveTmux(): Promise<ReadonlySet<string> | null>;
  heartbeatAlive(s: AgentSession): boolean;
  /** WP5-F2 — a árvore de trabalho desta linha foi apagada (tmux zumbi, ver {@link isLiveConductor}). Ausente ⇒ nunca. */
  treeGone?(s: AgentSession): boolean;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  /** stamp `routing.driver: conductor` (idempotent, under the card lock). */
  markDriver(board: string, cardId: string): Promise<void>;
  /** remove the driver the DISPATCH set (only used when the dispatch is abandoned before any conductor ran). */
  clearDriver(board: string, cardId: string): Promise<void>;
  /**
   * CARIMBA no card o teto de modelo que o TIPO dele dá (driver.ts `withTypeModelCap`: Sonnet para bug/manutenção sem
   * risco alto), na admissão — o card, a tela e o histórico mostram qual teto valeu. Idempotente; um teto escolhido por
   * alguém nunca é tocado. Ausente ⇒ o teto só é derivado no despacho (não fica visível no card).
   */
  stampModelCap?(board: string, cardId: string): Promise<void>;
  /** the operator-facing finding when spawning keeps failing (idempotent upsert). */
  stampDispatchFailure(board: string, cardId: string, detail: string): Promise<void>;
  /** the SAME spawn `claude_new` uses. */
  spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>;
  /** the live autorun master switch (settings.yaml `autorun.enabled` / AGILEHARNESS_AUTORUN). */
  masterEnabled(): boolean;
  /** the board gate (board-pace.ts: disarmed, paused, slow). Absent ⇒ only the board config answers. */
  boardGate?: BoardGatePort;
  /**
   * The ACCOUNT window (capacity-governor). The session is spawned as `human` (the acceptance is the go, and
   * the steward must not reap a conductor waiting at a pause), but the DISPATCH is automation: nobody is at a
   * keyboard when it fires. So it asks the governor as automation — held ⇒ the entry WAITS in the queue (never
   * dropped) and the next pump re-asks. Absent ⇒ admitted (tests / an adopter without a meter).
   */
  admission?(): GateVerdict;
  /**
   * Tell the governor WHICH queue entries its window is holding (the complete set; it replaces the previous one),
   * so the capacity panel counts them and the >24h alert covers them. Reported only by a pass that actually ASKED
   * the governor (or found the queue empty): a pass that stopped earlier (box full, slots taken) does not know,
   * and must not reset the clock of an entry that was already waiting — the engine's rule for its own queue.
   */
  reportHeld?(keys: string[]): void;
  /**
   * O TETO DE GASTO do card (card-budget.ts): o motivo pelo qual este card não pode receber um condutor agora (o que
   * já foi gasto chegou ao teto em vigor), ou null. Para um card conduzido o teto era só texto da skill; aqui ele
   * passa a valer em código — a entrada ESPERA na fila (nunca sai) e anda quando um aumento for aprovado.
   */
  budgetRefusal?(board: string, card: Card): Promise<string | null>;
  /**
   * A VAGA EXTRA (extra-slot.ts): com o board no limite de `maxSessions`, este card pode nascer mesmo assim? `open`
   * só com todas as travas do dono (máquina folgada, cota no ritmo, integração vazia, card pequeno). Ausente ⇒ o
   * limite do board é o limite.
   */
  extraSlot?(board: string, card: Card, live: number, maxSessions: number): Promise<{ open: boolean; why: string; lock?: string }>;
  /** um condutor nasceu NA vaga extra — para o registro de decisões do sistema. */
  onExtraSlot?(board: string, card: Card, why: string): Promise<void>;
  /**
   * WP5-F1 — `readCard` devolveu null: o card sumiu, foi para a lixeira, ou só não foi lido agora? (ver
   * {@link QueuedCardMiss}). Na dúvida, `unreadable`. Ausente ⇒ o comportamento antigo (a entrada sai da fila).
   */
  explainMissingCard?(board: string, cardId: string): Promise<QueuedCardMiss>;
  /** WP5-F1 — o card SUMIU com a fila esperando: grava a decisão do sistema (`card-missing`) e alerta. */
  recordCardMissing?(entry: ConductorQueueEntry, miss: Extract<QueuedCardMiss, { kind: "missing" }>): Promise<void>;
  /**
   * WP5-F2 — os boards com o condutor ligado e o autorun armado, com os cards de agora, para a admissão dos ÓRFÃOS
   * ({@link isConductorOrphan}). Ausente ⇒ só a entrada admite. Pode devolver [] para poupar a leitura (a produção
   * varre no máximo a cada 5 min).
   */
  orphanCandidates?(): Promise<Array<{ board: string; config: BoardConfig; cards: readonly Card[] }>>;
  /**
   * Revisão do WP5-F2 — alguém trabalha neste card FORA do registro de sessões: claim ativo, run do engine ou entrada
   * viva no merge train (a régua `inFlight` do vigia, stall-watch-deps.ts). Só a adoção de órfãos pergunta; lançar ⇒ o
   * card não é adotado. Ausente ⇒ só o registro de sessões responde.
   */
  cardInFlight?(board: string, cardId: string): Promise<boolean>;
  /**
   * Fase 6 (6D) — o card ESPERA OUTRA HISTÓRIA (um `depends-on` que não terminou, um bloqueio `blocked-by-*` aberto —
   * cascade-decision.ts `dependencyWait`): o motivo, ou null. A entrada ESPERA na fila com o driver (nunca o solta — soltar
   * deixava a cascata pegar o card e gastar runs) e é despachada na primeira passada depois de a dependência chegar.
   * Ausente ⇒ ninguém espera dependência.
   */
  dependencyHold?(board: string, card: Card, config: BoardConfig | null): Promise<string | null>;
  /**
   * Fase 6 — a RESERVA DO DONO (signals.ts `conductorSlotAllowsSignal`, ≥ 40% das vagas para o PRD e os pedidos dele):
   * um card de SINAL (rótulo `sinal`) só pega vaga se, com ele, os de sinal vivos no board não passarem da fatia. Recebe
   * os cards com condutor vivo no board (inclusive os que esta passada já despachou), as vagas e se há trabalho do
   * dono/PRD na fila do board (a exceção de board pequeno); devolve o motivo da espera, ou null. Ausente ⇒ sem reserva.
   */
  signalSlotHold?(board: string, card: Card, liveCardIds: readonly string[], maxSessions: number, ownerWorkQueued: boolean): Promise<string | null>;
  /**
   * Fase 6 (6D) — reavalia a ENTRADA do card (autorun-eval.ts `evaluateAutorunOnEntry`) depois de o pump devolvê-lo ao
   * fluxo (a reabertura pendente: a skill da reabertura roda primeiro). Ausente ⇒ o card espera o próximo evento.
   */
  reevaluateEntry?(board: string, cardId: string): Promise<void>;
  /**
   * Fase 7 — a FUNCIONALIDADE do card (feature-key.ts `featureKeyOf`, com o contexto do board). Decide a espera
   * «funcionalidade ocupada» (decisão 9 do dono) e os candidatos do lote. null / lançar ⇒ sem funcionalidade (não
   * bloqueia nem forma lote). Ausente ⇒ nenhum dos dois (o comportamento de antes).
   */
  featureKeyOf?(board: string, card: Card): Promise<FeatureKey | null>;
  /**
   * Fase 7 — as entregas de condutor AINDA no merge train (`.runner/conductor-handoffs.json`, sem veredito assentado):
   * o código delas ainda não chegou à base, então a funcionalidade segue ocupada. Ausente ⇒ nenhuma.
   */
  pendingHandoffs?(): Promise<Array<{ board: string; cardId: string; runId: string; batchCardIds?: string[] }>>;
  now?(): number;
  log?(line: string): void;
}

/** A classe da espera por OUTRA HISTÓRIA na fila (a vez fica guardada, o driver também). */
export const CONDUCTOR_DEPENDENCY_WAIT_KIND = "dependency";
/** A classe da espera de um card de SINAL pela reserva do dono (as vagas que sobram são do PRD e dos pedidos dele). */
export const CONDUCTOR_SIGNAL_RESERVE_WAIT_KIND = "signal-reserve";

const QUEUE_LOCK = "conductor-dispatch";

/**
 * O MOTIVO REAL da espera por vaga (WP5-F2). Antes a fila gravava só «2 condutor(es) vivo(s) — esperando uma vaga» e
 * descartava o porquê da vaga extra: num caso real, vários cards esperaram horas com a máquina carregada pelo gate e ninguém
 * via a trava. Agora a classe diz qual trava fechou (`slots:extra-closed:<trava>`) e o texto, os números. PURA.
 */
export function slotWait(live: number, extra: { open: boolean; why: string; lock?: string } | null): { reason: string; kind: string } {
  const base = `${live} condutor(es) vivo(s) no board`;
  if (!extra || extra.open) return { reason: `${base} — esperando uma vaga`, kind: "slots" };
  return { reason: `${base} — esperando uma vaga (vaga extra fechada: ${extra.why})`, kind: extra.lock ? `slots:extra-closed:${extra.lock}` : "slots" };
}

/** A entrada espera uma VAGA (com ou sem o motivo da vaga extra)? PURA — quem lê a fila usa esta régua, nunca `=== "slots"`. */
export function isSlotWait(kind: string | undefined): boolean {
  return kind === "slots" || !!kind?.startsWith("slots:");
}

const logOf = (deps: ConductorDeps) => deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));

/**
 * ADMIT a card whose entry made it a dispatch: stamp the driver and queue it (idempotent). Awaited by the
 * shell BEFORE it returns, so every evaluation that follows already sees a conducted card. The spawn itself is
 * the pump's job (seconds of worktree + tmux) — the caller fires it without holding the entry path.
 */
export async function admitConductorCard(
  deps: ConductorDeps,
  board: string,
  cardId: string,
  /**
   * `resume`: na frente da fila (retomada); `yielded`: depois das que esperavam (cedeu a vaga — {@link ConductorQueueEntry.yielded});
   * `handoff`: a retomada depois do veredito do train ({@link ConductorQueueEntry.handoff}); `requireDriver`: NÃO carimba o
   * driver — o card precisa já tê-lo (a passagem ao train: se o operador o limpou entre a leitura e a readmissão, a
   * decisão dele vale e nada entra na fila).
   */
  opts: { resume?: boolean; yielded?: boolean; handoff?: ConductorQueueEntry["handoff"]; requireDriver?: boolean } = {},
): Promise<{ queued: boolean }> {
  if (opts.requireDriver) {
    const card = await deps.readCard(board, cardId); // lançar ⇒ quem chamou tenta de novo
    if (!card || !isConducted(card)) {
      logOf(deps)(`${board}/${cardId}: não volta à fila do condutor — o card não tem mais routing.driver: conductor`);
      return { queued: false };
    }
  } else {
    await deps.markDriver(board, cardId);
  }
  return withKeyedLock(QUEUE_LOCK, async () => {
    const entries = await deps.queue.load();
    const waiting = entries.find((e) => e.board === board && e.cardId === cardId);
    if (waiting) {
      // já na fila: uma retomada só PROMOVE a entrada (nunca duplica, nunca rebaixa)
      if ((opts.resume && !waiting.resume) || (opts.handoff && !waiting.handoff)) {
        const promoted = { ...waiting, ...(opts.resume ? { resume: true as const } : {}), ...(opts.handoff ? { handoff: opts.handoff } : {}) };
        await deps.queue.persist(entries.map((e) => (e === waiting ? promoted : e)));
        logOf(deps)(`${board}/${cardId} passou para a frente da fila do condutor (retomada)`);
      }
      return { queued: false };
    }
    const sessions = await deps.sessions().catch(() => [] as AgentSession[]);
    const live = await deps.liveTmux().catch(() => null);
    const already = sessions.some(
      // fase 7: um ITEM de lote vivo também já tem condutor (o da sessão do lote)
      (s) => s.board === board && sessionCardIds(s).includes(cardId) && isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone),
    );
    if (already) return { queued: false }; // its conductor is on it (e.g. the conductor itself moved the card here)
    const place = opts.resume ? { resume: true as const } : opts.yielded ? { yielded: true as const } : {};
    entries.push({
      board,
      cardId,
      queuedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      attempts: 0,
      ...place,
      ...(opts.handoff ? { handoff: opts.handoff } : {}),
    });
    await deps.queue.persist(entries);
    logOf(deps)(
      opts.handoff
        ? `${board}/${cardId} volta para a frente da fila do condutor (o train decidiu a submissão ${opts.handoff.runId.slice(0, 8)}: ${opts.handoff.status})`
        : opts.resume
        ? `${board}/${cardId} volta para a frente da fila do condutor (retomada de card estacionado)`
        : opts.yielded
          ? `${board}/${cardId} volta à fila do condutor DEPOIS das que esperavam vaga (estacionou por quietude e cedeu a vaga)`
          : `${board}/${cardId} na fila do condutor (driver: conductor)`,
    );
    return { queued: true };
  });
}

/** What one pump pass did — for the log and the tests. */
export interface ConductorPumpReport {
  spawned: Array<{ board: string; cardId: string; sessionId: string; tmuxSession: string }>;
  waiting: Array<{ board: string; cardId: string; reason: string }>;
  dropped: Array<{ board: string; cardId: string; reason: string }>;
  /** WP5-F2 — órfãos que esta passada admitiu (driver + fila). */
  adopted: Array<{ board: string; cardId: string }>;
}

/**
 * WP5-F2 — um ÓRFÃO do condutor: card de story parado num `fromStatus` do board, sem driver. PURA — a MESMA régua da
 * entrada (`conductorEntryVerdict` em autorun-eval.ts), que só admite quando o card ENTRA no status: um card que já
 * estava lá quando o condutor foi ligado, ou cuja entrada se perdeu (restart, evento perdido), ficava sem ninguém para
 * sempre — nem condutor (nunca admitido), nem skill de coluna (a entrada daquele status é do condutor). Num caso real,
 * vários cards em «Moldando» ficaram assim (um que tinha driver não entra — ver abaixo).
 *
 * Com o `gate` do board (o ESCOPO DE TIPOS, board-pace.ts), um card de tipo que o board não pode começar NÃO é órfão: ninguém
 * o adota enquanto o escopo o recusar (ele não perdeu o dono — está esperando de propósito) e a primeira varredura depois de o
 * escopo alargar o adota. Sem `gate`, a régua é a de sempre.
 *
 * Card COM driver e sem sessão nem fila NÃO é órfão aqui: é o condutor que morreu, e reabrir em laço quem morre é o
 * que o cabeçalho deste módulo proíbe — o vigia de card parado o mostra ao operador (`conductor-dead`).
 */
export function isConductorOrphan(card: Card, config: BoardConfig, gate?: Pick<BoardGate, "scope"> | null): boolean {
  return !isConducted(card) && conductorEntryVerdict(card, config, gate).dispatch;
}

/**
 * One PUMP pass over the queue (in the board's order — {@link compareConductorQueue}), serialized with admission
 * under one lock so the per-board count cannot race a concurrent pass into a third conductor. Every outcome of a
 * spawn attempt is decided HERE:
 *   • ok                       → out of the queue (the card now has its conductor);
 *   • no_capacity              → stays; the pass STOPS (the box is full — later entries would fail the same way);
 *   • card_claimed by a SESSION→ out of the queue: another session already owns the card (an operator-opened
 *                                conductor, typically) — log only, the driver stays;
 *   • card_claimed by anyone else (a run settling, the tick) → stays, retried next pass;
 *   • plumbing (spawn_failed / session_lost / name_taken) → stays, `attempts`+1; at
 *     {@link CONDUCTOR_MAX_SPAWN_ATTEMPTS} it leaves the queue with an operator finding on the card.
 * An entry whose card was not READ stays (WP5-F1 — see {@link QueuedCardMiss}); one whose card went to the trash,
 * vanished (recorded as `card-missing`, never silently), left the driver, or reached a terminal status is dropped; one whose board
 * turned the conductor OFF is dropped AND the dispatch's driver is removed (no conductor ever ran: handing the
 * card back to the cascade is the honest undo). The master switch / board kill switch pause, never drop.
 */
export async function pumpConductorQueue(deps: ConductorDeps): Promise<ConductorPumpReport> {
  return withKeyedLock(QUEUE_LOCK, () => pumpUnlocked(deps));
}

/**
 * Fase 3 — a TRAVA do despacho para uma ação do OPERADOR sobre um card conduzido («Parar condutor», «Devolver ao fluxo»):
 * a mesma da admissão e do pump, para que nenhuma passada concorrente re-admita o card ou abra um condutor novo enquanto
 * a ação tira o card da fila, encerra a sessão e mexe no driver.
 */
export function withConductorDispatchLock<T>(fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(QUEUE_LOCK, fn);
}

/** Tira `board/cardId` da fila do condutor (chamar DENTRO de {@link withConductorDispatchLock}). Devolve se tirou. */
export async function dropQueuedConductorCard(store: ConductorQueueStore, board: string, cardId: string): Promise<boolean> {
  const entries = await store.load();
  const kept = entries.filter((e) => !(e.board === board && e.cardId === cardId));
  if (kept.length === entries.length) return false;
  await store.persist(kept);
  return true;
}

/** O registro do retido é escrituração — nunca pode travar o pump. */
function reportHeldSafe(deps: ConductorDeps, keys: string[]): void {
  try {
    deps.reportHeld?.(keys);
  } catch {
    /* best-effort */
  }
}

/**
 * Admite os órfãos ({@link isConductorOrphan}) na fila — idempotente: o driver carimbado tira o card da régua, e um
 * card já na fila não entra de novo. Só com o autorun ligado (a entrada também não admite com ele desligado). A fila
 * é gravada logo, para um card com driver novo nunca ficar fora dela se o resto da passada lançar.
 *
 * Órfão é quem NINGUÉM está carregando — sem driver, sem fila E sem sessão, claim, run ou merge no card. Sem a segunda
 * metade, o card que o operador trabalha numa sessão interativa (sem driver de condutor) ganhava o driver, o spawn
 * esbarrava no claim da sessão dele e a entrada saía da fila com o driver — o card virava «conduzido» sem condutor, e
 * nenhuma skill de coluna rodava mais nele. Adotar MUDA o card: sem saber quem está nele, nada é adotado nesta passada.
 */
async function adoptOrphans(deps: ConductorDeps, entries: ConductorQueueEntry[], report: ConductorPumpReport): Promise<void> {
  if (!deps.orphanCandidates || !deps.masterEnabled()) return;
  const boards = await deps.orphanCandidates().catch(() => []);
  const queued = new Set(entries.map((e) => `${e.board}/${e.cardId}`));
  const candidates = boards.flatMap(({ board, config, cards }) => {
    const gate = gateOf(deps.boardGate, board, config);
    if (gate.held) return [];
    // O ESCOPO DE TIPOS (board-pace.ts): a adoção é «começar» — um card de tipo fora do escopo espera sem driver e sem fila
    // (nada a desfazer quando o escopo alargar: a próxima varredura o adota).
    return cards
      .filter((card) => !queued.has(`${board}/${card.id}`) && isConductorOrphan(card, config) && gateAdmitsCard(gate, card, "conductor").admit)
      .map((card) => ({ board, card }));
  });
  if (!candidates.length) return; // o registro e as reservas só são lidos quando há órfão a adotar
  let sessions: AgentSession[];
  try {
    sessions = await deps.sessions();
  } catch (err) {
    logOf(deps)(`órfãos do condutor: o registro de sessões não foi lido (${err instanceof Error ? err.message : String(err)}) — nenhum adotado nesta varredura`);
    return;
  }
  const live = await deps.liveTmux().catch(() => null);
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  let changed = false;
  for (const { board, card } of candidates) {
    if (sessions.some((s) => s.board === board && sessionCardIds(s).includes(card.id) && isLiveSession(s, live, deps.heartbeatAlive))) continue;
    const inFlight = await (deps.cardInFlight?.(board, card.id) ?? Promise.resolve(false)).catch(() => true);
    if (inFlight) continue;
    const marked = await deps.markDriver(board, card.id).then(
      () => true,
      (err) => {
        logOf(deps)(`${board}/${card.id}: órfão em «${card.status}» — o driver não foi gravado (${err instanceof Error ? err.message : String(err)}); tento na próxima varredura`);
        return false;
      },
    );
    if (!marked) continue;
    entries.push({ board, cardId: card.id, queuedAt: nowIso, attempts: 0 });
    report.adopted.push({ board, cardId: card.id });
    changed = true;
    logOf(deps)(`${board}/${card.id}: estava em «${card.status}» sem condutor, sem fila e sem ninguém no card (órfão) — admitido na fila do condutor`);
  }
  if (changed) await deps.queue.persist(entries);
}

async function pumpUnlocked(deps: ConductorDeps): Promise<ConductorPumpReport> {
  const log = logOf(deps);
  const report: ConductorPumpReport = { spawned: [], waiting: [], dropped: [], adopted: [] };
  const entries = await deps.queue.load();
  await adoptOrphans(deps, entries, report);
  if (!entries.length) {
    reportHeldSafe(deps, []);
    return report;
  }
  const sessions = await deps.sessions().catch(() => [] as AgentSession[]);
  const live = await deps.liveTmux().catch(() => null);
  const liveConductors = sessions.filter((s) => isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone));
  // A conductor whose story is over holds no slot, from this very pass — ending its process is endFinishedConductors'.
  const finished = await finishedConductors(deps, liveConductors);
  const liveCount = countLiveConductorsByBoard(liveConductors.filter((s) => !finished.has(s.sessionId)));

  // Fase 7 — NUNCA DOIS CONDUTORES NA MESMA FUNCIONALIDADE (decisão 9): quem já a ocupa — um condutor vivo (todos os
  // cards dele, lote incluído), uma sessão de implementação aberta à mão, uma entrega ainda no train — e o que esta
  // passada despachar. A chave de cada card é lida uma vez por passada.
  const keyCache = new Map<string, Promise<FeatureKey | null>>();
  const keyOf = (board: string, card: Card | null, cardId: string): Promise<FeatureKey | null> => {
    if (!deps.featureKeyOf) return Promise.resolve(null);
    const k = `${board}/${cardId}`;
    let p = keyCache.get(k);
    if (!p) {
      p = (async () => {
        const c = card ?? (await deps.readCard(board, cardId).catch(() => null));
        if (!c) return null;
        const key = await deps.featureKeyOf!(board, c).catch(() => null);
        return sharesFeature(key) ? key : null;
      })();
      keyCache.set(k, p);
    }
    return p;
  };
  const busyFeatures = new Map<string, ConductorFeatureHolder>();
  if (deps.featureKeyOf) {
    const holders = sessions.filter(
      (s) => (s.driver === "conductor" || s.role === "implement") && !!s.board && !finished.has(s.sessionId) && isLiveSession(s, live, deps.heartbeatAlive) && !deps.treeGone?.(s),
    );
    for (const s of holders) {
      for (const id of sessionCardIds(s)) {
        const key = await keyOf(s.board as string, null, id);
        if (key && !busyFeatures.has(`${s.board}/${key.id}`)) busyFeatures.set(`${s.board}/${key.id}`, { sessionId: s.sessionId, cardId: s.cardId as string, via: "session" });
      }
    }
    for (const h of (await deps.pendingHandoffs?.().catch(() => [])) ?? []) {
      for (const id of [h.cardId, ...(h.batchCardIds ?? [])]) {
        const key = await keyOf(h.board, null, id);
        if (key && !busyFeatures.has(`${h.board}/${key.id}`)) busyFeatures.set(`${h.board}/${key.id}`, { sessionId: h.runId, cardId: h.cardId, via: "handoff" });
      }
    }
  }

  const keep: ConductorQueueEntry[] = [];
  /** boards em que esta passada abriu um condutor — a vez cedida (`yielded`) de quem ficou nele foi servida */
  const servedBoards = new Set<string>();
  /** os cards que ESTA passada despachou, por board — contam como vivos para a reserva do dono já na passada */
  const spawnedThisPass = new Map<string, string[]>();
  let boxFull = false;
  /** a passada PERGUNTOU ao governador por alguma entrada (ver {@link ConductorDeps.reportHeld}) */
  let consulted = false;
  const heldByAccount: string[] = [];
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();
  const drop = (e: ConductorQueueEntry, reason: string) => {
    report.dropped.push({ board: e.board, cardId: e.cardId, reason });
    log(`${e.board}/${e.cardId} saiu da fila: ${reason}`);
  };
  /** Espera: persiste o motivo e desde quando; loga só quando a CLASSE do motivo muda (sem spam por passada). */
  const wait = (e: ConductorQueueEntry, reason: string, kind: string, patch: Partial<ConductorQueueEntry> = {}) => {
    const changed = e.lastWaitKind !== kind;
    keep.push({
      ...e,
      ...patch,
      lastWaitReason: reason.slice(0, 300),
      lastWaitKind: kind,
      lastWaitAt: changed || !e.lastWaitAt ? nowIso() : e.lastWaitAt,
    });
    report.waiting.push({ board: e.board, cardId: e.cardId, reason });
    if (changed) log(`${e.board}/${e.cardId} esperando: ${reason}`);
  };
  /** Os itens da fila que podem entrar no lote do líder `lead` (a régua barata; claim_batch valida tudo). */
  const batchCandidates = async (lead: ConductorQueueEntry, key: FeatureKey): Promise<string[]> => {
    const out: string[] = [];
    for (const q of queued) {
      const c = q.card;
      if (q.entry.board !== lead.board || q.entry.cardId === lead.cardId || q.entry.solo || !c) continue;
      if (!isConducted(c) || !batchable(c) || c.deferred || c.reopenPending) continue;
      if ((await keyOf(q.entry.board, c, c.id))?.id !== key.id) continue;
      out.push(c.id);
    }
    return out;
  };

  // The board's order (bug severity, then column position) decides who gets a free slot first (compareConductorQueue) — the queue is persisted in
  // that order too, so the file reads as the dispatch order.
  // Uma leitura que LANÇA não é um card que sumiu (WP5-F1): guarda o erro para a entrada ficar na fila.
  const queued = await Promise.all(
    entries.map(async (entry) => {
      try {
        return { entry, card: await deps.readCard(entry.board, entry.cardId), readError: null as string | null };
      } catch (err) {
        return { entry, card: null, readError: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  queued.sort(compareConductorQueue);

  for (const { entry: e, card, readError } of queued) {
    if (boxFull) {
      wait(e, "máquina saturada (admissão da frota)", "box-full");
      continue;
    }
    const config = await deps.readBoardConfig(e.board).catch(() => null);
    if (!card) {
      const miss: QueuedCardMiss | null =
        readError !== null
          ? { kind: "unreadable", detail: readError }
          : deps.explainMissingCard
            ? await deps.explainMissingCard(e.board, e.cardId).catch((err): QueuedCardMiss => ({
                kind: "unreadable",
                detail: err instanceof Error ? err.message : String(err),
              }))
            : null;
      if (miss?.kind === "unreadable") {
        wait(e, `o card não foi lido agora (${miss.detail.slice(0, 160)}) — a entrada fica na fila`, "card-unreadable");
        continue;
      }
      if (miss?.kind === "trashed") {
        drop(e, "o card foi para a lixeira");
        continue;
      }
      if (miss?.kind === "transferred") {
        // A entrada segue o card (nenhum alarme): no board novo o pump julga o driver, o status e a política de lá. Uma
        // entrada que já existe lá para o mesmo card vence (nunca duplica).
        const already = entries.some((x) => x !== e && x.board === miss.toBoard && x.cardId === e.cardId);
        if (already) drop(e, `o card mudou para o board «${miss.toBoard}» e já está na fila de lá`);
        else wait(e, `o card mudou para o board «${miss.toBoard}» — a entrada o seguiu`, "transferred", { board: miss.toBoard });
        continue;
      }
      if (miss?.kind === "missing") {
        await deps.recordCardMissing?.(e, miss).catch((err) =>
          log(`${e.board}/${e.cardId}: o registro do card sumido falhou — ${err instanceof Error ? err.message : String(err)}`),
        );
        drop(e, "o card SUMIU do disco (fora da lixeira) — registrado como decisão do sistema card-missing");
        continue;
      }
      drop(e, "card não existe mais");
      continue;
    }
    if (card.deferred) {
      // «Adiado — não agora»: o card sai da fila e fica livre (sem driver) — inerte até alguém trazê-lo de volta.
      if (isConducted(card)) await deps.clearDriver(e.board, e.cardId).catch(() => {});
      drop(e, "o card foi adiado (não agora) — saiu da fila");
      continue;
    }
    if (!isConducted(card)) {
      drop(e, "o driver foi removido (operador) — o card voltou à cascata");
      continue;
    }
    if (card.status && config?.statuses.find((s) => s.id === card.status)?.terminal) {
      // fase 6 — a história acabou: o driver sai junto (dois cards entregues seguiam «conduzidos» para sempre, e a tela
      // oferecia «Parar condutor» sobre ninguém)
      if (isConducted(card)) await deps.clearDriver(e.board, e.cardId).catch(() => {});
      drop(e, `card já está num status terminal (${card.status})`);
      continue;
    }
    // Fase 6 (6D) — a REABERTURA pendente roda a skill dela antes de qualquer condutor (driver.ts conductorEntryVerdict):
    // chamar o condutor aqui gastava uma sessão que parava no PRE-VOO. O card volta ao fluxo (sem o driver do despacho) e
    // a entrada dele é reavaliada — a cascata roda a skill da reabertura no passo onde ele está.
    if (card.reopenPending) {
      await deps.clearDriver(e.board, e.cardId).catch(() => {});
      drop(e, "reabertura pendente — a skill da reabertura roda antes do condutor (driver do despacho removido)");
      void deps.reevaluateEntry?.(e.board, e.cardId).catch(() => {});
      continue;
    }
    const policy = resolveConductorPolicy(config);
    if (!policy) {
      await deps.clearDriver(e.board, e.cardId).catch(() => {});
      drop(e, "o conductor foi desligado neste board antes de a sessão nascer — driver removido");
      continue;
    }
    if (!deps.masterEnabled()) {
      wait(e, "autorun desligado (master switch) — a fila espera", "autorun-off");
      continue;
    }
    // O portão do board (board-pace.ts): desarmado ou pausado, a fila espera; devagar, um condutor por vez.
    const boardGate = gateOf(deps.boardGate, e.board, config);
    if (boardGate.held) {
      wait(e, `${boardGate.why} — a fila espera`, boardGate.source === "pace" ? "board-paused" : "autorun-off");
      continue;
    }
    const maxSessions = paceCap(policy.maxSessions, boardGate);
    if (liveConductors.some((s) => s.board === e.board && sessionCardIds(s).includes(e.cardId))) {
      drop(e, "já tem um condutor vivo");
      continue;
    }
    // O ESCOPO DE TIPOS (board-pace.ts, segundo eixo do ritmo): o condutor leva a story de ponta a ponta, então um card de
    // tipo que o board não pode começar ESPERA na fila (com o motivo à vista) em vez de abrir uma sessão — e NÃO é
    // descartado: a entrada guarda o driver e a vez, e a primeira passada depois de o escopo alargar a despacha. Não gasta
    // vaga (a pergunta vem antes da conta das vagas).
    const scope = gateAdmitsCard(boardGate, card, "conductor");
    if (!scope.admit) {
      wait(e, `${scope.why} — a fila espera`, CONDUCTOR_SCOPE_WAIT_KIND);
      continue;
    }
    // Fase 6 (6D) — o card ESPERA OUTRA HISTÓRIA: fica na fila COM o driver (a vez guardada) e não gasta vaga; a primeira
    // passada depois de a dependência chegar o despacha (uma retomada, na frente). Uma leitura que falha não segura.
    const dependency = await deps.dependencyHold?.(e.board, card, config).catch(() => null);
    if (dependency) {
      wait(e, `espera outra história: ${dependency}`, CONDUCTOR_DEPENDENCY_WAIT_KIND);
      continue;
    }
    // Fase 6 — a reserva do dono: um card de SINAL não toma a fatia do PRD/pedidos (espera com a vez guardada). Os vivos
    // são os do retrato do começo da passada MAIS os que esta passada já despachou (senão N sinais admitidos numa passada
    // viam todos o mesmo retrato e passavam juntos da fatia); a fila do board diz se há trabalho do dono esperando.
    if (card.labels?.includes("sinal")) {
      const liveIds = [...liveConductors.filter((s) => s.board === e.board && s.cardId).map((s) => s.cardId as string), ...(spawnedThisPass.get(e.board) ?? [])];
      const ownerWorkQueued = queued.some((q) => q.entry.board === e.board && q.entry.cardId !== e.cardId && !!q.card && !q.card.labels?.includes("sinal"));
      const reserve = await deps.signalSlotHold?.(e.board, card, liveIds, maxSessions, ownerWorkQueued).catch(() => null);
      if (reserve) {
        wait(e, reserve, CONDUCTOR_SIGNAL_RESERVE_WAIT_KIND);
        continue;
      }
    }
    // Fase 7 — a funcionalidade ocupada: espera COM a vez guardada e sem gastar vaga. A retomada do train do MESMO card
    // não espera por ela mesma (ela é a dona da funcionalidade).
    const featureKey = await keyOf(e.board, card, e.cardId);
    if (featureKey) {
      const holder = busyFeatures.get(`${e.board}/${featureKey.id}`);
      if (holder && holder.cardId !== e.cardId) {
        wait(e, `${featureBusyReason(holder, featureKey.title)} — a fila espera`, CONDUCTOR_FEATURE_BUSY_WAIT_KIND);
        continue;
      }
    }
    const liveNow = liveCount.get(e.board) ?? 0;
    let viaExtraSlot: string | null = null;
    if (liveNow >= maxSessions) {
      // Em ritmo devagar a vaga extra não abre: o ritmo é a decisão de gastar menos, e ela a desfaria.
      const extra =
        boardGate.level === "slow"
          ? { open: false, why: "o board está em ritmo devagar (um card por vez)", lock: "pace" }
          : await deps.extraSlot?.(e.board, card, liveNow, maxSessions).catch(() => null);
      if (!extra?.open) {
        const why = slotWait(liveNow, extra ?? null);
        wait(e, why.reason, why.kind);
        continue;
      }
      viaExtraSlot = extra.why;
    }
    // A retomada de um `done` do train (só a projeção falta — o código já está em stage) não passa pelo teto: o gasto
    // de quem passou ao train já entrou no ledger, e segurá-la deixaria o trabalho integrado parado sem condutor vivo
    // para pedir o aumento (conductor-handoff.ts).
    const overBudget = e.handoff?.status === "done" ? null : await deps.budgetRefusal?.(e.board, card).catch(() => null);
    if (overBudget) {
      wait(e, overBudget, "budget");
      continue;
    }
    const gate = deps.admission?.();
    if (gate) consulted = true;
    if (gate && !gate.admit) {
      heldByAccount.push(`${e.board}/${e.cardId}`);
      wait(e, `janela da conta: ${gate.detail}`, `account:${gate.reason}`);
      continue;
    }

    // o teto pelo tipo fica VISÍVEL no card antes da sessão nascer (o despacho abaixo o deriva igual, com ou sem o carimbo)
    await deps.stampModelCap?.(e.board, e.cardId).catch(() => {});
    // Fase 7 — o LOTE: um líder loteável (correção/manutenção, fora de «Outros») recebe na tarefa os itens da MESMA
    // funcionalidade que esperam na fila (só os ids). Quem ESCOLHE é a sessão (claim_batch) — decisão 5 do dono.
    const candidates = featureKey && !e.solo && !e.handoff && batchable(card) ? await batchCandidates(e, featureKey) : [];
    const res = await deps
      .spawn({
        role: "implement",
        task: e.handoff
          ? conductorHandoffTask(e.board, e.cardId, e.handoff)
          : candidates.length
            ? conductorBatchTask(e.board, e.cardId, candidates)
            : conductorTask(e.board, e.cardId),
        board: e.board,
        cardId: e.cardId,
        // The board's model is the DEFAULT; the card's cap lowers it (see conductorModelFor) — the explicit
        // `routing.modelCap`, else the one its TYPE gets at admission (Sonnet for bug/chore, conductorModelCapFor).
        model: conductorModelFor(policy.model, conductorModelCapFor(card)),
        // A per-DISPATCH suffix (the recycle path's convention): a card re-dispatched after its conductor died gets a
        // NEW tmux name, so the dead registry row — same card, same old name — never looks alive again through the
        // new process (measured v0.9.0: the re-dispatched session resurrected the killed one and the board counted
        // 2 conductors for 1, starving the next card of a slot).
        name: conductorSessionSlug(e.cardId, (deps.now ?? Date.now)()),
        actor: "service:conductor",
        // The session is on the operator's behalf, not the copiloto's own (only copilot-spawned sessions are the
        // steward's to reap — a conductor waiting at a pause must not be). The go to BUILD is the plan critic's.
        spawnedBy: "human",
        driver: "conductor",
        command: conductorCommand(e.board, e.cardId),
      })
      .catch((err): SpawnSessionResult => ({ ok: false, code: "spawn_failed", reason: err instanceof Error ? err.message : String(err) }));

    if (res.ok) {
      if (featureKey) busyFeatures.set(`${e.board}/${featureKey.id}`, { sessionId: res.session.sessionId, cardId: e.cardId, via: "session" });
      liveCount.set(e.board, (liveCount.get(e.board) ?? 0) + 1);
      spawnedThisPass.set(e.board, [...(spawnedThisPass.get(e.board) ?? []), e.cardId]);
      servedBoards.add(e.board);
      report.spawned.push({ board: e.board, cardId: e.cardId, sessionId: res.session.sessionId, tmuxSession: res.tmuxSession });
      log(`${e.board}/${e.cardId} → condutor ${res.tmuxSession} (${res.route.model ?? "?"}, sessão ${res.session.sessionId.slice(0, 8)})`);
      if (viaExtraSlot) {
        log(`${e.board}/${e.cardId}: nasceu na VAGA EXTRA (${policy.maxSessions} + 1) — ${viaExtraSlot}`);
        await deps.onExtraSlot?.(e.board, card, viaExtraSlot).catch(() => {});
      }
      continue;
    }
    if (res.code === "no_capacity") {
      boxFull = true;
      wait(e, `máquina saturada: ${res.reason}`, "box-full");
      continue;
    }
    if (res.code === "card_claimed") {
      if (res.holder?.actor.startsWith("session:")) {
        drop(e, `outra sessão já é dona do card (${res.holder.actor}) — nenhum condutor novo`);
      } else {
        wait(e, `card reservado por ${res.holder?.actor ?? "?"} — tento no próximo tick`, "claimed");
      }
      continue;
    }
    const attempts = e.attempts + 1;
    if (attempts >= CONDUCTOR_MAX_SPAWN_ATTEMPTS) {
      const detail =
        `A dispatch do condutor falhou ${attempts}x ao abrir a sessão (${res.code}: ${res.reason}). O card segue com ` +
        `routing.driver: conductor, então nenhuma skill de coluna roda nele. Abra o condutor à mão ` +
        `(claude_new role:"implement" task:"/${CONDUCTOR_SKILL} ${e.board}/${e.cardId}") ou devolva o card à cascata ` +
        `(set_card_driver driver:null).`;
      await deps.stampDispatchFailure(e.board, e.cardId, detail).catch(() => {});
      drop(e, `spawn falhou ${attempts}x (${res.code}) — finding no card`);
      continue;
    }
    wait(e, `spawn falhou (${res.code}) — tentativa ${attempts}/${CONDUCTOR_MAX_SPAWN_ATTEMPTS}`, "spawn-failed", {
      attempts,
      lastError: `${res.code}: ${res.reason}`.slice(0, 300),
    });
  }

  await deps.queue.persist(keep.map((e) => (e.yielded && servedBoards.has(e.board) ? yieldServed(e) : e)));
  if (consulted || keep.length === 0) reportHeldSafe(deps, heldByAccount);
  return report;
}

/** A vez cedida foi servida (outro card do board ganhou a vaga): a entrada volta a disputar pelo seu tier. PURA. */
function yieldServed(e: ConductorQueueEntry): ConductorQueueEntry {
  const out = { ...e };
  delete out.yielded;
  return out;
}

// ── the END of a conductor whose story is over ──────────────────────────────────────────────────────────

/** How long a story must STAY over before its conductor is asked to leave — and how long `/exit` gets to take. */
export const CONDUCTOR_END_GRACE_MS = 10 * 60_000;

/** Per-session memory of the end pass. In-process on purpose: a restart only restarts the grace. */
export type ConductorEndState = Map<string, { finishedAt: number; exitAt?: number; note?: string }>;

export interface ConductorEndDeps
  extends Pick<ConductorDeps, "sessions" | "liveTmux" | "heartbeatAlive" | "readCard" | "readBoardConfig" | "now" | "log"> {
  /** is everything the session produced integrated? (session-worktree `sessionWorkSettled`) */
  workSettled(s: AgentSession): Promise<SessionWorkVerdict>;
  /** type `/exit` into the conductor's pane — only a pane proven to run claude; false = not delivered. */
  requestExit(s: AgentSession): Promise<boolean>;
  /** the last resort, when `/exit` did not take within a whole grace. */
  kill(s: AgentSession): Promise<void>;
  /** release the card claims the session holds (the tmux death would too, one tick later). */
  releaseClaims(s: AgentSession): Promise<void>;
  /**
   * Fase 7 — o LÍDER de um lote saiu (lixeira, adiado, sem driver): os ITENS ainda abertos da sessão perdem a marca do
   * lote, o claim e voltam à fila normal ({@link batchLeadDropped}). Ausente ⇒ os itens esperam o operador.
   */
  releaseBatchItems?(s: AgentSession, why: string): Promise<void>;
  /**
   * Fase 7 — a sessão de LOTE acabou (tudo entregue, ou o líder saiu): a marca do lote sai do líder e de cada item que
   * ainda a carrega (só a DESTE lote). Sem isso, um card reaberto depois herdaria o plano aprovado, o teto e o gasto do
   * lote antigo. Chamado para toda sessão que acaba (a que retomou só depois de uma divisão não tem lote na linha, mas
   * o líder dela guarda a marca). Ausente ⇒ as marcas ficam.
   */
  clearBatchMarks?(s: AgentSession): Promise<void>;
  state: ConductorEndState;
}

export interface ConductorEndReport {
  exited: string[];
  killed: string[];
  /** over, but ending it would lose work — it holds no slot, and stays until its work is integrated. */
  kept: Array<{ sessionId: string; reason: string }>;
}

/**
 * One END pass: every live conductor whose story has been over for a whole grace, and whose work is integrated,
 * is asked to `/exit` once, its claims released; one that is still there a grace after that is killed. The tmux
 * death is then the ordinary one — the fleet reconcile books its spend and the session GC forgets the row.
 * A tmux probe that did not answer ends nobody (not knowing who is alive is not evidence of anything).
 */
export async function endFinishedConductors(deps: ConductorEndDeps): Promise<ConductorEndReport> {
  const log = deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));
  const now = (deps.now ?? Date.now)();
  const report: ConductorEndReport = { exited: [], killed: [], kept: [] };
  const live = await deps.liveTmux().catch(() => null);
  if (live === null) return report;
  const conductors = (await deps.sessions().catch(() => [] as AgentSession[])).filter(
    (s) => !!s.tmuxSession && isLiveConductor(s, live, deps.heartbeatAlive),
  );
  const finished = await finishedConductors(deps, conductors);
  for (const id of deps.state.keys()) if (!finished.has(id)) deps.state.delete(id); // back to work, or gone

  for (const s of conductors) {
    const why = finished.get(s.sessionId);
    if (!why) continue;
    const st = deps.state.get(s.sessionId) ?? { finishedAt: now };
    deps.state.set(s.sessionId, st);
    const label = `${s.board}/${s.cardId} (${s.tmuxSession})`;
    if (st.exitAt !== undefined) {
      if (now - st.exitAt >= CONDUCTOR_END_GRACE_MS) {
        await deps.kill(s).catch(() => {});
        report.killed.push(s.sessionId);
        log(`${label}: o /exit não encerrou o condutor em ${CONDUCTOR_END_GRACE_MS / 60_000}min — sessão encerrada à força`);
      }
      continue;
    }
    if (now - st.finishedAt < CONDUCTOR_END_GRACE_MS) continue;
    const work = await deps.workSettled(s).catch((err): SessionWorkVerdict => ({ settled: false, reason: String(err) }));
    if (!work.settled) {
      report.kept.push({ sessionId: s.sessionId, reason: work.reason });
      if (st.note !== work.reason) log(`${label}: ${why}, mas o condutor fica — ${work.reason} (não ocupa vaga)`);
      st.note = work.reason;
      continue;
    }
    if (!(await deps.requestExit(s).catch(() => false))) continue; // tries again next tick
    st.exitAt = now;
    if (deps.releaseBatchItems && s.board && s.cardId && sessionCardIds(s).length > 1) {
      const [lead, config] = await Promise.all([deps.readCard(s.board, s.cardId).catch(() => null), deps.readBoardConfig(s.board).catch(() => null)]);
      if (batchLeadDropped(s, lead, config)) {
        await deps.releaseBatchItems(s, why).catch((err) => log(`${label}: os itens do lote não voltaram à fila (${err instanceof Error ? err.message : String(err)})`));
        log(`${label}: o líder do lote saiu (${why}) — os itens abertos voltam à fila`);
      }
    }
    if (deps.clearBatchMarks) {
      await deps.clearBatchMarks(s).catch((err) => log(`${label}: a marca do lote não saiu dos cards (${err instanceof Error ? err.message : String(err)})`));
    }
    await deps.releaseClaims(s).catch(() => {});
    report.exited.push(s.sessionId);
    log(`${label}: ${why} e ${work.detail} — /exit enviado ao condutor`);
  }
  return report;
}

// ── the ORPHAN terminal of a conductor that already left the registry ────────────────────────────────

/** A conductor's tmux name: `agent-` + {@link conductorSessionSlug}. Only names of THIS shape are ever touched. */
export const CONDUCTOR_TMUX_NAME = /^agent-conductor-[A-Za-z0-9][A-Za-z0-9_-]*-[a-z0-9]{4}$/;

/** Per-terminal memory of the orphan pass (tmux name → when it was first seen without a row, and the `/exit`). */
export type ConductorOrphanState = Map<string, { seenAt: number; exitAt?: number }>;

export interface ConductorOrphanDeps extends Pick<ConductorDeps, "sessions" | "liveTmux" | "now" | "log"> {
  /** the pane shows a drawn prompt (menu, y/N): typing `/exit` there would ANSWER it — leave it alone. */
  asking(tmux: string): boolean;
  /** type `/exit` — only into a pane proven to run claude; false = not delivered. */
  requestExit(tmux: string): Promise<boolean>;
  kill(tmux: string): Promise<void>;
  state: ConductorOrphanState;
}

export interface ConductorOrphanReport {
  exited: string[];
  killed: string[];
}

/**
 * One ORPHAN pass. A conductor ends its story by discarding its own worktree (`worktree_discard`), which removes
 * its row from the session registry — and {@link endFinishedConductors} only knows conductors that HAVE a row. The
 * `claude` process stays at its prompt in a tmux nobody tracks: it holds no slot and no claim, but it sits in the
 * operator's terminal list as if it were waiting for something (seen in practice: several such terminals, some for
 * hours). A terminal named like a conductor's, with no row for a whole grace, is asked to `/exit`; one that is
 * still there a grace later is killed. Nothing here can lose work: a session with a row — the only kind that can
 * own a worktree — is never touched, and a probe that did not answer ends nobody.
 */
export async function endOrphanConductorTerminals(deps: ConductorOrphanDeps): Promise<ConductorOrphanReport> {
  const log = deps.log ?? ((line: string) => console.log(`[conductor] ${line}`));
  const now = (deps.now ?? Date.now)();
  const report: ConductorOrphanReport = { exited: [], killed: [] };
  const live = await deps.liveTmux().catch(() => null);
  if (live === null) return report;
  // A registry that could not be read is not "no rows": without it nobody is an orphan.
  const sessions = await deps.sessions().catch(() => null);
  if (sessions === null) return report;
  const tracked = new Set(sessions.map((s) => s.tmuxSession).filter((n): n is string => !!n));
  const orphans = [...live].filter((name) => CONDUCTOR_TMUX_NAME.test(name) && !tracked.has(name));
  for (const name of deps.state.keys()) if (!orphans.includes(name)) deps.state.delete(name); // gone, or tracked again

  for (const name of orphans) {
    const st = deps.state.get(name) ?? { seenAt: now };
    deps.state.set(name, st);
    if (st.exitAt !== undefined) {
      if (now - st.exitAt >= CONDUCTOR_END_GRACE_MS) {
        await deps.kill(name).catch(() => {});
        report.killed.push(name);
        log(`${name}: terminal de condutor sem sessão registrada — o /exit não o encerrou em ${CONDUCTOR_END_GRACE_MS / 60_000}min, encerrado à força`);
      }
      continue;
    }
    if (now - st.seenAt < CONDUCTOR_END_GRACE_MS) continue; // a spawn writes its row within seconds; a grace is ample
    if (deps.asking(name)) continue;
    if (!(await deps.requestExit(name).catch(() => false))) continue; // tries again next tick
    st.exitAt = now;
    report.exited.push(name);
    log(`${name}: terminal de condutor sem sessão registrada há ${CONDUCTOR_END_GRACE_MS / 60_000}min (a sessão já se encerrou) — /exit enviado`);
  }
  return report;
}
