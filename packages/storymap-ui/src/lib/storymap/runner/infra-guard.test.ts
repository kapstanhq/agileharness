import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";

// C1 regression tripwire (2026-07-08): the npm package `just-install` ships a bin named `just`.
// Hoisted to node_modules/.bin it shadows the system just for every process whose PATH carries
// node_modules/.bin prepends (the storymap service, hence every autorun spawn) — and its Linux
// failure mode is a SILENT exit-0 no-op, which taught skills to hand-flip card status instead of
// using the sanctioned advance path. These guards fail the suite the moment the shim (or any
// package.json declaring it) comes back.
describe("infra guard — `just` must never be shadowed by a node_modules bin shim", () => {
  const repoRoot = findRepoRoot();

  it("node_modules/.bin carries no `just` shim", () => {
    const bin = path.join(repoRoot, "node_modules", ".bin");
    const shims = ["just", "just.exe", "just.cmd", "just.ps1", "just.bunx"].filter((name) =>
      existsSync(path.join(bin, name)),
    );
    expect(
      shims,
      `shim 'just' em node_modules/.bin — remova o pacote que o instala (ex.: just-install) e rode bun install (shims: ${shims.join(", ")})`,
    ).toEqual([]);
  });

  it("no package.json declares just-install", () => {
    const packagesDir = path.join(repoRoot, "packages");
    const manifests = [
      path.join(repoRoot, "package.json"),
      ...readdirSync(packagesDir).map((d) => path.join(packagesDir, d, "package.json")),
    ].filter(existsSync);
    const offenders = manifests.filter((file) => {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, string> | undefined>;
      return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
        (kind) => pkg[kind] && "just-install" in (pkg[kind] as Record<string, string>),
      );
    });
    expect(
      offenders,
      "just-install declarado — o shim `just` dele engole invocações em silêncio no Linux (C1); instale o just real na máquina em vez do pacote npm",
    ).toEqual([]);
  });
});
