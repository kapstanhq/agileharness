import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WS-0 §0.3 aceite — the dispatcher CONTRACT, asserted over the component SOURCE (the AgileHarness test rig
// is node-env with no DOM renderer; `.tsx` render tests are broken under rolldown-vite — same regex-over-
// source pattern as kanban-card-footer.test.ts). The single dispatcher must handle EVERY invoke kind,
// call each mapped server action, and honour the click invariants (stopPropagation, no leak of the
// escalate `?copilot=` outside a navigation).
// O despachante é o botão MAIS o módulo de execução que ele compartilha com o cartão do Inbox (quick-action-run.ts):
// o switch de invoke → ação de servidor mora lá, UMA vez, e as duas superfícies o chamam.
const source =
  readFileSync(fileURLToPath(new URL("./QuickActionButton.tsx", import.meta.url)), "utf8") +
  readFileSync(fileURLToPath(new URL("./quick-action-run.ts", import.meta.url)), "utf8");

describe("QuickActionButton dispatcher contract", () => {
  it("has a switch case for every QuickActionInvoke kind (10)", () => {
    for (const kind of ["move-card", "run-skill", "force-release", "resolve-merge", "resolve-gate", "update-finding", "discard-branch", "requeue-merge"]) {
      expect(source, `case "${kind}"`).toContain(`case "${kind}"`);
    }
    // navegar e abrir o Jido são gestos de tela: o botão os trata ANTES de ir ao despachante de servidor
    for (const kind of ["link", "escalate"]) expect(source, kind).toContain(`invoke.kind === "${kind}"`);
    // exhaustiveness backstop — a never-check on the default so a new kind breaks the typecheck.
    expect(source).toMatch(/const _?never: never = invoke/);
  });

  it("B1 — a exclusão de dados tem invoke próprio e chama approveDataDeletionAction (nunca um move)", () => {
    expect(source).toContain('case "approve-data-deletion"');
    expect(source).toContain("approveDataDeletionAction");
  });

  it("as decisões do dono no Inbox têm invoke próprio: autorizar a publicação (por causa) e mandar corrigir um aviso", () => {
    expect(source).toContain('case "authorize-publish"');
    expect(source).toContain("authorizePublishAction({ boardId: invoke.boardId, causeKey: invoke.causeKey })");
    expect(source).toContain('case "fix-finding"');
    expect(source).toContain("fixFindingAction({ boardId: invoke.boardId, cardId: invoke.cardId, findingId: invoke.findingId })");
  });

  it("B2 — o toast vem de quickActionFeedback (iniciado × feito × recusado), nunca «<rótulo>: ok»", () => {
    expect(source).toContain("quickActionFeedback(");
    expect(source).not.toMatch(/:\s*ok`/);
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

describe("B12 — um rótulo só para o botão do Jido", () => {
  it("EscalateButton e buildEscalateAction usam o mesmo rótulo padrão", () => {
    const esc = readFileSync(fileURLToPath(new URL("./copilot/EscalateButton.tsx", import.meta.url)), "utf8");
    const qa = readFileSync(fileURLToPath(new URL("../lib/storymap/quick-actions.ts", import.meta.url)), "utf8");
    expect(esc).toMatch(/label = "Pedir ao Jido"/);
    expect(qa).toMatch(/label = "Pedir ao Jido"/);
  });
});
