import { describe, expect, it } from "vitest";
import { ADVANCE_ON_SUCCESS_SKILLS, AGENTS, CODE_SKILLS, FULL_AUTONOMY_SKILLS } from "./skill-registry";
import type { TriggerId } from "@/lib/storymap/types";

// D3 — AGENTS is the SINGLE source for two runner primitives: lane/watchdog (isCode → HEAVY lane +
// no fast-watchdog, scheduler.ts/engine.ts) and permission (fullAutonomy → --dangerously-skip-
// permissions vs acceptEdits, engine.ts). The compiler (Record<TriggerId, AgentDef>) guarantees every
// trigger HAS an entry, but NOT that its booleans are correct — flipping harness-do.isCode to false would
// silently route a code run to the light lane with reduced perms and no test would notice. So pin the
// load-bearing VALUES, the derivations, and the structural invariant. (Mirrors gate-exhaustiveness.test
// — the runtime guard that keeps a compile-time-only contract honest.) A new code skill must be added
// to CODE_TRIGGERS below — an explicit, reviewable failure by design.

const CODE_TRIGGERS: TriggerId[] = [
  "harness-do",
  "harness-review",
  "harness-qa",
  "harness-refine",
  "harness-fix",
  "harness-retire",
  "harness-sync-card",
  // WS-10.1 — the semantic judge. isCode:true is DELIBERATE and load-bearing in both directions this
  // registry drives: it needs the HEAVY lane + no fast-watchdog (it provisions a fresh worktree, reapplies
  // a delta and re-runs a suite — minutes, not seconds), and it needs real write perms to materialize the
  // resolved artifact. It is COLUMN-LESS (no pipeline step triggers it — it is born only from the
  // train/release conflict disposition, like the redrive), so this list is the only place it is pinned.
  "harness-resolve",
];
// Skills that write ONLY the card .md (no Bash / no code) → run WITHOUT --dangerously-skip-permissions.
const NO_AUTONOMY: TriggerId[] = ["harness-grill", "harness-tasks", "harness-prioritize", "harness-plan"];
// Linear data skills whose successful run ALWAYS advances the card → a clean exit that left it in
// place is a sucesso-fantasma (no-op). Excludes HITL (grill, AND harness-capture — it proposes cards in the
// sidecar and RESTS in `capturando` for the human to accept in Inbox) and conditional-advance skills.
const ADVANCE_ON_SUCCESS: TriggerId[] = ["harness-enrich", "harness-tasks", "harness-prioritize", "harness-plan"];

const entries = Object.entries(AGENTS) as [
  TriggerId,
  { isCode: boolean; fullAutonomy: boolean; advancesOnSuccess: boolean },
][];

describe("AGENTS registry — pinned attribute values (D3)", () => {
  it("the code skills are EXACTLY the long-running diagnose/write-code ones", () => {
    expect([...CODE_SKILLS].sort()).toEqual([...CODE_TRIGGERS].sort());
  });

  it("harness-grill is human-in-the-loop — never full autonomy, never code, never must-advance", () => {
    expect(AGENTS["harness-grill"]).toEqual({ isCode: false, fullAutonomy: false, advancesOnSuccess: false });
  });

  it("the must-advance skills are EXACTLY the linear data ones (a clean exit that didn't advance is a no-op)", () => {
    expect([...ADVANCE_ON_SUCCESS_SKILLS].sort()).toEqual([...ADVANCE_ON_SUCCESS].sort());
  });

  it("INVARIANT: no code skill is must-advance (code can legitimately rest in blocker/red without advancing)", () => {
    for (const t of CODE_SKILLS) {
      expect(AGENTS[t].advancesOnSuccess, `${t} is a code skill but marked advancesOnSuccess`).toBe(false);
    }
  });

  it("the no-autonomy skills are EXACTLY the planning/HITL set (others advance via Bash → autonomy)", () => {
    const noAuto = entries.filter(([, a]) => !a.fullAutonomy).map(([t]) => t);
    expect(noAuto.sort()).toEqual([...NO_AUTONOMY].sort());
  });

  it("INVARIANT: every code skill runs with full autonomy (code ⟹ Bash ⟹ skip-permissions)", () => {
    for (const t of CODE_SKILLS) {
      expect(AGENTS[t].fullAutonomy, `${t} writes code but lacks fullAutonomy`).toBe(true);
    }
  });

  it("CODE_SKILLS / FULL_AUTONOMY_SKILLS / ADVANCE_ON_SUCCESS_SKILLS derive faithfully from AGENTS", () => {
    for (const [t, a] of entries) {
      expect(CODE_SKILLS.has(t)).toBe(a.isCode);
      expect(FULL_AUTONOMY_SKILLS.has(t)).toBe(a.fullAutonomy);
      expect(ADVANCE_ON_SUCCESS_SKILLS.has(t)).toBe(a.advancesOnSuccess);
    }
  });
});
