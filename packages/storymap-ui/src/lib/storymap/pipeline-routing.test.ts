import { describe, expect, it } from "vitest";
import {
  UI_DESIGN_STATUSES,
  needsUiDesign,
  nextBuildStatus,
  skipsStatusForType,
  statusSkipsForType,
} from "./pipeline-routing";
import type { RoutableCard } from "./skip-routing";
import type { ImprovementKind, StoryType } from "./frameworks";
import type { BoardConfig, StatusDef } from "./types";

const cfg = (statuses: StatusDef[]): BoardConfig => ({
  id: "b",
  name: "B",
  statuses,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
});

// nextBuildStatus is now INSTANCE-aware: it takes a card, not a bare storyType. These helpers keep
// the existing storyType-based assertions terse while exercising the new mode/kinds routing.
const sc = (storyType: StoryType): RoutableCard => ({ storyType });
const refineCard = (kinds: ImprovementKind[]): RoutableCard => ({
  storyType: "user",
  mode: "refine",
  refinement: { brief: "x", kinds, target: null, screenshot: null, openedAt: null },
});

// The real build slice that the storyType branch cares about: the go/no-go stop,
// the UI-design block, then the plan/tasks/build columns and QA.
const pipeline = cfg([
  { id: "pronta", name: "Pronta", autorun: false },
  { id: "design-ux", name: "Design UI/UX", trigger: "harness-ux", autorun: true },
  { id: "com-design", name: "Com design", gate: "hasWireframe", autorun: false },
  { id: "plano-tecnico", name: "Plano técnico", trigger: "harness-plan", autorun: true },
  { id: "quebrar-tasks", name: "Quebrar tasks", gate: "hasTechPlan", trigger: "harness-tasks", autorun: true },
  { id: "desenvolver", name: "Em desenvolvimento", gate: "hasTasks", trigger: "harness-do", autorun: false },
  { id: "qa-automatizado", name: "QA automatizado", trigger: "harness-qa", autorun: false },
  { id: "concluida", name: "Concluída", terminal: true },
]);

const NON_USER: StoryType[] = ["technical", "chore", "spike", "bug"];

describe("needsUiDesign", () => {
  it("only `user` stories need the UI-design columns", () => {
    expect(needsUiDesign("user")).toBe(true);
  });
  it.each(NON_USER)("a %s story has no UI surface", (t) => {
    expect(needsUiDesign(t)).toBe(false);
  });
  it("a null storyType (activity/step/legacy) is treated as non-UI", () => {
    expect(needsUiDesign(null)).toBe(false);
  });
});

describe("skipsStatusForType", () => {
  it("user stories skip nothing — they traverse the design block", () => {
    for (const s of UI_DESIGN_STATUSES) expect(skipsStatusForType(s, "user")).toBe(false);
  });
  it.each(NON_USER)("a %s story skips both UI-design columns", (t) => {
    expect(skipsStatusForType("design-ux", t)).toBe(true);
    expect(skipsStatusForType("com-design", t)).toBe(true);
  });
  it("never skips a non-design status, regardless of type", () => {
    for (const t of [...NON_USER, "user" as StoryType]) {
      expect(skipsStatusForType("plano-tecnico", t)).toBe(false);
      expect(skipsStatusForType("qa-automatizado", t)).toBe(false);
    }
  });
});

