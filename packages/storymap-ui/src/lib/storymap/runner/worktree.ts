// Worktree ops — the ISOLATION layer of the autorun pipeline (R1, harness paralelo).
//
// Every headless run used to share ONE working tree (cwd = repo root), so two concurrent
// runs could overwrite each other's files — making maxConcurrent > 1 unsafe. This module
// gives each run an EPHEMERAL `git worktree` on a throwaway branch (`run/<sessionId>`), so
// N runs operate on N independent trees with zero file contention. Created at spawn, torn
// down at settle (success OR failure); orphans left by a crash are reaped by recovery.ts.
//
// The git plumbing is behind an injectable `exec` (DI — like the engine's `spawn`/`journal`)
// so the lifecycle is unit-testable without a real repo. SERVER-ONLY (node:child_process).

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runnerStateDir } from "@/lib/storymap/paths";
import { BOARD_DATA_PATHSPEC, STAGING_CODE_PREFIXES, loadRunnerConfig } from "./config";
import { type GitExec, makeGit, pushHeadToOrigin, quote } from "./git";
import { pathsTouchCode } from "./staging";
// run-base only type-imports `ExecFn` from here (erased at runtime), so this value import is acyclic.
import { isExactBase, resolveRunBase, runOwnWork } from "./run-base";
import { branchWorkLandedInMainOrStage, type Landedness } from "./convergence";
import { branchLiveness, readSessionsFromDisk } from "./session-liveness";

/** Allocate/dispose an ephemeral worktree for one run. Injected into the engine (DI). */
export interface WorktreeOps {
  /**
   * Create `<repoRoot>/.worktrees/run-<sessionId>` on branch `run/<sessionId>`. When `baseCommit` is
   * given the branch is cut from THAT sha (the integration base — `stage` when staging is on, so the
   * run sees the unreleased code in flight); omitted ⇒ cut from `HEAD` (the pre-fix / staging-off path).
   */
  create(repoRoot: string, sessionId: string, baseCommit?: string): Promise<{ worktreePath: string; branch: string }>;
  /**
   * Commit ALL of the run's writes onto its branch BEFORE the dir is detached (f1). The skill
   * edits files in the worktree but never commits; without this step the run branch stays == HEAD,
   * `git worktree remove --force` discards the diff, and the merge train (seeing `--is-ancestor`
   * true) deletes the branch — losing the whole run (code + the card's status advance). Stages
   * everything (`git add -A`) and commits on the run branch (cwd = the worktree). Returns
   * `{ committed: false }` for an EMPTY diff (nothing changed) WITHOUT making a commit, so the
   * caller can tear the tree down instead of enqueuing a no-op merge.
   */
  commit(worktreePath: string, message: string): Promise<{ committed: boolean }>;
  /**
   * HEAD=estado boundary commit on the MAIN repo. writeCard writes a card .md to disk WITHOUT
   * committing (the working tree is the live board "database"), so by the time the git boundaries
   * run — creating a run worktree (a checkout of HEAD) or merging a run branch back — HEAD/main is
   * STALE. This commits any pending board mutations on `repoRoot` (cwd = the main tree) with a
   * `board:`-prefixed message (separable from the `usm(...)` code commits), so the worktree is born
   * from the LIVE state and the merge-back runs on a clean tree. story-p3bu01: SCOPED to the board
   * pathspec (`storymap/boards/**`) via {@link commitBoardDataScoped} — NEVER `git add -A` — so a stray
   * code edit / a predeploy tarball dirtying the shared runtime checkout can never be SWEPT into the
   * `board: estado vivo` boundary commit that reaches origin/main (the silent-regression vector that
   * broke prod deploys). Same fail-closed secret scan + code-touch abort as {@link commitBoardDataScoped}.
   * Returns `{ committed: false }` WITHOUT committing when the board delta is empty.
   */
  commitBoardState(repoRoot: string, message: string): Promise<{ committed: boolean }>;
  /**
   * The no-worktree SETTLE commit of an isCode:false board-data run (story-apz8sa). Like
   * {@link commitBoardState} it commits ONLY the scoped `storymap/boards/**` delta (both delegate to
   * {@link commitBoardDataScoped}); on top of that this:
   *   1. commits ONLY the `storymap/boards/**` delta (scoped pathspec, NEVER `git add -A`) so a stray
   *      code edit / unrelated board dirt can't ride the `board:` commit — and ABORTS if the staged
   *      diff touches CODE (defense-in-depth — FIX 2);
   *   2. on a real commit, PUSHES it to origin via the SAME robust cumulative-push+reconcile path the
   *      merge train / release use (FIX 1) so a board-data run is durable + visible to other checkouts,
   *      matching the pre-apz8sa behavior (board data reached origin via the merge train).
   * FAIL-OPEN on the push (a failed push is logged on the result, never throws) so a push outage never
   * crashes the run. Returns whether it committed and whether the push landed. Same fail-closed secret
   * scan as the other commit paths (a secret-scan rejection throws — the caller logs it non-fatally).
   */
  commitBoardStateAndPush(
    repoRoot: string,
    message: string,
  ): Promise<{ committed: boolean; pushed: boolean; pushError?: string }>;
  /**
   * Remove the worktree dir and delete its branch (idempotent — safe if already gone).
   *
   * Uma árvore de SESSÃO VIVA só é removida com `consent: "session-discard"` — ver o guard em
   * `assertRemovable`. Todo chamador que não seja o discard explícito do próprio agente deve
   * OMITIR o consentimento: assim, um caminho que não devia estar removendo é recusado em vez de
   * apagar trabalho.
   */
  remove(
    worktreePath: string,
    branch: string,
    base?: string,
    opts?: { consent?: "session-discard" },
  ): Promise<void>;
  /**
   * Remove ONLY the worktree dir, PRESERVING its branch (SM-2). Used at settle when the
   * merge queue will integrate the run's branch — the queue (not the worktree teardown)
   * owns deleting it after a successful merge. Without this, `remove`'s `git branch -D`
   * would destroy the work before it could be merged.
   *
   * SEM o resgate de {@link remove}, e isso é DELIBERADO (não esquecimento): `detach` tem UM chamador,
   * o settle do engine, que roda o sweep-commit imediatamente antes — a árvore aqui está limpa por
   * construção, e o branch (com o trabalho todo) sobrevive para a fila. Pôr um `git status` neste
   * caminho custaria um subprocesso por run para cobrir um risco que a ordem das chamadas já elimina.
   * Se um dia aparecer um segundo chamador, ele precisa do resgate — ou desta mesma prova.
   */
  detach(worktreePath: string): Promise<void>;
  /**
   * Does the run branch carry work the merge train still needs to integrate? TRUE when `branch`
   * is NOT yet an ancestor of `repoRoot`'s HEAD — i.e. it has commits not on main. This is the
   * settle gate that lets a skill make its OWN incremental commits inside the worktree: the old
   * `commit().committed` flag only saw UNcommitted changes, so a skill that committed everything
   * itself looked "empty" and its branch was discarded (work lost). Asking git whether the branch
   * diverged catches BOTH paths (skill self-committed AND/OR the settle sweep committed leftovers).
   * Mirrors the merge train's own `--is-ancestor` integration check. Run from `repoRoot` (main).
   */
  hasUnmergedWork(repoRoot: string, branch: string, base?: string): Promise<boolean>;
  /**
   * Paths que o run mudou vs sua base de integração — commitados E não-commitados (diff tracked vs
   * `base`; o settle roda ANTES do sweep-commit do teardown) + arquivos novos untracked. O guard de
   * artefatos C2/O3.5 pergunta com isto "este run produziu CÓDIGO?". Opcional: implementação ausente
   * desliga o guard (fail-open) — nunca falha um run por conta própria.
   */
  changedPaths?(worktreePath: string, base: string): Promise<string[]>;
  /**
   * Dispose a run branch that has NO worktree (a detached/orphaned `run/<id>` left by a crash in the
   * settle gap — committed + detached, but the merge enqueue never persisted). PRESERVES it as
   * `failed/<branch>` when it carries un-integrated commits (recoverable), else `branch -D`. The same
   * safe preserve-or-delete tail `remove` applies, minus the worktree step (the dir is already gone) —
   * used by the boot reconciler's branch sweep. Idempotent. (settle-gap-resume)
   */
  disposeBranch(repoRoot: string, branch: string, base?: string): Promise<void>;
}

