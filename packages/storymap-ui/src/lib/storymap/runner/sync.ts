// Per-card "Sincronizar" — constants for the on-demand card-reconciliation run.
//
// Unlike the pipeline skills (which are tied to a column via `StatusDef.trigger`
// and run while a card SITS in that status), `harness-sync-card` runs ON DEMAND on a
// SINGLE card from the per-card button, REGARDLESS of which column the card is in
// (incl. cards with no column trigger at all). It reuses the SAME runner engine
// (concurrency cap + in-flight lock + registry + live console + `claude --resume`)
// as the autorun pipeline — see engine.ts / actions.ts `syncCardAction`.

import type { StatusDef, TriggerId } from "@/lib/storymap/types";

/** The trigger id for the per-card sync run (IS the headless skill name). */
export const SYNC_TRIGGER: TriggerId = "harness-sync-card";

/**
 * Synthetic StatusDef used SOLELY to resolve the sync run's column args
 * (`--model`/`--effort`) via resolveColumnArgs. The sync agent diagnoses the LIVE
 * codebase (read-only Bash + Grep/Read) to reconcile the card, so it needs a
 * capable model and has an unpredictable duration — hence opus/high + costGuard
 * (the engine treats sync as a CODE skill: no fast watchdog; costGuard supplies a
 * generous ceiling when the global code-skill watchdog is off). This is FIXED so a
 * card's sync cost/capability never depends on which column it happens to sit in
 * (a `triage` card has no policy of its own). The id is a non-pipeline sentinel.
 */
export const SYNC_STATUS_DEF: StatusDef = {
  id: "__sync__",
  name: "Sincronizar",
  model: "opus",
  effort: "high",
  costGuard: true,
};
