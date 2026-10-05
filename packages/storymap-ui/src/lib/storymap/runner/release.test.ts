// Fase 4b RELEASE — real-git test for promoteStageToMain. Proves the human "publish" step against actual
// git: it brings ONLY the staged `packages/**` code from `stage` onto main, leaves main's (newer) board
// data intact, and is idempotent (a second promote is a clean no-op).

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describePosix } from "./test-platform";
import {
  ORIGIN_TRUST_ENV,
  classifyDeltaPath,
  classifyIncoming,
  declaredOriginTrust,
  judgeIncoming,
  mayAbsorbIncoming,
  promoteStageToMain,
} from "./release";
import { findRepoRoot } from "@/lib/storymap/paths";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import type { ExecFn } from "./worktree";

// Worktree-fragility guard: this real-git suite drives release.ts directly, so it skips the runner
// boot that creates runnerStateDir() (where release writes its patch) and runs against whatever git
// context vitest's cwd sits in. Inside the merge train's integration gate (a nested git worktree) both
// bite. `exec` is wrapped to run git in a fully isolated env; the temp repo's parent is the ceiling.
// See git-test-env.ts. Re-bound to the temp root in beforeAll once tmpRoot is known.
let exec = promisify(nodeExec) as unknown as ExecFn;
const show = async (cwd: string, ref: string) => (await exec(`git show ${ref}`, { cwd })).stdout;

describePosix("promoteStageToMain (real git) — Fase 4b release: code stage→main, path-scoped", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let baseBranch: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-release-"));
    // Isolate every git op from the host/outer-worktree context, and ensure runnerStateDir() exists
    // (release.ts writes its patch there) — the production runner boot does the latter for us in prod.
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    mainRepo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(mainRepo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "storymap", "cards"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n");
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "x.ts"), "export const x = 1;\n");
    await fsp.writeFile(path.join(mainRepo, "storymap", "cards", "c.md"), "# card\nstatus: a\n");

    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@example.test`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m base`, { cwd: mainRepo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: mainRepo })).stdout.trim();

    // `stage` carries CODE (packages/**) + a STALE data snapshot (status:a, from when it branched).
    await exec(`git checkout -q -b stage`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "x.ts"), "export const x = 2; // staged\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "usm(card): staged code"`, { cwd: mainRepo });

    // Meanwhile main's board DATA advances past stage's stale snapshot (status:a → status:b).
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "storymap", "cards", "c.md"), "# card\nstatus: b\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "board: card advance"`, { cwd: mainRepo });
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("promotes ONLY packages/** code from stage to main; main's newer data is untouched", async () => {
    const res = await promoteStageToMain({
      exec,
      repoRoot: mainRepo,
      stageBranch: "stage",
      codePrefixes: ["packages/"],
    });

    expect(res.promoted).toBe(true);
    expect(res.branch).toBe(baseBranch);
    expect(res.blocked).toBeFalsy();
    // story-ex0071 — the promoted file set is surfaced (the deploy's merged-face gate reads it).
    expect(res.changedFiles).toEqual(["packages/app/x.ts"]);
    // CODE is now live on main.
    expect(await show(mainRepo, `${baseBranch}:packages/app/x.ts`)).toContain("x = 2");
    // main's OWN newer board data survived (the stale status:a on stage did NOT clobber it).
    expect(await show(mainRepo, `${baseBranch}:storymap/cards/c.md`)).toContain("status: b");
    // The release commit is identifiable.
    const log = (await exec(`git log --oneline -1 ${baseBranch}`, { cwd: mainRepo })).stdout;
    expect(log).toContain("release:");
  });

  it("is idempotent: a second promote with nothing new staged is a clean no-op", async () => {
    const res = await promoteStageToMain({
      exec,
      repoRoot: mainRepo,
      stageBranch: "stage",
      codePrefixes: ["packages/"],
    });
    expect(res.promoted).toBe(false);
    // No-op either way: nothing new to stage, OR the --3way apply resolved to an empty commit.
    expect(res.reason).toMatch(/nada staged|já promovido|nada a commitar/i);
  });

  // Regression — a `stage` BEHIND main on packages/** (any direct code commit to main
  // makes it stale) used to promote `main..stage`, whose patch DELETES/reverts main's newer code → it
  // wiped a large block of code. The merge-base guard makes a stale (ancestor) stage a clean NO-OP instead.
  it("does NOT clobber main's newer code when stage is behind on packages/** (stale-stage guard)", async () => {
    const repo = path.join(tmpRoot, "stale");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "app", "old.ts"), "export const old = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    // stage branches HERE (it only ever saw old.ts=1) and never moves.
    await exec(`git branch stage`, { cwd: repo });
    // main advances with code stage never saw: a NEW file + an updated old file.
    await fsp.writeFile(path.join(repo, "packages", "app", "new.ts"), "export const fresh = 99;\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "old.ts"), "export const old = 2; // updated\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "main: newer code stage lacks"`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"] });

    // stage adds NOTHING main lacks → clean no-op (NOT a clobbering promote).
    expect(res.promoted).toBe(false);
    expect(res.reason).toMatch(/nada staged/i);
    // main's newer code is intact — the bug deleted new.ts and reverted old.ts to 1.
    expect(await show(repo, `${main}:packages/app/new.ts`)).toContain("fresh = 99");
    expect(await show(repo, `${main}:packages/app/old.ts`)).toContain("old = 2");
  });

  // story-ex0034 — the classic trap: `stage` carried REAL code but under a package OUTSIDE the board's
  // scoped prefix. The scoped promote finds 0 files (a silent no-op) — but the code IS staged, just not
  // where this board looks. `allCodePrefixes` (the global `packages/`) lets promoteStageToMain tell that
  // apart: outcome "out-of-scope" (a FAILURE the caller reverts), not "nothing-staged" (a legit no-op).
  it("flags out-of-scope when stage added code OUTSIDE the board's scoped prefix (story-ex0034)", async () => {
    const repo = path.join(tmpRoot, "oos");
    await fsp.mkdir(path.join(repo, "packages", "storefront"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "ledger"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "storefront", "keep.ts"), "export const k = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    // stage adds code ONLY under packages/ledger/** — outside a board scoped to packages/storefront/**.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "ledger", "feature.ts"), "export const f = 2; // staged, out of shop scope\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): staged code in ledger"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/storefront/"], // the board's scope
      allCodePrefixes: ["packages/"], // the global code roots — where the out-of-scope code hides
    });

    expect(res.promoted).toBe(false);
    expect(res.outcome).toBe("out-of-scope");
    expect(res.reason).toMatch(/fora do escopo/i);
  });

  // The legit counterpart: `stage` added NOTHING → outcome "nothing-staged" (deployable no-op), NOT a failure.
  it("reports nothing-staged (legit no-op) when stage added no code at all (story-ex0034)", async () => {
    const repo = path.join(tmpRoot, "empty");
    await fsp.mkdir(path.join(repo, "packages", "storefront"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "storefront", "keep.ts"), "export const k = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    await exec(`git branch stage`, { cwd: repo }); // stage == main → nothing added anywhere

    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/storefront/"],
      allCodePrefixes: ["packages/"],
    });

    expect(res.promoted).toBe(false);
    expect(res.outcome).toBe("nothing-staged");
  });

  // story-ex0121 — two boards LEGITIMATELY share a package (e.g. packages/shared-kit/, used by two
  // boards). Each declares it in BoardConfig.sharedPackages, so both boards' release codePrefixes cover
  // it. Promotion must be idempotent/safe across them: there is a SINGLE `stage` branch, so both boards
  // promote the SAME delta — the first lands it, the second is a clean no-op with NO duplicate commit and
  // NO conflict. This is the safety the card asks for; it rides for free on the existing --3way + empty-
  // commit guard (the fix only WIDENS the pathspec — it adds no new promotion machinery).
  it("is idempotent across two boards sharing a package: first promotes, second is a clean no-op (story-ex0121)", async () => {
    const repo = path.join(tmpRoot, "shared-pkg");
    await fsp.mkdir(path.join(repo, "packages", "storefront"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "catalog"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "shared-kit"), { recursive: true });
    // This test PROMOTES (commits) → it reaches the SM-08 secret re-scan, so the hook must exist locally.
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, "packages", "shared-kit", "util.ts"), "export const u = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    // stage adds code ONLY under the SHARED package — the code both boards' fixes touched.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "shared-kit", "util.ts"), "export const u = 2; // shared fix\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): shared-pkg fix"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    // Board ARMAZEM releases first: its sharedPackages puts packages/shared-kit/ in scope → it promotes.
    const first = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/storefront/", "packages/shared-kit/"],
      allCodePrefixes: ["packages/"],
    });
    expect(first.promoted).toBe(true);
    expect(await show(repo, `${main}:packages/shared-kit/util.ts`)).toContain("u = 2");

    // The second board then releases the SAME shared package (also in its scope) → already on main → clean no-op.
    const second = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/catalog/", "packages/shared-kit/"],
      allCodePrefixes: ["packages/"],
    });
    expect(second.promoted).toBe(false);
    expect(second.outcome).toBe("already-promoted"); // NOT out-of-scope, NOT a failure — the code is live
    // Exactly ONE release commit exists — the second board did NOT duplicate it.
    const releaseCommits = (await exec(`git log --oneline ${main}`, { cwd: repo })).stdout
      .split("\n")
      .filter((l) => l.includes("release:"));
    expect(releaseCommits).toHaveLength(1);
  });

  // story-ex0121 (bug) — a release whose delta touches a file Git treats as BINARY must still promote.
  // `.gitattributes` marks `*.snap binary` ON PURPOSE (golden snapshots must never be textually merged),
  // so `git diff` emits a `Binary files … differ` stub with no payload — and `git apply` dies with
  // "cannot apply binary patch … without full index line", failing the WHOLE release. The fix emits the
  // patch with `--binary` (full index + `GIT binary patch` payload). This test reproduces it end-to-end:
  // without --binary it goes apply-failed; with it, the binary .snap promotes clean alongside the .ts.
  it("promotes a delta that touches a Git-binary file (.snap) — full binary patch, not a stub (story-ex0121)", async () => {
    const repo = path.join(tmpRoot, "binary-snap");
    await fsp.mkdir(path.join(repo, "packages", "app", "__snapshots__"), { recursive: true });
    // This test PROMOTES (commits) → it reaches the SM-08 secret re-scan, so the hook must exist locally.
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    // The attribute is what forces Git down the binary-diff path (independent of the file's bytes) —
    // exactly the production config (root .gitattributes: `*.snap binary`).
    await fsp.writeFile(path.join(repo, ".gitattributes"), "*.snap binary\n");
    const snap = path.join("packages", "app", "__snapshots__", "board.test.ts.snap");
    await fsp.writeFile(path.join(repo, "packages", "app", "code.ts"), "export const c = 1;\n");
    await fsp.writeFile(path.join(repo, snap), "exports[`board 1`] = `\nold snapshot\n`;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    // stage regenerates the golden snapshot (the intentional change) AND touches a normal .ts file.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, snap), "exports[`board 1`] = `\nnew regenerated snapshot\n`;\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "code.ts"), "export const c = 2; // staged\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): regen snapshot + code"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"] });

    // Without --binary this is apply-failed (the exact bug); with it, a clean promote of BOTH files.
    expect(res.outcome).toBe("promoted");
    expect(res.promoted).toBe(true);
    expect(res.blocked).toBeFalsy();
    // The regenerated binary snapshot is live on main…
    expect(await show(repo, `${main}:${snap.split(path.sep).join("/")}`)).toContain("new regenerated snapshot");
    // …and the co-staged text file promoted too.
    expect(await show(repo, `${main}:packages/app/code.ts`)).toContain("c = 2");
  });
});

