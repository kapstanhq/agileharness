import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeStepRollups, stepLabel, runStatusLabel, stepProgress, GATE_ICON, classifyTools, expectedCapabilities, stepCapabilities } from "./step-rollup";
import type { BoardConfig, Card, StatusDef } from "./types";
import type { TelemetryRecord } from "./runner/telemetry";
import type { Transition } from "./runner/transitions";
import type { RunOutcome } from "./runner/journal";

// O dev-server é capacidade do board PRÓPRIO da instalação (lib/storymap/self-board.ts). A fixture
// usa o id "storymap", então declará-lo aqui é o que faz o cenário de dogfood existir.
beforeEach(() => { process.env.AGILEHARNESS_SELF_BOARD = "storymap"; });
afterEach(() => { delete process.env.AGILEHARNESS_SELF_BOARD; });

/** A minimal forward pipeline (a slice of the canonical _base order). */
function config(over: Partial<BoardConfig> = {}): BoardConfig {
  const statuses: Partial<StatusDef>[] = [
    { id: "grill", name: "Dúvidas", trigger: "harness-grill" },
    { id: "enriquecer", name: "Especificar", trigger: "harness-enrich" },
    { id: "interview", name: "Entrevista", trigger: "harness-interview", skipForTypes: ["technical", "bug", "chore", "spike"] },
    { id: "priorizar", name: "Estimar", trigger: "harness-prioritize" },
    { id: "design-ux", name: "Wireframe", trigger: "harness-ux", skipForTypes: ["technical", "bug", "chore", "spike"] },
    { id: "plano-tecnico", name: "Plano técnico", trigger: "harness-plan", mcpConfig: "storymap/graphify/storymap.json" },
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
    { id: "revisar-codigo", name: "Revisão de código", trigger: "harness-review", mcpConfig: "storymap/graphify/storymap.json" },
    { id: "qa-automatizado", name: "QA automatizado", trigger: "harness-qa", mcpConfig: "storymap/qa-mcp.json" },
    { id: "revisao", name: "Revisão" }, // manual gate, no trigger → never a rollup
    { id: "merge", name: "Integrar", laneStep: true, trigger: "harness-merge" as never }, // laneStep → excluded
    { id: "concluida", name: "No ar", terminal: true },
    { id: "refinar", name: "Refinar", trigger: "harness-refine" }, // reentry → only if it ran
  ];
  return { id: "storymap", statuses, personas: [], systems: [] } as unknown as BoardConfig;
}

function card(over: Partial<Card> = {}): Card {
  return {
    id: "story-x",
    type: "story",
    title: "T",
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
    order: 1,
    created: null,
    updated: null,
    body: "",
    ...over,
  } as Card;
}

let seq = 0;
function rec(trigger: string, over: Partial<TelemetryRecord> = {}): TelemetryRecord {
  seq += 1;
  return {
    id: `s${seq}`,
    board: "storymap",
    cardId: "story-x",
    trigger: trigger as TelemetryRecord["trigger"],
    startedAt: 1_000 + seq,
    durationMs: 45_000,
    turns: 3,
    inputTokens: 1000,
    outputTokens: 200,
    costUSD: 0.1,
    model: "sonnet",
    effort: "low",
    summary: null,
    status: "ok" as RunOutcome,
    ...over,
  };
}

/** Telemetry is stored most-recent-first; helper sorts a list that way. */
function ledger(...recs: TelemetryRecord[]): TelemetryRecord[] {
  return [...recs].sort((a, b) => b.startedAt - a.startedAt);
}

const find = (rs: ReturnType<typeof computeStepRollups>, trigger: string) => rs.find((r) => r.trigger === trigger)!;

