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
 * DEFAULT OFF: an absent/disabled spec always returns `fullCommand`, so the pre-perf behavior is
 * byte-identical until a board opts in via `autorun.mergeGate.affected` in its settings.
 *
 * WHY `--changed <baseSha>` and not `vitest related <files>`: `--changed` natively includes changed
 * TEST files (a session that edits only a `*.test.ts` must still run it) AND the tests related to changed
 * SOURCE files; `related` only does source->test. `baseSha` is the pre-merge `main` HEAD (the accumulated
 * state the branch merged onto), so inside the merged staging tree `--changed <baseSha>` is EXACTLY the
 * branch's net diff — and at the attribution reset (tree back at `baseSha`) it selects nothing. The
 * command template MUST pass on an empty selection (e.g. vitest `--passWithNoTests`): a source file with
 * no importing test selects zero tests, and that is a PASS, not a gate failure.
 */

/** Opt-in affected-only gate config, carried on `autorun.mergeGate.affected`. */
export interface AffectedGateSpec {
  /** master switch; absent/false ⇒ the gate always runs the full `checkCommand`. */
  enabled: boolean;
  /**
   * The command run in place of the full suite. `{base}` is substituted with the pre-merge `main` sha.
   * MUST pass when zero tests match, e.g. `"bunx vitest run --changed {base} --passWithNoTests"`.
   */
  command: string;
  /**
   * Repo-relative patterns; a changed file matching ANY of them forces the FULL suite (blast radius).
   * Supports exact paths, `dir/` prefixes, and `*`/`**` globs (see {@link matchesGatePattern}).
   */
  fullSuitePaths: string[];
}

export interface AffectedGateDecision {
  /** the command the gate should run — either the full `checkCommand` or the affected selection. */
  command: string;
  mode: "full" | "affected";
  /** human-readable justification, surfaced in the gate log. */
  reason: string;
}

const BASE_TOKEN = "{base}";

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
 * Decide the gate command. Fails SAFE to the full suite on every ambiguity (disabled, misconfigured
 * template, no base, empty diff, or any blast-radius hit) — the affected path is taken only when it is
 * unambiguously safe.
 */
export function resolveAffectedGate(
  fullCommand: string,
  baseSha: string,
  changedFiles: string[],
  spec: AffectedGateSpec | undefined,
): AffectedGateDecision {
  if (!spec?.enabled) return { command: fullCommand, mode: "full", reason: "affected gate off" };
  if (!spec.command || !spec.command.includes(BASE_TOKEN)) {
    return { command: fullCommand, mode: "full", reason: `affected command missing ${BASE_TOKEN} — full suite` };
  }
  if (!baseSha) return { command: fullCommand, mode: "full", reason: "no base sha — full suite" };
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) return { command: fullCommand, mode: "full", reason: "empty diff — full suite" };
  const patterns = spec.fullSuitePaths ?? [];
  for (const f of files) {
    const hit = patterns.find((p) => matchesGatePattern(f, p));
    if (hit) return { command: fullCommand, mode: "full", reason: `blast-radius: ${f} ~ ${hit}` };
  }
  return {
    command: spec.command.split(BASE_TOKEN).join(baseSha),
    mode: "affected",
    reason: `${files.length} changed file(s) — affected only`,
  };
}
