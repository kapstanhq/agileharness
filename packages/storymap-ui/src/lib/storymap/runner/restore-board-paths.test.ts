import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGit, type GitRunner } from "./git";
import { defaultExec } from "./worktree";
import { restoreDataPaths } from "./merge-queue";

// WS1.2 — restoreDataPaths replaces a wide `git reset --hard HEAD` on the LIVE checkout with a
// storymap/boards/-scoped restore. Proven against REAL git in a throwaway repo (the whole point is git's
// actual checkout/clean/reset semantics), NOT a fake.
async function initRepo(): Promise<{ dir: string; git: GitRunner }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "restore-board-"));
  const git = makeGit(defaultExec, { cwd: dir, timeoutMs: 30_000 });
  await git(`init -q`);
  await git(`config user.email t@t.co`);
  await git(`config user.name tester`);
  await fsp.mkdir(path.join(dir, "storymap/boards/b/cards"), { recursive: true });
  await fsp.mkdir(path.join(dir, "packages/foo"), { recursive: true });
  await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "orig card\n");
  await fsp.writeFile(path.join(dir, "packages/foo/code.ts"), "export const A = 1;\n");
  await git(`add -A`);
  await git(`commit -q -m seed --no-verify`);
  return { dir, git };
}

const exists = (p: string) => fsp.access(p).then(() => true).catch(() => false);

describe("restoreDataPaths (WS1.2) — path-scoped park never clobbers out-of-boards work", () => {
  let dir: string;
  let git: GitRunner;
  beforeEach(async () => {
    ({ dir, git } = await initRepo());
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("restores boards/ (modified card reverted + new untracked file removed) while a tracked edit OUTSIDE boards/ SURVIVES", async () => {
    // a failed board-data apply: a staged card mutation + a leftover NEW board file + an unrelated code edit.
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "MUTATED by a failed apply\n");
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/new.md"), "leftover from a failed apply\n");
    await git(`add -- storymap/boards/`);
    await fsp.writeFile(path.join(dir, "packages/foo/code.ts"), "export const A = 999; // WIP não commitado\n");

    const res = await restoreDataPaths(git, dir);

    expect(res.ok).toBe(true);
    // boards/ pristine: card reverted to HEAD, the leftover NEW file removed
    expect(await fsp.readFile(path.join(dir, "storymap/boards/b/cards/x.md"), "utf8")).toBe("orig card\n");
    expect(await exists(path.join(dir, "storymap/boards/b/cards/new.md"))).toBe(false);
    // the OUT-OF-BOARDS edit SURVIVES — the exact clobber this fix closes
    expect(await fsp.readFile(path.join(dir, "packages/foo/code.ts"), "utf8")).toContain("999");
    const status = await git(`status --porcelain`);
    expect(status.stdout).toContain("packages/foo/code.ts");
    expect(status.stdout).not.toContain("storymap/boards/");
  });

  it("ABORTS without touching the checkout when CODE is staged outside boards/ (defense in depth)", async () => {
    await fsp.writeFile(path.join(dir, "packages/foo/code.ts"), "export const A = 2; // staged code\n");
    await git(`add -- packages/foo/code.ts`); // staged OUTSIDE boards/
    await fsp.writeFile(path.join(dir, "storymap/boards/b/cards/x.md"), "dirty\n"); // left as-is because we abort

    const res = await restoreDataPaths(git, dir);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/staged fora|packages\/foo/);
    // the checkout was NOT touched: the staged code AND the dirty card both remain
    expect(await fsp.readFile(path.join(dir, "storymap/boards/b/cards/x.md"), "utf8")).toBe("dirty\n");
    expect((await git(`diff --cached --name-only`)).stdout).toContain("packages/foo/code.ts");
  });

  it("is a clean no-op (ok) on an already-pristine boards/ (idempotent re-drive)", async () => {
    const res = await restoreDataPaths(git, dir);
    expect(res.ok).toBe(true);
    expect((await git(`status --porcelain`)).stdout.trim()).toBe("");
  });

  it("ABORTS on a staged RENAME whose source is OUTSIDE boards/ (dest inside) — --no-renames surfaces the source delete", async () => {
    // Move an out-of-boards tracked file INTO boards/ and stage it. With git's rename detection, --name-only
    // would print ONLY the in-boards destination, hiding the out-of-boards source DELETION — the false-negative
    // this guards. --no-renames makes the source delete visible so the guard aborts instead of silently
    // dropping the out-of-boards file.
    await fsp.rename(path.join(dir, "packages/foo/code.ts"), path.join(dir, "storymap/boards/b/cards/moved.md"));
    await git(`add -A`);
    const res = await restoreDataPaths(git, dir);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.detail).toMatch(/staged fora|packages\/foo/);
    // aborted → nothing touched: the staged rename is still intact for the operator to resolve
    expect((await git(`diff --cached --name-only --no-renames`)).stdout).toContain("packages/foo/code.ts");
  });
});
