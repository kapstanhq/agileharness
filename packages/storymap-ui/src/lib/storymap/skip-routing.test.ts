import { describe, expect, it } from "vitest";
import {
  isAmbiguousRouting,
  isDispensable,
  isDispensableForRefine,
  isLoadBearing,
  LOAD_BEARING_STEP_PREFIXES,
  resolveRouteProfile,
  routeSkip,
  routeSkipsValidationError,
} from "./skip-routing";
import type { RoutableCard } from "./skip-routing";
import { statusSkipsForType } from "./pipeline-routing";
import type { ImprovementKind, StoryType } from "./frameworks";
import type { RouteProfile, StatusDef } from "./types";

// The instance-aware skip router (story-rl5v03). It must:
//   - preserve the static storyType base byte-for-byte for every non-reopen / non-user case;
//   - skip the discovery interview for a refine/fix `user` story (Q1/Q3);
//   - skip the design block for a TEXT/BEHAVIOUR-only refine, KEEP it for a visual refine (Q5);
//   - treat a persisted card.routing.skips as authoritative (Q2/AC4);
//   - flag ONLY a mixed-kind refine as ambiguous (the only case the light agent is reached for).

const SKIP_TYPES: StoryType[] = ["technical", "chore", "spike", "bug"];

// The real design+ready steps the way _base declares them (skipForTypes + column).
const designUx: StatusDef = { id: "design-ux", name: "Jornada", column: "prepare", skipForTypes: SKIP_TYPES };
const designUi: StatusDef = { id: "design-ui", name: "Telas", column: "prepare", skipForTypes: SKIP_TYPES };
const comDesign: StatusDef = { id: "com-design", name: "Aprovar design", column: "prepare", skipForTypes: SKIP_TYPES };
const ready: StatusDef = { id: "ready", name: "Pronto p/ dev", column: "construcao", skipForTypes: SKIP_TYPES };
const interview: StatusDef = { id: "interview", name: "Entrevista", column: "discovery", skipForTypes: SKIP_TYPES };
const plano: StatusDef = { id: "plano-tecnico", name: "Plano & Tarefas", column: "construcao", trigger: "harness-plan" };
const desenvolver: StatusDef = { id: "desenvolver", name: "Desenvolver", column: "in-progress", gate: "hasTasks" };
const qa: StatusDef = { id: "qa-automatizado", name: "QA automatizado", column: "in-progress", trigger: "harness-qa" };

const DESIGN_BLOCK = [designUx, designUi, comDesign, ready];

const card = (over: Partial<RoutableCard> = {}): RoutableCard => ({
  storyType: "user",
  ...over,
});

const refine = (kinds: ImprovementKind[]): RoutableCard =>
  card({ mode: "refine", refinement: { brief: "x", kinds, target: null, screenshot: null, openedAt: null } });

describe("isDispensableForRefine", () => {
  it("is true for each design-block + ready step (declares skipForTypes, prepare/ready column)", () => {
    for (const s of DESIGN_BLOCK) expect(isDispensableForRefine(s)).toBe(true);
  });

  it("is FALSE for interview (it has its own mode-based rule, not the design-class one)", () => {
    expect(isDispensableForRefine(interview)).toBe(false);
  });

  it("is false for a step that declares NO skipForTypes (a build/discovery step)", () => {
    expect(isDispensableForRefine(plano)).toBe(false);
    expect(isDispensableForRefine(desenvolver)).toBe(false);
  });

  it("backs the column heuristic with the stable id fallback (no column field)", () => {
    // A design step whose `column` was dropped is still caught by its id in the fallback set.
    const orphan: StatusDef = { id: "com-design", name: "Aprovar", skipForTypes: SKIP_TYPES };
    expect(isDispensableForRefine(orphan)).toBe(true);
  });
});

describe("routeSkip — static base preserved (regression: non-user / non-reopen byte-identical)", () => {
  it.each(SKIP_TYPES)("a %s build story is identical to statusSkipsForType for every step", (t) => {
    for (const s of [interview, ...DESIGN_BLOCK, plano, desenvolver]) {
      expect(routeSkip(s, card({ storyType: t }))).toBe(statusSkipsForType(s, t));
    }
  });

  it("AC3: a bug skips the interview via the static base (unchanged path)", () => {
    expect(routeSkip(interview, card({ storyType: "bug" }))).toBe(true);
    // …and the base also skips the whole design block for it.
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, card({ storyType: "bug" }))).toBe(true);
  });

  it("a plain user BUILD story skips NOTHING (no reopen mode → only the base, which is false)", () => {
    for (const s of [interview, ...DESIGN_BLOCK, plano, desenvolver]) {
      expect(routeSkip(s, card({ storyType: "user" }))).toBe(false);
    }
  });

  it("a null storyType (activity/step/legacy) is never skipped by the explicit skipForTypes", () => {
    expect(routeSkip(designUx, card({ storyType: null }))).toBe(false);
  });
});

