// Runner registry — the single source of truth for "what is the autorun pipeline
// doing right now". The trigger-runner channel writes to it (start/finish); the
// SSE route reads a snapshot + subscribes to push live updates to the browser.
//
// Process-global singleton (survives Next dev HMR) so the channel and the route —
// loaded as separate modules — share ONE instance, exactly like sse-broadcaster.

import type {
  LogFrame,
  LogLevel,
  MergeQueueSnapshot,
  RunnerFailure,
  RunnerRun,
  RunnerSnapshot,
  RunUsage,
} from "./types";
import type { TriggerId } from "@/lib/storymap/types";

// How long a failure stays visible on the card after the process died. Long enough
// to notice a stuck/broken run, short enough that it self-clears (no manual reset).
const FAILURE_TTL_MS = 15 * 60_000;

// Console (Fase B) retention: per-card ring buffer + LRU across distinct cards.
const LOG_CAP_PER_CARD = 500;
const LOG_CARDS_CAP = 16;

type Listener = (snapshot: RunnerSnapshot) => void;
type LogListener = (frame: LogFrame) => void;
type MergeQueueListener = (snapshot: MergeQueueSnapshot) => void;

class RunnerRegistry {
  private runs = new Map<string, RunnerRun>();
  private failures = new Map<string, RunnerFailure>();
  // Card → most-recent run's session id. KEPT after the run finishes (unlike `runs`)
  // so `claude --resume <id>` stays resolvable from the console even when idle. Tiny
  // (one short string per card ever run); lives only for the dev server's lifetime.
  private lastSession = new Map<string, string>();
  // Card → most-recent run's cost/token usage. KEPT after the run ends (like lastSession)
  // so the Processos page can show a finished run's cost for this dev-server lifetime.
  private lastUsage = new Map<string, RunUsage>();
  private listeners = new Set<Listener>();
  private logs = new Map<string, LogFrame[]>(); // insertion-ordered → LRU evict
  private logListeners = new Set<LogListener>();
  private logSeq = 0;
  // SM-2 merge train: the latest merge-queue picture + its own subscriber set. The merge queue
  // (merge-queue.ts) bridges every change here via updateMergeQueue; the SSE route fans it out as
  // the dedicated `merge-queue` event, and it also rides the RunnerSnapshot for a fresh connection.
  private mergeQueue: MergeQueueSnapshot | undefined;
  private mqListeners = new Set<MergeQueueListener>();

  private key(board: string, cardId: string): string {
    return `${board}/${cardId}`;
  }

  /** A skill process just spawned for this card. Clears any prior failure on it. */
  start(board: string, cardId: string, trigger: TriggerId, startedAt: number, sessionId: string): void {
    const k = this.key(board, cardId);
    this.runs.set(k, { board, cardId, trigger, startedAt, sessionId });
    this.lastSession.set(k, sessionId);
    this.lastUsage.delete(k); // a fresh run hasn't reported cost yet — drop the prior run's
    this.failures.delete(k);
    // Fresh run → clear the prior console and mark this card most-recent (LRU).
    this.logs.delete(k);
    this.logs.set(k, []);
    this.evictLogs();
    this.emit();
  }

  /** The skill process ended. Pass a failure to flag the card; omit on success. */
  finish(board: string, cardId: string, failure?: Omit<RunnerFailure, "board" | "cardId">): void {
    const k = this.key(board, cardId);
    this.runs.delete(k);
    if (failure) this.failures.set(k, { board, cardId, ...failure });
    this.emit();
  }

  /** Current picture, with expired failures pruned lazily (no background timer). */
  snapshot(): RunnerSnapshot {
    const now = Date.now();
    for (const [k, f] of this.failures) {
      if (now - f.at > FAILURE_TTL_MS) this.failures.delete(k);
    }
    return {
      running: [...this.runs.values()],
      failures: [...this.failures.values()],
      ...(this.mergeQueue ? { mergeQueue: this.mergeQueue } : {}),
    };
  }

