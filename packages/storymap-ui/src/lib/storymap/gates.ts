// gates.ts — typed barrel over gate-core.js, the ISOMORPHIC single-source of the pipeline gates.
//
// The gate predicates + messages live in gate-core.js (pure CommonJS, zero imports) so the
// pre-write hook (.claude/hooks/checks/pre-write/validate-storymap-gate.js) can require() the
// SAME logic the app runs, instead of re-implementing it in ~200 lines of regex (the B4 drift
// surface — see ADR-057). This module just re-exports it with types, preserving every consumer's
// `from "./gates"` / `from "@/lib/storymap/gates"` import path.
//
// Gates are validated when a card ENTERS a status (not while it sits there). board.yaml's
// `gate:` per status declares WHICH gate guards it; gate-core maps the id → predicate.
export {
  GATES,
  GATE_LABELS,
  gateForStatus,
  evaluateGate,
  checkGate,
  hasNarrative,
  declaresCode,
  // A invariante de HIERARQUIA (ancoragem). Não é um gate — é a regra que o chokepoint de escrita
  // impõe —, mas mora na mesma fonte isomórfica e é reusada pela UI para explicar uma recusa.
  placementViolation,
  placementSpec,
} from "./gate-core";
export type { GateSpec, GateVerdict, PlacementViolation, PlacementSpec, CardLookup } from "./gate-core";
