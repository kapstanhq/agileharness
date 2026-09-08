import { describe, expect, it } from "vitest";
import { GATES } from "./gates";
import { GATE_IDS } from "./types";

// gate-core.js is `@ts-nocheck` plain CommonJS (it MUST be, to stay require()-able by the pre-write
// hook — B4 isomorphism) and is shadowed by gate-core.d.ts, so `GATES` is a bare object literal with
// ZERO compile-time tie to GATE_IDS. types.ts PROMISES "the exhaustive Record maps (GATES, GATE_LABEL)
// force every id to be handled — so adding a gate fails the typecheck until it's wired everywhere".
// For the GATES side that promise is FALSE: a GATE_ID with no predicate compiles clean, and
// evaluateGate then hits `if (!spec) return null` → SILENTLY ALLOWS the transition (a no-op gate on
// the pipeline's most safety-critical primitive). This runtime test is the real guard that keeps the
// types.ts comment honest. (GATE_LABELS is derived from GATES via Object.fromEntries, so its key-set
// equals GATES' by construction — no separate assertion needed.)
describe("gate-core exhaustiveness — GATES is complete vs GATE_IDS (no silent-allow, no orphan)", () => {
  it("Object.keys(GATES) set-equals GATE_IDS", () => {
    expect(new Set(Object.keys(GATES))).toEqual(new Set(GATE_IDS));
  });
});
