// ADR-063 item 3a SCAFFOLD — not yet wired into engine/_base; see ADR-063 Fase 3.
//
// AcceptanceGateRunner — the ACCEPTANCE layer of the QA ladder, cloned from the proven
// deterministic-runner architecture (merge-queue.ts's IntegrationGateRunner PORT +
// makeDefaultGateRunner). Where the merge gate proves "the suite is green after this branch
// integrates", the acceptance gate proves "each of the card's acceptance[] criteria is
// actually met, at the CHEAPEST layer that can prove it" (verification-ladder.ts routes each
// criterion to component / integration / browser).
//
// Same DI shape as makeDefaultGateRunner: the ACTUAL test execution is INJECTED (`runSpec`),
// so this module is PURE orchestration — zero IO, unit-testable with a fake runSpec. The real
// runSpec (which spins a seeded stack + drives Playwright / a render harness) lands in a later
// Fase; this scaffold only owns the planning (planAcceptance) + the aggregation (run → verdict).

import { planVerification, type VerificationLayer } from "../verification-ladder";

/** One acceptance criterion routed to its verification layer, with an optional authored spec path. */
export interface AcceptanceSpec {
  criterion: string;
  layer: VerificationLayer;
  /** Path to the authored runnable spec, once a later Fase synthesizes it. Absent in the scaffold. */
  specPath?: string;
}

/** Outcome of proving ONE acceptance criterion at its layer. */
export interface AcceptanceResult {
  criterion: string;
  layer: VerificationLayer;
  passed: boolean;
  /** Failure detail (assertion message / stderr tail) — present on a red, optional on a green. */
  detail?: string;
}

/** The verdict over a whole card's acceptance[] — `passed` iff EVERY criterion passed. */
export interface AcceptanceVerdict {
  passed: boolean;
  results: AcceptanceResult[];
}

/**
 * The injectable surface the QA step depends on (DI — like the merge gate's IntegrationGateRunner).
 * A fake in tests drives the aggregation deterministically; the real one executes the specs.
 */
export interface AcceptanceGateRunner {
  run(specs: AcceptanceSpec[], ctx: { cwd: string }): Promise<AcceptanceVerdict>;
}

/**
 * Plan the acceptance gate for a card's whole `acceptance[]`: route each criterion to its cheapest
 * verification layer via the ladder, preserving order + original text. PURE — no spec authoring yet
 * (the scaffold leaves `specPath` undefined; a later Fase synthesizes the runnable specs). Empty in →
 * empty out.
 */
export function planAcceptance(acceptance: string[]): AcceptanceSpec[] {
  return planVerification(acceptance).map(({ criterion, layer }) => ({ criterion, layer }));
}

/**
 * Production {@link AcceptanceGateRunner}. Orchestration ONLY — it runs each planned spec through the
 * INJECTED `runSpec` (mirroring makeDefaultGateRunner's injected `exec`: the actual test execution is
 * a dependency, never imported-and-called here) and aggregates the per-criterion outcomes into a
 * verdict. `passed` is true iff EVERY spec passed (one red ⇒ the whole gate is red), but every
 * criterion is ALWAYS reported so the operator sees exactly which acceptance criteria failed. PURE
 * over the injected `runSpec` — unit-testable with a fake.
 */
export function makeDefaultAcceptanceRunner(deps: {
  runSpec: (spec: AcceptanceSpec, ctx: { cwd: string }) => Promise<{ passed: boolean; detail?: string }>;
}): AcceptanceGateRunner {
  return {
    async run(specs, ctx) {
      const results: AcceptanceResult[] = [];
      for (const spec of specs) {
        const { passed, detail } = await deps.runSpec(spec, ctx);
        results.push({ criterion: spec.criterion, layer: spec.layer, passed, detail });
      }
      return { passed: results.every((r) => r.passed), results };
    },
  };
}
