// O COLETOR DE SAÚDE — a única leitura de disco do relatório (ah-health.ts é puro). SOMENTE-LEITURA: nenhuma
// função daqui escreve, move, libera ou reinicia nada; ela só reúne o que os outros módulos já sabem.
//
// REUSA, não reimplementa: o Inbox por board (`collectBoardInbox`, a mesma fonte de toda superfície do dono), o
// agrupamento de raias (`groupStoriesByLane`), a junção da frota (`buildFleetRows`, a definição de «vivo» que o resto
// do produto usa) mais a evidência de «quieto» do condutor (`conductorQuiet`), e os ledgers (transições, fila do
// condutor, disjuntor de publicação, vigia de parados, ações MCP, eventos). Cada mapeamento que decide algo é uma
// função PURA exportada e testada; o que sobra é IO fino.
//
// Falha de leitura de UM ledger vira «vazio» (o sinal fica verde para aquela fatia) — exceto a sonda do tmux, que decide
// ÓBITO no resto do produto e aqui é fail-closed: se ela não respondeu, o S4 diz «não medível» em vez de «tudo bem».

import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { collectBoardInbox, type BoardInbox } from "@/lib/storymap/inbox/collect";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { effectiveQuestionCategory, isOwnerOnlyQuestion, PROXIABLE_CATEGORIES } from "@/lib/storymap/autonomy";
import { deliveredStatusIds } from "@/lib/storymap/delivered";
import { isDeployStep } from "@/lib/storymap/demands";
import { ownerDecisionsFromEntries } from "@/lib/storymap/inbox/decidir-set";
import { boardLanes, groupStoriesByLane } from "@/lib/storymap/lanes";
import { runnerStateDir } from "@/lib/storymap/paths";
import { listBoards } from "@/lib/storymap/repo";
import { rolloutBoardReport } from "@/lib/storymap/rollout";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { currentTerminalAttention } from "@/lib/terminal/attention-watch";
import { probeLiveTmuxSessions } from "@/lib/vps/tmux";
import { readAgentActions, type AgentAction } from "@/lib/storymap/runner/agent-actions";
import { type CardClaim, getCardClaims, isClaimLive, sessionClaimActor } from "@/lib/storymap/runner/claims";
import { conductorQuiet, type ConductorQuiet } from "@/lib/storymap/runner/conductor-quiet";
import { CONDUCTOR_TMUX_NAME, diskConductorQueueStore } from "@/lib/storymap/runner/conductor";
import { readInboxReceipts } from "@/lib/storymap/runner/receipts-log";
import { buildFleetRows } from "@/lib/storymap/runner/fleet-view";
import { tryGetPublishBreaker } from "@/lib/storymap/runner/publish-breaker";
import type { AgentSession } from "@/lib/storymap/runner/session-worktree";
import { allSessions } from "@/lib/storymap/runner/session-worktree";
import { readTransitions } from "@/lib/storymap/runner/transitions";
import {
  isOutcomeOption,
  type HealthClaim,
  type HealthDemandLane,
  type HealthFleetRow,
  type HealthInboxEntry,
  type HealthInputs,
  type HealthOpenTechnicalQuestion,
  type HealthPublishWaiting,
  type HealthToolFailure,
} from "./ah-health";

// ── mapeamentos PUROS ────────────────────────────────────────────────────────────────────────────────

/** O marcador que o condutor põe numa pergunta sempre-humana (o mesmo que o piso de autonomy.ts lê). */
const OWNER_MARKER = /^\s*\[humano\]/i;

/** Quanto tempo uma amostra de entrega fica em Acompanhar para o dono olhar (C8); depois é registro. */
const SAMPLE_TTL_MS = 7 * 86_400_000;

/**
 * Esta linha de Acompanhar é do contrato (RC2/C8)? Ficam só (i) o que o dono COMBINOU rever — o aceite de triagem de
 * história `user` (o veto prometido a ele) e a amostra de entrega dentro de 7 dias — e (ii) o trabalho do sistema em
 * andamento, ou parado sem ninguém cuidando (`next.stalled`, o alarme honesto). O resto é registro: as outras decisões
 * do sistema (a maioria das linhas) e o aviso que nada espera («Nada trava»). PURA.
 *
 * É a régua com que o S2 MEDE o Inbox, independente de quem monta o Inbox: quando o coletor do Inbox passar a cumprir o
 * contrato, o S2 cai sozinho e o card `[saude:S2]` fecha por delta.
 */
