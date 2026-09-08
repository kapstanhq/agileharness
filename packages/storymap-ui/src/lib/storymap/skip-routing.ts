// Instance-aware skip routing — the PURE layer that decides, per CARD instance, which build-cascade
// steps it bypasses. It generalises the static, storyType-only `statusSkipsForType`
// (pipeline-routing.ts) to also read the card's `mode` + `refinement.kinds`, so a REOPENED refine
// of a `user` story whose kinds are purely TEXT/BEHAVIOUR (copy/functionality) skips the discovery
// interview AND the whole design block — the SM-1 token waste (it would otherwise burn a harness-interview
// + harness-ux + harness-ui spawn each on work that needs no discovery or wireframe).
//
// DESIGN (2026 cost-efficient agent routing — deterministic rules FIRST, an LLM only for genuine
// ambiguity, with a deterministic safeguard):
//   LAYER 1 — pure deterministic rules cover ~all real cases at ZERO tokens (this module);
//   LAYER 2 — a per-card persisted decision (`card.routing.skips`) is consulted FIRST and is
//             authoritative for the steps it lists — the seam where a light agent's verdict lands;
//   LAYER 3 — the light agent (the EXISTING harness-refine skill) POPULATES `card.routing` out-of-band,
//             ONLY for the genuinely AMBIGUOUS case (`isAmbiguousRouting`). It NEVER runs inside this
//             kernel: storymap-ui has no in-process LLM SDK; the only LLM path is a headless `claude -p`
//             spawn (runner/engine.ts), so the agent decision MUST be precomputed/persisted and the
//             pure kernel only ever reads a boolean. Keep this module PURE — no IO, no LLM.
//
// Decisions honour the answered grill on story-rl5v03: Q1 a refine/fix skips the interview (already
// validated scope); Q3 a bug keeps skipping the interview (unchanged static path); Q5
// kinds⊆{copy,functionality} → skip the design block, any visual kind (ui|ux) → keep it; Q2 the per
// instance decision is agent/rules-driven, not declared in board.yaml.

import { isVisualKind } from "./frameworks";
import type { ImprovementKind } from "./frameworks";
import { statusSkipsForType } from "./pipeline-routing";
import type { Card, CardMode, EffortLevel, ModelTier, RouteProfile, StatusDef, TriggerId } from "./types";

/** The minimal card facet the instance-aware router reads — keeps the kernel decoupled from the full Card.
 *  `status` is OPTIONAL: present (decideCascade passes the full card) it powers the own-destination guard
 *  (a reopen never auto-skips its chosen destination); absent (legacy synthetic callers) the guard is a
 *  no-op and behaviour is byte-identical to before the guard. */
export type RoutableCard = Pick<Card, "storyType" | "mode" | "refinement" | "routing"> & {
  status?: Card["status"];
};

/**
 * MODE → reopen skill. A card REOPENED for refine/fix (story reabertura, R1) runs its DEDICATED skill
 * (harness-refine|harness-fix) on its FIRST pass in the build column the operator reopened it into. `build` (the
 * normal pipeline) and `retire` (its own executor column) never override. Consumed by {@link triggerForCard}.
 */
const MODE_TRIGGERS: Partial<Record<CardMode, TriggerId>> = { refine: "harness-refine", fix: "harness-fix" };

/**
 * The EFFECTIVE trigger for a card sitting in a status. The reopen skill (harness-refine/harness-fix) overrides
 * the column's own `statusTrigger` ONLY while the ONE-SHOT `reopenPending` flag is set — i.e. the reopen's
 * FIRST pass at the chosen destination. The skill clears `reopenPending` on that pass (keeping `mode`), so
 * EVERY subsequent column runs its OWN mode-aware trigger (harness-do/harness-review/harness-qa). This is load-bearing:
 * `mode` PERSISTS through the whole fix/refine flow (harness-qa is the only station that clears it), so a
 * non-one-shot override would hijack harness-do/harness-review/harness-qa on every downstream column. PURE — reads only
 * `mode` + `reopenPending`. The cascade's suppress guard keys on THIS result, so a just-ran reopen skill is
 * not re-fired before it advances.
 */
export function triggerForCard(card: Pick<Card, "mode" | "reopenPending">, statusTrigger: TriggerId): TriggerId {
  if (!card.reopenPending) return statusTrigger;
  const override = card.mode ? MODE_TRIGGERS[card.mode] : undefined;
  return override ?? statusTrigger;
}

/**
 * The discovery step a refine/fix always skips — its scope was already validated when the story
 * shipped, so re-running the 3-persona interview is pure token waste (Q1/Q3). Stable in `_base`.
 */
