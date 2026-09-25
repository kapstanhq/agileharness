/**
 * Affected-only integration gate (perf). The merge train's gate runs the FULL suite per code entry
 * (`checkCommand`, a whole `vitest run`) — serial, so on a hot board a publish waits behind however many
 * suite runs are in flight. This module decides, purely, to run instead ONLY the tests AFFECTED by the
 * entry's diff — UNLESS a changed file lands in the BLAST RADIUS (a kernel/config/fixture the static
 * import graph can't be trusted to bound), where it falls back to the full suite.
 *
 * Measured (storymap-ui, 272 test files): a leaf-module entry selects 1–5 files (~6s vs the full ~40s
 * warm / minutes under contention), because it SKIPS the heavy real-git integration tests that amplify
 * worst under load; a kernel change (types/contracts/gate-core) already selects 30–50% of the suite, so
 * the fallback loses almost nothing exactly where the graph is least trustworthy.
 *
 * DEFAULT OFF: an absent/disabled spec always runs every unit in full, so the pre-perf behavior is
 * byte-identical until a board opts in via `autorun.mergeGate.affected` in its settings.
 *
 * ── PER UNIT, APPENDED — never a global REPLACEMENT (honest gate) ──────────────────────────────────────
 * The first version carried a global `affected.command` template that REPLACED the command of EVERY gate
 * unit. Measured on the reference target: a pytest unit ran `vitest` in its directory (never its own
 * suite), and a unit declared as `bunx vitest run --config vitest.unit.config.ts` lost its `--config` and
 * ran the wrong project. The selection is now a SUFFIX (`--changed <baseSha> --passWithNoTests`) appended
 * to the unit's OWN command, and only for units whose reporter is `vitest-json` (see gate-scope.ts
 * `unitAcceptsAffected`) — every other reporter always runs full. `affected.command` is kept in the
 * settings shape for back-compat but no longer drives anything.
 *
 * WHY `--changed <baseSha>` and not `vitest related <files>`: `--changed` natively includes changed
 * TEST files (a session that edits only a `*.test.ts` must still run it) AND the tests related to changed
 * SOURCE files; `related` only does source->test. `baseSha` is the pre-merge `main` HEAD (the accumulated
 * state the branch merged onto), so inside the merged staging tree `--changed <baseSha>` is EXACTLY the
 * branch's net diff — and at the attribution reset (tree back at `baseSha`) it selects nothing.
 * `--passWithNoTests` is part of the suffix because a source file with no importing test selects zero
 * tests, and that is a PASS, not a gate failure.
 */

/** Opt-in affected-only gate config, carried on `autorun.mergeGate.affected`. */
export interface AffectedGateSpec {
  /** master switch; absent/false ⇒ the gate always runs every unit in full. */
  enabled: boolean;
  /**
   * LEGACY, ignored. It used to be a template (`{base}` = the pre-merge sha) that REPLACED every unit's
   * command — the defect described at the top of this file. Accepted so an old settings.yaml still loads;
   * the selection is now {@link AFFECTED_SUFFIX} appended to each eligible unit's own command.
   */
  command?: string;
  /**
   * Repo-relative patterns; a changed file matching ANY of them forces the FULL suite (blast radius).
   * Supports exact paths, `dir/` prefixes, and `*`/`**` globs (see {@link matchesGatePattern}).
   */
  fullSuitePaths: string[];
}

/** The eligibility verdict for affected selection over ONE entry's delta (unit-independent). */
export interface AffectedSelection {
  /** true ⇒ each eligible (`vitest-json`, not opted out) unit runs `<its command> --changed <base> --passWithNoTests`. */
  eligible: boolean;
  /** human-readable justification, surfaced in the gate log. */
  reason: string;
}

export interface AffectedGateDecision {
  /** the command the gate should run for THIS unit — its own command, possibly with the affected suffix. */
  command: string;
  mode: "full" | "affected";
  /** human-readable justification, surfaced in the gate log. */
  reason: string;
}

/** The selection suffix. `{base}` is the pre-merge sha. `--passWithNoTests` is load-bearing (see top). */
export const AFFECTED_SUFFIX = "--changed {base} --passWithNoTests";

/** The base is interpolated into a SHELL command line: only a shell-inert revision token gets there. */
const SHA_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Match a repo-relative path against ONE pattern. `dir/` = prefix (the directory and everything under
 * it); a pattern with `*`/`?` is a glob (`**` crosses `/`, `*`/`?` do not); otherwise exact equality.
 */
export function matchesGatePattern(file: string, pattern: string): boolean {
  if (!pattern || !file) return false;
  if (pattern.endsWith("/")) return file === pattern.slice(0, -1) || file.startsWith(pattern);
  if (pattern.includes("*") || pattern.includes("?")) {
    // Escape regex metachars EXCEPT the glob ones, then translate the glob tokens in a SINGLE pass
    // (alternation matches `**` before `*`) so no placeholder byte is needed.
    const rx = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*|\*|\?/g, (m) => (m === "**" ? ".*" : m === "*" ? "[^/]*" : "[^/]"));
    return new RegExp(`^${rx}$`).test(file);
  }
  return file === pattern;
}

/**
 * Is affected-only selection SAFE for this entry at all? Fails SAFE to "full" on every ambiguity
 * (disabled, no/invalid base, empty diff, or any blast-radius hit) — the affected path is taken only when
 * it is unambiguously safe. Unit-independent: WHICH units get the suffix is {@link resolveAffectedGate}'s
 * question. PURE.
 */
export function resolveAffectedSelection(
  baseSha: string,
  changedFiles: readonly string[],
  spec: AffectedGateSpec | undefined,
): AffectedSelection {
  if (!spec?.enabled) return { eligible: false, reason: "affected gate off" };
  if (!baseSha) return { eligible: false, reason: "no base sha — full suite" };
  if (!SHA_RE.test(baseSha)) return { eligible: false, reason: `base "${baseSha.slice(0, 20)}" is not a shell-inert revision — full suite` };
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) return { eligible: false, reason: "empty diff — full suite" };
  const patterns = spec.fullSuitePaths ?? [];
  for (const f of files) {
    const hit = patterns.find((p) => matchesGatePattern(f, p));
    if (hit) return { eligible: false, reason: `blast-radius: ${f} ~ ${hit}` };
  }
  return { eligible: true, reason: `${files.length} changed file(s) — affected only` };
}

/**
 * Decide the command for ONE unit. `unitCommand` is the unit's OWN command (flags included); when the
 * entry is eligible AND the unit accepts selection, the result is that command with
 * {@link AFFECTED_SUFFIX} appended — never a replacement. `unitAccepts` is gate-scope's
 * `unitAcceptsAffected(unit)` (only `vitest-json` units, and not those that opted out). PURE.
 */
export function resolveAffectedGate(
  unitCommand: string,
  baseSha: string,
  changedFiles: readonly string[],
  spec: AffectedGateSpec | undefined,
  unitAccepts = true,
): AffectedGateDecision {
  const sel = resolveAffectedSelection(baseSha, changedFiles, spec);
  if (!sel.eligible) return { command: unitCommand, mode: "full", reason: sel.reason };
  if (!unitAccepts) return { command: unitCommand, mode: "full", reason: "unit does not accept affected selection — full" };
  return {
    command: `${unitCommand} ${AFFECTED_SUFFIX.split("{base}").join(baseSha)}`,
    mode: "affected",
    reason: sel.reason,
  };
}
