#!/usr/bin/env bun
// ADR-063 item 3c SCAFFOLD — pure discovery generator, dogfood on storymap-ui;
// artifact not yet consumed; see ADR-063 Fase 3.
//
// A build-time, PURE, deterministic generator that scans an App-Router package and
// emits a JSON artifact mapping route -> component-file -> data-testid registry, so a
// future QA planner reads route->component->testid WITHOUT re-deriving it per run.
//
// buildDiscovery is a PURE function (no fs, no Date.now, no Math.random) — the same
// {path,content}[] input always yields byte-identical output (routes + testids sorted).
// main() is the thin IO shell: read the app dir from disk, call buildDiscovery, write
// the artifact under storymap/qa-discovery/.
//
// Usage:  bun packages/storymap-ui/scripts/gen-qa-discovery.ts

import { promises as fs } from "node:fs";
import path from "node:path";

export interface RouteEntry {
  route: string;
  file: string;
  testids: string[];
}

export interface QaDiscovery {
  pkg: string;
  generatedFrom: string;
  routes: RouteEntry[];
  testids: string[];
}

const PAGE_FILE = /(?:^|\/)page\.(?:tsx|jsx|ts|js)$/;
// Match data-testid="..." and data-testid='...'; capture the literal value.
const TESTID_RE = /data-testid\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Normalize a file path to POSIX separators and strip any leading "./". */
function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Extract the app-router segments after the LAST `app/` boundary, sans the page file. */
function routeFromPagePath(p: string): string | null {
  const norm = normalize(p);
  if (!PAGE_FILE.test(norm)) return null;

  // Find the `app` segment that roots the router tree (e.g. src/app/... or app/...).
  const parts = norm.split("/");
  const appIdx = parts.lastIndexOf("app");
  if (appIdx === -1) return null;

  // Segments between `app/` and the trailing `page.*` file.
  const segments = parts.slice(appIdx + 1, -1).filter((seg) => {
    if (seg === "") return false;
    if (seg.startsWith("(") && seg.endsWith(")")) return false; // route group
    if (seg.startsWith("@")) return false; // parallel-route slot
    return true;
  });

  return "/" + segments.join("/");
}

/** Pull every data-testid literal from a file's content, deduped + sorted. */
function extractTestids(content: string): string[] {
  const found = new Set<string>();
  for (const m of content.matchAll(TESTID_RE)) {
    const value = m[1] ?? m[2];
    if (value) found.add(value);
  }
  return [...found].sort();
}

/**
 * PURE core: derive routes from app-router file paths (page.* -> route) and extract the
 * data-testid registry. Deterministic — routes sorted by route string, testids sorted,
 * both deduped. No side-effects, no clock, no randomness.
 */
export function buildDiscovery(
  pkg: string,
  files: { path: string; content: string }[],
): QaDiscovery {
  const routes: RouteEntry[] = [];
  const globalTestids = new Set<string>();

  for (const f of files) {
    const route = routeFromPagePath(f.path);
    if (route === null) continue;
    const testids = extractTestids(f.content);
    for (const t of testids) globalTestids.add(t);
    routes.push({ route, file: normalize(f.path), testids });
  }

  routes.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.file < b.file ? -1 : 1));

  return {
    pkg,
    generatedFrom: `packages/${pkg}/src/app`,
    routes,
    testids: [...globalTestids].sort(),
  };
}

/** Recursively collect every file under `dir`, returning {path,content} relative to `root`. */
async function collectFiles(
  dir: string,
  root: string,
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(abs, root)));
    } else if (entry.isFile()) {
      const content = await fs.readFile(abs, "utf8");
      out.push({ path: normalize(path.relative(root, abs)), content });
    }
  }
  return out;
}

/**
 * Thin IO shell: read storymap-ui's app dir from disk, run the pure core, and write the
 * artifact to storymap/qa-discovery/agileharness-ui.json (mkdir -p the dir).
 */
export async function main(): Promise<void> {
  const pkg = "agileharness-ui";
  // scripts/ -> package root -> repo root.
  const pkgRoot = path.resolve(import.meta.dirname, "..");
  const repoRoot = path.resolve(pkgRoot, "..", "..");
  const appDir = path.join(pkgRoot, "src", "app");

  const files = await collectFiles(appDir, pkgRoot);
  const discovery = buildDiscovery(pkg, files);

  const outDir = path.join(repoRoot, "storymap", "qa-discovery");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${pkg}.json`);
  await fs.writeFile(outPath, JSON.stringify(discovery, null, 2) + "\n", "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `qa-discovery: ${discovery.routes.length} routes, ${discovery.testids.length} testids -> ${outPath}`,
  );
}

// Run only when invoked directly (bun packages/storymap-ui/scripts/gen-qa-discovery.ts),
// never on import (keeps buildDiscovery importable by the test without IO). `import.meta.main`
// is a Bun runtime flag not in the TS ImportMeta lib type — narrow it locally.
if ((import.meta as { main?: boolean }).main) {
  void main();
}