  /** Replace the merge-queue picture and push it to merge-queue subscribers (the SSE `merge-queue`
   * event). Called by merge-queue.ts after every state change. Does NOT re-broadcast the runner
   * snapshot — live merge updates flow on the dedicated channel; the snapshot carries it only on
   * (re)connect. */
  updateMergeQueue(snapshot: MergeQueueSnapshot): void {
    this.mergeQueue = snapshot;
    for (const fn of this.mqListeners) {
      try {
        fn(snapshot);
      } catch {
        this.mqListeners.delete(fn); // stream closed — drop it
      }
    }
  }

  /** Latest merge-queue picture (for the SSE initial frame), or undefined before the queue exists. */
  mergeQueueSnapshot(): MergeQueueSnapshot | undefined {
    return this.mergeQueue;
  }

  /** Subscribe to merge-queue changes; returns an unsubscribe fn (call on stream cancel). */
  subscribeMergeQueue(fn: MergeQueueListener): () => void {
    this.mqListeners.add(fn);
    return () => this.mqListeners.delete(fn);
  }

  /** Append a console line for a card's run and push it to log subscribers. */
  appendLog(board: string, cardId: string, level: LogLevel, text: string): void {
    const k = this.key(board, cardId);
    let buf = this.logs.get(k);
    if (!buf) {
      buf = [];
      this.logs.set(k, buf);
      this.evictLogs();
    }
    const frame: LogFrame = { board, cardId, seq: ++this.logSeq, level, text, at: Date.now() };
    buf.push(frame);
    if (buf.length > LOG_CAP_PER_CARD) buf.splice(0, buf.length - LOG_CAP_PER_CARD);
    for (const fn of this.logListeners) {
      try {
        fn(frame);
      } catch {
        this.logListeners.delete(fn);
      }
    }
  }

  /** Retained console frames for one card (most recent run). */
  getLogs(board: string, cardId: string): LogFrame[] {
    return this.logs.get(this.key(board, cardId)) ?? [];
  }

  /** Session id of this card's most recent run (for `claude --resume`), or undefined. */
  lastSessionId(board: string, cardId: string): string | undefined {
    return this.lastSession.get(this.key(board, cardId));
  }

  /** Attach cost/token usage to a card's run (parsed from its stream-json `result` event).
   * Retained after the run ends so the Processos page can show a finished run's cost. */
  setUsage(board: string, cardId: string, usage: RunUsage): void {
    const k = this.key(board, cardId);
    this.lastUsage.set(k, usage);
    const run = this.runs.get(k);
    if (run) {
      run.usage = usage;
      this.emit();
    }
  }

  /** Cost/token usage of this card's most-recent run, or undefined. */
  getUsage(board: string, cardId: string): RunUsage | undefined {
    return this.lastUsage.get(this.key(board, cardId));
  }

  /** All retained frames (bounded by the caps) — used to replay on SSE connect. */
  allLogs(): LogFrame[] {
    const out: LogFrame[] = [];
    for (const buf of this.logs.values()) out.push(...buf);
    return out;
  }

  /** Subscribe to live console frames; returns an unsubscribe fn. */
  logSubscribe(fn: LogListener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  /** Keep only the most-recently-active cards' logs (insertion-order LRU). */
  private evictLogs(): void {
    while (this.logs.size > LOG_CARDS_CAP) {
      const oldest = this.logs.keys().next().value;
      if (oldest === undefined) break;
      this.logs.delete(oldest);
    }
  }

  /** Subscribe an SSE stream sink; returns an unsubscribe fn (call on cancel). */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        this.listeners.delete(fn); // stream closed — drop it
      }
    }
  }
}

const KEY = Symbol.for("storymap.runner.registry");
const store = globalThis as unknown as { [KEY]?: RunnerRegistry };

export function getRunnerRegistry(): RunnerRegistry {
  return (store[KEY] ??= new RunnerRegistry());
}
