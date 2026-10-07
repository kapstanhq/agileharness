// O LOTE DO CONDUTOR ligado à produção (fase 7). Os núcleos são conductor.ts (o despacho e a funcionalidade ocupada),
// conductor-batch-ops.ts (`claim_batch`, `batch_drop`, a divisão) e conductor-handoff.ts (o veredito do train); aqui
// mora só o IO: o contexto de funcionalidades do board, o registro de sessões, os claims, o ledger e o git.
//
// Fiação que mora em fleet-deps.ts (outra trilha): `defaultConductorDeps()` recebe `...conductorBatchDeps()`, a
// passada de assentamento recebe `...batchHandoffDeps()` e o fim do condutor recebe `releaseBatchItems`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boardFeatures } from "@/lib/storymap/board-strategy";
import { featureCtx, featureKeyOf, type FeatureCtx, type FeatureKey } from "@/lib/storymap/feature-key";
import { findRepoRoot } from "@/lib/storymap/paths";
import { readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import type { Card } from "@/lib/storymap/types";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { probeLiveTmuxSessions } from "@/lib/vps/tmux";
import { readWorktreeSessionCost } from "@/lib/vps/session-cost";
import { boardGateNow } from "./board-pace-store";
import { gateAdmitsCard } from "./board-pace";
import { getCardClaims } from "./claims";
import { withConductorDispatchLock, diskConductorQueueStore, isLiveSession, type ConductorDeps, type FeatureHolderCandidate } from "./conductor";
import { itemCommitRanges, sharesFeature, unrevertedDroppedCommits, type BatchCommit } from "./conductor-batch";
import { claimBatch, clearBatchMarks, dropBatchItem, releaseBatchItems, splitBatch, type BatchOpsDeps } from "./conductor-batch-ops";
import { diskConductorHandoffStore, type ConductorHandoff, type ConductorHandoffDeps } from "./conductor-handoff";
import { featureAnchoredOnce } from "./feature-anchor";
import { loadRunnerConfig } from "./config";
import { upsertFinding } from "./findings";
import { getMergeQueue } from "./merge-queue";
import { isSessionAlive } from "./session-liveness";
import { allSessions, sessionCardIds, type AgentSession, type SessionBatch } from "./session-worktree";
import { getTelemetryStore } from "./telemetry";

const execFileP = promisify(execFile);

/** O contexto de funcionalidades de um board AGORA (cards, funcionalidades do PRD, a ponte do lançamento). */
export async function boardFeatureCtx(board: string): Promise<FeatureCtx> {
  const [cards, features, anchoredOnce] = await Promise.all([
    readCards(board).catch(() => [] as Card[]),
    boardFeatures(board).catch(() => []),
    featureAnchoredOnce(board).catch(() => false),
  ]);
  return featureCtx(new Map(cards.map((c) => [c.id, c] as const)), features.map((f) => ({ id: f.id, name: f.name })), anchoredOnce);
}

/** Um leitor de chave com o contexto de cada board lido UMA vez (por passada / por chamada de tool). */
function keyReader(): (board: string, card: Card) => Promise<FeatureKey> {
  const ctxs = new Map<string, Promise<FeatureCtx>>();
  return async (board, card) => {
    let p = ctxs.get(board);
    if (!p) {
      p = boardFeatureCtx(board);
      ctxs.set(board, p);
    }
    return featureKeyOf(card, await p);
  };
}

/** A funcionalidade de um card agora (a mesma régua do Kanban). */
export async function featureKeyNow(board: string, card: Card): Promise<FeatureKey> {
  return keyReader()(board, card);
}

const settingsCapNow = (): number | null => {
  const cap = loadRunnerConfig().autorun.cardBudgetUSD;
  return typeof cap === "number" && cap > 0 ? cap : null;
};

async function ledgerUSD(board: string, cardId: string): Promise<number> {
  const rows = await getTelemetryStore().listByCard(board, cardId).catch(() => []);
  return rows.reduce((acc, r) => acc + (r.costUSD ?? 0), 0);
}

async function liveTmuxNow(): Promise<ReadonlySet<string> | null> {
  const probe = await probeLiveTmuxSessions().catch(() => null);
  return probe?.ok ? new Set(probe.names) : null;
}

/** As entregas de condutor ainda no train (o arquivo das passagens: o que está lá ainda não foi assentado). */
async function pendingHandoffsNow(): Promise<ConductorHandoff[]> {
  return (await diskConductorHandoffStore().load()).entries;
}

/** A fiação do DESPACHO (conductor.ts `ConductorDeps`): a funcionalidade de cada card e as entregas no train. */
export function conductorBatchDeps(): Pick<ConductorDeps, "featureKeyOf" | "pendingHandoffs"> {
  const read = keyReader();
  return {
    featureKeyOf: (board, card) => read(board, card),
    pendingHandoffs: async () => (await pendingHandoffsNow()).map((h) => ({ board: h.board, cardId: h.cardId, runId: h.runId, batchCardIds: h.batchCardIds })),
  };
}

/**
 * Quem pode estar ocupando funcionalidades no board AGORA — as sessões vivas de implementação (condutor despachado ou
 * aberto à mão) e as entregas ainda no train —, com as chaves dos cards de cada um. O núcleo é conductor.ts
 * `findFeatureHolder`.
 */
export async function featureHoldersNow(board: string): Promise<FeatureHolderCandidate[]> {
  const read = keyReader();
  const keysOf = async (ids: readonly string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const id of ids) {
      const card = await readCard(board, id).catch(() => null);
      if (!card) continue;
      const key = await read(board, card).catch(() => null);
      if (key && sharesFeature(key) && !out.includes(key.id)) out.push(key.id);
    }
    return out;
  };
  const now = Date.now();
  const live = await liveTmuxNow();
  const out: FeatureHolderCandidate[] = [];
  for (const s of await allSessions().catch(() => [] as AgentSession[])) {
    if (s.board !== board || !s.cardId || !(s.driver === "conductor" || s.role === "implement")) continue;
    if (!isLiveSession(s, live, (x) => isSessionAlive(x, now))) continue;
    out.push({ board, sessionId: s.sessionId, cardId: s.cardId, via: "session", featureKeys: await keysOf(sessionCardIds(s)) });
  }
  for (const h of await pendingHandoffsNow().catch(() => [] as ConductorHandoff[])) {
    if (h.board !== board) continue;
    out.push({ board, sessionId: h.runId, cardId: h.cardId, via: "handoff", featureKeys: await keysOf([h.cardId, ...(h.batchCardIds ?? [])]) });
  }
  return out;
}

