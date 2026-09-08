import { describe, expect, it } from "vitest";
import { capDiffLines, DIFF_RENDER_LINE_CAP, parseDiffStat, parseShortstat, runBranchName } from "./diff";

describe("runBranchName", () => {
  it("prefixes the session id with run/", () => {
    expect(runBranchName("abc-123")).toBe("run/abc-123");
  });
});

describe("parseDiffStat", () => {
  it("counts content +/- lines, excluding the +++/--- headers", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index 111..222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
    ].join("\n");
    expect(parseDiffStat(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("empty diff → zeroes", () => {
    expect(parseDiffStat("")).toEqual({ additions: 0, deletions: 0 });
  });

  it("a pure-addition new file", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");
    expect(parseDiffStat(diff)).toEqual({ additions: 2, deletions: 0 });
  });
});

describe("parseShortstat", () => {
  it("parses insertions and deletions from a full shortstat line", () => {
    expect(parseShortstat(" 3 files changed, 42 insertions(+), 15 deletions(-)\n")).toEqual({
      additions: 42,
      deletions: 15,
    });
  });

  it("handles a pure-addition shortstat (no deletions clause)", () => {
    expect(parseShortstat(" 1 file changed, 7 insertions(+)\n")).toEqual({ additions: 7, deletions: 0 });
  });

  it("handles a pure-deletion shortstat (no insertions clause)", () => {
    expect(parseShortstat(" 1 file changed, 4 deletions(-)\n")).toEqual({ additions: 0, deletions: 4 });
  });

  it("handles the singular forms (1 insertion(+), 1 deletion(-))", () => {
    expect(parseShortstat(" 1 file changed, 1 insertion(+), 1 deletion(-)\n")).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it("empty output (no changes) → zeroes", () => {
    expect(parseShortstat("")).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("capDiffLines", () => {
  it("returns all lines untouched when under the cap", () => {
    const diff = "a\nb\nc";
    expect(capDiffLines(diff, 10)).toEqual({ lines: ["a", "b", "c"], hidden: 0 });
  });

  it("caps the rendered lines and reports how many were hidden", () => {
    const diff = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const { lines, hidden } = capDiffLines(diff, 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("line 0");
    expect(hidden).toBe(40);
  });

  it("exactly at the cap hides nothing", () => {
    const diff = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    expect(capDiffLines(diff, 10).hidden).toBe(0);
  });

  it("defaults to the DIFF_RENDER_LINE_CAP ceiling", () => {
    const diff = Array.from({ length: DIFF_RENDER_LINE_CAP + 5 }, () => "x").join("\n");
    expect(capDiffLines(diff).hidden).toBe(5);
  });
});
