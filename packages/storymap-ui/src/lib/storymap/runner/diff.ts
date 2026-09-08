// Pure helpers for the card run-diff quick action (story-redesenho-cards-storymap).
// The server action shells out to `git diff main...run/<sessionId>`; these two pure
// functions — the branch name and the +/− line counter — are split out so they're
// node-unit-testable without spawning git.

import type { CommitRange, DiffSnapshot } from "../types";

/** The throwaway branch a finished run lives on (mirrors MergeQueueEntry.branch). */
export function runBranchName(sessionId: string): string {
  return `run/${sessionId}`;
}

/**
 * Git's well-known empty-tree SHA — the diff base when a card's earliest commit is
 * the repo root (so it has no parent `^` to diff against). `git diff <empty-tree>..X`
 * yields X's full content as additions.
 */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The commit-subject convention every harness-do/review/qa commit carries, e.g.
 * `· storymap/story-sm-05-commit-range` (see harness-do "Commits incrementais"). Greppable
 * long after the run branch is merged + deleted — the durable trace SM-05 leans on.
 */
export function cardCommitGrep(board: string, cardId: string): string {
  return `· ${board}/${cardId}`;
}

/** Runs a git subcommand and resolves its stdout. Injected so callers are testable. */
export type GitRunner = (args: string[]) => Promise<string>;

/**
 * SM-04 durable-diff fallback. When a card's run branch is gone (merged + `branch -D`)
 * but the merge train persisted a `diffSnapshot` on the card before deleting it,
 * reconstruct the EXACT diff the operator reviewed: `git diff <base>..<mergeCommit>`.
 * Preferred over the SM-05 grep range — it pins the precise merge commit instead of
 * scanning history by subject convention. Returns `ok:false` (NO throw, NO diff run)
 * when the snapshot is absent/incomplete, so the caller can fall through to the grep
 * fallback. `runGit` is injected so the range math is node-unit-testable without git.
 */
export async function snapshotRangeDiff(
  runGit: GitRunner,
  snapshot: DiffSnapshot | null | undefined,
): Promise<{ ok: true; range: CommitRange; diff: string } | { ok: false; error: string }> {
  const base = snapshot?.base?.trim();
  const mergeCommit = snapshot?.mergeCommit?.trim();
  if (!base || !mergeCommit) {
    return { ok: false, error: "Sem diffSnapshot persistido para este card." };
  }
  const diff = await runGit(["diff", `${base}..${mergeCommit}`]);
  return { ok: true, range: { base, head: mergeCommit }, diff };
}

/**
 * Reproduce the diff of a durable `commitRange` (`<base>..<head>`, both immutable
 * SHAs the review/QA pass stamped). This is the PREFERRED durable source on a card
 * that's been through review: unlike `diffSnapshot` (which the merge train rewrites on
 * EVERY merge-back, so a card's final trivial status-transition run overwrites the
 * implementation run's snapshot — see story-sm-12, where the +54/−9 doc change got
 * masked by a +6/−1 board-state merge), `commitRange.base..head` pins the exact
 * contiguous delta the review validated and never moves. Returns `ok:false` (NO git
 * run) when the range is absent/half-written, so the caller falls through to the
 * snapshot then the grep fallback. `runGit` is injected so it's node-unit-testable.
 */
export async function commitRangeDiff(
  runGit: GitRunner,
  range: CommitRange | null | undefined,
): Promise<{ ok: true; range: CommitRange; diff: string } | { ok: false; error: string }> {
  const base = range?.base?.trim();
  const head = range?.head?.trim();
  if (!base || !head) {
    return { ok: false, error: "Sem commitRange persistido para este card." };
  }
  const diff = await runGit(["diff", `${base}..${head}`]);
  return { ok: true, range: { base, head }, diff };
}

/**
 * SM-05 durable-diff fallback. When a card's run branch is gone (merged + deleted)
 * and no diffSnapshot exists, reconstruct its change from the `· <board>/<cardId>`
 * subject convention: grep the history (oldest→newest via `--reverse`), take the
 * range `<parent-of-first>..<last>`, and diff it. Returns a friendly message — NOT a
 * throw, and without running any diff — when the card has no commits (AC4). `runGit`
 * is injected so the range math is node-unit-testable without spawning git.
 */
export async function grepCardCommitRangeDiff(
  runGit: GitRunner,
  board: string,
  cardId: string,
): Promise<{ ok: true; range: CommitRange; diff: string } | { ok: false; error: string }> {
  const logOut = await runGit([
    "log",
    `--grep=${cardCommitGrep(board, cardId)}`,
    "--format=%H",
    "--reverse",
  ]);
  const shas = logOut
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (shas.length === 0) {
    return { ok: false, error: "Nenhum commit encontrado para este card." };
  }
  const head = shas[shas.length - 1];
  const base = await resolveRangeBase(runGit, shas[0]);
  const diff = await runGit(["diff", `${base}..${head}`]);
  return { ok: true, range: { base, head }, diff };
}

/**
 * Cumulative CODE diff of a card: ALL of its staged code commits on the `stage` branch — the split's
 * `usm(<cardId>): código staged (run <id>)` convention (merge-queue.ts integrateSplit). Range =
 * parent-of-first..last, scoped to `packages/`. Returns ok:false (no diff run) when the card has no
 * staged code yet (the `do` stage hasn't run / nothing split). `-F` (fixed-strings) because the message
 * carries literal `(`/`)` that `--grep`'s default regex would mis-parse. `runGit` injected for tests.
 */
