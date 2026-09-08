import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diskMergeQueueStore } from "./merge-queue";

// B1 contract at a boundary: diskMergeQueueStore.load() validates merge-queue.json BEFORE its entries
// reach the runner's MOST DESTRUCTIVE recovery path — recover() fires `git branch -D`, `git worktree
// remove --force`, and `git merge` into main off e.status/e.branch/e.split. A malformed entry or a
// foreign/old-schema file is dropped, not cast in. Mirrors journal-store.test.ts (the sibling store).

const base = fs.mkdtempSync(path.join(os.tmpdir(), "merge-queue-store-test-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function storeWith(json: unknown) {
  const dir = fs.mkdtempSync(path.join(base, "s-"));
  fs.writeFileSync(path.join(dir, "merge-queue.json"), typeof json === "string" ? json : JSON.stringify(json));
  return diskMergeQueueStore(dir);
}

const valid = {
  runId: "r1",
  board: "acme",
  cardId: "c1",
  branch: "run/r1",
  status: "merging",
  enqueuedAt: 1,
  trigger: "harness-do",
  split: { dataLanded: true },
};

describe("diskMergeQueueStore.load — validates before feeding recovery (B1)", () => {
  it("keeps a structurally-valid v1 entry (incl. its optionals)", async () => {
    const out = await storeWith({ version: 1, entries: [valid] }).load();
    expect(out).toHaveLength(1);
    expect(out[0].runId).toBe("r1");
    expect(out[0].split).toEqual({ dataLanded: true });
  });

  it("drops the whole file on a version mismatch / missing version (foreign or old schema)", async () => {
    expect(await storeWith({ version: 2, entries: [valid] }).load()).toEqual([]);
    expect(await storeWith({ entries: [valid] }).load()).toEqual([]);
  });

  it("drops a malformed entry (bad status enum / wrong types / junk) but keeps valid siblings", async () => {
    const out = await storeWith({
      version: 1,
      entries: [
        { ...valid, status: "bogus" }, // not a MergeQueueStatus
        valid,
        { junk: true }, // missing required fields
        { ...valid, runId: 123 }, // wrong type — would feed `git branch -D` a non-string
        { ...valid, enqueuedAt: "soon" }, // wrong type
      ],
    }).load();
    expect(out).toHaveLength(1);
    expect(out[0].runId).toBe("r1");
  });

  it("keeps an entry whose trigger was renamed (loose z.string) so recovery can still clean its branch", async () => {
    const out = await storeWith({ version: 1, entries: [{ ...valid, trigger: "harness-some-removed-skill" }] }).load();
    expect(out).toHaveLength(1);
    expect(out[0].trigger).toBe("harness-some-removed-skill");
  });

  it("absent / unreadable / malformed JSON → start clean (never throws)", async () => {
    const dir = fs.mkdtempSync(path.join(base, "s-"));
    expect(await diskMergeQueueStore(dir).load()).toEqual([]); // absent file
    fs.writeFileSync(path.join(dir, "merge-queue.json"), "{not json");
    expect(await diskMergeQueueStore(dir).load()).toEqual([]); // malformed JSON
  });

  // storymap-parallel-work — the schema is a BOUNDARY, and every field it forgets is data the runner
  // silently loses at boot (Zod strips unknown keys; a failed safeParse drops the whole entry). These are
  // regressions with teeth: each one was live, and none of them announce themselves — the entry just comes
  // back subtly wrong, or not at all, one restart later.
  it("card-less session entry survives the round-trip with baseCommit/pinnedSha/kind intact", async () => {
    const session = {
      runId: "s1",
      board: "storymap",
      // NO cardId — WS-1.3/D2: self-dev work with no card. `cardId: z.string()` (required) dropped the
      // WHOLE entry here, so the session's branch was left with no integration and no trace in the queue.
      branch: "agent/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
      status: "waiting",
      enqueuedAt: 1,
      kind: "session",
      // Absent from the schema ⇒ stripped on load. baseCommit is the spawn-pinned integration base (its
      // loss re-arms the stale-base bug it exists to kill); pinnedSha is G5 (its loss makes the restart
      // integrate the branch's live tip — code the gate never validated).
      baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      pinnedSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const [got] = await storeWith({ version: 1, entries: [session] }).load();
    expect(got).toBeDefined(); // the entry survives at all — it used to vanish
    expect(got.cardId).toBeUndefined();
    expect(got.kind).toBe("session");
    expect(got.baseCommit).toBe(session.baseCommit);
    expect(got.pinnedSha).toBe(session.pinnedSha);
  });

  it("a run entry keeps baseCommit across the round-trip (pre-existing loss, predates this plan)", async () => {
    const [got] = await storeWith({ version: 1, entries: [{ ...valid, baseCommit: "cccccccccccccccccccccccccccccccccccccccc" }] }).load();
    expect(got.baseCommit).toBe("cccccccccccccccccccccccccccccccccccccccc");
  });

  it("returned-to-session is a loadable status (G6) — the ledger keeps the record across a restart", async () => {
    const [got] = await storeWith({ version: 1, entries: [{ ...valid, status: "returned-to-session", kind: "session" }] }).load();
    expect(got?.status).toBe("returned-to-session");
  });
});

// autonomy-endgame WS-2.4 — an orphaned `re-driving` entry is RESOLVED at boot, never ERASED.
//
// A re-drive's live work is a fresh headless run, and runs do not survive a restart — so a `re-driving`
// seen at load() is always orphaned, with no live work and no operator path. Terminating it was right;
// DELETING it was not. The entry is the only legible record of what happened, and the two entries wedged in
// the live runtime (a779b5be / f873d987 — both `{codeStaged:true}` with no `dataLanded`) were one restart
// away from evaporating, taking the only readable evidence of the half-landing with them. A `failed` entry
// is requeueable by the operator and says why; an erased one is requeueable by nobody.
describe("diskMergeQueueStore.load — WS-2.4: a entry `re-driving` órfã do boot vira `failed`, não some", () => {
  const reDriving = { ...valid, runId: "a779b5be", status: "re-driving", split: { codeStaged: true } };

  it("resolve para `failed` COM motivo legível — em vez de descartar em silêncio", async () => {
    const out = await storeWith({ version: 1, entries: [reDriving] }).load();
    expect(out).toHaveLength(1); // não sumiu
    expect(out[0].status).toBe("failed");
    expect(out[0].failureReason).toMatch(/re-drive órfão/);
    expect(out[0].failureReason).toMatch(/requeue/i); // o operador tem saída
    expect(out[0].branch).toBe("run/r1"); // o branch continua em git, e a entry diz qual é
  });

  it("uma MEIA-ATERRISSAGEM é nomeada no motivo — e o motivo recusa o instinto errado (re-drivar)", async () => {
    const out = await storeWith({ version: 1, entries: [reDriving] }).load();
    // Este é o texto que o operador lê às 3h da manhã antes de decidir. Se ele disser só "falhou", o
    // próximo clique é "re-drive" — que re-implementa código já publicado (o padrão qb8z2c, ~$13).
    expect(out[0].failureReason).toMatch(/MEIA-ATERRISSAGEM/);
    expect(out[0].failureReason).toMatch(/retentar a metade de dados/i);
    expect(out[0].failureReason).toMatch(/NUNCA re-drivar/i);
  });

  it("uma entry `re-driving` SEM meia-aterrissagem não ganha o aviso (só o fato do órfão)", async () => {
    const out = await storeWith({
      version: 1,
      entries: [{ ...valid, status: "re-driving", split: { codeStaged: true, dataLanded: true } }],
    }).load();
    expect(out[0].status).toBe("failed");
    expect(out[0].failureReason).not.toMatch(/MEIA-ATERRISSAGEM/);
  });

  it("as outras entries passam intocadas (a resolução é cirúrgica, não uma varredura)", async () => {
    const out = await storeWith({ version: 1, entries: [valid, reDriving] }).load();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ runId: "r1", status: "merging" });
    expect(out[1]).toMatchObject({ runId: "a779b5be", status: "failed" });
  });
});