/**
 * Minimal async exec surface (DI). The default is `promisify(child_process.exec)`, which runs
 * the command through a shell — so callers MUST quote interpolated paths (see `quote`). Only
 * git invocations with controlled args (uuid session ids, repo paths) flow through here.
 */
export type ExecFn = (
  command: string,
  // `env` é OPCIONAL por compatibilidade, e AUSENTE significa «herda o process.env do serviço» —
  // sob systemd, NODE_ENV=production e os tokens MCP. Quem spawna uma suíte de teste ou um tsc passa
  // `env: sanitizeSpawnEnv(...)` (ver gateExecOptions em merge-queue.ts). promisify(child_process.exec)
  // repassa o campo tal qual.
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Minimal filesystem surface (DI) for the node_modules provisioning step. Injected into
 * `makeWorktreeOps` alongside `exec` so the link logic is unit-testable without touching disk.
 * The default ({@link defaultWorktreeFs}) wires `node:fs/promises`. SERVER-ONLY in production.
 */
export interface WorktreeFs {
  /** Names of the immediate SUBDIRECTORIES of `dir` (for enumerating `packages/*`). `[]` if `dir` is absent. */
  listDirs(dir: string): Promise<string[]>;
  /** True iff `p` exists and is (or resolves to) a directory. */
  isDir(p: string): Promise<boolean>;
  /** True iff `p` exists and is (or resolves to) a regular FILE (probing `tsconfig.json` per gate unit). */
  isFile(p: string): Promise<boolean>;
  /**
   * Create a directory symlink/junction at `linkPath` pointing to `target` (idempotent: a NO-OP
   * if `linkPath` already exists). Uses the `"junction"` type so it works on Windows WITHOUT admin
   * rights (a plain symlink there needs elevation); POSIX ignores the type and makes a real symlink.
   */
  linkDir(target: string, linkPath: string): Promise<void>;
  /**
   * Remove ONLY a symlink/junction at `linkPath` (the link itself, NEVER its target). A NO-OP if
   * `linkPath` is absent. SAFETY: if `linkPath` is a REAL directory (not a link) this MUST refuse —
   * deleting it would wipe the main checkout's node_modules. Returns whether a link was removed.
   */
  unlinkDir(linkPath: string): Promise<boolean>;
}

/** Production {@link WorktreeFs} over `node:fs/promises`. */
export const defaultWorktreeFs: WorktreeFs = {
  async listDirs(dir) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  },
  async isDir(p) {
    try {
      return (await fsp.stat(p)).isDirectory(); // stat follows links → "is the TARGET a dir"
    } catch {
      return false;
    }
  },
  async isFile(p) {
    try {
      return (await fsp.stat(p)).isFile(); // stat follows links → "is the TARGET a file"
    } catch {
      return false;
    }
  },
  async linkDir(target, linkPath) {
    // Idempotent: if anything already sits at linkPath (a stale link, a prior run's dir), leave it.
    try {
      await fsp.lstat(linkPath);
      return;
    } catch {
      /* ENOENT → create below */
    }
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    // "junction" works for directories on Windows without elevation; POSIX makes a normal symlink.
    await fsp.symlink(target, linkPath, "junction");
  },
  async unlinkDir(linkPath) {
    let isLink: boolean;
    try {
      isLink = (await fsp.lstat(linkPath)).isSymbolicLink(); // lstat → describe the LINK, not its target
    } catch {
      return false; // already gone
    }
    // GUARD: only ever unlink a symlink/junction. A junction reports isSymbolicLink() on Windows;
    // a POSIX symlink-to-dir likewise. If it is a REAL directory we refuse — recursing into it
    // would delete the main checkout's deps (the exact teardown footgun the bug warns about).
    if (!isLink) return false;
    await fsp.unlink(linkPath); // unlink removes the link inode only — it can NEVER touch the target
    return true;
  },
};

/**
 * The NESTED workspace tiers under each `packages/<pkg>/` that are their OWN workspace packages with
 * their OWN non-hoisted `node_modules` — mirrors the root `package.json` `workspaces` globs
 * (`packages/*` plus the nested `packages/<pkg>/web`, `/api`, `/functions` tiers). A worktree that runs a
 * build/test IN one of these (e.g. `packages/orbit/web` for a QA E2E, or `harness-do` building the web
 * app) needs its node_modules linked too — otherwise dep/@types resolution fails and every run wastes
 * turns hand-`ln -s`-ing it (the exact degraded-worktree churn story-olr777's QA hit). Keep in sync
 * with the root `workspaces` globs.
 */
const NESTED_WORKSPACE_TIERS = ["web", "api", "functions"] as const;