/**
 * A abertura À MÃO de implementação (`claude_new` implement, `claim_card` de uma sessão de implementação) num card cuja
 * funcionalidade outro condutor já ocupa: o motivo da recusa, ou null. O próprio card (a entrega dele ainda no train, o
 * operador reabrindo o condutor dele) não se bloqueia.
 */
export async function featureBusyRefusal(board: string, card: Card, exceptSessionId?: string): Promise<string | null> {
  const key = await featureKeyNow(board, card).catch(() => null);
  if (!key || !sharesFeature(key)) return null;
  const { conductorFeatureBusy, featureBusyReason } = await import("./conductor");
  const holder = await conductorFeatureBusy(board, key.id, exceptSessionId);
  if (!holder || holder.cardId === card.id) return null;
  return `${featureBusyReason(holder, key.title)} — nunca dois condutores na mesma funcionalidade. Espere ele terminar ou trabalhe em outro card.`;
}

/** Grava o lote na linha da sessão (fecha-o, com `closed`; undefined = a sessão volta a ser de um card só). */
async function setSessionBatch(sessionId: string, batch: SessionBatch | undefined): Promise<void> {
  const [{ defaultSessionDeps }, { updateSession }] = await Promise.all([import("./fleet-deps"), import("./session-worktree")]);
  const row = await updateSession(defaultSessionDeps(), sessionId, { batch });
  if (!row) throw new Error(`sessão ${sessionId} não está mais no registro`);
}

/** O plano do lote foi submetido: a sessão fecha o lote (critics.ts `freezeBatchPlan`). */
export async function closeSessionBatchNow(sessionId: string): Promise<void> {
  const s = (await allSessions()).find((x) => x.sessionId === sessionId);
  if (!s?.batch || s.batch.closed) return;
  await setSessionBatch(sessionId, { ...s.batch, closed: true });
}

/** As deps de produção das operações do lote. */
export function batchOpsDeps(): BatchOpsDeps {
  const read = keyReader();
  return {
    sessions: () => allSessions(),
    readCard: (board, cardId) => readCard(board, cardId).catch(() => null),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    featureKeyOf: (board, card) => read(board, card),
    queue: diskConductorQueueStore(),
    withDispatchLock: withConductorDispatchLock,
    claims: getCardClaims(),
    admittedByScope: (board, config, card) => gateAdmitsCard(boardGateNow(board, config ?? {}), card, "conductor").admit,
    settingsCapUSD: settingsCapNow,
    ledgerUSD,
    sessionCostUSD: async (s) => (await readWorktreeSessionCost(s.worktreePath ?? s.cwd ?? null).catch(() => null))?.costUSD ?? 0,
    writeBatchMark: async (board, cardId, mark, finding) => {
      await updateCardOnDisk(board, cardId, (card) => {
        const next: Card = { ...card };
        if (mark) next.batch = mark;
        else delete next.batch;
        if (finding) next.findings = upsertFinding(card.findings ?? [], finding);
        return next;
      });
    },
    setSessionBatch,
  };
}