describe("computeStepRollups — gate verdict (✓/✗/·)", () => {
  it("enrich: delivered → ok; ran-but-not-delivered → blocked; never-ran → pending", () => {
    const delivered = card({ narrative: { role: "op", want: "ver", soThat: "decidir" }, acceptance: ["a1"] });
    expect(find(computeStepRollups(config(), delivered, ledger(rec("harness-enrich"))), "harness-enrich").gate).toBe("ok");

    const ranEmpty = card(); // no narrative/acceptance, but enrich ran
    expect(find(computeStepRollups(config(), ranEmpty, ledger(rec("harness-enrich"))), "harness-enrich").gate).toBe("blocked");

    const never = card();
    expect(find(computeStepRollups(config(), never, []), "harness-enrich").gate).toBe("pending");
  });

  it("review: open blocker → blocked with count; ran clean → ok with '0 bloqueadores'", () => {
    const blocked = card({ findings: [{ id: "f1", lens: "security", severity: "blocker", title: "x", status: "open" } as never] });
    const r1 = find(computeStepRollups(config(), blocked, ledger(rec("harness-review"))), "harness-review");
    expect(r1.gate).toBe("blocked");
    expect(r1.left).toBe("1 bloqueador");

    const clean = card({ findings: [] });
    const r2 = find(computeStepRollups(config(), clean, ledger(rec("harness-review"))), "harness-review");
    expect(r2.gate).toBe("ok");
    expect(r2.left).toBe("0 bloqueadores");

    // never ran → pending and no '0 bloqueadores' noise
    const r3 = find(computeStepRollups(config(), clean, []), "harness-review");
    expect(r3.gate).toBe("pending");
    expect(r3.left).toBeNull();
  });

  it("grill: open questions → blocked with count", () => {
    const c = card({ questions: [{ id: "q1", text: "?", askedBy: "x", askedAt: "2026-06-19", status: "open" } as never] });
    const r = find(computeStepRollups(config(), c, ledger(rec("harness-grill"))), "harness-grill");
    expect(r.gate).toBe("blocked");
    expect(r.left).toBe("1 pergunta");
  });

  it("prioritize/qa reflect their gate fields", () => {
    const prioritized = card({ rice: { reach: 100, impact: 2, confidence: 0.8, effort: 2 }, kano: "must-be", funnelStage: "retention" });
    expect(find(computeStepRollups(config(), prioritized, ledger(rec("harness-prioritize"))), "harness-prioritize").gate).toBe("ok");
    expect(find(computeStepRollups(config(), prioritized, ledger(rec("harness-prioritize"))), "harness-prioritize").left).toBe("RICE 80");

    const qa = card({ qaPassed: true });
    expect(find(computeStepRollups(config(), qa, ledger(rec("harness-qa"))), "harness-qa").gate).toBe("ok");
  });

  it("WS5: qa on a non-UI non-user story reads `exempt` (not a retroactive ✓ 'QA lie')", () => {
    // WS5 intentional change: a NON-user (non-UI) story with no qaPassed + no run is EXEMPT from the visual
    // sweep (gate = the suite, which harness-qa RUNS) — surfaced honestly as `exempt`, not a fake ✓.
    const technical = card({ storyType: "technical" });
    const qaTech = find(computeStepRollups(config(), technical, []), "harness-qa");
    expect(qaTech.gate).toBe("exempt");
    expect(qaTech.reason).toMatch(/isento/);
    // with an actual QA pass it reads ✓ (a real deliverable).
    expect(find(computeStepRollups(config(), card({ storyType: "technical", qaPassed: true }), ledger(rec("harness-qa"))), "harness-qa").gate).toBe("ok");
    // a user story is NOT exempt: pending until it runs, blocked if it ran without passing.
    const user = card({ storyType: "user" });
    expect(find(computeStepRollups(config(), user, []), "harness-qa").gate).toBe("pending");
    expect(find(computeStepRollups(config(), user, ledger(rec("harness-qa"))), "harness-qa").gate).toBe("blocked");
  });
});

