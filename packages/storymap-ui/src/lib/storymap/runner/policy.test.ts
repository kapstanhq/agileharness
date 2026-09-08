import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { columnFlags } from "./flags";
import {
  DEFAULT_RUNNER_SETTINGS,
  coerceRunnerSettings,
  loadRunnerConfig,
  resolveCardArgs,
  resolveColumnArgs,
} from "./config";
import { coerceStatuses } from "../repo";
import type { Card, StatusDef } from "../types";

// Minimal Card factory — only the fields resolveCardArgs reads (storyType/rice/tasks/severity)
// matter; the rest are filled to satisfy the type. Overrides win.
function makeCard(over: Partial<Card> = {}): Card {
  return {
    id: "story-x",
    type: "story",
    title: "X",
    storyType: "user",
    status: "desenvolver",
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    findings: [],
    order: 10,
    created: null,
    updated: null,
    ...over,
  } as Card;
}

// The `desenvolver` column ships opus/high — the DEFAULT + TETO every card routes within.
const devDef = { id: "desenvolver", name: "Desenvolver", model: "opus", effort: "high" } as StatusDef;

describe("columnFlags — per-column policy → CLI flags", () => {
  it("emits --model/--effort/--max-turns from the column def", () => {
    expect(columnFlags({ model: "opus", effort: "max", maxTurns: 5 }, {})).toEqual([
      "--model",
      "opus",
      "--effort",
      "max",
      "--max-turns",
      "5",
    ]);
  });

  it("falls back to the global defaults when the column is unset", () => {
    expect(columnFlags({}, { model: "sonnet", effort: "medium" })).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
  });

  it("lets the column override a single field (effort still inherited)", () => {
    expect(columnFlags({ model: "haiku" }, { model: "sonnet", effort: "low" })).toEqual([
      "--model",
      "haiku",
      "--effort",
      "low",
    ]);
  });

  it("emits nothing when neither column nor defaults set anything", () => {
    expect(columnFlags({}, {})).toEqual([]);
  });

  it("WS3: NO LONGER emits mcp flags from columnFlags — the MCP mounts moved to the toolkit seam (toolkitFlags, existence-filtered in the engine)", () => {
    // columnFlags now only routes model/effort/max-turns; a column's mcpConfig is absorbed by
    // resolveToolkit + emitted by toolkitFlags (see flags.test.ts). So mcpConfig here is a no-op.
    expect(columnFlags({ model: "sonnet", mcpConfig: "storymap/qa-mcp.json" }, {})).toEqual(["--model", "sonnet"]);
    expect(columnFlags({ mcpConfig: "  " }, {})).toEqual([]);
    expect(columnFlags({}, {})).toEqual([]);
  });
});

describe("coerceStatuses — reads policy fields, drops invalid ones", () => {
  it("reads model/effort/maxTurns/costGuard alongside trigger/gate/autorun", () => {
    const [s] = coerceStatuses([
      {
        id: "enriquecer",
        name: "Enriquecer",
        trigger: "harness-enrich",
        autorun: true,
        model: "haiku",
        effort: "low",
        maxTurns: 8,
        costGuard: true,
      },
    ]);
    expect(s).toMatchObject({
      id: "enriquecer",
      trigger: "harness-enrich",
      autorun: true,
      model: "haiku",
      effort: "low",
      maxTurns: 8,
      costGuard: true,
    });
  });

  it("drops invalid policy values instead of throwing", () => {
    const [s] = coerceStatuses([
      { id: "x", name: "X", model: "gpt-4", effort: "ultra", maxTurns: -3, costGuard: "yes" },
    ]);
    expect(s.model).toBeUndefined();
    expect(s.effort).toBeUndefined();
    expect(s.maxTurns).toBeUndefined();
    expect(s.costGuard).toBeUndefined();
  });

  it("floors a fractional maxTurns to a positive int", () => {
    const [s] = coerceStatuses([{ id: "x", name: "X", maxTurns: 5.9 }]);
    expect(s.maxTurns).toBe(5);
  });

  it("reads the new harness-qa trigger + per-column mcpConfig (trimmed)", () => {
    const [s] = coerceStatuses([
      { id: "qa-automatizado", name: "QA automatizado", trigger: "harness-qa", mcpConfig: "  storymap/qa-mcp.json  " },
    ]);
    expect(s.trigger).toBe("harness-qa");
    expect(s.mcpConfig).toBe("storymap/qa-mcp.json");
  });
});