const INTERVIEW_STATUS_ID = "interview";

/**
 * The DESIGN-block + ready step ids a TEXT/BEHAVIOUR-only refine dispenses with (Q5). Used as the
 * stable fallback backing the data-driven `column`-based detection in {@link isDispensableForRefine}
 * (so the heuristic still fires if a board reorganises its columns). Mirrors the design steps that
 * declare `skipForTypes` in `_base/board.yaml`.
 */
const DISPENSABLE_DESIGN_STATUS_IDS = ["design-ux", "design-ui", "com-design", "ready"] as const;

/**
 * WS4 — the KERNEL INVARIANT: step-id prefixes that are LOAD-BEARING and can NEVER be skipped by a card's
 * `routing.skips`, even if a board.yaml accidentally (or maliciously) marks one `dispensable:true`. These
 * are the steps whose omission would silently ship broken work — the technical plan, the implementation,
 * the code review, and any QA station. {@link isLoadBearing} matches by exact id OR prefix (so `qa-` covers
 * every QA station id). Defense-in-depth: a board-integrity lint ALSO rejects `dispensable:true` on these,
 * but the kernel enforces it regardless of the lint so an unlinted/hand-edited board is still safe.
 */
export const LOAD_BEARING_STEP_PREFIXES = ["plano-tecnico", "desenvolver", "revisar-codigo", "qa-"] as const;

/** Is `statusId` a LOAD-BEARING step (see {@link LOAD_BEARING_STEP_PREFIXES})? Matches exact id or prefix
 *  (so `qa-` catches `qa-automatizado`). PURE. */
export function isLoadBearing(statusId: string): boolean {
  return LOAD_BEARING_STEP_PREFIXES.some((p) => statusId === p || statusId.startsWith(p));
}

/**
 * WS4 — is `status` DISPENSABLE for per-instance routing (a card's `routing.skips` may bypass it)? The
 * declarative generalisation of {@link isDispensableForRefine}: a step is dispensable when it explicitly
 * declares `dispensable:true` (the WS4 facet, marked on interview/design/ready/priorizar in `_base`), with
 * the LEGACY heuristic (the design block + the discovery interview) kept as the fallback so a board WITHOUT
 * the facet (orbit opt-out, or any board before the migration lands) behaves byte-identically. A
 * LOAD-BEARING step ({@link isLoadBearing}) is NEVER dispensable — this guard wins over an accidental
 * `dispensable:true`, so an over-broad/buggy `routing.skips` can never drop the implementation or QA. PURE.
 */
export function isDispensable(status: StatusDef): boolean {
  if (isLoadBearing(status.id)) return false; // load-bearing wins over any dispensable:true (defense in depth)
  if (status.dispensable === true) return true; // declarative facet (WS4)
  // legacy fallback for boards without the facet: the discovery interview + the dispensable design block.
  return status.id === INTERVIEW_STATUS_ID || isDispensableForRefine(status);
}

/**
 * WS4 — the DESIGN-WORK step ids whose skip on a UI-bearing card signals an under-dimensioned route (the
 * `ready` buffer is excluded — it's not design work). Used by {@link isRouteUndersized}.
 */
const DESIGN_WORK_STATUS_IDS = ["design-ux", "design-ui", "com-design"] as const;

/**
 * WS4 (furo do juiz #1) — is this card's ROUTE under-dimensioned? True when the card declares UI surface
 * (`hasUiSurface`) yet its persisted `routing.skips` bypassed a DESIGN-WORK step — the mismatch an
 * `express`-style route can create (a trivial route on a card that actually needs wireframes). PURE, on the
 * card alone (the design ids are stable) → drives the SOFT `route-undersized` advisory. Returns the skipped
 * design step ids (empty ⇒ not undersized) so the finding can name them.
 */
export function routeUndersizedSkips(card: Pick<Card, "hasUiSurface" | "routing">): string[] {
  if (card.hasUiSurface !== true) return [];
  const skips = card.routing?.skips ?? [];
  return skips.filter((id) => (DESIGN_WORK_STATUS_IDS as readonly string[]).includes(id));
}

/** Convenience boolean over {@link routeUndersizedSkips}. PURE. */
export function isRouteUndersized(card: Pick<Card, "hasUiSurface" | "routing">): boolean {
  return routeUndersizedSkips(card).length > 0;
}

