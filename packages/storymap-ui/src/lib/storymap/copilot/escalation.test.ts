import { describe, expect, it } from "vitest";
import {
  encodeEscalationRef,
  parseEscalationRef,
  escalationRefFor,
  ESCALATION_TEMPLATES,
  type EscalationParams,
  type EscalationRef,
  type EscalationTemplateId,
} from "./escalation";
import { SENSITIVE_AUDIT_CLASSES } from "../quick-actions";
import type { CockpitItem } from "../demands";

const ALL_IDS: EscalationTemplateId[] = [
  "merge-conflict", "merge-gate-failed", "merge-failed-terminal", "deploy-failed", "deploy-unsettled",
  "run-death", "run-inflight-stuck", "run-advanced-warning", "blocker-generic", "blocker-merge-back",
  "blocker-secret-scan", "qa-red", "question-pending", "approval-pending", "proposal-capture",
  "review-triage", "gate-manual-approve", "design-wireframe", "governance-draft", "release-aging",
  "preserved-branch-recovery", "orphan-process-kill", "move-gate-blocked", "unplaced-card", "hitl-card-instructions",
];

// One ref of EVERY kind in the union (roundtrip must be lossless).
const REFS: EscalationRef[] = [
  { templateId: "hitl-card-instructions", kind: "card", boardId: "storymap", cardId: "story-abc" },
  { templateId: "question-pending", kind: "question", boardId: "acme", cardId: "c1", questionId: "q1" },
  { templateId: "blocker-generic", kind: "finding", boardId: "storymap", cardId: "c1", findingId: "f1" },
  { templateId: "merge-conflict", kind: "merge", boardId: "storymap", cardId: "c1", runId: "run-1", entryStatus: "conflict" },
  { templateId: "run-death", kind: "run", boardId: "storymap", cardId: "c1" },
  { templateId: "run-inflight-stuck", kind: "run", boardId: "storymap", cardId: "c1", runId: "run-9" },
  { templateId: "deploy-failed", kind: "deploy", boardId: "storymap", cardId: "c1" },
  { templateId: "preserved-branch-recovery", kind: "branch", boardId: "storymap", branch: "run/abc-123" },
  { templateId: "orphan-process-kill", kind: "process", boardId: "storymap", session: "tmux-card-1" },
  { templateId: "approval-pending", kind: "approval", boardId: "storymap", approvalId: "apr-1" },
  { templateId: "governance-draft", kind: "governance", boardId: "storymap", draftId: "d1" },
  { templateId: "move-gate-blocked", kind: "move-blocked", boardId: "storymap", cardId: "c1", target: "revisao" },
];

/** Encode arbitrary JSON to the wire the same way encodeEscalationRef does (for tampered-payload tests). */
const wire = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");

describe("EscalationRef encode/parse", () => {
  it("roundtrips every kind losslessly", () => {
    for (const ref of REFS) {
      expect(parseEscalationRef(encodeEscalationRef(ref))).toEqual(ref);
    }
  });

  it("rejects tampered / malformed payloads WITHOUT throwing (null)", () => {
    const bad: (string | null | undefined)[] = [
      "",
      null,
      undefined,
      "not base64!!", // char outside [A-Za-z0-9_-]
      Buffer.from("{not json").toString("base64url"), // valid base64url, invalid JSON
      wire({ kind: "bogus", templateId: "deploy-failed", boardId: "x", cardId: "c1" }), // unknown kind
      wire({ kind: "card", templateId: "nope", boardId: "x", cardId: "c1" }), // unknown templateId
      wire({ kind: "card", templateId: "deploy-failed", boardId: "x", cardId: "has space" }), // bad id char
      wire({ kind: "card", templateId: "deploy-failed", boardId: "NOT A SLUG", cardId: "c1" }), // bad board slug
      wire({ kind: "merge", templateId: "merge-conflict", boardId: "x", cardId: "c1", runId: "r1", entryStatus: "weird" }), // bad enum
      "A".repeat(513), // > 512 wire cap
    ];
    for (const raw of bad) {
      expect(parseEscalationRef(raw)).toBeNull();
    }
  });
});

