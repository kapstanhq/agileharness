import { describe, expect, it } from "vitest";
import {
  isSuperseded,
  listPreservedRunBranches,
  needsAttention,
  reasonFor,
  verdictFor,
  type BaseProvenance,
  type PreservedVerdict,
} from "./preserved-branches";

const facts = (over: Partial<Parameters<typeof verdictFor>[0]> = {}) => ({
  ancestorOfHead: false,
  ownCommits: 1,
  touchesCode: false,
  codeIdenticalToHead: false,
  cardExists: true,
  cardTerminal: false,
  redriven: false,
  ...over,
});

describe("verdictFor — what a preserved branch actually holds", () => {
  it("an ancestor of HEAD is integrated (its work landed via another path)", () => {
    expect(verdictFor(facts({ ancestorOfHead: true, touchesCode: true }))).toBe("integrated");
  });

  it("no commits of its own → integrated (the run wrote nothing; the rest is inherited history)", () => {
    expect(verdictFor(facts({ ownCommits: 0 }))).toBe("integrated");
  });

  it("board-data only + the card shipped/terminal → a stale board transition", () => {
    expect(verdictFor(facts({ cardTerminal: true }))).toBe("stale-board-data");
    expect(verdictFor(facts({ cardExists: false }))).toBe("stale-board-data");
  });

  it("board-data only + the card still live → a look, not a blockage", () => {
    expect(verdictFor(facts())).toBe("live-board-data");
  });

  it("the run's OWN code, absent from HEAD → unintegrated-code (the real thing)", () => {
    expect(verdictFor(facts({ touchesCode: true }))).toBe("unintegrated-code");
  });

  it("code that reached main by CHERRY-PICK is integrated — content acquits what sha/patch-id cannot", () => {
    // The exact shape that kept failed/run/86689cd8 in the attention panel: no ancestry (new sha) and
    // no patch-id match (rebased context) — while the content sits right there in HEAD.
    expect(verdictFor(facts({ touchesCode: true, codeIdenticalToHead: true }))).toBe("integrated");
  });

  it("an unresolvable base fails CLOSED — never 'safe' by accident", () => {
    expect(verdictFor(facts({ ownCommits: null }))).toBe("unknown");
  });

  it("a conflicted snapshot of a FINISHED card is superseded-by-redrive, not unintegrated", () => {
    // The train re-drives every conflict; a conflicted branch whose card reached terminal is the
    // losing attempt of a redrive that already landed a solution — safe to harvest, never an alarm.
    expect(verdictFor(facts({ redriven: true, touchesCode: true, cardTerminal: true }))).toBe("superseded-by-redrive");
    expect(verdictFor(facts({ redriven: true, touchesCode: true, cardExists: false }))).toBe("superseded-by-redrive");
  });

  it("a conflicted snapshot of a LIVE card stays unintegrated-code (a look), not superseded", () => {
    expect(verdictFor(facts({ redriven: true, touchesCode: true, cardTerminal: false }))).toBe("unintegrated-code");
  });
});

describe("isSuperseded / needsAttention — two DIFFERENT questions", () => {
  const cases: Array<[PreservedVerdict, BaseProvenance, boolean, boolean]> = [
    // verdict, provenance, superseded (safe to discard), needsAttention (TRAVADO)
    ["integrated", "reflog", true, false],
    ["stale-board-data", "reflog", true, false],
    ["live-board-data", "reflog", false, false], // not auto-discardable, but nothing is stuck
    ["superseded-by-redrive", "reflog", true, false], // the redrive landed; snapshot is safe to discard
    ["unintegrated-code", "reflog", false, true], // the only travado
    ["unknown", "none", false, true], // fail closed
  ];
  it.each(cases)("%s (%s) → superseded=%s needsAttention=%s", (verdict, prov, superseded, attention) => {
    expect(isSuperseded(verdict)).toBe(superseded);
    expect(needsAttention(verdict, prov)).toBe(attention);
  });

  it("an ESTIMATED base (expired reflog) never escalates to TRAVADO — a guess must not cry wolf", () => {
    expect(needsAttention("unintegrated-code", "fork-point")).toBe(false);
    expect(reasonFor("unintegrated-code", "fork-point", 3)).toContain("ESTIMADA");
  });

  it("a conflicted branch never alarms — its own merge-queue entry is the alarm, not the snapshot", () => {
    expect(needsAttention("unintegrated-code", "reflog", /* redriven */ true)).toBe(false);
  });

  it("a failed run of a CONCLUDED card never alarms — the card shipped, this is a non-winning attempt", () => {
    // The winning code is in main via a DIFFERENT run; this snapshot's own code is off-main but PRESERVED
    // (branch-gc won't delete un-integrated code). It belongs in the archive's review bucket, not Travados.
    // Regression: 2026-07-23 acme/story-tlz0dt (`concluida`) showed two such snapshots as "recuperar ou
    // descartar" while "listagem prioriza salvos/alta-afinidade" was already in production.
    expect(needsAttention("unintegrated-code", "reflog", /* redriven */ false, /* cardTerminal */ true)).toBe(false);
    // sanity: the SAME branch on a card still in flight DOES alarm (its code may be genuinely needed).
    expect(needsAttention("unintegrated-code", "reflog", false, /* cardTerminal */ false)).toBe(true);
  });
});

