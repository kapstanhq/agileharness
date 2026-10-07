// A ÂNCORA — liga os cards às funcionalidades do PRD (fase 7, plano §4). O GATILHO mora aqui (chamado pelo tick da
// frota, instrumentation.ts); a sessão é runner/anchor-spawn.ts (skill `harness-anchor`). Estado por board em
// `storymap/.runner/feature-anchor.json`.
//
// O QUE ELA FAZ, por board com funcionalidades no PRD:
//   1. aplica as respostas do dono às perguntas da âncora (a que nomeia uma funcionalidade vira `card.feature`, escrita
//      pelo serviço com o lock do card; «Deixar em Outros» fica; uma resposta livre volta para a próxima execução ler);
//   2. decide se abre UMA sessão (Sonnet, ≤ {@link ANCHOR_CARDS_PER_RUN} cards no prompt): há card sem funcionalidade
//      válida que ainda não foi tentado E (a última execução foi há {@link ANCHOR_INTERVAL_MS} ou mais, ou as
//      funcionalidades do PRD mudaram, ou a primeira passada ainda não terminou);
//   3. no fim da sessão, os cards do lote que seguem sem funcionalidade entram em `attempted` (não voltam até o PRD mudar
//      ou o dono responder) — exceto os que a sessão disse que ficaram para depois.
// No máximo UMA sessão por board de cada vez (em processo e, depois de um restart, pelo pid gravado). Para no
// interruptor geral do autorun, na cota, no ritmo do board (pausado/devagar) e no «só organização».
//
// A PONTE DO LANÇAMENTO: {@link featureAnchoredOnce} responde `false` até a primeira passada (todos os cards, os
// terminais inclusive — para o «Feito» da página da funcionalidade) terminar; até lá o Kanban agrupa pelo mapa o card
// ainda sem funcionalidade (feature-key.ts).

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { featureCtx, featureKeyOf, type FeatureNameRef } from "@/lib/storymap/feature-key";
import type { BoardConfig, Card } from "@/lib/storymap/types";

/** Uma execução nova só depois disto (fora da primeira passada e de uma mudança no PRD). */
export const ANCHOR_INTERVAL_MS = 6 * 60 * 60_000;
/** Cards por prompt (o custo da primeira passada: Sonnet, em lotes). */
export const ANCHOR_CARDS_PER_RUN = 30;
/** Uma execução que falhou espera isto antes de tentar de novo (a primeira passada não vira laço de falhas). */
export const ANCHOR_FAILURE_BACKOFF_MS = 60 * 60_000;
/** Um `running` gravado mais velho que isto é de uma sessão que já morreu (o relógio dela + folga). */
export const ANCHOR_RUNNING_MAX_AGE_MS = 30 * 60_000;
/** O gatilho olha os boards no máximo a cada isto (o tick da frota roda de minuto em minuto). */
export const ANCHOR_CHECK_EVERY_MS = 5 * 60_000;
/** Quem a âncora diz que é nas perguntas (`askedBy`). */
export const ANCHOR_ASKED_BY = "harness-anchor";
/** A opção de uma pergunta da âncora que deixa o card em «Outros». */
export const ANCHOR_LEAVE_OPTION = "Deixar em Outros";

/** O estado da âncora num board (uma entrada por board em `.runner/feature-anchor.json`). */
export interface FeatureAnchorBoardState {
  /** os cards que a âncora já tentou e não ligou (não voltam até o PRD mudar ou o dono responder). */
  attempted: string[];
  /** o hash das funcionalidades do PRD na última execução — mudou ⇒ `attempted` zera. */
  featuresHash: string;
  /** quando a última execução terminou (ISO). */
  lastRunAt?: string;
  /** a primeira passada (todos os cards) terminou — desliga a ponte do lançamento. */
  anchoredOnce: boolean;
  /** a execução em voo (o pid confere depois de um restart). */
  running?: { since: string; pid?: number };
  /** quando a última execução falhou (ISO) — segura a próxima por {@link ANCHOR_FAILURE_BACKOFF_MS}. */
  lastFailedAt?: string;
  /** as respostas do dono já aplicadas (`<card>:<pergunta>`), para não aplicar duas vezes. */
  appliedAnswers?: string[];
  /** o resumo da última execução (para o operador e o diagnóstico). */
  lastRun?: { at: string; cards: number; anchored: number; costUSD: number; outcome: "ok" | "failed" };
}

