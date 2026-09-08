import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import type { BoardConfig } from "@/lib/storymap/types";
import type { StyleGuideDoc } from "@/lib/storymap/style-guide";

// design-actions.test.ts — the guide is a PLAIN SOURCE-OF-TRUTH document (no generation/approval flow):
//   - applyStyleGuideAssistAction (the human-authoring write) promotes version+1 + writes the pointer,
//     refuses a stale baseVersion (optimistic concurrency), and is byte-identical to compile(coerce(doc))
//   - AA (WCAG contrast) is INFORMATIONAL only — it never blocks a write, and promotion stamps no
//     approvedBy (there is no approval, just a write)
//   - styleGuideDriftAction (WS-4, report-only): no package: → "não aplicável"; tokenBindings + divergent
//     CSS → exact mismatch; matching CSS → no finding
//
// The node:fs mock injects in-memory product-file fixtures for the drift audit; findRepoRoot() stays REAL.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// WS-4 drift — intercept node:fs's readFile with an in-memory fixture (`productFiles`) keyed by
// absolute path, falling through to the REAL fs for anything not in the fixture.
let productFiles: Map<string, string>;

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: async (p: string, enc?: unknown) => {
        const hit = productFiles.get(String(p));
        if (hit != null) return hit;
        return actual.promises.readFile(p as never, enc as never);
      },
    },
  };
});

let boardConfig: BoardConfig;
let writtenGuides: { boardId: string; doc: StyleGuideDoc }[];
/** The PUBLISHED canonical guide `readStyleGuide` returns — null = board has none yet. */
let styleGuideDoc: StyleGuideDoc | null;

function baseConfig(): BoardConfig {
  return {
    id: "b",
    name: "B",
    statuses: [],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  };
}

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readBoardConfig: async () => boardConfig,
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    writeBoardConfig: async (_b: string, config: BoardConfig) => {
      boardConfig = config;
    },
  };
});

vi.mock("@/lib/storymap/sidecars", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/sidecars")>();
  return {
    ...actual,
    readStyleGuide: async (_b: string) => styleGuideDoc,
    writeStyleGuide: async (boardId: string, doc: StyleGuideDoc) => {
      writtenGuides.push({ boardId, doc });
    },
  };
});

import { applyStyleGuideAssistAction, styleGuideDriftAction } from "@/app/design-actions";
import { compileStyleGuideMd, coerceStyleGuideDoc } from "@/lib/storymap/style-guide";

/** A minimal, AA-CLEAN StyleGuideDoc (white text on the primary role — a real ≥4.5:1 pair). */
function cleanDoc(): StyleGuideDoc {
  return coerceStyleGuideDoc({
    meta: { version: 0, updatedAt: "2026-07-15", sources: { refs: [] } },
    identity: { school: "editorial", personality: ["direto"], prose: "" },
    principles: { items: ["um destaque por tela"], prose: "" },
    color: {
      tokens: [{ role: "primary", value: "#000000", on: "#FFFFFF", usage: "CTA", budget: "≤10%" }],
      budgetRules: [],
      prose: "",
    },
    typography: { fonts: [{ family: "Inter", role: "body" }], scale: [], rules: [], prose: "" },
    spacing: { base: 4, steps: [4, 8], prose: "" },
    shape: { radii: {}, depth: "sem sombras", borders: "", prose: "" },
    motion: { durations: {}, easings: {}, prose: "" },
    voice: { lexicon: { preferred: [], forbidden: [], exceptions: [] }, prose: "" },
    antiPatterns: [],
    debt: { knownIssues: [] },
  });
}

/** An AA-FAILING doc — a near-identical grey-on-grey pair (<4.5:1). */
function failingDoc(): StyleGuideDoc {
  const d = cleanDoc();
  return {
    ...d,
    color: { ...d.color, tokens: [{ role: "primary", value: "#888888", on: "#999999", usage: "CTA", budget: "≤10%" }] },
  };
}

beforeEach(() => {
  boardConfig = baseConfig();
  writtenGuides = [];
  styleGuideDoc = null;
  productFiles = new Map();
});

/** A published guide whose `primary` token is bound to a real CSS var — the mechanical drift path (D6). */
function docWithBindings(): StyleGuideDoc {
  const d = cleanDoc();
  return {
    ...d,
    color: { ...d.color, tokens: [{ role: "primary", value: "#FF4F00", on: "#FFFFFF", usage: "CTA", budget: "≤10%" }] },
    // Repo-ROOT-relative (the AgileHarness convention: like `package:`/`brandbook:`/SystemDef.paths). The drift
    // resolver joins this to the repo root, NOT to <root>/<pkg> (the fixed double-prefix bug).
    tokenBindings: { primary: { file: "packages/testapp/web/src/app/globals.css", cssVar: "--primary" } },
  };
}

