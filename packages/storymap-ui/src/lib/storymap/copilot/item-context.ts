// WS-1 (copilot-actionability, D5) — the PURE serialization of an escalated item's MINIMAL evidence +
// pointers into a text block. The client injects this block INSIDE the <contexto> of composeCopilotPrompt
// (never in the instruction — invariant 7), so a hostile conflictDetail is DATA, wrapped by the anti-injection
// notice. Zero IO / React / fs — same regime as protocol.ts; the aggregator action (copilotItemContextAction)
// reads the sources and hands the already-loaded pieces here. Deterministic (no Date.now) → snapshot-testable.
//
// Philosophy (D5): evidência MÍNIMA + ponteiros (runId, sessionId, paths) + the fixed MCP hint line — the
// agent collects the rest itself via MCP. The builder writes NO imperative verbs (the imperative is the
// escalation template, which travels in the composer, not here).

import type { Card, Finding } from "@/lib/storymap/types";
import type { MergeQueueEntry, RunnerFailure } from "@/lib/storymap/runner/types";
import type { JournalEntry } from "@/lib/storymap/runner/journal";
import type { PreservedBranch } from "@/lib/storymap/runner/preserved-branches";
import { openQuestions } from "../questions";
import type { EscalationRef } from "./escalation";

/** Everything OPTIONAL except boardId/ref: the action aggregates what exists; the builder serializes what came. */
export interface ItemContextPieces {
  boardId: string;
  ref: EscalationRef;
  card?: Card | null;
  mergeEntry?: MergeQueueEntry | null;
  journal?: JournalEntry | null;
  /** live registry failure (ephemeral; gone post-restart — the durable one is the run-death finding). */
  failure?: Pick<RunnerFailure, "reason" | "detail" | "at"> | null;
  /** findings ALREADY filtered to the ref's relevant ones — the builder does not filter. */
  findings?: Finding[];
  preserved?: PreservedBranch | null;
  /** "fonte X indisponível: <motivo>" lines — best-effort from the action. */
  unavailable?: string[];
}

/** The FIXED delegation line (D5) that closes EVERY item context. Exported for a test assertion. */
export const MCP_EVIDENCE_HINT =
  "Para mais evidência use as tools MCP: get_card, runner_status, card_console, deploy_status, git_*.";

const FINDING_DETAIL_CAP = 1200;
const BLOCK_CAP = 6000;

/** The primary id of a ref (for the header line). Pure. */
function refIdOf(ref: EscalationRef): string {
  switch (ref.kind) {
    case "merge":
      return ref.runId;
    case "run":
      return ref.runId ?? ref.cardId;
    case "branch":
      return ref.branch;
    case "process":
      return ref.session;
    case "approval":
      return ref.approvalId;
    case "governance":
      return ref.draftId;
    case "finding":
      return ref.findingId;
    case "question":
      return ref.questionId;
    case "move-blocked":
      return ref.target;
    default:
      return ref.cardId;
  }
}

/** Short title of the item (block header + drawer UI). Pure. */
export function itemContextTitle(pieces: ItemContextPieces): string {
  const { ref, card } = pieces;
  const name = card?.title ?? ref.boardId;
  switch (ref.kind) {
    case "merge":
      return `Merge ${ref.entryStatus} · run ${ref.runId}`;
    case "run":
      return `Run travado · ${card?.title ?? ref.cardId}`;
    case "deploy":
      return `Deploy falhou · ${card?.title ?? ref.cardId}`;
    case "finding":
      return `Bloqueio ${ref.findingId} · ${card?.title ?? ref.cardId}`;
    case "question":
      return `Pergunta · ${card?.title ?? ref.cardId}`;
    case "branch":
      return `Branch preservada ${ref.branch}`;
    case "process":
      return `Processo ${ref.session}`;
    case "approval":
      return `Aprovação ${ref.approvalId}`;
    case "governance":
      return `Governança ${ref.draftId}`;
    case "move-blocked":
      return `Move bloqueado → ${ref.target}`;
    default:
      return `Card ${name}`;
  }
}

function truncate(s: string, cap: number, suffix: string): string {
  return s.length <= cap ? s : s.slice(0, cap) + suffix;
}

/**
 * Serialize the item's minimal evidence + pointers. Sections are omitted when their piece is absent; per-field
 * caps + a total cap keep the block from becoming a dump. The `MCP_EVIDENCE_HINT` is ALWAYS the last line
 * (even under truncation). NO imperative verbs — only data + pointers (invariant 7 / D5).
 */
