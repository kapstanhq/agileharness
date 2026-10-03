import { describe, expect, it } from "vitest";
import {
  applyActiveProviders,
  buildCapabilityNote,
  computeToolGap,
  expectationApplies,
  expectsForActiveProviders,
  lintToolkit,
  providerChain,
  requiredCapabilities,
} from "./toolkit";
import { GATES } from "./gate-core";
import type { BoardConfig, Card, StatusDef, ToolConfigDef } from "./types";

// The capability contract: DECLARE (toolConfigs.provides/probe/fallback) → PROVE (preflight) → DEGRADE
// (fallback + a note telling the run which route is live). These tests pin the pure half. Each one maps
// to a way the chrome-devtools incident was allowed to happen.

const CONFIGS: Record<string, ToolConfigDef> = {
  browser: {
    mcp: "storymap/qa-mcp.json",
    match: "^mcp__chrome-devtools__",
    provides: "browser",
    probe: "probe-mcp",
    fallback: "browser-script",
  },
  "browser-script": { provides: "browser", probe: "probe-script", cli: "node scripts/visual-sweep.mjs" },
  codegraph: { mcp: "storymap/graphify/{board}.json", match: "^mcp__graphify__" },
};

const board = (statuses: Partial<StatusDef>[], toolConfigs = CONFIGS): Parameters<typeof lintToolkit>[0] =>
  ({ id: "b", statuses: statuses as StatusDef[], toolConfigs }) as unknown as Parameters<typeof lintToolkit>[0];

