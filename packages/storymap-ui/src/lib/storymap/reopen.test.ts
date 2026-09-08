import { describe, expect, it } from "vitest";
import {
  applyReopen,
  clearReopenPending,
  isReopenableStatus,
  isReopenDestination,
  REOPEN_DESTINATIONS,
  REOPEN_GATES,
  REOPEN_KINDS,
  REOPENABLE_STATUSES,
} from "./reopen";
import { GATE_IDS, REOPEN_MODES } from "./types";
import type { BugReport, Card, Refinement, Retirement } from "./types";

// C1 — the reopen invariant ("a card carries ONE reopen block at a time") lives in applyReopen, the
// single source the refine/fix/retire actions delegate to. These pin the stamp-and-clear-siblings
// behaviour the actions previously hand-rolled (and partially diverged on).

const base: Card = {
  id: "c1",
  type: "story",
  title: "Salvar evento",
  storyType: "user",
  status: "concluida",
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
  order: 0,
  created: null,
  updated: null,
  body: "",
};

const refinement: Refinement = { brief: "mais contraste", kinds: ["ui"], target: null, screenshot: null, openedAt: "2026-06-11" };
const bugReport: BugReport = { brief: "quebra no login", severity: "high", expected: null, actual: null, steps: [], target: null, screenshot: null, openedAt: "2026-06-11" };
const retirement: Retirement = { brief: "fora do escopo", disposition: "descontinuado", level: "remover-codigo", scope: ["codigo"], target: null, screenshot: null, fromStatus: "concluida", dataDeletionApproved: false, openedAt: "2026-06-11" };

describe("applyReopen — stamps mode + sets the block + NULLs the other reopen blocks", () => {
  it("refine: sets refinement, nulls bugReport + retirement", () => {
    const stale = { ...base, bugReport, retirement };
    const out = applyReopen(stale, { mode: "refine", refinement });
    expect(out.mode).toBe("refine");
    expect(out.refinement).toEqual(refinement);
    expect(out.bugReport).toBeNull();
    expect(out.retirement).toBeNull();
  });

  it("fix: sets bugReport, nulls refinement + retirement", () => {
    const stale = { ...base, refinement, retirement };
    const out = applyReopen(stale, { mode: "fix", bugReport });
    expect(out.mode).toBe("fix");
    expect(out.bugReport).toEqual(bugReport);
    expect(out.refinement).toBeNull();
    expect(out.retirement).toBeNull();
  });

  it("retire: sets retirement, nulls refinement + bugReport", () => {
    const stale = { ...base, refinement, bugReport };
    const out = applyReopen(stale, { mode: "retire", retirement });
    expect(out.mode).toBe("retire");
    expect(out.retirement).toEqual(retirement);
    expect(out.refinement).toBeNull();
    expect(out.bugReport).toBeNull();
  });

  it("preserves every other card field; never sets status (caller's job)", () => {
    const out = applyReopen(base, { mode: "refine", refinement });
    expect(out.id).toBe("c1");
    expect(out.title).toBe("Salvar evento");
    expect(out.status).toBe(base.status); // applyReopen does NOT touch status
  });

  it("WS4: clears the whole stale routing — profile + model/effort caps too, not only skips", () => {
    const stale = {
      ...base,
      routing: { skips: ["design-ux"], decidedBy: "agent" as const, decidedAt: "2026-07-10", profile: "express", modelCap: "sonnet" as const, effortCap: "medium" as const, rationale: "trivial" },
    };
    const out = applyReopen(stale, { mode: "refine", refinement });
    // a fresh work instance must compute its route from the new brief — the prior instance's caps/profile
    // must not leak (else a trivial-profile card silently underpays a now-larger refine).
    expect(out.routing).toBeNull();
  });

  // story-rl5v03 (HIGH): a fresh reopen must NULL the per-instance routing override. The skip set
  // was computed FOR a previous reopen (its mode + refinement.kinds); if it survived, the new reopen
  // would inherit a stale, authoritative `routing.skips` that could silently bypass steps it should
  // traverse. applyReopen is the single chokepoint that clears it, for EVERY reopen lane.
  it("clears the stale per-instance routing override on a refine reopen (HIGH)", () => {
    const stale = {
      ...base,
      routing: { skips: ["design-ux", "design-ui"], decidedBy: "agent" as const, decidedAt: "2026-06-10" },
    };
    expect(stale.routing).not.toBeNull(); // precondition: the previous reopen left a routing decision
    const out = applyReopen(stale, { mode: "refine", refinement });
    expect(out.routing).toBeNull();
  });

  it("clears the stale routing override on a fix reopen too (every lane, not just refine)", () => {
    const stale = {
      ...base,
      routing: { skips: ["interview"], decidedBy: "rules" as const, decidedAt: "2026-06-10" },
    };
    const out = applyReopen(stale, { mode: "fix", bugReport });
    expect(out.routing).toBeNull();
  });

  it("clears the stale routing override on a retire reopen", () => {
    const stale = {
      ...base,
      routing: { skips: ["design-ux"], decidedBy: "agent" as const, decidedAt: "2026-06-10" },
    };
    const out = applyReopen(stale, { mode: "retire", retirement });
    expect(out.routing).toBeNull();
  });
});

