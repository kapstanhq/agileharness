import { describe, expect, it } from "vitest";
import { parseCreatedFrom, resolveRunBase, runOwnWork, sessionIdFromBranch } from "./run-base";
import type { ExecFn } from "./worktree";

const CUT = "243d9f5e78259b0dc99b9ad1e68b83d339613c1e";
const SID = "86689cd8-09a3-40ad-b2fb-c43005e34576";

describe("sessionIdFromBranch — only our run branches reach a git command line", () => {
  it("extracts the uuid from failed/conflicted/orphan run refs", () => {
    expect(sessionIdFromBranch(`failed/run/${SID}`)).toBe(SID);
    expect(sessionIdFromBranch(`conflicted/run/${SID}`)).toBe(SID);
    expect(sessionIdFromBranch(`run/${SID}`)).toBe(SID);
  });
  it("rejects a foreign / injected ref name", () => {
    expect(sessionIdFromBranch("failed/run/not-a-uuid; rm -rf /")).toBeNull();
    expect(sessionIdFromBranch("main")).toBeNull();
  });
});

describe("parseCreatedFrom — the LAST 'Created from' is the branch's creation", () => {
  it("reads the cut point even after a rename prepended newer entries", () => {
    const reflog = [
      `92a4ade6f failed/run/${SID}@{1}: commit: usm(harness-fix): x`,
      `243d9f5e7 failed/run/${SID}@{2}: branch: Created from ${CUT}`,
    ].join("\n");
    expect(parseCreatedFrom(reflog)).toBe(CUT);
  });
  it("returns null when there is no creation record", () => {
    expect(parseCreatedFrom("92a4ade6f x@{0}: commit: y")).toBeNull();
  });
});

/** Fake git over the injected exec. Probes throw to express their negative answer, like real git. */
const exec = (responses: Record<string, string>, missing: string[] = []) =>
  (async (cmd: string) => {
    if (missing.some((m) => cmd.includes(m))) throw Object.assign(new Error("git said no"), { code: 1 });
    const key = Object.keys(responses).find((k) => cmd.includes(k));
    return { stdout: key === undefined ? "" : responses[key], stderr: "" };
  }) as unknown as ExecFn;

describe("resolveRunBase — reflog first (exact), fork-point as an estimate", () => {
  it("prefers the reflog cut point", async () => {
    const r = await resolveRunBase(
      exec({ "reflog show": `x @{1}: branch: Created from ${CUT}`, "rev-parse --verify": `${CUT}\n` }),
      "/repo",
      `failed/run/${SID}`,
    );
    expect(r).toEqual({ base: CUT, provenance: "reflog" });
  });

  it("falls back to the fork point vs stage when the reflog expired", async () => {
    const r = await resolveRunBase(
      exec({ "merge-base": `${CUT}\n` }, ["reflog show"]),
      "/repo",
      `failed/run/${SID}`,
      { stageBranch: "stage" },
    );
    expect(r).toEqual({ base: CUT, provenance: "fork-point" });
  });

  it("is 'none' when nothing resolves — the caller must fail closed", async () => {
    const r = await resolveRunBase(exec({}, ["reflog show", "merge-base"]), "/repo", `failed/run/${SID}`);
    expect(r.provenance).toBe("none");
    expect(r.base).toBe("");
  });

  it("does not trust a reflog sha that no longer resolves to a commit", async () => {
    const r = await resolveRunBase(
      exec({ "reflog show": `x @{1}: branch: Created from ${CUT}`, "merge-base": `${CUT}\n` }, ["rev-parse --verify"]),
      "/repo",
      `failed/run/${SID}`,
      { stageBranch: "stage" },
    );
    expect(r.provenance).toBe("fork-point"); // reflog sha unverifiable → estimate, not a false exact
  });
});

describe("runOwnWork — base..branch (two-dot), and a failure is not an empty result", () => {
  it("counts the run's own commits + files above the cut point", async () => {
    const w = await runOwnWork(
      exec({ "rev-list --count": "2\n", "diff --name-only": "a.ts\nstorymap/boards/b/cards/c.md\n" }),
      "/repo",
      `failed/run/${SID}`,
      CUT,
    );
    expect(w).toEqual({ commits: 2, files: ["a.ts", "storymap/boards/b/cards/c.md"] });
  });

  it("returns null (not zero) when the diff read fails — fail closed", async () => {
    const w = await runOwnWork(
      exec({ "rev-list --count": "2\n" }, ["diff --name-only"]),
      "/repo",
      `failed/run/${SID}`,
      CUT,
    );
    expect(w).toBeNull();
  });

  it("returns null with no base (nothing to measure against)", async () => {
    expect(await runOwnWork(exec({}), "/repo", `failed/run/${SID}`, "")).toBeNull();
  });
});
