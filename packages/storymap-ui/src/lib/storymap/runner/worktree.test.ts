import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionsFilePath } from "./session-liveness";
import {
  commitBoardDataScoped,
  makeWorktreeOps,
  planNodeModulesLinks,
  repoRootOfWorktree,
  rescueCommitMessage,
  runBranch,
  runWorktreePath,
  type ExecFn,
  type WorktreeFs,
} from "./worktree";
import { itPosix } from "./test-platform";

// A recording exec double (DI) so the git plumbing is unit-testable without touching a real
// repo. Each WorktreeOps method is asserted by the exact `git` command line + cwd it issues.
function makeExec(impl?: (cmd: string) => void) {
  const calls: Array<{ cmd: string; cwd?: string }> = [];
  const exec: ExecFn = async (cmd, opts) => {
    impl?.(cmd);
    calls.push({ cmd, cwd: opts?.cwd });
    return { stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("worktree — runWorktreePath / runBranch (pure)", () => {
  it("derives a deterministic, repo-scoped path + branch from the session id", () => {
    expect(runBranch("abc-123")).toBe("run/abc-123");
    expect(runWorktreePath("/repo", "abc-123")).toBe(path.join("/repo", ".worktrees", "run-abc-123"));
  });
});

describe("WorktreeOps.create — git worktree add", () => {
  it("runs `git worktree add <path> -b run/<id>` from the repo root and returns the path + branch", async () => {
    const { exec, calls } = makeExec();
    const res = await makeWorktreeOps(exec).create("/repo", "sess-1");

    const worktreePath = path.join("/repo", ".worktrees", "run-sess-1");
    expect(res).toEqual({ worktreePath, branch: "run/sess-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toContain("git worktree add");
    expect(calls[0].cmd).toContain(`"${worktreePath}"`); // path quoted (may contain spaces)
    expect(calls[0].cmd).toContain('-b "run/sess-1"'); // exclusive temp branch for this run
    expect(calls[0].cwd).toBe("/repo"); // added to THIS repo
  });

  it("propagates a create failure (e.g. git index.lock) to the caller", async () => {
    const { exec } = makeExec(() => {
      throw new Error("fatal: could not lock .git/index.lock");
    });
    await expect(makeWorktreeOps(exec).create("/repo", "s")).rejects.toThrow(/index\.lock/);
  });
});

describe("WorktreeOps.commit — git add -A && git commit on the run branch (f1)", () => {
  // A status-aware exec double: `git status --porcelain` returns the seeded diff lines, every
  // other git command succeeds. Lets us assert the empty-diff branch vs the real-commit branch.
  function makeStatusExec(porcelain: string) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    // story-yy3hds: a mensagem vai por arquivo (-F) e o arquivo é unlinkado logo após — então o double
    // lê o conteúdo NO MOMENTO da chamada, para a asserção byte-exata da mensagem continuar possível.
    const messages: string[] = [];
    const exec: ExecFn = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      const msgFile = cmd.match(/^git commit --no-verify -F "(.+)"$/)?.[1];
      if (msgFile) messages.push(readFileSync(msgFile, "utf8"));
      if (cmd.includes("status --porcelain")) return { stdout: porcelain, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    return { exec, calls, messages };
  }

  itPosix("stages everything and commits from the worktree cwd when the diff is NON-empty → committed:true", async () => {
    const { exec, calls, messages } = makeStatusExec(" M src/foo.ts\n?? new.ts\n");
    const worktreePath = path.join("/repo", ".worktrees", "run-sess-1");

    const res = await makeWorktreeOps(exec).commit(worktreePath, "usm(harness-do): acme/story-1 [run sess-1]");

    expect(res).toEqual({ committed: true });
    // status check first, then add -A, then the f-sec secret-scan over the staged diff, then commit
    // — all run FROM the worktree (cwd), so the commit lands on run/<id>, leaving it strictly ahead
    // of HEAD for the merge train.
    const scanner = path.join("/repo", "scripts", "git-hooks", "scan-secrets.mjs");
    // Invoked via process.execPath (the running Node binary), not a bare `node`, so the f-sec scan
    // survives the systemd service's minimal PATH (see worktree.ts f-sec note).
    expect(calls.map((c) => c.cmd).slice(0, 3)).toEqual([
      "git status --porcelain",
      "git add -A",
      `"${process.execPath}" "${scanner}" --staged`,
    ]);
    // story-yy3hds: a mensagem é TEXTO LIVRE (trailer Decision: do agente) e NUNCA vai inline no
    // shell — só o PATH controlado do arquivo -F. O conteúdo chega ao git byte-exato.
    expect(calls[3].cmd).toMatch(/^git commit --no-verify -F "[^"]*harness-commit-msg-\d+-\d+\.txt"$/);
    expect(messages).toEqual(["usm(harness-do): acme/story-1 [run sess-1]"]);
    expect(calls.every((c) => c.cwd === worktreePath)).toBe(true);
  });

  it("makes NO commit on an EMPTY diff → committed:false (no no-op merge enqueued downstream) (AC3)", async () => {
    const { exec, calls } = makeStatusExec("   \n"); // only whitespace → nothing changed
    const res = await makeWorktreeOps(exec).commit(path.join("/r", ".worktrees", "run-x"), "msg");

    expect(res).toEqual({ committed: false });
    // ONLY the status probe ran — never add/commit (a commit here would create an empty no-op entry).
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("git status --porcelain");
  });

  it("hasUnmergedWork: TRUE when the branch is NOT an ancestor of HEAD (it carries commits)", async () => {
    // `git merge-base --is-ancestor` exits non-zero → branch diverged → there is work to integrate.
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      return { stdout: "", stderr: "" };
    };
    expect(await makeWorktreeOps(exec).hasUnmergedWork("/repo", "run/sess-1")).toBe(true);
  });

  it("hasUnmergedWork: FALSE when the branch IS an ancestor of HEAD (skill committed nothing new)", async () => {
    // exit 0 → branch already contained in HEAD → empty run → settle drops it (no no-op merge entry).
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return { stdout: "", stderr: "" }; // is-ancestor succeeds
    };
    expect(await makeWorktreeOps(exec).hasUnmergedWork("/repo", "run/sess-1")).toBe(false);
    expect(calls[0]).toContain('git merge-base --is-ancestor "run/sess-1" HEAD');
  });

  it("propagates a commit failure (e.g. an in-progress merge) to the caller", async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("status --porcelain")) return { stdout: " M x\n", stderr: "" };
      if (cmd.includes("git commit")) throw new Error("fatal: cannot do a partial commit during a merge");
      return { stdout: "", stderr: "" };
    };
    await expect(makeWorktreeOps(exec).commit(path.join("/r", ".worktrees", "run-x"), "m")).rejects.toThrow(/partial commit/);
  });
});