export function buildItemContext(pieces: ItemContextPieces): string {
  const { boardId, ref, card, mergeEntry, journal, failure, findings, preserved, unavailable } = pieces;
  const out: string[] = [];
  out.push(`## Item escalado: ${itemContextTitle(pieces)}`);
  out.push(`(board ${boardId} · ref ${ref.kind} ${refIdOf(ref)})`);

  if (card) {
    out.push("");
    out.push("### Card");
    const idbits = [`${card.id}`, `"${card.title}"`, `status ${card.status ?? "—"}`, `tipo ${card.storyType ?? "—"}`];
    if (card.mode) idbits.push(`mode ${card.mode}`);
    out.push(idbits.join(" · "));
    const meta: string[] = [];
    if (card.deployFiredAt) meta.push(`deployFiredAt ${card.deployFiredAt}`);
    if (card.commitRange) meta.push(`commitRange ${card.commitRange.base}..${card.commitRange.head}`);
    if (meta.length) out.push(meta.join(" · "));
    const tasks = card.tasks ?? [];
    const pendingTasks = tasks.filter((t) => !t.done).length;
    const openFindings = (card.findings ?? []).filter((f) => f.status === "open").length;
    out.push(`Tasks pendentes: ${pendingTasks}/${tasks.length} · Findings abertos: ${openFindings} · Perguntas abertas: ${openQuestions(card).length}`);
  }

  if (mergeEntry) {
    out.push("");
    out.push(`### Merge train (run ${mergeEntry.runId})`);
    out.push(
      `branch ${mergeEntry.branch} · base ${mergeEntry.baseCommit ?? "HEAD (entry legada)"} · status ${mergeEntry.status} · driveCount ${mergeEntry.driveCount ?? 0}`,
    );
    // conflictDetail/gateLog/failureReason are already ≤500 in the entry — verbatim (they ARE data).
    if (mergeEntry.conflictDetail) out.push(`conflictDetail: ${mergeEntry.conflictDetail}`);
    else if (mergeEntry.gateLog) out.push(`gateLog: ${mergeEntry.gateLog}`);
    else if (mergeEntry.failureReason) out.push(`failureReason: ${mergeEntry.failureReason}`);
  }

  if (journal || failure) {
    out.push("");
    out.push("### Run (journal)");
    if (journal) {
      out.push(
        `sessionId ${journal.sessionId} (retomável: claude --resume ${journal.sessionId}) · outcome ${journal.outcome ?? "—"} · origin ${journal.origin ?? "—"}`,
      );
      const j: string[] = [];
      if (journal.worktreePath) j.push(`worktree ${journal.worktreePath}`);
      if (journal.unit) j.push(`unit ${journal.unit}`);
      if (journal.column) j.push(`column ${journal.column}`);
      if (typeof journal.noProgressRuns === "number") j.push(`noProgressRuns ${journal.noProgressRuns}`);
      if (journal.resumeNote) j.push(`resumeNote ${journal.resumeNote}`);
      if (j.length) out.push(j.join(" · "));
    }
    if (failure) out.push(`Falha viva: ${failure.reason}${failure.detail ? ` — ${failure.detail}` : ""}`);
  }

  if (findings && findings.length) {
    out.push("");
    out.push("### Findings");
    for (const f of findings) {
      const detail = f.detail
        ? ` — ${truncate(f.detail, FINDING_DETAIL_CAP, "… [truncado; leia o finding completo via get_card]")}`
        : "";
      out.push(`- [${f.severity}] ${f.id}: ${f.title}${detail}${f.failureClass ? ` (failureClass ${f.failureClass})` : ""}`);
    }
  }

  if (preserved) {
    out.push("");
    out.push("### Branch preservada");
    out.push(
      `${preserved.branch} (${preserved.kind}, ${preserved.verdict}) · ${preserved.ownCommits} commits próprios · ${preserved.filesChanged} arquivos · código: ${preserved.touchesCode ? "sim" : "não"}`,
    );
    out.push(`motivo: ${preserved.reason}`);
    out.push(`recuperação: ${preserved.recoverHint}`);
  }

  if (unavailable && unavailable.length) {
    out.push("");
    out.push("### Fontes indisponíveis");
    for (const u of unavailable) out.push(`- ${u}`);
  }

  out.push("");
  out.push(MCP_EVIDENCE_HINT);

  const block = out.join("\n");
  if (block.length <= BLOCK_CAP) return block;
  // Trim from the END, ALWAYS preserving the MCP hint as the last line.
  const tail = `\n… [truncado]\n\n${MCP_EVIDENCE_HINT}`;
  return block.slice(0, BLOCK_CAP - tail.length) + tail;
}
