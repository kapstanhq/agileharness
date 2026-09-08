// 🔒 License guard — the @blocknote/xl-* packages are GPL/AGPL-family (dual-licensed commercial)
// and MUST NOT enter this repo (core/react/mantine are MPL-2.0, which is fine). A transitive dep
// can slip in through the LOCKFILE without ever appearing in package.json, so both are scanned.
// The merge-train gate (full suite, fail-closed) makes this test the enforcement point.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BANNED = /@blocknote\/xl-/;

describe("license guard", () => {
  it("package.json has no @blocknote/xl-* dependency", () => {
    const pkg = readFileSync(join(__dirname, "../../../../package.json"), "utf8");
    expect(BANNED.test(pkg)).toBe(false);
  });

  it("root lockfile has no @blocknote/xl-* entry", () => {
    const lock = readFileSync(join(__dirname, "../../../../../../bun.lock"), "utf8");
    expect(BANNED.test(lock)).toBe(false);
  });
});
