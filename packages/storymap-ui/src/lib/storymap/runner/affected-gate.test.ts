import { describe, expect, it } from "vitest";
import { matchesGatePattern, resolveAffectedGate, type AffectedGateSpec } from "./affected-gate";

const FULL = "vitest run";
const spec = (over: Partial<AffectedGateSpec> = {}): AffectedGateSpec => ({
  enabled: true,
  command: "bunx vitest --changed {base} --run --passWithNoTests",
  fullSuitePaths: ["packages/storymap-ui/src/lib/storymap/types.ts", "**/package.json", "packages/storymap-ui/vitest.config.ts"],
  ...over,
});

describe("matchesGatePattern", () => {
  it("exact path", () => {
    expect(matchesGatePattern("a/b/types.ts", "a/b/types.ts")).toBe(true);
    expect(matchesGatePattern("a/b/types.ts", "a/b/other.ts")).toBe(false);
  });
  it("dir/ prefix matches the dir and everything under it", () => {
    expect(matchesGatePattern("a/b", "a/b/")).toBe(true);
    expect(matchesGatePattern("a/b/c/d.ts", "a/b/")).toBe(true);
    expect(matchesGatePattern("a/bc/d.ts", "a/b/")).toBe(false);
  });
  it("* does not cross a slash; ** does", () => {
    expect(matchesGatePattern("pkg/package.json", "**/package.json")).toBe(true);
    expect(matchesGatePattern("a/b/c/package.json", "**/package.json")).toBe(true);
    expect(matchesGatePattern("src/tsconfig.build.json", "src/tsconfig*.json")).toBe(true);
    expect(matchesGatePattern("src/deep/tsconfig.json", "src/tsconfig*.json")).toBe(false); // * stops at /
  });
});

describe("resolveAffectedGate", () => {
  it("disabled/absent spec → full suite, unchanged command", () => {
    expect(resolveAffectedGate(FULL, "sha1", ["x.ts"], undefined)).toMatchObject({ command: FULL, mode: "full" });
    expect(resolveAffectedGate(FULL, "sha1", ["x.ts"], spec({ enabled: false }))).toMatchObject({ command: FULL, mode: "full" });
  });

  it("command template missing {base} → full suite (misconfig, fail safe)", () => {
    const d = resolveAffectedGate(FULL, "sha1", ["x.ts"], spec({ command: "vitest run" }));
    expect(d.mode).toBe("full");
    expect(d.command).toBe(FULL);
  });

  it("no base sha → full suite", () => {
    expect(resolveAffectedGate(FULL, "", ["x.ts"], spec())).toMatchObject({ command: FULL, mode: "full" });
  });

  it("empty diff → full suite (never select zero by accident)", () => {
    expect(resolveAffectedGate(FULL, "sha1", [], spec())).toMatchObject({ command: FULL, mode: "full" });
    expect(resolveAffectedGate(FULL, "sha1", ["  ", ""], spec())).toMatchObject({ command: FULL, mode: "full" });
  });

  it("a blast-radius file forces the full suite and names the culprit", () => {
    const d = resolveAffectedGate(
      FULL,
      "sha1",
      ["packages/storymap-ui/src/lib/foo.ts", "packages/storymap-ui/src/lib/storymap/types.ts"],
      spec(),
    );
    expect(d.mode).toBe("full");
    expect(d.command).toBe(FULL);
    expect(d.reason).toContain("blast-radius");
    expect(d.reason).toContain("types.ts");
  });

  it("blast-radius via glob (**/package.json)", () => {
    const d = resolveAffectedGate(FULL, "sha1", ["packages/storymap-ui/package.json"], spec());
    expect(d.mode).toBe("full");
  });

  it("normal diff → affected command with {base} substituted", () => {
    const d = resolveAffectedGate(FULL, "abc123", ["packages/storymap-ui/src/lib/foo.ts"], spec());
    expect(d.mode).toBe("affected");
    expect(d.command).toBe("bunx vitest --changed abc123 --run --passWithNoTests");
    expect(d.command).not.toContain("{base}");
  });

  it("substitutes EVERY {base} occurrence", () => {
    const d = resolveAffectedGate(FULL, "abc", ["src/foo.ts"], spec({ command: "x --changed {base} --base {base}" }));
    expect(d.command).toBe("x --changed abc --base abc");
  });
});
