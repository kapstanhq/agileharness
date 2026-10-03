// Unit tests for the repo secret scanner's CLI contract (SM-08) — colocated under storymap-ui
// so `just test-storymap` (this card's QA gate) covers it. The merge train shells out to this
// script over the merge commit, so its --range mode and FAIL-CLOSED exit code are part of the
// merge-queue's security contract. Driven over an injectable `git` (no real repo/diff needed).
import { describe, expect, it } from "vitest";
// The scanner is a root-level shared script (also wired into the real pre-commit hook).
import { runScan, buildDiffArgs, buildNameArgs } from "../../../../../../scripts/git-hooks/scan-secrets.mjs";

// A fake `git` keyed by the subcommand. `names` feeds `diff --name-only`; `diff` feeds the
// unified-diff scan. `throwOn` forces an internal error (e.g. a diff past git's maxBuffer).
function fakeGit({ names = "", diff = "", throwOn }: { names?: string; diff?: string; throwOn?: string } = {}) {
  const calls: string[][] = [];
  const git = (args: string[]) => {
    calls.push(args);
    if (throwOn && args.join(" ").includes(throwOn)) {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" });
    }
    if (args.includes("--name-only")) return names;
    return diff;
  };
  return { git, calls };
}

// A diff line that trips the high-confidence prefix rule with a REAL-looking (marker-less) AWS access key id.
// (This test file legitimately contains secret-shaped fixtures → the escape is the pragma, dogfooding the gate.)
const SECRET_DIFF = ["+++ b/src/config.ts", "@@ -0,0 +1 @@", "+const k = 'AKIA3F8ZQ2W7YB1N6XPL'"].join("\n"); // pragma: allowlist secret
const CLEAN_DIFF = ["+++ b/src/util.ts", "@@ -0,0 +1 @@", "+export const sum = (a, b) => a + b"].join("\n");
// A test FIXTURE credential — the value carries an explicit marker (the canonical AWS EXAMPLE key) → skipped.
const FIXTURE_PREFIX_DIFF = ["+++ b/src/config.ts", "@@ -0,0 +1 @@", "+const k = 'AKIAIOSFODNN7EXAMPLE'"].join("\n");
// keyword-assign: a real high-entropy value (flag) vs a fixture value carrying a 'mock' marker (skip).
const KEYWORD_REAL_DIFF = ["+++ b/src/config.ts", "@@ -0,0 +1 @@", "+const apiKey = 'aB3xK9pQ2mZ7wL5nR8tY'"].join("\n"); // pragma: allowlist secret
const KEYWORD_FIXTURE_DIFF = ["+++ b/tests/fixtures/config.ts", "@@ -0,0 +1 @@", "+const apiKey = 'mock_secret_value_1234'"].join("\n");

describe("scan-secrets — diff arg construction (--staged vs --range)", () => {
  it("--staged scans the cached diff", () => {
    expect(buildDiffArgs({ staged: true })).toEqual(["diff", "--cached", "--diff-filter=ACMR", "-U0", "--no-color"]);
    expect(buildNameArgs({ staged: true })).toEqual(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  });

  it("--range scans a committed range (e.g. the merge commit HEAD~1..HEAD)", () => {
    expect(buildDiffArgs({ range: "HEAD~1..HEAD" })).toEqual([
      "diff",
      "--diff-filter=ACMR",
      "-U0",
      "--no-color",
      "HEAD~1..HEAD",
    ]);
    expect(buildNameArgs({ range: "HEAD~1..HEAD" })).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "HEAD~1..HEAD",
    ]);
  });
});

describe("scan-secrets — runScan exit codes", () => {
  it("exit 0 on a clean diff (--staged)", () => {
    const { git } = fakeGit({ diff: CLEAN_DIFF });
    expect(runScan({ argv: ["--staged"], git, env: {} }).code).toBe(0);
  });

  it("exit 2 when a secret is found (--range)", () => {
    const { git, calls } = fakeGit({ diff: SECRET_DIFF });
    const res = runScan({ argv: ["--range", "HEAD~1..HEAD"], git, env: {} });
    expect(res.code).toBe(2);
    // it scanned the RANGE, not the cached diff
    expect(calls.some((a) => a.includes("HEAD~1..HEAD"))).toBe(true);
    expect(calls.some((a) => a.includes("--cached"))).toBe(false);
  });

  it("exit 1 (fail-CLOSED) when the scanner hits an internal error — NOT a silent exit 0", () => {
    // A diff past git's maxBuffer throws ENOBUFS. The old scanner swallowed this as exit 0
    // (fail-open); SM-08 makes it exit 1 so the merge train treats it as a block.
    const { git } = fakeGit({ throwOn: "diff", diff: CLEAN_DIFF });
    const res = runScan({ argv: ["--range", "HEAD~1..HEAD"], git, env: {} });
    expect(res.code).toBe(1);
    expect(res.internalError).toBe(true);
  });

  it("honors SKIP_SECRET_SCAN=1 (exit 0 without scanning)", () => {
    const { git, calls } = fakeGit({ diff: SECRET_DIFF });
    expect(runScan({ argv: ["--staged"], git, env: { SKIP_SECRET_SCAN: "1" } }).code).toBe(0);
    expect(calls).toHaveLength(0); // never scanned
  });
});

// The security contract of the fixture-marker relaxation: a fixture credential carrying an EXPLICIT marker in
// its VALUE is skipped, but a real (marker-less) credential is STILL flagged — the gate is not weakened.
describe("scan-secrets — fixture markers skip fake creds WITHOUT weakening the gate", () => {
  it("PREFIX: a real-looking AWS key (no marker) is STILL flagged (exit 2)", () => {
    const { git } = fakeGit({ diff: SECRET_DIFF });
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD"], git, env: {} }).code).toBe(2);
  });

  it("PREFIX: the canonical AWS EXAMPLE fixture key is skipped (exit 0)", () => {
    const { git } = fakeGit({ diff: FIXTURE_PREFIX_DIFF });
    expect(runScan({ argv: ["--staged"], git, env: {} }).code).toBe(0);
  });

  it("KEYWORD: a real high-entropy assigned value is flagged (exit 2)", () => {
    const { git } = fakeGit({ diff: KEYWORD_REAL_DIFF });
    expect(runScan({ argv: ["--staged"], git, env: {} }).code).toBe(2);
  });

  it("KEYWORD: a fixture value with a 'mock' marker is skipped (exit 0), even in a tests/fixtures path", () => {
    const { git } = fakeGit({ diff: KEYWORD_FIXTURE_DIFF });
    expect(runScan({ argv: ["--staged"], git, env: {} }).code).toBe(0);
  });
});
