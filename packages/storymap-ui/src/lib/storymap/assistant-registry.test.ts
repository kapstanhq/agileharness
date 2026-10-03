import { describe, expect, it } from "vitest";
import { VIEW_ASSISTANTS, assistantById, assistantForKind } from "./assistant-registry";
import * as publicationGate from "../../../../../scripts/oss/publication-gate.mjs";

describe("VIEW_ASSISTANTS — the styleguide view-assistant (WS-4)", () => {
  it("registers exactly one assistant for kind 'styleguide', with id 'styleguide' (matches the override filename .claude/storymap-assistants/styleguide.md)", () => {
    const matches = VIEW_ASSISTANTS.filter((a) => a.kind === "styleguide");
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("styleguide");
  });

  it("assistantForKind('styleguide') and assistantById('styleguide') resolve the same entry", () => {
    const byKind = assistantForKind("styleguide");
    const byId = assistantById("styleguide");
    expect(byKind).toBeDefined();
    expect(byKind).toBe(byId);
  });

  it("the default persona is generic/agnostic — no product/brand marks (agnostic-lint invariant 5)", () => {
    const a = assistantForKind("styleguide")!;
    const forbidden = ["armazem", "galpao", "totem", "balcao", "tally"];
    const lower = a.defaultPrompt.toLowerCase();
    for (const mark of forbidden) {
      expect(lower.includes(mark), `defaultPrompt must not mention "${mark}"`).toBe(false);
    }
    // …and none of the operator's own private names, when the installation declares them (the publication gate's terms
    // file lives OUTSIDE the repository — a list of real brands written here would be the leak itself).
    const g = publicationGate as unknown as { defaultTermsFile: () => string; loadPrivateTerms: (file: string) => Array<{ re: RegExp; term: string }> | null };
    for (const t of g.loadPrivateTerms(g.defaultTermsFile()) ?? []) {
      expect(t.re.test(a.defaultPrompt), `defaultPrompt must not mention the private term "${t.term}"`).toBe(false);
    }
  });

  it("cites papéis/ratios in the persona (design-director tone required by 05-ws4)", () => {
    const a = assistantForKind("styleguide")!;
    expect(a.defaultPrompt).toContain("papéis");
    expect(a.defaultPrompt.toLowerCase()).toContain("ratio");
  });
});
