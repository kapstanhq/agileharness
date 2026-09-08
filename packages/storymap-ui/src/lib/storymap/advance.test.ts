import { describe, expect, it } from "vitest";
import { decideAdvance, reportAdvance } from "./advance";
import type { AdvanceDecision } from "./advance";
import type { StoryType } from "./frameworks";
import type { BoardConfig, Card, StatusDef } from "./types";

const cfg = (statuses: StatusDef[]): BoardConfig => ({
  id: "b",
  name: "B",
  statuses,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
});

const card = (over: Partial<Card>): Card =>
  ({
    id: "story-x",
    type: "story",
    title: "t",
    storyType: "user",
    status: null,
    parent: null,
    links: [],
    acceptance: [],
    tasks: [],
    ...over,
  }) as Card;

const COMPLETE_NARRATIVE = { role: "operador", want: "algo", soThat: "valor" };

// The slice the advance helper walks: enrich → estimate(gate) → todo(gate) → design block → live.
const board = cfg([
  { id: "enriquecer", name: "Spec", trigger: "harness-enrich", autorun: true },
  { id: "priorizar", name: "Estimar", gate: "hasRefinement", trigger: "harness-prioritize", autorun: true },
  { id: "design-ux", name: "UX", trigger: "harness-ux", autorun: true, skipForTypes: ["technical", "chore", "spike", "bug"] },
  { id: "plano", name: "Plano", trigger: "harness-plan", autorun: true },
  { id: "concluida", name: "Live", terminal: true },
  // a re-entry step AFTER the terminal (mirrors board.yaml: refinar follows concluida)
  { id: "refinar", name: "Refinar", gate: "hasRefineBrief", trigger: "harness-refine", autorun: true },
]);

describe("decideAdvance", () => {
  it("advances to the next step when its entry gate passes", () => {
    const c = card({ status: "enriquecer", narrative: COMPLETE_NARRATIVE, acceptance: ["dado/quando/então"] });
    expect(decideAdvance(c, board)).toEqual({ action: "advance", from: "enriquecer", to: "priorizar" });
  });

  it("blocks (does not advance) when the next step's gate is unmet", () => {
    const c = card({ status: "enriquecer", narrative: { role: "", want: "", soThat: "" }, acceptance: [] });
    const d = decideAdvance(c, board);
    expect(d.action).toBe("blocked");
    if (d.action === "blocked") {
      expect(d.to).toBe("priorizar");
      expect(d.gate).toMatch(/narrativa/i);
    }
  });

  it("is done at a terminal step (end of pipeline) — NEVER walks into a re-entry step after it", () => {
    // Regression: with `refinar` placed AFTER `concluida` in array order, a naive forward
    // scan returns refinar (gate unmet) → "blocked". A terminal current status must be done.
    const c = card({ status: "concluida" });
    expect(decideAdvance(c, board)).toMatchObject({ action: "done", from: "concluida" });
  });

  it("is done when the next step would be terminal", () => {
    const c = card({ status: "plano" });
    expect(decideAdvance(c, board)).toMatchObject({ action: "done", from: "plano" });
  });

  // ADR-059 parity with decideForward: a step that sets `autoEnterTerminal` ADVANCES into the
  // terminal (the Deploy → No ar case), while a plain step before a terminal stays `done`.
  it("ADVANCES into the terminal when the current step sets autoEnterTerminal (Deploy → No ar)", () => {
    const deployBoard = cfg([
      { id: "deploy", name: "Publicar", autoEnterTerminal: true },
      { id: "concluida", name: "No ar", terminal: true },
    ]);
    expect(decideAdvance(card({ status: "deploy" }), deployBoard)).toEqual({
      action: "advance",
      from: "deploy",
      to: "concluida",
    });
  });

  it("stays done before a terminal when the current step lacks autoEnterTerminal (default-off)", () => {
    const plainBoard = cfg([
      { id: "deploy", name: "Publicar" },
      { id: "concluida", name: "No ar", terminal: true },
    ]);
    expect(decideAdvance(card({ status: "deploy" }), plainBoard)).toMatchObject({ action: "done", from: "deploy" });
  });

  it("is done when the card has no status", () => {
    expect(decideAdvance(card({ status: null }), board)).toMatchObject({ action: "done" });
  });

  it("is board-aware: a non-user story skips the design block in one hop", () => {
    // A technical story past the gate at priorizar advances to plano, NOT design-ux.
    for (const t of ["technical", "chore", "spike", "bug"] as StoryType[]) {
      const c = card({ status: "priorizar", storyType: t });
      expect(decideAdvance(c, board)).toEqual({ action: "advance", from: "priorizar", to: "plano" });
    }
    // A user story DOES traverse design-ux.
    const u = card({ status: "priorizar", storyType: "user" });
    expect(decideAdvance(u, board)).toEqual({ action: "advance", from: "priorizar", to: "design-ux" });
  });

  it("is instance-aware: a refine[functionality] user story skips the design block (advance → plano)", () => {
    const c = card({
      status: "priorizar",
      storyType: "user",
      mode: "refine",
      refinement: { brief: "ajustar copy", kinds: ["functionality"], target: null, screenshot: null, openedAt: null },
    });
    expect(decideAdvance(c, board)).toEqual({ action: "advance", from: "priorizar", to: "plano" });
  });

  it("is instance-aware: a refine[ui] user story KEEPS the design block (advance → design-ux)", () => {
    const c = card({
      status: "priorizar",
      storyType: "user",
      mode: "refine",
      refinement: { brief: "repensar layout", kinds: ["ui"], target: null, screenshot: null, openedAt: null },
    });
    expect(decideAdvance(c, board)).toEqual({ action: "advance", from: "priorizar", to: "design-ux" });
  });
});

