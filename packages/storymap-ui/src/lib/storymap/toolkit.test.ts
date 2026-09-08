import { describe, expect, it } from "vitest";
import { resolveToolkit, computeToolGap, expandToolkitTemplate, lintToolkit, TOOLKIT_GUIDANCE_MAX } from "./toolkit";
import type { BoardConfig, StatusDef } from "./types";

// WS3 (F2) — resolveToolkit turns the declarative facet into concrete mounts/expectations. The KEY
// property: a toolConfig mount templated by `{board}` resolves per-board, so nimbus gets its OWN graph
// instead of inheriting storymap's (the diagnóstico-I4 bug this closes) — with ZERO per-board code.
const config = (
  toolConfigs: BoardConfig["toolConfigs"],
  specialists?: BoardConfig["specialists"],
): Pick<BoardConfig, "toolConfigs" | "specialists"> => ({ toolConfigs, specialists });
const step = (over: Partial<StatusDef>): Pick<StatusDef, "mcpConfig" | "toolkit"> => over;

const CODEGRAPH = {
  codegraph: { mcp: "storymap/graphify/{board}.json", match: "^mcp__graphify__", description: "grafo" },
};

describe("resolveToolkit — template per board", () => {
  it("expands {board} in a toolConfig mount → the per-board graph path (nimbus, NOT storymap)", () => {
    const r = resolveToolkit(step({ toolkit: { use: ["codegraph"] } }), config(CODEGRAPH), "nimbus", "/repo");
    expect(r.mcpConfigPaths).toEqual(["storymap/graphify/nimbus.json"]);
  });

  it("expands {repoRoot} too", () => {
    const r = resolveToolkit(
      step({ toolkit: { use: ["cg"] } }),
      config({ cg: { mcp: "{repoRoot}/.graphify/{board}.json" } }),
      "acme",
      "/root/repo",
    );
    expect(r.mcpConfigPaths).toEqual(["/root/repo/.graphify/acme.json"]);
    expect(expandToolkitTemplate("{board}-{repoRoot}", "b", "/r")).toBe("b-/r");
  });

  it("absorbs the legacy mcpConfig as a plain mount (sugar) and DEDUPES against a use path", () => {
    // a step that both use's codegraph AND carries the same resolved path mounts it ONCE.
    const r = resolveToolkit(
      step({ mcpConfig: "storymap/graphify/nimbus.json", toolkit: { use: ["codegraph"] } }),
      config(CODEGRAPH),
      "nimbus",
      "/repo",
    );
    expect(r.mcpConfigPaths).toEqual(["storymap/graphify/nimbus.json"]);
  });

  it("a legacy-only step (no toolkit) resolves to just its mcpConfig — byte-identical mount set", () => {
    const r = resolveToolkit(step({ mcpConfig: "storymap/qa-mcp.json" }), config(undefined), "storymap", "/repo");
    expect(r.mcpConfigPaths).toEqual(["storymap/qa-mcp.json"]);
    expect(r.allowedTools).toEqual([]);
    expect(r.expects).toEqual([]);
    expect(r.guidance).toBeUndefined();
  });

  it("fail-open: an unknown use id contributes no mount", () => {
    const r = resolveToolkit(step({ toolkit: { use: ["ghost"] } }), config(CODEGRAPH), "nimbus", "/repo");
    expect(r.mcpConfigPaths).toEqual([]);
  });

  it("carries allowedTools + specialists + composed guidance (incl. a v1 CLI hint)", () => {
    const r = resolveToolkit(
      step({
        toolkit: {
          use: ["codegraph", "cli-tool"],
          guidance: "Consulte query_graph antes de propor arquitetura.",
          allowedTools: ["Read", "mcp__graphify__query_graph"],
          specialists: ["security"],
        },
      }),
      config(
        { ...CODEGRAPH, "cli-tool": { cli: "graphify-rebuild" } },
        { security: { agent: "security-reviewer", when: "rules, auth, pagamentos" } },
      ),
      "storymap",
      "/repo",
    );
    expect(r.allowedTools).toEqual(["Read", "mcp__graphify__query_graph"]);
    // WS4 — the id resolves against the registry to {id, agent, when}.
    expect(r.specialists).toEqual([{ id: "security", agent: "security-reviewer", when: "rules, auth, pagamentos" }]);
    expect(r.guidance).toBe("Consulte query_graph antes de propor arquitetura. CLIs deste passo: graphify-rebuild.");
  });

  it("WS4: a specialist id with NO registry entry is dropped (fail-open, agnostic)", () => {
    const r = resolveToolkit(
      step({ toolkit: { specialists: ["ghost", "security"] } }),
      config(undefined, { security: { agent: "security-reviewer", when: "rules" } }),
      "storymap",
      "/repo",
    );
    expect(r.specialists).toEqual([{ id: "security", agent: "security-reviewer", when: "rules" }]);
  });

  it("joins expect entries with their toolConfig match regex", () => {
    const r = resolveToolkit(
      step({ toolkit: { use: ["codegraph"], expect: [{ tool: "codegraph", level: "expected" }] } }),
      config(CODEGRAPH),
      "storymap",
      "/repo",
    );
    expect(r.expects).toEqual([{ tool: "codegraph", level: "expected", match: "^mcp__graphify__" }]);
  });
});

