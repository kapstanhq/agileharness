import { describe, expect, it, vi } from "vitest";
import {
  changedFilesInRange,
  DEFAULT_FORCE_ALL_FRAGMENTS,
  makeDiscoveryFileResolver,
  runIncrementalAcceptance,
  selectIncremental,
} from "./incremental-qa";
import type { GitRunner } from "./diff";
import type { AcceptanceGateRunner, AcceptanceSpec } from "./qa-runner";

// ADR-063 Fase 5a — incremental QA: run only what the commit range changed since the last green.
// PURE kernel over an injected resolver + changed-file list; DI'd git helper. Hermetic (no repo).

/** A resolver that maps each spec to a fixed file via a lookup on its criterion text. */
const byText = (map: Record<string, string[]>) => (s: AcceptanceSpec) => map[s.criterion] ?? [];

describe("selectIncremental — scope an acceptance suite to a commit range", () => {
  const specs: AcceptanceSpec[] = [
    { criterion: "nav aparece em /account", layer: "component" },
    { criterion: "lista carrega em /eventos", layer: "integration" },
  ];
  const resolveFiles = byText({
    "nav aparece em /account": ["src/app/account/page.tsx"],
    "lista carrega em /eventos": ["src/app/eventos/page.tsx"],
  });

  it("empty specs → nothing to do", () => {
    expect(selectIncremental([], { changedFiles: [], resolveFiles })).toEqual({ toRun: [], skipped: [], reason: "empty-specs" });
  });

  it("null range (git failed / unparseable) → run EVERYTHING (never skip on an unknown delta)", () => {
    const sel = selectIncremental(specs, { changedFiles: null, resolveFiles });
    expect(sel.reason).toBe("unknown-range");
    expect(sel.toRun).toHaveLength(2);
    expect(sel.skipped).toHaveLength(0);
  });

  it("empty range (nothing changed since last green) → skip EVERYTHING (the big win)", () => {
    const sel = selectIncremental(specs, { changedFiles: [], resolveFiles });
    expect(sel.reason).toBe("empty-range");
    expect(sel.toRun).toHaveLength(0);
    expect(sel.skipped).toHaveLength(2);
  });

  it("a GLOBAL change (config / layout / shared) forces a full run", () => {
    const sel = selectIncremental(specs, { changedFiles: ["packages/x/tsconfig.json"], resolveFiles });
    expect(sel.reason).toBe("global-change");
    expect(sel.toRun).toHaveLength(2);
  });

  it("scoped: runs only the criteria whose mapped files changed; carries the rest", () => {
    const sel = selectIncremental(specs, {
      changedFiles: ["packages/storymap-ui/src/app/account/page.tsx"], // only /account moved
      resolveFiles,
    });
    expect(sel.reason).toBe("scoped");
    expect(sel.toRun.map((s) => s.criterion)).toEqual(["nav aparece em /account"]);
    expect(sel.skipped.map((s) => s.criterion)).toEqual(["lista carrega em /eventos"]);
  });

  it("an UNMAPPED criterion (resolver returns []) is RUN, never skipped (unproven ⇒ run)", () => {
    const sel = selectIncremental(specs, {
      changedFiles: ["packages/storymap-ui/src/app/other/page.tsx"], // touches neither mapped file
      resolveFiles: byText({ "nav aparece em /account": ["src/app/account/page.tsx"] }), // /eventos unmapped
    });
    // /account is mapped + unchanged → skipped; /eventos is unmapped → run.
    expect(sel.toRun.map((s) => s.criterion)).toEqual(["lista carrega em /eventos"]);
    expect(sel.skipped.map((s) => s.criterion)).toEqual(["nav aparece em /account"]);
  });

  it("DEFAULT_FORCE_ALL_FRAGMENTS covers the global mount (layout) + monorepo config", () => {
    expect(DEFAULT_FORCE_ALL_FRAGMENTS).toContain("/layout.");
    expect(DEFAULT_FORCE_ALL_FRAGMENTS).toContain("package.json");
    // a layout change forces a full run even though no criterion maps to it
    const sel = selectIncremental(specs, { changedFiles: ["packages/x/src/app/layout.tsx"], resolveFiles });
    expect(sel.reason).toBe("global-change");
  });
});

describe("makeDiscoveryFileResolver — criterion → files via the 3c discovery artifact", () => {
  const discovery = {
    routes: [
      { route: "/account", file: "src/app/account/page.tsx", testids: ["account-bottom-nav"] },
      { route: "/eventos", file: "src/app/eventos/page.tsx", testids: ["evento-card"] },
      { route: "/eventos/novo", file: "src/app/eventos/novo/page.tsx", testids: [] },
      { route: "/", file: "src/app/page.tsx", testids: ["home-hero"] },
    ],
  };
  const resolve = makeDiscoveryFileResolver(discovery);

  it("maps a criterion that mentions a route to that route's file", () => {
    expect(resolve({ criterion: "o nav aparece em /account", layer: "component" })).toEqual(["src/app/account/page.tsx"]);
  });

  it("maps a criterion that mentions a testid to the file that declares it", () => {
    expect(resolve({ criterion: "o evento-card renderiza", layer: "component" })).toEqual(["src/app/eventos/page.tsx"]);
  });

  it("prefers the more specific nested route (longest-first) but can include both when both are named", () => {
    // "/eventos/novo" is matched; "/eventos" also substring-matches → both files (superset is safe: runs more).
    const files = resolve({ criterion: "abrir /eventos/novo a partir de /eventos", layer: "browser" });
    expect(files).toContain("src/app/eventos/novo/page.tsx");
  });

  it("returns [] when nothing is recognized (→ the criterion is run, never skipped)", () => {
    expect(resolve({ criterion: "algum critério sem rota nem testid", layer: "integration" })).toEqual([]);
  });

  it("does NOT pull every criterion into the home '/' route on a bare slash", () => {
    expect(resolve({ criterion: "usuário faz algo genérico", layer: "component" })).toEqual([]);
  });
});

