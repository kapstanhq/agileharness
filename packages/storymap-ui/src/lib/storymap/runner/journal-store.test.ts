import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diskJournalStore } from "./journal";

// B1 contracts at a boundary: diskJournalStore.load() validates the cross-process journal.json BEFORE
// its entries reach the DESTRUCTIVE recovery path (killOrphan(pid) + git worktree remove). A malformed
// entry or a foreign/old schema is dropped, not cast in. (journal.test.ts covers the in-memory store;
// this covers the disk JSON path the finding flagged.)

const base = fs.mkdtempSync(path.join(os.tmpdir(), "journal-store-test-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function storeWith(json: unknown) {
  const dir = fs.mkdtempSync(path.join(base, "s-"));
  fs.writeFileSync(path.join(dir, "journal.json"), typeof json === "string" ? json : JSON.stringify(json));
  return diskJournalStore(dir);
}

const valid = { board: "acme", cardId: "c1", trigger: "harness-do", sessionId: "s1", pid: 123, startedAt: 1, status: "running" };

describe("diskJournalStore.load — validates before feeding recovery (B1)", () => {
  it("keeps a structurally-valid v1 entry", async () => {
    const out = await storeWith({ version: 1, runs: [valid] }).load();
    expect(out).toHaveLength(1);
    expect(out[0].cardId).toBe("c1");
  });

  it("keeps the resumeFallbackCount field (story-harness-cc #5 — the durable fallback budget survives load)", async () => {
    const out = await storeWith({ version: 1, runs: [{ ...valid, resumeFallbackCount: 2 }] }).load();
    expect(out).toHaveLength(1);
    expect(out[0].resumeFallbackCount).toBe(2);
  });

  it("drops the whole file on a version mismatch / missing version (foreign or old schema)", async () => {
    expect(await storeWith({ version: 2, runs: [valid] }).load()).toEqual([]);
    expect(await storeWith({ runs: [valid] }).load()).toEqual([]);
  });

  it("drops a malformed entry (wrong pid type / junk) but keeps valid siblings", async () => {
    const out = await storeWith({
      version: 1,
      runs: [{ ...valid, pid: "nan" }, valid, { junk: true }, { ...valid, status: "bogus" }],
    }).load();
    expect(out).toHaveLength(1);
    expect(out[0].cardId).toBe("c1");
  });

  it("tolerates an UNKNOWN trigger — keeps the entry so its orphan still gets reaped", async () => {
    const out = await storeWith({ version: 1, runs: [{ ...valid, trigger: "harness-renamed-skill" }] }).load();
    expect(out).toHaveLength(1);
  });

  it("keeps a done entry with outcome 'cancelled' (story-vbkazs — the schema enum accepts it)", async () => {
    // A deliberate operator cancel journals outcome 'cancelled'; JournalEntrySchema.outcome must
    // accept it, else the entry would be DROPPED on the next boot's load (losing forensic history).
    const done = { ...valid, status: "done", outcome: "cancelled", endedAt: 2 };
    const out = await storeWith({ version: 1, runs: [done] }).load();
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe("cancelled");
  });

  it("absent file or non-JSON → clean start (never throws)", async () => {
    expect(await storeWith("{ not json").load()).toEqual([]);
    expect(await diskJournalStore(path.join(base, "does-not-exist")).load()).toEqual([]);
  });
});
