import { describe, expect, it } from "vitest";
import { decideAdvance } from "./advance";
import { moveTargets } from "./move-targets";
import { listBoards, readBoardConfig } from "./repo";
import { subjectBoards } from "./board-fixture";
import type { BoardConfig, Card, CardType } from "./types";

// D3 parity guard (WS-0 copilot-actionability, risk 8). The "next obvious action" a gate item / the kanban
// slot offers is `moveTargets(card, config).find(t => t.recommended)` — while the autorun cascade advances
// via `decideAdvance`. The two are SEPARATE walks (decideAdvance uses nextBuildStatus/routeSkip; moveTargets
// walks pipeline order stepping over inactive branch lanes). This test PINS their relationship so a silent
// change to either becomes a detectable regression — and documents the ONE intended asymmetry (terminals).
//
// IO in a test is accepted here (the board-base-pipeline.test.ts pattern) — we iterate the real resolved
// pipeline of every board, not a synthetic one.

const BASE = {
  id: "c1", type: "story" as CardType, title: "T", storyType: "user", status: null, parent: null, release: null,
  personas: [], systems: [], links: [], narrative: { role: "", want: "", soThat: "" }, acceptance: [], tasks: [],
  rice: {}, kano: null, funnelStage: null, findings: [], order: 10, created: null, updated: null, body: "",
} as unknown as Card;

// A `user` card that satisfies (most) forward gates — so decideAdvance actually EXERCISES the `advance`
// branch across the pipeline instead of blocking at the first gate. `as unknown as Card` keeps the fixture
// terse (the exact PriorityCall/kano shapes are irrelevant to the walk).
const MAX_FIELDS = {
  storyType: "user",
  narrative: { role: "r", want: "w", soThat: "s" },
  acceptance: ["a"],
  tasks: [{ id: "t1", title: "t", done: true }],
  rice: { reach: 10, impact: 2, confidence: 0.8, effort: 1 },
  priorityCall: { rank: 1, rationale: "r", riskiestAssumption: "y", source: "reasoning", assessedAt: "2026-01-01" },
  kano: "must-be",
  funnelStage: "activation",
  techPlanReady: true,
  wireframeChosen: "o1",
  qaPassed: true,
  hasUiSurface: false,
  criteriaSpecs: [],
  findings: [],
  parent: "p1",
  stagedAt: "2026-01-01",
  releasedAt: "2026-01-02",
};

const maxCard = (status: string): Card => ({ ...BASE, ...MAX_FIELDS, status } as unknown as Card);
const minCard = (status: string): Card => ({ ...BASE, storyType: "user", status } as Card);

/** For EVERY status of `cfg`, place the card there and assert the parity invariants. */
function checkParity(cfg: BoardConfig, make: (status: string) => Card) {
  for (const s of cfg.statuses) {
    const card = make(s.id);
    const d = decideAdvance(card, cfg);
    const rec = moveTargets(card, cfg).find((t) => t.recommended);
    const at = `${cfg.id}@${s.id}`;
    if (d.action === "advance") {
      // STRONG invariant: the cascade's next step IS the recommended move.
      expect(rec?.status.id, `advance ${at}: ${d.to}`).toBe(d.to);
    } else if (d.action === "done") {
      // DOCUMENTED ASYMMETRY (not a bug): decideAdvance won't auto-close a terminal (closing is explicit),
      // yet moveTargets MAY recommend one — finishing is a legitimate next step in the popover. So a `done`
      // may still carry a recommendation, but ONLY a terminal one. An inverted assertion: if this flips
      // (moveTargets recommends a NON-terminal on a `done`) either walk regressed.
      if (rec) expect(rec.status.terminal ?? false, `done ${at}: recommends non-terminal ${rec.status.id}`).toBe(true);
    } else {
      // blocked: the gate for `to` failed, so moveTargets can NEVER recommend `to` itself (it isn't eligible).
      expect(rec?.status.id, `blocked ${at}: recommends the blocked step`).not.toBe(d.to);
    }
  }
}

describe("D3 parity — decideAdvance × moveTargets.recommended", () => {
  it("holds on the canonical pipeline for a gate-max and a gate-min user card", async () => {
    for (const board of subjectBoards()) {
      const cfg = await readBoardConfig(board);
      checkParity(cfg, maxCard);
      checkParity(cfg, minCard);
    }
  });

  it("holds on every real board (incl. orbit, inheritPipeline:false)", async () => {
    for (const b of await listBoards()) {
      const cfg = await readBoardConfig(b.id);
      checkParity(cfg, maxCard);
    }
  });

  it("documents the terminal asymmetry: `concluida` is done, yet moveTargets recommends a terminal", async () => {
    const cfg = await readBoardConfig(subjectBoards()[0]);
    const card = maxCard("concluida");
    expect(decideAdvance(card, cfg).action).toBe("done");
    const rec = moveTargets(card, cfg).find((t) => t.recommended);
    // moveTargets DOES walk forward past the inactive reentry branch lanes and recommends the archive terminal.
    expect(rec, "moveTargets should still recommend a terminal from concluida").toBeTruthy();
    expect(rec?.status.terminal).toBe(true);
  });

  it("a mandatory forward gate blocks with NO recommendation (the walk stops at the unmet gate)", async () => {
    const cfg = await readBoardConfig(subjectBoards()[0]);
    // A gate-min user card at `interview` cannot enter `priorizar` (hasRefinement unmet) — a MANDATORY gate.
    const card = minCard("interview");
    const d = decideAdvance(card, cfg);
    expect(d.action).toBe("blocked");
    expect(moveTargets(card, cfg).find((t) => t.recommended)).toBeUndefined();
  });
});
