import { describe, expect, it } from "vitest";
import { MCP_INSTRUCTIONS, ONBOARDING_GUIDE } from "./onboarding";

// story-26xi3s — discoverability of the high-use authoring tools that the client
// harness DEFERS (update_card, save_persona, save_system, triage_finding). An agent
// that can't see them on the initial surface wastes hours on tmux/script workarounds
// for what is one call. The fix is purely textual: name them prominently in the
// always-on instructions + the onboarding guide, and tell the agent how to load them
// (tool_search). The deferral itself is CLIENT-SIDE (the harness), not server-controlled —
// the surface must NOT promise to "un-defer" them.

const DEFERRED_TOOLS = ["update_card", "save_persona", "save_system", "triage_finding"];

describe("MCP_INSTRUCTIONS — names the high-use deferred authoring tools", () => {
  it("names all four high-use deferred authoring tools", () => {
    for (const tool of DEFERRED_TOOLS) {
      expect(MCP_INSTRUCTIONS).toContain(tool);
    }
  });

  it("tells the agent HOW to load a deferred tool (tool_search)", () => {
    expect(MCP_INSTRUCTIONS).toMatch(/tool_search/);
  });

  it("frames update_card as the way to fix/edit a card (not tmux/scripts)", () => {
    expect(MCP_INSTRUCTIONS).toMatch(/update_card/);
    expect(MCP_INSTRUCTIONS.toLowerCase()).toMatch(/poluíd|corrigir|editar/);
  });

  it("does NOT promise the server un-defers the tool (the deferral is client-side)", () => {
    // No misleading promise like "removemos/tiramos a update_card do deferral".
    expect(MCP_INSTRUCTIONS).not.toMatch(/(remov|tira)\w*[^\n]*deferr?al/i);
  });
});

describe("ONBOARDING_GUIDE — LEIA PRIMEIRO block for the deferred authoring tools", () => {
  it("has a LEIA PRIMEIRO block naming the deferred authoring tools", () => {
    expect(ONBOARDING_GUIDE).toMatch(/LEIA PRIMEIRO/);
    for (const tool of DEFERRED_TOOLS) {
      expect(ONBOARDING_GUIDE).toContain(tool);
    }
  });

  it("explains the deferral is the client harness (server can't un-defer) + tool_search loads it", () => {
    expect(ONBOARDING_GUIDE.toLowerCase()).toMatch(/harness|cliente/);
    expect(ONBOARDING_GUIDE).toMatch(/tool_search/);
  });

  it("frames update_card as O CAMINHO to fix a polluted/wrong card, not tmux/scripts", () => {
    expect(ONBOARDING_GUIDE.toLowerCase()).toMatch(/poluíd/);
    expect(ONBOARDING_GUIDE.toLowerCase()).toMatch(/tmux|scripts?/);
  });

  it("does NOT promise the server un-defers the tool", () => {
    expect(ONBOARDING_GUIDE).not.toMatch(/(remov|tira)\w*[^\n]*deferr?al/i);
  });
});

// story-tool-mcp-captura-inteligente (AC4) — the preamble + guide must carry an explicit
// intent→tool map so any agent knows when to reach for usm_capture vs create_card/report_issue.

describe("intent→tool map — names usm_capture for full plans (AC4)", () => {
  it("MCP_INSTRUCTIONS names usm_capture alongside create_card and report_issue", () => {
    expect(MCP_INSTRUCTIONS).toContain("usm_capture");
    expect(MCP_INSTRUCTIONS).toContain("create_card");
    expect(MCP_INSTRUCTIONS).toContain("report_issue");
  });

  it("MCP_INSTRUCTIONS frames usm_capture as the full-plan / hierarchy path", () => {
    expect(MCP_INSTRUCTIONS.toLowerCase()).toMatch(/plano completo|hierarquia|brain-dump/);
  });

  it("ONBOARDING_GUIDE documents usm_capture (propose→apply) in the create/edit section + a recipe", () => {
    expect(ONBOARDING_GUIDE).toContain("usm_capture");
    expect(ONBOARDING_GUIDE).toMatch(/propose/);
    expect(ONBOARDING_GUIDE).toMatch(/apply/);
  });
});
