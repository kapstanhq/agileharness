// A PASSAGEM AO TRAIN — o condutor termina quando a fila de merge ACEITA a submissão, e o serviço fecha o ciclo.
//
// O CUSTO que motivou: o bloco PUBLICAR mantinha a sessão do condutor viva esperando o veredito do merge train
// (`wait_for_submit` re-chamado a cada 10 min). Cada espera relia o contexto inteiro da sessão — medido em ~US$ 1,60
// por sessão só esperando — e a sessão segurava uma vaga do board durante o gate inteiro, com cards na fila.
//
// O CONTRATO NOVO (skill harness-conductor, PUBLICAR): depois de `worktree_submit` aceito, o condutor escreve no card
// a nota `## Estado do condutor` (o que submeteu, o que falta), solta o claim, descarta o worktree DECLARANDO a passagem
// (`worktree_discard({sessionId, handoff: true})` — o branch com trabalho não integrado é PRESERVADO como
// `failed/agent/<id>`, e o train integra pelo sha PINADO, reparando a ref renomeada) e ENCERRA a sessão, mantendo
// `routing.driver: conductor`.
//
// POR QUE A PASSAGEM É DECLARADA (e não deduzida da sessão): a primeira versão gravava a passagem de toda sessão com
// `driver: conductor` que saísse com QUALQUER entrada no train — e a entrada de um checkpoint de dados já `done`
// (MOLDAR/CONSTRUIR) fica no snapshot. Um condutor estacionado por quietude (que CEDEU a vaga) voltava então para a
// FRENTE da fila pela passagem, desfazendo a cessão. E o condutor aberto à mão (`claude_new`, `worktree_open`) não tem
// `driver` na linha do registro — a passagem dele nunca era gravada e o card ficava para sempre com o driver. Só quem
// diz «estou passando ao train» passa; o estacionar (conductor-pause.ts) descarta SEM a marca.
//
// O QUE ESTE MÓDULO FAZ (o serviço fecha o ciclo):
//   1. REGISTRAR — no descarte com `handoff: true` (onSessionEnd) de uma sessão de card cuja submissão está no train,
//      grava a passagem num arquivo durável (`.runner/conductor-handoffs.json`).
//   2. ASSENTAR — a cada tick da frota, ANTES do pump, cada passagem cuja entrada do train já tem VEREDITO é decidida
//      UMA vez: o card ainda conduzido e sem dono vivo volta para a FRENTE da fila do condutor (retomada, numa sessão
//      NOVA que recebe na tarefa o sessionId de quem submeteu e o veredito), tanto numa devolução (conflito, gate
//      reprovado, merge falho) quanto num `done`.
//
// POR QUE O `done` TAMBÉM RETOMA (medido no código, não suposto): nenhum fluxo do train avança o status de um card
// conduzido. A metade de dados funde o card 3-way, e o `status` do worktree só vence quando main NÃO o moveu depois
// do corte (card-merge.ts `mergeCardThreeWay`) — e o condutor move o card em main (por move_card) durante o build;
// `update_card` recusa `status`; e a cascata é muda para um card com driver. Quem leva o card a «Aprovar entrega»
// depois do `done` é a projeção do condutor (PUBLICAR passo 5, com o gate de verdade) — feita agora por uma sessão
// curta, que o teto de gasto do card NÃO segura (conductor.ts: a retomada de um `done` não passa pelo teto — o código
// já está em stage e só falta a projeção).
//
// O LIMITE: devoluções SEGUIDAS do mesmo card são contadas; passadas {@link CONDUCTOR_HANDOFF_MAX_RETURNS}, o serviço
// para de reabrir condutores (um gate vermelho persistente, uma divergência que volta sempre — cada volta é uma sessão
// Opus inteira na frente da fila) e deixa um finding no card para o operador. O `done` zera a conta.
//
// O driver fica `conductor` durante toda a passagem e enquanto o card espera na fila (a cascata segue muda); quem o
// limpa é o condutor no fim da story (P5), como sempre. Uma passagem NUNCA retoma um card que já acabou (entregue,
// terminal, adiado, sem driver), um card com alguém vivo nele, nem um card com pergunta aberta (a resposta é que o
// acorda — conductor-pause.ts), nem uma submissão que outra mais nova do mesmo card substituiu. Núcleo puro + IO
// injetado (a convenção do runner); as deps de produção moram em fleet-deps.ts.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { openQuestions } from "@/lib/storymap/questions";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { conductorDoneReason, isLiveSession } from "./conductor";
import { isActiveMergeStatus } from "./merge-status";
import { sessionCardIds, type AgentSession } from "./session-worktree";
import type { MergeQueueEntry } from "./types";