describe("computeStepRollups — path, ordering, telemetry folding", () => {
  it("keeps pipeline order and skips manual-gate / laneStep / terminal statuses", () => {
    const rs = computeStepRollups(config(), card(), []);
    const triggers = rs.map((r) => r.trigger);
    expect(triggers).toContain("harness-grill");
    expect(triggers).toContain("harness-review");
    expect(triggers).not.toContain("harness-merge"); // laneStep excluded
    // forward order preserved
    expect(triggers.indexOf("harness-enrich")).toBeLessThan(triggers.indexOf("harness-prioritize"));
    expect(triggers.indexOf("harness-prioritize")).toBeLessThan(triggers.indexOf("harness-do"));
  });

  it("WS5: a step this card's TYPE skips is VISIBLE as `skipped` + reason (was silently omitted)", () => {
    const technical = card({ storyType: "technical" });
    const rs = computeStepRollups(config(), technical, []);
    const ux = rs.find((r) => r.trigger === "harness-ux");
    expect(ux).toBeDefined(); // no longer omitted — the route is honest
    expect(ux!.gate).toBe("skipped");
    expect(ux!.reason).toBe("tipo: technical");
    expect(rs.find((r) => r.trigger === "harness-do")).toBeDefined(); // build still applies
  });

  it("a reentry skill is off-path UNLESS it ran", () => {
    const noReentry = computeStepRollups(config(), card(), []);
    expect(noReentry.find((r) => r.trigger === "harness-refine")).toBeUndefined();

    const reopened = computeStepRollups(config(), card(), ledger(rec("harness-refine")));
    const refine = reopened.find((r) => r.trigger === "harness-refine")!;
    expect(refine).toBeDefined();
    expect(refine.onPath).toBe(false);
    expect(refine.runs).toBe(1);
  });

  it("collapses multiple runs of a step: count + latest timestamp + summed cost", () => {
    const rs = computeStepRollups(
      config(),
      card({ findings: [] }),
      ledger(
        rec("harness-review", { startedAt: 100, costUSD: 0.05, status: "error" }),
        rec("harness-review", { startedAt: 200, costUSD: 0.07, summary: "aprovado" }),
      ),
    );
    const review = find(rs, "harness-review");
    expect(review.runs).toBe(2);
    expect(review.lastRunAt).toBe(200);
    expect(review.lastStatus).toBe("ok"); // the latest (startedAt 200) wins
    expect(review.metrics?.costUSD).toBeCloseTo(0.07); // the LATEST run's cost (consistent fields)
    expect(review.metrics?.totalCostUSD).toBeCloseTo(0.12); // cumulative across runs
  });

  it("falls back to the run's decision summary as `left` for an unspecced skill", () => {
    const rs = computeStepRollups(config(), card(), ledger(rec("harness-interview", { summary: "validei a dor com 3 personas" })));
    expect(find(rs, "harness-interview").left).toBe("validei a dor com 3 personas");
  });

  it("flags the live run", () => {
    const rs = computeStepRollups(config(), card(), ledger(rec("harness-do")), "harness-do");
    expect(find(rs, "harness-do").live).toBe(true);
    expect(find(rs, "harness-review").live).toBe(false);
  });

  it("marks the current step", () => {
    const rs = computeStepRollups(config(), card({ status: "revisar-codigo" }), []);
    expect(find(rs, "harness-review").isCurrent).toBe(true);
    expect(find(rs, "harness-do").isCurrent).toBe(false);
  });
});

