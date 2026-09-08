// Pipeline routing — the PURE, storyType-aware advance rules for the build cascade.
//
// The 11-status build pipeline (enriquecer → revisao) was authored for `user`
// stories: it includes a UI-design block (design-ux → com-design) where harness-ux
// designs wireframes and a human picks one (gate hasWireframe), and a QA column
// (qa-automatizado) that proves the acceptance E2E + a headless visual sweep. A
// technical/chore/spike/bug story has NO UI surface — there is nothing to
// wireframe and no screen to sweep — so forcing it through the design block only
// makes a human drag it across by hand (the SM-1 pain that motivated this work).
//
// This module encodes the ONE branch that makes the pipeline storyType-aware:
// which statuses a card of a given storyType actually traverses. The cascade
// kernel (cascade-decision.ts) consumes it to FORWARD a non-user card past the
// design block straight to plano-tecnico; the hasQaPassed gate (gates.ts) already
// lets non-user cards clear QA without an E2E run; and the harness-ux/harness-qa skills
// mirror it in prose (short-circuit + suite-as-QA-gate).

import type { StoryType } from "./frameworks";
import { routeSkip } from "./skip-routing";
import type { RoutableCard } from "./skip-routing";
import type { BoardConfig, StatusDef } from "./types";

/**
 * The UI-design statuses only `user` stories traverse: harness-ux designs wireframes
 * here and a human approves one (gate hasWireframe on `com-design`). A story with
 * no UI surface (technical/chore/spike/bug) skips them — nothing to design.
 */
export const UI_DESIGN_STATUSES = ["design-ux", "com-design"] as const;

/**
 * Does a story of `storyType` need the UI-design columns? Only `user` stories do.
 * Mirrors the `hasQaPassed` gate invariant (`storyType !== "user"` passes freely),
 * so the design-skip and the QA-skip stay in lockstep. A null storyType
 * (activity/step, or an unset legacy story) is treated as non-UI — but in practice
 * only stories reach the build cascade and coerceCard defaults a story to "user".
 */
export function needsUiDesign(storyType: StoryType | null): boolean {
  return storyType === "user";
}

/**
 * Should a card of `storyType` SKIP `statusId` in the build cascade? Legacy,
 * id-based: true only for the hardcoded UI-design statuses when the story has no UI
 * surface (non-`user`). Kept as the BACK-COMPAT fallback for boards that don't yet
 * declare a per-step `skipForTypes` (see {@link statusSkipsForType}).
 */
export function skipsStatusForType(statusId: string, storyType: StoryType | null): boolean {
  return !needsUiDesign(storyType) && (UI_DESIGN_STATUSES as readonly string[]).includes(statusId);
}

/**
 * Data-driven skip: should a card of `storyType` SKIP this STEP in the cascade?
 * Prefers the step's own `skipForTypes` (board.yaml) — true when it lists the card's
 * storyType — and falls back to the hardcoded {@link skipsStatusForType} for steps
 * that declare none (so old boards keep skipping the design block). This is the
 * generalization seam: any step can declare which types bypass it, without touching
 * the kernel. PURE. A null storyType (activity/step — never reaches the cascade in
 * practice) is never matched by an explicit `skipForTypes`, so it traverses.
 */
export function statusSkipsForType(status: StatusDef, storyType: StoryType | null): boolean {
  if (status.skipForTypes && status.skipForTypes.length > 0) {
    return storyType != null && status.skipForTypes.includes(storyType);
  }
  return skipsStatusForType(status.id, storyType);
}

/**
 * The next status `card` advances to from `fromStatusId`, skipping any status this
 * card instance doesn't traverse. The skip decision is INSTANCE-AWARE (routeSkip,
 * skip-routing.ts): it generalises the static storyType×skipForTypes base with the
 * card's `mode`/`refinement.kinds` (a refine/fix skips the discovery interview; a
 * TEXT/BEHAVIOUR-only refine also skips the design block) and the per-instance
 * persisted decision (`card.routing.skips`). Returns the StatusDef + its pipeline
 * index, or null when there is no next status. Monotonic (only ever scans forward
 * from `fromStatusId`) so the cascade still terminates. PURE — no IO, no LLM, no gate
 * evaluation (the caller gate-checks the result; the instance-aware verdict is a
 * precomputed boolean, never an inline model call).
 */
export function nextBuildStatus(
  config: BoardConfig,
  fromStatusId: string,
  card: RoutableCard,
): { status: StatusDef; index: number } | null {
  const idx = config.statuses.findIndex((s) => s.id === fromStatusId);
  if (idx < 0) return null;
  for (let i = idx + 1; i < config.statuses.length; i++) {
    const status = config.statuses[i];
    if (routeSkip(status, card)) continue;
    return { status, index: i };
  }
  return null;
}