export function followUpAllowedOf(e: InboxEntry, ctx: { decisionKind?: string; storyType?: string | null; now: number }): boolean {
  if (e.kind === "system-decision") return ctx.decisionKind === "triage-accept" && ctx.storyType === "user";
  if (e.kind === "delivery-audit") return ctx.now - Date.parse(e.decision.since ?? "") <= SAMPLE_TTL_MS;
  return e.decision.next.who !== "ninguem" || !!e.decision.next.stalled;
}

/**
 * As entradas do Inbox de um board, reduzidas ao que os sinais leem. PURA.
 *
 * `floorOnly` responde «a classe de dono desta pergunta veio SÓ do piso de palavras de dinheiro?» sem depender do
 * texto do veredito: o piso dispara, o autor NÃO declarou dinheiro, não há `[humano]` e nem o autor nem o
 * classificador disseram que a pergunta é do dono. Foi assim que as perguntas técnicas de ciclo extra (que só
 * citavam «custo estimado» e «funções pagas») foram parar no dono com a classe «dinheiro».
 */
export function inboxEntriesOf(inbox: Pick<BoardInbox, "boardId" | "entries" | "cards" | "decisions">, now: number): HealthInboxEntry[] {
  const cardsById = new Map(inbox.cards.map((c) => [c.id, c]));
  const decisionKind = new Map(inbox.decisions.map((d) => [`sd:${d.id}`, d.kind]));
  return inbox.entries.map((e: InboxEntry): HealthInboxEntry => {
    const d = e.decision;
    let floorOnly = false;
    if (e.item?.kind === "question" && d.verdict.decider === "owner" && d.verdict.ownerClass != null) {
      const q = cardsById.get(e.cardId)?.questions?.find((x) => x.id === (e.item as { questionId: string }).questionId);
      if (q) {
        floorOnly =
          q.category !== "money" &&
          effectiveQuestionCategory(q) !== "owner" &&
          !OWNER_MARKER.test(q.text ?? "") &&
          !OWNER_MARKER.test(q.context ?? "") &&
          !q.proxy?.declined &&
          q.proxy?.auditOutcome !== "reopened" &&
          isOwnerOnlyQuestion(q);
      }
    }
    return {
      board: inbox.boardId,
      cardId: e.cardId,
      kind: e.kind,
      bucket: d.bucket,
      decider: d.verdict.decider,
      ownerClass: d.verdict.ownerClass,
      floorOnly,
      executable: d.options.filter(isOutcomeOption).length,
      followUpAllowed: d.bucket === "acompanhar" && followUpAllowedOf(e, { decisionKind: decisionKind.get(e.itemId), storyType: cardsById.get(e.cardId)?.storyType, now }),
    };
  });
}

/**
 * Os cards que a raia do dono do board mostra, MEDIDOS pela mesma função que o Kanban usa (`groupStoriesByLane` com o
 * Decidir do Inbox); `null` quando o board não tem raia do dono. PURA. Depois do WP4 a raia é o Decidir por
 * construção — este sinal existe para pegar a regressão (um card na raia fora do Decidir, ou o contrário).
 */
export function demandLaneOf(boardId: string, config: BoardConfig, cards: readonly Card[], entries: readonly InboxEntry[]): HealthDemandLane | null {
  const lanes = boardLanes(config);
  const demandLane = lanes?.find((l) => l.demand);
  if (!lanes || !demandLane) return null;
  const { byLane } = groupStoriesByLane(
    cards.filter((c) => c.type === "story"),
    lanes,
    { owner: ownerDecisionsFromEntries(entries, boardId) },
  );
  return { board: boardId, laneId: demandLane.id, cardIds: (byLane.get(demandLane.id) ?? []).map((c) => c.id) };
}

/**
 * Os statuses onde o código aprovado ESPERA a publicação: o passo que dispara o deploy e os dois repousos canônicos antes
 * dele (`stage`/`release` — vocabulário da pipeline, o mesmo que a demanda de «publicar código aprovado» já usa).
 */
const PUBLISH_REST_STATUSES: ReadonlySet<string> = new Set(["stage", "release"]);

