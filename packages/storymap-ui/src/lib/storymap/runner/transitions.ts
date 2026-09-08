// WS2 — WRITERS-ONLY durable ledger of card status transitions (append-only JSONL) at
// storymap/.runner/transitions.jsonl. Honest history: every from→to hop with WHO caused it — a human move,
// the cascade, the merge-back, a run's advance, or a system auto-enter-terminal. The card panel's
// retroactive-✓ pipeline (WS5) reads this instead of guessing from array position.
//
// FAIL-OPEN: an append failure WARNS, never throws into the caller — moveCardAction, forward()'s
// lock-scoped try, and the engine's child `close` handler must never break because the ledger couldn't
// write (mirrors telemetry.recordRun's discipline). SERIALIZED: appends chain onto a single writeChain so
// concurrent writers never interleave a partial line. Reading (readTransitions) is a separate, tolerant
// concern (per-line safeParse) — a corrupt line is skipped, never fatal.

import { promises as fsp } from "node:fs";
import { transitionsPath } from "@/lib/storymap/paths";

export const TRANSITIONS_VERSION = 1;

/** Who caused a transition. `run:<trigger>` names the skill that advanced the card on settle. */
export type TransitionActor = "human" | "cascade" | "system" | "merge" | `run:${string}`;

export interface Transition {
  v: number;
  /** ISO timestamp of the transition. */
  at: string;
  board: string;
  cardId: string;
  /** the status left (null when unknown / first observation). */
  from: string | null;
  /** the status entered. */
  to: string;
  actor: TransitionActor;
  /** the run/session id (== branch run/<id>) when a run/merge caused it. */
  runId?: string;
  /** free-form context (e.g. "reopen:fix"). */
  note?: string;
}

export interface AppendTransitionInput {
  board: string;
  cardId: string;
  from: string | null;
  to: string;
  actor: TransitionActor;
  runId?: string;
  note?: string;
}

/** Injectable persist port — tests swap it for an in-memory collector; prod appends to the JSONL file. */
export interface TransitionSink {
  append(line: string): Promise<void>;
}

/** Keep the ledger bounded. MAX_LINES is now a GATE (not the post-compaction size): when the file grows past
 *  it, compactTransitions() runs CARD-SCOPED retention (last N per card + last 30 days) — so after a compaction
 *  the file may still sit near MAX_LINES if many cards are live inside the window. That is intended (the 30-day
 *  history is kept regardless); do NOT "fix" it back to a blind slice. TRIM_EVERY gates HOW OFTEN we attempt a
 *  compaction (every N appends) to keep the amortized append O(1). */
const MAX_LINES = 20_000;
const TRIM_EVERY = 1_000;
/** 6.2 — card-scoped retention knobs: keep the last N hops of EVERY card PLUS everything from the last 30 days. */
const KEEP_PER_CARD = 50;
const KEEP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function fileSink(): TransitionSink {
  let sinceTrim = 0;
  return {
    async append(line: string): Promise<void> {
      // Under vitest the DEFAULT sink is a no-op so an engine/autorun test firing appendTransition doesn't
      // churn the gitignored ledger file. The writer's OWN tests inject a collector sink (setTransitionSink),
      // so they bypass this guard and still assert the payload.
      if (process.env.VITEST) return;
      const file = transitionsPath();
      await fsp.appendFile(file, line, "utf8");
      if (++sinceTrim >= TRIM_EVERY) {
        sinceTrim = 0;
        // 6.2 — best-effort CARD-SCOPED compaction: read, keep last-N-per-card + last-30-days, rewrite. Only
        // when the file exceeds the cap (so append stays O(1) amortized). Replaces the old blind slice, which
        // could evict a quiet board's live-card history when a noisy board flooded the shared file. A failure
        // here is swallowed by the caller's fail-open catch — an over-long ledger is never worse than a throw.
        const raw = await fsp.readFile(file, "utf8").catch(() => "");
        const lines = raw.split("\n").filter((l) => l.trim());
        if (lines.length > MAX_LINES) {
          await fsp.writeFile(file, compactTransitions(raw, { now: Date.now() }), "utf8");
        }
      }
    },
  };
}

let sink: TransitionSink = fileSink();
let writeChain: Promise<void> = Promise.resolve();