describe("providerChain", () => {
  it("resolves the chain primary-first and expands {board} in BOTH mount and probe", () => {
    const chain = providerChain("codegraph", { codegraph: { mcp: "g/{board}.json", probe: "check {board}" } }, "acme", "/repo");
    expect(chain[0].mcp).toBe("g/acme.json");
    expect(chain[0].probe).toBe("check acme");
  });

  it("follows fallback transitively", () => {
    expect(providerChain("browser", CONFIGS, "b", "/r").map((p) => p.id)).toEqual(["browser", "browser-script"]);
  });

  it("a CYCLE terminates instead of spinning the resolver", () => {
    const cyclic = { a: { provides: "x", fallback: "b" }, b: { provides: "x", fallback: "a" } };
    expect(providerChain("a", cyclic, "b", "/r").map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("defaults `capability` to the id when `provides` is omitted (back-compat)", () => {
    expect(providerChain("codegraph", CONFIGS, "b", "/r")[0].capability).toBe("codegraph");
  });
});

describe("lintToolkit — the exhaustiveness of PRODUCERS", () => {
  const requiring = (tool: string) => [
    { id: "qa", toolkit: { expect: [{ tool, level: "required" as const }] } },
  ];

  it("ERRORS when a REQUIRED capability has no probeable provider — the zero-producers shape", () => {
    const { errors } = lintToolkit(board(requiring("codegraph")));
    expect(errors.join("\n")).toContain("capacidade DECLARADA sem produtor verificável");
  });

  it("passes when the chain has a probe", () => {
    expect(lintToolkit(board(requiring("browser"))).errors).toEqual([]);
  });

  it("does NOT demand a probe at `expected` level — that level is a soft audit, not a requirement", () => {
    const soft = [{ id: "plan", toolkit: { expect: [{ tool: "codegraph", level: "expected" as const }] } }];
    expect(lintToolkit(board(soft)).errors).toEqual([]);
  });

  it("ERRORS on a fallback that provides a DIFFERENT capability (not interchangeable ⇒ not a fallback)", () => {
    const bad = { a: { provides: "browser", probe: "p", fallback: "b" }, b: { provides: "graph", probe: "p2" } };
    expect(lintToolkit(board([], bad)).errors.join("\n")).toContain("INTERCAMBIÁVEL");
  });

  it("ERRORS on a fallback pointing at a nonexistent toolConfig", () => {
    const bad = { a: { provides: "browser", probe: "p", fallback: "ghost" } };
    expect(lintToolkit(board([], bad)).errors.join("\n")).toContain("inexistente");
  });

  it("ERRORS on a fallback CYCLE", () => {
    const cyclic = { a: { provides: "x", probe: "p", fallback: "b" }, b: { provides: "x", probe: "p", fallback: "a" } };
    expect(lintToolkit(board([], cyclic)).errors.join("\n")).toContain("ciclo de fallback");
  });

  it("ERRORS on a non-positive probeTimeoutMs", () => {
    const bad = { a: { provides: "x", probe: "p", probeTimeoutMs: 0 } };
    expect(lintToolkit(board([], bad)).errors.join("\n")).toContain("probeTimeoutMs");
  });
});

describe("requiredCapabilities — what the preflight enforces", () => {
  const step = (level: "required" | "expected", when?: "uiSurface") =>
    ({ toolkit: { expect: [{ tool: "browser", level, ...(when ? { when } : {}) }] } }) as Pick<StatusDef, "toolkit">;

  it("enforces `required` only — `expected` is never probed", () => {
    expect(requiredCapabilities(step("required"), CONFIGS, "b", "/r")).toHaveLength(1);
    expect(requiredCapabilities(step("expected"), CONFIGS, "b", "/r")).toHaveLength(0);
  });

  it("`when: uiSurface` applies to a UI card and SPARES a card with no screens", () => {
    expect(requiredCapabilities(step("required", "uiSurface"), CONFIGS, "b", "/r", { uiSurface: true })).toHaveLength(1);
    expect(requiredCapabilities(step("required", "uiSurface"), CONFIGS, "b", "/r", { uiSurface: false })).toHaveLength(0);
  });

  it("an UNREADABLE card (uiSurface undefined) does NOT trigger the requirement — never block on a fact we could not read", () => {
    expect(requiredCapabilities(step("required", "uiSurface"), CONFIGS, "b", "/r", {})).toHaveLength(0);
  });

  it("drops a requirement whose whole chain is unprovable — an unenforceable rule must not block a spawn", () => {
    const noProbe = { browser: { provides: "browser", mcp: "x.json" } };
    expect(requiredCapabilities(step("required"), noProbe, "b", "/r")).toHaveLength(0);
  });

  it("expectationApplies: an absent condition applies to every card", () => {
    expect(expectationApplies(undefined, {})).toBe(true);
  });
});

describe("applyActiveProviders — the DEGRADE", () => {
  const choice = (activeId: string, mcp?: string) => [
    { tool: "browser", capability: "browser", active: { id: activeId, ...(mcp ? { mcp } : {}) } },
  ];

  it("leaves mounts untouched when the PRIMARY won", () => {
    expect(applyActiveProviders(["storymap/qa-mcp.json"], choice("browser"), CONFIGS, "b", "/r")).toEqual([
      "storymap/qa-mcp.json",
    ]);
  });

  it("REMOVES the dead primary's mount when a mountless fallback won", () => {
    // Mounting a server whose every tool fails is worse than not mounting it: the agent sees the tools,
    // tries them and burns turns. This is the concrete fix for that.
    expect(applyActiveProviders(["storymap/qa-mcp.json"], choice("browser-script"), CONFIGS, "b", "/r")).toEqual([]);
  });

  it("swaps in the fallback's own mount when it has one", () => {
    expect(applyActiveProviders(["storymap/qa-mcp.json"], choice("other", "alt.json"), CONFIGS, "b", "/r")).toEqual([
      "alt.json",
    ]);
  });

  it("never disturbs mounts of OTHER capabilities", () => {
    const out = applyActiveProviders(["storymap/qa-mcp.json", "g.json"], choice("browser-script"), CONFIGS, "b", "/r");
    expect(out).toEqual(["g.json"]);
  });
});

describe("buildCapabilityNote — the degrade must be VISIBLE to the run", () => {
  it("is null when every primary won (byte-identical prompt on the 99% path)", () => {
    expect(buildCapabilityNote([{ tool: "browser", capability: "browser", active: { id: "browser" } }])).toBeNull();
  });

  it("names the ACTIVE provider and says the primary is NOT mounted", () => {
    const note = buildCapabilityNote([
      { tool: "browser", capability: "browser", active: { id: "browser-script", description: "script Playwright" } },
    ]);
    expect(note).toContain("browser-script");
    expect(note).toContain("script Playwright");
    expect(note).toContain("NÃO está montado");
  });
});

describe("expectsForActiveProviders — the audit must not lie when a fallback is live", () => {
  const expects = [{ tool: "browser", level: "required" as const, match: "^mcp__chrome-devtools__" }];

  it("DROPS an expectation whose live provider has no classifier (unverifiable ⇒ never a gap)", () => {
    const adjusted = expectsForActiveProviders(
      expects,
      [{ tool: "browser", capability: "browser", active: { id: "browser-script" } }],
      CONFIGS,
    );
    expect(adjusted).toEqual([]);
    // …which is what stops a false "provisioned but unused" advisory landing on every card.
    expect(computeToolGap(adjusted, ["Bash", "Read"])).toEqual([]);
  });

  it("re-points the classifier at the live provider when it HAS one", () => {
    const configs = { ...CONFIGS, "browser-script": { ...CONFIGS["browser-script"], match: "^mcp__pw__" } };
    const adjusted = expectsForActiveProviders(
      expects,
      [{ tool: "browser", capability: "browser", active: { id: "browser-script" } }],
      configs,
    );
    expect(adjusted[0].match).toBe("^mcp__pw__");
    expect(computeToolGap(adjusted, ["mcp__pw__screenshot"])).toEqual([]);
    expect(computeToolGap(adjusted, ["Bash"])).toEqual(["browser"]);
  });

  it("leaves the expectation alone when the primary is live", () => {
    const adjusted = expectsForActiveProviders(expects, [{ tool: "browser", capability: "browser", active: { id: "browser" } }], CONFIGS);
    expect(adjusted).toEqual(expects);
  });

  it("`required` participates in the toolGap audit exactly like `expected`", () => {
    expect(computeToolGap(expects, ["Bash"])).toEqual(["browser"]);
  });
});

describe("hasNoBlockers — an INFRA failure is a diagnosis, never a veto", () => {
  const card = (findings: unknown[]) => ({ findings }) as unknown as Card;
  const blocker = (over: Record<string, unknown> = {}) => ({
    id: "f1",
    severity: "blocker",
    status: "open",
    title: "algo",
    ...over,
  });

  it("a product blocker still holds the card", () => {
    expect(GATES.hasNoBlockers.ok(card([blocker()]))).toBe(false);
  });

  it("an `infra` blocker does NOT — no card-level change could ever lift it", () => {
    // This is the incident, exactly: `qa-infra-chrome-devtools-unavailable` parked a card whose code was
    // fine, because the HOST had no browser. The card's real gate (hasQaPassed) is what must hold it.
    expect(GATES.hasNoBlockers.ok(card([blocker({ failureClass: "infra" })]))).toBe(true);
  });

  it("an infra blocker does not mask a REAL one sitting beside it", () => {
    expect(GATES.hasNoBlockers.ok(card([blocker({ failureClass: "infra" }), blocker({ id: "f2" })]))).toBe(false);
  });

  it("`test`/`app` failure classes still block (only the environment class is exempt)", () => {
    expect(GATES.hasNoBlockers.ok(card([blocker({ failureClass: "test" })]))).toBe(false);
    expect(GATES.hasNoBlockers.ok(card([blocker({ failureClass: "app" })]))).toBe(false);
  });
});

describe("the live _base board satisfies its own contract", () => {
  it("lints clean (this is the build-time guard consumers inherit)", async () => {
    const { readBoardConfig } = await import("./repo");
    const { subjectBoards } = await import("./board-fixture");
    for (const board of subjectBoards()) {
      const cfg = (await readBoardConfig(board)) as BoardConfig;
      expect(lintToolkit(cfg).errors, board).toEqual([]);
    }
  });
});
