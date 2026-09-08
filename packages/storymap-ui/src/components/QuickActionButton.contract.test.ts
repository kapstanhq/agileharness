import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WS-0 §0.3 aceite — the dispatcher CONTRACT, asserted over the component SOURCE (the AgileHarness test rig
// is node-env with no DOM renderer; `.tsx` render tests are broken under rolldown-vite — same regex-over-
// source pattern as kanban-card-footer.test.ts). The single dispatcher must handle EVERY invoke kind,
// call each mapped server action, and honour the click invariants (stopPropagation, no leak of the
// escalate `?copilot=` outside a navigation).
const source = readFileSync(fileURLToPath(new URL("./QuickActionButton.tsx", import.meta.url)), "utf8");

describe("QuickActionButton dispatcher contract", () => {
  it("has a switch case for every QuickActionInvoke kind (10)", () => {
    for (const kind of ["move-card", "run-skill", "force-release", "resolve-merge", "resolve-gate", "update-finding", "discard-branch", "link", "escalate", "requeue-merge"]) {
      expect(source, `case "${kind}"`).toContain(`case "${kind}"`);
    }
    // exhaustiveness backstop — a never-check on the default so a new kind breaks the typecheck.
    expect(source).toContain("const _never: never = invoke");
  });

  it("calls each of the 8 quick-action server actions", () => {
    for (const action of [
      "moveCardAction",
      "runCardSkillAction",
      "forceReleaseRunAction",
      "resolveMergeConflictAction",
      "resolveGateFailedAction",
      "updateFindingStatusAction",
      "discardPreservedBranchAction",
      "requeueMergeEntryAction",
    ]) {
      expect(source, action).toContain(action);
    }
  });

  it("navigates (link + escalate) and seeds ?copilot=<ref> via encodeEscalationRef", () => {
    expect(source).toContain("router.push");
    expect(source).toContain("router.replace");
    expect(source).toContain("encodeEscalationRef");
    expect(source).toContain("?copilot=");
  });

  it("stops propagation on pointer down and click (invariant 8)", () => {
    expect(source).toContain("onPointerDown");
    expect(source).toContain("stopPropagation");
  });

  it("audits the sensitive human click (D7) and toasts on the Result (invariant 9)", () => {
    expect(source).toContain("SENSITIVE_AUDIT_CLASSES");
    expect(source).toContain("logHumanActionAction");
    expect(source).toContain("router.refresh");
  });
});