/**
 * Compute the node_modules links a worktree needs from the MAIN checkout: the ROOT `node_modules`
 * (hoisted deps), every `packages/<pkg>/node_modules` (per-package deps that do NOT hoist — e.g.
 * gray-matter under `packages/storymap-ui/node_modules`), AND every NESTED workspace tier's
 * `packages/<pkg>/{web,api,functions}/node_modules` ({@link NESTED_WORKSPACE_TIERS} — the deps of the
 * nested app/api/functions workspaces, which likewise do NOT hoist and were previously MISSED). Pure
 * over the injected fs (a query): returns `{ target, linkPath }` pairs, only for node_modules that
 * actually exist in the main repo. Root-first so a hoisted dep resolves to the worktree's own root link.
 */
export async function planNodeModulesLinks(
  fs: WorktreeFs,
  repoRoot: string,
  worktreePath: string,
): Promise<Array<{ target: string; linkPath: string }>> {
  const links: Array<{ target: string; linkPath: string }> = [];
  const rootNm = path.join(repoRoot, "node_modules");
  if (await fs.isDir(rootNm)) {
    links.push({ target: rootNm, linkPath: path.join(worktreePath, "node_modules") });
  }
  const packagesDir = path.join(repoRoot, "packages");
  for (const name of await fs.listDirs(packagesDir)) {
    // depth-1: packages/<pkg>/node_modules
    const pkgNm = path.join(packagesDir, name, "node_modules");
    if (await fs.isDir(pkgNm)) {
      links.push({ target: pkgNm, linkPath: path.join(worktreePath, "packages", name, "node_modules") });
    }
    // nested workspace tiers: packages/<pkg>/{web,api,functions}/node_modules — do NOT hoist, MISSED
    // by the depth-1 pass above (the root cause of the degraded-worktree test-env, story-olr777).
    for (const tier of NESTED_WORKSPACE_TIERS) {
      const nestedNm = path.join(packagesDir, name, tier, "node_modules");
      if (await fs.isDir(nestedNm)) {
        links.push({
          target: nestedNm,
          linkPath: path.join(worktreePath, "packages", name, tier, "node_modules"),
        });
      }
    }
  }
  return links;
}

/**
 * Provision a fresh worktree's deps by LINKING (not installing) the main checkout's node_modules
 * into it — instantaneous, no network, no `bun install` (the costly/flaky auto-heal the bug rejects).
 * Idempotent per link. Returns the links created so callers/tests can assert them.
 */
export async function provisionNodeModules(
  fs: WorktreeFs,
  repoRoot: string,
  worktreePath: string,
): Promise<Array<{ target: string; linkPath: string }>> {
  const links = await planNodeModulesLinks(fs, repoRoot, worktreePath);
  for (const { target, linkPath } of links) {
    await fs.linkDir(target, linkPath);
  }
  return links;
}

/**
 * Tear the provisioning down BEFORE `git worktree remove` runs, so git never even sees the links —
 * a belt-and-suspenders guarantee that teardown can NEVER follow a link and delete the main
 * checkout's node_modules. Unlinks each planned link (the link only — `unlinkDir` refuses real dirs).
 */
export async function deprovisionNodeModules(
  fs: WorktreeFs,
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  const links = await planNodeModulesLinks(fs, repoRoot, worktreePath);
  for (const { linkPath } of links) {
    await fs.unlinkDir(linkPath);
  }
}

// Sibling of the repo working tree, gitignored at the root (.gitignore → `.worktrees/`). Kept
// inside the repo (not /tmp) so all run trees live on the same filesystem as `.git` — `git
// worktree add` requires it, and a same-fs rename keeps teardown cheap.
const WORKTREE_PARENT = ".worktrees";

/**
 * A raiz do repositório a partir do caminho de um worktree — COM verificação de forma.
 *
 * ── POR QUE ISTO EXISTE (F0 · ADR-067) ──────────────────────────────────────────────────────────────
 * Três sítios deste arquivo faziam `path.resolve(worktreePath, "..", "..")` e alimentavam com o
 * resultado `git worktree remove --force` e `git branch -D`. É EXATAMENTE o par que o plano nomeia como
 * risco nº 1 — "resolução de raiz que não falha alto + operação destrutiva sobre o resultado" — e que
 * F0 matou em `paths.ts` e deixou vivo aqui. Um revisor apontou; a contagem de `../` estava certa para
 * o layout de hoje e não havia NADA verificando que o caminho tinha mesmo a forma esperada. Num
 * `worktreePath` de outro formato, o `../..` aponta para um diretório arbitrário e o `git branch -D`
 * roda lá.
 *
 * O contrato é `<repoRoot>/.worktrees/<nome>`. Qualquer outra forma LANÇA, nomeando o que recebeu —
 * porque a alternativa é apagar branch no lugar errado em silêncio.
 */
export function repoRootOfWorktree(worktreePath: string): string {
  const pai = path.dirname(worktreePath);
  if (path.basename(pai) !== WORKTREE_PARENT) {
    throw new Error(
      `[worktree] caminho fora do contrato: esperava <repoRoot>/${WORKTREE_PARENT}/<nome>, recebi ` +
        `"${worktreePath}" (o pai é "${path.basename(pai)}"). Recusando a derivar uma raiz por contagem ` +
        `de "../" — o resultado alimentaria "git worktree remove --force" e "git branch -D".`,
    );
  }
  return path.dirname(pai);
}
// Generous ceiling: `git worktree add` copies refs + checks out HEAD; on a big repo that is
// seconds, never minutes. A hang here would otherwise block a concurrency slot indefinitely.
const EXEC_TIMEOUT_MS = 60_000;

/** Throwaway branch backing a run's worktree. Derivable from the (journaled) sessionId. */
export function runBranch(sessionId: string): string {
  return `run/${sessionId}`;
}

/** Absolute path of a run's ephemeral worktree, under `<repoRoot>/.worktrees/`. */
export function runWorktreePath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, WORKTREE_PARENT, `run-${sessionId}`);
}

/**
 * Throwaway branch backing an AGENT SESSION's worktree (WS-1) — the interactive/spawned twin of
 * {@link runBranch}. Same shape, same lifecycle, same preservation renames (`failed/`/`conflicted/`);
 * the ONLY differences are who commits onto it (a live session, over hours, instead of a headless run)
 * and that the merge train never deletes it (the session still holds it — see the deletion guard in
 * merge-queue.ts). `sessionId` is ALWAYS minted by the tool (uuid, D12), never a name the agent chose.
 */
export function agentBranch(sessionId: string): string {
  return `agent/${sessionId}`;
}

