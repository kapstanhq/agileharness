// semantic-resolution — THE LADDER a text divergence climbs BEFORE it reaches a human (D14 · WS-10).
//
// The sister session promotion-mechanism-fix (033ee72e6) concluded that a genuine text divergence — two
// different edits to the same region — "always needs a human; no diff base avoids it". That is a true
// diagnosis OF GIT (a 3-way merge is blind to semantics) and a FALSE ceiling for the SYSTEM: an LLM reads
// both sides and generalizes "this is just prose" in ANY language, which is MORE application-agnostic than
// any per-language heuristic (AST-diffing is rejected — it is per-language, against D13). The Operator
// rejected "genuine divergence always needs a human" as the definitive limit; a human is the FINAL INFORMED
// rung, not the default answer.
//
// THE LADDER — each cheaper rung answers before the next is paid for:
//   rung 0  convergence (deltaLanded)     "there is no real conflict: it already landed"        free
//   rung 1  deterministic filter          the two sides are equal modulo whitespace/blank        free
//                                         lines (`git diff -w --ignore-blank-lines`) → resolve
//   rung 2  LLM JUDGE (harness-resolve,       cosmetic/non-functional → resolve + document          ~cents
//           `mechanical` profile)         substantive → ABORT and produce the ANALYSIS
//   rung 3  human                         receives the per-hunk analysis, already digested      the last rung
//
// COSMETIC (the judge MAY resolve): comment/docstring, formatting, import order with no effect, a rename
// with identical effect, the two sides are the SAME fix written differently. SUBSTANTIVE (ALWAYS escalates):
// divergent logic/behaviour/contract, the two sides DO different things, or ANY doubt.
//
// ── SAFETY INVARIANTS (non-negotiable — this header carries them) ────────────────────────────────────
//  1. THE JUDGE NEVER WRITES TO stage/main. It works in a FRESH worktree and materializes a resolved
//     artifact that RE-ENTERS through the normal mechanism (train re-enqueue / release retry) — and the
//     GATE (the suite) RUNS AGAIN over the result. The deterministic gate is the backstop of the LLM's
//     judgement: a wrong "cosmetic" that changes test-covered behaviour dies at the gate.
//  2. ALL-OR-NOTHING per resolution: 3 cosmetic hunks + 1 substantive ⇒ NONE is applied; the analysis
//     covers all 4 (the human resolves 1 informed hunk, not a raw diff). A partial resolution would leave
//     a broken tree — see {@link allCosmetic}.
//  3. ONE semantic attempt per entry (a persisted counter, like `maxRedrives`) — a retry only on a change
//     of FACT (a new base). Never a loop. Enforced by the CALLER (it owns the durable entry); this module
//     exposes {@link SEMANTIC_ATTEMPT_CAP} as the single number both callers read.
//  4. FULL TRAIL: a per-hunk JSON verdict in the journal, a structured trailer on the resolution commit
//     ({@link resolutionTrailer}), a summary in the copilot's diary.
//  5. SPLIT WITH WS-2 (ADR-063 invariant 1 — deterministic > LLM where the rule is KNOWABLE): board-data /
//     cards keep merging through WS-2's element-level 3-way and NEVER reach the judge; the judge covers
//     exactly the complement (arbitrary CODE text, where no agnostic deterministic rule exists). Enforced
//     by {@link isJudgeableFile} — the routing test is an acceptance criterion, not an aspiration.
//  6. DOUBT ⇒ SUBSTANTIVE (fail-closed). Every failure mode in this module — a git error, an unparseable
//     verdict, a judge crash, a timeout — resolves NOTHING and escalates. Forcing a substantive resolution
//     would be unsafe; the win is that the human only ever sees what is genuinely ambiguous, WITH the
//     analysis ready.
//  7. GOVERNANCE: `settings.yaml autorun.mergeTrain.semanticResolution` (boot flag, default ON — D8 of the
//     AgileHarness plan: a complete train out of the box). `semanticResolution: false` ⇒ TODAY's behaviour,
//     byte-identical: {@link climbLadder} returns `disabled` before touching git, so not one command runs.
//
// HONEST RESIDUAL: a "cosmetic" judged WRONG and NOT covered by a test = a behaviour change enters stage.
// Mitigations: doubt⇒substantive, the gate always re-runs, the diffSnapshot is preserved, the forensic
// trail, and the telemetry that calibrates the prompt's examples with real data. The alternative ("a human
// always") is the status quo the Operator rejected — and the same risk exists in a rushed HUMAN merge,
// WITHOUT the trail.
//
// PURE over the injected ports (`exec` + {@link JudgePort}), like release.ts / convergence.ts: every rung is
// unit-testable against real or fake git, and the judge is a fake in tests. NEVER throws — a failure is an
// escalation, and an escalation authorizes nothing.