// #37 auto-push — the release push reconcile, proven against a FAKE exec (deterministic +
// platform-independent; mirrors how merge-queue.test.ts proves the IDENTICAL pushToOrigin reconcile).
// On a non-fast-forward push rejection, promoteStageToMain must fetch + merge FETCH_HEAD + retry the
// push so origin stays == this checkout; a reconcile conflict must abort and degrade to pushed:false.
describePosix("promoteStageToMain — auto-push reconcile on a diverged origin (#37)", () => {
  // Drives the promote happy-path (so control reaches the push) and models the push as rejected
  // `pushFails` times before succeeding. `mergeFails` forces the reconcile merge to conflict.
  function fakeExec(opts: { pushFails: number; mergeFails?: boolean }) {
    const calls: string[] = [];
    let pushes = 0;
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    const reject = (stderr: string) => {
      throw Object.assign(new Error(stderr), { code: 1, stderr });
    };
    const fexec = (async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ok("main");
      if (cmd.includes("merge-base")) return ok("basesha");
      if (cmd.includes("diff --name-only")) return ok("packages/app/x.ts"); // staged code exists
      if (cmd.includes(" diff ") && cmd.includes(">")) return ok(); // diff → patch file (redirect)
      if (cmd.includes("apply --3way")) return ok();
      if (cmd.includes("commit --no-verify")) return ok();
      if (cmd.includes("scan-secrets")) return ok(); // secret scan clean
      if (cmd.includes("rev-parse HEAD")) return ok("releasesha");
      if (cmd.includes("fetch origin")) return ok();
      if (cmd.includes("merge --no-edit FETCH_HEAD")) return opts.mergeFails ? reject("CONFLICT") : ok();
      if (cmd.includes("merge --abort")) return ok();
      if (cmd.includes("push origin")) {
        pushes += 1;
        return pushes <= opts.pushFails ? reject("! [rejected] (non-fast-forward)") : ok();
      }
      return ok();
    }) as unknown as ExecFn;
    return { fexec, calls };
  }

  it("reconciles (fetch+merge) and retries the push when origin diverged → pushed:true", async () => {
    const { fexec, calls } = fakeExec({ pushFails: 1 });
    const res = await promoteStageToMain({ exec: fexec, repoRoot: "/repo", stageBranch: "stage", codePrefixes: ["packages/"] });
    expect(res.promoted).toBe(true);
    expect(res.pushed).toBe(true);
    expect(calls.some((c) => c.includes("fetch origin"))).toBe(true);
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(calls.filter((c) => c.includes("push origin")).length).toBe(2); // initial reject + retry
  });

  it("aborts the reconcile merge on conflict → pushed:false (best-effort), tree left pristine", async () => {
    const { fexec, calls } = fakeExec({ pushFails: 99, mergeFails: true });
    const res = await promoteStageToMain({ exec: fexec, repoRoot: "/repo", stageBranch: "stage", codePrefixes: ["packages/"] });
    expect(res.promoted).toBe(true); // the local promote still happened
    expect(res.pushed).toBe(false); // reconcile conflicted → not pushed
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(true);
  });
});

// fail-clean — when the staged code does NOT apply cleanly (a genuine overlap, or a STALE
// stage whose old code collides with main's newer code), the partial `apply --3way --index` leaves
// the released worktree dirty. promoteStageToMain MUST restore the code pathspec to HEAD before
// returning, so a failed release can NEVER dirty the LIVE checkout (which the next autorun commit
// could otherwise capture and corrupt main). Deterministic fake exec (cross-platform).
describePosix("promoteStageToMain — fail-clean on a conflicting apply", () => {
  it("restores the code pathspec to HEAD when apply --3way fails → promoted:false, worktree not dirtied", async () => {
    const calls: string[] = [];
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    const reject = (stderr: string) => {
      throw Object.assign(new Error(stderr), { code: 1, stderr });
    };
    const fexec = (async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ok("main");
      if (cmd.includes("merge-base")) return ok("basesha");
      if (cmd.includes("diff --name-only")) return ok("packages/app/x.ts"); // staged code exists
      if (cmd.includes(" diff ") && cmd.includes(">")) return ok(); // diff → patch file (redirect)
      if (cmd.includes("apply --3way")) return reject("error: patch failed: packages/app/x.ts"); // stale-stage overlap
      return ok();
    }) as unknown as ExecFn;

    const res = await promoteStageToMain({ exec: fexec, repoRoot: "/repo", stageBranch: "stage", codePrefixes: ["packages/"] });

    expect(res.promoted).toBe(false);
    expect(res.reason).toMatch(/não aplicou limpo|worktree restaurada/i);
    // FAIL-CLEAN: the partial apply is reverted (scoped to the code pathspec) so the live checkout
    // is never left dirty for the next autorun commit to capture.
    expect(calls.some((c) => c.includes("checkout HEAD -- ") && c.includes("packages/"))).toBe(true);
    // A failed apply NEVER commits.
    expect(calls.some((c) => c.includes("commit --no-verify"))).toBe(false);
  });
});