describe("ESCALATION_TEMPLATES", () => {
  it("is exhaustive over the 25 catalogued scenarios", () => {
    expect(Object.keys(ESCALATION_TEMPLATES).sort()).toEqual([...ALL_IDS].sort());
  });

  it("D8b — every sensitive template requires confirm + carries a non-empty confirmClause; others don't", () => {
    for (const id of ALL_IDS) {
      const t = ESCALATION_TEMPLATES[id];
      expect(t.id).toBe(id);
      if (SENSITIVE_AUDIT_CLASSES.has(t.cls)) {
        expect(t.requiresConfirm).toBe(true);
        expect(t.confirmClause && t.confirmClause.trim().length).toBeGreaterThan(0);
      } else {
        expect(t.requiresConfirm).toBe(false);
        expect(t.confirmClause).toBeUndefined();
      }
    }
  });

  const fullParams: EscalationParams = {
    boardId: "storymap",
    cardId: "card-1",
    runId: "run-1",
    findingId: "f-1",
    questionId: "q-1",
    approvalId: "a-1",
    branch: "run/b-1",
    session: "s-1",
    targetStatus: "revisao",
    extra: { gate: "hasTasks", gateLabel: "QA", draftId: "d-1", reason: "timeout", firedAt: "12:00", stagedAt: "2026-01-01" },
  };
  const RUN_BEARING = new Set<EscalationTemplateId>([
    "merge-conflict", "merge-gate-failed", "merge-failed-terminal", "run-inflight-stuck", "blocker-merge-back", "blocker-secret-scan",
  ]);
  const NON_CARD = new Set<EscalationTemplateId>(["governance-draft", "orphan-process-kill"]);

  it("every instruction cites its target id and is a non-empty string", () => {
    for (const id of ALL_IDS) {
      const text = ESCALATION_TEMPLATES[id].instruction(fullParams);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      if (!NON_CARD.has(id)) expect(text).toContain("card-1");
      if (RUN_BEARING.has(id)) expect(text).toContain("run-1");
    }
  });

  it("no instruction embeds third-party evidence (invariant 7 — anti prompt-injection)", () => {
    for (const id of ALL_IDS) {
      const text = ESCALATION_TEMPLATES[id].instruction(fullParams);
      for (const blob of ["stderr", "gateLog", "logTail", "<contexto>"]) {
        expect(text).not.toContain(blob);
      }
    }
  });
});

describe("escalationRefFor", () => {
  const base = (kind: string, over: Record<string, unknown>): CockpitItem =>
    ({ id: "c1:x", boardId: "storymap", cardId: "c1", cardTitle: "T", status: "s", lane: "travado", severity: "high", kind, ...over }) as CockpitItem;

  it("maps each item kind to the expected ref kind", () => {
    expect(escalationRefFor(base("question", { id: "c1:q:q1", lane: "pergunta", questionId: "q1", prompt: "?", options: [], mode: "single" }), "storymap")?.kind).toBe("question");
    expect(escalationRefFor(base("blocker", { id: "c1:b:f1", findingId: "f1", title: "Blk" }), "storymap")?.kind).toBe("card");
    expect(escalationRefFor(base("deploy-failed", { id: "c1:deploy-failed", findingId: "deploy-failure", title: "D" }), "storymap")?.kind).toBe("deploy");
    expect(escalationRefFor(base("gate", { id: "c1:approval", lane: "aprovar", gateLabel: "Aprovar" }), "storymap")?.kind).toBe("card");
    expect(escalationRefFor(base("review", { id: "c1:review", lane: "pergunta", severity: "medium" }), "storymap")?.kind).toBe("card");
    expect(escalationRefFor(base("proposal", { id: "c1:proposal", lane: "aprovar", summary: "", items: [], rounds: 0 }), "storymap")?.kind).toBe("card");
    expect(escalationRefFor(base("design", { id: "c1:design", lane: "aprovar", journey: null, options: [], chosenId: null }), "storymap")?.kind).toBe("card");

    const stuck = escalationRefFor(base("stuck", { id: "c1:stuck:error", trigger: "harness-do", outcome: "error" }), "storymap");
    expect(stuck?.kind).toBe("run");

    const conflict = escalationRefFor(base("conflict", { id: "c1:conflict:r1", runId: "r1", conflictKind: "merge-conflict" }), "storymap");
    expect(conflict?.kind).toBe("merge");
    expect(conflict && "entryStatus" in conflict ? conflict.entryStatus : null).toBe("conflict");

    const gov = escalationRefFor(base("governance", { id: "gov:d1", lane: "aprovar", draftId: "d1", changes: [], reason: "r", conflicts: [] }), "storymap");
    expect(gov?.kind).toBe("governance");
    expect(gov && "draftId" in gov ? gov.draftId : null).toBe("d1");
  });

  it("strips the apr: prefix for a copiloto approval, degrades data-deletion to a card", () => {
    const apr = escalationRefFor(base("approval", { id: "apr:xyz", lane: "aprovar", gateLabel: "Jido pede" }), "storymap");
    expect(apr?.kind).toBe("approval");
    expect(apr && "approvalId" in apr ? apr.approvalId : null).toBe("xyz");

    const del = escalationRefFor(base("approval", { id: "c1:data-deletion", lane: "aprovar", gateLabel: "Aprovar exclusão" }), "storymap");
    expect(del?.kind).toBe("card");
  });

  it("returns null when there is no cardId and no specific id", () => {
    expect(escalationRefFor(base("review", { id: "c1:review", cardId: "", lane: "pergunta" }), "storymap")).toBeNull();
  });
});