describe("coerceRunnerSettings — YAML → settings, layered over defaults", () => {
  it("returns the baseline defaults for empty/garbage input", () => {
    expect(coerceRunnerSettings(undefined)).toEqual(DEFAULT_RUNNER_SETTINGS);
    expect(coerceRunnerSettings("nope")).toEqual(DEFAULT_RUNNER_SETTINGS);
  });

  it("merges a partial file over the defaults", () => {
    const s = coerceRunnerSettings({ autorun: { maxConcurrent: 5 } });
    expect(s.autorun.maxConcurrent).toBe(5);
    expect(s.autorun.enabled).toBe(true); // untouched default
    expect(s.autorun.claudeBin).toBe("claude");
  });

  it("accepts extraArgs as a string or an array", () => {
    expect(coerceRunnerSettings({ autorun: { extraArgs: "--verbose --foo" } }).autorun.extraArgs).toEqual([
      "--verbose",
      "--foo",
    ]);
    expect(coerceRunnerSettings({ autorun: { extraArgs: ["--a", "", "--b"] } }).autorun.extraArgs).toEqual([
      "--a",
      "--b",
    ]);
  });

  it("keeps the code-skill watchdog null unless a positive number is given", () => {
    expect(coerceRunnerSettings({ autorun: { timeouts: { doMs: null } } }).autorun.timeouts.doMs).toBeNull();
    expect(coerceRunnerSettings({ autorun: { timeouts: { doMs: "x" } } }).autorun.timeouts.doMs).toBeNull();
    expect(coerceRunnerSettings({ autorun: { timeouts: { doMs: 120000 } } }).autorun.timeouts.doMs).toBe(120000);
  });

  it("reads universalMs, falling back to the default ceiling when absent or invalid (never null)", () => {
    const def = DEFAULT_RUNNER_SETTINGS.autorun.timeouts.universalMs;
    expect(def).toBeGreaterThan(0);
    // present + valid → taken
    expect(
      coerceRunnerSettings({ autorun: { timeouts: { universalMs: 1234567 } } }).autorun.timeouts.universalMs,
    ).toBe(1234567);
    // absent → default (an old config without the field still loads a working watchdog)
    expect(coerceRunnerSettings({ autorun: { timeouts: { doMs: null } } }).autorun.timeouts.universalMs).toBe(def);
    // invalid (0 / non-numeric) → default, never null
    expect(coerceRunnerSettings({ autorun: { timeouts: { universalMs: 0 } } }).autorun.timeouts.universalMs).toBe(def);
    expect(coerceRunnerSettings({ autorun: { timeouts: { universalMs: "nope" } } }).autorun.timeouts.universalMs).toBe(
      def,
    );
  });

  it("drops invalid columnDefaults", () => {
    const cd = coerceRunnerSettings({ columnDefaults: { model: "bogus", effort: "low", maxTurns: 0 } }).columnDefaults;
    expect(cd.model).toBeUndefined();
    expect(cd.effort).toBe("low");
    expect(cd.maxTurns).toBeUndefined(); // 0 is not a positive int
  });
});

describe("resolveColumnArgs — def + global column defaults", () => {
  it("combines a column model with the global default effort", () => {
    const def = { id: "x", name: "X", model: "opus" } as StatusDef;
    const config = { ...DEFAULT_RUNNER_SETTINGS, columnDefaults: { effort: "medium" as const } };
    expect(resolveColumnArgs(def, config)).toEqual(["--model", "opus", "--effort", "medium"]);
  });
});

