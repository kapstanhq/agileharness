// Regression test for the node_modules-provisioning bug (story-vovhjj).
//
// A run worktree is born from `git worktree add` (a checkout of HEAD). `node_modules/` is
// gitignored, so the fresh tree has NO deps — and they DON'T hoist: a dep installed
// per-package (`packages/<pkg>/node_modules/<dep>`) is unresolvable inside the worktree, so
// `tsc`/`just test-*`/build break by ENVIRONMENT, not logic. The fix links the main checkout's
// node_modules (root + per-package) into the worktree, instantly, with NO `bun install`.
//
// Unlike worktree.test.ts (pure, mocked exec), THIS suite needs a REAL git repo + REAL fs:
// the bug is a node-resolution failure no exec double can reproduce. We build a synthetic
// main repo with a per-package dep that does NOT hoist, then assert it resolves inside the
// worktree after create(), and — the teardown guard — that remove() never deletes the main
// checkout's node_modules through the link.

import { exec as nodeExec } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultWorktreeFs,
  deprovisionNodeModules,
  makeWorktreeOps,
  runWorktreePath,
  type ExecFn,
} from "./worktree";

const exec = promisify(nodeExec) as unknown as ExecFn;
const requireFrom = createRequire(import.meta.url);

// A synthetic main repo: a ROOT-hoisted dep (`roothoisted`) AND a PER-PACKAGE dep
// (`packages/foo/node_modules/barpkg`) that does NOT hoist — mirroring gray-matter living
// only under packages/storymap-ui/node_modules in the real monorepo.
async function writePkg(dir: string, name: string) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  await fsp.writeFile(path.join(dir, "index.js"), `module.exports = ${JSON.stringify(name)};\n`);
}