describe("WorktreeOps.commit — secret-scan gate before git commit (f-sec)", () => {
  it("THROWS and makes NO git commit when the staged secret-scan finds a secret (exit 2)", async () => {
    // The run's `--no-verify` commit skips the pre-commit hooks (incl. the secret scan) and the
    // merge train doesn't re-scan → a secret could ride a run branch into main. f-sec runs the
    // scanner EXPLICITLY over the staged diff inside commit(); exit 2 (secret found) → abort.
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status --porcelain")) return { stdout: " M src/config.ts\n", stderr: "" };
      if (cmd.includes("scan-secrets.mjs")) {
        throw Object.assign(new Error("secret found"), { code: 2, stderr: "🔒 BLOCKED" });
      }
      return { stdout: "", stderr: "" };
    };
    const worktreePath = path.join("/repo", ".worktrees", "run-s1");

    await expect(makeWorktreeOps(exec).commit(worktreePath, "msg")).rejects.toThrow(/secret/i);
    // it staged, ran the scan, then ABORTED — the secret never reaches a commit
    expect(calls.some((c) => c === "git add -A")).toBe(true);
    expect(calls.some((c) => c.includes("scan-secrets.mjs") && c.endsWith("--staged"))).toBe(true);
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(false);
  });

  it("THROWS and makes NO git commit when the scanner exits 1 (its OWN internal error — SM-08 fail-closed)", async () => {
    // Pre-SM-08 the scanner exited 0 on an internal error (e.g. a diff past git's maxBuffer), failing
    // OPEN — an un-scanned diff committed silently. Now it exits 1, and commit()'s "any non-zero aborts"
    // rule catches it too, so the run-commit path is fail-CLOSED for internal errors as well as secrets.
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status --porcelain")) return { stdout: " M big.ts\n", stderr: "" };
      if (cmd.includes("scan-secrets.mjs")) {
        throw Object.assign(new Error("INTERNAL_ERROR could not scan diff"), { code: 1 });
      }
      return { stdout: "", stderr: "" };
    };
    await expect(makeWorktreeOps(exec).commit(path.join("/repo", ".worktrees", "run-s1"), "msg")).rejects.toThrow(
      /secret-scan bloqueou o commit/,
    );
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(false); // never committed the un-scanned diff
  });

  it("runs the scan AFTER `git add` and proceeds to commit when the staged diff is clean (exit 0)", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status --porcelain")) return { stdout: " M x\n", stderr: "" };
      return { stdout: "", stderr: "" }; // scan (exit 0) + commit both succeed
    };
    const res = await makeWorktreeOps(exec).commit(path.join("/r", ".worktrees", "run-x"), "m");

    expect(res).toEqual({ committed: true });
    const ix = (s: string) => calls.findIndex((c) => c.includes(s));
    expect(ix("git add -A")).toBeLessThan(ix("scan-secrets.mjs")); // scan AFTER staging
    expect(ix("scan-secrets.mjs")).toBeLessThan(ix("git commit")); // commit only after a clean scan
  });

  it("does NOT scan an EMPTY diff (returns committed:false before staging — nothing to scan)", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status --porcelain")) return { stdout: "\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const res = await makeWorktreeOps(exec).commit(path.join("/r", ".worktrees", "run-x"), "m");
    expect(res).toEqual({ committed: false });
    expect(calls.some((c) => c.includes("scan-secrets.mjs"))).toBe(false); // never reached
  });
});

describe("WorktreeOps.commitBoardState — HEAD=estado boundary commit, SCOPED to board data (story-p3bu01)", () => {
  // story-p3bu01: the "board: estado vivo" boundary snapshot now delegates to commitBoardDataScoped —
  // it stages ONLY the storymap/boards/ pathspec (NEVER `git add -A`), so a stray code edit / a predeploy
  // tarball dirtying the shared runtime checkout can NEVER ride the snapshot into a real commit on main
  // (the silent-regression vector: those swept edits reached origin/main and broke prod deploys). A
  // staged-aware exec double: `git diff --cached --name-only` returns the seeded staged set; `onScan`
  // lets a test make the secret scan throw. Everything else is ok.
  function makeStagedExec(stagedPaths: string, onScan?: () => void) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    // story-yy3hds: o arquivo -F é lido no momento da chamada (é unlinkado logo após) — mantém
    // possível a asserção byte-exata da mensagem.
    const messages: string[] = [];
    const exec: ExecFn = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      const msgFile = cmd.match(/^git commit --no-verify -F "(.+)"$/)?.[1];
      if (msgFile) messages.push(readFileSync(msgFile, "utf8"));
      if (cmd.includes("diff --cached --name-only")) return { stdout: stagedPaths, stderr: "" };
      if (cmd.includes("scan-secrets.mjs")) {
        onScan?.();
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls, messages };
  }

  it("stages ONLY storymap/boards/ — NEVER `git add -A` — so stray code / a predeploy tarball can't ride the snapshot (story-p3bu01)", async () => {
    // writeCard writes the card .md to disk WITHOUT committing (working-tree = banco vivo). Before a
    // worktree is created (checkout of HEAD), this commit makes HEAD carry the LIVE board state — so the
    // run reads the live status, not the stale last-commit one. Runs from the repo root, NOT a worktree,
    // and stages with the board PATHSPEC (the p3bu01 fix), never the blanket `git add -A`.
    const { exec, calls, messages } = makeStagedExec("storymap/boards/storymap/cards/story-1.md\n");

    const res = await makeWorktreeOps(exec).commitBoardState("/repo", "board: estado vivo (storymap/story-1)");

    expect(res).toEqual({ committed: true });
    const scanner = path.join("/repo", "scripts", "git-hooks", "scan-secrets.mjs");
    // stage-pathspec → staged probe → fail-closed secret scan → commit, ALL from repoRoot (the main tree).
    expect(calls.map((c) => c.cmd).slice(0, 3)).toEqual([
      'git add -- "storymap/boards/"',
      "git diff --cached --name-only",
      `"${process.execPath}" "${scanner}" --staged`,
    ]);
    // story-yy3hds: mensagem via arquivo -F (nunca inline no shell), byte-exata.
    expect(calls[3].cmd).toMatch(/^git commit --no-verify -F "[^"]*harness-commit-msg-\d+-\d+\.txt"$/);
    expect(messages).toEqual(["board: estado vivo (storymap/story-1)"]);
    expect(calls.map((c) => c.cmd)).not.toContain("git add -A"); // p3bu01: the whole-tree sweep IS the bug
    expect(calls.every((c) => c.cwd === "/repo")).toBe(true);
  });

  it("is a NO-OP on a clean board tree → committed:false (only the pathspec stage + staged probe run)", async () => {
    const { exec, calls } = makeStagedExec("\n");
    const res = await makeWorktreeOps(exec).commitBoardState("/repo", "board: noop");
    expect(res).toEqual({ committed: false });
    // staged the pathspec + probed the staged diff, then stopped — no scan, no commit (and no `git add -A`).
    expect(calls.map((c) => c.cmd)).toEqual(['git add -- "storymap/boards/"', "git diff --cached --name-only"]);
  });

  it("defense in depth: ABORTS (never commits) if a packages/** code path somehow reached the board-scoped index (story-p3bu01)", async () => {
    // Even if a path-confusion staged code under the board pathspec (should be impossible), the inherited
    // commitBoardDataScoped guard RESETS the index and ABORTS — the boundary snapshot can NEVER write code.
    const { exec, calls } = makeStagedExec("storymap/boards/x/cards/y.md\npackages/storymap-ui/src/evil.ts\n");
    await expect(makeWorktreeOps(exec).commitBoardState("/repo", "board: x")).rejects.toThrow(/toca código/i);
    expect(calls.some((c) => c.cmd.startsWith("git commit"))).toBe(false);
  });

  it("fail-closed: a secret-scan hit (exit 2) THROWS and makes no board commit", async () => {
    const { exec, calls } = makeStagedExec("storymap/boards/x.md\n", () => {
      throw Object.assign(new Error("secret found"), { code: 2 });
    });
    await expect(makeWorktreeOps(exec).commitBoardState("/repo", "board: x")).rejects.toThrow(/secret/i);
    expect(calls.some((c) => c.cmd.startsWith("git commit"))).toBe(false);
  });
});