/** Os cards (história viva) que esperam publicação neste board. PURA. */
export function publishWaitingOf(boardId: string, config: BoardConfig, cards: readonly Card[]): HealthPublishWaiting[] {
  const defs = new Map(config.statuses.map((s) => [s.id, s]));
  return cards
    .filter((c) => {
      if (c.type !== "story" || !c.status) return false;
      const def = defs.get(c.status);
      return !def?.terminal && (isDeployStep(def) || PUBLISH_REST_STATUSES.has(c.status));
    })
    .map((c) => ({ board: boardId, cardId: c.id }));
}

/**
 * As perguntas técnicas abertas que o proxy ainda não respondeu — só em board só-negócio (é onde o proxy existe) e em
 * card vivo. «Técnica» = a categoria efetiva é uma das que o proxy responde. PURA.
 */
export function openTechnicalQuestionsOf(boardId: string, config: BoardConfig, cards: readonly Card[]): HealthOpenTechnicalQuestion[] {
  if (config.autonomy?.mode !== "ultra") return [];
  const terminal = new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id));
  const out: HealthOpenTechnicalQuestion[] = [];
  for (const c of cards) {
    if (c.type !== "story" || (c.status && terminal.has(c.status))) continue;
    for (const q of c.questions ?? []) {
      if (q.status !== "open" || q.proxy) continue;
      const cat = effectiveQuestionCategory(q);
      if (!cat || !PROXIABLE_CATEGORIES.includes(cat)) continue;
      out.push({ board: boardId, cardId: c.id, questionId: q.id, askedAt: q.askedAt ?? null });
    }
  }
  return out;
}

/**
 * A assinatura estável de uma falha da FERRAMENTA (e não do produto) a partir do texto que o run deixou, ou `null`.
 * Assinaturas conhecidas: o sandbox que não sobe (seccomp/bwrap) e o binário do CLI que não abre. É o que deixa «o mesmo
 * erro em 3 runs» virar UMA contagem, em vez de três cards de produto «parados» por uma causa que nenhum condutor de
 * produto consegue consertar. PURA.
 */
export function infraSignatureOf(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/apply-seccomp|setgroups[^\n]{0,60}Permission denied/i.test(text)) return "sandbox:seccomp";
  if (/\bbwrap\b[^\n]{0,80}(?:denied|failed|not permitted)/i.test(text)) return "sandbox:bwrap";
  if (/spawn\s+\S*claude\S*\s+ENOENT/i.test(text)) return "spawn:claude-enoent";
  return null;
}

/** Os eventos `settled` do runner que não terminaram bem e cuja causa é uma falha conhecida da ferramenta. PURA. */
export function toolFailuresFromEvents(lines: readonly unknown[]): HealthToolFailure[] {
  const out: HealthToolFailure[] = [];
  for (const raw of lines) {
    const ev = raw as { type?: string; outcome?: string; board?: string; cardId?: string; at?: number | string; result?: { finalText?: unknown } } | null;
    if (!ev || ev.type !== "settled" || ev.outcome === "ok" || !ev.board || !ev.cardId) continue;
    const at = Number(ev.at);
    const signature = infraSignatureOf(typeof ev.result?.finalText === "string" ? ev.result.finalText : null);
    if (signature && Number.isFinite(at)) out.push({ signature, at, board: ev.board, cardId: ev.cardId });
  }
  return out;
}

/**
 * A frota como o S4 a lê: quem está vivo, quem está quieto, quem tem o worktree apagado, os terminais sem linha e os
 * claims cuja sessão não está viva. PURA — o IO (tmux, transcript, disco) já foi lido por quem chama.
 */
