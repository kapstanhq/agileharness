import { describe, expect, it } from "vitest";
import { moveTargets, movableStatusIds } from "./move-targets";
import { coerceCard } from "./repo";
import type { BoardConfig, Card } from "./types";

// A small linear pipeline with gates mid-way, mirroring a real board: a fresh card
// can reach triage/enriquecer freely, but priorizar is gated (hasRefinement) and
// pronta is gated (hasPrioritization).
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "enriquecer", name: "Enriquecer", trigger: "harness-enrich" },
    { id: "priorizar", name: "Priorizar", gate: "hasRefinement" },
    { id: "pronta", name: "Pronta", gate: "hasPrioritization" },
    { id: "concluida", name: "Concluída", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

const FULL_NARRATIVE = { role: "Como morador", want: "quero X", soThat: "para Y" };

describe("moveTargets", () => {
  it("excludes the card's current status and any gate that fails", () => {
    const c = card({ status: "enriquecer" }); // no narrative/acceptance yet
    const ids = moveTargets(c, board).map((t) => t.status.id);
    expect(ids).not.toContain("enriquecer"); // current — excluded
    expect(ids).not.toContain("priorizar"); // hasRefinement fails → not eligible
    expect(ids).not.toContain("pronta"); // hasPrioritization fails → not eligible
    // ungated columns remain reachable (incl. backward to triage, terminal concluida has no gate)
    expect(ids).toEqual(expect.arrayContaining(["triage", "concluida"]));
  });

  it("recommends the nearest FORWARD gate-passing status, listed first", () => {
    // A refined card in enriquecer: priorizar's gate (hasRefinement) now passes.
    const c = card({ status: "enriquecer", narrative: FULL_NARRATIVE, acceptance: ["ac"] });
    const targets = moveTargets(c, board);
    expect(targets[0].status.id).toBe("priorizar"); // nearest forward eligible → first
    expect(targets[0].recommended).toBe(true);
    expect(targets.filter((t) => t.recommended)).toHaveLength(1); // exactly one recommended
  });

  it("flags no recommendation when no forward status is eligible", () => {
    // In priorizar but not prioritized → pronta (next) is gated out; only backward moves remain.
    const c = card({ status: "priorizar", narrative: FULL_NARRATIVE, acceptance: ["ac"] });
    const targets = moveTargets(c, board);
    expect(targets.every((t) => !t.recommended)).toBe(true);
    expect(targets.map((t) => t.status.id)).not.toContain("pronta");
  });

  it("for an unstatused card recommends the first eligible status", () => {
    const c = card({ status: null });
    const targets = moveTargets(c, board);
    expect(targets[0].recommended).toBe(true);
    expect(targets[0].status.id).toBe("triage"); // first column in pipeline order
  });

  it("recommends the terminal finish, stepping over inactive branch/re-entry lanes", () => {
    // Mirrors the real board tail: refinar/corrigir (brief-gated re-entry lanes) sit
    // between human review and the terminal Concluída. A reviewed card with no brief
    // should recommend Concluída — not stall on the refinar lane that precedes it.
    const tail: BoardConfig = {
      ...board,
      statuses: [
        { id: "revisao", name: "Revisão" },
        { id: "refinar", name: "Refinar", gate: "hasRefineBrief" },
        { id: "corrigir", name: "Corrigir", gate: "hasBugReport" },
        { id: "concluida", name: "Concluída", terminal: true },
        { id: "arquivados", name: "Arquivados", terminal: true },
      ],
    };
    const c = card({ status: "revisao" });
    const targets = moveTargets(c, tail);
    expect(targets[0].status.id).toBe("concluida");
    expect(targets[0].recommended).toBe(true);
    const ids = targets.map((t) => t.status.id);
    expect(ids).not.toContain("refinar"); // brief-gated, no brief → not a destination
    expect(ids).not.toContain("corrigir");
  });

  it("does NOT skip a failing MANDATORY gate to reach a terminal", () => {
    // pronta (hasPrioritization) is a mandatory readiness gate, NOT a branch lane — when it
    // fails the walk stops, so we never recommend skipping straight to the terminal.
    const c = card({ status: "priorizar", narrative: FULL_NARRATIVE, acceptance: ["ac"] });
    const targets = moveTargets(c, board);
    expect(targets.every((t) => !t.recommended)).toBe(true);
  });

  it("returns [] when the card cannot move anywhere", () => {
    const single: BoardConfig = { ...board, statuses: [{ id: "only", name: "Only" }] };
    expect(moveTargets(card({ status: "only" }), single)).toEqual([]);
  });

  it("movableStatusIds mirrors moveTargets as a Set", () => {
    const c = card({ status: "enriquecer", narrative: FULL_NARRATIVE, acceptance: ["ac"] });
    const ids = movableStatusIds(c, board);
    expect(ids.has("priorizar")).toBe(true);
    expect(ids.has("enriquecer")).toBe(false);
  });
});