describe("commitBoardDataScoped — SCOPED board-data commit (story-apz8sa FIX 2)", () => {
  // A staged-aware exec double: `git diff --cached --name-only` returns the seeded staged set; the
  // optional `onScan` lets a test make the secret scan throw. Everything else is ok.
  function makeStagedExec(stagedPaths: string, onScan?: () => void) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    // story-yy3hds: o arquivo -F é lido no momento da chamada (é unlinkado logo após) — mantém
    // possível a asserção byte-exata da mensagem.
    const messages: string[] = [];
    const exec: ExecFn = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts?.cwd });
      const msgFile = cmd.match(/^git commit --no-verify -F "(.+)"$/)?.[1];
      if (msgFile) messages.push(readFileSync(msgFile, "utf8"));
      if (cmd.includes("diff --cached --name-only")) return { stdout: stagedPaths, stderr: "" };
      if (cmd.includes("scan-secrets.mjs")) {
        onScan?.();
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls, messages };
  }

  it("stages ONLY the storymap/boards/ pathspec — NEVER `git add -A` — then scans + commits", async () => {
    // The blast-radius fix: a board-data commit must stage with a pathspec, so unrelated dirt on the
    // shared main tree can't ride it. Assert the EXACT command line: `git add -- "storymap/boards/"`.
    const { exec, calls } = makeStagedExec("storymap/boards/storymap/cards/story-1.md\n");
    const res = await commitBoardDataScoped(exec, "/repo", "board: storymap/story-1");
    expect(res).toEqual({ committed: true });
    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toContain('git add -- "storymap/boards/"');
    expect(cmds).not.toContain("git add -A"); // the whole point of FIX 2: NEVER the blanket add
    expect(cmds.some((c) => c.startsWith("git commit --no-verify"))).toBe(true);
    expect(calls.every((c) => c.cwd === "/repo")).toBe(true);
  });

  it("is a NO-OP when the board-data delta is empty (run touched nothing under the pathspec)", async () => {
    const { exec, calls } = makeStagedExec("\n");
    const res = await commitBoardDataScoped(exec, "/repo", "board: noop");
    expect(res).toEqual({ committed: false });
    // It staged the pathspec + probed the staged diff, then stopped — no scan, no commit.
    expect(calls.map((c) => c.cmd)).toEqual(['git add -- "storymap/boards/"', "git diff --cached --name-only"]);
  });

  // Double STATEFUL para o self-heal: `git reset -- <paths>` remove os paths do conjunto staged; cada
  // `diff --cached` reflete o estado corrente. Modela o índice real por trás do unstage-and-proceed.
  function makeRestagingExec(initialStaged: string[], opts?: { resetKeepsCode?: boolean }) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    let staged = [...initialStaged];
    const exec: ExecFn = async (cmd, o) => {
      calls.push({ cmd, cwd: o?.cwd });
      if (cmd.includes("diff --cached --name-only")) return { stdout: staged.join("\n") + "\n", stderr: "" };
      const reset = cmd.match(/^git reset -- (.+)$/);
      if (reset && !opts?.resetKeepsCode) {
        const targets = [...reset[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        staged = staged.filter((p) => !targets.some((t) => p === t || p.startsWith(t)));
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  it("SELF-HEALS foreign staged code: unstages the code paths (index only) and commits the board delta alone", async () => {
    // story-tlz0dt run-death 2026-07-21: dois arquivos de código encalhados no índice do checkout
    // compartilhado ABORTAVAM todo flush/boundary de board para sempre, matando runs saudáveis até um
    // humano limpar. O guard agora DESESTAGIA o lixo (working tree intocada) e versiona o board mesmo
    // assim — o invariante (commit de board nunca carrega código) permanece.
    const { exec, calls } = makeRestagingExec([
      "storymap/boards/storymap/cards/story-1.md",
      "packages/acmeapp/web/src/components/eventos/agenda-order.ts",
    ]);
    const res = await commitBoardDataScoped(exec, "/repo", "board: x");
    expect(res).toEqual({ committed: true });
    const cmds = calls.map((c) => c.cmd);
    // Desestagiou EXATAMENTE o path de código (não o board), e então commitou.
    expect(cmds).toContain('git reset -- "packages/acmeapp/web/src/components/eventos/agenda-order.ts"');
    expect(cmds).not.toContain('git reset -- "storymap/boards/"');
    expect(cmds.some((c) => c.startsWith("git commit --no-verify"))).toBe(true);
    expect(cmds.some((c) => c.includes("scan-secrets.mjs"))).toBe(true); // o scan continua no caminho
  });

  it("junk-ONLY staged: unstages the code and returns committed:false (nothing of the board to version)", async () => {
    const { exec, calls } = makeRestagingExec(["packages/app/stray.ts"]);
    const res = await commitBoardDataScoped(exec, "/repo", "board: x");
    expect(res).toEqual({ committed: false });
    expect(calls.some((c) => c.cmd.startsWith("git commit"))).toBe(false);
  });

  it("still ABORTS fail-closed when code REMAINS staged after the reset (defense in depth intact)", async () => {
    // Se o unstage não removeu o código (reset falhou/índice travado), o invariante manda abortar como
    // antes: um commit de board JAMAIS carrega código para a main sem gate.
    const { exec, calls } = makeRestagingExec(
      ["storymap/boards/storymap/cards/story-1.md", "packages/storymap-ui/src/evil.ts"],
      { resetKeepsCode: true },
    );
    await expect(commitBoardDataScoped(exec, "/repo", "board: x")).rejects.toThrow(/toca código/i);
    const cmds = calls.map((c) => c.cmd);
    expect(cmds.some((c) => c.startsWith("git commit"))).toBe(false); // NUNCA commitou
    expect(cmds).toContain('git reset -- "storymap/boards/"'); // desfez o stage do board → índice limpo
  });

  it("fail-closed: a secret-scan hit on the scoped board delta THROWS and makes no commit", async () => {
    const { exec, calls } = makeStagedExec("storymap/boards/x.md\n", () => {
      throw Object.assign(new Error("secret found"), { code: 2 });
    });
    await expect(commitBoardDataScoped(exec, "/repo", "board: x")).rejects.toThrow(/secret/i);
    expect(calls.some((c) => c.cmd.startsWith("git commit"))).toBe(false);
  });
});

describe("WorktreeOps.commitBoardStateAndPush — scoped commit + push to origin (story-apz8sa FIX 1)", () => {
  // A staged+push-aware exec double: returns the seeded staged set and lets a test fail the push.
  function makeExec(stagedPaths: string, opts?: { pushFails?: boolean }) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    const exec: ExecFn = async (cmd, o) => {
      calls.push({ cmd, cwd: o?.cwd });
      if (cmd.includes("diff --cached --name-only")) return { stdout: stagedPaths, stderr: "" };
      if (opts?.pushFails && cmd.includes("push origin HEAD")) {
        throw Object.assign(new Error("rejected (non-fast-forward)"), { code: 1, stderr: "non-fast-forward" });
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  it("on a real board-data commit, PUSHES HEAD to origin (cumulative push) and reports pushed:true", async () => {
    const { exec, calls } = makeExec("storymap/boards/storymap/cards/story-1.md\n");
    const res = await makeWorktreeOps(exec).commitBoardStateAndPush("/repo", "board: storymap/story-1");
    expect(res).toMatchObject({ committed: true, pushed: true });
    expect(calls.map((c) => c.cmd)).toContain("git push origin HEAD");
  });

  it("an EMPTY board delta commits nothing and pushes nothing (gated on a real commit)", async () => {
    const { exec, calls } = makeExec("\n");
    const res = await makeWorktreeOps(exec).commitBoardStateAndPush("/repo", "board: noop");
    expect(res).toEqual({ committed: false, pushed: false });
    expect(calls.some((c) => c.cmd.includes("push origin HEAD"))).toBe(false); // never reached the push
  });

  it("FAIL-OPEN: a rejected push does NOT throw — the commit is durable, pushed:false reported", async () => {
    const { exec } = makeExec("storymap/boards/x.md\n", { pushFails: true });
    const res = await makeWorktreeOps(exec).commitBoardStateAndPush("/repo", "board: x");
    expect(res.committed).toBe(true); // the commit landed locally regardless
    expect(res.pushed).toBe(false); // the push failed, but non-fatally (no throw)
  });
});

describe("WorktreeOps.remove — git worktree remove + safe branch teardown", () => {
  itPosix("force-deletes the branch when it is already an ancestor of HEAD (no work to lose)", async () => {
    // makeExec succeeds on every command → `merge-base --is-ancestor` exits 0 → no unmerged work.
    const { exec, calls } = makeExec();
    const worktreePath = path.join("/repo", ".worktrees", "run-sess-1");

    await makeWorktreeOps(exec).remove(worktreePath, "run/sess-1");

    expect(calls).toHaveLength(3);
    // --force discards the ephemeral run's uncommitted changes AND is idempotent if a crash
    // already deleted the dir; the repo root is derived from the worktree path (../..).
    expect(calls[0].cmd).toBe(`git worktree remove "${worktreePath}" --force`);
    expect(calls[0].cwd).toBe("/repo");
    // DATA-LOSS GUARD: it asks whether the branch carries un-integrated work BEFORE any delete.
    expect(calls[1].cmd).toBe('git merge-base --is-ancestor "run/sess-1" HEAD');
    expect(calls[1].cwd).toBe("/repo");
    // …it doesn't (ancestor of HEAD) → safe to force-delete.
    expect(calls[2].cmd).toBe('git branch -D "run/sess-1"');
    expect(calls[2].cwd).toBe("/repo");
  });

  it("PRESERVES the branch (rename → failed/<branch>) when it carries un-integrated commits — never -D it", async () => {
    // is-ancestor exits non-zero → the branch diverged (has the run's committed work) → must NOT be
    // force-deleted (the audit's CRITICAL data-loss path: an isolated run's code + card advance).
    const { exec, calls } = makeExec((cmd) => {
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
    });
    const worktreePath = path.join("/repo", ".worktrees", "run-sess-1");

    await makeWorktreeOps(exec).remove(worktreePath, "run/sess-1");

    // NB: makeExec records a command only AFTER its impl runs, so the throwing `merge-base` line is
    // not in `calls` — we assert the meaningful invariants instead: the worktree dir is removed, the
    // branch is PRESERVED via rename, and the destructive delete NEVER runs on a branch with work.
    expect(calls[0].cmd).toBe(`git worktree remove "${worktreePath}" --force`);
    expect(calls.some((c) => c.cmd === 'git branch -m "run/sess-1" "failed/run/sess-1"')).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("git branch -D"))).toBe(false);
  });

  it("leaves the branch intact (no -D) when both the work-check AND the rename fail", async () => {
    // Worst case: branch has work (is-ancestor non-zero) and the preserve rename also fails. We must
    // STILL never delete it — a leaked branch is recoverable, a deleted one is not.
    // reflog show returns empty (makeExec default) → no Created-from → base not proven exactly → the
    // guard falls through to PRESERVE, never a delete.
    const { exec, calls } = makeExec((cmd) => {
      if (cmd.includes("merge-base --is-ancestor")) throw new Error("not ancestor");
      if (cmd.includes("git branch -m")) throw new Error("a branch named 'failed/run/x' already exists");
    });
    await makeWorktreeOps(exec).remove(path.join("/r", ".worktrees", "run-x"), "run/x");
    expect(calls.some((c) => c.cmd.startsWith("git branch -D"))).toBe(false);
  });

  itPosix("DELETES a stage-cut branch with ZERO own commits — never preserves empty junk (lixo imortal fix)", async () => {
    // The 12-empty-branches bug: a run branch cut from `stage` is NOT an ancestor of HEAD (its tip is a
    // stage commit), so `--is-ancestor` says "has work" even though the run committed NOTHING of its own.
    // The reflog records the exact cut point; base..branch is empty ⇒ there is nothing to preserve.
    const sid = "sess-empty";
    const CUT = "243d9f5e78259b0dc99b9ad1e68b83d339613c1e";
    const calls: Array<{ cmd: string }> = [];
    const exec: ExecFn = async (cmd) => {
      calls.push({ cmd });
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("not ancestor of HEAD"), { code: 1 });
      if (cmd.includes("reflog show")) return { stdout: `x @{1}: branch: Created from ${CUT}`, stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: `${CUT}\n`, stderr: "" };
      if (cmd.includes("rev-list --count")) return { stdout: "0\n", stderr: "" }; // ← zero own commits
      if (cmd.includes("diff --name-only")) return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await makeWorktreeOps(exec).remove(path.join("/repo", ".worktrees", `run-${sid}`), `run/${sid}`);
    expect(calls.some((c) => c.cmd === `git branch -D "run/${sid}"`)).toBe(true); // deleted…
    expect(calls.some((c) => c.cmd.startsWith("git branch -m"))).toBe(false); // …NOT preserved
  });

  itPosix("still PRESERVES a stage-cut branch that DID commit its own work (>0 own commits)", async () => {
    const sid = "sess-real";
    const CUT = "243d9f5e78259b0dc99b9ad1e68b83d339613c1e";
    const calls: Array<{ cmd: string }> = [];
    const exec: ExecFn = async (cmd) => {
      calls.push({ cmd });
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      if (cmd.includes("reflog show")) return { stdout: `x @{1}: branch: Created from ${CUT}`, stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: `${CUT}\n`, stderr: "" };
      if (cmd.includes("rev-list --count")) return { stdout: "3\n", stderr: "" }; // ← real own work
      if (cmd.includes("diff --name-only")) return { stdout: "packages/app/x.ts\n", stderr: "" };
      // ADR-065: the teardown now also asks the CONTENT question (is this work already in main/stage?) before
      // preserving. This branch's work is NOT integrated — which is the whole premise of the test — so the
      // post-image layer must report the files DIFFER (`git diff --quiet` exits 1 = "they differ", an answer,
      // not a failure). Without modelling it the stub's blanket `{stdout:""}` reads as exit 0 = "identical",
      // i.e. a fake `landed`, and the branch would be deleted.
      if (cmd.includes("diff --quiet")) throw Object.assign(new Error("differ"), { code: 1 });
      return { stdout: "", stderr: "" };
    };
    await makeWorktreeOps(exec).remove(path.join("/repo", ".worktrees", `run-${sid}`), `run/${sid}`);
    expect(calls.some((c) => c.cmd === `git branch -m "run/${sid}" "failed/run/${sid}"`)).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("git branch -D"))).toBe(false);
  });

  itPosix("ADR-065 — um branch cujo trabalho JÁ ESTÁ no alvo por CONTEÚDO é deletado (o falso failed/* morre)", async () => {
    // O espelho do teste acima: mesma forma (3 commits próprios, não-ancestral — o que a integração por
    // patch do train SEMPRE produz), mas o conteúdo do delta é idêntico no alvo. Antes, a régua contava
    // shas e não tinha como enxergar isso: preservava como failed/* todo trabalho já integrado.
    const sid = "sess-landed";
    const CUT = "243d9f5e78259b0dc99b9ad1e68b83d339613c1e";
    const calls: Array<{ cmd: string }> = [];
    const exec: ExecFn = async (cmd) => {
      calls.push({ cmd });
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      if (cmd.includes("reflog show")) return { stdout: `x @{1}: branch: Created from ${CUT}`, stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: `${CUT}\n`, stderr: "" };
      if (cmd.includes("rev-list --count")) return { stdout: "3\n", stderr: "" };
      if (cmd.includes("diff --name-only")) return { stdout: "packages/app/x.ts\n", stderr: "" };
      if (cmd.includes("diff --quiet")) return { stdout: "", stderr: "" }; // exit 0 → pós-imagem IDÊNTICA
      return { stdout: "", stderr: "" };
    };
    await makeWorktreeOps(exec).remove(path.join("/repo", ".worktrees", `run-${sid}`), `run/${sid}`);
    expect(calls.some((c) => c.cmd === `git branch -D "run/${sid}"`)).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("git branch -m"))).toBe(false);
  });
});