describe("worktree node_modules provisioning (real git + fs) — story-vovhjj", () => {
  let tmpRoot: string;
  let mainRepo: string;
  const sessionId = "sess-prov";
  let worktreePath: string;
  let branch: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-prov-"));
    mainRepo = path.join(tmpRoot, "main");
    await fsp.mkdir(mainRepo, { recursive: true });

    // node_modules is gitignored (as in the real repo) → `git worktree add` won't copy it. The BARE
    // form (no trailing slash) is load-bearing: it also ignores the node_modules SYMLINKS the
    // provisioner creates, so a run's `git add -A` never commits a link (see the gitignore guard test).
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(mainRepo, "README.md"), "# synthetic repo\n");
    // Tracked package (checked out into the worktree) whose dep lives ONLY per-package.
    await fsp.mkdir(path.join(mainRepo, "packages", "foo"), { recursive: true });
    await fsp.writeFile(
      path.join(mainRepo, "packages", "foo", "package.json"),
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    // The deps themselves (gitignored, never committed) — these are what the fix must link.
    await writePkg(path.join(mainRepo, "node_modules", "roothoisted"), "roothoisted");
    await writePkg(path.join(mainRepo, "packages", "foo", "node_modules", "barpkg"), "barpkg");

    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@t.dev`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m init`, { cwd: mainRepo });
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("t1/t2: a freshly created worktree resolves a PER-PACKAGE dep (gray-matter analogue)", async () => {
    const ops = makeWorktreeOps(exec, defaultWorktreeFs);
    const res = await ops.create(mainRepo, sessionId);
    worktreePath = res.worktreePath;
    branch = res.branch;

    expect(worktreePath).toBe(runWorktreePath(mainRepo, sessionId));
    // The package dir is a real checkout of HEAD; its node_modules must now be provisioned INTO the
    // worktree. existsSync through the link is the DISCRIMINATING proof: before the fix the worktree
    // has no node_modules at all, so this path is absent (the bug); after it, the link resolves.
    const pkgDir = path.join(worktreePath, "packages", "foo");
    expect(existsSync(path.join(pkgDir, "node_modules", "barpkg", "package.json"))).toBe(true);
    // The functional proof: node resolution of the per-package dep no longer THROWS from inside the
    // worktree (before the fix `require.resolve` raises MODULE_NOT_FOUND). The result is realpath'd
    // back to the main checkout (node canonicalizes through the symlink) — expected, that IS the dep.
    expect(requireFrom.resolve("barpkg", { paths: [pkgDir] })).toMatch(/barpkg/);
  });

  it("the provisioned node_modules links are gitignored — a run's `git add -A` never commits them", async () => {
    // Without this, commit() (git add -A on the run branch) would stage the node_modules SYMLINK and
    // carry it through the merge train into main — a broken absolute-path link in the repo.
    const { stdout } = await exec(`git status --porcelain`, { cwd: worktreePath });
    expect(stdout).not.toContain("node_modules");
  });

  it("t4: the worktree resolves BOTH hoisted (root) AND per-package deps", async () => {
    const pkgDir = path.join(worktreePath, "packages", "foo");
    // The ROOT link is the discriminating bit here: a hoisted dep ALWAYS resolved "by luck" (the
    // worktree sits under main/, so resolution climbs to main/node_modules) — so "it resolves" alone
    // doesn't prove the fix. The worktree having its OWN root node_modules link does.
    expect(existsSync(path.join(worktreePath, "node_modules", "roothoisted", "package.json"))).toBe(true);
    // Both deps resolve without throwing — the full chain (hoisted + per-package) is satisfied.
    expect(requireFrom.resolve("roothoisted", { paths: [pkgDir] })).toMatch(/roothoisted/);
    expect(requireFrom.resolve("barpkg", { paths: [pkgDir] })).toMatch(/barpkg/);
  });

  it("t3: teardown removes the worktree but NEVER deletes the main checkout's node_modules", async () => {
    const mainRootDep = path.join(mainRepo, "node_modules", "roothoisted", "package.json");
    const mainPkgDep = path.join(mainRepo, "packages", "foo", "node_modules", "barpkg", "package.json");
    expect(existsSync(mainRootDep)).toBe(true); // present before teardown
    expect(existsSync(mainPkgDep)).toBe(true);

    await makeWorktreeOps(exec, defaultWorktreeFs).remove(worktreePath, branch);

    // The ephemeral tree is gone…
    expect(existsSync(worktreePath)).toBe(false);
    // …but `git worktree remove --force` must NOT have followed the links into the main repo.
    expect(existsSync(mainRootDep)).toBe(true);
    expect(existsSync(mainPkgDep)).toBe(true);
  });
});

describe("deprovision SAFETY guard — never deletes a REAL node_modules — story-vovhjj", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-guard-"));
  });
  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("unlinkDir refuses a REAL directory (only unlinks symlinks/junctions)", async () => {
    const realDir = path.join(tmpRoot, "node_modules");
    await fsp.mkdir(path.join(realDir, "important-dep"), { recursive: true });
    await fsp.writeFile(path.join(realDir, "important-dep", "index.js"), "module.exports = 1;\n");

    // A real dir is NOT a link → unlinkDir must return false and leave it untouched.
    const removed = await defaultWorktreeFs.unlinkDir(realDir);
    expect(removed).toBe(false);
    expect(existsSync(path.join(realDir, "important-dep", "index.js"))).toBe(true);
  });

  it("deprovisionNodeModules over a worktree whose links point at a real main repo leaves the target intact", async () => {
    // main repo with a real per-package node_modules; a worktree dir whose node_modules is a LINK to it.
    const main = path.join(tmpRoot, "repo");
    const worktree = path.join(main, ".worktrees", "run-x");
    const mainDep = path.join(main, "node_modules", "dep", "index.js");
    await fsp.mkdir(path.dirname(mainDep), { recursive: true });
    await fsp.writeFile(mainDep, "module.exports = 1;\n");
    await fsp.mkdir(worktree, { recursive: true });
    await fsp.symlink(path.join(main, "node_modules"), path.join(worktree, "node_modules"), "junction");

    await deprovisionNodeModules(defaultWorktreeFs, main, worktree);

    // The worktree's link is gone, the main repo's real deps survive.
    expect(existsSync(path.join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(mainDep)).toBe(true);
  });
});
