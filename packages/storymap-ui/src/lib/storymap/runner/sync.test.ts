import { describe, expect, it } from "vitest";
import { commandForTrigger, isCodeSkill, needsFullAutonomy } from "./engine";
import { SYNC_STATUS_DEF, SYNC_TRIGGER } from "./sync";
import { DEFAULT_RUNNER_SETTINGS, resolveColumnArgs } from "./config";
import type { TriggerId } from "../types";

// Expected per-trigger policy for the WHOLE TriggerId union. Declaring this as a
// Record<TriggerId, …> is the COMPILE-TIME lock: adding a new trigger to types.ts
// fails the build here until its command + code-skill + autonomy policy is declared.
// (The previous ALL_TRIGGERS array silently omitted harness-qa/harness-fix/harness-retire — an
// array literal does NOT force union completeness; a Record key set does.)
//   code     = isCodeSkill (no fast watchdog — diagnoses/writes code)
//   autonomy = needsFullAutonomy (--dangerously-skip-permissions — runs Bash)
const TRIGGER_POLICY: Record<TriggerId, { code: boolean; autonomy: boolean }> = {
  "harness-capture": { code: false, autonomy: true }, // writes the proposal sidecar + PARKS in capturando (HITL, no advance)
  "harness-enrich": { code: false, autonomy: true }, // fast skill, but renames the card .md via Bash
  "harness-grill": { code: false, autonomy: false }, // writes questions; human-in-the-loop, no Bash advance
  "harness-interview": { code: false, autonomy: true }, // advances via `bun packages/storymap-ui/scripts/advance-card.ts` (Bash)
  "harness-tasks": { code: false, autonomy: false },
  "harness-prioritize": { code: false, autonomy: false },
  "harness-plan": { code: false, autonomy: false },
  "harness-ux": { code: false, autonomy: true }, // advances via `bun packages/storymap-ui/scripts/advance-card.ts` (Bash)
  "harness-ui": { code: false, autonomy: true }, // advances via `bun packages/storymap-ui/scripts/advance-card.ts` (Bash)
  "harness-do": { code: true, autonomy: true },
  "harness-review": { code: true, autonomy: true },
  "harness-qa": { code: true, autonomy: true },
  "harness-refine": { code: true, autonomy: true },
  "harness-fix": { code: true, autonomy: true },
  "harness-retire": { code: true, autonomy: true },
  "harness-sync-card": { code: true, autonomy: true },
  // WS-10 — the column-less semantic judge: reads/edits code in its own fresh worktree, so it is a code
  // skill with full autonomy. Its containment is the WORKTREE (it is never in a checkout of stage/main),
  // not the permission mode — see runner/resolution-judge-spawn.ts.
  "harness-resolve": { code: true, autonomy: true },
};
const ALL_TRIGGERS = Object.keys(TRIGGER_POLICY) as TriggerId[];

describe("harness-sync-card — per-card sync trigger wiring", () => {
  it("maps to the /harness-sync-card headless command", () => {
    expect(SYNC_TRIGGER).toBe("harness-sync-card");
    expect(commandForTrigger("harness-sync-card")).toBe("/harness-sync-card");
  });

  it("is a code skill (no fast watchdog — it diagnoses the live codebase)", () => {
    expect(isCodeSkill("harness-sync-card")).toBe(true);
  });

  it("needs full autonomy (runs read-only Bash diagnosis + edits the card .md)", () => {
    expect(needsFullAutonomy("harness-sync-card")).toBe(true);
  });

  it("every TriggerId has a /<skill> command (coverage lock)", () => {
    for (const t of ALL_TRIGGERS) {
      expect(commandForTrigger(t)).toBe(`/${t}`);
    }
  });
});

describe("per-trigger policy — isCodeSkill / needsFullAutonomy across the WHOLE union", () => {
  // The previous lock only asserted harness-sync-card; the 11 others (incl. the code
  // skills harness-qa/harness-fix/harness-retire and the data skills) were unverified. A code
  // skill wrongly classified as fast gets the 6-min watchdog and is killed mid-run.
  for (const [trigger, expected] of Object.entries(TRIGGER_POLICY) as [TriggerId, { code: boolean; autonomy: boolean }][]) {
    it(`${trigger}: isCodeSkill=${expected.code}, needsFullAutonomy=${expected.autonomy}`, () => {
      expect(isCodeSkill(trigger)).toBe(expected.code);
      expect(needsFullAutonomy(trigger)).toBe(expected.autonomy);
    });
  }

  it("harness-enrich is the asymmetric case: a FAST skill that still needs full autonomy", () => {
    // It renames the card file (rm/mv via Bash) during refinement, so it must NOT
    // get the fast watchdog removed (it's fast) yet DOES need skip-permissions.
    expect(isCodeSkill("harness-enrich")).toBe(false);
    expect(needsFullAutonomy("harness-enrich")).toBe(true);
  });
});

describe("SYNC_STATUS_DEF — capable run regardless of the card's column", () => {
  it("resolves to --model opus --effort high (fixed, column-independent)", () => {
    expect(resolveColumnArgs(SYNC_STATUS_DEF, DEFAULT_RUNNER_SETTINGS)).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });

  it("carries costGuard so the code-skill watchdog has a ceiling when doMs is off", () => {
    expect(SYNC_STATUS_DEF.costGuard).toBe(true);
  });
});
