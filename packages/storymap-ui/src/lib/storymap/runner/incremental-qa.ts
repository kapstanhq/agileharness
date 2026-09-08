// Incremental QA — verify only what the diff changed since the last green (ADR-063 Fase 5a).
//
// The QA gate proves a card's whole acceptance[] every run. But between two consecutive QA runs of the
// same card the code usually moves only a LITTLE — a `commitRange` (lastGreenCommit..HEAD) captures
// exactly that delta. 5a routes each acceptance criterion to the files it exercises (via the 3c discovery
// artifact) and RUNS only the criteria whose files changed in the range; the rest were green last time
// and nothing they touch moved, so they are carried forward as green. The extreme case — an EMPTY range
// (nothing changed since the last green) — skips the ENTIRE suite (the run is a no-op verdict).
//
// SAFE BY CONSTRUCTION — every ambiguity biases toward RUNNING (never skip a criterion we can't prove
// unaffected):
//   - the git diff failed / the range is unparseable → run EVERYTHING (can't scope → don't guess);
//   - a changed file is GLOBAL (config / shared / the layout mount) → run EVERYTHING (can't scope);
//   - a criterion the resolver can't map to files → run it (unmapped ⇒ unproven ⇒ run).
// Only a criterion PROVABLY mapped to files, NONE of which changed, is skipped.
//
// PURE kernel over an injected `resolveFiles` + `changedFiles`, plus a thin DI'd git helper — unit-testable
// with no repo. Composes with qa-runner: selectIncremental(planAcceptance(acceptance), …) → runner.run(toRun).

import type { CommitRange } from "../types";
import type { GitRunner } from "./diff";
import type { AcceptanceGateRunner, AcceptanceResult, AcceptanceSpec, AcceptanceVerdict } from "./qa-runner";

/** The result of scoping an acceptance suite to a commit range: what to run now, what to carry as green. */
export interface AcceptanceSelection {
  /** Criteria whose mapped files changed in the range (or a global/unknown change forced a full run). */
  toRun: AcceptanceSpec[];
  /** Criteria green last time whose files did NOT change → carried forward as green (not re-run). */
  skipped: AcceptanceSpec[];
  /** Why the plan looks the way it does (observability): what drove the run/skip split. */
  reason: "empty-specs" | "unknown-range" | "empty-range" | "global-change" | "scoped";
}

/** Resolve the files an acceptance criterion exercises. `[]` = UNKNOWN (the criterion is then run, never
 *  skipped — unmapped ⇒ unproven). Injected; the default is discovery-backed ({@link makeDiscoveryFileResolver}). */
export type SpecFileResolver = (spec: AcceptanceSpec) => string[];

/** Path fragments whose change invalidates the WHOLE suite (can't scope a shared/config/global change). A
 *  changed file matching ANY fragment forces a full run. Tuned to the App-Router + monorepo shape. */
export const DEFAULT_FORCE_ALL_FRAGMENTS: readonly string[] = [
  "package.json",
  "bun.lock",
  "tsconfig",
  "next.config",
  "tailwind.config",
  "postcss.config",
  "playwright.config",
  "vitest.config",
  "middleware.",
  "/layout.", // the global mount — a change here can affect every route (finding f1 class)
  "/providers", // app-wide providers
  "/globals.css",
];

/** Does a changed file (repo-relative) reference a spec file (which may be package-relative)? Suffix-aware
 *  so `packages/x/src/app/a/page.tsx` (git) matches `src/app/a/page.tsx` (discovery). Exact OR path-suffix. */
function fileMatches(changedFile: string, specFile: string): boolean {
  if (!specFile) return false;
  return changedFile === specFile || changedFile.endsWith(`/${specFile}`) || specFile.endsWith(`/${changedFile}`);
}

/**
 * Scope an acceptance suite to the files that changed in a commit range. `changedFiles`:
 *   - `null`  ⇒ the range couldn't be resolved (git error / bad range) → run EVERYTHING (`unknown-range`).
 *   - `[]`    ⇒ nothing changed since the last green → skip EVERYTHING (`empty-range` — the big win).
 *   - a list  ⇒ per-criterion scoping; a GLOBAL change (matches `forceAllFragments`) forces a full run.
 * PURE over `resolveFiles`. Order + text of specs preserved. Exported for tests.
 */