/** O que a passagem lê de uma entrada do train. */
export type TrainEntryView = Pick<MergeQueueEntry, "runId" | "board" | "cardId" | "status" | "enqueuedAt" | "conflictDetail" | "failureReason">;

/** O veredito de uma entrada, guardado na passagem na primeira vez que o tick o vê (a poda do train não o perde). */
export type HandoffTrainVerdict = Pick<MergeQueueEntry, "status" | "conflictDetail" | "failureReason">;

/** Uma passagem: a submissão `runId` do condutor do card ficou com o train quando a sessão terminou. */
export interface ConductorHandoff {
  board: string;
  cardId: string;
  /** o runId da entrada no train (== o sessionId da sessão que submeteu — `wait_for_submit` o aceita). */
  runId: string;
  /** quando a sessão terminou (ISO). */
  at: string;
  /** quando a entrada entrou no train (epoch ms) — a régua de «uma submissão MAIS NOVA do mesmo card». */
  enqueuedAt?: number;
  /** o veredito já visto (ver {@link HandoffTrainVerdict}); ausente = ainda não visto fora do train ativo. */
  verdict?: HandoffTrainVerdict;
  /**
   * Fase 7 — os ITENS do lote que a submissão levou (além do líder `cardId`). A retomada os re-pega (`claim_batch`); o
   * `done` dá a cada um o seu `commitRange` (pelos trailers `Card:`); a funcionalidade segue ocupada até o veredito.
   */
  batchCardIds?: string[];
}

/** O arquivo inteiro: as passagens pendentes e as devoluções SEGUIDAS já readmitidas por card (`board/cardId`). */
export interface ConductorHandoffState {
  entries: ConductorHandoff[];
  returns: Record<string, number>;
}

export interface ConductorHandoffStore {
  load(): Promise<ConductorHandoffState>;
  persist(state: ConductorHandoffState): Promise<void>;
}

/**
 * Devoluções SEGUIDAS do train que o serviço ainda readmite para o mesmo card. Na seguinte, ele para e deixa um
 * finding no card ({@link CONDUCTOR_HANDOFF_FINDING_ID}): o mesmo «no máximo 2 voltas» do VERIFICAR, agora em código.
 */
export const CONDUCTOR_HANDOFF_MAX_RETURNS = 2;

/**
 * Uma passagem cuja entrada NÃO aparece no train e que nunca teve o veredito visto espera até este prazo antes de ser
 * encerrada: uma fila que não carregou (leitura do store falhou) não pode descartar as passagens no primeiro tick.
 */
export const CONDUCTOR_HANDOFF_MISSING_TTL_MS = 6 * 60 * 60_000;

/** O finding que o operador vê quando o serviço para de reabrir condutores para o card. */
export const CONDUCTOR_HANDOFF_FINDING_ID = "conductor-handoff";

const cardKey = (board: string, cardId: string) => `${board}/${cardId}`;

/** `storymap/.runner/conductor-handoffs.json` (gitignored com o resto de `.runner/`). */
export function conductorHandoffsPath(): string {
  return path.join(runnerStateDir(), "conductor-handoffs.json");
}