describe("WorktreeOps.remove — RESGATE do trabalho não-commitado (incidente 2026-07-27)", () => {
  // A árvore existe (isDir → true) e `git status --porcelain` decide se ela está suja. É o par exato
  // do incidente: um varredor chega numa árvore com edição não-commitada e chama `remove`.
  function makeRescueExec(porcelain: string, opts: { commitFails?: boolean } = {}) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    const messages: string[] = [];
    const exec: ExecFn = async (cmd, o) => {
      calls.push({ cmd, cwd: o?.cwd });
      const msgFile = cmd.match(/^git commit --no-verify -F "(.+)"$/)?.[1];
      if (msgFile) {
        messages.push(readFileSync(msgFile, "utf8"));
        if (opts.commitFails) throw new Error("commit falhou");
      }
      if (cmd.includes("status --porcelain")) return { stdout: porcelain, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const fs: WorktreeFs = {
      listDirs: async () => [],
      isDir: async () => true,
      isFile: async () => false,
      linkDir: async () => {},
      unlinkDir: async () => true,
    };
    return { exec, fs, calls, messages };
  }

  // Branch `run/*` nos casos de MECÂNICA: o resgate não é específico de sessão — ele protege também o
  // run ceifado no meio (memory `harness-do-worktree-reaped-midrun`), e assim o teste não precisa forjar o
  // registro de sessões só para exercitar o commit. O caso da SESSÃO (o incidente) tem o seu, no fim.
  const WT = path.join("/repo", ".worktrees", "run-s1");

  itPosix("árvore SUJA: commita ANTES do `--force` (o trabalho vira objeto git, recuperável)", async () => {
    const { exec, fs, calls, messages } = makeRescueExec(" M src/a.ts\n?? src/b.ts\n");

    await makeWorktreeOps(exec, fs).remove(WT, "run/s1");

    const cmds = calls.map((c) => c.cmd);
    const commitAt = cmds.findIndex((c) => c.startsWith("git commit --no-verify -F"));
    const removeAt = cmds.findIndex((c) => c.startsWith("git worktree remove"));
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeLessThan(removeAt); // a ORDEM é a correção inteira
    expect(cmds.slice(0, 2)).toEqual(["git status --porcelain", "git add -A"]);
    // o commit acontece DENTRO da árvore → cai no branch dela, não no repo principal
    expect(calls[commitAt].cwd).toBe(WT);
    // a mensagem é o runbook de recuperação (é o que alguém vai achar num `git log`) — o ASSUNTO vem
    // do builder exportado, para as duas pontas do contrato não poderem divergir em silêncio.
    expect(messages[0].split("\n")[0]).toBe(rescueCommitMessage("run/s1", "ignorado").split("\n")[0]);
    expect(messages[0]).toContain("failed/run/s1");
    expect(messages[0]).toContain("cherry-pick");
  });

  itPosix("árvore LIMPA: nenhum commit — o caminho comum não ganha ruído", async () => {
    const { exec, fs, calls } = makeRescueExec("");

    await makeWorktreeOps(exec, fs).remove(WT, "run/s1");

    expect(calls.some((c) => c.cmd === "git add -A")).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith("git commit"))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith("git worktree remove"))).toBe(true);
  });

  itPosix("consentimento explícito (worktree_discard): NÃO resgata — o autor mandou jogar fora", async () => {
    const { exec, fs, calls } = makeRescueExec(" M src/a.ts\n");

    await makeWorktreeOps(exec, fs).remove(WT, "run/s1", undefined, { consent: "session-discard" });

    expect(calls.some((c) => c.cmd === "git status --porcelain")).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith("git worktree remove"))).toBe(true);
  });

  itPosix("resgate FALHOU ⇒ a remoção NÃO acontece (a árvore é a única cópia)", async () => {
    const { exec, fs, calls } = makeRescueExec(" M src/a.ts\n", { commitFails: true });

    await expect(makeWorktreeOps(exec, fs).remove(WT, "run/s1")).rejects.toThrow(/resgate/i);

    expect(calls.some((c) => c.cmd.startsWith("git worktree remove"))).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith("git branch"))).toBe(false);
  });

  itPosix("pasta já ausente: segue direto (a remoção ainda limpa o registro do git)", async () => {
    const { exec, calls } = makeRescueExec(" M src/a.ts\n");
    const fs: WorktreeFs = {
      listDirs: async () => [],
      isDir: async () => false, // sumiu (crash/limpeza manual)
      isFile: async () => false,
      linkDir: async () => {},
      unlinkDir: async () => true,
    };

    await makeWorktreeOps(exec, fs).remove(WT, "run/s1");

    expect(calls.some((c) => c.cmd === "git status --porcelain")).toBe(false);
    expect(calls.some((c) => c.cmd.startsWith("git worktree remove"))).toBe(true);
  });

  itPosix("O INCIDENTE, ponta a ponta: sessão de heartbeat vencido tem a edição SALVA, não descartada", async () => {
    // O registro REAL (vitest.setup redireciona o runnerStateDir para um temp): uma sessão registrada
    // com heartbeat de 9h atrás — exatamente o estado que autorizou a varredura a apagar a árvore.
    const nineHoursAgo = new Date(Date.now() - 9 * 3600_000).toISOString();
    writeFileSync(
      sessionsFilePath(),
      JSON.stringify({
        v: 1,
        sessions: [
          {
            sessionId: "s-dead",
            agentId: "s-dead",
            branch: "agent/s-dead",
            worktreePath: "/repo/.worktrees/agent-s-dead",
            heartbeatAt: nineHoursAgo,
            task: "editando há horas sem chamar tool",
          },
        ],
      }),
      "utf8",
    );
    const { exec, fs, calls, messages } = makeRescueExec(" M src/editado.ts\n");

    // Sem consentimento — é o varredor chegando, como no incidente.
    await makeWorktreeOps(exec, fs).remove(path.join("/repo", ".worktrees", "agent-s-dead"), "agent/s-dead");

    const cmds = calls.map((c) => c.cmd);
    expect(cmds.findIndex((c) => c.startsWith("git commit"))).toBeLessThan(
      cmds.findIndex((c) => c.startsWith("git worktree remove")),
    );
    expect(messages[0]).toContain("failed/agent/s-dead");
  });
});