export function selectIncremental(
  specs: AcceptanceSpec[],
  opts: {
    changedFiles: string[] | null;
    resolveFiles: SpecFileResolver;
    forceAllFragments?: readonly string[];
  },
): AcceptanceSelection {
  if (specs.length === 0) return { toRun: [], skipped: [], reason: "empty-specs" };
  if (opts.changedFiles === null) return { toRun: [...specs], skipped: [], reason: "unknown-range" };
  if (opts.changedFiles.length === 0) return { toRun: [], skipped: [...specs], reason: "empty-range" };

  const fragments = opts.forceAllFragments ?? DEFAULT_FORCE_ALL_FRAGMENTS;
  const globalChange = opts.changedFiles.some((f) => fragments.some((frag) => f.includes(frag)));
  if (globalChange) return { toRun: [...specs], skipped: [], reason: "global-change" };

  const toRun: AcceptanceSpec[] = [];
  const skipped: AcceptanceSpec[] = [];
  for (const spec of specs) {
    const files = opts.resolveFiles(spec);
    // Unmapped criterion (no files) ⇒ we can't prove it's unaffected ⇒ RUN it (conservative).
    const affected = files.length === 0 || files.some((sf) => opts.changedFiles!.some((cf) => fileMatches(cf, sf)));
    (affected ? toRun : skipped).push(spec);
  }
  return { toRun, skipped, reason: "scoped" };
}

/** The minimal discovery shape the resolver needs (structural — decoupled from the scripts/ generator). */
export interface DiscoveryLike {
  routes: { route: string; file: string; testids: string[] }[];
}

/**
 * A discovery-backed {@link SpecFileResolver}: map a criterion to component files by the routes + testids
 * its text mentions (the 3c artifact). Best-effort + CONSERVATIVE — a route/testid mentioned in the
 * criterion text pulls in its file(s); nothing recognized ⇒ `[]` (→ the criterion is run, never skipped).
 * Routes are matched longest-first so `/eventos/novo` wins over `/eventos`; the root route `/` is only
 * matched on an explicit word to avoid pulling every criterion into the home page.
 */
export function makeDiscoveryFileResolver(discovery: DiscoveryLike): SpecFileResolver {
  // Longest route first so a nested route beats its prefix; skip the bare "/" from substring matching.
  const routes = [...discovery.routes].sort((a, b) => b.route.length - a.route.length);
  return (spec) => {
    const text = spec.criterion.toLowerCase();
    const files = new Set<string>();
    for (const r of routes) {
      const route = r.route.toLowerCase();
      const hitRoute = route !== "/" && (text.includes(` ${route}`) || text.includes(`"${route}`) || text.includes(`(${route}`) || text.endsWith(route) || text.includes(`${route} `) || text.includes(`${route}/`));
      const hitTestid = r.testids.some((t) => t && text.includes(t.toLowerCase()));
      if (hitRoute || hitTestid) files.add(r.file);
    }
    return [...files];
  };
}

// A git ref charset — blocks shell/flag injection before base/head reach `git diff`. The QA stamps these
// as immutable SHAs (or the empty-tree SHA), but tags/HEAD~n shapes are allowed too. Anything else ⇒ null.
const SAFE_REF = /^[A-Za-z0-9_./~^-]+$/;

/**
 * The files changed in a card's durable `commitRange` (`<base>..<head>`, the SHAs the QA/review stamped —
 * {@link CommitRange}), or `null` when it can't be resolved (absent/half-written range, a non-SHA ref, or
 * git errored) — the caller then runs the WHOLE suite (never skips on an unknown delta). An EMPTY array is
 * a REAL answer (the range is valid but touched nothing → skip-everything). Reuses the codebase's
 * {@link GitRunner} (throws on git error) — a throw is swallowed to `null`. Repo-relative paths.
 */
export async function changedFilesInRange(
  range: CommitRange | null | undefined,
  runGit: GitRunner,
): Promise<string[] | null> {
  const base = range?.base?.trim();
  const head = range?.head?.trim();
  if (!base || !head || !SAFE_REF.test(base) || !SAFE_REF.test(head)) return null;
  try {
    const stdout = await runGit(["diff", "--name-only", `${base}..${head}`]);
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null; // git couldn't resolve the range → unknown → run all
  }
}

/**
 * Run an acceptance suite INCREMENTALLY: execute only `selection.toRun` through the gate runner, and carry
 * every `selection.skipped` criterion forward as a green result (annotated so the operator sees it was
 * skipped, not run). The verdict `passed` reflects only the criteria that RAN — a skipped-green criterion
 * can't fail (it didn't change since it last passed). An empty `toRun` short-circuits the runner entirely.
 */
export async function runIncrementalAcceptance(
  runner: AcceptanceGateRunner,
  selection: AcceptanceSelection,
  ctx: { cwd: string },
): Promise<AcceptanceVerdict> {
  const ran = selection.toRun.length > 0 ? await runner.run(selection.toRun, ctx) : { passed: true, results: [] };
  const carried: AcceptanceResult[] = selection.skipped.map((s) => ({
    criterion: s.criterion,
    layer: s.layer,
    passed: true,
    detail: "skipped-green (inalterado desde o último green)",
  }));
  return { passed: ran.passed, results: [...ran.results, ...carried] };
}