/** Disco — temp+rename atômico; ilegível ⇒ vazio (o card segue com o driver, e o vigia de card parado o mostra). */
export function diskConductorHandoffStore(file: string = conductorHandoffsPath()): ConductorHandoffStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as { entries?: unknown; returns?: unknown };
        const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
        const entries = list.filter(
          (e): e is ConductorHandoff =>
            !!e &&
            typeof e === "object" &&
            typeof (e as ConductorHandoff).board === "string" &&
            typeof (e as ConductorHandoff).cardId === "string" &&
            typeof (e as ConductorHandoff).runId === "string",
        );
        const returns: Record<string, number> = {};
        if (parsed?.returns && typeof parsed.returns === "object") {
          for (const [k, v] of Object.entries(parsed.returns as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) returns[k] = Math.floor(v);
          }
        }
        return { entries, returns };
      } catch {
        return { entries: [], returns: {} };
      }
    },
    async persist(state) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteFile(file, JSON.stringify({ v: 1, entries: state.entries, returns: state.returns }, null, 2));
    },
  };
}

/** Em memória (testes). */
export function memoryConductorHandoffStore(
  seed: ConductorHandoff[] = [],
  returns: Record<string, number> = {},
): ConductorHandoffStore & { entries: ConductorHandoff[]; returns: Record<string, number> } {
  const box: ConductorHandoffState = { entries: seed.map((e) => ({ ...e })), returns: { ...returns } };
  return {
    get entries() {
      return box.entries;
    },
    get returns() {
      return box.returns;
    },
    async load() {
      return { entries: box.entries.map((e) => ({ ...e })), returns: { ...box.returns } };
    },
    async persist(state) {
      box.entries = state.entries.map((e) => ({ ...e }));
      box.returns = { ...state.returns };
    },
  };
}

const HANDOFF_LOCK = "conductor-handoffs";

/** Como a sessão terminou: `handoff` = ela DECLAROU a passagem ao train (`worktree_discard({…, handoff: true})`). */
export interface SessionEndInfo {
  handoff?: boolean;
}

/**
 * A passagem que esta sessão deixa ao terminar — ou null. PURA. Só quando a sessão DECLAROU a passagem, tem card, e a
 * submissão dela (a entrada do train com `runId === sessionId` — um reenvio da mesma sessão SUBSTITUI a entrada
 * anterior, então esta é sempre a última) existe: sem submissão não há veredito a esperar. O `driver` da linha do
 * registro NÃO conta: o condutor aberto à mão não o tem (quem decide se o card ainda é do condutor é o assentamento,
 * lendo o CARD).
 */
export function handoffFor(
  session: Pick<AgentSession, "sessionId" | "board" | "cardId" | "batch">,
  end: SessionEndInfo | undefined,
  entries: readonly Pick<MergeQueueEntry, "runId" | "enqueuedAt">[],
  at: string,
): ConductorHandoff | null {
  if (!end?.handoff || !session.board || !session.cardId) return null;
  const own = entries.find((e) => e.runId === session.sessionId);
  if (!own) return null;
  const items = sessionCardIds(session).filter((id) => id !== session.cardId);
  return {
    board: session.board,
    cardId: session.cardId,
    runId: session.sessionId,
    at,
    ...(typeof own.enqueuedAt === "number" ? { enqueuedAt: own.enqueuedAt } : {}),
    ...(items.length ? { batchCardIds: items } : {}),
  };
}

/**
 * REGISTRAR — grava a passagem da sessão que está saindo (idempotente por runId). Chamado no descarte da sessão
 * (onSessionEnd), o último instante em que o serviço ainda sabe de quem era a submissão.
 */
export async function recordConductorHandoff(
  store: ConductorHandoffStore,
  session: Pick<AgentSession, "sessionId" | "board" | "cardId" | "batch">,
  end: SessionEndInfo | undefined,
  entries: readonly Pick<MergeQueueEntry, "runId" | "enqueuedAt">[],
  now: number = Date.now(),
): Promise<ConductorHandoff | null> {
  const handoff = handoffFor(session, end, entries, new Date(now).toISOString());
  if (!handoff) return null;
  return withKeyedLock(HANDOFF_LOCK, async () => {
    const state = await store.load();
    if (state.entries.some((h) => h.runId === handoff.runId)) return handoff;
    await store.persist({ ...state, entries: [...state.entries, handoff] });
    return handoff;
  });
}