export function fleetHealthOf(input: {
  sessions: readonly AgentSession[];
  claims: readonly CardClaim[];
  /** nomes dos terminais tmux vivos agora. */
  liveTmux: ReadonlySet<string>;
  /** a evidência de «quieto» de cada condutor vivo, por sessionId. */
  quiet: ReadonlyMap<string, ConductorQuiet>;
  worktreeExists: (path: string) => boolean;
  now: number;
}): { fleet: HealthFleetRow[]; orphanTerminals: string[]; claims: HealthClaim[] } {
  const { now } = input;
  const rows = buildFleetRows(
    { sessions: [...input.sessions], claims: [...input.claims], entries: [], liveTmux: new Set(input.liveTmux), contextBySession: new Map(), recycleThresholdPct: 100 },
    now,
  );
  const byId = new Map(input.sessions.map((s) => [s.sessionId, s]));
  const claimAge = (c: CardClaim) => Math.max(0, now - Date.parse(c.acquiredAt));
  const liveClaims = input.claims.filter((c) => isClaimLive(c, now));
  const aliveAgents = new Set(rows.filter((r) => r.alive && r.processAlive !== false).map((r) => r.agentId));

  const fleet = rows.map((r): HealthFleetRow => {
    const s = byId.get(r.sessionId);
    const claim = liveClaims.find((c) => c.actor === sessionClaimActor(r.agentId) && c.board === r.board && c.cardId === r.cardId);
    const q = input.quiet.get(r.sessionId);
    return {
      agentId: r.agentId,
      board: r.board,
      cardId: r.cardId,
      alive: r.alive && r.processAlive !== false,
      isConductor: s?.driver === "conductor",
      quietForMs: q?.quietForMs ?? null,
      declaredWaiting: !!s?.progress?.waiting,
      asking: q?.asking ?? false,
      worktreeMissing: !!r.worktreePath && !input.worktreeExists(r.worktreePath),
      claimAgeMs: claim ? claimAge(claim) : null,
    };
  });

  const tracked = new Set(input.sessions.map((s) => s.tmuxSession).filter((n): n is string => !!n));
  const orphanTerminals = [...input.liveTmux].filter((name) => CONDUCTOR_TMUX_NAME.test(name) && !tracked.has(name));

  const claims = liveClaims
    .filter((c) => c.actor.startsWith("session:"))
    .map((c): HealthClaim => ({ board: c.board, cardId: c.cardId, actor: c.actor, claimAgeMs: claimAge(c), holderAlive: aliveAgents.has(c.actor.slice("session:".length)) }));

  return { fleet, orphanTerminals, claims };
}

/** A ação MCP diz QUEM a fez? (Hoje nenhuma diz: o ator é só o nome do token — a lacuna que o S11 mede.) */
type AttributedAction = AgentAction & { sessionId?: string; actorKind?: string };

/** A fatia de atribuição das ações MCP da janela. PURA. */
export function attributionOf(actions: readonly AttributedAction[]): { actions: number; attributed: number; ownerSessionActions: number } {
  return {
    actions: actions.length,
    attributed: actions.filter((a) => a.sessionId || a.actorKind).length,
    ownerSessionActions: actions.filter((a) => a.actorKind === "owner-session").length,
  };
}

// ── IO ───────────────────────────────────────────────────────────────────────────────────────────────

/** As últimas linhas do events.jsonl, tolerantes: uma linha quebrada é pulada. */
async function readEvents(): Promise<unknown[]> {
  const raw = await fsp.readFile(path.join(runnerStateDir(), "events.jsonl"), "utf8").catch(() => "");
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* linha parcial — o arquivo é append-only */
    }
  }
  return out;
}

export interface CollectHealthOptions {
  /** quantas horas de ações MCP entram na atribuição do S11. */
  attributionWindowHours?: number;
}

/**
 * Lê tudo e monta os `HealthInputs`. Custo: o mesmo do Inbox de todos os boards (uma passada pelos cards) mais seis
 * ledgers pequenos e, no máximo, um `capture-pane` por condutor vivo cujo transcript está quieto há mais de 2 min.
 */