/**
 * WS4 — server-side VALIDATION for a human route override (set_card_route): every requested skip must be a
 * REAL step, must be DISPENSABLE, and can NEVER be LOAD-BEARING. Returns a structured error string for the
 * FIRST offending id, or null when the whole set is valid. PURE (takes the board's status list) — the same
 * predicates the kernel enforces, surfaced early with a human-readable reason so the drawer/MCP rejects a
 * bad skip instead of silently persisting a set the kernel would then ignore. Exported for tests.
 */
export function routeSkipsValidationError(skips: readonly string[], statuses: readonly StatusDef[]): string | null {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  for (const id of skips) {
    const st = byId.get(id);
    if (!st) return `Step desconhecido: "${id}".`;
    if (isLoadBearing(id)) {
      return `Step load-bearing não pode ser pulado: "${id}" (plano/dev/review/QA são obrigatórios).`;
    }
    if (!isDispensable(st)) {
      return `Step "${id}" não é dispensável — só passos marcados dispensable podem ser pulados.`;
    }
  }
  return null;
}

/**
 * Fase 4.2 — resolve a named {@link RouteProfile} to its concrete skips + caps, so the WRITE path
 * (setCardRouteAction) and the drawer preview MATERIALIZE the profile identically. A profile is authoring
 * sugar: the runner reads `card.routing.skips`/`modelCap`/`effortCap` DIRECTLY (never the profile name), so a
 * route stamped with ONLY `profile` is INERT until its skips/caps are copied onto the card. Returns null for
 * an absent/unknown name. PURE (no IO). Exported for the action + tests.
 */
export function resolveRouteProfile(
  name: string | undefined,
  profiles: Record<string, RouteProfile> | undefined,
): { skips: string[]; modelCap?: ModelTier; effortCap?: EffortLevel } | null {
  const p = name ? profiles?.[name] : undefined;
  if (!p) return null;
  return {
    skips: [...p.skips],
    ...(p.modelCap ? { modelCap: p.modelCap } : {}),
    ...(p.effortCap ? { effortCap: p.effortCap } : {}),
  };
}

/**
 * Is this card in a REOPEN mode whose scope is already validated (refine/fix), so the discovery
 * interview is dispensable? (A plain `build` runs discovery in full; `retire` never reaches the
 * build cascade.) PURE.
 */
function reopenSkipsInterview(card: RoutableCard): boolean {
  return card.mode === "refine" || card.mode === "fix";
}

/** The refinement's kinds (defaults to [] when absent so callers don't juggle null). */
function refineKinds(card: RoutableCard): ImprovementKind[] {
  return card.refinement?.kinds ?? [];
}

/** Does this refine touch ANY visual kind (ui|ux)? A visual kind means the design block must run (Q5). */
function hasVisualKind(card: RoutableCard): boolean {
  return refineKinds(card).some(isVisualKind);
}

/** Does this refine touch ANY non-visual kind (copy|functionality)? */
function hasNonVisualKind(card: RoutableCard): boolean {
  return refineKinds(card).some((k) => !isVisualKind(k));
}

/**
 * Is `status` a DISPENSABLE design-class step a TEXT/BEHAVIOUR-only refine should skip? Data-driven:
 * a step that DECLARES `skipForTypes` is, by definition, an optional/dispensable step (the only steps that
 * do so in `_base` are the design block in the `prepare` column + the `ready` buffer). It is dispensable if
 * it sits in the `prepare` column OR its id is in the stable {@link DISPENSABLE_DESIGN_STATUS_IDS} fallback
 * (which still catches `ready` — since the 6-column redesign it lives in the `construcao` column, so the id
 * fallback, not the column, covers it). The `interview` step is handled by its OWN rule, not here. PURE.
 */
export function isDispensableForRefine(status: StatusDef): boolean {
  if (!status.skipForTypes || status.skipForTypes.length === 0) return false;
  if (status.id === INTERVIEW_STATUS_ID) return false; // interview has its own (mode-based) rule
  const byColumn = status.column === "prepare";
  const byId = (DISPENSABLE_DESIGN_STATUS_IDS as readonly string[]).includes(status.id);
  return byColumn || byId;
}