describe("WorktreeOps.detach — git worktree remove WITHOUT branch delete (SM-2)", () => {
  itPosix("force-removes the worktree dir but PRESERVES the branch (so the merge queue can merge it)", async () => {
    const { exec, calls } = makeExec();
    const worktreePath = path.join("/repo", ".worktrees", "run-sess-1");

    await makeWorktreeOps(exec).detach(worktreePath);

    // ONLY the worktree-remove runs — no `git branch -D` (the branch must survive for the merge train).
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(`git worktree remove "${worktreePath}" --force`);
    expect(calls[0].cwd).toBe("/repo"); // run from the repo root (derived ../..), not the tree itself
  });

  it("propagates a detach failure (e.g. the dir is locked) to the caller", async () => {
    const { exec } = makeExec(() => {
      throw new Error("fatal: ... is locked");
    });
    await expect(makeWorktreeOps(exec).detach(path.join("/r", ".worktrees", "run-x"))).rejects.toThrow(/locked/);
  });
});

describe("WorktreeOps.disposeBranch — safe teardown of a worktree-less orphan branch (settle-gap-resume)", () => {
  it("NEVER touches a worktree (the dir is already gone) and PRESERVES a branch with un-integrated work", async () => {
    const { exec, calls } = makeExec((cmd) => {
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
    });
    await makeWorktreeOps(exec).disposeBranch("/repo", "run/orphan");
    expect(calls.some((c) => c.cmd.includes("worktree remove"))).toBe(false); // no dir to remove
    expect(calls.some((c) => c.cmd === 'git branch -m "run/orphan" "failed/run/orphan"')).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("git branch -D"))).toBe(false);
  });

  it("force-deletes an empty/already-integrated orphan branch (nothing to lose)", async () => {
    const { exec, calls } = makeExec(); // is-ancestor succeeds → no unmerged work
    await makeWorktreeOps(exec).disposeBranch("/repo", "run/empty");
    expect(calls.some((c) => c.cmd.includes("worktree remove"))).toBe(false);
    expect(calls.some((c) => c.cmd === 'git branch -D "run/empty"')).toBe(true);
  });
});

