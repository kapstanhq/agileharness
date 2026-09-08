import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { evaluateGate } from "./gates";
import { coerceCard } from "./repo";
import type { BoardConfig, GateId } from "./types";

// B4 PARITY — the pre-write hook gates on a RAW js-yaml parse of the frontmatter; the app gates
// on a coerceCard()-NORMALIZED card. Both run the SAME gate-core predicates, so the only thing
// that can make the hook and the app disagree is a field that coerceCard normalizes differently
// than raw YAML (a quoted "true", a stringy number, a null vs absent). This test runs BOTH paths
// over an adversarial corpus and asserts they reach the SAME verdict for every gate — the
// guarantee that "the hook blocks exactly what the app blocks". A divergence here is a real bug.

// One status per gate (id chosen so the gate is unambiguous), mirroring gates-core.test's board.
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "refinada", name: "r", gate: "hasRefinement" },
    { id: "com-tasks", name: "t", gate: "hasTasks" },
    { id: "so-rice", name: "rc", gate: "hasRice" },
    { id: "pronta", name: "p", gate: "hasPrioritization" },
    { id: "qa", name: "qa", gate: "hasNoBlockers" },
    { id: "rev", name: "rev", gate: "hasQaPassed" },
    { id: "tp", name: "tp", gate: "hasTechPlan" },
    { id: "wf", name: "wf", gate: "hasWireframe" },
    { id: "refinar", name: "rf", gate: "hasRefineBrief" },
    { id: "corrigir", name: "cr", gate: "hasBugReport" },
    { id: "descontinuar", name: "dc", gate: "hasRetireBrief" },
    { id: "dup", name: "dp", gate: "hasDuplicateOf" },
    { id: "staged", name: "st", gate: "hasStaged" },
    { id: "released", name: "rl", gate: "hasReleased" },
    { id: "proof", name: "pf", gate: "hasDeployProof" },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const N = "narrative:\n  role: Como morador\n  want: quero algo\n  soThat: para um bem";