describe("applyStyleGuideAssistAction — the single writer of the canonical (human-authoring path)", () => {
  it("promotes version+1 and writes the pointer with the hash of the compiled bytes", async () => {
    boardConfig.styleGuide = { version: 2, hash: "old" };
    const res = await applyStyleGuideAssistAction({ boardId: "b", doc: cleanDoc(), baseVersion: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.pointer.version).toBe(3);
    expect(boardConfig.styleGuide?.version).toBe(3);
    expect(boardConfig.styleGuide?.hash).toBe(res.data?.pointer.hash);
    expect(writtenGuides).toHaveLength(1);
  });

  it("refuses a stale baseVersion (optimistic concurrency — canonical moved under the edit)", async () => {
    boardConfig.styleGuide = { version: 2, hash: "old" };
    const res = await applyStyleGuideAssistAction({ boardId: "b", doc: cleanDoc(), baseVersion: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("avançou");
    expect(writtenGuides).toHaveLength(0);
    expect(boardConfig.styleGuide?.version).toBe(2); // untouched
  });

  it("AA is INFORMATIONAL only — an AA-failing doc PUBLISHES (never blocks), no aaOverride stamped", async () => {
    const res = await applyStyleGuideAssistAction({ boardId: "b", doc: failingDoc(), baseVersion: 0 });
    expect(res.ok).toBe(true);
    expect(writtenGuides).toHaveLength(1);
    expect(writtenGuides[0].doc.meta.aaOverride).toBeUndefined();
  });

  it("does NOT stamp approvedBy — promotion is a plain write, not an approval", async () => {
    const res = await applyStyleGuideAssistAction({ boardId: "b", doc: cleanDoc(), baseVersion: 0 });
    expect(res.ok).toBe(true);
    expect(writtenGuides[0].doc.meta.approvedBy).toBeUndefined();
  });

  it("the resulting canonical is byte-identical to compileStyleGuideMd(coerce(doc)) — D3 fixed point", async () => {
    const res = await applyStyleGuideAssistAction({ boardId: "b", doc: cleanDoc(), baseVersion: 0 });
    expect(res.ok).toBe(true);
    const written = writtenGuides[0].doc;
    expect(compileStyleGuideMd(written)).toBe(compileStyleGuideMd(coerceStyleGuideDoc(written)));
    expect(res.ok && res.data?.pointer.hash).toBeTruthy();
  });
});

describe("styleGuideDriftAction (WS-4, D15 — report-only, fail-open)", () => {
  it("applicable:false when the board has no package: (never an error)", async () => {
    const res = await styleGuideDriftAction({ boardId: "b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.applicable).toBe(false);
    expect(res.data?.report.findings).toEqual([]);
    expect(res.data?.filesRead).toEqual([]);
  });

  it("applicable:false when package: is set but no guide has been published yet", async () => {
    boardConfig.package = "packages/testapp";
    const res = await styleGuideDriftAction({ boardId: "b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.applicable).toBe(false);
  });

  it("tokenBindings + divergent CSS → reports the exact mismatch (declared vs found)", async () => {
    boardConfig.package = "packages/testapp";
    styleGuideDoc = docWithBindings();
    const absPath = path.join(findRepoRoot(), "packages/testapp", "web/src/app/globals.css");
    productFiles.set(absPath, "--primary: #4B76E8;\n");

    const res = await styleGuideDriftAction({ boardId: "b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.applicable).toBe(true);
    expect(res.data?.report.findings).toEqual([
      { role: "primary", declared: "#FF4F00", found: "#4B76E8", file: "packages/testapp/web/src/app/globals.css", kind: "mismatch" },
    ]);
    expect(res.data?.filesRead).toEqual(["packages/testapp/web/src/app/globals.css"]);
  });

  it("no drift when the CSS value matches the declared token", async () => {
    boardConfig.package = "packages/testapp";
    styleGuideDoc = docWithBindings();
    const absPath = path.join(findRepoRoot(), "packages/testapp", "web/src/app/globals.css");
    productFiles.set(absPath, "--primary: #FF4F00;\n");

    const res = await styleGuideDriftAction({ boardId: "b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.report.findings).toEqual([]);
  });

  it("a bound file that can't be read reports 'unreadable' — never throws", async () => {
    boardConfig.package = "packages/testapp";
    styleGuideDoc = docWithBindings(); // productFiles left empty — the bound file is "missing"
    const res = await styleGuideDriftAction({ boardId: "b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.report.findings).toEqual([
      { role: "primary", declared: "#FF4F00", file: "packages/testapp/web/src/app/globals.css", kind: "unreadable" },
    ]);
  });

  it("falls back to the heuristic default candidates when the guide declares no tokenBindings", async () => {
    boardConfig.package = "packages/testapp";
    styleGuideDoc = cleanDoc(); // no tokenBindings — cleanDoc's primary is "#000000"
    const absPath = path.join(findRepoRoot(), "packages/testapp", "web/src/app/globals.css");
    productFiles.set(absPath, "--primary: #FFFFFF;\n");

    const res = await styleGuideDriftAction({ boardId: "b" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data?.applicable).toBe(true);
    expect(res.data?.report.findings).toEqual([
      expect.objectContaining({ role: "primary", declared: "#000000", found: "#FFFFFF", confidence: "low" }),
    ]);
  });
});