describe("WorktreeOps — node_modules provisioning ↔ git ordering (story-vovhjj teardown footgun)", () => {
  // The combined recorder: the git `exec` double AND the provisioning `fs` double append to ONE
  // timeline, so we can pin the SAFETY-CRITICAL ordering ACROSS the two DI surfaces. The real-fs
  // teardown test (worktree-provisioning.test.ts t3) proves teardown doesn't corrupt main deps, but
  // it would pass even if `deprovisionNodeModules` were a no-op — `git worktree remove --force` does
  // not follow symlinks into their target anyway. THIS test pins the actual contract the comments
  // promise: teardown UNLINKS the node_modules links BEFORE git touches the dir (belt to git's
  // suspenders), and create LINKS them only AFTER `git worktree add` has materialised the tree. A
  // future refactor that reorders these would re-open the footgun (git following a link into the
  // main checkout) — and this test, not t3, is what would catch it.
  function makeRecorder() {
    const timeline: string[] = [];
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("git worktree add")) timeline.push("git:add");
      else if (cmd.includes("git worktree remove")) timeline.push("git:remove");
      else if (cmd.startsWith("git branch")) timeline.push("git:branch-D");
      return { stdout: "", stderr: "" };
    };
    // isDir → true so the root node_modules is planned; listDirs → one package so a PER-PACKAGE link
    // is planned too (the deps that don't hoist — the actual bug), PLUS its 3 nested workspace tiers
    // (web/api/functions — story-olr777 fix). Five links provisioned/torn down (root + pkg + 3 tiers).
    const fs: WorktreeFs = {
      listDirs: async () => ["storymap-ui"],
      isDir: async () => true,
      isFile: async () => false,
      linkDir: async () => {
        timeline.push("fs:link");
      },
      unlinkDir: async () => {
        timeline.push("fs:unlink");
        return true;
      },
    };
    return { exec, fs, timeline };
  }

  it("create LINKS node_modules AFTER `git worktree add` (the checkout must exist first)", async () => {
    const { exec, fs, timeline } = makeRecorder();
    await makeWorktreeOps(exec, fs).create("/repo", "sess-1");
    expect(timeline.filter((t) => t === "fs:link")).toHaveLength(5); // root + pkg + web/api/functions
    expect(timeline.indexOf("git:add")).toBeLessThan(timeline.indexOf("fs:link")); // add, THEN link
  });

  it("remove UNLINKS node_modules BEFORE `git worktree remove` (git can never follow a link into main)", async () => {
    const { exec, fs, timeline } = makeRecorder();
    await makeWorktreeOps(exec, fs).remove(path.join("/repo", ".worktrees", "run-x"), "run/x");
    const firstUnlink = timeline.indexOf("fs:unlink");
    expect(firstUnlink).toBeGreaterThanOrEqual(0); // deprovision actually ran (not a no-op)
    expect(firstUnlink).toBeLessThan(timeline.indexOf("git:remove")); // …and BEFORE git touched the dir
  });

  it("detach UNLINKS node_modules BEFORE `git worktree remove` (same guard; branch preserved for SM-2)", async () => {
    const { exec, fs, timeline } = makeRecorder();
    await makeWorktreeOps(exec, fs).detach(path.join("/repo", ".worktrees", "run-x"));
    const firstUnlink = timeline.indexOf("fs:unlink");
    expect(firstUnlink).toBeGreaterThanOrEqual(0);
    expect(firstUnlink).toBeLessThan(timeline.indexOf("git:remove"));
    expect(timeline).not.toContain("git:branch-D"); // detach keeps the branch for the merge train
  });
});