describe("REOPEN_KINDS registry — the single source of the reopen lanes", () => {
  it("has exactly one entry per reopen mode (compiler-exhaustive)", () => {
    expect(Object.keys(REOPEN_KINDS).sort()).toEqual([...REOPEN_MODES].sort());
  });

  it("each lane: valid gate, non-empty status, block matches the mode's Card field", () => {
    const blockByMode: Record<string, string> = { refine: "refinement", fix: "bugReport", retire: "retirement" };
    for (const k of Object.values(REOPEN_KINDS)) {
      expect(GATE_IDS).toContain(k.gate);
      expect(k.status.length).toBeGreaterThan(0);
      expect(k.block).toBe(blockByMode[k.mode]);
    }
  });

  it("only retire has a noOpStatus (the no-level graveyard route)", () => {
    expect(REOPEN_KINDS.retire.noOpStatus).toBe("arquivados");
    expect(REOPEN_KINDS.refine.noOpStatus).toBeUndefined();
    expect(REOPEN_KINDS.fix.noOpStatus).toBeUndefined();
  });

  it("REOPEN_GATES derives exactly the three lane gates", () => {
    expect([...REOPEN_GATES].sort()).toEqual(["hasBugReport", "hasRefineBrief", "hasRetireBrief"].sort());
  });
});

describe("isReopenableStatus / REOPENABLE_STATUSES", () => {
  it("true for a delivered story in QA/shipped, false otherwise", () => {
    expect(REOPENABLE_STATUSES).toEqual(new Set(["revisao", "concluida"]));
    expect(isReopenableStatus({ type: "story", status: "revisao" })).toBe(true);
    expect(isReopenableStatus({ type: "story", status: "concluida" })).toBe(true);
    expect(isReopenableStatus({ type: "story", status: "desenvolver" })).toBe(false);
    expect(isReopenableStatus({ type: "story", status: null })).toBe(false);
    expect(isReopenableStatus({ type: "activity", status: "concluida" })).toBe(false);
  });
});

// reabertura R1 — the ONE-SHOT contract. clearReopenPending disarms the override flag WITHOUT touching
// `mode`: the reopen executor skill (harness-refine/harness-fix) calls it on its FIRST pass so the SAME run's
// downstream cascade entries run the column's OWN mode-aware skill — while `mode` PERSISTS through the
// flow (harness-qa is the only station that clears it). This pins the cross-run loop fix the critic flagged.
describe("clearReopenPending — disarms the one-shot override, KEEPS mode + blocks", () => {
  it("clears reopenPending but PRESERVES mode + bugReport (the flow still needs them)", () => {
    const reopened = { ...base, mode: "fix" as const, reopenPending: true, bugReport };
    const out = clearReopenPending(reopened);
    expect(out.reopenPending).toBeUndefined();
    expect(out.mode).toBe("fix"); // mode PERSISTS — harness-qa clears it, not this
    expect(out.bugReport).toEqual(bugReport);
  });

  it("preserves every other card field (id/title/status untouched)", () => {
    const out = clearReopenPending({ ...base, mode: "refine" as const, reopenPending: true, refinement });
    expect(out.id).toBe("c1");
    expect(out.title).toBe("Salvar evento");
    expect(out.status).toBe(base.status);
    expect(out.refinement).toEqual(refinement);
  });
});

describe("isReopenDestination / REOPEN_DESTINATIONS", () => {
  it("accepts exactly the three build-flow destinations, rejects everything else", () => {
    expect(REOPEN_DESTINATIONS).toEqual(new Set(["enriquecer", "design-ux", "desenvolver"]));
    expect(isReopenDestination("desenvolver")).toBe(true);
    expect(isReopenDestination("design-ux")).toBe(true);
    expect(isReopenDestination("enriquecer")).toBe(true);
    expect(isReopenDestination("refinar")).toBe(false); // the old dedicated lane is no longer a destination
    expect(isReopenDestination("concluida")).toBe(false);
    expect(isReopenDestination(null)).toBe(false);
    expect(isReopenDestination(undefined)).toBe(false);
  });
});

describe("applyReopen — um FIX re-tipa a story como bug (invariante do lint de classificação)", () => {
  it("story technical + fix → storyType bug", () => {
    const out = applyReopen({ ...base, storyType: "technical" }, { mode: "fix", bugReport });
    expect(out.storyType).toBe("bug");
    expect(out.mode).toBe("fix");
  });

  it("story chore + fix → storyType bug (era o par que o reportBugAction gravava inválido)", () => {
    expect(applyReopen({ ...base, storyType: "chore" }, { mode: "fix", bugReport }).storyType).toBe("bug");
  });

  it("REFINE não re-tipa — só o fix carrega essa regra", () => {
    const out = applyReopen({ ...base, storyType: "technical" }, { mode: "refine", refinement });
    expect(out.storyType).toBe("technical");
  });

  it("backbone (step) NÃO ganha storyType — o schema dele não tem o campo", () => {
    const out = applyReopen({ ...base, type: "step", storyType: null }, { mode: "fix", bugReport });
    expect(out.storyType).toBeNull();
  });
});
