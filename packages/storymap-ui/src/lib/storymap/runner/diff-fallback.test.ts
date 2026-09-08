import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TREE_SHA,
  cardBoardRangeDiff,
  cardCommitGrep,
  cardCumulativeDiff,
  commitRangeDiff,
  grepCardCommitRangeDiff,
  grepStagedCodeRangeDiff,
  snapshotRangeDiff,
  type GitRunner,
} from "./diff";

// SM-05: the durable diff fallback. When a card's run branch is gone (merged +
// deleted) and there's no diffSnapshot, the card's change is still reconstructable
// from the `· <board>/<cardId>` subject convention every harness-* commit carries. These
// tests drive `grepCardCommitRangeDiff` with an INJECTED git runner — no real git —
// so the range math + the friendly empty case are unit-testable in the node env
// (the server action `getCardRunDiffAction` can't be: it's a "use server" module).

/** Build a fake GitRunner from a router keyed by the git subcommand (argv[0]). */
function fakeGit(handlers: Partial<Record<string, (args: string[]) => Promise<string> | string>>): {
  run: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: GitRunner = async (args) => {
    calls.push(args);
    const h = handlers[args[0]];
    if (!h) throw new Error(`unexpected git ${args.join(" ")}`);
    return h(args);
  };
  return { run, calls };
}

describe("cardCommitGrep", () => {
  it("builds the `· <board>/<cardId>` subject pattern", () => {
    expect(cardCommitGrep("storymap", "story-sm-05-commit-range")).toBe(
      "· storymap/story-sm-05-commit-range",
    );
  });
});

describe("grepCardCommitRangeDiff (SM-05 fallback)", () => {
  it("AC2: greps the card's commits, derives <first>^..<last> and returns the diff", async () => {
    const { run, calls } = fakeGit({
      // --reverse → oldest first; three commits for this card
      log: () => "aaa111\nbbb222\nccc333\n",
      "rev-parse": () => "aaa000\n", // parent of the earliest commit
      diff: () => "diff --git a/x b/x\n+added\n-removed\n",
    });

    const res = await grepCardCommitRangeDiff(run, "storymap", "story-x");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // base = parent of the EARLIEST (aaa111), head = the LATEST (ccc333)
    expect(res.range).toEqual({ base: "aaa000", head: "ccc333" });
    expect(res.diff).toContain("+added");

    // grep used the card-id convention; diff ran over base..head
    const logCall = calls.find((c) => c[0] === "log")!;
    expect(logCall).toContain("--grep=· storymap/story-x");
    expect(logCall).toContain("--reverse");
    const diffCall = calls.find((c) => c[0] === "diff")!;
    expect(diffCall).toContain("aaa000..ccc333");
  });

  it("AC4: returns a friendly message (and runs NO diff) when no commit matches", async () => {
    const { run, calls } = fakeGit({
      log: () => "", // nothing carries this card-id
      diff: () => {
        throw new Error("diff must not run when there are no commits");
      },
    });

    const res = await grepCardCommitRangeDiff(run, "storymap", "ghost");

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/nenhum commit encontrado/i);
    expect(res.error).not.toMatch(/branch|stack/i); // not confused with a branch error
    expect(calls.some((c) => c[0] === "diff")).toBe(false);
  });

  it("falls back to the empty-tree SHA when the earliest commit is the repo root", async () => {
    const revParse = vi.fn(async () => {
      // `git rev-parse --verify --quiet <root>^` exits non-zero → execFile rejects
      throw new Error("fatal: bad revision");
    });
    const { run } = fakeGit({
      log: () => "root111\n",
      "rev-parse": (args) => revParse(),
      diff: () => "diff body\n",
    });

    const res = await grepCardCommitRangeDiff(run, "storymap", "story-root");

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.range.base).toBe(EMPTY_TREE_SHA);
    expect(res.range.head).toBe("root111");
    expect(revParse).toHaveBeenCalled();
  });
});