describe("routeSkip — reopen overrides (user stories)", () => {
  it("Q1: a refine[functionality] user story SKIPS the interview AND the whole design block (AC1)", () => {
    const c = refine(["functionality"]);
    expect(routeSkip(interview, c)).toBe(true);
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(true);
    // …but never a build step.
    expect(routeSkip(plano, c)).toBe(false);
    expect(routeSkip(desenvolver, c)).toBe(false);
  });

  it("a refine[copy] user story also skips interview + design (copy is non-visual too)", () => {
    const c = refine(["copy"]);
    expect(routeSkip(interview, c)).toBe(true);
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(true);
  });

  it("AC2: a refine[ui] user story KEEPS the design block but still skips the interview (Q1)", () => {
    const c = refine(["ui"]);
    expect(routeSkip(interview, c)).toBe(true); // a refine skips discovery regardless of kind
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(false); // visual → design runs
  });

  it("a refine[ux] user story keeps the design block (ux is visual)", () => {
    const c = refine(["ux"]);
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(false);
  });

  it("a refine with MIXED kinds [ui, functionality] keeps the design block (any visual kind wins)", () => {
    const c = refine(["ui", "functionality"]);
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(false);
    expect(routeSkip(interview, c)).toBe(true);
  });

  it("a fix user story skips the interview (already-validated scope) but touches no design (no kinds)", () => {
    const c = card({ mode: "fix" });
    expect(routeSkip(interview, c)).toBe(true);
    // fix has no refinement.kinds → the design-skip rule (refine-only) never fires.
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(false);
  });

  it("a refine with empty/defaulted kinds keeps the design block (conservative: ['ux'] default is visual)", () => {
    // coerceRefinement defaults missing kinds to ['ux'] — a visual kind, so design runs (the safe choice).
    const c = refine(["ux"]);
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(false);
  });
});