// story-m3x2uq — advance-card reported "success" (exit 0 + "from → to") whenever the DECISION was
// "advance", regardless of whether the write actually landed (`written`). So a decided-but-unpersisted
// advance (the card changed under the lock / a concurrent writer) looked like a success with no effect —
// the "sucesso aparente sem efeito" a headless run hit, then burned turns misdiagnosing the sandbox.
// reportAdvance makes the outcome (ok/exitCode/message) follow `written`, so a no-op is LOUD.
describe("reportAdvance — the outcome follows `written`, not just the decision (story-m3x2uq)", () => {
  const adv: AdvanceDecision = { action: "advance", from: "plano-tecnico", to: "desenvolver" };

  it("advance + written → success (exit 0, ok), message shows the transition", () => {
    const r = reportAdvance("story-x", adv, true, false);
    expect(r).toMatchObject({ ok: true, exitCode: 0, written: true });
    expect(r.message).toContain("plano-tecnico → desenvolver");
  });

  it("advance + NOT written → LOUD failure (exit ≠ 0, not ok) — the silent-success this fixes", () => {
    const r = reportAdvance("story-x", adv, false, false);
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.message).toMatch(/não persistiu/i);
  });

  it("advance + dryRun → success WITHOUT a write (no false failure on a preview)", () => {
    const r = reportAdvance("story-x", adv, false, true);
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("blocked → exit 1 with the actionable gate reason", () => {
    const blocked: AdvanceDecision = {
      action: "blocked",
      from: "plano-tecnico",
      to: "desenvolver",
      gate: "Quebre a story em ao menos 1 task",
    };
    const r = reportAdvance("story-x", blocked, false, false);
    expect(r).toMatchObject({ ok: false, exitCode: 1 });
    expect(r.message).toContain("Quebre a story em ao menos 1 task");
  });

  it("done → exit 0, ok, no write expected", () => {
    const done: AdvanceDecision = { action: "done", from: "concluida", reason: "card em status terminal" };
    const r = reportAdvance("story-x", done, false, false);
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.message).toMatch(/sem avanço/i);
  });
});
