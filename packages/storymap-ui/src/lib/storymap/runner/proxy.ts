// The ULTRA-mode decision PROXY — the dispatcher. DI core (no IO of its own; production deps in proxy-deps.ts).
//
// When a story in effective `ultra` mode (autonomy.ts) has an OPEN question of a proxiable category (interview,
// ui-choice) the owner does not have to answer it: this module hands it to a PROXY — a separate headless run with
// a clean context (proxy-spawn.ts) — whose validated answers land through the board's single writer stamped
// `answeredBy: "proxy"`, with its premissas and confidence, and a deterministic sample goes on the owner's audit
// list. Two doors lead here, and both are idempotent:
//   • `proxyCard` — fired right after a question is asked (askQuestionsAction), so an ultra conductor pauses for
//     seconds, not for a human;
//   • `sweepProxy` — the fleet tick (instrumentation.ts → reconcileFleetNow), which also catches questions a
//     skill wrote straight into a card file and anything a restart interrupted.
//
// What makes it safe to run unattended:
//   • MONEY NEVER ENTERS. Selection is `proxiableQuestions` — the asker's category first, the money floor second;
//     a card whose only open questions are the owner's is simply not a candidate, so it WAITS and every other card
//     proceeds (no queue here can be blocked by it — there is no queue, only a scan).
//   • BOUNDED. At most {@link PROXY_MAX_ATTEMPTS} spawns per question, ever (a durable ledger counts them BEFORE the
//     spawn, so a crash mid-run still counts); one proxy per card at a time; at most `maxConcurrent` in the box;
//     each spawn budget-capped (`--max-budget-usd`, surface `proxy`).
//   • THE SAME SWITCHES AS AUTORUN. The live master switch and the board's `autorunDisabled` pause it (nothing is
//     dropped — the next sweep resumes), and the box's admission (RAM/load) defers it like a heavy run.
//   • THE WRITER RE-JUDGES. The answers are applied over a FRESH read, only to questions still open and still
//     proxiable — an owner who answered first, or who flipped the story to `human`, always wins.

import { proxiableQuestions, type ProxyAnswerInput } from "@/lib/storymap/autonomy";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";
import type { ProxyRequest, ProxyResult } from "./proxy-spawn";

/** Spawns per question, ever — a proxy that failed twice on the same question leaves it to the owner. */
export const PROXY_MAX_ATTEMPTS = 2;
/** Proxies alive at once in the box (the dispatcher's own cap, below the fleet's). */
export const PROXY_MAX_CONCURRENT_DEFAULT = 1;
/** Ledger rows kept (oldest dropped) — it is a loop-guard, not an archive. */
const LEDGER_MAX_ROWS = 500;

/** One question's history with the proxy. `answered`/`declined` are final; `failed` retries up to the cap. */
export interface ProxyLedgerEntry {
  key: string;
  attempts: number;
  lastAt: string;
  outcome: "running" | "answered" | "declined" | "failed" | "not-applied";
  detail?: string;
}

export interface ProxyLedgerStore {
  load(): Promise<ProxyLedgerEntry[]>;
  persist(entries: ProxyLedgerEntry[]): Promise<void>;
}