/**
 * Should THIS card instance SKIP `status` in the build cascade? The instance-aware generalisation of
 * {@link statusSkipsForType} — it layers per-card `mode`/`kinds` overrides ON TOP of the static
 * storyType base, so non-reopen / non-user behaviour stays byte-identical. PURE.
 *
 *   1) a persisted per-instance decision (`card.routing.skips`) is AUTHORITATIVE for the listed steps
 *      (the seam where a light agent / the rules wrote the verdict the kernel reads) — but ONLY for
 *      DISPENSABLE steps (the design block / ready, or the discovery interview). It can NEVER skip a
 *      load-bearing build/QA step (desenvolver / plano-tecnico / qa-*), so an over-broad or buggy
 *      persisted set cannot quietly drop work — the worst it can do is keep an optional step;
 *   2) the static base verdict (storyType × skipForTypes, incl. the UI_DESIGN_STATUSES fallback) —
 *      preserves every current behaviour (bug skips interview via skipForTypes; non-user skips design);
 *   3) reopen overrides for `user` stories (non-user already short-circuits via the base):
 *        - a refine/fix skips the `interview` step (Q1/Q3 — already-validated scope);
 *        - a refine with NO visual kind (kinds ⊆ {copy,functionality}) skips the dispensable design
 *          block (Q5 — functionality needs no wireframe); a refine with ANY visual kind keeps it.
 */
export function routeSkip(status: StatusDef, card: RoutableCard): boolean {
  // Layer 2: a persisted per-instance decision wins for the steps it names — but ONLY for steps that are
  // actually DISPENSABLE ({@link isDispensable}: the WS4 `dispensable:true` facet, or the legacy design
  // block / discovery interview). The authoritative override is deliberately constrained so a buggy or
  // over-broad `routing.skips` (or a named RouteProfile that lists a step it shouldn't) can NEVER bypass a
  // LOAD-BEARING build or QA step (plano-tecnico / desenvolver / revisar-codigo / qa-*) — isDispensable
  // returns false for those regardless of any `dispensable:true`. A skip listed for a non-dispensable step
  // is ignored here and falls through to the deterministic rules below.
  // 1.7 — EXCEPT the card's OWN current status: a human (or a reopen) can deliberately MOVE a card INTO a
  // status its route lists as skipped (e.g. to force-run that step for this one card). The cascade must NOT
  // eject it — decideCascade forwards past a routeSkip'd RESTING status, which would UNDO the explicit human
  // placement. Mirrors the Q5 refine guard below (`status.id !== card.status`): the skip still applies to
  // FUTURE candidates (nextBuildStatus scans idx+1, so a candidate is never card.status there) — only the
  // resting-status decideCascade check is guarded, so a card advancing THROUGH the pipeline still bypasses
  // its route-skips; it just can't be ejected FROM one it was deliberately placed in.
  if (card.routing?.skips?.includes(status.id) && isDispensable(status) && status.id !== card.status) {
    return true;
  }

  // Layer 1 base: the static storyType verdict (also handles every non-user / non-reopen case).
  const base = statusSkipsForType(status, card.storyType);
  if (base) return true;

  // Reopen overrides apply only to `user` stories (non-user is fully covered by the base above).
  if (card.storyType !== "user") return false;

  // Q1/Q3: a refine or fix has already-validated scope → skip the discovery interview.
  if (reopenSkipsInterview(card) && status.id === INTERVIEW_STATUS_ID) return true;

  // Q5: a refine with NO visual kind (copy/functionality only) skips the dispensable design block —
  // EXCEPT the card's OWN current status. A reabertura (R1) lands a refine DIRECTLY in a chosen
  // destination column (e.g. design-ux); the operator's explicit choice must never be auto-skipped, so
  // a refine resting AT a dispensable step stays there (its mode-override skill runs) instead of being
  // forwarded past it. The skip still applies to FUTURE candidates (nextBuildStatus scans idx+1, so
  // candidate.id is never card.status there) — only the resting-status decideCascade check is guarded.
  if (
    card.mode === "refine" &&
    !hasVisualKind(card) &&
    isDispensableForRefine(status) &&
    status.id !== card.status
  ) {
    return true;
  }

  return false;
}

/**
 * Is this card's routing GENUINELY AMBIGUOUS — the only case that warrants the light agent
 * (`harness-refine`) precomputing `card.routing`? True ONLY for a refine whose `kinds` MIX visual and
 * non-visual (e.g. [ui, functionality]): the rules can't tell whether the design block is worth it,
 * so the agent decides per instance. Every clean case — a single-kind refine, a bug/fix, a plain
 * build, a non-user story — is unambiguous and NEVER spawns an agent (the deterministic rules decide
 * it at zero tokens). PURE — the deterministic guard that keeps the LLM reached only for real
 * ambiguity. (A refine with empty/defaulted kinds is NOT ambiguous here: it coerces to the
 * conservative visual default `['ux']`, so the rules keep the design block — the safe choice.)
 */
export function isAmbiguousRouting(card: RoutableCard): boolean {
  if (card.mode !== "refine") return false;
  return hasVisualKind(card) && hasNonVisualKind(card);
}