describe("resolveCardArgs — card complexity routes within the column ceiling", () => {
  it("AC1: a chore with no tasks resolves to --model sonnet --effort medium (column opus/high ignored)", () => {
    expect(resolveCardArgs(makeCard({ storyType: "chore", tasks: [] }), devDef, DEFAULT_RUNNER_SETTINGS)).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
  });

  it("AC2: a big, broad card (rice.effort 3, 5 tasks) keeps the column opus/high", () => {
    const card = makeCard({
      storyType: "technical",
      rice: { reach: null, impact: null, confidence: null, effort: 3 },
      tasks: [
        { id: "a", title: "", done: false },
        { id: "b", title: "", done: false },
        { id: "c", title: "", done: false },
        { id: "d", title: "", done: false },
        { id: "e", title: "", done: false },
      ],
    });
    expect(resolveCardArgs(card, devDef, DEFAULT_RUNNER_SETTINGS)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  it("AC3: a sonnet column ceiling caps an Opus-signalling card back to sonnet", () => {
    const sonnetDef = { id: "x", name: "X", model: "sonnet", effort: "high" } as StatusDef;
    const card = makeCard({
      storyType: "technical",
      rice: { reach: null, impact: null, confidence: null, effort: 5 },
      tasks: Array.from({ length: 6 }, (_, i) => ({ id: String(i), title: "", done: false })),
    });
    expect(resolveCardArgs(card, sonnetDef, DEFAULT_RUNNER_SETTINGS)).toEqual(["--model", "sonnet", "--effort", "high"]);
  });

  it("AC4: a card with no complexity signal falls through to the column default unchanged", () => {
    const card = makeCard({
      storyType: "user",
      rice: { reach: null, impact: null, confidence: null, effort: 1 },
      tasks: [{ id: "a", title: "", done: false }],
    });
    expect(resolveCardArgs(card, devDef, DEFAULT_RUNNER_SETTINGS)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  it("uses the global columnDefaults as the ceiling when the column itself is unset", () => {
    // No model/effort on the column → the ceiling is the global default (sonnet/medium). A chore
    // resolves to sonnet/medium; the size branch would also cap to sonnet there.
    const bareDef = { id: "x", name: "X" } as StatusDef;
    const config = { ...DEFAULT_RUNNER_SETTINGS, columnDefaults: { model: "sonnet" as const, effort: "medium" as const } };
    expect(resolveCardArgs(makeCard({ storyType: "chore" }), bareDef, config)).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
  });

  it("SCALES maxTurns by card size (story-9s52tu HALF A): a small card → lean baseline, ceiling = the column maxTurns", () => {
    // story-9s52tu HALF A: the column maxTurns (80) is now the CEILING, not a fixed value. A SMALL
    // card (chore, no rice.effort, 0 tasks → size score 0) gets the lean baseline (40), well under the
    // ceiling. model/effort still route by complexity (chore → sonnet/medium). (The OLD behavior emitted
    // --max-turns 80 verbatim; the lean budget is the new contract.) WS3: mcp flags no longer ride here —
    // they moved to the toolkit seam (resolveCardArgs is model/effort/max-turns only now).
    const def = { id: "qa", name: "QA", model: "opus", effort: "high", maxTurns: 80, mcpConfig: "storymap/qa-mcp.json" } as StatusDef;
    expect(resolveCardArgs(makeCard({ storyType: "chore" }), def, DEFAULT_RUNNER_SETTINGS)).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--max-turns",
      "40",
    ]);
  });

  // ── WS-7 §7.2/§7.3 — the `mechanical` route reaching the SPAWN FLAGS ───────────────────────────
  // AC1 of WS-7: a run on the mechanical profile spawns sonnet/medium/lean-turns. The profile lives in
  // _base/board.yaml and is MATERIALIZED onto the card's `routing` by setCardRouteAction (4.2 —
  // setcardroute-materialize.test.ts pins that half, including "explicit human caps override the
  // profile's"); resolveCardArgs is where those caps become the actual CLI flags. Nothing here knows the
  // word "mechanical" — the caps arrive as data, which is the point (D10: no 4th door).
  const mechanicalRouting = {
    skips: [],
    decidedBy: "agent",
    decidedAt: "2026-07-16",
    profile: "mechanical",
    modelCap: "sonnet",
    effortCap: "medium",
  } as Card["routing"];

  it("WS-7 AC1: a mechanical card spawns --model sonnet --effort medium --max-turns 40 on an opus/high/220 column", () => {
    // The storymap `desenvolver` ceiling (220) is the harshest column in the repo — a resolution run there
    // still comes out lean, and the 40 is the size baseline, NOT a knob on the profile.
    const bigCeilingDef = { id: "desenvolver", name: "Desenvolver", model: "opus", effort: "high", maxTurns: 220 } as StatusDef;
    expect(resolveCardArgs(makeCard({ routing: mechanicalRouting }), bigCeilingDef, DEFAULT_RUNNER_SETTINGS)).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
      "--max-turns",
      "40",
    ]);
  });

  it("WS-7 AC1: the mechanical caps survive the size branch (a big card's resolution never spawns opus)", () => {
    const card = makeCard({
      routing: mechanicalRouting,
      rice: { reach: null, impact: null, confidence: null, effort: 5 },
      tasks: Array.from({ length: 8 }, (_, i) => ({ id: String(i), title: "", done: false })),
    });
    // model/effort are held at the cap; the turn budget DOES scale with the card's size (the caps bound the
    // tier, not the leash) — pinned so the WS-10 spawn's duty to pass size-neutral signals stays visible.
    expect(resolveCardArgs(card, devDef, DEFAULT_RUNNER_SETTINGS)).toEqual(["--model", "sonnet", "--effort", "medium"]);
  });

  it("WS-7 §7.3: an explicit human cap on the card OVERRIDES the profile's (the stamped caps are what spawn)", () => {
    // setCardRouteAction resolves `input.modelCap ?? profile.modelCap` at STAMP time, so a human who
    // insisted on haiku/low is what sits on the card — and the spawn honors the card, not the profile label.
    const humanOverride = { ...mechanicalRouting!, decidedBy: "human", modelCap: "haiku", effortCap: "low" } as Card["routing"];
    expect(resolveCardArgs(makeCard({ routing: humanOverride }), devDef, DEFAULT_RUNNER_SETTINGS)).toEqual([
      "--model",
      "haiku",
      "--effort",
      "low",
    ]);
  });

  it("reads the bug severity off bugReport when the first-class field is unset (no crash, routes normally)", () => {
    const card = makeCard({ storyType: "bug", severity: null, bugReport: { brief: "x", severity: "high", expected: null, actual: null, steps: [], target: null, screenshot: null, openedAt: null } });
    // bug + no size signal → column default (severity is reserved, doesn't change the tier yet)
    expect(resolveCardArgs(card, devDef, DEFAULT_RUNNER_SETTINGS)).toEqual(["--model", "opus", "--effort", "high"]);
  });
});

describe("loadRunnerConfig — ENV always wins over the file", () => {
  const ENV_KEYS = ["USM_AUTORUN", "USM_AUTORUN_MAX"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("USM_AUTORUN=0 forces enabled false", () => {
    process.env.USM_AUTORUN = "0";
    expect(loadRunnerConfig().autorun.enabled).toBe(false);
  });

  it("USM_AUTORUN_MAX overrides the file/default concurrency", () => {
    process.env.USM_AUTORUN_MAX = "7";
    expect(loadRunnerConfig().autorun.maxConcurrent).toBe(7);
  });
});