import { deltaLanded, type DeltaLandedResult, type DeltaRange } from "./convergence";
import type { ExecFn } from "./worktree";

/** Per-command git budget. An overrun escalates (invariant 6), so a generous budget costs nothing. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Invariant 3 — ONE semantic attempt per entry. The counter is PERSISTED by the caller (the train's entry /
 * the release's card), exactly like `maxRedrives`: a second conflict on the SAME entry parks straight away.
 * A retry is legitimate ONLY on a change of FACT (a new base ⇒ a new entry ⇒ a fresh counter), which is the
 * D10 principle from the sister plan. Deliberately NOT configurable: "how many times may an LLM re-judge the
 * same unchanged text?" has one honest answer, and making it a knob invites a loop.
 */
export const SEMANTIC_ATTEMPT_CAP = 1;

/** How much of a conflicting region we carry per hunk. The analysis rides an entry/finding the operator
 *  reads — capped like `CONFLICT_DETAIL_CAP` so one pathological file can't blow up the state file. */
export const HUNK_TEXT_CAP = 800;

/** How many hunks one analysis carries. Beyond this the divergence is not a merge, it is a rewrite — and a
 *  human needs the branch, not a 200-entry list. The overflow is COUNTED in the detail, never dropped silently. */
export const MAX_ANALYSIS_HUNKS = 20;

export type HunkVerdictKind =
  /** comment/docstring, formatting, import order, identical-effect rename, the same fix worded differently */
  | "cosmetic"
  /** divergent logic/behaviour/contract — or ANY doubt (invariant 6) */
  | "substantive";

/** ONE judged region: what the human (or the trail) reads when the resolution escalates. */
export interface HunkAnalysis {
  /** repo-relative path of the divergent file */
  file: string;
  /** the conflicting region, capped at {@link HUNK_TEXT_CAP} */
  hunk: string;
  verdict: HunkVerdictKind;
  /** WHY — the judge's own reasoning, in the operator's language */
  rationale: string;
}

/**
 * The ladder's verdict. `resolved-*` are the three ways a divergence dies without a human; the rest all mean
 * "a human still decides", and NONE of them ever applies anything (invariant 2 + 6).
 * These are also the TELEMETRY buckets (10.5) — the number that answers "how many conflicts did the human
 * NOT have to see?" and that calibrates the prompt's examples with real data.
 */
export type ResolutionOutcome =
  /** rung 0 — the delta is already in the target; there was never a real conflict */
  | "resolved-converged"
  /** rung 1 — the two sides are equal modulo whitespace/blank lines; no LLM was paid */
  | "resolved-deterministic"
  /** rung 2 — the judge proved EVERY hunk cosmetic and materialized a resolved artifact */
  | "resolved-cosmetic"
  /** rung 2 — at least one hunk is substantive (or the judge doubted) ⇒ the human decides, WITH the analysis */
  | "escalated-substantive"
  /** rung 2 — the judge crashed / timed out / returned garbage ⇒ fail-closed, the human decides */
  | "judge-failed"
  /** the flag is off ⇒ today's behaviour, byte-identical (invariant 7) */
  | "disabled"
  /** the ladder does not apply here: a live session's conflict (D3), board-data (invariant 5), or the
   *  single semantic attempt is spent (invariant 3) */
  | "skipped";

/** True when this outcome MATERIALIZED an artifact the caller must re-enter through the normal mechanism. */
export function isResolved(outcome: ResolutionOutcome): boolean {
  return outcome === "resolved-converged" || outcome === "resolved-deterministic" || outcome === "resolved-cosmetic";
}