describe("commitRangeDiff (preferred durable source)", () => {
  it("diffs <base>..<head> and returns the range + diff", async () => {
    const { run, calls } = fakeGit({
      diff: () => "diff --git a/x b/x\n+added line\n-removed line\n",
    });

    const res = await commitRangeDiff(run, { base: "base0sha", head: "head9sha" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.range).toEqual({ base: "base0sha", head: "head9sha" });
    expect(res.diff).toContain("+added line");
    // diffed exactly the review-stamped base..head — NOT a merge commit (which a later
    // trivial run would have overwritten on diffSnapshot).
    const diffCall = calls.find((c) => c[0] === "diff")!;
    expect(diffCall).toContain("base0sha..head9sha");
  });

  it("returns ok:false and runs NO git when the range is missing", async () => {
    const { run, calls } = fakeGit({
      diff: () => {
        throw new Error("diff must not run without a commitRange");
      },
    });

    const res = await commitRangeDiff(run, null);

    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("returns ok:false (no git) when the range is half-written (missing a SHA)", async () => {
    const { run, calls } = fakeGit({
      diff: () => {
        throw new Error("diff must not run on a half range");
      },
    });

    // base present but head blank → incomplete, falls through (caller tries snapshot next).
    const res = await commitRangeDiff(run, { base: "base0sha", head: "  " });

    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("snapshotRangeDiff (SM-04 fallback)", () => {
  it("AC2: diffs <base>..<mergeCommit> and returns the range + diff", async () => {
    const { run, calls } = fakeGit({
      diff: () => "diff --git a/x b/x\n+added line\n-removed line\n",
    });

    const res = await snapshotRangeDiff(run, { base: "base0sha", mergeCommit: "merge9sha" });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.range).toEqual({ base: "base0sha", head: "merge9sha" });
    expect(res.diff).toContain("+added line");
    // diffed exactly the persisted base..mergeCommit range (the precise merge commit).
    const diffCall = calls.find((c) => c[0] === "diff")!;
    expect(diffCall).toContain("base0sha..merge9sha");
  });

  it("returns ok:false and runs NO git when the snapshot is missing", async () => {
    const { run, calls } = fakeGit({
      diff: () => {
        throw new Error("diff must not run without a snapshot");
      },
    });

    const res = await snapshotRangeDiff(run, undefined);

    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("returns ok:false (no git) when the snapshot is half-written (missing a SHA)", async () => {
    const { run, calls } = fakeGit({
      diff: () => {
        throw new Error("diff must not run on a half snapshot");
      },
    });

    // mergeCommit present but base blank → incomplete, falls through (caller greps next).
    const res = await snapshotRangeDiff(run, { base: "   ", mergeCommit: "merge9sha" });

    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});

describe("grepStagedCodeRangeDiff (cumulative staged code on `stage`)", () => {
  it("greps the card's `código staged` commits on stage, derives the range, diffs packages/", async () => {
    const { run, calls } = fakeGit({
      log: () => "c1\nc2\n",
      "rev-parse": () => "c0\n",
      diff: () => "diff --git a/packages/x b/packages/x\n+code\n",
    });
    const res = await grepStagedCodeRangeDiff(run, "story-x");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.range).toEqual({ base: "c0", head: "c2" });
    const logCall = calls.find((c) => c[0] === "log")!;
    expect(logCall).toContain("stage");
    expect(logCall).toContain("-F"); // fixed-strings for the literal () in the message
    expect(logCall).toContain("--grep=usm(story-x): código staged");
    const diffCall = calls.find((c) => c[0] === "diff")!;
    expect(diffCall).toContain("c0..c2");
    expect(diffCall).toContain("packages/");
  });

  it("ok:false (and runs NO diff) when the card has no staged code yet", async () => {
    const { run, calls } = fakeGit({ log: () => "\n" });
    const res = await grepStagedCodeRangeDiff(run, "ghost");
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c[0] === "diff")).toBe(false);
  });
});

describe("cardBoardRangeDiff (cumulative board-data, PATH-based)", () => {
  it("selects the card's board files by PATH (not message-grep), derives the range, diffs them", async () => {
    const { run, calls } = fakeGit({
      log: () => "b1\nb2\nb3\n",
      "rev-parse": () => "b0\n",
      diff: () => "diff --git a/...cards/story-x.md b/...cards/story-x.md\n+narrativa\n",
    });
    const res = await cardBoardRangeDiff(run, "storymap", "story-x");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.range).toEqual({ base: "b0", head: "b3" });
    const logCall = calls.find((c) => c[0] === "log")!;
    // NO --grep — selection is by path: the card .md + plan + wireframe sidecars.
    expect(logCall.some((a) => a.startsWith("--grep="))).toBe(false);
    expect(logCall).toContain("storymap/boards/storymap/cards/story-x.md");
    expect(logCall).toContain("storymap/boards/storymap/plans/story-x.md");
    const diffCall = calls.find((c) => c[0] === "diff")!;
    expect(diffCall).toContain("b0..b3");
    expect(diffCall).toContain("storymap/boards/storymap/cards/story-x.md");
  });

  it("ok:false (runs NO diff) when the card has no board commits", async () => {
    const { run, calls } = fakeGit({ log: () => "\n" });
    const res = await cardBoardRangeDiff(run, "storymap", "ghost");
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c[0] === "diff")).toBe(false);
  });
});

describe("cardCumulativeDiff (board + code, all stages)", () => {
  it("combines the board range (main) + the code range (stage) into two parts", async () => {
    const { run } = fakeGit({
      log: (args) => {
        const grep = args.find((a) => a.startsWith("--grep=")) ?? "";
        return grep.includes("código staged") ? "k1\nk2\n" : "b1\nb2\nb3\n";
      },
      "rev-parse": (args) => (args.some((a) => a.includes("k1")) ? "k0\n" : "b0\n"),
      diff: (args) => (args.some((a) => a.includes("k0..k2")) ? "+code line\n" : "+board line\n"),
    });
    const res = await cardCumulativeDiff(run, "storymap", "story-x");
    expect(res.board).toMatchObject({ range: { base: "b0", head: "b3" }, additions: 1 });
    expect(res.board?.diff).toContain("board line");
    expect(res.code).toMatchObject({ range: { base: "k0", head: "k2" }, additions: 1 });
    expect(res.code?.diff).toContain("code line");
  });

  it("code is null when nothing is staged yet (board-only card)", async () => {
    const { run } = fakeGit({
      log: (args) => ((args.find((a) => a.startsWith("--grep="))?.includes("código staged")) ? "" : "b1\n"),
      "rev-parse": () => "b0\n",
      diff: () => "+board\n",
    });
    const res = await cardCumulativeDiff(run, "storymap", "story-y");
    expect(res.board).not.toBeNull();
    expect(res.code).toBeNull();
  });
});