/** Absolute path of an agent session's worktree — sibling of the run trees under `<repoRoot>/.worktrees/`. */
export function agentWorktreePath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, WORKTREE_PARENT, `agent-${sessionId}`);
}

/**
 * Build the shell command that runs the repo's secret scanner over a target diff (SM-08). SHARED by
 * the run/board commit path ({@link commitAllPending}, `--staged`) and the merge train
 * (`merge-queue.ts`, `--range HEAD~1..HEAD` over the merge commit) so BOTH invoke the SAME scanner
 * the SAME way: via `process.execPath` (the CURRENTLY-running Node binary — the storymap systemd
 * service's PATH is minimal and may not resolve a bare `node`), with `repoRoot` locating the scanner
 * independent of cwd. The caller runs it and FAILS CLOSED on any non-zero exit (2 = secret found,
 * 1 = internal scan error after SM-08).
 */
export function secretScanCommand(repoRoot: string, target: "staged" | { range: string }): string {
  const scanner = path.join(repoRoot, "scripts", "git-hooks", "scan-secrets.mjs");
  const selector = target === "staged" ? "--staged" : `--range ${target.range}`;
  return `${quote(process.execPath)} ${quote(scanner)} ${selector}`;
}

/**
 * Stage + commit ALL pending changes in `cwd` onto its current branch, with a fail-closed secret
 * scan first. Returns `{ committed: false }` WITHOUT making a commit on an EMPTY diff (so the caller
 * can skip a no-op merge). `repoRoot` locates the secret scanner independently of `cwd` (which may be
 * a worktree under `<repoRoot>/.worktrees/`). Used by `commit` (cwd = a run worktree → lands on
 * `run/<id>` — the run's own isolated CODE commit, where the whole-tree `git add -A` is correct). The
 * board-boundary snapshots (`commitBoardState` + the merge-train boundary-2) DELIBERATELY do NOT use
 * this — they take the SCOPED {@link commitBoardDataScoped} (story-p3bu01) so the shared main tree's
 * stray code / predeploy tarballs are never swept into a `board:` commit. Pure over the injected exec —
 * SERVER-ONLY in production (real git). See the f-sec note below for why the scan is run EXPLICITLY
 * here even though the commit uses `--no-verify`.
 */