/** The full result of a climb — what the caller persists, surfaces and counts. */
export interface ResolutionResult {
  outcome: ResolutionOutcome;
  /** operator-facing one-liner (PT-BR): WHICH rung answered and why. Rides logs/entries/findings. */
  detail: string;
  /** the per-hunk verdicts. Populated on `escalated-substantive` (the point of the whole WS) and on
   *  `resolved-cosmetic` (the trail). Empty on the rungs that never judged. */
  hunks: HunkAnalysis[];
  /** rung 2 only — the ref the judge materialized (a branch/commit holding the resolved tree), which the
   *  caller re-enters through the NORMAL mechanism so the GATE runs again (invariant 1). Never applied here. */
  resolvedRef?: string;
  /** the files the ladder considered — named in the escalation so the operator knows the blast radius. */
  files: string[];
}

/**
 * Invariant 5 — is this file the JUDGE's business? The judge owns arbitrary CODE text (where no agnostic
 * deterministic rule exists). Board data (cards, sidecars, the board's own YAML) is WS-2's element-level
 * 3-way merge: the rule there is KNOWABLE, and ADR-063 invariant 1 says deterministic beats LLM wherever it
 * is. A card that reached the judge would be a REGRESSION (an LLM re-deciding what a merge-by-id already
 * decides correctly), so this is a hard routing rule, not a preference.
 *
 * Path-based ON PURPOSE (never content sniffing): `storymap/boards/**` is the board-data root the split
 * train already routes by (ADR-057), so both mechanisms read the SAME boundary from the same place — a
 * second, cleverer ruler here is exactly the duplicated-ruler class of bug D15 warns about.
 */