describe("planNodeModulesLinks — links nested workspace tiers (story-olr777 degraded-worktree fix)", () => {
  // A fake fs backed by an EXPLICIT set of existing dirs, so the plan is asserted precisely (not
  // "everything is a dir"). Proves the nested web/api/functions node_modules are linked and an
  // ABSENT tier is skipped — the gap that made every worktree test/build hand-`ln -s` its deps.
  function fsFrom(existing: string[]): WorktreeFs {
    const set = new Set(existing);
    return {
      listDirs: async (dir) =>
        [...set]
          .filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))
          .map((p) => p.slice(dir.length + 1)),
      isDir: async (p) => set.has(p),
      isFile: async () => false,
      linkDir: async () => {},
      unlinkDir: async () => true,
    };
  }

  it("plans ROOT + each packages/<pkg>/node_modules + the nested {web,api,functions}/node_modules that exist", async () => {
    const repo = "/repo";
    const fs = fsFrom([
      `${repo}/node_modules`,
      `${repo}/packages`,
      `${repo}/packages/orbit`,
      `${repo}/packages/orbit/node_modules`,
      `${repo}/packages/orbit/web`,
      `${repo}/packages/orbit/web/node_modules`,
      `${repo}/packages/orbit/functions`,
      `${repo}/packages/orbit/functions/node_modules`,
      // NOTE: no packages/orbit/api/node_modules → must be skipped
      `${repo}/packages/storymap-ui`,
      `${repo}/packages/storymap-ui/node_modules`,
      // storymap-ui has no nested tiers
    ]);

    const links = await planNodeModulesLinks(fs, repo, "/wt");
    const linkPaths = links.map((l) => l.linkPath);

    expect(linkPaths).toContain(path.join("/wt", "node_modules")); // root (hoisted)
    expect(linkPaths).toContain(path.join("/wt", "packages", "orbit", "node_modules")); // depth-1
    expect(linkPaths).toContain(path.join("/wt", "packages", "orbit", "web", "node_modules")); // nested (the fix)
    expect(linkPaths).toContain(path.join("/wt", "packages", "orbit", "functions", "node_modules")); // nested
    expect(linkPaths).toContain(path.join("/wt", "packages", "storymap-ui", "node_modules"));
    // an ABSENT nested tier is NOT linked
    expect(linkPaths).not.toContain(path.join("/wt", "packages", "orbit", "api", "node_modules"));
    // the nested link TARGET points at the MAIN checkout (the source of truth for deps)
    const webLink = links.find((l) => l.linkPath === path.join("/wt", "packages", "orbit", "web", "node_modules"));
    expect(webLink?.target).toBe(path.join(repo, "packages", "orbit", "web", "node_modules"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("repoRootOfWorktree — o risco nº 1 do plano, fechado também AQUI (F0 · ADR-067)", () => {
  // O par "resolução de raiz que não falha alto + operação destrutiva" foi morto em `paths.ts` e
  // sobreviveu neste arquivo: três sítios contavam `../..` e entregavam o resultado a
  // `git worktree remove --force` e `git branch -D`, sem nada verificar a forma do caminho.
  it("deriva a raiz de um caminho no contrato", () => {
    expect(repoRootOfWorktree("/repo/.worktrees/run-abc")).toBe("/repo");
    expect(repoRootOfWorktree("/a/b/c/.worktrees/agent-1")).toBe("/a/b/c");
  });

  it("LANÇA num caminho fora do contrato — em vez de apontar para um diretório arbitrário", () => {
    // Era este o cenário mudo: `../..` de um caminho de outra forma resolve para QUALQUER coisa, e o
    // `git branch -D` roda lá.
    expect(() => repoRootOfWorktree("/repo/outra-pasta/run-abc")).toThrow(/fora do contrato/);
    expect(() => repoRootOfWorktree("/tmp/x")).toThrow(/fora do contrato/);
  });

  it("a mensagem é ACIONÁVEL: diz o que recebeu e por que se recusou", () => {
    try {
      repoRootOfWorktree("/tmp/qualquer/coisa");
    } catch (e) {
      const m = String(e);
      expect(m).toMatch(/\/tmp\/qualquer\/coisa/); // o que recebeu
      expect(m).toMatch(/worktree remove --force|branch -D/); // o que estava em jogo
    }
  });

  it("nenhum sítio do módulo voltou a contar `../` para uma operação destrutiva", () => {
    const src = readFileSync(path.join(__dirname, "worktree.ts"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/path\.resolve\(worktreePath,\s*"\.\.",\s*"\.\."\)/);
  });
});

// ─── A trava de board-data segue a régua DECLARADA, não a constante (2026-08-19) ─────────────────
//
// `staging.codePrefixes` é campo de settings desde a Fase 4a, e o merge train sempre leu o valor
// declarado. Esta trava — a que impede um run de board-data escrever CÓDIGO na main sem gate nenhum —
// perguntava pela CONST `["packages/"]`. Num repositório de layout PLANO (o layout NORMAL fora de um
// monorepo) ela respondia "não há código aqui" para todo arquivo de código: a defesa não errava, ela
// DESAPARECIA — e desaparecia onde o dono do repositório achava que tinha configurado.
describe("commitBoardDataScoped — a régua de código é a DECLARADA (layout plano)", () => {
  function execComIndice(inicial: string[]) {
    const calls: string[] = [];
    let staged = [...inicial];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("diff --cached --name-only")) return { stdout: staged.join("\n") + "\n", stderr: "" };
      const reset = cmd.match(/^git reset -- (.+)$/);
      if (reset) {
        const alvos = [...reset[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        if (alvos.length > 0) staged = staged.filter((p) => !alvos.includes(p));
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls, staged: () => staged };
  }

  it("com `codePrefixes: ['src/']`, um `src/x.ts` staged é DESESTAGIADO — a trava enxerga o layout plano", async () => {
    const { exec, calls, staged } = execComIndice(["storymap/boards/acme/cards/story-1.md", "src/app/page.tsx"]);
    const res = await commitBoardDataScoped(exec, "/repo", "board: acme/story-1", ["src/"]);
    expect(res).toEqual({ committed: true });
    expect(calls.some((c) => c.startsWith("git reset -- ") && c.includes("src/app/page.tsx"))).toBe(true);
    expect(staged()).toEqual(["storymap/boards/acme/cards/story-1.md"]); // o board seguiu; o código ficou
  });

  it("[ATAQUE] a régua ANTIGA deixaria o mesmo arquivo passar — é a prova de que o parâmetro importa", async () => {
    // MESMO índice, régua `["packages/"]` (o default legado): `src/app/page.tsx` não casa nenhum
    // prefixo, então nada é desestagiado e o código entra no commit de board-data — sem gate, sem
    // review, sem isolamento. Este caso documenta o defeito que o de cima corrige.
    const { exec, calls } = execComIndice(["storymap/boards/acme/cards/story-1.md", "src/app/page.tsx"]);
    await commitBoardDataScoped(exec, "/repo", "board: acme/story-1", ["packages/"]);
    expect(calls.some((c) => c.startsWith("git reset -- "))).toBe(false);
  });

  it("o DEFAULT do parâmetro vem do settings — não de uma constante deste arquivo", () => {
    // A fonte é o que garante que o caminho de produção (que chama com 3 argumentos) use o declarado.
    const fonte = readFileSync(path.join(__dirname, "worktree.ts"), "utf8");
    expect(fonte).toMatch(/codePrefixes: readonly string\[\] = loadRunnerConfig\(\)\.autorun\.staging\?\.codePrefixes/);
  });
});