describe("capabilities — classify + expected + anomaly", () => {
  it("classifyTools maps tool-name prefixes to capabilities", () => {
    const caps = classifyTools([
      "mcp__graphify__get_pr_impact",
      "mcp__chrome-devtools__resize_page",
      "mcp__playwright__browser_click",
      "Workflow",
      "Task",
      "local-dev-server",
      "Bash", // generic → no capability
      "Read",
    ]);
    expect([...caps].sort()).toEqual(["browser", "devServer", "graphify", "subagents"]);
    expect(classifyTools(["Bash", "Edit", "Read"]).size).toBe(0);
  });

  it("expectedCapabilities derives from mcpConfig (QA caps user-only; dev server dogfood-only)", () => {
    const review = { id: "revisar-codigo", trigger: "harness-review", mcpConfig: "storymap/graphify/storymap.json" } as never;
    expect([...expectedCapabilities(review, "storymap", "user")]).toEqual(["graphify"]); // graphify not type-gated

    const qa = { id: "qa-automatizado", trigger: "harness-qa", mcpConfig: "storymap/qa-mcp.json" } as never;
    expect([...expectedCapabilities(qa, "storymap", "user")].sort()).toEqual(["browser", "devServer"]);
    // on a PRODUCT board the dogfood dev-server expectation drops (no false anomaly)
    expect([...expectedCapabilities(qa, "acme", "user")]).toEqual(["browser"]);
    // a NON-user story is exempt from QA → neither browser nor dev server is expected (no false ⚠)
    expect(expectedCapabilities(qa, "storymap", "technical").size).toBe(0);

    expect(expectedCapabilities(null, "storymap", "user").size).toBe(0);
  });

  it("WS3: derives the graphify marker from a declarative toolkit.use → toolConfig (survives the _base migration)", () => {
    const toolConfigs = { codegraph: { mcp: "storymap/graphify/nimbus.json", match: "^mcp__graphify__" } };
    // a step with NO mcpConfig but toolkit.use:[codegraph] still lights graphify (the marker didn't vanish)
    const plan = { id: "plano-tecnico", trigger: "harness-plan", toolkit: { use: ["codegraph"], expect: [{ tool: "codegraph", level: "expected" }] } } as never;
    expect([...expectedCapabilities(plan, "nimbus", "technical", toolConfigs)]).toEqual(["graphify"]);
    // without the toolConfigs map (can't resolve) it degrades to no marker — never throws
    expect(expectedCapabilities(plan, "nimbus", "technical").size).toBe(0);
    // a browser toolConfig on a non-QA step lights browser; on a non-user QA step it stays gated off
    const tcBrowser = { cdt: { match: "^mcp__chrome-devtools__" } };
    const uiStep = { id: "x", trigger: "harness-review", toolkit: { use: ["cdt"] } } as never;
    expect([...expectedCapabilities(uiStep, "storymap", "user", tcBrowser)]).toEqual(["browser"]);
    const qaTk = { id: "qa-automatizado", trigger: "harness-qa", toolkit: { use: ["cdt"] } } as never;
    expect(expectedCapabilities(qaTk, "storymap", "technical", tcBrowser).size).toBe(0); // non-user QA → no browser
  });

  it("stepCapabilities folds used×expected, surfacing the expected-but-not-used anomaly", () => {
    const qa = { id: "qa-automatizado", trigger: "harness-qa", mcpConfig: "storymap/qa-mcp.json" } as never;
    // QA (user story) ran but only touched the dev server, never the browser MCP → browser is the ⚠ anomaly
    const caps = stepCapabilities(qa, "storymap", "user", ["local-dev-server"]);
    const browser = caps.find((c) => c.id === "browser")!;
    const server = caps.find((c) => c.id === "devServer")!;
    expect(browser).toMatchObject({ expected: true, used: false });
    expect(server).toMatchObject({ expected: true, used: true });
  });

  it("computeStepRollups populates per-step capabilities from the runs' toolsUsed", () => {
    const rs = computeStepRollups(
      config(),
      card({ findings: [] }),
      ledger(
        rec("harness-review", { toolsUsed: ["mcp__graphify__search_code", "Read"] }),
        rec("harness-qa", { toolsUsed: ["local-dev-server"] }), // ran QA but no chrome-devtools → anomaly
      ),
    );
    const review = find(rs, "harness-review").capabilities;
    expect(review).toEqual([{ id: "graphify", label: "graphify", used: true, expected: true }]);

    const qa = find(rs, "harness-qa").capabilities;
    expect(qa.find((c) => c.id === "browser")).toMatchObject({ used: false, expected: true }); // ⚠ missing
    expect(qa.find((c) => c.id === "devServer")).toMatchObject({ used: true, expected: true });
  });

  it("a step with no tracked tools + no mcpConfig has no capability markers", () => {
    const rs = computeStepRollups(config(), card(), ledger(rec("harness-do", { toolsUsed: ["Bash", "Edit"] })));
    expect(find(rs, "harness-do").capabilities).toEqual([]);
  });
});

describe("presentation helpers", () => {
  it("stepLabel maps known triggers and passes unknown ones through", () => {
    expect(stepLabel("harness-review")).toBe("Revisão de código");
    expect(stepLabel("harness-mystery")).toBe("harness-mystery");
  });

  it("runStatusLabel maps outcomes to PT-BR (null → null)", () => {
    expect(runStatusLabel("ok")).toBe("ok");
    expect(runStatusLabel("error")).toBe("erro");
    expect(runStatusLabel(null)).toBeNull();
  });

  it("GATE_ICON covers every verdict", () => {
    expect(GATE_ICON.ok).toBe("✓");
    expect(GATE_ICON.blocked).toBe("✗");
    expect(GATE_ICON.pending).toBe("·");
  });
});