export function isJudgeableFile(file: string): boolean {
  const f = file.replace(/^\.\//, "");
  return !f.startsWith("storymap/boards/");
}

/**
 * Invariant 2 — ALL-OR-NOTHING. A resolution is authorized ONLY when EVERY judged hunk is cosmetic; one
 * substantive hunk poisons the whole set. An EMPTY verdict list is NOT a licence either: "the judge found
 * nothing to judge" is a failure of the judge, not proof of harmlessness — the asymmetry contract from
 * convergence.ts holds verbatim (whoever ACTS needs proof).
 */
export function allCosmetic(hunks: readonly HunkAnalysis[]): boolean {
  return hunks.length > 0 && hunks.every((h) => h.verdict === "cosmetic");
}

/**
 * Invariant 4 — the structured trailer stamped on a resolution commit, so `git log` alone tells a future
 * archaeologist that an LLM (not a human) resolved this text and WHICH run to audit. Deliberately a git
 * trailer (`Key: value`, last paragraph) rather than prose: `git log --format=%(trailers)` can find every
 * machine-resolved commit in the history without parsing English. PURE.
 */
export function resolutionTrailer(hunkCount: number, runId: string): string {
  return `Merge-Resolution: ${hunkCount} hunk(s) cosmético(s), juiz ${runId}`;
}

/** The two sides of a divergence, as git refs. `ours` is the TARGET (main/stage — what already exists);
 *  `theirs` is the incoming delta's side. Rung 1 resolves by keeping `ours`, which is why the naming matters. */
export interface DivergenceSides {
  /** the target's ref (main / stage) — the side rung 1 KEEPS */
  ours: string;
  /** the incoming side (the run branch / stage during a release) */
  theirs: string;
  /** the divergent files, already narrowed by the caller (release: `toPromote`; train: the conflicted set) */
  files: string[];
}

/**
 * RUNG 1 — the deterministic filter (pure code, language-agnostic BY CONSTRUCTION).
 *
 * Are the two sides equal MODULO whitespace and blank lines, for EVERY file? `git diff -w
 * --ignore-blank-lines` between the two sides answers it with no LLM and no per-language knowledge: an empty
 * diff means the sides carry the same tokens, differing only in layout. Resolving then means KEEPING `ours`
 * (the target's side) — which is lossless: the incoming side would have produced the same tokens.
 *
 * ALL-OR-NOTHING (invariant 2): one file that is NOT equivalent sends the WHOLE set to rung 2. Resolving the
 * equivalent files here and judging the rest would be exactly the partial resolution the spec rejects.
 *
 * FAIL-CLOSED (invariant 6): a git failure is NOT "equivalent" — any non-zero exit that is not the "they
 * differ" answer (exit 1) returns false and the set climbs to rung 2. Collapsing an error into "no diff"
 * would auto-resolve a divergence nobody measured, which is the one unrecoverable mistake here.
 */
export async function sidesEquivalentModuloWhitespace(
  exec: ExecFn,
  repoRoot: string,
  sides: DivergenceSides,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<boolean> {
  if (sides.files.length === 0) return false; // nothing measured proves nothing (asymmetry contract)
  for (const file of sides.files) {
    // Per FILE, not one batched diff: a batched `--quiet` collapses "file A differs" and "git blew up on
    // file B" into the same exit code, and we would not know which. One file at a time keeps every exit
    // code attributable — the same reason convergence.ts refuses to collapse exit 1 and exit 128.
    const cmd =
      `git diff --quiet -w --ignore-blank-lines --ignore-cr-at-eol ` +
      `${JSON.stringify(`${sides.ours}:${file}`)} ${JSON.stringify(`${sides.theirs}:${file}`)}`;
    let code: number;
    try {
      await exec(cmd, { cwd: repoRoot, timeout: timeoutMs });
      code = 0; // exit 0 ⇒ NO diff ⇒ equivalent modulo whitespace
    } catch (err) {
      const e = err as { code?: unknown };
      code = typeof e?.code === "number" ? e.code : -1;
    }
    if (code === 0) continue; // this file is equivalent — keep checking the rest
    // exit 1 = "they genuinely differ" (an ANSWER); anything else = git failed (NOT an answer). Both send
    // the set to rung 2, but only exit 1 is a real divergence — the distinction is preserved for the reader
    // even though the action is the same, because collapsing them is how a broken git becomes "resolve it".
    return false;
  }
  return true;
}

/** Everything the judge needs to do its job, and nothing else. Built by the caller (train or release), which
 *  is the only side that knows the entry/branch/base — this module stays agnostic of both. */
export interface JudgeRequest {
  /** the divergence: the two sides + the files */
  sides: DivergenceSides;
  /** the base the delta was cut from — the judge reapplies the delta onto a FRESH worktree of `sides.ours` */
  base: string;
  /** who is asking (`train` / `release`) + the board, for the trail and the telemetry */
  origin: "train" | "release";
  board?: string;
  cardId?: string;
  /** the operator-facing conflict text the caller already has (the git stderr), so the judge starts informed */
  conflictDetail?: string;
}

/** What the judge returns. `resolvedRef` is present ONLY when every hunk is cosmetic (invariant 2) — the port
 *  implementation is responsible for never materializing an artifact it did not fully authorize. */
export interface JudgeVerdict {
  hunks: HunkAnalysis[];
  /** the branch/commit holding the resolved tree, when (and only when) the judge resolved */
  resolvedRef?: string;
  /** the judge run's id — rides the trail (trailer/journal/telemetry) */
  runId: string;
  /** set when the judge itself failed (crash/timeout/garbage) ⇒ `judge-failed`, never an escalation dressed
   *  up as a verdict: the operator must be able to tell "the judge says it's ambiguous" from "the judge died". */
  error?: string;
}

/**
 * RUNG 2 — the port over the `harness-resolve` spawn (DI: a fake in tests, a real headless run in prod). The
 * implementation lives in resolution-judge-spawn.ts (the IO), exactly as the engine wires `RedriveHandler`:
 * this module decides WHEN to judge, never HOW to spawn.
 */
export type JudgePort = (req: JudgeRequest) => Promise<JudgeVerdict>;

/** The ports {@link climbLadder} needs. All injected — the module does no IO of its own. */
export interface LadderDeps {
  exec: ExecFn;
  repoRoot: string;
  /** rung 2. Absent ⇒ the ladder stops after rung 1 (the train degrades to today's park, like a missing
   *  RedriveHandler degrades to the legacy pause) — never a crash. */
  judge?: JudgePort;
  /** invariant 7 — the boot flag. false ⇒ `disabled` before ANY git command runs. */
  enabled: boolean;
  /** rung 0's ruler, injected so this module never re-implements convergence (D6: one ruler, one question).
   *  Defaults to the real {@link deltaLanded}. */
  deltaLandedFn?: (opts: { range: DeltaRange; target: string }) => Promise<DeltaLandedResult>;
}

/** What a climb needs to know beyond the ports. */
export interface LadderInput extends JudgeRequest {
  /** rung 0 — the delta's range, when the caller has one. Absent ⇒ rung 0 is skipped (nothing to measure);
   *  the ladder starts at rung 1. Never invented here: a made-up range is the loose heuristic convergence.ts
   *  explicitly refuses. */
  range?: DeltaRange;
  /** invariant 3 — how many semantic attempts this entry has ALREADY spent. `>= SEMANTIC_ATTEMPT_CAP` ⇒
   *  `skipped` (park straight away). The counter is the caller's to persist; the rule lives here. */
  attempts?: number;
}

/**
 * Climb the ladder for ONE divergence. Returns what happened; APPLIES NOTHING (invariant 1) — the caller
 * re-enters a `resolved-*` artifact through its normal mechanism (train re-enqueue / release retry) so the
 * GATE runs again over the result.
 *
 * NEVER throws: every failure is an escalation, and an escalation authorizes nothing (invariant 6).
 */
export async function climbLadder(deps: LadderDeps, input: LadderInput): Promise<ResolutionResult> {
  const files = input.sides.files;
  const base = { files };

  // Invariant 7 — the flag, checked FIRST so `false` is byte-identical to today: not one git command runs.
  if (!deps.enabled) {
    return { outcome: "disabled", detail: "resolução semântica desligada (autorun.mergeTrain.semanticResolution: false)", hunks: [], ...base };
  }

  // Invariant 5 — board data NEVER reaches the judge (WS-2's element merge owns it, deterministically).
  // ALL-OR-NOTHING again: a MIXED set (code + board data) is not the judge's to split, and letting it
  // through would hand an LLM a card to re-decide. The train never builds such a set (the split routes the
  // two halves apart), so this is the invariant's teeth, not a live path.
  const nonJudgeable = files.filter((f) => !isJudgeableFile(f));
  if (nonJudgeable.length > 0) {
    return {
      outcome: "skipped",
      detail:
        `board-data não passa pelo juiz (merge por elemento do WS-2 é determinístico): ` +
        `${nonJudgeable.slice(0, 3).join(", ")}${nonJudgeable.length > 3 ? ` (+${nonJudgeable.length - 3})` : ""}`,
      hunks: [],
      ...base,
    };
  }

  // Invariant 3 — one semantic attempt per entry. A retry only on a change of FACT (a new base ⇒ a new
  // entry ⇒ attempts back to 0). Checked BEFORE rung 0 on purpose: a second climb over the same unchanged
  // text is precisely the loop this guards, and rung 0 would pay git to learn nothing new.
  if ((input.attempts ?? 0) >= SEMANTIC_ATTEMPT_CAP) {
    return {
      outcome: "skipped",
      detail: `tentativa semântica já gasta (${input.attempts}/${SEMANTIC_ATTEMPT_CAP}) — só re-tenta com base nova`,
      hunks: [],
      ...base,
    };
  }

  if (files.length === 0) {
    return { outcome: "skipped", detail: "nenhum arquivo divergente informado — nada a resolver", hunks: [], ...base };
  }

  // ── RUNG 0 — convergence: is there even a real conflict? (D6 — the shared ruler, never a bespoke check.)
  // Only `landed` (POSITIVE PROOF by content) resolves; `partial`/`unknown`/`absent` climb on. This is the
  // asymmetry contract from convergence.ts, honored rather than re-implemented.
  if (input.range && deps.deltaLandedFn) {
    try {
      const res = await deps.deltaLandedFn({ range: input.range, target: input.sides.ours });
      if (res.verdict === "landed") {
        return { outcome: "resolved-converged", detail: `degrau 0: ${res.detail}`, hunks: [], ...base };
      }
    } catch {
      // Rung 0 is an OPTIMIZATION, not a gate: a failure here costs one rung of cheapness, never a wrong
      // answer. Climb on silently — the next rungs are the ones that decide.
    }
  }

  // ── RUNG 1 — the deterministic filter: equal modulo whitespace ⇒ keep `ours`, no LLM paid.
  const equivalent = await sidesEquivalentModuloWhitespace(deps.exec, deps.repoRoot, input.sides).catch(() => false);
  if (equivalent) {
    return {
      outcome: "resolved-deterministic",
      detail:
        `degrau 1: os dois lados são idênticos módulo whitespace/blank-lines em ${files.length} arquivo(s) ` +
        `— resolvido mantendo ${input.sides.ours}, sem LLM`,
      hunks: [],
      ...base,
    };
  }

  // ── RUNG 2 — the LLM judge. Absent port ⇒ degrade to today's behaviour (park), never a crash: the same
  // contract as a missing RedriveHandler.
  if (!deps.judge) {
    return {
      outcome: "escalated-substantive",
      detail: "degrau 2 indisponível (sem juiz configurado) — escalado para o humano (fail-closed)",
      hunks: [],
      ...base,
    };
  }

  const verdict = await deps
    .judge({ sides: input.sides, base: input.base, origin: input.origin, board: input.board, cardId: input.cardId, conflictDetail: input.conflictDetail })
    .catch((err): JudgeVerdict => ({ hunks: [], runId: "", error: String(err instanceof Error ? err.message : err) }));

  // The judge DIED (crash/timeout/garbage) — distinct from "the judge says substantive". Both send it to the
  // human, but only one of them means the ladder is broken, and the operator/telemetry must be able to tell.
  if (verdict.error) {
    return {
      outcome: "judge-failed",
      detail: `degrau 2: o juiz falhou (${verdict.error.slice(0, 200)}) — escalado para o humano (fail-closed)`,
      hunks: capHunks(verdict.hunks),
      ...base,
    };
  }

  // Invariant 2 — ALL-OR-NOTHING. Every hunk cosmetic AND an artifact actually materialized ⇒ resolved.
  // The `resolvedRef` check is deliberate belt-and-braces: a judge that claims "all cosmetic" but produced
  // no artifact has not resolved anything, and trusting the claim over the evidence is how a false
  // "resolved" would slip through. Proof, not assertion.
  if (allCosmetic(verdict.hunks) && verdict.resolvedRef) {
    return {
      outcome: "resolved-cosmetic",
      detail: `degrau 2: o juiz julgou os ${verdict.hunks.length} hunk(s) COSMÉTICOS e resolveu (run ${verdict.runId}) — o gate roda de novo sobre o resultado`,
      hunks: capHunks(verdict.hunks),
      resolvedRef: verdict.resolvedRef,
      ...base,
    };
  }

  // Everything else escalates WITH the analysis — the whole point of the WS: the human sees only what is
  // genuinely ambiguous, and sees it already digested (per hunk: verdict + rationale).
  const substantive = verdict.hunks.filter((h) => h.verdict === "substantive");
  return {
    outcome: "escalated-substantive",
    detail:
      substantive.length > 0
        ? `degrau 2: ${substantive.length}/${verdict.hunks.length} hunk(s) SUBSTANTIVO(s) — nenhuma resolução aplicada (tudo-ou-nada), análise anexada`
        : `degrau 2: o juiz não provou que os hunks são cosméticos — escalado (dúvida ⇒ substantivo)`,
    hunks: capHunks(verdict.hunks),
    ...base,
  };
}

/** Cap the analysis so one pathological divergence can't blow up the state file (see MAX_ANALYSIS_HUNKS /
 *  HUNK_TEXT_CAP). The overflow is COUNTED in a trailing marker rather than dropped silently — a truncated
 *  analysis that lies about its own completeness is worse than none. */
function capHunks(hunks: readonly HunkAnalysis[]): HunkAnalysis[] {
  const kept = hunks.slice(0, MAX_ANALYSIS_HUNKS).map((h) => ({ ...h, hunk: h.hunk.slice(0, HUNK_TEXT_CAP) }));
  if (hunks.length > MAX_ANALYSIS_HUNKS) {
    kept.push({
      file: "—",
      hunk: "",
      verdict: "substantive",
      rationale: `(+${hunks.length - MAX_ANALYSIS_HUNKS} hunk(s) não listados — divergência grande demais para um merge assistido; inspecione o branch)`,
    });
  }
  return kept;
}

/** Re-export so a consumer wiring the real rung 0 names ONE symbol instead of reaching into convergence.ts
 *  for the shape (D6: one ruler — importing it here keeps the ladder's contract self-contained). */
export { deltaLanded };
