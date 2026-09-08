// noop-attribution.ts — WS-12 (D16) — WHO did the copiloto's run actually TRY, this run?
//
// The per-item anti-noop streak (autonomy-reliability WS-5.4) used to grow for every actionable item PRESENT
// at a spawn. The doc-comment promised "the copiloto gets two tries per item"; the code delivered "two spawns
// per board while the item exists". On 2026-07-16 that punished `acme/story-xfleex` — a CLEAN card parked at
// Publicar — into backoff with streak 4, without the copiloto ever having tried to publish it: the spawns were
// consumed by the spurious deploy-failures of two OTHER cards, and xfleex absorbed +1 by association each time.
// Board in Autônomo, `deploy: auto`, tick every 5min, and the pre-check answered `skipped-no-work` all day.
//
// The fix is a RULER, not a bigger cap: the streak grows only for an item the run actually ATTEMPTED. The
// evidence is the guard's own ledger (agent-actions.jsonl) — the tool calls that were really made, with the
// `cardId` the guard read off the canonical args. NEVER the item's presence on the board, and NEVER the run's
// self-report (ADR-063 inv. 1: deterministic where the rule is knowable — a run can lie or omit; the ledger
// can't). Two verdicts come out of one read (deriveRunAttempt):
//
//   anyMutation=false  → the run looked at a board WITH work and mutated NOTHING ⇒ the TRUE no-op of the
//                        2026-07-15 incident ("look, do nothing, wake up again") ⇒ every item bumps.
//   anyMutation=true   → only the cards it touched bump; an item it never tried keeps its streak (presence is
//                        not guilt).
//
// PURE (an array of AgentAction in, a verdict out) — the IO/window lives in orchestrator-run.ts.

import type { RiskClass } from "@/lib/storymap/types";
import type { AgentAction } from "./agent-actions";

/**
 * The risk classes that MUTATE the board — the ones whose call is a real attempt at moving an item. `read` is
 * excluded (looking is not trying); `run-free`/`destructive` are excluded because they are NEVER_AUTO in any
 * tier (kernel clamp) — a refused call to one of them is the guard's decision, not an attempt at the item.
 */
export const MUTATING_RISK_CLASSES: ReadonlySet<RiskClass> = new Set<RiskClass>([
  "write-board", // move_card / update_card / triage_finding / answer_question — the everyday pipeline verbs
  "run", // enqueue / run_skill / cancel_run — driving a card's own automation
  "merge-resolve", // resolve_merge / reconcile_stage — unparking the train
  "deploy", // publishing
  // ADR-065 — `session` is deliberately ABSENT. It is not an attempt at a board ITEM: the fleet's worktree
  // lifecycle acts on a session, not a card. Counting it would also actively BREAK this mechanism, because
  // `actor` here is the tokenEnv — which the copiloto tick and every fleet session SHARE (both hold
  // STORYMAP_MCP_TOKEN_ORCH). A fleet agent's `worktree_submit` inside a tick's window would then be credited
  // to the TICK as `anyMutation`, suppressing the no-op bump for a tick that genuinely did nothing.
]);

/** What ONE finished run did, as told by the ledger. */
export interface RunAttempt {
  /** the run executed ≥1 mutating call ON THIS BOARD (or one whose board can't be proven — see below). */
  anyMutation: boolean;
  /** the cards it aimed a mutating call at, in this window. Empty is legitimate (a board-level mutation). */
  attemptedCardIds: Set<string>;
}

export interface RunAttemptWindow {
  board: string;
  /** epoch ms of the spawn (inclusive). */
  from: number;
  /** epoch ms of the run's death (inclusive). */
  to: number;
  /** the ledger `actor` (tokenEnv) of the token THIS run holds. Required: without it, another scoped agent's
   *  actions in the same window would be credited to this run — the very misattribution being fixed. */
  actor: string;
}

/**
 * Derive what `run` attempted, from the guard's ledger. An entry counts when it is (a) inside the window,
 * (b) written by this run's actor, and (c) of a mutating class.
 *
 * OUTCOME IS NOT FILTERED, deliberately: `executed`, `grant-consumed`, `pending` (escalated to the human) and
 * `refused` (the matrix said no) are ALL attempts — the run spent its turn on that item and the item did not
 * move. Counting only `executed` would let a card the copiloto asks-and-is-refused about re-spawn forever.
 *
 * BOARD, and why an unprovable board suppresses the bump-all: a mutating call whose args carry no `board`
 * (`resolve_merge` takes a runId) cannot be proven to belong to THIS board — but it also cannot be proven not
 * to. Treating it as "no mutation" would let a run whose only work was unparking the train be judged a true
 * no-op and punish every innocent item on the board. So it counts as evidence the run ACTED (suppressing the
 * bump-all) while attributing to no card. The direction is deliberate: the 2026-07-15 no-op did not touch a
 * tool at all, so it is still caught; the cost of the fail-open is at most one extra tick, bounded by the
 * daily budget and the global signature backoff.
 *
 * PURE.
 */
export function deriveRunAttempt(actions: readonly AgentAction[], w: RunAttemptWindow): RunAttempt {
  const attemptedCardIds = new Set<string>();
  let anyMutation = false;
  for (const a of actions) {
    if (a.actor !== w.actor) continue;
    if (!MUTATING_RISK_CLASSES.has(a.cls)) continue;
    const at = Date.parse(a.at ?? "");
    if (!Number.isFinite(at) || at < w.from || at > w.to) continue;
    if (a.board != null && a.board !== w.board) continue; // provably another board's work
    anyMutation = true;
    if (a.board === w.board && a.cardId) attemptedCardIds.add(a.cardId);
  }
  return { anyMutation, attemptedCardIds };
}
