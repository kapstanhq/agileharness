import { describe, expect, it } from "vitest";
import { coerceStatuses, coerceToolkit, coerceToolConfigs, coerceBoardDeploy } from "./repo";
import { boardDeployConfigShape } from "./contracts";

// coerceStatuses parses board.yaml's `statuses` — the pipeline topology for a whole
// app board. A bad parse (dropped gate/trigger, accepted garbage enum) breaks gate
// enforcement or autorun for every card on that board. Tolerant by design: invalid
// per-column values are DROPPED, never thrown.
describe("coerceStatuses", () => {
  it("returns [] for a non-array / missing input", () => {
    expect(coerceStatuses(undefined)).toEqual([]);
    expect(coerceStatuses(null)).toEqual([]);
    expect(coerceStatuses("nope")).toEqual([]);
  });

  it("drops entries with no id, and defaults name to id", () => {
    const out = coerceStatuses([{ name: "sem id" }, { id: "a" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", name: "a" });
  });

  it("reads gate + trigger, and DROPS invalid gate/trigger ids", () => {
    const [ok] = coerceStatuses([{ id: "s", gate: "hasTasks", trigger: "harness-tasks" }]);
    expect(ok.gate).toBe("hasTasks");
    expect(ok.trigger).toBe("harness-tasks");
    const [bad] = coerceStatuses([{ id: "s", gate: "hasBogus", trigger: "harness-bogus" }]);
    expect(bad.gate).toBeUndefined();
    expect(bad.trigger).toBeUndefined();
  });

  it("keeps valid model/effort and drops invalid ones", () => {
    const [ok] = coerceStatuses([{ id: "s", model: "opus", effort: "high" }]);
    expect(ok.model).toBe("opus");
    expect(ok.effort).toBe("high");
    const [bad] = coerceStatuses([{ id: "s", model: "gpt", effort: "turbo" }]);
    expect(bad.model).toBeUndefined();
    expect(bad.effort).toBeUndefined();
  });

  it("floors a positive maxTurns and drops non-positive / non-finite", () => {
    expect(coerceStatuses([{ id: "s", maxTurns: 7.9 }])[0].maxTurns).toBe(7);
    expect(coerceStatuses([{ id: "s", maxTurns: 0 }])[0].maxTurns).toBeUndefined();
    expect(coerceStatuses([{ id: "s", maxTurns: -3 }])[0].maxTurns).toBeUndefined();
    expect(coerceStatuses([{ id: "s", maxTurns: "x" }])[0].maxTurns).toBeUndefined();
  });

  it("accepts autorun / terminal / costGuard only as real booleans", () => {
    const [ok] = coerceStatuses([{ id: "s", autorun: true, terminal: true, costGuard: true }]);
    expect(ok.autorun).toBe(true);
    expect(ok.terminal).toBe(true);
    expect(ok.costGuard).toBe(true);
    const [bad] = coerceStatuses([{ id: "s", autorun: "true", terminal: 1, costGuard: "yes" }]);
    expect(bad.autorun).toBeUndefined();
    expect(bad.terminal).toBeUndefined();
    expect(bad.costGuard).toBeUndefined();
  });

  // `delivered` ("no ar") is read by deliveredIndex to describe what the product ALREADY DOES.
  // coerceStatuses is an explicit ALLOW-LIST ("dropped on read unless mapped here"), so a field added
  // to types + Zod but not here reads back as undefined — the facet is declared in board.yaml and
  // silently inert. That is exactly what happened while building this: the golden showed
  // `delivered: true` and the index still came back EMPTY. Fail-closed made it a silent zero, not a
  // crash, which is why it needs a test and not just a comment.
  it("preserves the `delivered` facet — and only as a real `true`", () => {
    expect(coerceStatuses([{ id: "s", terminal: true, delivered: true }])[0].delivered).toBe(true);
    // fail-closed: anything that is not exactly true means "do not assert this shipped"
    expect(coerceStatuses([{ id: "s", delivered: "true" }])[0].delivered).toBeUndefined();
    expect(coerceStatuses([{ id: "s", delivered: 1 }])[0].delivered).toBeUndefined();
    expect(coerceStatuses([{ id: "s", delivered: false }])[0].delivered).toBeUndefined();
    expect(coerceStatuses([{ id: "s", terminal: true }])[0].delivered).toBeUndefined();
  });

  it("trims mcpConfig and drops an empty/whitespace one", () => {
    expect(coerceStatuses([{ id: "s", mcpConfig: "  qa-mcp.json  " }])[0].mcpConfig).toBe("qa-mcp.json");
    expect(coerceStatuses([{ id: "s", mcpConfig: "   " }])[0].mcpConfig).toBeUndefined();
  });

  // WS3 (F2) — the toolkit facet round-trips through coerceStatuses.
  it("reads a full toolkit facet with stable shape, dropping off-level expect entries", () => {
    const [s] = coerceStatuses([
      {
        id: "plano-tecnico",
        toolkit: {
          use: ["codegraph", ""],
          expect: [
            { tool: "codegraph", level: "expected" },
            { tool: "x", level: "bogus" }, // dropped — invalid level
            { tool: "", level: "advisory" }, // dropped — empty tool
          ],
          guidance: "  Consulte o grafo antes.  ",
          allowedTools: ["Read", "Bash"],
          specialists: ["security-reviewer"],
        },
      },
    ]);
    expect(s.toolkit).toEqual({
      use: ["codegraph"],
      expect: [{ tool: "codegraph", level: "expected" }],
      guidance: "Consulte o grafo antes.",
      allowedTools: ["Read", "Bash"],
      specialists: ["security-reviewer"],
    });
  });

  it("omits the toolkit field entirely when empty / off-shape", () => {
    expect(coerceStatuses([{ id: "s", toolkit: {} }])[0].toolkit).toBeUndefined();
    expect(coerceStatuses([{ id: "s", toolkit: "nope" }])[0].toolkit).toBeUndefined();
    expect(coerceStatuses([{ id: "s" }])[0].toolkit).toBeUndefined();
    // an expect-only toolkit whose entries are ALL invalid collapses to undefined (no empty {})
    expect(coerceStatuses([{ id: "s", toolkit: { expect: [{ tool: "", level: "off" }] } }])[0].toolkit).toBeUndefined();
  });

  it("coerceToolkit is directly callable and drops empty use/allowedTools/specialists arrays", () => {
    expect(coerceToolkit({ use: [], allowedTools: [], specialists: [] })).toBeUndefined();
    expect(coerceToolkit({ use: ["a"] })).toEqual({ use: ["a"] });
  });
});

describe("coerceToolConfigs (WS3 F2)", () => {
  it("reads mount/match/cli/description per id, trimming, dropping empties", () => {
    expect(
      coerceToolConfigs({
        codegraph: { mcp: "  storymap/graphify/{board}.json  ", match: "^mcp__graphify__", description: "grafo" },
        empty: {},
        bad: "nope",
      }),
    ).toEqual({
      codegraph: { mcp: "storymap/graphify/{board}.json", match: "^mcp__graphify__", description: "grafo" },
      empty: {},
    });
  });

  it("returns undefined for a non-record / empty input (so the board omits the field)", () => {
    expect(coerceToolConfigs(undefined)).toBeUndefined();
    expect(coerceToolConfigs([])).toBeUndefined();
    expect(coerceToolConfigs({})).toBeUndefined();
  });

  // Este coerce é o que PERSISTE o board: um campo que ele não conhecesse seria apagado na próxima
  // gravação, e a declaração sumiria sem ninguém notar. `outsideRunSandbox` é a quarta perna do contrato
  // de capacidade — declara que o provedor trabalha fora da jaula do run — e sem esta prova ela seria
  // exatamente o tipo de campo que atravessa a revisão e morre no primeiro save.
  it("preserva `outsideRunSandbox` — só o literal true, e nada mais liga", () => {
    expect(coerceToolConfigs({ browser: { provides: "browser", outsideRunSandbox: true } })).toEqual({
      browser: { provides: "browser", outsideRunSandbox: true },
    });
    // Booleano: NÃO segue o trim-and-drop das strings. Qualquer coisa que não seja `true` deixa o campo
    // FORA — o default seguro, em que um provedor sem declaração continua sendo sondado como sempre foi.
    for (const v of [false, "true", 1, "", null, undefined, "sim"]) {
      const out = coerceToolConfigs({ browser: { provides: "browser", outsideRunSandbox: v } });
      expect(out?.browser.outsideRunSandbox, `valor ${JSON.stringify(v)} não deveria ligar`).toBeUndefined();
    }
  });

  it("reads the stage `column` grouping and trims it, dropping empty", () => {
    expect(coerceStatuses([{ id: "s", column: "  backlog  " }])[0].column).toBe("backlog");
    expect(coerceStatuses([{ id: "s", column: "   " }])[0].column).toBeUndefined();
    expect(coerceStatuses([{ id: "s" }])[0].column).toBeUndefined();
  });

  it("reads skipForTypes, keeping only valid storyTypes and dropping the rest", () => {
    const [ok] = coerceStatuses([{ id: "s", skipForTypes: ["technical", "bug", "garbage", 7] }]);
    expect(ok.skipForTypes).toEqual(["technical", "bug"]);
    // all-invalid → field omitted entirely (not an empty array)
    expect(coerceStatuses([{ id: "s", skipForTypes: ["nope"] }])[0].skipForTypes).toBeUndefined();
    expect(coerceStatuses([{ id: "s", skipForTypes: "technical" }])[0].skipForTypes).toBeUndefined();
    expect(coerceStatuses([{ id: "s" }])[0].skipForTypes).toBeUndefined();
  });
});

// coerceBoardDeploy parses board.yaml's `deploy` DESCRIPTOR. It hand-maintains a field allow-list that MUST
// stay in lockstep with BoardDeployConfigSchema — a field the schema declares but the coercer forgets is
// dropped SILENTLY on read (deploy is optional, so not even the drift alarm fires), leaving the capability
// DECLARED-BUT-INERT. That is exactly how deploy.surfaces went inert and tripped the release out-of-scope
// revert. These pin the surfaces coercion AND guard the whole class via a schema↔coercer exhaustiveness check.
describe("coerceBoardDeploy", () => {
  it("returns undefined for a non-object / empty descriptor", () => {
    expect(coerceBoardDeploy(undefined)).toBeUndefined();
    expect(coerceBoardDeploy("nope")).toBeUndefined();
    expect(coerceBoardDeploy({})).toBeUndefined();
    expect(coerceBoardDeploy({ bogus: 1 })).toBeUndefined();
  });

  it("coerces deployable surfaces (prefix + optional deployCmd), tolerant on shape, strict on values", () => {
    const out = coerceBoardDeploy({
      surfaces: [
        { prefix: "tools/web-terminal/", deployCmd: "just sync-web-terminal" },
        { prefix: "  tools/x/  " }, // trimmed, deployCmd omitted
        { prefix: "" }, // dropped — empty prefix (schema min(1))
        { deployCmd: "just y" }, // dropped — no prefix
        "garbage", // dropped — not an object
      ],
    });
    expect(out?.surfaces).toEqual([
      { prefix: "tools/web-terminal/", deployCmd: "just sync-web-terminal" },
      { prefix: "tools/x/" },
    ]);
  });

  it("drops a non-array or all-invalid surfaces (never throws → empty descriptor)", () => {
    expect(coerceBoardDeploy({ surfaces: "nope" })).toBeUndefined();
    expect(coerceBoardDeploy({ surfaces: [{ prefix: "" }] })).toBeUndefined();
  });

  // THE LOCKSTEP GUARD (kills the bug class): a fully-valid descriptor with one value per schema field must
  // round-trip EVERY field through the coercer. Add a field to boardDeployConfigShape without teaching the
  // coercer and this reds — the "declared but inert" regression can never ship silently again.
  it("preserves EVERY field BoardDeployConfigSchema declares (schema↔coercer lockstep)", () => {
    const full: Record<string, unknown> = {
      kind: "command",
      command: "just deploy",
      description: "como este app é publicado",
      healthUrl: "https://x/health",
      canaryCommand: "just canary",
      timeoutMinutes: 20,
      surfaces: [{ prefix: "tools/web-terminal/", deployCmd: "just sync-web-terminal" }],
    };
    const out = coerceBoardDeploy(full) ?? {};
    for (const field of Object.keys(boardDeployConfigShape)) {
      expect(
        out,
        `coerceBoardDeploy DROPS the schema field "${field}" — it must coerce every declared field`,
      ).toHaveProperty(field);
    }
  });
});
