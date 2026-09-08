import { describe, expect, it } from "vitest";
import {
  criterionHash,
  diskSpecMemoStore,
  loadSpecMemo,
  makeSpecMemo,
  type SpecMemoEntry,
  type SpecMemoStore,
} from "./spec-memo";
import type { AcceptanceSpec } from "./qa-runner";

// ADR-063 Fase 5b — spec memoization: author each acceptance spec once, reuse while its criterion is
// unchanged. PURE over an injected store; hermetic (the disk round-trip uses a real tmp dir).

const spec = (criterion: string, layer: AcceptanceSpec["layer"] = "component"): AcceptanceSpec => ({ criterion, layer });

function memStore(seed: SpecMemoEntry[] = []): SpecMemoStore & { last: () => SpecMemoEntry[] } {
  let entries = [...seed];
  return {
    async load() {
      return [...entries];
    },
    async persist(next) {
      entries = [...next];
    },
    last: () => [...entries],
  };
}

describe("criterionHash — stable content key", () => {
  it("is deterministic and layer-sensitive", () => {
    expect(criterionHash("nav aparece", "component")).toBe(criterionHash("nav aparece", "component"));
    expect(criterionHash("nav aparece", "component")).not.toBe(criterionHash("nav aparece", "browser"));
  });

  it("ignores whitespace reflow but not real wording changes", () => {
    expect(criterionHash("  nav   aparece\n", "component")).toBe(criterionHash("nav aparece", "component"));
    expect(criterionHash("nav aparece", "component")).not.toBe(criterionHash("nav some", "component"));
  });
});

describe("makeSpecMemo — recall / remember", () => {
  it("recall splits specs into cached (with specPath) vs. toAuthor", () => {
    const seed: SpecMemoEntry = {
      hash: criterionHash("a", "component"),
      criterion: "a",
      layer: "component",
      specPath: "tests/e2e/a.spec.ts",
      authoredAt: 1,
    };
    const memo = makeSpecMemo({ store: memStore(), seed: [seed], now: () => 2 });
    const { cached, toAuthor } = memo.recall([spec("a"), spec("b")]);
    expect(cached).toEqual([{ criterion: "a", layer: "component", specPath: "tests/e2e/a.spec.ts" }]);
    expect(toAuthor).toEqual([{ criterion: "b", layer: "component" }]);
  });

  it("a criterion cached at a DIFFERENT layer is a MISS (must re-author for the new layer)", () => {
    const seed: SpecMemoEntry = { hash: criterionHash("a", "component"), criterion: "a", layer: "component", specPath: "x", authoredAt: 1 };
    const memo = makeSpecMemo({ store: memStore(), seed: [seed] });
    expect(memo.lookup("a", "browser")).toBeNull();
    expect(memo.recall([spec("a", "browser")]).toAuthor).toHaveLength(1);
  });

  it("remember upserts an authored spec so the next recall hits", () => {
    const memo = makeSpecMemo({ store: memStore(), now: () => 42 });
    expect(memo.recall([spec("new")]).toAuthor).toHaveLength(1); // miss first
    memo.remember(spec("new"), "tests/e2e/new.spec.ts");
    const { cached, toAuthor } = memo.recall([spec("new")]);
    expect(toAuthor).toHaveLength(0);
    expect(cached[0].specPath).toBe("tests/e2e/new.spec.ts");
    expect(memo.entries()[0]).toMatchObject({ criterion: "new", specPath: "tests/e2e/new.spec.ts", authoredAt: 42 });
  });

  it("flush persists the live entries to the store", async () => {
    const store = memStore();
    const memo = makeSpecMemo({ store, now: () => 7 });
    memo.remember(spec("z"), "tests/e2e/z.spec.ts");
    await memo.flush();
    expect(store.last()).toEqual([
      { hash: criterionHash("z", "component"), criterion: "z", layer: "component", specPath: "tests/e2e/z.spec.ts", authoredAt: 7 },
    ]);
  });
});

describe("loadSpecMemo — hydrate from the store", () => {
  it("seeds recall from the persisted entries", async () => {
    const seed: SpecMemoEntry = { hash: criterionHash("hi", "integration"), criterion: "hi", layer: "integration", specPath: "s.ts", authoredAt: 1 };
    const memo = await loadSpecMemo(memStore([seed]));
    expect(memo.recall([spec("hi", "integration")]).cached).toHaveLength(1);
  });

  it("a broken store load degrades to an empty memo (never throws)", async () => {
    const broken: SpecMemoStore = {
      load: async () => {
        throw new Error("disk boom");
      },
      persist: async () => {},
    };
    const memo = await loadSpecMemo(broken);
    expect(memo.entries()).toEqual([]);
  });
});

describe("diskSpecMemoStore — versioned JSON, per-entry safeParse, per-board file", () => {
  it("round-trips valid entries and drops malformed / wrong-version data", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-memo-"));
    try {
      const store = diskSpecMemoStore(dir, "storymap");
      expect(await store.load()).toEqual([]); // absent → clean

      const entries: SpecMemoEntry[] = [
        { hash: "h1", criterion: "a", layer: "component", specPath: "a.spec.ts", authoredAt: 1 },
      ];
      await store.persist(entries);
      expect(await store.load()).toEqual(entries);

      // Per-board file: a different board's store is independent.
      expect(await diskSpecMemoStore(dir, "acme").load()).toEqual([]);

      // Wrong version → dropped whole; right version with a malformed entry → only the good one survives.
      await fs.writeFile(path.join(dir, "spec-memo-storymap.json"), JSON.stringify({ version: 999, entries }), "utf8");
      expect(await store.load()).toEqual([]);
      await fs.writeFile(
        path.join(dir, "spec-memo-storymap.json"),
        JSON.stringify({ version: 1, entries: [entries[0], { hash: "x" /* missing fields */ }] }),
        "utf8",
      );
      expect(await store.load()).toEqual(entries);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
