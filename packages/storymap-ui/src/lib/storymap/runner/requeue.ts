// WS-5 (copilot-actionability) — the PURE pieces of "re-enfileirar" a TERMINAL `failed` merge-train entry.
// Re-integrating a failed entry with the SAME branch is a terminal-retry of enqueueMerge (merge-queue.ts:
// a prior terminal entry with the same runId is removed and re-inserted as `waiting`, and the processor is
// kicked). No surgery on the train. These helpers are pure (no IO) so they stay node-unit-testable; the
// server action (requeueMergeEntryAction) probes the branch on disk and calls enqueueMerge.

import type { MergeQueueEntry } from "./types";

/**
 * Candidate branches to re-integrate a parked entry, in preference order: the one registered on the entry,
 * the preserved `failed/run/<id>`, the preserved `conflicted/run/<id>`, then the original `run/<id>`.
 * Deduped. Pure.
 *
 * autonomy-endgame WS-3.5 — `conflicted/run/<id>` is here because the recovery tool did not reach the state
 * the incident parks in. A DATA-half failure finalizes the entry as `conflict` (not `failed`), and the
 * preservation rename stacks `conflicted/` (not `failed/`) — so the operator's one manual recovery path was
 * blind to the exact situation it existed for: it looked for the wrong status AND, even past that, for the
 * wrong branch name.
 */
export function requeueCandidates(entry: Pick<MergeQueueEntry, "runId" | "branch">): string[] {
  const out: string[] = [];
  const add = (b: string | undefined) => {
    if (b && !out.includes(b)) out.push(b);
  };
  add(entry.branch);
  add(`failed/run/${entry.runId}`);
  add(`conflicted/run/${entry.runId}`);
  add(`run/${entry.runId}`);
  return out;
}

/**
 * Which TERMINAL statuses a requeue accepts. `failed`/`conflict` are the classic recovery targets.
 * `done` is accepted TOO — deliberately: a `done` can LIE (o falso-done 94bfdb77: a ref sumiu sob a fila,
 * o diff leu vazio e as duas metades "aterrissaram vazias"), and re-integrating an HONEST done is a
 * structural no-op — applyPatch is idempotent (`--reverse --check` → "already"), so both halves re-detect
 * as landed and the entry re-finalizes done without duplicating a single commit. Accepting `done` turns
 * the false-done from "git surgery" into one requeue call. Live statuses (waiting/merging/gate-running/
 * re-driving) have their own paths and are NEVER requeueable. Pure.
 */
export function isRequeueableStatus(status: string): boolean {
  return status === "failed" || status === "conflict" || status === "done";
}

/**
 * The CLEAN entry for the enqueueMerge retry: preserves identity/lineage (runId, board, cardId, baseCommit,
 * trigger, driveCount) + the RESOLVED branch; DISCARDS all terminal residue (mergeStartedAt/mergeEndedAt/
 * failureReason/conflictDetail/gateLog/pushError/gateBlockerError/secretScanBlockerError/split) — a split
 * progress belongs to the ATTEMPT, not the lineage; a partial split re-detects on the new integration. Pure.
 */
export function buildRequeueEntry(entry: MergeQueueEntry, branch: string): Omit<MergeQueueEntry, "status" | "enqueuedAt"> {
  return {
    runId: entry.runId,
    board: entry.board,
    cardId: entry.cardId,
    branch,
    ...(entry.baseCommit ? { baseCommit: entry.baseCommit } : {}),
    ...(entry.trigger ? { trigger: entry.trigger } : {}),
    ...(entry.driveCount !== undefined ? { driveCount: entry.driveCount } : {}),
  };
}