describe("nextBuildStatus", () => {
  it("user: pronta → design-ux (no skip, the full path is intact)", () => {
    expect(nextBuildStatus(pipeline, "pronta", sc("user"))?.status.id).toBe("design-ux");
  });

  it.each(NON_USER)("%s: pronta → plano-tecnico (skips design-ux + com-design)", (t) => {
    expect(nextBuildStatus(pipeline, "pronta", sc(t))?.status.id).toBe("plano-tecnico");
  });

  it.each(NON_USER)("%s: design-ux → plano-tecnico (steps over com-design too)", (t) => {
    expect(nextBuildStatus(pipeline, "design-ux", sc(t))?.status.id).toBe("plano-tecnico");
  });

  it("user: design-ux → com-design (the design block runs in full)", () => {
    expect(nextBuildStatus(pipeline, "design-ux", sc("user"))?.status.id).toBe("com-design");
  });

  it("non-design transitions are identical for every type", () => {
    for (const t of [...NON_USER, "user" as StoryType]) {
      expect(nextBuildStatus(pipeline, "plano-tecnico", sc(t))?.status.id).toBe("quebrar-tasks");
      expect(nextBuildStatus(pipeline, "desenvolver", sc(t))?.status.id).toBe("qa-automatizado");
    }
  });

  it("returns the next index alongside the status", () => {
    const out = nextBuildStatus(pipeline, "pronta", sc("user"));
    expect(out).toEqual({ status: pipeline.statuses[1], index: 1 });
  });

  it("returns null past the last status", () => {
    expect(nextBuildStatus(pipeline, "concluida", sc("user"))).toBeNull();
  });

  it("returns null for an unknown fromStatusId", () => {
    expect(nextBuildStatus(pipeline, "fantasma", sc("user"))).toBeNull();
  });
});

// Instance-aware routing: a reopened refine of a `user` story skips steps a fresh build traverses.
// The slice mirrors _base: the discovery interview, the full design block (design-ux/ui + approve),
// the ready buffer, then the build columns. A refine with a TEXT/BEHAVIOUR-only kind hops past
// interview + the whole design+ready run; a refine with a visual kind keeps the design block.
describe("nextBuildStatus — mode/kinds-aware skip (refine)", () => {
  const SKIP = ["technical", "chore", "spike", "bug"] as const;
  const reopenPipeline = cfg([
    { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true, column: "discovery" },
    { id: "interview", name: "Entrevista", trigger: "harness-interview", autorun: true, column: "discovery", skipForTypes: [...SKIP] },
    { id: "priorizar", name: "Estimar", gate: "hasRefinement", trigger: "harness-prioritize", autorun: true, column: "discovery" },
    { id: "pronta", name: "A fazer", gate: "hasPrioritization", autorun: false, column: "todo" },
    { id: "design-ux", name: "Jornada", trigger: "harness-ux", autorun: true, column: "prepare", skipForTypes: [...SKIP] },
    { id: "design-ui", name: "Telas", trigger: "harness-ui", autorun: true, column: "prepare", skipForTypes: [...SKIP] },
    { id: "com-design", name: "Aprovar design", gate: "hasWireframe", autorun: false, column: "prepare", skipForTypes: [...SKIP] },
    { id: "ready", name: "Pronto p/ dev", autorun: false, column: "ready", skipForTypes: [...SKIP] },
    { id: "plano-tecnico", name: "Plano & Tarefas", trigger: "harness-plan", autorun: true, column: "in-progress" },
    { id: "concluida", name: "No ar", terminal: true, column: "live" },
  ]);

  it("AC1: a refine[functionality] hops enriquecer → priorizar (skips the interview)", () => {
    expect(nextBuildStatus(reopenPipeline, "enriquecer", refineCard(["functionality"]))?.status.id).toBe("priorizar");
  });

  it("AC1: a refine[functionality] hops pronta → plano-tecnico (skips the whole design+ready run)", () => {
    expect(nextBuildStatus(reopenPipeline, "pronta", refineCard(["functionality"]))?.status.id).toBe("plano-tecnico");
  });

  it("AC2: a refine[ui] still LANDS on design-ux from pronta (design block runs)", () => {
    expect(nextBuildStatus(reopenPipeline, "pronta", refineCard(["ui"]))?.status.id).toBe("design-ux");
  });

  it("AC2: a refine[ux] lands on design-ux but still skips the interview (enriquecer → priorizar)", () => {
    expect(nextBuildStatus(reopenPipeline, "enriquecer", refineCard(["ux"]))?.status.id).toBe("priorizar");
    expect(nextBuildStatus(reopenPipeline, "pronta", refineCard(["ux"]))?.status.id).toBe("design-ux");
  });

  it("a refine[ui, functionality] (mixed) keeps the design block (visual wins) from pronta", () => {
    expect(nextBuildStatus(reopenPipeline, "pronta", refineCard(["ui", "functionality"]))?.status.id).toBe("design-ux");
  });

  it("a plain user BUILD story still traverses interview + the design block (regression)", () => {
    expect(nextBuildStatus(reopenPipeline, "enriquecer", sc("user"))?.status.id).toBe("interview");
    expect(nextBuildStatus(reopenPipeline, "pronta", sc("user"))?.status.id).toBe("design-ux");
  });

  it("a non-user build story still skips interview + design via the static base (regression)", () => {
    for (const t of SKIP) {
      expect(nextBuildStatus(reopenPipeline, "enriquecer", sc(t))?.status.id).toBe("priorizar");
      expect(nextBuildStatus(reopenPipeline, "pronta", sc(t))?.status.id).toBe("plano-tecnico");
    }
  });
});