// Each case: a frontmatter (sans fences) + the target status. The expected verdict is whatever
// the APP produces — the test's job is to prove the HOOK (raw parse) produces the SAME thing.
const CORPUS: Array<{ name: string; fm: string; status: string }> = [
  // booleans — the highest divergence risk (quoted string vs bare boolean)
  { name: "techPlanReady bare true → pass", fm: "id: c\ntype: story\ntechPlanReady: true", status: "tp" },
  { name: "techPlanReady quoted string → app & hook agree", fm: 'id: c\ntype: story\ntechPlanReady: "true"', status: "tp" },
  { name: "techPlanReady absent → block", fm: "id: c\ntype: story", status: "tp" },
  { name: "qaPassed bare true (user) → pass", fm: "id: c\ntype: story\nstoryType: user\nqaPassed: true", status: "rev" },
  { name: "qaPassed quoted string (user) → agree", fm: 'id: c\ntype: story\nstoryType: user\nqaPassed: "true"', status: "rev" },
  { name: "qaPassed absent but not user → pass", fm: "id: c\ntype: story\nstoryType: technical", status: "rev" },
  // rice numbers — stringy vs numeric, zero/negative effort
  { name: "rice full numeric → pass", fm: "id: c\ntype: story\nrice:\n  reach: 100\n  impact: 2\n  confidence: 0.8\n  effort: 4", status: "so-rice" },
  { name: "rice effort 0 → block", fm: "id: c\ntype: story\nrice:\n  reach: 100\n  impact: 2\n  confidence: 0.8\n  effort: 0", status: "so-rice" },
  { name: "rice effort quoted '0' → agree", fm: 'id: c\ntype: story\nrice:\n  reach: 100\n  impact: 2\n  confidence: 0.8\n  effort: "0"', status: "so-rice" },
  { name: "rice with a null field → block", fm: "id: c\ntype: story\nrice:\n  reach: null\n  impact: 2\n  confidence: 0.8\n  effort: 4", status: "so-rice" },
  // narrative / acceptance
  { name: "refinement: narrative + acceptance → pass", fm: `id: c\ntype: story\n${N}\nacceptance:\n  - Dado A Quando B Então C`, status: "refinada" },
  { name: "refinement: narrative only (acceptance []) → block", fm: `id: c\ntype: story\n${N}\nacceptance: []`, status: "refinada" },
  { name: "refinement: whitespace-only role → block", fm: 'id: c\ntype: story\nnarrative:\n  role: "   "\n  want: q\n  soThat: s\nacceptance:\n  - x', status: "refinada" },
  // tasks
  { name: "tasks one item → pass", fm: "id: c\ntype: story\ntasks:\n  - id: t1\n    title: fazer\n    done: false", status: "com-tasks" },
  { name: "tasks [] → block", fm: "id: c\ntype: story\ntasks: []", status: "com-tasks" },
  // findings / hasNoBlockers — title is the coerceFindings drop-rule; encoded in the predicate so
  // raw (hook) and coerced (app) agree. A titleless blocker is ignored by BOTH (hook never false-blocks).
  { name: "findings blocker open WITH title → both block", fm: 'id: c\ntype: story\nfindings:\n  - id: f1\n    severity: blocker\n    status: open\n    title: "algo quebrou"', status: "qa" },
  { name: "findings blocker open WITHOUT title → both allow (malformed finding ignored)", fm: "id: c\ntype: story\nfindings:\n  - id: f1\n    severity: blocker\n    status: open", status: "qa" },
  { name: "findings blocker fixed → both pass", fm: 'id: c\ntype: story\nfindings:\n  - id: f1\n    severity: blocker\n    status: fixed\n    title: "x"', status: "qa" },
  { name: "findings absent → both pass", fm: "id: c\ntype: story", status: "qa" },
  // type-aware prioritization
  { name: "bug no frequency → block", fm: "id: c\ntype: story\nstoryType: bug\nseverity: high", status: "pronta" },
  { name: "bug severity+frequency → pass", fm: "id: c\ntype: story\nstoryType: bug\nseverity: high\nfrequency: often", status: "pronta" },
  { name: "melhoria impact+effort → pass", fm: "id: c\ntype: story\nmode: refine\nrice:\n  impact: 2\n  effort: 2", status: "pronta" },
  { name: "feature RICE+kano+funnel → pass", fm: "id: c\ntype: story\nrice:\n  reach: 100\n  impact: 2\n  confidence: 0.8\n  effort: 4\nkano: performance\nfunnelStage: activation", status: "pronta" },
  // briefs (nested) + duplicateOf (trim)
  { name: "wireframeChosen set → pass", fm: "id: c\ntype: story\nwireframeChosen: wf-1", status: "wf" },
  { name: "refineBrief set → pass", fm: 'id: c\ntype: story\nrefinement:\n  brief: "melhorar contraste"', status: "refinar" },
  { name: "refineBrief absent → block", fm: "id: c\ntype: story", status: "refinar" },
  { name: "bugReport brief set → pass", fm: 'id: c\ntype: story\nbugReport:\n  brief: "quebra no login"', status: "corrigir" },
  { name: "retireBrief absent → block", fm: "id: c\ntype: story", status: "descontinuar" },
  { name: "duplicateOf whitespace-only → block", fm: 'id: c\ntype: story\nduplicateOf: "   "', status: "dup" },
  { name: "duplicateOf set → pass", fm: "id: c\ntype: story\nduplicateOf: story-abc", status: "dup" },
  // staged / released
  { name: "stagedAt present → pass", fm: "id: c\ntype: story\nstagedAt: 2026-06-10", status: "staged" },
  { name: "staged absent → block", fm: "id: c\ntype: story", status: "staged" },
  { name: "released: staged but not released → block", fm: "id: c\ntype: story\nstagedAt: 2026-06-10", status: "released" },
  { name: "released: board-only (no code) → pass", fm: "id: c\ntype: story", status: "released" },
  // deploy-truth — hasReleased fail-closed (declaresCode also counts commitRange) + hasDeployProof.
  { name: "released: commitRange only (never staged) → both block (fail-closed)", fm: "id: c\ntype: story\ncommitRange:\n  base: a1\n  head: b2", status: "released" },
  { name: "released: half commitRange (no head) → both pass (no code declared on either path)", fm: "id: c\ntype: story\ncommitRange:\n  base: a1", status: "released" },
  { name: "proof: code (stagedAt) without deployProof → both block", fm: "id: c\ntype: story\nstagedAt: 2026-07-16", status: "proof" },
  { name: "proof: commitRange without deployProof → both block", fm: "id: c\ntype: story\ncommitRange:\n  base: a1\n  head: b2", status: "proof" },
  { name: "proof: well-formed deployProof → both pass", fm: 'id: c\ntype: story\nstagedAt: 2026-07-16\ndeployProof:\n  sha: abc1234\n  targets: [acmeapp]\n  at: "2026-07-17T12:00:00Z"\n  source: registry-ondone', status: "proof" },
  { name: "proof: deployProof without sha → both block (not proof on either path)", fm: "id: c\ntype: story\nstagedAt: 2026-07-16\ndeployProof:\n  targets: [acmeapp]\n  at: \"2026-07-17T12:00:00Z\"\n  source: registry-ondone", status: "proof" },
  { name: "proof: no-code card → both pass (nothing to prove)", fm: "id: c\ntype: story", status: "proof" },

  // ── adversarial-hunt regressions (gate-parity-hunt wf_f134cea6) — each was a real divergence,
  //    now fixed in the predicate so raw and coerced AGREE. ──
  // briefs / duplicateOf as an empty array: raw `.trim()` used to THROW; String()-safe now blocks both.
  { name: "refine brief [] → both block (no throw)", fm: "id: c\ntype: story\nmode: refine\nrefinement:\n  brief: []", status: "refinar" },
  { name: "bug brief [] → both block (no throw)", fm: "id: c\ntype: story\nmode: fix\nbugReport:\n  brief: []", status: "corrigir" },
  { name: "retire brief [] → both block (no throw)", fm: "id: c\ntype: story\nmode: retire\nretirement:\n  brief: []", status: "descontinuar" },
  { name: "duplicateOf [] → both block (no throw)", fm: "id: c\ntype: story\nduplicateOf: []", status: "dup" },
  // stagedAt/releasedAt as a falsy scalar: coerce stringifies to a truthy "false"/"0" → hook must not false-BLOCK.
  { name: "stagedAt false → both allow (no false-block)", fm: "id: c\ntype: story\nstagedAt: false", status: "staged" },
  { name: "stagedAt 0 → both allow (no false-block)", fm: "id: c\ntype: story\nstagedAt: 0", status: "staged" },
  { name: "released: releasedAt false + staged date → both allow", fm: "id: c\ntype: story\nstagedAt: 2026-06-02\nreleasedAt: false", status: "released" },
  // hasNoBlockers numeric title: coerce String(0)="0" keeps it → hook must count it too.
  { name: "findings blocker open title:0 → both block", fm: "id: c\ntype: story\nfindings:\n  - severity: blocker\n    status: open\n    title: 0", status: "qa" },
  // hasQaPassed storyType default: a story with no storyType coerces to user → both require QA.
  { name: "rev: storyType absent (story) → both block", fm: "id: c\ntype: story\nstatus: rev", status: "rev" },
  { name: "rev: non-story (type activity) → both allow", fm: "id: c\ntype: activity", status: "rev" },
  // hasUiSurface — the surface-aware QA exemption (bug WITH UI must QA; user WITHOUT UI is exempt).
  { name: "rev: bug + hasUiSurface true → both block (visual regression needs QA)", fm: "id: c\ntype: story\nstoryType: bug\nhasUiSurface: true", status: "rev" },
  { name: "rev: user + hasUiSurface false → both allow (UI-less user story exempt)", fm: "id: c\ntype: story\nstoryType: user\nhasUiSurface: false", status: "rev" },
  { name: "rev: hasUiSurface quoted 'true' (malformed) → fallback user → both block", fm: 'id: c\ntype: story\nstoryType: user\nhasUiSurface: "true"', status: "rev" },
  { name: "rev: bug + hasUiSurface true + qaPassed → both allow", fm: "id: c\ntype: story\nstoryType: bug\nhasUiSurface: true\nqaPassed: true", status: "rev" },
];