describe("routeSkip — card.routing.skips is AUTHORITATIVE (AC4 / Q2 — agent or rules decision wins)", () => {
  it("a persisted skip forces a step to be skipped even when the rules wouldn't", () => {
    // A user BUILD story normally skips NOTHING, but an explicit per-instance decision overrides.
    const c = card({
      storyType: "user",
      routing: { skips: ["design-ux", "design-ui"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    expect(routeSkip(designUx, c)).toBe(true);
    expect(routeSkip(designUi, c)).toBe(true);
    // A step NOT in the list still follows the rules (here: not skipped).
    expect(routeSkip(comDesign, c)).toBe(false);
    expect(routeSkip(plano, c)).toBe(false);
  });

  it("1.7 — does NOT eject a card RESTING at a status its OWN route skips (human placement wins)", () => {
    // A human deliberately moved this card INTO design-ux even though its route lists design-ux as skipped
    // (e.g. to force-run that step for this one card). routeSkip must return FALSE for the card's OWN current
    // status so decideCascade never forwards it past — the explicit placement is respected. Mirrors the Q5
    // refine guard (status.id !== card.status).
    const c = card({
      storyType: "user",
      status: "design-ux",
      routing: { skips: ["design-ux", "design-ui"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    expect(routeSkip(designUx, c)).toBe(false); // resting HERE → NOT skipped (not ejected)
    // the skip STILL applies to a FUTURE candidate the card is not resting at (the cascade still bypasses it):
    expect(routeSkip(designUi, c)).toBe(true);
  });

  it("the persisted decision can WIDEN a visual refine to skip design for this instance", () => {
    // A refine[ui] keeps design by the rules; the agent decided this mixed instance skips it.
    const c = refine(["ui"]);
    c.routing = { skips: ["design-ux", "design-ui", "com-design", "ready"], decidedBy: "agent", decidedAt: "2026-06-16" };
    for (const s of DESIGN_BLOCK) expect(routeSkip(s, c)).toBe(true);
  });

  // story-rl5v03 (MEDIUM): the authoritative override is constrained to DISPENSABLE steps. A buggy or
  // over-broad persisted skip set must NEVER bypass a load-bearing build/QA step — skipping
  // `desenvolver` would ship a story with no implementation; skipping `qa-automatizado` would ship it
  // unverified. The override can only ever DROP an optional design/interview step, never real work.
  it("the persisted skip is IGNORED for a load-bearing build step (desenvolver / plano-tecnico)", () => {
    const c = card({
      storyType: "user",
      routing: { skips: ["desenvolver", "plano-tecnico"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    // A user build story would normally traverse these — and the persisted skip CANNOT override that.
    expect(routeSkip(desenvolver, c)).toBe(false);
    expect(routeSkip(plano, c)).toBe(false);
  });

  it("the persisted skip is IGNORED for a QA step (cannot ship a story unverified)", () => {
    const c = card({
      storyType: "user",
      routing: { skips: ["qa-automatizado"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    expect(routeSkip(qa, c)).toBe(false);
  });

  it("a mixed (over-broad) persisted set still skips the DISPENSABLE entries while ignoring the build ones", () => {
    // The set names a dispensable design step AND a build step; only the design step is honored.
    const c = card({
      storyType: "user",
      routing: { skips: ["design-ux", "desenvolver"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    expect(routeSkip(designUx, c)).toBe(true); // dispensable → honored
    expect(routeSkip(desenvolver, c)).toBe(false); // load-bearing → ignored
  });

  it("the persisted skip IS honored for the interview (a dispensable discovery step)", () => {
    // interview is dispensable for a reopen; an explicit persisted skip is allowed to drop it.
    const c = card({
      storyType: "user",
      routing: { skips: ["interview"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    expect(routeSkip(interview, c)).toBe(true);
  });
});

describe("isAmbiguousRouting — the LLM is reached ONLY for a genuinely mixed-kind refine", () => {
  it("is TRUE only for a refine mixing a visual and a non-visual kind", () => {
    expect(isAmbiguousRouting(refine(["ui", "functionality"]))).toBe(true);
    expect(isAmbiguousRouting(refine(["ux", "copy"]))).toBe(true);
  });

  it("is FALSE for a single-visual-kind refine", () => {
    expect(isAmbiguousRouting(refine(["ui"]))).toBe(false);
    expect(isAmbiguousRouting(refine(["ux"]))).toBe(false);
  });

  it("is FALSE for a single-non-visual-kind refine", () => {
    expect(isAmbiguousRouting(refine(["functionality"]))).toBe(false);
    expect(isAmbiguousRouting(refine(["copy"]))).toBe(false);
  });

  it("is FALSE for two non-visual kinds (no visual to weigh)", () => {
    expect(isAmbiguousRouting(refine(["copy", "functionality"]))).toBe(false);
  });

  it("is FALSE for a bug/fix, a plain build, and a non-user story (never ambiguous)", () => {
    expect(isAmbiguousRouting(card({ mode: "fix" }))).toBe(false);
    expect(isAmbiguousRouting(card({ storyType: "user" }))).toBe(false);
    expect(isAmbiguousRouting(card({ storyType: "bug" }))).toBe(false);
  });
});

// ── WS4 — declarative dispensability facet + LOAD_BEARING kernel invariant ─────────────────────────
describe("isLoadBearing (WS4)", () => {
  it("is true for each load-bearing prefix (exact id or prefix match)", () => {
    expect(isLoadBearing("plano-tecnico")).toBe(true);
    expect(isLoadBearing("desenvolver")).toBe(true);
    expect(isLoadBearing("revisar-codigo")).toBe(true);
    expect(isLoadBearing("qa-automatizado")).toBe(true); // qa- is a PREFIX (every QA station)
    expect(isLoadBearing("qa-manual")).toBe(true);
  });
  it("is false for dispensable/discovery steps", () => {
    for (const id of ["interview", "design-ux", "design-ui", "com-design", "ready", "priorizar"]) {
      expect(isLoadBearing(id)).toBe(false);
    }
  });
  it("the prefix list is the documented invariant (guards against silent edits)", () => {
    expect([...LOAD_BEARING_STEP_PREFIXES]).toEqual(["plano-tecnico", "desenvolver", "revisar-codigo", "qa-"]);
  });
});

describe("isDispensable (WS4 facet + fallback + load-bearing guard)", () => {
  it("is true for a step that declares dispensable:true (the facet)", () => {
    const priorizar: StatusDef = { id: "priorizar", name: "Priorizar", dispensable: true };
    expect(isDispensable(priorizar)).toBe(true);
  });
  it("NEVER true for a load-bearing step, even with a malicious dispensable:true", () => {
    const evil: StatusDef = { id: "desenvolver", name: "Desenvolver", dispensable: true };
    expect(isDispensable(evil)).toBe(false); // load-bearing guard wins over dispensable:true
    const evilQa: StatusDef = { id: "qa-automatizado", name: "QA", dispensable: true };
    expect(isDispensable(evilQa)).toBe(false);
  });
  it("falls back to the legacy heuristic for boards WITHOUT the facet (interview + design block)", () => {
    expect(isDispensable(interview)).toBe(true); // discovery interview (legacy rule)
    for (const s of DESIGN_BLOCK) expect(isDispensable(s)).toBe(true);
  });
  it("is false for an ordinary non-dispensable, non-load-bearing step", () => {
    const plain: StatusDef = { id: "capturar", name: "Capturar" };
    expect(isDispensable(plain)).toBe(false);
  });
});

describe("routeSkip — WS4 facet honoured; load-bearing skip IGNORED", () => {
  const withSkips = (skips: string[]): RoutableCard =>
    card({ routing: { skips, decidedBy: "agent", decidedAt: "2026-07-10" } });

  it("honours routing.skips for a dispensable:true step (express profile skips priorizar)", () => {
    const priorizar: StatusDef = { id: "priorizar", name: "Priorizar", dispensable: true };
    expect(routeSkip(priorizar, withSkips(["priorizar"]))).toBe(true);
  });

  it("IGNORES routing.skips for a load-bearing step even with dispensable:true (LOAD_BEARING wins)", () => {
    const evil: StatusDef = { id: "desenvolver", name: "Desenvolver", dispensable: true };
    // A malicious/buggy routing.skips can never drop the implementation.
    expect(routeSkip(evil, withSkips(["desenvolver"]))).toBe(false);
    const evilQa: StatusDef = { id: "qa-automatizado", name: "QA", trigger: "harness-qa", dispensable: true };
    expect(routeSkip(evilQa, withSkips(["qa-automatizado"]))).toBe(false);
  });

  it("keeps the legacy fallback intact for a board with NO facet (design block via skipForTypes)", () => {
    // A user story with routing.skips over the design block (no dispensable facet) is still honoured.
    expect(routeSkip(designUx, withSkips(["design-ux"]))).toBe(true);
  });

  it("a skip for a step that is neither dispensable nor load-bearing falls through to the base rules", () => {
    const plain: StatusDef = { id: "capturar", name: "Capturar" };
    // Not dispensable → Layer 2 ignores it; base (user story, no skipForTypes) → not skipped.
    expect(routeSkip(plain, withSkips(["capturar"]))).toBe(false);
  });
});

describe("routeSkipsValidationError (WS4 — server-side validation for set_card_route)", () => {
  const priorizar: StatusDef = { id: "priorizar", name: "Priorizar", dispensable: true };
  const statuses: StatusDef[] = [interview, ...DESIGN_BLOCK, priorizar, plano, desenvolver, qa];

  it("null (valid) for a set of dispensable steps", () => {
    expect(routeSkipsValidationError(["priorizar", "design-ux"], statuses)).toBeNull();
    expect(routeSkipsValidationError([], statuses)).toBeNull();
  });

  it("rejects an unknown step id", () => {
    expect(routeSkipsValidationError(["ghost"], statuses)).toMatch(/desconhecido/);
  });

  it("rejects a load-bearing step (structured error naming it)", () => {
    expect(routeSkipsValidationError(["desenvolver"], statuses)).toMatch(/load-bearing/);
    expect(routeSkipsValidationError(["qa-automatizado"], statuses)).toMatch(/load-bearing/);
  });

  it("rejects a known-but-not-dispensable step", () => {
    // plano-tecnico is load-bearing (caught first); use a plain non-dispensable step.
    const plain: StatusDef = { id: "capturar", name: "Capturar" };
    expect(routeSkipsValidationError(["capturar"], [...statuses, plain])).toMatch(/não é dispensável/);
  });
});

describe("resolveRouteProfile (4.2 — materialize a named profile to skips/caps)", () => {
  const profiles: Record<string, RouteProfile> = {
    express: { skips: ["priorizar", "design-ux"], modelCap: "sonnet", effortCap: "low", description: "trivial" },
    lean: { skips: ["priorizar"] },
  };

  it("returns the profile's skips + caps for a known name", () => {
    expect(resolveRouteProfile("express", profiles)).toEqual({ skips: ["priorizar", "design-ux"], modelCap: "sonnet", effortCap: "low" });
  });
  it("omits caps a profile doesn't declare", () => {
    expect(resolveRouteProfile("lean", profiles)).toEqual({ skips: ["priorizar"] });
  });
  it("returns null for an unknown name / undefined name / undefined profiles", () => {
    expect(resolveRouteProfile("missing", profiles)).toBeNull();
    expect(resolveRouteProfile(undefined, profiles)).toBeNull();
    expect(resolveRouteProfile("express", undefined)).toBeNull();
  });
  it("returns a COPY of skips (mutating the result must not corrupt the profile)", () => {
    const r = resolveRouteProfile("lean", profiles)!;
    r.skips.push("x");
    expect(profiles.lean.skips).toEqual(["priorizar"]);
  });
});
