import { describe, expect, it } from "vitest";
import { detectSystemDrift, parseOnelineLog, SHA_RE, type GitRunner } from "./system-drift";
import type { SystemDef } from "./types";

const sys = (over: Partial<SystemDef>): SystemDef => ({ id: "s", name: "S", ...over });

/** A canned git: rev-parse → head; log → the mapped output for that `<base>..HEAD` range (or throw). */
function fakeGit(opts: { head: string; logs?: Record<string, string>; throwFor?: string[] }): GitRunner {
  return async (args) => {
    if (args[0] === "rev-parse") return `${opts.head}\n`;
    if (args[0] === "log") {
      const range = args[2]; // ["log","--oneline","<base>..HEAD","--",...paths]
      if (opts.throwFor?.includes(range)) throw new Error("fatal: bad revision");
      return opts.logs?.[range] ?? "";
    }
    return "";
  };
}

describe("SHA_RE — guards the base ref fed to git", () => {
  it("accepts 7–40 hex chars; rejects anything else", () => {
    expect(SHA_RE.test("abc1234")).toBe(true);
    expect(SHA_RE.test("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(SHA_RE.test("abc12")).toBe(false); // too short
    expect(SHA_RE.test("HEAD~3")).toBe(false);
    expect(SHA_RE.test("main; rm -rf /")).toBe(false);
    expect(SHA_RE.test("")).toBe(false);
  });
});

describe("parseOnelineLog", () => {
  it("parses sha + subject, drops blank lines", () => {
    expect(parseOnelineLog("abc123 fix the engine\n\ndef456 refactor lock\n")).toEqual([
      { sha: "abc123", subject: "fix the engine" },
      { sha: "def456", subject: "refactor lock" },
    ]);
  });
  it("tolerates a sha with no subject + empty output", () => {
    expect(parseOnelineLog("abc123\n")).toEqual([{ sha: "abc123", subject: "" }]);
    expect(parseOnelineLog("")).toEqual([]);
  });
});

describe("detectSystemDrift", () => {
  it("flags a system whose code changed since syncedCommit (with the commits as the WHY)", async () => {
    const systems = [sys({ id: "engine", name: "Engine", paths: ["a.ts"], syncedCommit: "abc1234", prompt: "old" })];
    const git = fakeGit({ head: "def5678", logs: { "abc1234..HEAD": "c1aaaa muda engine\nc2bbbb refactor" } });
    const { head, drift } = await detectSystemDrift("/repo", systems, git);
    expect(head).toBe("def5678");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ systemId: "engine", name: "Engine", prompt: "old" });
    expect(drift[0].commits).toEqual([
      { sha: "c1aaaa", subject: "muda engine" },
      { sha: "c2bbbb", subject: "refactor" },
    ]);
  });

  it("does NOT flag a system whose paths had no commits since syncedCommit", async () => {
    const systems = [sys({ id: "engine", paths: ["a.ts"], syncedCommit: "abc1234" })];
    const git = fakeGit({ head: "def5678", logs: { "abc1234..HEAD": "" } });
    expect((await detectSystemDrift("/repo", systems, git)).drift).toEqual([]);
  });

  it("skips UNANCHORED systems: no paths, no syncedCommit, or a non-SHA base", async () => {
    const systems = [
      sys({ id: "a", paths: [], syncedCommit: "abc1234" }), // no paths
      sys({ id: "b", paths: ["x.ts"] }), // no syncedCommit
      sys({ id: "c", paths: ["x.ts"], syncedCommit: "HEAD~2" }), // not a sha
    ];
    const git = fakeGit({ head: "def5678", logs: { "abc1234..HEAD": "z1 x", "HEAD~2..HEAD": "z1 x" } });
    expect((await detectSystemDrift("/repo", systems, git)).drift).toEqual([]);
  });

  it("skips a system already at HEAD (syncedCommit === head) — cannot have drifted", async () => {
    const systems = [sys({ id: "engine", paths: ["a.ts"], syncedCommit: "abc1234" })];
    const git = fakeGit({ head: "abc1234", logs: { "abc1234..HEAD": "should-not-be-read" } });
    expect((await detectSystemDrift("/repo", systems, git)).drift).toEqual([]);
  });

  it("marks baseInvalid (no commits) when the base SHA no longer resolves", async () => {
    const systems = [sys({ id: "engine", name: "Engine", paths: ["a.ts"], syncedCommit: "abc1234", prompt: "p" })];
    const git = fakeGit({ head: "def5678", throwFor: ["abc1234..HEAD"] });
    const { drift } = await detectSystemDrift("/repo", systems, git);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ systemId: "engine", baseInvalid: true, commits: [] });
  });
});