describe("changedFilesInRange — the commitRange {base,head} differ over the codebase GitRunner", () => {
  const okGit = (stdout: string): GitRunner => async () => stdout;

  it("returns the changed files for a valid range (git diff --name-only base..head)", async () => {
    const git = vi.fn<GitRunner>(async () => "a.ts\nb.ts\n");
    const files = await changedFilesInRange({ base: "abc123", head: "def456" }, git);
    expect(files).toEqual(["a.ts", "b.ts"]);
    expect(git).toHaveBeenCalledWith(["diff", "--name-only", "abc123..def456"]);
  });

  it("an EMPTY output is a REAL empty answer (drives skip-everything), NOT null", async () => {
    expect(await changedFilesInRange({ base: "abc", head: "def" }, okGit(""))).toEqual([]);
  });

  it("a git error (throw) → null (unknown delta → caller runs all)", async () => {
    const failGit: GitRunner = async () => {
      throw new Error("bad revision");
    };
    expect(await changedFilesInRange({ base: "abc", head: "def" }, failGit)).toBeNull();
  });

  it("an absent / half-written / unsafe range → null WITHOUT invoking git", async () => {
    const spyGit = vi.fn<GitRunner>(async () => "");
    expect(await changedFilesInRange(null, spyGit)).toBeNull();
    expect(await changedFilesInRange({ base: "abc", head: "" }, spyGit)).toBeNull();
    expect(await changedFilesInRange({ base: "abc; rm -rf /", head: "def" }, spyGit)).toBeNull();
    expect(await changedFilesInRange({ base: "--output=/etc/x", head: "def" }, spyGit)).toBeNull();
    expect(spyGit).not.toHaveBeenCalled();
  });

  it("accepts the empty-tree base (repo-root card) + tag/HEAD~n refs", async () => {
    const git = vi.fn<GitRunner>(async () => "");
    await changedFilesInRange({ base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head: "HEAD" }, git);
    await changedFilesInRange({ base: "v1.2.0", head: "HEAD~2" }, git);
    expect(git).toHaveBeenCalledTimes(2);
  });
});

describe("runIncrementalAcceptance — run toRun, carry skipped as green", () => {
  const makeRunner = (perCriterion: Record<string, boolean>): AcceptanceGateRunner & { calls: AcceptanceSpec[][] } => {
    const calls: AcceptanceSpec[][] = [];
    return {
      calls,
      async run(specs) {
        calls.push(specs);
        const results = specs.map((s) => ({ criterion: s.criterion, layer: s.layer, passed: perCriterion[s.criterion] ?? true }));
        return { passed: results.every((r) => r.passed), results };
      },
    };
  };

  it("runs only toRun and appends skipped as green results", async () => {
    const runner = makeRunner({ "a": true });
    const verdict = await runIncrementalAcceptance(
      runner,
      { toRun: [{ criterion: "a", layer: "component" }], skipped: [{ criterion: "b", layer: "integration" }], reason: "scoped" },
      { cwd: "/repo" },
    );
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].map((s) => s.criterion)).toEqual(["a"]); // b was NOT run
    expect(verdict.passed).toBe(true);
    const b = verdict.results.find((r) => r.criterion === "b");
    expect(b).toMatchObject({ passed: true });
    expect(b?.detail).toMatch(/skipped-green/);
  });

  it("empty toRun short-circuits the runner (a fully-skipped suite is green without running anything)", async () => {
    const runner = makeRunner({});
    const verdict = await runIncrementalAcceptance(
      runner,
      { toRun: [], skipped: [{ criterion: "b", layer: "component" }], reason: "empty-range" },
      { cwd: "/repo" },
    );
    expect(runner.calls).toHaveLength(0); // runner never invoked
    expect(verdict.passed).toBe(true);
    expect(verdict.results).toHaveLength(1);
  });

  it("a real failure in toRun makes the verdict red (skipped-green can't rescue it)", async () => {
    const runner = makeRunner({ "a": false });
    const verdict = await runIncrementalAcceptance(
      runner,
      { toRun: [{ criterion: "a", layer: "component" }], skipped: [{ criterion: "b", layer: "component" }], reason: "scoped" },
      { cwd: "/repo" },
    );
    expect(verdict.passed).toBe(false);
  });
});