export async function collectHealthInputs(now: number = Date.now(), opts: CollectHealthOptions = {}): Promise<HealthInputs> {
  const attributionSince = now - (opts.attributionWindowHours ?? 24) * 3_600_000;
  // Import dinâmico: as deps do vigia de parados puxam o engine e o merge train, que este módulo (e o teste dos
  // mapeamentos puros acima) não precisa carregar só para existir.
  const { diskStallLedger, QUIET_IO } = await import("@/lib/storymap/runner/stall-watch-deps");
  const [boards, receipts] = await Promise.all([listBoards(), readInboxReceipts().catch(() => [])]);
  const inboxes = (
    await Promise.all(
      boards.map((b) =>
        collectBoardInbox(b.id, now, { receipts }).catch((err) => {
          console.warn(`[health] o board ${b.id} não pôde ser lido:`, err instanceof Error ? err.message : err);
          return null;
        }),
      ),
    )
  ).filter((x): x is BoardInbox => x != null);

  const [transitions, sessions, claims, probe, queue, breaker, stallRows, events, actions] = await Promise.all([
    readTransitions().catch(() => []),
    allSessions().catch(() => [] as AgentSession[]),
    getCardClaims().list().catch(() => [] as CardClaim[]),
    probeLiveTmuxSessions().catch(() => ({ ok: false as const })),
    diskConductorQueueStore().load().catch(() => []),
    (tryGetPublishBreaker()?.snapshot() ?? Promise.resolve([])).catch(() => []),
    diskStallLedger().load().catch(() => []),
    readEvents(),
    readAgentActions({ since: attributionSince }).catch(() => [] as AgentAction[]),
  ]);

  // Frota: a sonda do tmux decide óbito no resto do produto — sem resposta dela, ninguém é julgado.
  const liveTmux = probe.ok ? new Set(probe.names) : null;
  let fleetPart: ReturnType<typeof fleetHealthOf> = { fleet: [], orphanTerminals: [], claims: [] };
  if (liveTmux) {
    const attention = new Map(currentTerminalAttention().map((t) => [t.session, t]));
    const quiet = new Map<string, ConductorQuiet>();
    await Promise.all(
      sessions
        .filter((s) => s.driver === "conductor" && s.tmuxSession && liveTmux.has(s.tmuxSession))
        .map(async (s) => quiet.set(s.sessionId, await conductorQuiet(s, attention.get(s.tmuxSession!), now, QUIET_IO))),
    );
    fleetPart = fleetHealthOf({ sessions, claims, liveTmux, quiet, worktreeExists: existsSync, now });
  }

  const demandLanes: HealthDemandLane[] = [];
  const deliveredStatuses: Record<string, string[]> = {};
  const publishWaiting: HealthPublishWaiting[] = [];
  const openTechnicalQuestions: HealthOpenTechnicalQuestion[] = [];
  const cards: HealthInputs["cards"] = [];
  let liveStories = 0;
  let technicalTouches = 0;
  for (const inbox of inboxes) {
    const lane = demandLaneOf(inbox.boardId, inbox.config, inbox.cards, inbox.entries);
    if (lane) demandLanes.push(lane);
    deliveredStatuses[inbox.boardId] = [...deliveredStatusIds(inbox.config)];
    publishWaiting.push(...publishWaitingOf(inbox.boardId, inbox.config, inbox.cards));
    openTechnicalQuestions.push(...openTechnicalQuestionsOf(inbox.boardId, inbox.config, inbox.cards));
    for (const c of inbox.cards) if (c.type === "story") cards.push({ board: inbox.boardId, cardId: c.id, status: c.status ?? null });
    if (inbox.config.autonomy?.mode === "ultra") {
      const firstDecision = inbox.decisions.map((d) => d.at).sort()[0] ?? null;
      const report = rolloutBoardReport(transitions, { id: inbox.boardId, name: inbox.boardName, config: inbox.config, cards: inbox.cards, firstSystemDecisionAt: firstDecision });
      liveStories += report.live;
      technicalTouches += report.touched.reduce((sum, t) => sum + t.technical, 0);
    }
  }

  const attribution = attributionOf(actions as AttributedAction[]);
  return {
    now,
    inbox: inboxes.flatMap((b) => inboxEntriesOf(b, now)),
    demandLanes,
    cards,
    transitions: transitions.flatMap((t) => {
      const at = Date.parse(t.at);
      return Number.isFinite(at) ? [{ board: t.board, cardId: t.cardId, to: t.to, at, actor: t.actor }] : [];
    }),
    deliveredStatuses,
    publishWaiting,
    publishHeld: breaker
      .filter((a) => publishWaiting.some((w) => w.board === a.board && w.cardId === a.cardId))
      .map((a) => ({ board: a.board, cardId: a.cardId, phase: a.phase, exitCode: a.exitCode })),
    fleetKnown: liveTmux != null,
    ...fleetPart,
    conductorQueue: queue.flatMap((q) => {
      const queuedAt = Date.parse(q.queuedAt);
      return Number.isFinite(queuedAt) ? [{ board: q.board, cardId: q.cardId, queuedAt }] : [];
    }),
    stall: stallRows.map((r) => ({ key: r.key, firstSeenAt: r.firstSeenAt, ...(r.escalatedAt != null ? { escalatedAt: r.escalatedAt } : {}) })),
    toolFailures: toolFailuresFromEvents(events),
    attribution: { actions: attribution.actions, attributed: attribution.attributed },
    touches: { liveStories, technicalTouches, ownerSessionActions: attribution.ownerSessionActions },
    openTechnicalQuestions,
  };
}