/** TEST SEAM — swap the persist port. Returns nothing; pair with resetTransitionSink() in afterEach. */
export function setTransitionSink(s: TransitionSink): void {
  sink = s;
}
/** TEST SEAM — restore the production file sink. */
export function resetTransitionSink(): void {
  sink = fileSink();
}

/**
 * Append ONE transition. Fire-and-forget from the caller's perspective (they may `void` it): the returned
 * promise resolves after the serialized write, and NEVER rejects (a failure is warned + swallowed). Chains
 * onto the previous append so lines can't interleave.
 */
export function appendTransition(input: AppendTransitionInput): Promise<void> {
  const rec: Transition = { v: TRANSITIONS_VERSION, at: new Date().toISOString(), ...input };
  const line = JSON.stringify(rec) + "\n";
  writeChain = writeChain.then(() => sink.append(line)).catch((err) => {
    console.warn("[transitions] append falhou (não-fatal):", err instanceof Error ? err.message : err);
  });
  return writeChain;
}

/**
 * Read the ledger (tolerant, per-line safeParse — a corrupt line is skipped). Optional filter by card/board.
 * Returns [] when the file is absent. Reading is advisory display data (WS5), never a gate.
 */
export async function readTransitions(filter?: { cardId?: string; board?: string }): Promise<Transition[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(transitionsPath(), "utf8");
  } catch {
    return [];
  }
  return parseTransitionsLines(raw, filter);
}

/** PURE — parse a JSONL blob into transitions, tolerant (a corrupt line is skipped) + optionally filtered. */
export function parseTransitionsLines(raw: string, filter?: { cardId?: string; board?: string }): Transition[] {
  const out: Transition[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Transition;
      if (!rec || typeof rec.to !== "string" || typeof rec.cardId !== "string") continue;
      if (filter?.cardId && rec.cardId !== filter.cardId) continue;
      if (filter?.board && rec.board !== filter.board) continue;
      out.push(rec);
    } catch {
      /* skip a malformed line — the ledger is append-only and a partial write must not break reads */
    }
  }
  return out;
}

/**
 * PURE — CARD-SCOPED compaction of a JSONL ledger blob (6.2). Replaces the old card-BLIND global trim, which
 * let a noisy board evict a quiet board's live-card history from the single shared file. For EVERY card it
 * keeps the last `keepPerCard` hops PLUS every hop inside the last `windowMs`; the union is the survivor set.
 * Because the most-recent hop of any card is always within the last-N, the last hop of a card is NEVER removed.
 *
 * Order-preserving (chronological) and byte-preserving — survivors are re-emitted as their EXACT original line
 * text, so any forward-compatible fields the parser doesn't model are retained. Unparseable / attribution-less
 * lines (no string `cardId`/`to`) are DROPPED — they carry no card to retain by; this is a documented
 * divergence from the old slice (which kept junk) and matches the reader's own tolerance. `now` is injected
 * (defaulted to Date.now()) so the 30-day window is deterministically testable. Never throws.
 */
export function compactTransitions(
  raw: string,
  opts?: { now?: number; keepPerCard?: number; windowMs?: number },
): string {
  const now = opts?.now ?? Date.now();
  const keepPerCard = opts?.keepPerCard ?? KEEP_PER_CARD;
  const windowMs = opts?.windowMs ?? KEEP_WINDOW_MS;
  // Parse once, remembering each survivor candidate's ORIGINAL text + its cardId + parsed timestamp.
  const parsed: { line: string; cardId: string; atMs: number }[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Transition;
      if (!rec || typeof rec.to !== "string" || typeof rec.cardId !== "string") continue; // same guard as the reader
      parsed.push({ line: t, cardId: rec.cardId, atMs: Date.parse(rec.at) });
    } catch {
      /* drop a malformed line — no attributable card, so per-card retention can't keep it */
    }
  }
  // Walk newest→oldest, marking survivors: keep while under the per-card count OR inside the time window.
  const perCard = new Map<string, number>();
  const keep = new Array<boolean>(parsed.length).fill(false);
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    const seen = perCard.get(p.cardId) ?? 0;
    const withinWindow = Number.isFinite(p.atMs) && now - p.atMs <= windowMs;
    if (seen < keepPerCard || withinWindow) {
      keep[i] = true;
      perCard.set(p.cardId, seen + 1);
    }
  }
  // Re-emit survivors in ORIGINAL (chronological) order.
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) if (keep[i]) out.push(parsed[i].line);
  return out.length ? out.join("\n") + "\n" : "";
}