export interface FeatureAnchorFile {
  v: 1;
  boards: Record<string, FeatureAnchorBoardState>;
}

const EMPTY_STATE: FeatureAnchorBoardState = { attempted: [], featuresHash: "", anchoredOnce: false };

// ── PURAS ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** O hash das funcionalidades (ids + nomes, em ordem). Renomear, criar ou apagar uma muda o hash. PURA. */
export function featuresHashOf(features: readonly FeatureNameRef[]): string {
  return createHash("sha256")
    .update(features.map((f) => `${f.id}\u0000${f.name}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/** Um card que a âncora pode ligar: uma HISTÓRIA (não nó do mapa, não contêiner de captura) num passo conhecido. */
function anchorable(card: Card, config: Pick<BoardConfig, "statuses">): { terminal: boolean } | null {
  if (card.type !== "story" || card.capture) return null;
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def) return null;
  return { terminal: !!def.terminal };
}

/**
 * Os cards SEM funcionalidade válida — os que o Kanban põe em «Outros» (a mesma régua: `featureKeyOf` com a ponte
 * desligada; o card que herda pelo `serves` já tem dono). Os terminais só entram na primeira passada. PURA.
 */
export function anchorCandidates(cards: readonly Card[], config: Pick<BoardConfig, "statuses">, features: readonly FeatureNameRef[], firstPass: boolean): Card[] {
  if (features.length === 0) return [];
  const ctx = featureCtx(new Map(cards.map((c) => [c.id, c])), features, true);
  return cards.filter((c) => {
    const a = anchorable(c, config);
    if (!a || (a.terminal && !firstPass)) return false;
    return featureKeyOf(c, ctx).source === "outros";
  });
}

export type AnchorDecision =
  | { action: "skip"; why: "no-features" | "running" | "nothing" | "not-due" | "backoff"; state: FeatureAnchorBoardState }
  | { action: "run"; cardIds: string[]; firstPass: boolean; state: FeatureAnchorBoardState };

/**
 * A decisão de UM board, PURA. `state` volta normalizado: o hash novo zera `attempted`; sem nada a tentar na primeira
 * passada, ela termina (`anchoredOnce`). Os cards vão na ordem do board, os não terminais primeiro.
 */
export function decideAnchorRun(input: {
  state: FeatureAnchorBoardState | undefined;
  features: readonly FeatureNameRef[];
  cards: readonly Card[];
  config: Pick<BoardConfig, "statuses">;
  now: number;
  /** há uma sessão da âncora viva neste board. */
  running: boolean;
}): AnchorDecision {
  const prev = input.state ?? EMPTY_STATE;
  if (input.features.length === 0) return { action: "skip", why: "no-features", state: prev };
  const hash = featuresHashOf(input.features);
  const hashChanged = prev.featuresHash !== hash;
  // o PRD mudou: o que a âncora já tentou volta a valer (uma funcionalidade nova pode servir)
  const state: FeatureAnchorBoardState = hashChanged ? { ...prev, featuresHash: hash, attempted: [] } : { ...prev };
  if (input.running) return { action: "skip", why: "running", state };
  const firstPass = !state.anchoredOnce;
  const tried = new Set(state.attempted);
  const fresh = anchorCandidates(input.cards, input.config, input.features, firstPass).filter((c) => !tried.has(c.id));
  if (fresh.length === 0) {
    // a primeira passada acabou: nada mais a ligar (o que sobrou já foi tentado)
    return { action: "skip", why: "nothing", state: firstPass ? { ...state, anchoredOnce: true } : state };
  }
  const failedAt = state.lastFailedAt ? Date.parse(state.lastFailedAt) : NaN;
  if (Number.isFinite(failedAt) && input.now - failedAt < ANCHOR_FAILURE_BACKOFF_MS) return { action: "skip", why: "backoff", state };
  const lastAt = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  const due = firstPass || hashChanged || !Number.isFinite(lastAt) || input.now - lastAt >= ANCHOR_INTERVAL_MS;
  if (!due) return { action: "skip", why: "not-due", state };
  const terminalOf = (c: Card) => !!input.config.statuses.find((s) => s.id === c.status)?.terminal;
  const ordered = [...fresh.filter((c) => !terminalOf(c)), ...fresh.filter(terminalOf)];
  return { action: "run", cardIds: ordered.slice(0, ANCHOR_CARDS_PER_RUN).map((c) => c.id), firstPass, state };
}

/** O que a sessão disse no fim (a linha `ANCORA {...}` do texto final — anchor-spawn.ts `parseAnchorVerdict`). */
export interface AnchorVerdict {
  /** cards que ela deixou em «Outros» de propósito. */
  outros?: string[];
  /** cards que ela não chegou a julgar (o limite da pergunta): voltam na próxima execução. */
  depois?: string[];
}

/**
 * O estado depois de uma execução, PURO. Cada card do lote que segue sem funcionalidade entra em `attempted` — menos os
 * que a sessão disse que ficaram para depois. Uma falha não marca ninguém (o lote volta inteiro depois do recuo).
 */
export function settleAnchorRun(
  state: FeatureAnchorBoardState,
  run: { cardIds: readonly string[]; stillUnanchored: ReadonlySet<string>; now: number; ok: boolean; costUSD: number; verdict?: AnchorVerdict | null },
): FeatureAnchorBoardState {
  const at = new Date(run.now).toISOString();
  const { running: _running, ...rest } = state;
  void _running;
  const anchored = run.cardIds.filter((id) => !run.stillUnanchored.has(id)).length;
  const lastRun = { at, cards: run.cardIds.length, anchored, costUSD: Math.max(0, Number.isFinite(run.costUSD) ? run.costUSD : 0), outcome: run.ok ? ("ok" as const) : ("failed" as const) };
  if (!run.ok) return { ...rest, lastRunAt: at, lastFailedAt: at, lastRun };
  const later = new Set(run.verdict?.depois ?? []);
  const attempted = new Set(state.attempted);
  for (const id of run.cardIds) if (run.stillUnanchored.has(id) && !later.has(id)) attempted.add(id);
  const { lastFailedAt: _f, ...ok } = rest;
  void _f;
  return { ...ok, attempted: [...attempted], lastRunAt: at, lastRun };
}

/** Uma resposta do dono a uma pergunta da âncora, já interpretada. */
export interface AnchorAnswer {
  /** `<card que hospeda a pergunta>:<id da pergunta>`. */
  key: string;
  /** o card de que a pergunta fala. */
  cardId: string;
  /** a funcionalidade escolhida; `null` = «Deixar em Outros»; `undefined` = resposta livre (a próxima execução lê). */
  featureId?: string | null;
}

/** O card de que uma pergunta da âncora fala: o `(card <id>)` no fim do contexto (a skill o escreve assim). */
const CARD_REF_RE = /\(card ([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\)\s*$/;

const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/**
 * As respostas às perguntas da âncora (`askedBy: harness-anchor`) ainda não aplicadas. A opção marcada é casada com a
 * funcionalidade pelo NOME (o rótulo que a skill escreve) ou pelo id. PURA.
 */
export function anchorAnswers(cards: readonly Card[], features: readonly FeatureNameRef[], applied: ReadonlySet<string>): AnchorAnswer[] {
  const byName = new Map<string, string>();
  for (const f of features) {
    byName.set(norm(f.name), f.id);
    byName.set(norm(f.id), f.id);
  }
  const out: AnchorAnswer[] = [];
  for (const host of cards) {
    for (const q of host.questions ?? []) {
      if (q.askedBy !== ANCHOR_ASKED_BY || q.status !== "answered") continue;
      const key = `${host.id}:${q.id}`;
      if (applied.has(key)) continue;
      const cardId = CARD_REF_RE.exec(q.context ?? "")?.[1] ?? CARD_REF_RE.exec(q.text)?.[1] ?? host.id;
      const picked = (q.selectedOptionIds ?? []).map((id) => q.options?.find((o) => o.id === id)?.label ?? id);
      const labels = [...picked, ...(q.answer ? [q.answer] : [])].map(norm);
      const featureId = labels.map((l) => byName.get(l)).find((id): id is string => !!id);
      if (featureId) out.push({ key, cardId, featureId });
      else if (labels.includes(norm(ANCHOR_LEAVE_OPTION))) out.push({ key, cardId, featureId: null });
      else out.push({ key, cardId });
    }
  }
  return out;
}

/** O estado depois de aplicar as respostas, PURO: ligado ou resposta livre ⇒ sai de `attempted`; «Outros» ⇒ fica. */
export function applyAnswersToState(state: FeatureAnchorBoardState, answers: readonly AnchorAnswer[]): FeatureAnchorBoardState {
  if (answers.length === 0) return state;
  const attempted = new Set(state.attempted);
  for (const a of answers) {
    if (a.featureId === null) attempted.add(a.cardId);
    else attempted.delete(a.cardId);
  }
  const applied = [...(state.appliedAnswers ?? []), ...answers.map((a) => a.key)].slice(-500);
  return { ...state, attempted: [...attempted], appliedAnswers: applied };
}

// ── o estado durável ────────────────────────────────────────────────────────────────────────────────────────────

/** Onde mora o estado. */
export async function featureAnchorFile(): Promise<string> {
  const { runnerStateDir } = await import("@/lib/storymap/paths");
  return path.join(runnerStateDir(), "feature-anchor.json");
}

/** Lê o estado (ilegível ou ausente ⇒ vazio). Nunca lança. */
export async function readFeatureAnchorState(): Promise<FeatureAnchorFile> {
  try {
    const raw = JSON.parse(await fsp.readFile(await featureAnchorFile(), "utf8")) as Partial<FeatureAnchorFile>;
    const boards = raw && typeof raw.boards === "object" && raw.boards ? raw.boards : {};
    return { v: 1, boards: boards as Record<string, FeatureAnchorBoardState> };
  } catch {
    return { v: 1, boards: {} };
  }
}

async function writeFeatureAnchorState(file: FeatureAnchorFile): Promise<void> {
  const { atomicWriteFile } = await import("@/lib/storymap/atomic-write");
  await atomicWriteFile(await featureAnchorFile(), JSON.stringify(file, null, 2) + "\n");
}

let stateChain: Promise<unknown> = Promise.resolve();

/** Muda o estado de UM board sob a cadeia do módulo (o tick e o fim de uma sessão não se atropelam). */
async function mutateBoardState(store: FeatureAnchorStore, board: string, fn: (s: FeatureAnchorBoardState | undefined) => FeatureAnchorBoardState): Promise<FeatureAnchorBoardState> {
  const next = stateChain.then(async () => {
    const file = await store.load();
    const updated = fn(file.boards[board]);
    await store.save({ v: 1, boards: { ...file.boards, [board]: updated } });
    return updated;
  });
  stateChain = next.catch(() => undefined);
  return next;
}

/** A primeira passada da âncora já terminou neste board? (o `FeatureCtx.anchoredOnce` do Kanban e do despacho). */
export async function featureAnchoredOnce(board: string): Promise<boolean> {
  const file = await readFeatureAnchorState();
  return file.boards[board]?.anchoredOnce === true;
}

// ── o gatilho ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface FeatureAnchorStore {
  load(): Promise<FeatureAnchorFile>;
  save(file: FeatureAnchorFile): Promise<void>;
}

/** O que o gatilho entrega à sessão (anchor-spawn.ts monta o prompt). */
export interface AnchorRunInput {
  board: string;
  features: Array<{ id: string; name: string; markdown: string }>;
  cards: Card[];
  /** os títulos do que já está em «Outros» (para a proposta de funcionalidade nova). */
  outros: Array<{ id: string; title: string }>;
  /** há uma proposta de mudança do PRD esperando o dono: não propor outra. */
  draftPending: boolean;
  firstPass: boolean;
  /** o CORPO inteiro da seção «Funcionalidades» do PRD (markdown) — a base de uma `propose_change`, que troca a seção toda. */
  sectionMarkdown?: string;
}

/** O que a sessão devolve ao morrer (null = não nasceu). */
export interface AnchorRunOutcome {
  ok: boolean;
  costUSD: number;
  pid?: number;
  verdict?: AnchorVerdict | null;
}

export interface FeatureAnchorDeps {
  now(): number;
  /** o interruptor geral do autorun (`autorun.enabled`). */
  masterEnabled(): boolean;
  /** a cota segura o trabalho automático agora? */
  capacityHeld(): boolean;
  /** os boards em que a âncora pode agir agora (ritmo do board e «só organização» já filtrados). */
  boards(): Promise<string[]>;
  /** o board: config, cards, funcionalidades do PRD e se há proposta de PRD pendente. null = ilegível. */
  boardData(board: string): Promise<{ config: BoardConfig; cards: Card[]; features: Array<{ id: string; name: string; markdown: string }>; draftPending: boolean; sectionMarkdown?: string } | null>;
  /** grava `card.feature` como o SERVIÇO (o lock do card). true = gravou, ou o card já a tinha. */
  applyFeature(board: string, cardId: string, featureId: string): Promise<boolean>;
  /** lança a sessão; resolve quando ela morre. `onStart` recebe o pid. */
  spawn(input: AnchorRunInput, onStart: (pid: number | undefined) => void): Promise<AnchorRunOutcome | null>;
  /** o processo ainda vive? (o `running` gravado antes de um restart). */
  pidAlive(pid: number): boolean;
  store: FeatureAnchorStore;
  log?(line: string): void;
}

export interface AnchorBoardReport {
  board: string;
  action: "skipped" | "spawned" | "answers-applied";
  why?: string;
  cardIds?: string[];
  /** a sessão em voo (o teste a espera; a produção não). */
  done?: Promise<void>;
}

/** Os boards com sessão viva neste processo (no máximo uma por board). */
const LIVE = new Set<string>();

/** Um `running` gravado ainda vale? (pid vivo e dentro do relógio). PURA sobre os fatos. */
export function runningStillLive(running: FeatureAnchorBoardState["running"], now: number, pidAlive: (pid: number) => boolean): boolean {
  if (!running) return false;
  const since = Date.parse(running.since);
  if (!Number.isFinite(since) || now - since > ANCHOR_RUNNING_MAX_AGE_MS) return false;
  return running.pid ? pidAlive(running.pid) : true;
}

/** UMA passada do gatilho em todos os boards. Nunca lança. */
export async function runFeatureAnchorTick(deps: FeatureAnchorDeps): Promise<AnchorBoardReport[]> {
  const out: AnchorBoardReport[] = [];
  const log = deps.log ?? ((l: string) => console.log(`[anchor] ${l}`));
  try {
    if (!deps.masterEnabled()) return out;
    for (const board of await deps.boards()) {
      try {
        out.push(...(await anchorBoard(board, deps, log)));
      } catch (err) {
        log(`${board}: falhou — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    log(`passada falhou — ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

async function anchorBoard(board: string, deps: FeatureAnchorDeps, log: (l: string) => void): Promise<AnchorBoardReport[]> {
  const out: AnchorBoardReport[] = [];
  const data = await deps.boardData(board);
  if (!data || data.features.length === 0) return [{ board, action: "skipped", why: "no-features" }];
  const now = deps.now();
  const file = await deps.store.load();
  const prev = file.boards[board];

  // 1) as respostas do dono: a que nomeia uma funcionalidade é aplicada pelo SERVIÇO, com o lock do card
  const answers = anchorAnswers(data.cards, data.features, new Set(prev?.appliedAnswers ?? []));
  if (answers.length) {
    const done: AnchorAnswer[] = [];
    for (const a of answers) {
      if (a.featureId) {
        const ok = await deps.applyFeature(board, a.cardId, a.featureId).catch(() => false);
        if (!ok) continue;
        const card = data.cards.find((c) => c.id === a.cardId);
        if (card) card.feature = a.featureId;
      }
      done.push(a);
    }
    if (done.length) {
      await mutateBoardState(deps.store, board, (s) => applyAnswersToState(s ?? { ...EMPTY_STATE }, done));
      out.push({ board, action: "answers-applied", cardIds: done.map((a) => a.cardId) });
      log(`${board}: ${done.length} resposta(s) do dono aplicada(s)`);
    }
  }

  // 2) a decisão
  const current = (await deps.store.load()).boards[board];
  const running = LIVE.has(board) || runningStillLive(current?.running, now, deps.pidAlive);
  const decision = decideAnchorRun({ state: current, features: data.features, cards: data.cards, config: data.config, now, running });
  const changed = JSON.stringify(decision.state) !== JSON.stringify(current ?? null);
  if (decision.action === "skip") {
    if (changed && decision.why !== "running") {
      const keepRunning = current?.running;
      await mutateBoardState(deps.store, board, () => {
        const { running: _r, ...rest } = decision.state;
        void _r;
        // um `running` que não vale mais sai; o que vale fica
        return keepRunning && runningStillLive(keepRunning, now, deps.pidAlive) ? { ...rest, running: keepRunning } : rest;
      });
    }
    out.push({ board, action: "skipped", why: decision.why });
    return out;
  }
  if (deps.capacityHeld()) {
    out.push({ board, action: "skipped", why: "capacity" });
    return out;
  }

  // 3) a sessão — o registro ANTES de nascer (um restart no meio não abre outra no mesmo board)
  LIVE.add(board);
  const startedAt = new Date(now).toISOString();
  await mutateBoardState(deps.store, board, () => ({ ...decision.state, running: { since: startedAt } }));
  const ids = new Set(decision.cardIds);
  const ctx = featureCtx(new Map(data.cards.map((c) => [c.id, c])), data.features, true);
  const input: AnchorRunInput = {
    board,
    features: data.features,
    cards: data.cards.filter((c) => ids.has(c.id)),
    outros: data.cards
      .filter((c) => !ids.has(c.id) && c.type === "story" && !c.capture && featureKeyOf(c, ctx).source === "outros")
      .slice(0, 60)
      .map((c) => ({ id: c.id, title: c.title })),
    draftPending: data.draftPending,
    firstPass: decision.firstPass,
    ...(data.sectionMarkdown ? { sectionMarkdown: data.sectionMarkdown } : {}),
  };
  log(`${board}: sessão da âncora com ${decision.cardIds.length} card(s)${decision.firstPass ? " (primeira passada)" : ""}`);
  const done = (async () => {
    let result: AnchorRunOutcome | null = null;
    try {
      result = await deps.spawn(input, (pid) => {
        if (pid) void mutateBoardState(deps.store, board, (s) => ({ ...(s ?? decision.state), running: { since: startedAt, pid } })).catch(() => {});
      });
    } catch {
      result = null;
    }
    try {
      // o desfecho pelo MUNDO: quem segue sem funcionalidade, relido do disco
      const after = await deps.boardData(board).catch(() => null);
      const still = new Set(after ? anchorCandidates(after.cards, after.config, after.features, true).map((c) => c.id) : decision.cardIds);
      await mutateBoardState(deps.store, board, (s) =>
        settleAnchorRun(s ?? decision.state, {
          cardIds: decision.cardIds,
          stillUnanchored: still,
          now: deps.now(),
          ok: !!result?.ok,
          costUSD: result?.costUSD ?? 0,
          verdict: result?.verdict ?? null,
        }),
      );
      log(`${board}: a âncora terminou (${result?.ok ? "ok" : "falhou"}); ${decision.cardIds.filter((id) => !still.has(id)).length} de ${decision.cardIds.length} ligado(s)`);
    } finally {
      LIVE.delete(board);
    }
  })().catch(() => {
    LIVE.delete(board);
  });
  out.push({ board, action: "spawned", cardIds: decision.cardIds, done });
  return out;
}

// ── produção ────────────────────────────────────────────────────────────────────────────────────────────────────

let lastCheckAt = 0;

/** O arquivo de estado de produção. */
export function diskFeatureAnchorStore(): FeatureAnchorStore {
  return { load: readFeatureAnchorState, save: writeFeatureAnchorState };
}

/** As deps de produção, montadas sob demanda (os imports pesados só carregam quando a âncora roda). */
export async function productionFeatureAnchorDeps(): Promise<FeatureAnchorDeps> {
  const [repo, docIo, prdFeatures, schemaCodec, mdCodec, sidecars, governance, prdSchema, cfgMod, cap, pace, organize, write] = await Promise.all([
    import("@/lib/storymap/repo"),
    import("@/lib/storymap/doc/schema-doc-io"),
    import("@/lib/storymap/doc/prd-features"),
    import("@/lib/storymap/doc/schema-codec"),
    import("@/lib/storymap/doc/md-codec"),
    import("@/lib/storymap/sidecars"),
    import("@/lib/storymap/doc/doc-governance"),
    import("@/lib/storymap/doc/schemas/prd"),
    import("./config"),
    import("./capacity-service"),
    import("./board-pace-store"),
    import("@/lib/storymap/organize-only"),
    import("@/lib/storymap/write"),
  ]);
  return {
    now: () => Date.now(),
    masterEnabled: () => cfgMod.loadRunnerConfig().autorun.enabled === true,
    capacityHeld: () => !cap.getCapacityGovernor().admission("automation").admit,
    boards: async () => (await repo.listBoards()).map((b) => b.id).filter((id) => !id.startsWith("_") && pace.paceAllowsBackground(id) && !organize.organizeOnlyNow(id)),
    boardData: async (board) => {
      const config = await repo.readBoardConfig(board).catch(() => null);
      if (!config) return null;
      const [cards, loaded, drafts] = await Promise.all([
        repo.readCards(board),
        docIo.loadDoc(board, prdSchema.PRD_DOC_TYPE, config).catch(() => undefined),
        sidecars.listGovernanceDrafts(board).catch(() => []),
      ]);
      // as funcionalidades pela MESMA régua do Kanban (board-strategy.ts `boardFeatures`), e a seção inteira para a proposta
      const features = prdFeatures.prdFeatureEntries(loaded?.doc);
      const blocks = loaded?.doc ? (schemaCodec.sectionContent(loaded.doc, "funcionalidades")?.blocks ?? []) : [];
      const sectionMarkdown = blocks.length ? mdCodec.serializeDocMd({ docType: prdSchema.PRD_DOC_TYPE, title: "", blocks }, { includeTitle: false }).trim() : "";
      return { config, cards, features, draftPending: governance.pendingDraftsForDoc(drafts, prdSchema.PRD_DOC_TYPE).length > 0, ...(sectionMarkdown ? { sectionMarkdown } : {}) };
    },
    applyFeature: async (board, cardId, featureId) => {
      // o card JÁ ter a funcionalidade escolhida também é «aplicada» — sem isso a resposta voltava a cada passada
      let already = false;
      const written = await write.updateCardOnDisk(board, cardId, (card) => {
        if (card.feature !== featureId) return { ...card, feature: featureId };
        already = true;
        return null;
      });
      return written !== null || already;
    },
    spawn: async (input, onStart) => {
      const { spawnAnchorRun } = await import("./anchor-spawn");
      const [bin] = await Promise.all([import("./claude-bin")]);
      const cfg = cfgMod.loadRunnerConfig();
      return spawnAnchorRun(input, {
        claudeBin: bin.resolvedClaudeBin({ name: cfg.autorun.claudeBin }),
        port: Number(process.env.AGILEHARNESS_PORT || process.env.PORT) || undefined,
        onStart,
      });
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    store: diskFeatureAnchorStore(),
  };
}

/**
 * O gancho do tick da frota (instrumentation.ts): no máximo a cada {@link ANCHOR_CHECK_EVERY_MS}, uma passada. Não
 * espera as sessões (elas rodam soltas); revoga as credenciais de âncora órfãs. Nunca lança.
 */
export async function maybeRunFeatureAnchor(now: number = Date.now()): Promise<AnchorBoardReport[]> {
  if (now - lastCheckAt < ANCHOR_CHECK_EVERY_MS) return [];
  lastCheckAt = now;
  try {
    const { reapOrphanAnchorHandles } = await import("./anchor-spawn");
    await reapOrphanAnchorHandles(now).catch(() => undefined);
    return await runFeatureAnchorTick(await productionFeatureAnchorDeps());
  } catch (err) {
    console.error("[anchor] tick falhou:", err instanceof Error ? err.message : err);
    return [];
  }
}