// story-ex0128 — OUT-OF-BAND LANDING regression (real git). A manual rescue (a cherry-pick straight onto main,
// the CLI, another board's release carrying a shared file) makes main hold code the pipeline never promoted.
// This board's frontier does NOT advance for that, so the next release still re-diffs the WHOLE staged range
// and re-applies deltas main already absorbed. `git apply --3way` absorbs a re-included MODIFICATION silently
// (ours == theirs → clean), which is why this hid for so long — but a re-included DELETION has no 3-way
// fallback at all (`load_preimage` fails before the merge: "does not exist in index"), so the apply dies and
// the WHOLE release reports `apply-failed`. The card then reverts "No ar" → "Liberar" with a deploy-failure
// swearing the code was never published, while the code is in fact live and correct (seen in a real
// install, rescued by hand). The fix: intersect the staged range with the files main ACTUALLY lacks
// (`branch..stage`) before touching the patch — provably lossless, since an excluded file already holds
// exactly the content stage would give it.
describePosix("promoteStageToMain — code that landed out-of-band (story-ex0128)", () => {
  let root: string;
  let gitExec: ExecFn;
  const read = async (cwd: string, ref: string) => (await gitExec(`git show ${ref}`, { cwd })).stdout;

  /** A repo whose `stage` carries a staged delta that main ALREADY absorbed out-of-band (identical content). */
  const seed = async (repo: string) => {
    const exec = gitExec;
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    // These tests reach the SM-08 secret re-scan on the promoting path → the hook must exist locally.
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = raw || description;\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "dead.ts"), "export const dead = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    return (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
  };

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-oob-"));
    gitExec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, root);
    await ensureRunnerStateDir(); // release.ts writes its patch to runnerStateDir()
  });
  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // THE reported scenario: the card's code was rescued onto main by hand, so the release has nothing left to
  // do. It must SAY so (a LIVE outcome the caller lets through to the deploy), not die re-applying itself.
  it("skips the apply and reports already-promoted when main already holds every staged file (manual rescue)", async () => {
    const exec = gitExec;
    const repo = path.join(root, "rescued");
    const main = await seed(repo);

    // stage: the card's fix — edit one file, delete another.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = raw || null;\n");
    await exec(`git rm -q packages/app/dead.ts`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): the fix"`, { cwd: repo });

    // main: a human rescues the SAME change out-of-band (a cherry-pick → identical content, different sha).
    await exec(`git checkout -q ${main}`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = raw || null;\n");
    await exec(`git rm -q packages/app/dead.ts`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "rescue: cherry-pick straight onto main"`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"], board: "boardR" });

    // LIVE, not a failure: the code IS on main, so the card must reach the deploy instead of reverting.
    // Pre-fix this was `apply-failed` — the re-included deletion of dead.ts killed the apply.
    expect(res.outcome).toBe("already-promoted");
    expect(res.promoted).toBe(false);
    // The durable evidence a card is stamped with (releasedSha) — absent on failures, required on LIVE.
    expect(res.mainSha).toBe((await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim());
    // Idempotent + honest: main is untouched and the tree stays clean (no conflict markers, no partial hunks).
    expect((await exec(`git status --porcelain`, { cwd: repo })).stdout.trim()).toBe("");
    expect(await read(repo, `${main}:packages/app/fix.ts`)).toContain("raw || null");
    // The frontier advanced past this stage sha, so the next release starts from a clean base.
    expect((await exec(`git rev-parse --verify --quiet refs/promoted/boardR`, { cwd: repo })).stdout.trim()).toBe(
      (await exec(`git rev-parse stage`, { cwd: repo })).stdout.trim(),
    );
  });

  // The sharper failure: ONE stale re-included deletion used to take the whole release down with it, stranding
  // an unrelated file that genuinely needed promoting. Narrowing to what main lacks lets the real delta through.
  it("still promotes a genuinely-new staged file when a stale re-included deletion is in the same range", async () => {
    const exec = gitExec;
    const repo = path.join(root, "mixed");
    const main = await seed(repo);

    // stage: deletes dead.ts (already gone from main, below) AND adds a file main has never seen.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await exec(`git rm -q packages/app/dead.ts`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "fresh.ts"), "export const fresh = 42;\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): drop dead, add fresh"`, { cwd: repo });

    // main: the deletion already landed out-of-band; `fresh.ts` did NOT.
    await exec(`git checkout -q ${main}`, { cwd: repo });
    await exec(`git rm -q packages/app/dead.ts`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "rescue: dropped dead.ts out-of-band"`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"], board: "boardM" });

    // Pre-fix: the re-included `dead.ts` deletion failed the apply → apply-failed → `fresh.ts` never landed.
    expect(res.outcome).toBe("promoted");
    expect(await read(repo, `${main}:packages/app/fresh.ts`)).toContain("fresh = 42");
  });

  // FANTASMA DE BASE (base fantasma): a fronteira ficou VELHA — o patch dela (v1→v3) morre em 3-way contra a
  // main que já anda em v2. Mas o delta REAL (merge-base..stage = v2→v3) aplica limpo. A promoção precisa
  // tentar a base fresca antes de reportar falha — senão um release perfeitamente publicável reverte o card
  // com um "não aplicou limpo" fantasma (o revert Liberar).
  it("fantasma de base: fronteira velha reprova o 3-way, a base fresca aplica → PROMOVIDO", async () => {
    const exec = gitExec;
    const repo = path.join(root, "ghostbase");
    const main = await seed(repo);
    const F = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git update-ref refs/promoted/boardG ${F}`, { cwd: repo }); // fronteira congelada em v1

    // main avança a MESMA linha (v1→v2) — o contexto do patch da fronteira morre aqui.
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = 'v2';\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "released: v2 direto na main"`, { cwd: repo });

    // stage nasce DA MAIN v2 (stage ⊇ main — o invariante que o sync/evicção do train mantém) e leva v3.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = 'v3';\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): v3 staged"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"], board: "boardG" });

    // Pré-fix: apply-failed fantasma (patch v1→v3 conflita com ours v2). Pós-fix: base fresca v2→v3 aplica.
    expect(res.outcome).toBe("promoted");
    expect(await read(repo, `${main}:packages/app/fix.ts`)).toContain("'v3'");
  });

  it("divergência REAL: a base fresca coincide com a fronteira → apply-failed carrega divergentBase p/ a escada", async () => {
    const exec = gitExec;
    const repo = path.join(root, "realdiv");
    const main = await seed(repo);
    const F = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git update-ref refs/promoted/boardD ${F}`, { cwd: repo });

    // stage DIVERGE de verdade: nasce em F (não contém a main nova) e muda a mesma linha.
    await exec(`git checkout -q -b stage ${F}`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = 'stage-side';\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): stage diverge"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "fix.ts"), "export const summary = 'main-side';\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "released: main diverge"`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"], board: "boardD" });

    expect(res.outcome).toBe("apply-failed");
    // A base EFETIVA do 3-way reprovado viaja no resultado — é dela que a escada materializa o conflito
    // (base=ours seria tautologia: o juiz "aplicaria limpo" e nunca julgaria — o fail-closed fantasma).
    expect(res.divergentBase).toBe(F);
    expect(res.divergentFiles).toEqual(["packages/app/fix.ts"]);
    // Fail-clean: a árvore viva ficou limpa.
    expect((await exec(`git status --porcelain`, { cwd: repo })).stdout.trim()).toBe("");
  });
});

// story-ex0100 — MERGE-BASE FREEZE regression (real git). On a `stage` shared by N boards, promoteStageToMain
// RE-COMMITS the delta onto main (a NEW sha), so the stage commit never becomes a main ancestor and
// `merge-base(main, stage)` stays FROZEN at the pre-first-release point. Every later release then re-diffs
// from that frozen base and RE-INCLUDES deltas already promoted — a file touched by two releases hits a
// false add/add conflict and the 2nd release fails (`apply-failed`), stranding the code (this is exactly
// what blocked story-ex0121). The fix: a PER-BOARD frontier ref `refs/promoted/<board>` advances past each
// board's own last promotion, so the scoped diff carries only what THIS board added since — no re-inclusion.
describePosix("promoteStageToMain — per-board promotion frontier (story-ex0100)", () => {
  let root: string;
  let gitExec: ExecFn;
  const read = async (cwd: string, ref: string) => (await gitExec(`git show ${ref}`, { cwd })).stdout;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-frontier-"));
    gitExec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, root);
    await ensureRunnerStateDir(); // release.ts writes its patch to runnerStateDir()
  });
  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("a 2nd release on a re-committed (frozen merge-base) main promotes its NEW delta without re-including the 1st", async () => {
    const exec = gitExec;
    const show = read;
    const repo = path.join(root, "frontier-freeze");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    // This test PROMOTES (commits) → it reaches the SM-08 secret re-scan, so the hook must exist locally.
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    const reg = path.join(repo, "packages", "app", "reg.ts");
    // A registry-style file where each release inserts a block right after the header anchor — the shape
    // that produces the real add/add when a prior block is re-included over main's already-committed copy.
    await fsp.writeFile(reg, "// --- registry (generated) ---\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    const baseSha = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();

    // ---- Release 1: stage inserts block A after the header; promote (board-scoped). ----
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(reg, '// --- registry (generated) ---\nexport function a() {\n  return "a";\n}\n');
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card-a): block A"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const first = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/app/"], board: "boardX" });
    expect(first.promoted).toBe(true);
    // FREEZE precondition: main re-committed the delta, so merge-base is STILL the base — the stage commit
    // never became a main ancestor. This is the condition every subsequent release inherits.
    expect((await exec(`git merge-base ${main} stage`, { cwd: repo })).stdout.trim()).toBe(baseSha);

    // ---- Second promotion: stage inserts block B ABOVE block A; promote the SAME board again. ----
    await exec(`git checkout -q stage`, { cwd: repo });
    await fsp.writeFile(
      reg,
      '// --- registry (generated) ---\nexport function b() {\n  return "b";\n}\nexport function a() {\n  return "a";\n}\n',
    );
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card-b): block B"`, { cwd: repo });
    const stageHead = (await exec(`git rev-parse stage`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const second = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/app/"], board: "boardX" });

    // Under a FROZEN merge-base the 2nd diff re-includes block A (already on main) → add/add → apply-failed.
    // The per-board frontier diffs from release 1's stage sha → only block B → clean promote.
    expect(second.promoted).toBe(true);
    const live = await show(repo, `${main}:packages/app/reg.ts`);
    expect(live).toContain('return "b"'); // the NEW delta (block B) landed
    expect(live).toContain('return "a"'); // block A is still there (not clobbered)
    expect(live.match(/function a\(\)/g)).toHaveLength(1); // exactly ONE copy — no duplication from re-inclusion
    // The frontier advanced to stage HEAD so the NEXT release starts from a clean base.
    expect((await exec(`git rev-parse --verify --quiet refs/promoted/boardX`, { cwd: repo })).stdout.trim()).toBe(stageHead);
  });

  // NO-ORPHAN guard (the property that killed approach (a) — a real merge with `stage` as a parent would
  // advance merge-base to stage HEAD, so a SECOND board sharing the branch would see its own un-promoted
  // code as "already merged" → orphaned). Per-board frontier refs are INDEPENDENT: promoting board A must
  // not move board B's base, so board B still promotes ITS code.
  it("keeps per-board frontiers independent: promoting board A does not orphan board B's staged code", async () => {
    const exec = gitExec;
    const show = read;
    const repo = path.join(root, "frontier-two-boards");
    await fsp.mkdir(path.join(repo, "packages", "aApp"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "bApp"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, "packages", "aApp", "x.ts"), "export const a = 0;\n");
    await fsp.writeFile(path.join(repo, "packages", "bApp", "y.ts"), "export const b = 0;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();

    // A SINGLE shared stage carries BOTH boards' staged code.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "aApp", "x.ts"), "export const a = 1; // A staged\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card-a): A code"`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "bApp", "y.ts"), "export const b = 1; // B staged\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card-b): B code"`, { cwd: repo });
    const stageHead = (await exec(`git rev-parse stage`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q ${main}`, { cwd: repo });

    // Board A releases its OWN scope → advances refs/promoted/a to stage HEAD (re-commit → frozen merge-base).
    const relA = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/aApp/"], allCodePrefixes: ["packages/"], board: "a" });
    expect(relA.promoted).toBe(true);

    // Board B releases NEXT. Under approach (a) its code would be orphaned; the per-board frontier (absent
    // for B → merge-base fallback) still sees B's delta → it promotes.
    const relB = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/bApp/"], allCodePrefixes: ["packages/"], board: "b" });
    expect(relB.promoted).toBe(true);

    // BOTH deltas are now live on main, and each board owns an independent frontier at stage HEAD.
    expect(await show(repo, `${main}:packages/aApp/x.ts`)).toContain("a = 1");
    expect(await show(repo, `${main}:packages/bApp/y.ts`)).toContain("b = 1");
    expect((await exec(`git rev-parse --verify --quiet refs/promoted/a`, { cwd: repo })).stdout.trim()).toBe(stageHead);
    expect((await exec(`git rev-parse --verify --quiet refs/promoted/b`, { cwd: repo })).stdout.trim()).toBe(stageHead);
  });

  // A FRONTEIRA MENTIROSA (git real). A fronteira é uma OTIMIZAÇÃO; a verdade é a
  // main. Quando código entra no `stage` por fora do caminho que move a fronteira — o train integrou e a
  // escrituração da entrada morreu num restart — a fronteira fica À FRENTE daquele commit. Daí toda
  // promoção vê `frontier..stage` VAZIO, declara `nothing-staged` e AVANÇA por cima: o conteúdo fica
  // invisível para sempre, sem erro e sem log.
  //
  // Estado real encontrado: 21 arquivos em 7 pacotes vivos só no `stage`, com `refs/promoted/storymap`
  // exatamente no HEAD do stage — a fronteira jurando que tudo estava promovido.
  it("fronteira À FRENTE do que main tem: NÃO declara nothing-staged nem avança — falha nomeando os arquivos", async () => {
    const exec = gitExec;
    const repo = path.join(root, "frontier-stale");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, "packages", "app", "base.ts"), "export const base = 0;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();

    // O `stage` ganha código que NUNCA foi promovido (o merge do train que ficou órfão).
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "orfao.ts"), "export const orfao = 1;\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(sessão): código que o train integrou e ninguém promoveu"`, { cwd: repo });
    const stageHead = (await exec(`git rev-parse stage`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q ${main}`, { cwd: repo });

    // A FRONTEIRA é forçada ao HEAD do stage — exatamente o estado que a promoção anterior deixou.
    await exec(`git update-ref refs/promoted/boardF ${stageHead}`, { cwd: repo });

    const rel = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/app/"],
      allCodePrefixes: ["packages/"],
      board: "boardF",
    });

    // ANTES: `nothing-staged` + fronteira avançada = perda permanente e silenciosa.
    expect(rel.outcome).toBe("frontier-stale");
    expect(rel.promoted).toBe(false);
    expect(rel.reason).toContain("orfao.ts"); // NOMEIA o que ficou de fora — recusa sem alvo é inútil
    // E o principal: a fronteira NÃO andou, então o estado é RECUPERÁVEL em vez de definitivo.
    expect((await exec(`git rev-parse --verify --quiet refs/promoted/boardF`, { cwd: repo })).stdout.trim()).toBe(stageHead);
    // main segue sem o arquivo — a falha é honesta sobre isso (o card não pode reivindicar "No Ar").
    expect((await exec(`git cat-file -e ${main}:packages/app/orfao.ts`, { cwd: repo }).catch(() => null))).toBeNull();
  });

  // O FALSO POSITIVO que a guarda precisa evitar: `stage` ATRASADO (ancestral de main) é o caso que o
  // clobber-guard já documenta — main está à frente por construção, e ali "nada staged" é a verdade.
  // Sem esta guarda, todo board com stage atrasado passaria a reportar falha em toda publicação.
  it("stage ATRASADO (ancestral de main) segue sendo nothing-staged legítimo — sem falso positivo", async () => {
    const exec = gitExec;
    const repo = path.join(root, "frontier-stage-behind");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, "packages", "app", "base.ts"), "export const base = 0;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git branch stage`, { cwd: repo }); // stage = main, e main anda sozinha depois

    await fsp.writeFile(path.join(repo, "packages", "app", "novo-na-main.ts"), "export const n = 1;\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "código direto na main"`, { cwd: repo });

    const rel = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/app/"],
      allCodePrefixes: ["packages/"],
      board: "boardBehind",
    });
    expect(rel.outcome).toBe("nothing-staged"); // legítimo: o stage não tem nada que a main não tenha
  });
});

// story-ex0025 — CROSS-BOARD out-of-scope FALSE-POSITIVE (real git). The out-of-scope guard (story-ex0034)
// probes the GLOBAL code roots (`packages/`) to tell a legit "nothing-staged" no-op from a real scoping
// FAILURE. On the SINGLE shared `stage` branch that probe also sees code that ANOTHER board staged (and has
// NOT yet promoted through ITS OWN frontier refs/promoted/<other>) — most often packages/storymap-ui/, the
// dev tool that releases on its own independent cadence. That foreign code made the releasing board's probe
// non-empty even with its own scoped diff empty → a FALSE `out-of-scope` that reverted the card (a real
// revert loop). The fix: `otherBoardPrefixes` EXCLUDES every OTHER board's package from
// the probe (each board owns its own promotion cycle), while a package NO other board owns still trips it.
describePosix("promoteStageToMain — cross-board out-of-scope false-positive (story-ex0025)", () => {
  let root: string;
  let gitExec: ExecFn;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-xboard-"));
    gitExec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, root);
    await ensureRunnerStateDir(); // release.ts writes its patch to runnerStateDir()
  });
  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Two boards, one shared stage. Board `shop` promotes its own code (frontier advances), THEN board
  // `storymap` stages code that is NOT promoted to storymap. Armazem releases again with an EMPTY scoped diff:
  // the ONLY code on stage since shop's frontier is storymap's — another board's territory. That must be a
  // legit `nothing-staged` no-op, NOT a false `out-of-scope` revert.
  it("does NOT flag out-of-scope when the only staged code outside scope belongs to ANOTHER board", async () => {
    const exec = gitExec;
    const repo = path.join(root, "xboard");
    await fsp.mkdir(path.join(repo, "packages", "storefront"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "storymap-ui"), { recursive: true });
    // shop's first release COMMITS → it reaches the SM-08 secret re-scan, so the hook must exist locally.
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, "packages", "storefront", "keep.ts"), "export const k = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();

    // Round 1: stage carries ARMAZEM's own code. Armazem releases → promotes it, advances refs/promoted/shop.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "storefront", "feat.ts"), "export const f = 1; // shop staged\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): shop code"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const first = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/storefront/"],
      allCodePrefixes: ["packages/"],
      otherBoardPrefixes: ["packages/storymap-ui/"],
      board: "shop",
    });
    expect(first.promoted).toBe(true); // shop's code is live; refs/promoted/shop == stage HEAD after round 1

    // Round 2: ANOTHER board (storymap) stages code on the SAME shared stage — NOT promoted to storymap.
    await exec(`git checkout -q stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "storymap-ui", "tool.ts"), "export const t = 1; // storymap staged, not promoted to storymap\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): storymap code"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    // Armazem releases AGAIN. Its scoped diff (packages/storefront/ since refs/promoted/shop) is EMPTY. The ONLY
    // code on stage since shop's frontier is packages/storymap-ui/tool.ts — storymap's territory.
    //   OLD behavior: the global probe (`packages/`) sees it → out-of-scope → FALSE revert (the bug).
    //   NEW behavior: otherBoardPrefixes excludes packages/storymap-ui/ → probe empty → nothing-staged.
    const second = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/storefront/"],
      allCodePrefixes: ["packages/"],
      otherBoardPrefixes: ["packages/storymap-ui/"], // storymap's package — released on ITS OWN cadence
      board: "shop",
    });

    expect(second.promoted).toBe(false);
    expect(second.outcome).toBe("nothing-staged"); // NOT "out-of-scope" — foreign board code is excluded
  });

  // REGRESSION GUARD (story-ex0034 preserved): the exclusion is TARGETED, not a blanket mute. Code staged
  // under a package that NO other board owns (an undeclared touch — the original trap) is NOT in
  // otherBoardPrefixes, so it STILL trips out-of-scope.
  it("still flags out-of-scope for staged code under a package no OTHER board owns", async () => {
    const exec = gitExec;
    const repo = path.join(root, "xboard-genuine");
    await fsp.mkdir(path.join(repo, "packages", "storefront"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "entreposto"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "storefront", "keep.ts"), "export const k = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    // stage adds code ONLY under packages/entreposto/ — outside shop's scope, and entreposto is NOT in the exclusion
    // set (it declares no package). This is a genuine undeclared touch → must stay a FAILURE.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "entreposto", "feature.ts"), "export const c = 2; // undeclared, out of shop scope\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): staged code in entreposto"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/storefront/"],
      allCodePrefixes: ["packages/"],
      otherBoardPrefixes: ["packages/storymap-ui/", "packages/ledger/"], // other boards — but NOT entreposto
      board: "shop",
    });

    expect(res.promoted).toBe(false);
    expect(res.outcome).toBe("out-of-scope"); // entreposto code isn't excluded → still a real scoping failure
  });
});

/**
 * PUBLICAR NÃO PODE ATROPELAR TRABALHO VIVO (o embargo, virado mecanismo).
 *
 * O deploy não fazia parte do pipeline serializado do merge nem tinha guarda de concorrência real: a
 * promoção aplica um patch na MESMA árvore de trabalho de main que o train mexe, e nada perguntava se
 * outra sessão estava reescrevendo os mesmos arquivos naquele instante. A mitigação em uso era humana —
 * uma nota de embargo escrita à mão num card, que só protege o card em que alguém lembrou de escrever,
 * e só enquanto alguém lembrar de manter. Um mecanismo protege todos os cards, inclusive os que ninguém
 * previu.
 *
 * A guarda pergunta a coisa certa e POR ARQUIVO: existe worktree vivo ou entrada na fila tocando algum
 * dos arquivos que ESTA promoção carregaria? Por arquivo e não global de propósito — um cadeado global
 * faria N sessões pararem a fila umas das outras, que é o anti-objetivo do trabalho paralelo.
 */
describePosix("promoteStageToMain — guarda de concorrência por arquivo", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-conc-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "x.ts"), "export const x = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "x.ts"), "export const x = 2; // staged\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): staged code"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("RECUSA publicar quando outra sessão viva está mexendo nos MESMOS arquivos, e diz quem e quais", async () => {
    const probed: string[][] = [];
    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/"],
      concurrentWork: async (files) => {
        probed.push(files);
        return [{ owner: "agent/outra-sessao", files: ["packages/app/x.ts"] }];
      },
    });

    expect(res.promoted).toBe(false);
    expect(res.outcome).toBe("concurrent-work");
    // Acionável: nomeia o DONO e o ARQUIVO. Uma recusa sem isso é indistinguível de um bug — foi
    // exatamente esse o defeito do `returned-to-session` sem motivo.
    expect(res.reason).toContain("agent/outra-sessao");
    expect(res.reason).toContain("packages/app/x.ts");
    // A sonda recebe o conjunto REAL que a promoção carregaria, não o branch inteiro.
    expect(probed[0]).toContain("packages/app/x.ts");
    // E main NÃO avançou: o código continua staged, publicável depois, sem nada perdido.
    expect((await exec(`git show ${baseBranch}:packages/app/x.ts`, { cwd: repo })).stdout).toContain("x = 1");
  });

  it("publica normalmente quando o trabalho vivo NÃO toca os arquivos desta promoção", async () => {
    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/"],
      concurrentWork: async () => [{ owner: "agent/outro-pacote", files: ["packages/outro/y.ts"] }],
    });
    expect(res.promoted).toBe(true);
    expect((await exec(`git show ${baseBranch}:packages/app/x.ts`, { cwd: repo })).stdout).toContain("x = 2");
  });
});

describePosix("promoteStageToMain — território declarado por PREFIXO (sessão sem árvore isolada)", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-prefix-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "storefront"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n");
    await fsp.writeFile(path.join(repo, "packages", "storefront", "svc.js"), "const a = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "storefront", "svc.js"), "const a = 2; // staged\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): staged"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("um PREFIXO reivindicado segura os arquivos que caem sob ele (o caso da sessão adotada)", async () => {
    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/"],
      concurrentWork: async () => [{ owner: "sessão adotada (board shop, sem árvore isolada)", files: ["packages/storefront/"] }],
    });
    expect(res.outcome).toBe("concurrent-work");
    expect(res.reason).toContain("packages/storefront/svc.js");
  });

  it("um prefixo de OUTRO board não segura esta publicação (o território é limitado, não global)", async () => {
    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/"],
      concurrentWork: async () => [{ owner: "sessão adotada (board balcao)", files: ["packages/entreposto/"] }],
    });
    expect(res.promoted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RENAME (`git mv`) — o defeito que deixou uma cópia órfã em main.
//
// `git diff --name-only` com detecção de rename LIGADA (o default) lista apenas o caminho NOVO de um
// `git mv`. O caminho ANTIGO some da lista → some do pathspec → some do patch: main recebe o arquivo
// novo e FICA com o velho, e o release ainda devolve `promoted`. O merge train já tinha sido curado
// disto (merge-queue.ts, o caso de um módulo renomeado); o release ficou uma camada atrás.
//
// Este teste falha sem `--no-renames` em release.ts — reprovando por CONTEÚDO de main, não por
// mensagem de retorno: o desfecho `promoted` era exatamente a parte que já mentia.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describePosix("promoteStageToMain — um `git mv` staged carrega as DUAS metades (delete + add)", () => {
  let root: string;
  let gitExec: ExecFn;

  const seed = async (repo: string): Promise<string> => {
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "tools", "velho"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "keep.ts"), "export const keep = 1;\n");
    await fsp.writeFile(path.join(repo, "tools", "velho", "pagina.html"), "<h1>terminal</h1>\n");
    await gitExec(`git init -q`, { cwd: repo });
    await gitExec(`git config user.email t@example.test`, { cwd: repo });
    await gitExec(`git config user.name tester`, { cwd: repo });
    await gitExec(`git add -A`, { cwd: repo });
    await gitExec(`git commit -q --no-verify -m base`, { cwd: repo });
    return (await gitExec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
  };

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-rename-"));
    gitExec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, root);
    await ensureRunnerStateDir();
  });
  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("promove o `git mv` INTEIRO: o destino nasce em main e a ORIGEM deixa de existir", async () => {
    const exec = gitExec;
    const repo = path.join(root, "mv");
    const main = await seed(repo);

    // stage: exatamente o movimento que quebrou — um arquivo sai de tools/ e entra em packages/.
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.mkdir(path.join(repo, "packages", "app", "public"), { recursive: true });
    await exec(`git mv tools/velho/pagina.html packages/app/public/pagina.html`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): move a página para dentro do app"`, { cwd: repo });
    // Sanidade: o git REALMENTE vê isto como rename (senão o teste não exercita o defeito).
    expect(
      (await exec(`git diff --name-status -M ${main}..stage`, { cwd: repo })).stdout,
    ).toMatch(/^R\d*\s/m);

    await exec(`git checkout -q ${main}`, { cwd: repo });
    const res = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      // Escopo largo (as duas pontas do movimento) — é o caso real: `tools/` e `packages/` são ambos
      // código promovível do board.
      codePrefixes: ["packages/", "tools/"],
      board: "boardMV",
    });

    expect(res.outcome).toBe("promoted");

    // O QUE IMPORTA: main não pode ter as duas cópias. Pré-correção, `promoted` era true e este
    // assert falhava — o arquivo velho sobrevivia para sempre.
    const emMain = (await exec(`git ls-tree -r --name-only HEAD`, { cwd: repo })).stdout;
    expect(emMain).toContain("packages/app/public/pagina.html");
    expect(emMain).not.toContain("tools/velho/pagina.html");

    // E a árvore de trabalho fica limpa (nada de meia-aplicação).
    expect((await exec(`git status --porcelain`, { cwd: repo })).stdout.trim()).toBe("");
  });

  it("uma segunda promoção do mesmo `git mv` é no-op limpo (idempotência do par delete+add)", async () => {
    const exec = gitExec;
    const repo = path.join(root, "mv2");
    const main = await seed(repo);

    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.mkdir(path.join(repo, "packages", "app", "public"), { recursive: true });
    await exec(`git mv tools/velho/pagina.html packages/app/public/pagina.html`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): move"`, { cwd: repo });
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const opts = {
      exec,
      repoRoot: repo,
      stageBranch: "stage",
      codePrefixes: ["packages/", "tools/"],
      board: "boardMV2",
    };
    expect((await promoteStageToMain(opts)).outcome).toBe("promoted");
    // Segunda vez: nada a fazer — e, sobretudo, nada que re-crie o arquivo removido.
    const segunda = await promoteStageToMain(opts);
    expect(["already-promoted", "nothing-staged"]).toContain(segunda.outcome);
    expect(
      (await exec(`git ls-tree -r --name-only HEAD`, { cwd: repo })).stdout,
    ).not.toContain("tools/velho/pagina.html");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-ex0014 — FRONTEIRA DE CONTRIBUIÇÃO no self-deploy (e NÃO aprovação humana)
//
// O ATAQUE. `origin` é público (é o que "publicar o AgileHarness como OSS" significa) e um terceiro
// consegue pôr um commit em `origin/main` — via PR mergeado, via um token vazado, via qualquer caminho
// que não seja o merge train desta máquina. Ele não precisa de mais nada: basta ESPERAR. Na próxima
// publicação do dono, o `git push` do release é recusado (origin andou), e o release "reconcilia" — um
// `fetch origin main` + `merge FETCH_HEAD` — trazendo o commit do terceiro para dentro da árvore de
// trabalho de main. É essa árvore que o self-deploy builda e reinicia como root. Ou seja: código de
// fora chegava à produção sem passar pelo train, sem gate, sem ninguém decidir nada, de carona num
// retry de push. O reconcile foi feito para reconciliar DADO de outro checkout do dono; nunca para ser
// um canal de contribuição.
//
// A CORREÇÃO NÃO É APROVAÇÃO HUMANA. A publicação segue autônoma: o dono e a frota nunca chegam por
// aqui (eles entram pelo train e saem pelo promote). O que muda é a PROVENIÊNCIA — o que veio de fora
// e carrega CÓDIGO não é absorvido por um reconcile sob a fronteira declarada `public`; o push
// simplesmente fica para depois (é best-effort e cumulativo por desenho). Sob a fronteira default
// (`owner`, a topologia de hoje) o comportamento é o de sempre — só passa a deixar rastro.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describePosix("promoteStageToMain — fronteira de contribuição (story-ex0014)", () => {
  /** Roda o corpo com a fronteira declarada, restaurando o env depois (o default é a ausência da var). */
  const withTrust = async <T>(trust: string | undefined, body: () => Promise<T>): Promise<T> => {
    const before = process.env[ORIGIN_TRUST_ENV];
    if (trust === undefined) delete process.env[ORIGIN_TRUST_ENV];
    else process.env[ORIGIN_TRUST_ENV] = trust;
    try {
      return await body();
    } finally {
      if (before === undefined) delete process.env[ORIGIN_TRUST_ENV];
      else process.env[ORIGIN_TRUST_ENV] = before;
    }
  };

  // Fake exec determinístico (espelha o do bloco #37): leva o promote até o push, recusa o push como
  // non-fast-forward, e responde ao diff de PROVENIÊNCIA (`HEAD...FETCH_HEAD`) com o que `origin` traz.
  function fakeExec(incoming: string) {
    const calls: string[] = [];
    let pushes = 0;
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    const reject = (stderr: string) => {
      throw Object.assign(new Error(stderr), { code: 1, stderr });
    };
    const fexec = (async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return ok("main");
      if (cmd.includes("merge-base")) return ok("basesha");
      if (cmd.includes("HEAD...FETCH_HEAD")) return ok(incoming); // o que veio DE FORA
      if (cmd.includes("diff --name-only")) return ok("packages/app/x.ts"); // o código staged do dono
      if (cmd.includes(" diff ") && cmd.includes(">")) return ok();
      if (cmd.includes("apply --3way")) return ok();
      if (cmd.includes("commit --no-verify")) return ok();
      if (cmd.includes("scan-secrets")) return ok();
      if (cmd.includes("rev-parse HEAD")) return ok("releasesha");
      if (cmd.includes("fetch origin")) return ok();
      if (cmd.includes("merge --no-edit FETCH_HEAD")) return ok();
      if (cmd.includes("push origin")) {
        // O 1º push é RECUSADO (origin andou — é o que abre o caminho do reconcile); um 2º, se houver,
        // passa. Assim `pushed:false` só pode significar "o reconcile não aconteceu".
        pushes += 1;
        return pushes === 1 ? reject("! [rejected] (non-fast-forward)") : ok();
      }
      return ok();
    }) as unknown as ExecFn;
    return { fexec, calls };
  }

  const promote = (exec: ExecFn) =>
    promoteStageToMain({ exec, repoRoot: "/repo", stageBranch: "stage", codePrefixes: ["packages/"] });

  it("com a fronteira DECLARADA public, código de terceiro em origin NÃO entra na árvore que o deploy publica", async () => {
    const { fexec, calls } = await withTrust("public", async () => {
      const h = fakeExec("packages/app/backdoor.ts");
      await promote(h.fexec);
      return h;
    });
    // O merge que absorveria o commit do terceiro NUNCA acontece.
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(false);
    // E o release NÃO fica esperando ninguém: o promote local aconteceu, só o push ficou para depois.
    const res = await withTrust("public", async () => promote(fakeExec("packages/app/backdoor.ts").fexec));
    expect(res.promoted).toBe(true); // a publicação autônoma segue — nenhum humano foi inserido
    expect(res.pushed).toBe(false); // best-effort, cumulativo: o push seguinte recupera
  });

  it("BOARD DATA de outro checkout do dono continua reconciliando, mesmo sob a fronteira public", async () => {
    // A fronteira separa CONTRIBUIÇÃO de RECONCILIAÇÃO — não pode custar o propósito do mecanismo.
    const { calls, res } = await withTrust("public", async () => {
      const h = fakeExec("storymap/boards/shop/cards/story-1.md");
      const res = await promote(h.fexec);
      return { calls: h.calls, res };
    });
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(res.pushed).toBe(true);
  });

  it("DEFAULT (nenhuma fronteira declarada) = comportamento de hoje: reconcilia e empurra", async () => {
    const { calls, res } = await withTrust(undefined, async () => {
      const h = fakeExec("packages/app/outro.ts");
      const res = await promote(h.fexec);
      return { calls: h.calls, res };
    });
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(res.pushed).toBe(true);
  });

  it("ATAQUE: quebrar o diff de proveniência para o merge passar por 'origin não trouxe nada'", async () => {
    // A régua lia só o `stdout` do `git diff HEAD...FETCH_HEAD`. Um diff que FALHA devolve stdout vazio,
    // e vazio significava "nothing" — a única classe que a fronteira sempre absorve. Ou seja: o caso em
    // que NÃO SE SABE o que origin traz era exatamente o caso que entrava na árvore que o self-deploy
    // builda e reinicia como root. O sibling desta régua (`verificationDemand`, merge-queue.ts) já
    // verifica fail-closed quando o diff é ilegível; aqui a mesma incerteza liberava.
    //
    // Provocar isso não exige controlar o repositório: qualquer erro do git nesse ponto serve — um
    // `FETCH_HEAD` que o fetch deixou parcial, um objeto ausente após um fetch interrompido, o lock do
    // índice tomado por outro escritor do checkout (o train roda na MESMA árvore).
    const { calls } = await withTrust("public", async () => {
      const h = fakeExec("packages/app/backdoor.ts");
      const original = h.fexec as unknown as (cmd: string, opts?: unknown) => Promise<unknown>;
      const quebrado = (async (cmd: string, opts?: unknown) => {
        if (cmd.includes("HEAD...FETCH_HEAD")) {
          throw Object.assign(new Error("fatal: bad object FETCH_HEAD"), { code: 128, stderr: "fatal: bad object" });
        }
        return original(cmd, opts);
      }) as unknown as ExecFn;
      await promoteStageToMain({ exec: quebrado, repoRoot: "/repo", stageBranch: "stage", codePrefixes: ["packages/"] });
      return { calls: h.calls };
    });
    expect(
      calls.some((c) => c.includes("merge --no-edit FETCH_HEAD")),
      "diff ILEGÍVEL virou 'origin não trouxe nada' e o merge absorveu o que ninguém conseguiu classificar",
    ).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // story-ex0097 — O ATAQUE PELA SEGUNDA RÉGUA.
  //
  // A onda anterior deixou no ar DUAS definições incompatíveis de "o que não pode passar", e o atacante
  // só precisa escolher a mais permissiva. O gate do train (`verificationDemand`) classificava
  // `scripts/git-hooks/scan-secrets.mjs`, `.github/**`, `justfile` e `storymap/settings.yaml` como
  // CONTROLE — os arquivos que SÃO o mecanismo de segurança. A fronteira de proveniência, na mesma onda,
  // chamava esses MESMOS arquivos de DADO, porque não começam por `packages/` — e `outside-data` é a
  // classe que o reconcile absorve SEMPRE, inclusive sob a fronteira `public`.
  //
  // Logo, um terceiro que pusesse em `origin/main` um commit reescrevendo o próprio scanner de segredo
  // (ou desligando o gate em `storymap/settings.yaml`) não precisava de mais nada: na publicação seguinte
  // o release o traria para a árvore que o self-deploy builda e reinicia como root — recusado pelo gate,
  // aceito pela fronteira. Desativação do controle de segurança pelo caminho que o controle não cobria.
  // ───────────────────────────────────────────────────────────────────────────────────────────────
  it("ATAQUE: pôr o PRÓPRIO scanner de segredo em origin e esperar a fronteira chamá-lo de 'dado'", async () => {
    const { calls, res } = await withTrust("public", async () => {
      const h = fakeExec("scripts/git-hooks/scan-secrets.mjs");
      const res = await promote(h.fexec);
      return { calls: h.calls, res };
    });
    expect(
      calls.some((c) => c.includes("merge --no-edit FETCH_HEAD")),
      "o reconcile absorveu o mecanismo de controle porque a fronteira o classificava como DADO",
    ).toBe(false);
    // E a publicação NÃO para por isso: o promote local aconteceu, só o push ficou para depois.
    expect(res.promoted).toBe(true);
    expect(res.pushed).toBe(false);
  });

  it("ATAQUE: desligar o gate por `storymap/settings.yaml` — o arquivo que declara se o gate roda", async () => {
    // O caso extremo: `mergeGate.enabled: false` chegando de fora. Mora fora de `storymap/boards/**`
    // (não é board-data, é configuração do harness), e era exatamente por isso que passava.
    const { calls } = await withTrust("public", async () => {
      const h = fakeExec("storymap/settings.yaml");
      await promote(h.fexec);
      return { calls: h.calls };
    });
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(false);
  });

  it("codePrefixes INDECLARADO: a classe fica `code` para tudo fora de board-data/controle — e o VEREDITO não muda", () => {
    // `code` e `unclassified` exigem a mesma decisão (verificar); indeclarado só não inventa uma pasta de código.
    expect(classifyDeltaPath("src/bicicleta/quadro.ts", undefined)).toBe("code");
    expect(classifyDeltaPath("storymap/boards/oficina/cards/story-ex9962.md", undefined)).toBe("board-data");
    expect(classifyDeltaPath("justfile", undefined)).toBe("control");
    // declarado: o de sempre (fora do prefixo = unclassified); [] declarado = nada é código
    expect(classifyDeltaPath("src/bicicleta/quadro.ts", ["packages/"])).toBe("unclassified");
    expect(classifyDeltaPath("src/bicicleta/quadro.ts", [])).toBe("unclassified");
    expect(classifyIncoming(["src/bicicleta/quadro.ts"], undefined)).toBe("outside-code");
    expect(classifyIncoming(["storymap/boards/oficina/cards/story-ex9962.md"], undefined)).toBe("outside-data");
    expect(judgeIncoming(["src/bicicleta/quadro.ts"], undefined, { trust: "public" }).absorb).toBe(false);
  });

  it("a régua de proveniência: CÓDIGO de fora ≠ dado de fora ≠ nada de fora", () => {
    expect(classifyIncoming([], ["packages/"])).toBe("nothing");
    // UMA régua com o gate (`classifyDeltaPath`): só `storymap/boards/**` é dado PROVADO. `docs/y.md` era
    // chamado de dado por não estar sob `packages/` — inferência de prefixo, a mesma que abriu o buraco.
    expect(classifyIncoming(["storymap/boards/x/cards/c.md"], ["packages/"])).toBe("outside-data");
    expect(classifyIncoming(["storymap/boards/x/cards/c.md", "docs/y.md"], ["packages/"])).toBe("outside-code");
    expect(classifyIncoming(["docs/y.md", "packages/app/x.ts"], ["packages/"])).toBe("outside-code");
    // O mecanismo de controle é NOMEADO, não confundido com dado nem com código de feature.
    expect(classifyIncoming(["scripts/git-hooks/scan-secrets.mjs"], ["packages/"])).toBe("outside-control");
    expect(classifyIncoming([".github/workflows/ci.yml"], ["packages/"])).toBe("outside-control");
    expect(classifyIncoming(["justfile"], ["packages/"])).toBe("outside-control");
    expect(classifyIncoming(["storymap/settings.yaml"], ["packages/"])).toBe("outside-control");
    // Delta MISTO cai na classe PIOR, nunca na mais branda: um card + o justfile é um justfile.
    expect(classifyIncoming(["storymap/boards/x/cards/c.md", "justfile"], ["packages/"])).toBe("outside-control");
    // Uma classe NOVA nasce recusada sob `public` (a allow-list de `mayAbsorbIncoming` é o que garante).
    expect(mayAbsorbIncoming("outside-control", "public")).toBe(false);
    expect(mayAbsorbIncoming("outside-control", "owner")).toBe(true); // o default segue byte-idêntico
    // A fronteira é DECLARADA e o default é a topologia de hoje.
    expect(declaredOriginTrust({})).toBe("owner");
    expect(declaredOriginTrust({ [ORIGIN_TRUST_ENV]: "PUBLIC" })).toBe("public");
    expect(declaredOriginTrust({ [ORIGIN_TRUST_ENV]: "qualquer-coisa" })).toBe("owner");
    // Diff ILEGÍVEL não é "nada de fora": é INCERTEZA, e incerteza não pode ser a classe mais permissiva.
    expect(classifyIncoming([], ["packages/"], { readable: false })).toBe("unknown");
    expect(classifyIncoming(["docs/y.md"], ["packages/"], { readable: false })).toBe("unknown");
    expect(classifyIncoming([], ["packages/"], { readable: true })).toBe("nothing");
    // Duas combinações são recusadas — e nenhuma delas depende de um humano.
    expect(mayAbsorbIncoming("outside-code", "public")).toBe(false);
    expect(mayAbsorbIncoming("unknown", "public")).toBe(false);
    expect(mayAbsorbIncoming("unknown", "owner")).toBe(true); // o default segue byte-idêntico
    expect(mayAbsorbIncoming("outside-code", "owner")).toBe(true);
    expect(mayAbsorbIncoming("outside-data", "public")).toBe(true);
    expect(mayAbsorbIncoming("nothing", "public")).toBe(true);
  });

  it("o veredito que os TRÊS reconciles consomem: uma decisão + um rastro que diz a verdade", () => {
    // A duplicação da régua nos call sites foi o que produziu o defeito, então a decisão inteira vive num
    // lugar. `trust` é injetável para o teste não depender do env do processo.
    const controle = judgeIncoming(["scripts/git-hooks/scan-secrets.mjs"], ["packages/"], { trust: "public" });
    expect(controle.absorb).toBe(false);
    expect(controle.provenance).toBe("outside-control");
    expect(controle.detail).toContain("MECANISMO DE CONTROLE"); // o rastro nomeia o que é, não "código"
    expect(controle.detail).toContain("scan-secrets.mjs"); // e nomeia o arquivo

    // Board-data segue passando sob `public` (é o propósito do mecanismo) e sem gritar nada.
    const dado = judgeIncoming(["storymap/boards/x/cards/c.md"], ["packages/"], { trust: "public" });
    expect(dado.absorb).toBe(true);
    expect(dado.detail).toBe("");

    // O DEFAULT absorve — a autonomia de publicação não muda —, mas nunca em silêncio.
    const dono = judgeIncoming(["packages/app/x.ts"], ["packages/"], { trust: "owner" });
    expect(dono.absorb).toBe(true);
    expect(dono.detail).toContain("`owner`");

    // Diff ilegível: recusa sob `public`, e o rastro diz que ninguém conseguiu classificar.
    const cego = judgeIncoming([], ["packages/"], { readable: false, trust: "public" });
    expect(cego.absorb).toBe(false);
    expect(cego.detail).toContain("NÃO CONSEGUIMOS classificar");
  });
});

// WP5-F2 — o desfazer do release bloqueado pelo secret-scan era `reset --hard HEAD^1` no checkout de RUNTIME: todo card
// tocado por MCP desde o último flush (modificado, ainda não versionado) voltava junto — inclusive quando o bloqueio
// era um INTERNAL_ERROR do scanner num diff grande. O release só desfaz o que ELE escreveu.
describePosix("promoteStageToMain — release bloqueado pelo scan desfaz SÓ o próprio commit", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;
  const read = (rel: string) => fsp.readFile(path.join(repo, rel), "utf8");

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-release-blocked-"));
    exec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "b", "cards"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "app", "x.ts"), "export const x = 1;\n");
    await fsp.writeFile(path.join(repo, "storymap", "boards", "b", "cards", "c.md"), "---\nstatus: a\n---\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "x.ts"), "export const x = 2; // staged\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "novo.ts"), "export const novo = true;\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "usm(card): staged code"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });
    // O scanner do alvo falha como no caso real (INTERNAL_ERROR): qualquer saída ≠ 0 bloqueia o release.
    await fsp.writeFile(path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"), "console.error('INTERNAL_ERROR: maxBuffer'); process.exit(2);\n");
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("cards modificado e novo (não versionados, escritos por MCP) sobrevivem byte a byte; o código volta ao HEAD; HEAD não anda", async () => {
    const head = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();
    const modified = "---\nstatus: b\nmovidoPor: mcp\n---\n";
    const created = "---\nstatus: triagem\ntitle: aceito na triagem\n---\n";
    await fsp.writeFile(path.join(repo, "storymap", "boards", "b", "cards", "c.md"), modified);
    await fsp.writeFile(path.join(repo, "storymap", "boards", "b", "cards", "n.md"), created);

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/"] });

    expect(res).toMatchObject({ promoted: false, outcome: "blocked", blocked: true, reason: expect.stringMatching(/secret-scan bloqueou/) });
    expect((await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim()).toBe(head);
    expect(await read("storymap/boards/b/cards/c.md")).toBe(modified);
    expect(await read("storymap/boards/b/cards/n.md")).toBe(created);
    // o que o release escreveu voltou: o arquivo modificado ao texto de HEAD, o criado sumiu — índice e disco
    expect(await read("packages/app/x.ts")).toBe("export const x = 1;\n");
    await expect(fsp.access(path.join(repo, "packages", "app", "novo.ts"))).rejects.toThrow();
    expect((await exec(`git status --porcelain -- packages`, { cwd: repo })).stdout.trim()).toBe("");
    expect((await exec(`git diff --cached --name-only`, { cwd: repo })).stdout.trim()).toBe("");
  });
});


// A MAIN À FRENTE num arquivo do escopo — o «Publicar» nunca reverte na main conteúdo mais novo que o da stage. Dois jeitos
// de a main estar à frente: ela mudou o arquivo DE NOVO depois de receber o da stage, ou DESFEZ o que recebeu. O segundo
// o 3-way sozinho não pega: contra a base velha (o merge-base congelado, porque a promoção re-commita o delta), o patch da
// stage aplica «limpo» por cima do desfazer. A régua por conteúdo (stage-content.ts) o tira do conjunto a promover.
describePosix("promoteStageToMain — stage ATRÁS da main num caminho do escopo", () => {
  let tmpRoot: string;
  let repo: string;
  let main: string;
  const read = (rel: string) => fsp.readFile(path.join(repo, rel), "utf8");
  const commit = async (msg: string) => {
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m ${JSON.stringify(msg)}`, { cwd: repo });
  };

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-release-behind-"));
    exec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(path.join(repo, "packages", "vitrine"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"), path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"));
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "preco.ts"), "export const preco = 1;\n");
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "selo.ts"), "export const selo = 'a';\n");
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "nota.ts"), "export const nota = 'x';\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await commit("base");
    main = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    // a stage muda preco e selo; a promoção RE-COMMITA as duas mudanças na main (commits novos, não os da stage)
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "preco.ts"), "export const preco = 2;\n");
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "selo.ts"), "export const selo = 'b';\n");
    await commit("usm(card): preco 2, selo b");
    await exec(`git checkout -q ${main}`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "preco.ts"), "export const preco = 2;\n");
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "selo.ts"), "export const selo = 'b';\n");
    await commit("release: promove preco 2, selo b");
    // depois, a MAIN anda: o preco muda de novo, e o selo é DESFEITO (volta ao de antes) — os dois mais novos que a stage
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "preco.ts"), "export const preco = 3;\n");
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "selo.ts"), "export const selo = 'a';\n");
    await commit("conserto direto na main: preco 3, selo desfeito");
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("nada da stage é mais novo ⇒ nada a aplicar, e a main fica INTACTA (o selo desfeito não volta)", async () => {
    const head = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();
    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/vitrine/"] });
    expect(res.promoted).toBe(false);
    expect(res.outcome).toBe("already-promoted");
    expect((await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim()).toBe(head);
    expect(await read("packages/vitrine/preco.ts")).toBe("export const preco = 3;\n");
    expect(await read("packages/vitrine/selo.ts")).toBe("export const selo = 'a';\n");
  });

  it("com uma entrega NOVA na stage, só ela sobe — preco e selo da main seguem os da main", async () => {
    await exec(`git checkout -q stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "vitrine", "nota.ts"), "export const nota = 'y';\n");
    await commit("usm(card): nota y");
    await exec(`git checkout -q ${main}`, { cwd: repo });

    const res = await promoteStageToMain({ exec, repoRoot: repo, stageBranch: "stage", codePrefixes: ["packages/vitrine/"] });
    expect(res.promoted).toBe(true);
    const files = (await exec(`git show --name-only --format= HEAD`, { cwd: repo })).stdout.trim().split("\n");
    expect(files).toEqual(["packages/vitrine/nota.ts"]);
    expect(await read("packages/vitrine/nota.ts")).toBe("export const nota = 'y';\n");
    expect(await read("packages/vitrine/preco.ts")).toBe("export const preco = 3;\n");
    expect(await read("packages/vitrine/selo.ts")).toBe("export const selo = 'a';\n");
  });
});