export async function commitAllPending(
  exec: ExecFn,
  cwd: string,
  repoRoot: string,
  message: string,
): Promise<{ committed: boolean }> {
  // Empty-diff guard FIRST: a tree that changed nothing must NOT create a commit (it would enqueue a
  // no-op merge / pollute history). `git status --porcelain` prints one line per changed/untracked
  // path; empty output ⇒ nothing to commit.
  const status = await exec(`git status --porcelain`, { cwd, timeout: EXEC_TIMEOUT_MS });
  if (status.stdout.trim() === "") return { committed: false };
  // Stage every change (new/modified/deleted) on the current branch (cwd decides which branch).
  await exec(`git add -A`, { cwd, timeout: EXEC_TIMEOUT_MS });
  // f-sec: run the repo's real secret scanner over the STAGED diff before committing. The commit
  // below uses `--no-verify` (the headless, unattended autorun must not be blocked by the NON-security
  // pre-commit hooks — e.g. the non-deterministic test-evidence stamp), but skipping ALL hooks would
  // also skip the secret scan, and the merge train integrates with `git merge --no-ff` WITHOUT
  // re-scanning → a secret committed here could reach `main`. So we run scan-secrets.mjs --staged
  // EXPLICITLY (cwd = where the staged diff lives) via {@link secretScanCommand} — the SAME helper the
  // merge train uses for the merge-commit scan (SM-08). FAIL CLOSED: ANY non-zero exit aborts the commit
  // — exit 2 (secret found) AND, since SM-08, exit 1 (the scanner's OWN internal error — e.g. a diff past
  // its git maxBuffer — which previously exited 0 and failed OPEN inside the scanner). So an UNVERIFIED
  // diff never reaches main, including the narrow maxBuffer case the old comment documented as residual.
  try {
    await exec(secretScanCommand(repoRoot, "staged"), { cwd, timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`secret-scan bloqueou o commit (cwd ${cwd}): ${detail}`);
  }
  // `--no-verify`: skip only the NON-security pre-commit hooks (the secret scan already ran above).
  await commitWithMessageFile(exec, cwd, message);
  return { committed: true };
}

// story-yy3hds: a mensagem de commit é TEXTO LIVRE — desde o F4 o sweep carrega o finalText do agente
// no trailer `Decision:` — e por isso NUNCA pode ser interpolada na linha de shell: aspas duplas não
// neutralizam `` ` ``/`$(…)`/`\` no /bin/sh. Backticks balanceados EXECUTAVAM o conteúdo como comando
// (injeção silenciosa — trailers mutilados em commits integrados reais); um backtick ímpar (a truncagem
// de 140 chars cortando um code-span) matava o commit com "EOF in backquote substitution" e o teardown
// destruía o trabalho do run. A mensagem vai num ARQUIVO temporário (`git commit -F`), então só o PATH
// controlado toca o shell. Nome único por invocação (pid+seq) — um nome fixo compartilhado é corrida
// entre workers paralelos (mesma lição do patch do release.ts).
let commitMsgSeq = 0;
async function commitWithMessageFile(exec: ExecFn, cwd: string, message: string): Promise<void> {
  const file = path.join(os.tmpdir(), `harness-commit-msg-${process.pid}-${++commitMsgSeq}.txt`);
  await fsp.writeFile(file, message, "utf8");
  try {
    await exec(`git commit --no-verify -F ${quote(file)}`, { cwd, timeout: EXEC_TIMEOUT_MS });
  } finally {
    await fsp.unlink(file).catch(() => {}); // best-effort; tmpdir é limpo pelo SO
  }
}

/**
 * Commit ONLY the board-data delta (`storymap/boards/**`) of the SHARED main tree — the no-worktree
 * settle path of an isCode:false run (story-apz8sa FIX 2). Unlike {@link commitAllPending}'s
 * `git add -A` (which sweeps the WHOLE tree), this stages with the {@link BOARD_DATA_PATHSPEC} pathspec
 * ONLY, so a stray code edit or an unrelated dirty board file on the shared main tree can NEVER ride
 * the `board:` commit (blast-radius reduction — a board-data run has no review / gate / isolation).
 *
 * DEFENSE IN DEPTH: after staging, the STAGED diff (`--cached --name-only`) is re-checked against the
 * code prefixes (os DECLARADOS — ver o parâmetro `codePrefixes` —, via {@link pathsTouchCode}). If anything under a code
 * prefix slipped into the index (a misclassified skill / a path under `storymap/boards/` that is
 * somehow code — should be impossible, but fail SAFE), the commit is ABORTED with the index reset, so a
 * board-data run can NEVER write CODE to main as board data with no gate. Returns `{ committed:false }`
 * on an empty board-data delta (clean → no no-op commit). Same fail-closed secret scan as
 * {@link commitAllPending}. `repoRoot` is BOTH the cwd (main tree) and the scanner anchor.
 */
export async function commitBoardDataScoped(
  exec: ExecFn,
  repoRoot: string,
  message: string,
  /**
   * A régua de "o que é CÓDIGO", EFETIVA — `autorun.staging.codePrefixes` do settings, não a constante.
   *
   * Por que isto virou parâmetro (2026-08-19): a defesa em profundidade abaixo perguntava pela CONST
   * `["packages/"]` enquanto o repositório podia declarar outra coisa (`codePrefixes` é campo de
   * settings desde a Fase 4a, e o merge train JÁ lia o valor declarado). Num repositório de layout
   * PLANO — `src/` na raiz, sem `packages/` — a pergunta respondia "não há código aqui" para TODO
   * arquivo de código, e a trava que impede um run de board-data escrever código na main SEM GATE
   * ficava inerte. Ela não errava: ela desaparecia, e desaparecia exatamente onde o dono do
   * repositório achava que tinha configurado.
   */
  codePrefixes: readonly string[] = loadRunnerConfig().autorun.staging?.codePrefixes ?? STAGING_CODE_PREFIXES,
): Promise<{ committed: boolean }> {
  // Stage ONLY the board-data pathspec (NOT `git add -A`). `--` separates the pathspec from flags;
  // a missing/clean prefix is a no-op (git exits 0 with nothing staged).
  await exec(`git add -- ${quote(BOARD_DATA_PATHSPEC)}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
  // Empty-diff guard: with nothing under the pathspec staged, there is nothing to commit (the run only
  // touched files outside `storymap/boards/` — which a board-data run must NOT, so we simply skip).
  const staged = await exec(`git diff --cached --name-only`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
  const stagedPaths = staged.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (stagedPaths.length === 0) return { committed: false };
  // DEFENSE IN DEPTH: a board-data commit must NEVER carry CODE. The scoped `git add` above can't
  // stage code — code paths land in the index only when a PRIOR actor left them there (a crashed
  // split apply, a stray manual `git add` on the shared runtime checkout). That foreign junk used to
  // ABORT this commit forever — and because EVERY board flush + run boundary passes through here, two
  // stranded files kept KILLING healthy runs until a human cleaned the index (the story-tlz0dt
  // run-death of 2026-07-21). Self-heal instead: UNSTAGE the code paths (index only — the working
  // tree is untouched, the files stay visible for the operator/next code run), then commit the board
  // delta alone. Only if code REMAINS staged after the reset do we abort (fail-closed as before).
  if (pathsTouchCode(stagedPaths, codePrefixes)) {
    const codePaths = stagedPaths.filter((p) => codePrefixes.some((c) => p.startsWith(c)));
    console.warn(
      `[harness-worktree] board-data commit: desestagiando ${codePaths.length} path(s) de código alheios ao board (${codePaths.join(", ").slice(0, 200)}) — código nunca viaja num commit de board`,
    );
    await exec(`git reset -- ${codePaths.map((p) => quote(p)).join(" ")}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS }).catch(() => {});
    const recheck = await exec(`git diff --cached --name-only`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
    const recheckPaths = recheck.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (pathsTouchCode(recheckPaths, codePrefixes)) {
      await exec(`git reset -- ${quote(BOARD_DATA_PATHSPEC)}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS }).catch(() => {});
      throw new Error(
        `board-data commit ABORTADO: o diff staged toca código mesmo após desestagiar (${recheckPaths.filter((p) => codePrefixes.some((c) => p.startsWith(c))).join(", ").slice(0, 200)}) — um run de board-data nunca escreve código em main`,
      );
    }
    if (recheckPaths.length === 0) return { committed: false }; // só havia o lixo de código — nada de board a versionar
  }
  // Same fail-closed secret scan as commitAllPending (the `--no-verify` commit below skips the hooks).
  try {
    await exec(secretScanCommand(repoRoot, "staged"), { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`secret-scan bloqueou o board commit (cwd ${repoRoot}): ${detail}`);
  }
  // story-yy3hds: mesma disciplina do commitAllPending — mensagem via arquivo (-F), nunca interpolada.
  await commitWithMessageFile(exec, repoRoot, message);
  return { committed: true };
}

/**
 * Build a {@link WorktreeOps} over an injectable exec + fs. `defaultWorktreeOps` wires the real git
 * and `node:fs`. `fs` provisions the worktree's node_modules (links the main checkout's deps in,
 * instantly — see {@link provisionNodeModules}); it defaults to {@link defaultWorktreeFs}.
 */
/**
 * True iff `branch` carries commits NOT yet on HEAD (it diverged → there is work to integrate).
 * `git merge-base --is-ancestor` exits 0 when `branch` IS an ancestor of HEAD (→ no work), non-zero
 * otherwise. A missing/invalid branch also exits non-zero → treated as "has work" (fail-safe: prefer
 * preserving/enqueuing over silently dropping). Module-level (not a method) so `remove` can reuse it
 * with NO `this` dependency, and both stay over the SAME injected `exec`.
 */
export async function branchHasUnmergedWork(
  exec: ExecFn,
  repoRoot: string,
  branch: string,
  base = "HEAD",
): Promise<boolean> {
  try {
    // `base` is always a bare ref/sha (HEAD or a baseCommit) — no spaces/metachars — so it is NOT quoted
    // (keeps the command byte-identical to the pre-fix `... HEAD` for the default, no churn). `branch` is.
    await exec(`git merge-base --is-ancestor ${quote(branch)} ${base}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
    return false; // exit 0 → ancestor of `base` → nothing to integrate (branch never advanced past it)
  } catch {
    return true; // non-zero → diverged (has commits past `base`) → integrate/preserve it
  }
}

/**
 * Does this run branch carry commits IT wrote — measured from where the runner cut it, not from HEAD?
 *
 * This is the fix for the "lixo imortal": a branch is cut from `stage`, so its tip is a stage commit
 * that is NOT an ancestor of `main`. Against `base = HEAD/main`, `branchHasUnmergedWork` therefore
 * reports "has work" even for a run that committed NOTHING of its own — and the teardown preserved 12
 * such empty branches as `failed/*`. The run's reflog records its exact cut point (`branch: Created
 * from <sha>`, fresh at teardown time); if `cut..branch` has ZERO commits, there is literally nothing
 * to preserve. Returns null when the cut point can't be established EXACTLY (reflog gone) → the caller
 * must fall back to the conservative HEAD check (prefer a recoverable leak over a lost commit).
 */
async function hasOwnCommits(exec: ExecFn, repoRoot: string, branch: string): Promise<boolean | null> {
  const { base, provenance } = await resolveRunBase(exec, repoRoot, branch, {
    // o branch de integração é DECLARADO (`autorun.staging.branch`); fixar o literal aqui
  // sobrescrevia a declaração do repositório — o train já lia o declarado, as réguas de ciclo de vida não
    stageBranch: loadRunnerConfig().autorun.staging?.branch ?? "stage",
  });
  // Only an EXACT base may authorise a delete. WS-1: a session branch's exact base is `base-ref`, NOT the
  // reflog (the refresh rebase invalidates the reflog) — testing `=== "reflog"` here would make EVERY agent
  // branch unprovable, so every discard would preserve an empty `failed/agent/<id>`: the "lixo imortal" this
  // very function was written to end, reborn for sessions.
  if (!base || !isExactBase(provenance)) return null; // not proven exactly → don't risk a delete on a guess
  const work = await runOwnWork(exec, repoRoot, branch, base);
  if (!work) return null; // git couldn't read the delta → fail safe
  return work.commits > 0;
}

/**
 * SAFE branch teardown — the shared data-loss guard. PRESERVE a branch carrying un-integrated commits
 * as `failed/<branch>` (recoverable; frees the `run/<id>` name so the reconciler never re-scans it),
 * else `branch -D` it (already on HEAD / empty → nothing to lose). The common tail of `remove` (after
 * the worktree dir is gone) and `disposeBranch` (no worktree to remove) — extracted so the guard lives
 * in ONE place. (storymap-critical-audit safe-remove + settle-gap-resume)
 */
/**
 * O GUARD que faltava: nada remove a árvore de uma sessão VIVA sem pedir.
 *
 * O incidente (2026-07-21): quatro worktrees de sessão foram apagados NO MEIO da edição, um deles
 * levando trabalho ainda não commitado. A investigação eliminou, com evidência, todos os suspeitos
 * — TTL do heartbeat (6h, e as sessões tinham minutos), o reaper systemd (só mata chrome), o
 * reconciliador do serviço (nenhuma linha no journal, e um canário sobreviveu a dois restarts),
 * `git clean` (`.worktrees/` é ignorado, e `clean` sem `-x` não toca ignorados) e a suíte (os
 * `git worktree remove` dela apontam para sandboxes em /tmp). O autor não foi flagrado.
 *
 * Então a defesa não depende de saber quem é. O recurso passa a se defender no ponto MAIS BAIXO por
 * onde toda remoção passa: se a branch é de uma sessão viva e o chamador não declarou consentimento,
 * a remoção é RECUSADA e o stack trace de quem tentou vai para o log — o que, na próxima ocorrência,
 * entrega o culpado que a investigação não alcançou.
 *
 * Fail-closed nos dois sentidos que importam:
 *   • registro ILEGÍVEL ⇒ recusa (não sei ≠ pode);
 *   • sessão desconhecida/expirada ⇒ libera (é justamente o lixo que o reaper existe para colher).
 */
export function assertRemovable(branch: string, consent?: "session-discard"): void {
  if (consent === "session-discard") return; // o próprio agente pediu — é o caminho sancionado
  const liveness = branchLiveness(branch, readSessionsFromDisk(), Date.now());
  if (liveness.live === false) return; // run/*, sessão desconhecida ou heartbeat vencido
  const quem =
    liveness.live === true
      ? `sessão VIVA ${liveness.sessionId.slice(0, 8)}${liveness.task ? ` (${liveness.task.slice(0, 50)})` : ""}`
      : "registro de sessões ILEGÍVEL (não dá para provar que está morta)";
  const erro = new Error(
    `[worktree] REMOÇÃO RECUSADA de ${branch}: ${quem}. ` +
      `Quem remove árvore de sessão viva é o próprio agente, via worktree_discard ` +
      `(que declara consent:"session-discard"). Se você é um varredor, cheque o heartbeat antes.`,
  );
  // O stack É o produto aqui: ele nomeia o caminho que a investigação não conseguiu flagrar.
  console.error(erro.message, "\n  origem:", erro.stack);
  throw erro;
}

/**
 * A MENSAGEM do commit de resgate. Ela é o RUNBOOK: quem for procurar o trabalho perdido vai
 * encontrar exatamente este texto num `git log`, e ele precisa dizer o que aconteceu e como voltar.
 * Pura (vai por `-F`, nunca pela linha de shell). Exportada para o teste travar o contrato.
 */
export function rescueCommitMessage(branch: string, whenIso: string): string {
  return [
    `wip(resgate): trabalho não-commitado salvo antes do teardown de ${branch}`,
    "",
    `Um varredor foi remover esta árvore (heartbeat vencido) e ela tinha alterações não-commitadas.`,
    `Em vez de descartá-las com \`git worktree remove --force\`, elas viraram ESTE commit — o branch`,
    `é preservado como \`failed/${branch}\` pelo teardown, então nada se perde.`,
    "",
    `Para recuperar:  git log failed/${branch}   ·   git cherry-pick <sha>`,
    `Resgatado em: ${whenIso}`,
  ].join("\n");
}

/**
 * O ledger de resgates — raro por construção; cada linha é um incidente com endereço de recuperação.
 * Mora com os outros ledgers do runner (`runnerStateDir()`, como session-gc/branch-gc), que é também o
 * diretório que a bancada de teste redireciona para um temp.
 */
async function appendRescueLedger(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = runnerStateDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(path.join(dir, "worktree-rescue.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // O ledger é o REGISTRO, não a salvaguarda: o commit já aconteceu e o branch já será preservado.
    // Falhar aqui não pode impedir o teardown de seguir.
  }
}

/**
 * O RESGATE — nada destrói a única cópia de um trabalho.
 *
 * O INCIDENTE (2026-07-27): uma sessão interativa editou por horas sem commitar; o heartbeat dela só
 * avança em chamada de tool, venceu o TTL de 6h, e a varredura chamou `remove` → `git worktree remove
 * --force` apagou 14 arquivos editados. Sem commit não há objeto: `git fsck --dangling` não tem o que
 * achar. O branch, vazio, foi deletado logo depois — corretamente, porque de fato não havia commit
 * nenhum para preservar.
 *
 * O buraco não estava no TTL nem em quem varre: estava na PREMISSA de que "a pasta é descartável, o
 * trabalho nunca" — verdadeira só para trabalho COMMITADO. O `--force` é literalmente a instrução de
 * jogar fora o não-commitado.
 *
 * A correção é a mesma disciplina que o engine já pratica no fim de um run (o sweep-commit antes do
 * teardown), aplicada no PONTO ÚNICO por onde toda remoção passa — assim nenhum chamador futuro pode
 * esquecer dela. Reusa `commitAllPending`: mesmo `git add -A`, mesmo secret-scan fail-closed, mesma
 * mensagem por arquivo (à prova de injeção).
 *
 * FAIL-CLOSED: se havia o que salvar e o commit NÃO deu certo (secret-scan barrou, git quebrou), a
 * exceção sobe e a remoção NÃO acontece. Uma pasta vazada é barata e recuperável — esta é a mesma
 * direção de erro que o resto do subsistema já escolheu.
 *
 * NO-OPs de propósito: árvore limpa (nada a salvar) e árvore que já não existe no disco (a remoção
 * seguinte só limpa o registro do git — recusar ali deixaria um registro fantasma para sempre).
 */
export async function rescueUncommitted(
  exec: ExecFn,
  fs: WorktreeFs,
  worktreePath: string,
  repoRoot: string,
  branch: string,
): Promise<{ rescued: boolean }> {
  if (!(await fs.isDir(worktreePath))) return { rescued: false }; // pasta já não existe → nada a salvar
  const at = new Date().toISOString();
  let committed = false;
  try {
    ({ committed } = await commitAllPending(exec, worktreePath, repoRoot, rescueCommitMessage(branch, at)));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[worktree] RESGATE FALHOU em ${branch} (${worktreePath}): ${detail}\n` +
        `  A árvore tem trabalho não-commitado e NÃO será removida — ela é a única cópia. ` +
        `Resolva (ex.: o secret-scan acusou algo) e rode o teardown de novo.`,
    );
    throw new Error(`[worktree] resgate do trabalho não-commitado de ${branch} falhou: ${detail}`);
  }
  if (!committed) return { rescued: false }; // árvore limpa — o caminho comum, sem ruído
  console.warn(
    `[worktree] ${branch}: havia trabalho NÃO-COMMITADO na árvore — commitado antes do teardown. ` +
      `Recupere com: git log failed/${branch}`,
  );
  await appendRescueLedger({ at, branch, worktreePath, reason: "uncommitted-before-teardown" });
  return { rescued: true };
}

async function disposeRunBranch(exec: ExecFn, repoRoot: string, branch: string, base = "HEAD"): Promise<void> {
  if (await branchHasUnmergedWork(exec, repoRoot, branch, base)) {
    // Looks like work vs `base` — but `base` (HEAD/the persisted stage sha) misfires on a stage-cut
    // branch that committed nothing of its own. Confirm against the run's TRUE cut point before
    // preserving: proven-zero own commits ⇒ delete (nothing to recover); anything else ⇒ preserve.
    if ((await hasOwnCommits(exec, repoRoot, branch).catch(() => null)) === false) {
      await exec(`git branch -D ${quote(branch)}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
      console.warn(`[worktree] ${branch}: zero commits próprios acima do ponto de corte — removido (nada a preservar)`);
      return;
    }
    // ADR-065 — the branch HAS its own commits, but "has commits" is not "is not integrated". Both checks
    // above count SHAS: `--is-ancestor` walks the commit DAG, and `hasOwnCommits` counts `base..branch`.
    // The merge train integrates by re-applying the work as a PATCH onto stage/main, minting NEW shas and
    // never touching this branch — so neither check can EVER see integrated work, and every session that
    // committed anything was renamed `failed/agent/<id>` no matter how completely it landed. The false
    // "failed" then stuck forever: the branch-gc's own content escape was excluding session branches too.
    // So ask the ONE question that survives a patch-based integration: is the work there BY CONTENT?
    // Only `landed` (positive proof) authorizes the delete — `partial`/`absent`/`unknown` all preserve,
    // keeping the fail-closed contract exactly where it belongs.
    const landed = await branchWorkLandedInMainOrStage(exec, repoRoot, branch).catch((): Landedness => "unknown");
    if (landed === "landed") {
      await exec(`git branch -D ${quote(branch)}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
      console.warn(`[worktree] ${branch}: trabalho próprio PROVADO em main/stage por conteúdo — removido (integrado, nada a preservar)`);
      return;
    }
    const preserved = `failed/${branch}`;
    try {
      await exec(`git branch -m ${quote(branch)} ${quote(preserved)}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
      console.warn(`[worktree] preservei ${branch} → ${preserved} (commits não integrados; recuperável via merge/cherry-pick)`);
    } catch (err) {
      // Rename failed (target name taken / branch already gone) — leave the branch INTACT rather than
      // risk deleting work. A leaked branch is recoverable; a deleted one is not.
      console.error(`[worktree] não consegui preservar ${branch}; mantendo intacto:`, err instanceof Error ? err.message : err);
    }
    return;
  }
  await exec(`git branch -D ${quote(branch)}`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
}

export function makeWorktreeOps(exec: ExecFn, fs: WorktreeFs = defaultWorktreeFs): WorktreeOps {
  return {
    async create(repoRoot, sessionId, baseCommit) {
      const worktreePath = runWorktreePath(repoRoot, sessionId);
      const branch = runBranch(sessionId);
      // `-b` creates the (fresh, uuid-named → never pre-existing) branch; git makes the dir. A
      // `baseCommit` (the integration base — `stage`'s sha when staging is on) cuts the branch from
      // THAT sha so the run sees the unreleased code in flight; omitted ⇒ from HEAD (staging-off/legacy).
      const base = baseCommit ? ` ${quote(baseCommit)}` : "";
      await exec(`git worktree add ${quote(worktreePath)} -b ${quote(branch)}${base}`, {
        cwd: repoRoot,
        timeout: EXEC_TIMEOUT_MS,
      });
      // Provision deps: `node_modules/` is gitignored, so the fresh checkout has NONE and they don't
      // hoist — a per-package dep (gray-matter) is unresolvable, breaking tsc/test/build by ENVIRONMENT.
      // Link the main checkout's node_modules (root + per-package) in — instantaneous, no `bun install`.
      await provisionNodeModules(fs, repoRoot, worktreePath);
      return { worktreePath, branch };
    },

    async commit(worktreePath, message) {
      // cwd = the worktree, so the commit lands on `run/<id>` (strictly ahead of HEAD for the merge
      // train). The scanner lives in the MAIN repo: `<repoRoot>/.worktrees/run-<id>` → ../.. = repoRoot.
      const repoRoot = repoRootOfWorktree(worktreePath);
      return commitAllPending(exec, worktreePath, repoRoot, message);
    },

    async commitBoardState(repoRoot, message) {
      // cwd = the MAIN repo → the board commit lands on `main` itself, making HEAD carry the live
      // board state before the git boundary (worktree create / merge-back) runs. story-p3bu01: SCOPED
      // to `storymap/boards/**` (commitBoardDataScoped, NOT the whole-tree `git add -A` of
      // commitAllPending) so stray code / a predeploy tarball on the shared runtime checkout can never
      // be swept into the `board: estado vivo` boundary commit that reaches origin/main.
      return commitBoardDataScoped(exec, repoRoot, message);
    },

    async commitBoardStateAndPush(repoRoot, message) {
      // story-apz8sa FIX 1+2: the no-worktree settle of an isCode:false run. SCOPED commit (only the
      // `storymap/boards/**` delta — never `git add -A` — and aborts on a code-touching staged diff),
      // then PUSH to origin via the SAME robust path the merge train uses, FAIL-OPEN.
      const { committed } = await commitBoardDataScoped(exec, repoRoot, message);
      if (!committed) return { committed: false, pushed: false }; // empty board delta → nothing to push
      // Push HEAD via the shared cumulative-push + reconcile-on-non-ff helper. A GitRunner over the same
      // injected exec, anchored at repoRoot. FAIL-OPEN: a push failure is reported, never thrown — git
      // push is cumulative, so the next code run's merge-back push (or the next board commit) recovers it.
      const git = makeGit(exec as unknown as GitExec, { cwd: repoRoot, timeoutMs: EXEC_TIMEOUT_MS });
      const push = await pushHeadToOrigin(git);
      if (!push.pushed) {
        console.error(`[worktree] board-data push para origin falhou (não-fatal): ${push.detail}`);
      }
      return { committed: true, pushed: push.pushed, pushError: push.detail };
    },

    async remove(worktreePath, branch, base, opts) {
      // GUARD (2026-07-22): a árvore de uma sessão VIVA não se remove sem consentimento explícito.
      assertRemovable(branch, opts?.consent);
      // Run from the MAIN repo, not the worktree (a tree can't remove itself; the branch ref
      // lives in the main repo). The path is `<repoRoot>/.worktrees/run-<id>` → ../.. = repoRoot.
      const repoRoot = repoRootOfWorktree(worktreePath);
      // GUARD 2 (2026-07-27): o trabalho NÃO-COMMITADO vira commit ANTES do `--force`. Sem consentimento,
      // nada aqui tem o direito de destruir a única cópia de um arquivo. Ver {@link rescueUncommitted}.
      if (opts?.consent !== "session-discard") {
        await rescueUncommitted(exec, fs, worktreePath, repoRoot, branch);
      }
      // Unlink the provisioned node_modules FIRST so `git worktree remove --force` can never follow a
      // link into the main checkout and delete its deps (teardown non-regression guard, story-vovhjj).
      await deprovisionNodeModules(fs, repoRoot, worktreePath);
      // --force: discard the run's uncommitted changes (correct for an ephemeral tree) AND
      // tolerate a dir a crash already deleted (idempotent teardown).
      await exec(`git worktree remove ${quote(worktreePath)} --force`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
      // DATA-LOSS GUARD (storymap-critical-audit 2026-06): NEVER force-delete a branch carrying
      // un-integrated commits — an isolated run commits code AND advances its card INSIDE the worktree,
      // so a branch reaching teardown can hold REAL work invisible on main. Delegate to the shared
      // safe teardown, measuring "has work" against the run's BASE (stale-base fix: a run cut from
      // `stage` is never an ancestor of main, so vs HEAD it would ALWAYS look like work → spurious
      // failed/<branch> churn; vs its base, an empty run correctly `branch -D`s).
      await disposeRunBranch(exec, repoRoot, branch, base);
    },

    async detach(worktreePath) {
      // Same as `remove` minus the `git branch -D` — the branch stays so the merge queue can
      // integrate it. Run from the MAIN repo (a tree can't remove itself): ../.. = repoRoot.
      const repoRoot = repoRootOfWorktree(worktreePath);
      // Same teardown guard as `remove`: drop the links before git touches the dir.
      await deprovisionNodeModules(fs, repoRoot, worktreePath);
      await exec(`git worktree remove ${quote(worktreePath)} --force`, { cwd: repoRoot, timeout: EXEC_TIMEOUT_MS });
    },

    async hasUnmergedWork(repoRoot, branch, base) {
      // Thin wrapper over the shared predicate (the SAME check `remove` uses to decide preserve-vs-
      // delete). The caller only reaches here with a branch it just created, so a non-zero (missing/
      // invalid) is treated as "has work" — fail-safe: prefer enqueuing over silently dropping. `base`
      // = the run's integration base (its baseCommit) so a run cut from `stage` is measured against
      // where it was born, not main (else the unreleased code on stage looks like this run's work).
      return branchHasUnmergedWork(exec, repoRoot, branch, base);
    },

    async changedPaths(worktreePath, base) {
      // `base` é sempre um ref/sha puro (mesma convenção NÃO-quotada do branchHasUnmergedWork).
      // diff tracked vs base (pega commits do run + staged + unstaged) ∪ untracked (arquivo novo).
      const tracked = await exec(`git diff --name-only ${base}`, { cwd: worktreePath, timeout: EXEC_TIMEOUT_MS });
      const untracked = await exec(`git ls-files --others --exclude-standard`, { cwd: worktreePath, timeout: EXEC_TIMEOUT_MS });
      return [
        ...new Set(
          [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].map((l) => l.trim()).filter(Boolean),
        ),
      ];
    },

    async disposeBranch(repoRoot, branch, base) {
      // Safe teardown of a worktree-less orphan branch (settle-gap). Same preserve-or-delete tail as
      // `remove`, minus the worktree-remove step (the dir is already gone).
      await disposeRunBranch(exec, repoRoot, branch, base);
    },
  };
}

/** The production exec — `promisify(child_process.exec)` typed as ExecFn. ONE cast, ONE place;
 *  merge-queue/recovery/actions import this instead of re-casting. Lives next to ExecFn. */
export const defaultExec: ExecFn = promisify(nodeExec) as unknown as ExecFn;

/** Production WorktreeOps over the real `git` (promisified child_process.exec). */
export const defaultWorktreeOps: WorktreeOps = makeWorktreeOps(defaultExec);