describe("listPreservedRunBranches — the run's OWN work, via git's record of the cut point", () => {
  const SID = "86689cd8-09a3-40ad-b2fb-c43005e34576";
  const BRANCH = `failed/run/${SID}`;
  const CUT = "243d9f5e78259b0dc99b9ad1e68b83d339613c1e";

  /** A fake git: `responses` matches on a substring of the command. The exit-code-carrying probes
   *  (`--is-ancestor`, `--quiet`) THROW to express their negative answer, exactly like git. */
  const exec = (responses: Record<string, string>, opts: { ancestor?: boolean; identical?: boolean } = {}) =>
    (async (cmd: string) => {
      if (cmd.includes("merge-base --is-ancestor")) {
        if (opts.ancestor) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("diff --quiet")) {
        if (opts.identical) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("differs"), { code: 1 });
      }
      const key = Object.keys(responses).find((k) => cmd.includes(k));
      return { stdout: key === undefined ? "" : responses[key], stderr: "" };
    }) as unknown as import("./worktree").ExecFn;

  // The REAL failed/run/86689cd8: cut from stage at 243d9f5e, its own commit touching ONE card .md.
  // Everything else on the branch is stage history it inherited — which main already carries.
  const REAL = {
    "for-each-ref": `${BRANCH}\n`,
    "reflog show": [
      `92a4ade6f ${BRANCH}@{1}: commit: usm(harness-fix): acme/story-ny4v26 [run ${SID}]`,
      `243d9f5e7 ${BRANCH}@{2}: branch: Created from ${CUT}`,
    ].join("\n"),
    "rev-parse --verify": `${CUT}\n`,
    "log -1": "usm(harness-fix): acme/story-ny4v26|7 days ago",
    "rev-list --count": "1\n",
    "diff --name-only": "storymap/boards/acme/cards/story-ny4v26.md\n",
  };

  it("measures base..branch from the reflog cut point — the stage code it INHERITED is not its work", async () => {
    const [b] = await listPreservedRunBranches({
      exec: exec(REAL),
      repoRoot: "/repo",
      liveRunIds: async () => [],
      stageBranch: "stage",
      cardStatus: async () => ({ status: "concluida", title: "Notar eventos", terminal: true }),
    });
    expect(b.baseProvenance).toBe("reflog");
    expect(b.ownCommits).toBe(1);
    expect(b.touchesCode).toBe(false); // ← the whole bug: this used to be TRUE (7 inherited files)
    expect(b.verdict).toBe("stale-board-data");
    expect(b.needsAttention).toBe(false); // ← and that parked it in "Travados" for a week
    expect(b.superseded).toBe(true);
    expect(b.recoverHint).toContain(`${CUT}..${BRANCH}`);
  });

  it("a run whose OWN commit carries code, absent from HEAD, IS travado", async () => {
    const [b] = await listPreservedRunBranches({
      exec: exec({
        ...REAL,
        "diff --name-only": "packages/storymap-ui/src/lib/foo.ts\nstorymap/boards/storymap/cards/story-y.md\n",
      }),
      repoRoot: "/repo",
      liveRunIds: async () => [],
      cardStatus: async () => ({ status: "desenvolver", title: "Y", terminal: false }),
    });
    expect(b.verdict).toBe("unintegrated-code");
    expect(b.needsAttention).toBe(true);
    expect(b.touchesCode).toBe(true);
    expect(b.reason).toContain("1 arquivo(s) de código");
  });

  it("…but not when that same code is byte-identical in HEAD (it was cherry-picked)", async () => {
    const [b] = await listPreservedRunBranches({
      exec: exec({ ...REAL, "diff --name-only": "packages/storymap-ui/src/lib/foo.ts\n" }, { identical: true }),
      repoRoot: "/repo",
      liveRunIds: async () => [],
      cardStatus: async () => null,
    });
    expect(b.verdict).toBe("integrated");
    expect(b.needsAttention).toBe(false);
  });

  it("falls back to the fork point when the reflog expired, and REFUSES to escalate on that guess", async () => {
    const { "reflog show": _expired, ...noReflog } = REAL;
    const [b] = await listPreservedRunBranches({
      exec: exec({
        ...noReflog,
        "merge-base": `${CUT}\n`,
        "diff --name-only": "packages/storymap-ui/src/lib/inherited.ts\n",
      }),
      repoRoot: "/repo",
      liveRunIds: async () => [],
      stageBranch: "stage",
      cardStatus: async () => null,
    });
    expect(b.baseProvenance).toBe("fork-point");
    expect(b.verdict).toBe("unintegrated-code");
    expect(b.needsAttention).toBe(false); // an estimate never cries wolf…
    expect(b.superseded).toBe(false); // …but it is not called safe either
  });

  it("a git failure reads as UNKNOWN (fail closed), never as an empty/safe branch", async () => {
    const brokenGit = (async (cmd: string) => {
      if (cmd.includes("for-each-ref")) return { stdout: `${BRANCH}\n`, stderr: "" };
      if (cmd.includes("reflog show")) return { stdout: REAL["reflog show"], stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: `${CUT}\n`, stderr: "" };
      if (cmd.includes("rev-list --count")) return { stdout: "3\n", stderr: "" };
      if (cmd.includes("diff --name-only")) throw new Error("git exploded"); // ← cannot read the delta
      if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("no"), { code: 1 });
      return { stdout: "", stderr: "" };
    }) as unknown as import("./worktree").ExecFn;

    const [b] = await listPreservedRunBranches({
      exec: brokenGit,
      repoRoot: "/repo",
      liveRunIds: async () => [],
      cardStatus: async () => null,
    });
    expect(b.verdict).toBe("unknown");
    expect(b.needsAttention).toBe(true);
    expect(b.superseded).toBe(false);
  });

  it("excludes a run/* branch still on the merge train (not an orphan)", async () => {
    const live = "11111111-1111-4111-8111-111111111111";
    const orphan = "22222222-2222-4222-8222-222222222222";
    const out = await listPreservedRunBranches({
      exec: exec({ ...REAL, "for-each-ref": `run/${live}\nrun/${orphan}\n` }),
      repoRoot: "/repo",
      liveRunIds: async () => [live],
      cardStatus: async () => ({ status: "concluida", title: "X", terminal: true }),
    });
    expect(out.map((b) => b.branch)).toEqual([`run/${orphan}`]);
    expect(out[0].kind).toBe("orphan");
  });

  it("ignores a ref that is not a run branch (a foreign name never reaches a git command line)", async () => {
    const out = await listPreservedRunBranches({
      exec: exec({ ...REAL, "for-each-ref": "failed/run/not-a-uuid; rm -rf /\n" }),
      repoRoot: "/repo",
      liveRunIds: async () => [],
      cardStatus: async () => null,
    });
    expect(out).toEqual([]);
  });

  it("puts what needs a human first", async () => {
    const stuck = "33333333-3333-4333-8333-333333333333";
    const safe = "44444444-4444-4444-8444-444444444444";
    const out = await listPreservedRunBranches({
      exec: (async (cmd: string) => {
        if (cmd.includes("for-each-ref")) return { stdout: `failed/run/${safe}\nfailed/run/${stuck}\n`, stderr: "" };
        if (cmd.includes("merge-base --is-ancestor")) throw Object.assign(new Error("no"), { code: 1 });
        if (cmd.includes("diff --quiet")) throw Object.assign(new Error("differs"), { code: 1 });
        if (cmd.includes("reflog show")) return { stdout: `x @{1}: branch: Created from ${CUT}`, stderr: "" };
        if (cmd.includes("rev-parse --verify")) return { stdout: `${CUT}\n`, stderr: "" };
        if (cmd.includes("rev-list --count")) return { stdout: "1\n", stderr: "" };
        if (cmd.includes("diff --name-only")) {
          return cmd.includes(stuck)
            ? { stdout: "packages/app/src/x.ts\n", stderr: "" }
            : { stdout: "storymap/boards/b/cards/c.md\n", stderr: "" };
        }
        if (cmd.includes("log -1")) return { stdout: "s|1 day ago", stderr: "" };
        return { stdout: "", stderr: "" };
      }) as unknown as import("./worktree").ExecFn,
      repoRoot: "/repo",
      liveRunIds: async () => [],
      cardStatus: async () => ({ status: "concluida", title: "C", terminal: true }),
    });
    expect(out[0].sessionId).toBe(stuck);
    expect(out[0].needsAttention).toBe(true);
    expect(out[1].needsAttention).toBe(false);
  });
});
