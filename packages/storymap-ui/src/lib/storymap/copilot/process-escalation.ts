// WS-4 (copilot-actionability) — pure decisions of WHO escalates on /processes and WITH WHICH ref
// (§4.2–§4.4), plus the §4.6 receptor's anchor resolver. Zero IO/React — only types + the frozen WS-0
// escalation kernel (copilot/escalation.ts). The components in ProcessesClient.tsx/ProcessActions.tsx
// are thin casings over these decisions (invariant 5); every escalate button on /processes renders one
// of these, never a hand-rolled ref.

import type { EscalationRef, EscalationTemplateId } from "./escalation";
import type { MergeQueueStatus } from "../runner/types";
import type { ServiceKind, ServiceStatus } from "../../vps/types";

/** A resolved escalation: the board the drawer lands on + the ref that seeds the composer. */
export interface EscalationTarget {
  boardId: string;
  ref: EscalationRef;
}

/**
 * §4.2 — a merge-train row escalates only in its 3 troubled statuses (conflict/gate-failed/failed — the
 * other 6, waiting/gate-running/merging/re-driving/done/returned-to-session, have nothing to hand the
 * copiloto; `returned-to-session` least of all: it went back to a LIVE session that is already fixing it).
 * WS-1.3: an escalation is a CARD hand-off (the ref is card-shaped), so card-less session work escalates
 * nowhere — its owner is the session itself.
 */
export function mergeEntryEscalation(
  entry: { runId: string; board: string; cardId?: string; status: MergeQueueStatus },
): EscalationTarget | null {
  const { status, board, cardId, runId } = entry;
  if (!cardId) return null;
  if (status !== "conflict" && status !== "gate-failed" && status !== "failed") return null;
  const templateId: EscalationTemplateId =
    status === "conflict" ? "merge-conflict" : status === "gate-failed" ? "merge-gate-failed" : "merge-failed-terminal";
  return { boardId: board, ref: { templateId, kind: "merge", boardId: board, cardId, runId, entryStatus: status } };
}

/**
 * §4.3 — a run/service row: `interrupted`|`failed` ⇒ `run-death` (diagnose before Retomar); `running`
 * of a `runner-run` ⇒ `run-inflight-stuck` (diagnose before Liberar/⏹). No board+cardId ⇒ null — there
 * is no board to land the drawer on (tmux ad-hoc / claude-external without a card stay out of v1).
 */
export function serviceEscalation(
  svc: { kind: ServiceKind; status: ServiceStatus; board?: string; cardId?: string },
): EscalationTarget | null {
  const { board, cardId } = svc;
  if (!board || !cardId) return null;
  if (svc.status === "interrupted" || svc.status === "failed") {
    return { boardId: board, ref: { templateId: "run-death", kind: "run", boardId: board, cardId } };
  }
  if (svc.status === "running" && svc.kind === "runner-run") {
    return { boardId: board, ref: { templateId: "run-inflight-stuck", kind: "run", boardId: board, cardId } };
  }
  return null;
}

/**
 * §4.4 — a preserved branch escalates unless it's `superseded` (safe-to-discard trash — escalating
 * would only add noise) or has no `board` (no destination for the drawer, D14).
 */
export function preservedBranchEscalation(
  b: { branch: string; board: string | null; superseded: boolean },
): EscalationTarget | null {
  if (b.superseded || b.board === null) return null;
  return {
    boardId: b.board,
    ref: { templateId: "preserved-branch-recovery", kind: "branch", boardId: b.board, branch: b.branch },
  };
}

/** §4.6 — the receptor's resolved anchor: ONE target to scroll-to-and-ring, or silence. */
export type ProcessAnchor =
  | { kind: "merge"; runId: string; archived: boolean }
  | { kind: "service"; serviceId: string }
  | null;

/**
 * Resolves the raw `?run=`/`?svc=` query params to ONE `ProcessAnchor`. `run` has precedence over
 * `svc`; an id the page doesn't currently know about (run left the queue, service died post-restart)
 * resolves to `null` — NEVER throws, NEVER surfaces an error (the page just opens normally, silent).
 * `archived` = the entry lives in "Arquivo & recuperação" (done/failed — ProcessesClient.tsx mqHistory).
 */
export function resolveProcessAnchor(
  params: { run: string | null; svc: string | null },
  mergeStatusByRunId: ReadonlyMap<string, MergeQueueStatus>,
  serviceIds: ReadonlySet<string>,
): ProcessAnchor {
  if (params.run) {
    const status = mergeStatusByRunId.get(params.run);
    if (status === undefined) return null;
    return { kind: "merge", runId: params.run, archived: status === "done" || status === "failed" };
  }
  if (params.svc) {
    return serviceIds.has(params.svc) ? { kind: "service", serviceId: params.svc } : null;
  }
  return null;
}