/** The gate id a verdict points at, or null when allowed — the comparable unit. */
const gateOf = (v: { gate: GateId } | null): GateId | null => v?.gate ?? null;

describe("gate-core parity: raw-yaml (hook) vs coerceCard (app) reach the same verdict", () => {
  for (const c of CORPUS) {
    it(c.name, () => {
      const raw = yaml.load(c.fm) as Record<string, unknown>;
      // HOOK path: predicates on the RAW parsed object.
      const hookVerdict = evaluateGate(raw as never, c.status, board);
      // APP path: predicates on the coerceCard()-normalized card.
      const appVerdict = evaluateGate(coerceCard("c", raw, ""), c.status, board);
      expect(gateOf(hookVerdict)).toBe(gateOf(appVerdict));
    });
  }
});

// DOCUMENTED LENIENCY (the parity contract's deliberate exceptions): for MALFORMED inputs the hook
// is LENIENT by design — it checks presence, the app additionally VALIDATES (enums) / NORMALIZES
// (finite numbers). Replicating those constants in gate-core would re-create the drift B4 removed.
// So the hook ALLOWS (null) where the app BLOCKS — the SAFE direction (hook never false-blocks; the
// app's checkGate on the board move stays authoritative). These cases PIN that intentional gap so a
// future "fix" that silently tightens the hook (or loosens the app) is caught.
describe("gate-core parity: documented leniency — hook allows, app blocks on malformed inputs", () => {
  const lenient: Array<{ name: string; fm: string; status: string; appGate: GateId }> = [
    { name: "invalid bug frequency (typo) — coerce drops it", fm: "id: c\ntype: story\nstoryType: bug\nseverity: high\nfrequency: muito", status: "pronta", appGate: "hasPrioritization" },
    { name: "invalid feature kano/funnel (typos) — coerce drops them", fm: "id: c\ntype: story\nkano: musthave\nfunnelStage: ativacao\nrice:\n  reach: 10\n  impact: 2\n  confidence: 1\n  effort: 2", status: "pronta", appGate: "hasPrioritization" },
    { name: "blocker finding with invalid status — coerce defaults to open", fm: "id: c\ntype: story\nfindings:\n  - title: SQLi no login\n    severity: blocker\n    status: pending", status: "qa", appGate: "hasNoBlockers" },
    { name: "RICE effort .inf (non-finite) — coerce nulls it", fm: "id: c\ntype: story\nrice:\n  reach: 10\n  impact: 2\n  confidence: 1\n  effort: .inf", status: "so-rice", appGate: "hasRice" },
    // deploy-truth — the hook checks ONLY `sha` (the `at` round-trips as a Date in raw yaml, and the
    // source enum lives in coerceDeployProof — duplicating either in gate-core would re-create B4 drift).
    // A stamp with a sha but a missing `at` / unknown `source` is therefore hook-ALLOWED, app-BLOCKED
    // (coerce drops the whole stamp): the safe direction — the authoritative checkGate still refuses it.
    { name: "deployProof sha present but no at — coerce drops the stamp", fm: "id: c\ntype: story\nstagedAt: 2026-07-16\ndeployProof:\n  sha: abc1234\n  targets: [acmeapp]\n  source: registry-ondone", status: "proof", appGate: "hasDeployProof" },
    { name: "deployProof unknown source (hand-authored) — coerce drops the stamp", fm: 'id: c\ntype: story\nstagedAt: 2026-07-16\ndeployProof:\n  sha: abc1234\n  targets: [acmeapp]\n  at: "2026-07-17T12:00:00Z"\n  source: invente', status: "proof", appGate: "hasDeployProof" },
  ];
  for (const c of lenient) {
    it(c.name, () => {
      const raw = yaml.load(c.fm) as Record<string, unknown>;
      expect(gateOf(evaluateGate(raw as never, c.status, board))).toBeNull(); // hook: lenient allow
      expect(gateOf(evaluateGate(coerceCard("c", raw, ""), c.status, board))).toBe(c.appGate); // app: blocks
    });
  }
});