/** O que fazer com UMA passagem agora. */
export type HandoffVerdict =
  /** o train ainda está com a entrada (ou o card não foi lido agora): a passagem fica para o próximo tick. */
  | { kind: "keep"; why: string }
  /** a passagem está resolvida sem condutor novo (o card acabou, alguém já está nele, a resposta o acorda…). */
  | { kind: "drop"; why: string }
  /** veredito do train com o card ainda do condutor: volta para a FRENTE da fila (retomada, sessão nova). */
  | { kind: "resume"; why: string; status: MergeQueueEntry["status"] }
  /** devoluções demais seguidas: o serviço para de reabrir e deixa o finding para o operador. */
  | { kind: "give-up"; why: string; status: MergeQueueEntry["status"] };

const SUPERSEDED = /^superseded/i;

/**
 * A régua de UMA passagem. PURA. Em ordem:
 *   • a entrada não aparece no train e o veredito nunca foi visto ⇒ keep até {@link CONDUCTOR_HANDOFF_MISSING_TTL_MS}
 *     depois do descarte (a fila pode não ter carregado), depois drop;
 *   • entrada ainda ATIVA (waiting / gate-running / merging) ⇒ keep;
 *   • `failed` por SUBSTITUIÇÃO (`superseded …` — um run mais novo do card, ou o card movido/reaberto) ⇒ drop: quem
 *     substituiu é dono do próximo passo;
 *   • outra entrada do MESMO card enfileirada DEPOIS desta ⇒ drop (a submissão mais nova tem quem a acompanhe);
 *     outra entrada do card ainda ATIVA ⇒ keep (espera ela assentar);
 *   • card ilegível agora (`undefined`) ⇒ keep; card que não existe (`null`) ⇒ drop;
 *   • alguém VIVO no card (qualquer sessão — o próprio condutor que ainda não saiu, um terminal do operador) ⇒ keep:
 *     decidir com ele lá dentro seria abrir um segundo agente no mesmo card;
 *   • card já na fila ⇒ drop (já está voltando);
 *   • story acabou (entregue, terminal, adiado, descontinuado, sem driver — {@link conductorDoneReason}) ⇒ drop;
 *   • pergunta aberta no card ⇒ drop: a resposta é que acorda o card (conductor-pause.ts), e a nota já diz qual
 *     submissão ler;
 *   • `done` ⇒ resume (a projeção);
 *   • devolução com {@link CONDUCTOR_HANDOFF_MAX_RETURNS} devoluções seguidas já readmitidas ⇒ give-up; senão resume.
 */