export async function grepStagedCodeRangeDiff(
  runGit: GitRunner,
  cardId: string,
): Promise<{ ok: true; range: CommitRange; diff: string } | { ok: false; error: string }> {
  let logOut = "";
  try {
    logOut = await runGit(["log", "stage", "-F", `--grep=usm(${cardId}): código staged`, "--format=%H", "--reverse"]);
  } catch {
    return { ok: false, error: "Sem branch stage / sem código staged." };
  }
  const shas = logOut.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  if (shas.length === 0) return { ok: false, error: "Sem código staged para este card." };
  const head = shas[shas.length - 1];
  const base = await resolveRangeBase(runGit, shas[0]);
  const diff = await runGit(["diff", `${base}..${head}`, "--", "packages/"]);
  return { ok: true, range: { base, head }, diff };
}

/**
 * Cumulative BOARD diff of a card — every change to its board-data files (card .md + plan + wireframe
 * sidecars). PATH-based, NOT message-grep: the board-data commits use varied subjects (`board: … (board/
 * card)`, `usm(harness-enrich): board/card [run …]`), so only the file path is a reliable selector. Range =
 * parent-of-first-touch..last-touch, scoped to the card's files. `runGit` injected for tests.
 */
export async function cardBoardRangeDiff(
  runGit: GitRunner,
  board: string,
  cardId: string,
): Promise<{ ok: true; range: CommitRange; diff: string } | { ok: false; error: string }> {
  const files = [
    `storymap/boards/${board}/cards/${cardId}.md`,
    `storymap/boards/${board}/plans/${cardId}.md`,
    `storymap/boards/${board}/wireframes/${cardId}.json`,
  ];
  const logOut = await runGit(["log", "--format=%H", "--reverse", "--", ...files]);
  const shas = logOut.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  if (shas.length === 0) return { ok: false, error: "Sem commits de board para este card." };
  const base = await resolveRangeBase(runGit, shas[0]);
  const head = shas[shas.length - 1];
  const diff = await runGit(["diff", `${base}..${head}`, "--", ...files]);
  return { ok: true, range: { base, head }, diff };
}

/** One side (board OR code) of the cumulative card diff: the patch + its commit range + +/− totals. */
export interface CumulativeDiffPart {
  diff: string;
  range: CommitRange;
  additions: number;
  deletions: number;
}

/**
 * The CUMULATIVE "everything this card changed, all stages" — the answer to "ver todo o diff até a
 * revisão". Two parts because the split scatters them: `board` = every change to the card's board-data
 * files on the current branch (main) — narrative/acceptance/tasks/plan/wireframe, selected by PATH (the
 * board commits use varied subjects, so a message-grep would miss them); `code` = every `usm(<cardId>):
 * código staged` commit on `stage` — the product code held for release. Each is null when absent (e.g.
 * code not written yet). Reconstructed entirely from git history (no new storage) by reusing the two
 * range helpers.
 */
export async function cardCumulativeDiff(
  runGit: GitRunner,
  board: string,
  cardId: string,
): Promise<{ board: CumulativeDiffPart | null; code: CumulativeDiffPart | null }> {
  const toPart = (
    r: { ok: true; range: CommitRange; diff: string } | { ok: false; error: string },
  ): CumulativeDiffPart | null => (r.ok ? { diff: r.diff, range: r.range, ...parseDiffStat(r.diff) } : null);
  const [b, c] = await Promise.all([
    cardBoardRangeDiff(runGit, board, cardId).catch(() => ({ ok: false as const, error: "erro" })),
    grepStagedCodeRangeDiff(runGit, cardId).catch(() => ({ ok: false as const, error: "erro" })),
  ]);
  return { board: toPart(b), code: toPart(c) };
}

/**
 * The diff base = the parent of the card's EARLIEST commit. Falls back to the
 * empty-tree SHA when that commit is the repo root (its `^` doesn't resolve — git
 * rejects, or `--quiet` returns empty).
 */
async function resolveRangeBase(runGit: GitRunner, earliest: string): Promise<string> {
  try {
    const parent = (await runGit(["rev-parse", "--verify", "--quiet", `${earliest}^`])).trim();
    return parent || EMPTY_TREE_SHA;
  } catch {
    return EMPTY_TREE_SHA;
  }
}

/**
 * Count added/removed lines in a unified `git diff`, EXCLUDING the file headers
 * (`+++`/`---`) and hunk markers. A real content line is a single leading `+`/`-`
 * NOT immediately followed by another `+`/`-` (which would be the `+++`/`---` header).
 */
export function parseDiffStat(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Parse the +/− totals from `git diff --shortstat` output, e.g.
 * ` 3 files changed, 42 insertions(+), 15 deletions(-)`. Either clause may be absent
 * (a pure-add or pure-delete diff omits the other; the singular forms drop the `s`),
 * and an empty string (no changes) yields zeroes. Lets the idle card footer pull ONLY
 * the totals via `--shortstat` instead of the whole diff (up to 10 MB) per card. Pure →
 * node-unit-testable.
 */
export function parseShortstat(out: string): { additions: number; deletions: number } {
  const ins = /(\d+)\s+insertion/.exec(out);
  const del = /(\d+)\s+deletion/.exec(out);
  return {
    additions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** Default ceiling on how many diff lines the modal renders at once (one <div> per line). */
export const DIFF_RENDER_LINE_CAP = 2000;

/**
 * Cap the diff lines the modal mounts as DOM — the server action allows up to a 10 MB
 * diff, which split per-line could be 100k+ <div>s and freeze the (mobile) browser on
 * open. Splits the diff, returns the first `max` lines + the hidden count so the modal
 * can show a "+N linhas ocultas" banner. Pure → node-unit-testable.
 */
export function capDiffLines(
  diff: string,
  max: number = DIFF_RENDER_LINE_CAP,
): { lines: string[]; hidden: number } {
  const all = diff.split("\n");
  if (all.length <= max) return { lines: all, hidden: 0 };
  return { lines: all.slice(0, max), hidden: all.length - max };
}