/** `claim_batch` com as deps de produção. */
export function claimBatchNow(input: { sessionId: string; board: string; cardIds: readonly string[] }) {
  return claimBatch(batchOpsDeps(), input);
}

/** `batch_drop` com as deps de produção. */
export function dropBatchItemNow(input: { sessionId: string; cardId: string; reason: string }) {
  return dropBatchItem(batchOpsDeps(), input);
}

/** O líder saiu: os itens abertos voltam à fila (conductor.ts `ConductorEndDeps.releaseBatchItems`). */
export async function releaseBatchItemsNow(s: AgentSession, why: string): Promise<void> {
  await releaseBatchItems(batchOpsDeps(), s, why);
}

/** A sessão do lote acabou: a marca do lote sai dos cards dela (conductor.ts `ConductorEndDeps.clearBatchMarks`). */
export async function clearBatchMarksNow(s: AgentSession): Promise<void> {
  await clearBatchMarks(batchOpsDeps(), s);
}

// ── o git do lote: os trailers `Card:` ───────────────────────────────────────────────────────────────────────────

const RECORD = "\u001e";
const FIELD = "\u001f";

/** Os commits de `range` (o mais antigo primeiro), com o primeiro pai e a mensagem inteira. */
export async function batchCommits(cwd: string, range: string): Promise<BatchCommit[]> {
  const { stdout } = await execFileP("git", ["-C", cwd, "log", "--reverse", `--format=%H${FIELD}%P${FIELD}%B${RECORD}`, range], { maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split(RECORD)
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.includes(FIELD))
    .map((r) => {
      const [sha, parents, message] = r.split(FIELD);
      return { sha: sha.trim(), parent: parents.trim().split(/\s+/)[0] || undefined, message: message ?? "" };
    });
}

/**
 * A régua do `worktree_submit` de uma sessão de lote: os commits de itens que SAÍRAM do lote e seguem no branch (sem
 * `Card-Revert:`). O motivo da recusa, ou null. Sem lote, sem item tirado ou sem base conhecida, nada a conferir.
 */
export async function droppedItemsSubmitRefusal(s: AgentSession): Promise<string | null> {
  const dropped = (s.batch?.dropped ?? []).map((d) => d.cardId);
  if (!dropped.length || !s.worktreePath || !s.baseCommit) return null;
  const commits = await batchCommits(s.worktreePath, `${s.baseCommit}..HEAD`);
  const bad = unrevertedDroppedCommits(commits, dropped);
  if (!bad.length) return null;
  return (
    `o branch ainda tem código de item que SAIU do lote: ${bad.map((b) => `${b.cardId} (${b.sha.slice(0, 8)})`).join(", ")}. ` +
    `Desfaça cada commit com git revert e o trailer «Card-Revert: <sha>» — ou, se o revert conflitar, refaça o branch ` +
    `cherry-pickando só os commits «Card:» dos itens que ficaram sobre a base — e submeta de novo.`
  );
}

/** A fiação do ASSENTAMENTO (conductor-handoff.ts): o intervalo de cada item no `done` e a divisão do lote. */
export function batchHandoffDeps(): Pick<ConductorHandoffDeps, "stampItemRanges" | "splitBatch"> {
  return {
    stampItemRanges: async (h) => {
      const items = h.batchCardIds ?? [];
      if (!items.length) return;
      const full = getMergeQueue()
        .getSnapshot()
        .entries.find((e) => e.runId === h.runId);
      const head = full?.pinnedSha;
      const base = full?.baseCommit;
      if (!head || !base) throw new Error("a entrada do train não guarda base e sha pinado — sem intervalo a ler");
      const ranges = itemCommitRanges(await batchCommits(findRepoRoot(), `${base}..${head}`), [h.cardId, ...items]);
      for (const [cardId, range] of Object.entries(ranges)) {
        await updateCardOnDisk(h.board, cardId, (card) =>
          card.commitRange?.base === range.base && card.commitRange?.head === range.head ? null : { ...card, commitRange: range },
        );
      }
    },
    splitBatch: async (board, leadId, itemIds, why) => {
      await splitBatch(batchOpsDeps(), { board, leadId, itemIds, why });
    },
  };
}