export function handoffVerdict(input: {
  handoff: Pick<ConductorHandoff, "at" | "enqueuedAt" | "verdict">;
  /** a entrada do train desta passagem, AGORA (undefined = não está no snapshot). */
  entry: Pick<TrainEntryView, "status" | "conflictDetail" | "failureReason" | "enqueuedAt"> | undefined;
  /** as OUTRAS entradas do train para o mesmo card. */
  others: readonly Pick<TrainEntryView, "runId" | "status" | "enqueuedAt">[];
  /** undefined = não deu para ler agora; null = o card não existe. */
  card: Card | null | undefined;
  config: BoardConfig | null;
  someoneLive: boolean;
  queued: boolean;
  /** devoluções seguidas já readmitidas para este card. */
  returns: number;
  now: number;
}): HandoffVerdict {
  const { handoff, entry, card } = input;
  const seen = entry ?? handoff.verdict;
  if (!seen) {
    const at = Date.parse(handoff.at);
    if (Number.isFinite(at) && input.now - at >= CONDUCTOR_HANDOFF_MISSING_TTL_MS) {
      return { kind: "drop", why: "a entrada sumiu do train sem veredito visto (prazo vencido) — sem veredito a entregar" };
    }
    return { kind: "keep", why: "a entrada não aparece no train agora (a fila pode não ter carregado)" };
  }
  if (isActiveMergeStatus(seen.status)) return { kind: "keep", why: `o train ainda está com a entrada (${seen.status})` };
  if (seen.status === "failed" && SUPERSEDED.test(seen.failureReason ?? "")) {
    return { kind: "drop", why: `a submissão foi substituída (${(seen.failureReason ?? "").slice(0, 120)}) — quem a substituiu segue` };
  }
  const ownAt = entry?.enqueuedAt ?? handoff.enqueuedAt;
  const newer = typeof ownAt === "number" ? input.others.find((o) => o.enqueuedAt > ownAt) : undefined;
  if (newer) return { kind: "drop", why: `uma submissão mais nova do card (${newer.runId.slice(0, 8)}) está no train — ela tem quem a acompanhe` };
  const busy = input.others.find((o) => isActiveMergeStatus(o.status));
  if (busy) return { kind: "keep", why: `outra integração do card está em curso (${busy.runId.slice(0, 8)}, ${busy.status})` };
  if (card === undefined) return { kind: "keep", why: "o card não foi lido agora" };
  if (card === null) return { kind: "drop", why: "o card não existe mais" };
  if (input.someoneLive) return { kind: "keep", why: "há uma sessão viva no card — ela cuida do veredito" };
  if (input.queued) return { kind: "drop", why: "o card já está na fila do condutor" };
  const over = conductorDoneReason(card, input.config);
  if (over) return { kind: "drop", why: over };
  if (openQuestions(card).length) return { kind: "drop", why: "o card tem pergunta aberta — a resposta é que o retoma" };
  if (seen.status === "done") {
    return { kind: "resume", status: "done", why: "o train integrou a submissão (done) — falta a projeção do condutor (Aprovar entrega)" };
  }
  const detail = (seen.conflictDetail ?? seen.failureReason ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const what = `${seen.status}${detail ? `: ${detail}` : ""}`;
  if (input.returns >= CONDUCTOR_HANDOFF_MAX_RETURNS) {
    return {
      kind: "give-up",
      status: seen.status,
      why: `o train devolveu a submissão de novo (${what}) depois de ${input.returns} retomada(s) seguidas — o serviço parou de reabrir condutores`,
    };
  }
  return { kind: "resume", status: seen.status, why: `o train devolveu a submissão (${what})` };
}

export interface ConductorHandoffDeps {
  store: ConductorHandoffStore;
  /** as entradas do train AGORA, com a fila carregada; lançar ⇒ nenhuma passagem é decidida nesta passada. */
  entries(): Promise<readonly TrainEntryView[]>;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  sessions(): Promise<AgentSession[]>;
  liveTmux(): Promise<ReadonlySet<string> | null>;
  heartbeatAlive(s: AgentSession): boolean;
  /** o card está na fila do condutor agora? */
  queued(board: string, cardId: string): Promise<boolean>;
  /**
   * devolve o card à FRENTE da fila do condutor (`admitConductorCard(..., { resume, requireDriver, handoff })`) — sem
   * re-carimbar o driver: se o operador o limpou entre a leitura e a readmissão, a decisão dele vale. `false` = nada
   * enfileirado (driver limpo, já na fila, condutor vivo); lançar = tente de novo no próximo tick.
   */
  readmit(
    board: string,
    cardId: string,
    handoff: { runId: string; status: MergeQueueEntry["status"]; batchCardIds?: string[]; split?: true },
  ): Promise<boolean>;
  /** o finding do operador quando o serviço para de reabrir (upsert idempotente); lançar = tente de novo. */
  giveUp?(board: string, cardId: string, detail: string): Promise<void>;
  /**
   * Fase 7 — o `done` de um LOTE: grava em cada item o `commitRange` dele, lido dos trailers `Card: <id>` do intervalo
   * integrado (o verificador da Máxima lê a mudança por card). Lançar ⇒ só log (o item fica sem intervalo, e a entrega
   * dele espera o dono — a direção segura).
   */
  stampItemRanges?(handoff: ConductorHandoff, entry: TrainEntryView | undefined): Promise<void>;
  /**
   * Fase 7 — a DIVISÃO do lote: os itens voltam à fila sozinhos (`solo`), sem a marca, com o veredito como motivo; o
   * líder retoma só. Lançar = tente de novo no próximo tick. Ausente ⇒ o lote nunca é dividido (a retomada decide).
   */
  splitBatch?(board: string, leadId: string, itemIds: readonly string[], why: string): Promise<void>;
  now?(): number;
  log?(line: string): void;
}

export interface ConductorHandoffReport {
  resumed: Array<{ board: string; cardId: string; runId: string; why: string }>;
  dropped: Array<{ board: string; cardId: string; runId: string; why: string }>;
  gaveUp: Array<{ board: string; cardId: string; runId: string; why: string }>;
  kept: number;
}

/**
 * ASSENTAR — uma passada sobre as passagens gravadas: cada uma com veredito do train é decidida UMA vez
 * ({@link handoffVerdict}) e sai do arquivo; as que esperam ficam (com o veredito, quando já visto, gravado nelas). Uma
 * readmissão ou um finding que FALHA mantém a passagem (o próximo tick tenta de novo) — perder a passagem é deixar o
 * card esperando para sempre, que é o defeito que isto fecha. Serializada com o registro sob o mesmo lock.
 */
export async function settleConductorHandoffs(deps: ConductorHandoffDeps): Promise<ConductorHandoffReport> {
  const log = deps.log ?? ((line: string) => console.log(`[conductor-handoff] ${line}`));
  return withKeyedLock(HANDOFF_LOCK, async () => {
    const report: ConductorHandoffReport = { resumed: [], dropped: [], gaveUp: [], kept: 0 };
    const state = await deps.store.load();
    if (!state.entries.length) return report;
    let train: readonly TrainEntryView[];
    try {
      train = await deps.entries();
    } catch (err) {
      report.kept = state.entries.length;
      log(`o train não foi lido (${err instanceof Error ? err.message : String(err)}) — nenhuma passagem decidida nesta passada`);
      return report;
    }
    const now = (deps.now ?? Date.now)();
    const sessions = await deps.sessions().catch(() => null);
    const live = await deps.liveTmux().catch(() => null);
    const returns = { ...state.returns };
    const keep: ConductorHandoff[] = [];
    let changed = false;
    for (const h of state.entries) {
      const key = cardKey(h.board, h.cardId);
      const entry = train.find((e) => e.runId === h.runId);
      const others = train.filter((e) => e.board === h.board && e.cardId === h.cardId && e.runId !== h.runId);
      let card: Card | null | undefined;
      try {
        card = await deps.readCard(h.board, h.cardId);
      } catch {
        card = undefined;
      }
      const config = await deps.readBoardConfig(h.board).catch(() => null);
      // Sem o registro de sessões não dá para saber se há alguém no card: conta como «alguém vivo» (espera um tick).
      const someoneLive =
        sessions === null || sessions.some((s) => s.board === h.board && s.cardId === h.cardId && isLiveSession(s, live, deps.heartbeatAlive));
      const queued = await deps.queued(h.board, h.cardId).catch(() => false);
      const verdict = handoffVerdict({ handoff: h, entry, others, card, config, someoneLive, queued, returns: returns[key] ?? 0, now });
      const hold = () => {
        // o veredito já visto fica GRAVADO na passagem: a poda do train (100 terminais) não o perde enquanto ela espera
        if (entry && !isActiveMergeStatus(entry.status) && h.verdict?.status !== entry.status) {
          keep.push({ ...h, verdict: { status: entry.status, conflictDetail: entry.conflictDetail, failureReason: entry.failureReason } });
          changed = true;
        } else keep.push(h);
        report.kept++;
      };
      if (verdict.kind === "keep") {
        hold();
        continue;
      }
      if (verdict.kind === "drop") {
        changed = true;
        delete returns[key]; // a sequência de devoluções acabou (a story acabou, alguém assumiu, a resposta acorda…)
        report.dropped.push({ board: h.board, cardId: h.cardId, runId: h.runId, why: verdict.why });
        log(`${h.board}/${h.cardId}: passagem ${h.runId.slice(0, 8)} encerrada sem condutor novo — ${verdict.why}`);
        continue;
      }
      if (verdict.kind === "give-up") {
        const detail =
          `${verdict.why}. O card segue com routing.driver: conductor e a última submissão está preservada em ` +
          `failed/agent/${h.runId}. Veja o detalhe do train (wait_for_submit({sessionId: "${h.runId}"})), corrija a causa e reabra ` +
          `o condutor à mão (claude_new) — ou devolva o card à cascata (set_card_driver driver:null).`;
        try {
          await deps.giveUp?.(h.board, h.cardId, detail);
        } catch (err) {
          hold();
          log(`${h.board}/${h.cardId}: o finding de desistência falhou (${err instanceof Error ? err.message : String(err)}) — tento no próximo tick`);
          continue;
        }
        changed = true;
        delete returns[key];
        report.gaveUp.push({ board: h.board, cardId: h.cardId, runId: h.runId, why: verdict.why });
        log(`${h.board}/${h.cardId}: ${verdict.why} — finding no card, nenhum condutor novo`);
        continue;
      }
      // Fase 7 — o LOTE. `done`: cada item ganha o seu intervalo (pelos trailers). Devolução: na primeira, a retomada
      // decide (um item culpado sai do lote e ela submete de novo); na segunda do mesmo lote, o serviço DIVIDE — os itens
      // voltam à fila sozinhos e o líder retoma só com os commits dele.
      const items = h.batchCardIds ?? [];
      let split = false;
      if (items.length && verdict.status === "done") {
        await deps.stampItemRanges?.(h, entry).catch((err) =>
          log(`${h.board}/${h.cardId}: os intervalos dos itens do lote não foram gravados (${err instanceof Error ? err.message : String(err)})`),
        );
      } else if (items.length && (returns[key] ?? 0) >= 1 && deps.splitBatch) {
        try {
          await deps.splitBatch(h.board, h.cardId, items, verdict.why);
          split = true;
        } catch (err) {
          hold();
          log(`${h.board}/${h.cardId}: a divisão do lote falhou (${err instanceof Error ? err.message : String(err)}) — tento no próximo tick`);
          continue;
        }
      }
      let queuedNow: boolean;
      try {
        queuedNow = await deps.readmit(h.board, h.cardId, {
          runId: h.runId,
          status: verdict.status,
          ...(split ? { split: true as const } : items.length ? { batchCardIds: items } : {}),
        });
      } catch (err) {
        hold();
        log(`${h.board}/${h.cardId}: a readmissão na fila do condutor falhou (${err instanceof Error ? err.message : String(err)}) — tento no próximo tick`);
        continue;
      }
      changed = true;
      if (!queuedNow) {
        delete returns[key];
        const why = "a readmissão não enfileirou (driver limpo pelo operador, já na fila ou condutor vivo no card)";
        report.dropped.push({ board: h.board, cardId: h.cardId, runId: h.runId, why });
        log(`${h.board}/${h.cardId}: passagem ${h.runId.slice(0, 8)} encerrada — ${why}`);
        continue;
      }
      if (verdict.status === "done") delete returns[key];
      else returns[key] = (returns[key] ?? 0) + 1;
      report.resumed.push({ board: h.board, cardId: h.cardId, runId: h.runId, why: verdict.why });
      log(`${h.board}/${h.cardId}: ${verdict.why} — volta para a FRENTE da fila do condutor (retomada pela nota do card)`);
    }
    if (changed) await deps.store.persist({ entries: keep, returns });
    return report;
  });
}

/**
 * A ORDEM do tick da frota: o assentamento ANTES do pump — o card cuja passagem acabou de ser decidida volta à fila e o
 * pump logo depois já o despacha, na mesma passada. Uma falha do assentamento nunca impede o pump.
 */
export async function settleThenPump<T>(
  settle: () => Promise<unknown>,
  pump: () => Promise<T>,
  onSettleError: (err: unknown) => void = (err) =>
    console.error("[conductor-handoff] assentamento falhou:", err instanceof Error ? err.message : err),
): Promise<T> {
  try {
    await settle();
  } catch (err) {
    onSettleError(err);
  }
  return pump();
}