/** In-memory ledger (tests). */
export function memoryProxyLedger(seed: ProxyLedgerEntry[] = []): ProxyLedgerStore & { entries: ProxyLedgerEntry[] } {
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

export interface ProxyDispatchDeps {
  ledger: ProxyLedgerStore;
  listBoards(): Promise<string[]>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  readCards(board: string): Promise<Card[]>;
  /** the live autorun master switch. */
  masterEnabled(): boolean;
  /** the box's admission (RAM/load) — `null` when it admits, else why not. */
  admission(): string | null;
  /** the proxy's whole world: PRD, personas, style guide, the owner's past answers, the variants. */
  buildRequest(board: string, card: Card, config: BoardConfig, questions: CardQuestion[]): Promise<ProxyRequest>;
  spawn(req: ProxyRequest): Promise<ProxyResult>;
  /** apply through the single writer (re-judged on the fresh card) — the ids that LANDED. */
  apply(board: string, cardId: string, answers: ProxyAnswerInput[], runId: string): Promise<string[]>;
  /** hand questions BACK to the owner, written on the question (`proxy.declined`) — declined, or failed past the cap. */
  decline(board: string, cardId: string, items: Array<{ questionId: string; reason: string }>, runId: string): Promise<void>;
  /** book the spend in the card's ledger (best-effort). */
  bookCost?(board: string, cardId: string, result: ProxyResult, startedAt: number, model: string): Promise<void>;
  /** tell a live conductor its questions were answered (best-effort). */
  resumeConductor?(board: string, cardId: string, questionIds: string[]): Promise<void>;
  /** the process-wide set of cards with a proxy in flight (default: a global). */
  inFlight?: Set<string>;
  maxConcurrent?: number;
  now?(): number;
  log?(line: string): void;
}

const IN_FLIGHT_KEY = Symbol.for("agileharness.proxy.inflight");
function globalInFlight(): Set<string> {
  const store = globalThis as unknown as { [IN_FLIGHT_KEY]?: Set<string> };
  return (store[IN_FLIGHT_KEY] ??= new Set());
}

const keyOf = (board: string, cardId: string, qid: string) => `${board}/${cardId}/${qid}`;

/** What one card's pass did — for the log and the tests. */
export type ProxyCardOutcome =
  | { action: "skipped"; reason: string }
  | { action: "waiting"; reason: string }
  | { action: "spawned"; runId: string; applied: string[]; declined: string[]; failed: string[]; error?: string };

/**
 * The questions of `card` the proxy should take NOW: proxiable (autonomy.ts), and not settled or exhausted in the
 * ledger. PURE — the selection rule, testable alone.
 */
export function proxyWork(card: Card, config: BoardConfig, board: string, ledger: readonly ProxyLedgerEntry[]): CardQuestion[] {
  const byKey = new Map(ledger.map((e) => [e.key, e]));
  return proxiableQuestions(card, config).filter((q) => {
    const e = byKey.get(keyOf(board, card.id, q.id));
    if (!e) return true;
    if (e.outcome === "answered" || e.outcome === "declined") return false;
    return e.attempts < PROXY_MAX_ATTEMPTS;
  });
}

const upsert = (entries: ProxyLedgerEntry[], row: ProxyLedgerEntry): ProxyLedgerEntry[] => {
  const rest = entries.filter((e) => e.key !== row.key);
  return [...rest, row].slice(-LEDGER_MAX_ROWS);
};

/**
 * ONE card: select its proxiable questions, and — when the switches, the box and the caps allow — spawn ONE proxy
 * for all of them, then apply what it answered. Never throws.
 */
export async function proxyCard(deps: ProxyDispatchDeps, board: string, cardId: string): Promise<ProxyCardOutcome> {
  const log = deps.log ?? ((l: string) => console.log(`[proxy] ${l}`));
  const inFlight = deps.inFlight ?? globalInFlight();
  const cardKey = `${board}/${cardId}`;
  try {
    const config = await deps.readBoardConfig(board);
    if (!config) return { action: "skipped", reason: "board ilegível" };
    const card = (await deps.readCards(board)).find((c) => c.id === cardId);
    if (!card) return { action: "skipped", reason: "card não existe" };
    const ledger = await deps.ledger.load();
    const questions = proxyWork(card, config, board, ledger);
    if (!questions.length) return { action: "skipped", reason: "nenhuma pergunta proxiável pendente" };
    if (!deps.masterEnabled() || config.autorunDisabled) {
      return { action: "waiting", reason: "autorun desligado (master switch ou board desarmado) — o proxy espera" };
    }
    if (inFlight.has(cardKey)) return { action: "waiting", reason: "já há um proxy neste card" };
    if (inFlight.size >= (deps.maxConcurrent ?? PROXY_MAX_CONCURRENT_DEFAULT)) {
      return { action: "waiting", reason: "teto de proxies simultâneos — o próximo tick tenta" };
    }
    const refused = deps.admission();
    if (refused) return { action: "waiting", reason: `máquina saturada: ${refused}` };

    inFlight.add(cardKey);
    try {
      // Count the attempt BEFORE the spawn: a crash or restart mid-run still spends it, so a question that kills
      // the proxy cannot loop forever.
      const at = new Date((deps.now ?? Date.now)()).toISOString();
      let rows = ledger;
      for (const q of questions) {
        const prior = rows.find((e) => e.key === keyOf(board, cardId, q.id));
        rows = upsert(rows, { key: keyOf(board, cardId, q.id), attempts: (prior?.attempts ?? 0) + 1, lastAt: at, outcome: "running" });
      }
      await deps.ledger.persist(rows);

      const req = await deps.buildRequest(board, card, config, questions);
      const startedAt = (deps.now ?? Date.now)();
      const result = await deps.spawn(req);
      await deps.bookCost?.(board, cardId, result, startedAt, req.model).catch(() => {});

      const declined: string[] = [];
      const reasons: Array<{ questionId: string; reason: string }> = [];
      const answers: ProxyAnswerInput[] = [];
      for (const a of result.answers ?? []) {
        if ("decline" in a) {
          declined.push(a.questionId);
          reasons.push({ questionId: a.questionId, reason: `o proxy recusou: ${a.decline}` });
        } else answers.push(a);
      }
      const applied = answers.length ? await deps.apply(board, cardId, answers, result.runId).catch(() => [] as string[]) : [];
      const failed = questions.map((q) => q.id).filter((id) => !applied.includes(id) && !declined.includes(id) && !answers.some((a) => a.questionId === id));
      // A question the proxy failed on for the LAST allowed time goes back to the owner too — written on the card,
      // so the Inbox stops showing it as "the proxy is on it" (the ledger alone is invisible to every reader).
      for (const id of failed) {
        const attempts = rows.find((e) => e.key === keyOf(board, cardId, id))?.attempts ?? 1;
        if (attempts >= PROXY_MAX_ATTEMPTS) {
          reasons.push({ questionId: id, reason: `o proxy falhou ${attempts}x${result.error ? ` (${result.error.slice(0, 160)})` : ""} — a pergunta é sua` });
        }
      }
      if (reasons.length) await deps.decline(board, cardId, reasons, result.runId).catch(() => {});

      rows = await deps.ledger.load();
      const done = new Date((deps.now ?? Date.now)()).toISOString();
      for (const q of questions) {
        const prior = rows.find((e) => e.key === keyOf(board, cardId, q.id));
        const outcome: ProxyLedgerEntry["outcome"] = applied.includes(q.id)
          ? "answered"
          : declined.includes(q.id)
            ? "declined"
            : answers.some((a) => a.questionId === q.id)
              ? "not-applied"
              : "failed";
        rows = upsert(rows, {
          key: keyOf(board, cardId, q.id),
          attempts: prior?.attempts ?? 1,
          lastAt: done,
          // `not-applied` is final too: the writer refused on the fresh card (the owner answered first, or it stopped
          // being proxiable) — re-spawning would ask the same question of a card that already moved on.
          outcome: outcome === "not-applied" ? "answered" : outcome,
          ...(outcome === "failed" && result.error ? { detail: result.error.slice(0, 300) } : {}),
          ...(outcome === "not-applied" ? { detail: "o escritor recusou no card fresco" } : {}),
        });
      }
      await deps.ledger.persist(rows);

      if (applied.length) {
        log(`${board}/${cardId}: proxy respondeu ${applied.join(", ")}${declined.length ? ` · recusou ${declined.join(", ")} (ficam com o dono)` : ""}`);
        await deps.resumeConductor?.(board, cardId, applied).catch(() => {});
      } else if (result.error) {
        log(`${board}/${cardId}: proxy sem resposta — ${result.error}`);
      }
      return { action: "spawned", runId: result.runId, applied, declined, failed, ...(result.error ? { error: result.error } : {}) };
    } finally {
      inFlight.delete(cardKey);
    }
  } catch (err) {
    return { action: "skipped", reason: `falha: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** What one sweep did. */
export interface ProxySweepReport {
  spawned: Array<{ board: string; cardId: string; applied: string[] }>;
  waiting: Array<{ board: string; cardId: string; reason: string }>;
}

/**
 * The fleet-tick sweep: every board, every card with proxiable work, in order — each card judged alone, so a card
 * waiting on its owner (money, an uncategorized question) never holds up the next. Never throws.
 */
export async function sweepProxy(deps: ProxyDispatchDeps): Promise<ProxySweepReport> {
  const report: ProxySweepReport = { spawned: [], waiting: [] };
  const boards = await deps.listBoards().catch(() => [] as string[]);
  for (const board of boards) {
    const config = await deps.readBoardConfig(board).catch(() => null);
    if (!config) continue;
    const cards = await deps.readCards(board).catch(() => [] as Card[]);
    const ledger = await deps.ledger.load().catch(() => [] as ProxyLedgerEntry[]);
    for (const card of cards) {
      if (!proxyWork(card, config, board, ledger).length) continue;
      const out = await proxyCard(deps, board, card.id);
      if (out.action === "spawned") report.spawned.push({ board, cardId: card.id, applied: out.applied });
      else if (out.action === "waiting") report.waiting.push({ board, cardId: card.id, reason: out.reason });
    }
  }
  return report;
}