describe("computeToolGap — expected × used", () => {
  const expected = [{ tool: "codegraph", level: "expected" as const, match: "^mcp__graphify__" }];

  it("flags an expected+unused tool", () => {
    expect(computeToolGap(expected, ["Read", "Bash"])).toEqual(["codegraph"]);
  });

  it("clears when the run DID exercise the tool (match hit)", () => {
    expect(computeToolGap(expected, ["mcp__graphify__query_graph", "Read"])).toEqual([]);
  });

  it("advisory / off levels never contribute to the gap", () => {
    expect(computeToolGap([{ tool: "x", level: "advisory", match: "^mcp__x__" }], ["Read"])).toEqual([]);
    expect(computeToolGap([{ tool: "x", level: "off", match: "^mcp__x__" }], ["Read"])).toEqual([]);
  });

  it("an expected tool with NO match regex can't be verified → not counted (fail-open)", () => {
    expect(computeToolGap([{ tool: "x", level: "expected" }], ["Read"])).toEqual([]);
  });

  it("a malformed match regex is skipped, never thrown", () => {
    expect(computeToolGap([{ tool: "x", level: "expected", match: "(" }], ["Read"])).toEqual([]);
  });
});

describe("lintToolkit (WS3 F2)", () => {
  const cfg = (
    statuses: Partial<StatusDef>[],
    toolConfigs?: BoardConfig["toolConfigs"],
    extra?: Pick<BoardConfig, "routeProfiles" | "specialists">,
  ): Pick<BoardConfig, "id" | "statuses" | "toolConfigs" | "routeProfiles" | "specialists"> => ({
    id: "storymap",
    statuses: statuses as StatusDef[],
    toolConfigs,
    ...extra,
  });

  it("no errors when every toolkit ref resolves and guidance fits", () => {
    const r = lintToolkit(
      cfg([{ id: "plano-tecnico", toolkit: { use: ["codegraph"], expect: [{ tool: "codegraph", level: "expected" }], guidance: "curto" } }], {
        codegraph: { mcp: "storymap/graphify/{board}.json" },
      }),
    );
    expect(r.errors).toEqual([]);
  });

  it("ERRORS on a use/expect referencing a non-existent toolConfig id", () => {
    const r = lintToolkit(cfg([{ id: "s", toolkit: { use: ["ghost"], expect: [{ tool: "phantom", level: "expected" }] } }], { codegraph: {} }));
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join(" ")).toContain("ghost");
    expect(r.errors.join(" ")).toContain("phantom");
  });

  it("ERRORS on guidance longer than the cap", () => {
    const r = lintToolkit(cfg([{ id: "s", toolkit: { guidance: "x".repeat(TOOLKIT_GUIDANCE_MAX + 1) } }]));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("> 300");
  });

  it("WARNS (never errors) on a mcp mount not on disk, expanding {board}", () => {
    const seen: string[] = [];
    const r = lintToolkit(cfg([], { codegraph: { mcp: "storymap/graphify/{board}.json" } }), {
      boardId: "nimbus",
      mcpExists: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen).toEqual(["storymap/graphify/nimbus.json"]); // {board} expanded before the check
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("nimbus.json");
  });

  // ── WS4 lints ────────────────────────────────────────────────────────────────
  it("WS4 ERRORS on dispensable:true on a load-bearing step", () => {
    const r = lintToolkit(cfg([{ id: "desenvolver", name: "Dev", dispensable: true }]));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("LOAD-BEARING");
  });

  it("WS4 ERRORS on a toolkit.specialists id with no registry entry", () => {
    const r = lintToolkit(
      cfg([{ id: "desenvolver", name: "Dev", toolkit: { specialists: ["ghost", "security"] } }], undefined, {
        specialists: { security: { agent: "security-reviewer", when: "x" } },
      }),
    );
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("ghost");
  });

  it("WS4 ERRORS on a routeProfile skip that is unknown / load-bearing / non-dispensable", () => {
    const statuses: Partial<StatusDef>[] = [
      { id: "design-ux", name: "UX", dispensable: true },
      { id: "desenvolver", name: "Dev" },
      { id: "capturar", name: "Cap" },
    ];
    const r = lintToolkit(
      cfg(statuses, undefined, {
        routeProfiles: {
          express: { skips: ["design-ux", "desenvolver", "capturar", "ghost"] },
        },
      }),
    );
    // design-ux ok; desenvolver=load-bearing; capturar=not dispensable; ghost=unknown → 3 errors
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join(" ")).toMatch(/LOAD-BEARING/);
    expect(r.errors.join(" ")).toMatch(/não é dispensável/);
    expect(r.errors.join(" ")).toMatch(/não é um step/);
  });

  it("WS4 WARNS (never errors) on a specialist agent slug with no .claude/agents file", () => {
    const r = lintToolkit(cfg([], undefined, { specialists: { copy: { agent: "conversion-copywriter", when: "x" } } }), {
      agentExists: () => false,
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("conversion-copywriter");
  });
});