describe("statusSkipsForType (data-driven)", () => {
  it.each(NON_USER)("a step declaring skipForTypes skips the listed type (%s)", (t) => {
    const ux: StatusDef = { id: "ux", name: "UX", skipForTypes: NON_USER };
    expect(statusSkipsForType(ux, t)).toBe(true);
  });

  it("a step declaring skipForTypes is traversed by a type it does NOT list", () => {
    const ux: StatusDef = { id: "ux", name: "UX", skipForTypes: NON_USER };
    expect(statusSkipsForType(ux, "user")).toBe(false);
  });

  it("skipForTypes works on a NEW step id outside the hardcoded UI_DESIGN_STATUSES", () => {
    // `design-ui`/`ready` are not in UI_DESIGN_STATUSES — the legacy id-based skip
    // would never catch them; the per-step field is the whole point.
    const ui: StatusDef = { id: "design-ui", name: "UI", skipForTypes: NON_USER };
    const ready: StatusDef = { id: "ready", name: "Ready", skipForTypes: NON_USER };
    expect(statusSkipsForType(ui, "bug")).toBe(true);
    expect(statusSkipsForType(ready, "chore")).toBe(true);
    expect(statusSkipsForType(ui, "user")).toBe(false);
    expect(statusSkipsForType(ready, "user")).toBe(false);
  });

  it("falls back to the hardcoded skip for a step WITHOUT skipForTypes", () => {
    const legacy: StatusDef = { id: "design-ux", name: "Design UI/UX" };
    for (const t of NON_USER) expect(statusSkipsForType(legacy, t)).toBe(true);
    expect(statusSkipsForType(legacy, "user")).toBe(false);
  });

  it("never skips a non-design step that declares no skipForTypes", () => {
    const plan: StatusDef = { id: "plano-tecnico", name: "Plano", trigger: "harness-plan" };
    for (const t of [...NON_USER, "user" as StoryType]) {
      expect(statusSkipsForType(plan, t)).toBe(false);
    }
  });

  it("a null storyType is never matched by an explicit skipForTypes (traverses)", () => {
    const ux: StatusDef = { id: "ux", name: "UX", skipForTypes: NON_USER };
    expect(statusSkipsForType(ux, null)).toBe(false);
  });

  it("nextBuildStatus honors a per-step skipForTypes", () => {
    const board = cfg([
      { id: "todo", name: "Todo", autorun: false },
      { id: "ux", name: "UX", trigger: "harness-ux", autorun: true, skipForTypes: NON_USER },
      { id: "ui", name: "UI", autorun: false, skipForTypes: NON_USER },
      { id: "build", name: "Build", trigger: "harness-do", autorun: false },
    ]);
    // non-user skips ux+ui in one hop; user lands on ux
    expect(nextBuildStatus(board, "todo", sc("bug"))?.status.id).toBe("build");
    expect(nextBuildStatus(board, "todo", sc("user"))?.status.id).toBe("ux");
  });
});