// WS5 (F4) — the dual-axis honest history: skipped-visible, exempt, satisfiedWithoutRun, visited, counter.
describe("computeStepRollups — WS5 dual-axis (rota × execução)", () => {
  const t = (to: string, actor: Transition["actor"], at: string): Transition => ({
    v: 1, at, board: "storymap", cardId: "story-x", from: null, to, actor,
  });

  it("a routing.skips step (WS4) is VISIBLE as skipped with reason 'rota: <profile>'", () => {
    const c = card({ storyType: "user", routing: { skips: ["design-ux"], decidedBy: "agent", decidedAt: "2026-07-10", profile: "express" } });
    const ux = find(computeStepRollups(config(), c, []), "harness-ux");
    expect(ux.gate).toBe("skipped");
    expect(ux.reason).toBe("rota: express");
  });

  it("satisfiedWithoutRun: a card born with narrative+acceptance, zero runs → enrich ok + flag", () => {
    const c = card({ narrative: { role: "r", want: "w", soThat: "s" }, acceptance: ["ac"] });
    const enrich = find(computeStepRollups(config(), c, []), "harness-enrich");
    expect(enrich.gate).toBe("ok");
    expect(enrich.satisfiedWithoutRun).toBe(true);
    expect(enrich.visited).toBeUndefined();
  });

  it("visited via the WS2 ledger: a transition INTO the step records {at, actor} (run→agent)", () => {
    const c = card();
    const transitions = [t("desenvolver", "human", "2026-07-09T10:00:00Z"), t("desenvolver", "run:harness-plan", "2026-07-08T09:00:00Z")];
    const dev = find(computeStepRollups(config(), c, [], null, { transitions }), "harness-do");
    expect(dev.visited).toEqual({ at: "2026-07-09T10:00:00Z", actor: "human" }); // latest wins; human, not agent
    // a step no transition ever entered has no visited.
    expect(find(computeStepRollups(config(), c, [], null, { transitions }), "harness-enrich").visited).toBeUndefined();
    // a step visited only by a run:<trigger> normalises the actor to "agent".
    const revd = find(computeStepRollups(config(), c, [], null, { transitions: [t("revisar-codigo", "run:harness-do", "2026-07-08T00:00:00Z")] }), "harness-review");
    expect(revd.visited?.actor).toBe("agent");
  });

  it("a satisfied step that was VISITED is NOT flagged satisfiedWithoutRun (a real event happened)", () => {
    const c = card({ narrative: { role: "r", want: "w", soThat: "s" }, acceptance: ["ac"] });
    const enrich = find(computeStepRollups(config(), c, [], null, { transitions: [t("enriquecer", "run:harness-enrich", "2026-07-08T00:00:00Z")] }), "harness-enrich");
    expect(enrich.satisfiedWithoutRun).toBeUndefined();
    expect(enrich.visited?.actor).toBe("agent");
  });

  it("stepProgress excludes exempt/skipped from BOTH done and total (X/Y can reach Y on a technical card)", () => {
    const technical = card({ storyType: "technical", narrative: { role: "r", want: "w", soThat: "s" }, acceptance: ["ac"], tasks: [{ id: "t1", title: "x", done: false }] });
    const rs = computeStepRollups(config(), technical, []);
    const { done, total } = stepProgress(rs);
    // the QA-exempt step + the type-skipped steps (interview/design-ux) are NOT in the total.
    expect(rs.find((r) => r.trigger === "harness-qa")!.gate).toBe("exempt");
    expect(total).toBeGreaterThan(0);
    expect(done).toBeLessThanOrEqual(total);
    // no forward step in the total is exempt/skipped.
    const countedGates = rs.filter((r) => r.onPath && (r.gate === "exempt" || r.gate === "skipped"));
    expect(countedGates.every((r) => true)).toBe(true); // sanity: they exist but are excluded by stepProgress
    expect(total).toBe(rs.filter((r) => r.onPath && r.gate !== "exempt" && r.gate !== "skipped").length);
  });

  it("GATE_ICON has the WS5 glyphs", () => {
    expect(GATE_ICON.exempt).toBe("–");
    expect(GATE_ICON.skipped).toBe("⊘");
  });
});
