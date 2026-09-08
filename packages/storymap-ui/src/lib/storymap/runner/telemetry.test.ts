import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TelemetryStore,
  costByRole,
  diskTelemetryStore,
  isSuccessWithWarning,
  lastToolGapByTrigger,
  roleOf,
  type TelemetryPersistStore,
  type TelemetryRecord,
} from "./telemetry";

// In-memory persistence double so the store's logic (cap, aggregation, ordering) is exercised
// without touching disk. Records what got persisted so the cap can be asserted on the written set.
function makeMemStore(seed: TelemetryRecord[] = []) {
  const persisted: TelemetryRecord[][] = [];
  let current = [...seed];
  const store: TelemetryPersistStore = {
    load: async () => [...current],
    persist: async (records) => {
      current = [...records];
      persisted.push([...records]);
    },
  };
  return { store, persisted, current: () => current };
}

function rec(over: Partial<TelemetryRecord> = {}): TelemetryRecord {
  // Spread (not ??) so an EXPLICIT null override (costUSD/turns) is honored, not swallowed by a default.
  return {
    id: "s1",
    board: "storymap",
    cardId: "card-a",
    trigger: "harness-do" as TelemetryRecord["trigger"],
    startedAt: 1000,
    durationMs: 5000,
    turns: 3,
    inputTokens: 100,
    outputTokens: 20,
    costUSD: 0.05,
    status: "ok",
    ...over,
  };
}

// story-mzpzb0 — o sinal DURÁVEL "sucesso-com-aviso" que separa falha real de trabalho-entregou-mas-
// saiu-sujo. É derivável no settle SEM parâmetro novo: o engine SUPRIME o RunnerFailure quando o card
// avançou (falha-fantasma), mas grava o outcome de MORTE cru no telemetry. Então: sem failure + outcome
// de morte = o card avançou apesar da saída suja = sucesso-com-aviso (NÃO travado). Com failure, ou
// outcome não-de-morte (ok/cancelled/max-turns/no-op*), = não é esse caso. (*no-op sempre carrega failure.)
describe("lastToolGapByTrigger (5.3) — most-recent run of a trigger with a toolGap", () => {
  // records are most-recent-first (as diskTelemetryStore().load() returns them)
  const records: TelemetryRecord[] = [
    rec({ id: "r1", trigger: "harness-do", toolGap: null }),
    rec({ id: "r2", trigger: "harness-review", toolGap: ["codegraph"] }),
    rec({ id: "r3", trigger: "harness-do", toolGap: ["chrome-devtools"] }),
    rec({ id: "r4", trigger: "harness-do", toolGap: ["graphify"] }),
  ];
  it("returns the FIRST (most-recent) record of the trigger with a non-empty toolGap", () => {
    expect(lastToolGapByTrigger(records, "harness-do")?.id).toBe("r3"); // r1 has null gap, r3 is the next
  });
  it("ignores other triggers", () => {
    expect(lastToolGapByTrigger(records, "harness-review")?.id).toBe("r2");
  });
  it("returns undefined when no matching record has a non-empty toolGap", () => {
    expect(lastToolGapByTrigger([rec({ trigger: "harness-do", toolGap: [] })], "harness-do")).toBeUndefined();
    expect(lastToolGapByTrigger(records, "harness-plan")).toBeUndefined();
  });
});

describe("isSuccessWithWarning — deriva sucesso-com-aviso de (temFalha, outcome)", () => {
  it("sem failure + outcome de MORTE ⇒ true (avançou apesar da saída suja)", () => {
    for (const outcome of ["exit", "timeout", "oom-killed", "error"] as const) {
      expect(isSuccessWithWarning(false, outcome)).toBe(true);
    }
  });
  it("COM failure (falha real, inclusive no-op) ⇒ false — mantém travado", () => {
    for (const outcome of ["exit", "timeout", "oom-killed", "error", "no-op"] as const) {
      expect(isSuccessWithWarning(true, outcome)).toBe(false);
    }
  });
  it("outcome NÃO-de-morte ⇒ false (sucesso normal / cancel / resumível / no-op)", () => {
    for (const outcome of ["ok", "cancelled", "max-turns", "no-op"] as const) {
      expect(isSuccessWithWarning(false, outcome)).toBe(false);
    }
  });
});

describe("TelemetryStore — advanced (sucesso-com-aviso durável, story-mzpzb0)", () => {
  it("recordRun faz round-trip do campo advanced", async () => {
    const { store } = makeMemStore();
    const t = new TelemetryStore(store);
    await t.recordRun(rec({ id: "w1", status: "exit", advanced: true }));
    const rows = await t.listByCard("storymap", "card-a");
    expect(rows[0].advanced).toBe(true);
  });

  it("boardSummary expõe lastAdvanced do run MAIS RECENTE do card", async () => {
    const { store } = makeMemStore();
    const t = new TelemetryStore(store);
    // run antigo travado (exit sem avanço), run recente sucesso-com-aviso (exit + advanced)
    await t.recordRun(rec({ id: "old", cardId: "card-w", startedAt: 100, status: "exit" }));
    await t.recordRun(rec({ id: "new", cardId: "card-w", startedAt: 300, status: "exit", advanced: true }));
    const sum = await t.boardSummary("storymap");
    const card = sum.cards.find((c) => c.cardId === "card-w");
    expect(card).toMatchObject({ lastStatus: "exit", lastAdvanced: true });
  });
});

// WS-7 §7.4 — o PAPEL como dimensão de custo (run/session/steward/resolution). ESPARSA por construção: o
// engine NÃO estampa o campo (todo run de autorun É `run`), então ausente ⇒ `run` e a história inteira
// anterior ao WS-7 continua agregando — nenhum backfill, nenhum bump de TELEMETRY_VERSION.
describe("roleOf — papel esparso, ausente ⇒ run", () => {
  it("registro sem role (todo o histórico pré-WS-7 + todo run do engine hoje) lê como `run`", () => {
    expect(roleOf(rec())).toBe("run");
    expect(roleOf(rec({ role: null }))).toBe("run"); // null explícito = mesmo default, nunca "desconhecido"
  });
  it("um papel estampado é lido verbatim", () => {
    for (const role of ["run", "session", "steward", "resolution"] as const) {
      expect(roleOf(rec({ role }))).toBe(role);
    }
  });
});

describe("costByRole — custo por papel (a evidência que calibra a tabela 7.1)", () => {
  it("agrega custo+contagem por papel, ordenado por custo desc, com os sem-role sob `run`", () => {
    const rows = costByRole([
      rec({ id: "a", costUSD: 0.1 }), // sem role → run
      rec({ id: "b", role: "run", costUSD: 0.2 }),
      rec({ id: "c", role: "session", costUSD: 1.5 }),
      rec({ id: "d", role: "resolution", costUSD: 0.05 }),
      rec({ id: "e", role: "resolution", costUSD: 0.05 }),
    ]);
    expect(rows.map((r) => r.role)).toEqual(["session", "run", "resolution"]); // 1.5 > 0.3 > 0.1
    expect(rows.find((r) => r.role === "run")).toMatchObject({ runs: 2 });
    expect(rows.find((r) => r.role === "run")!.totalCostUSD).toBeCloseTo(0.3);
    expect(rows.find((r) => r.role === "resolution")).toMatchObject({ runs: 2 });
  });

  it("custo null conta como 0 (mesma regra da agregação por card) e papel sem registro é OMITIDO", () => {
    const rows = costByRole([rec({ id: "n", role: "steward", costUSD: null })]);
    expect(rows).toEqual([{ role: "steward", runs: 1, totalCostUSD: 0 }]);
    // `session`/`resolution` não aparecem com $0 — "nunca rodou" e "rodou de graça" são afirmações diferentes.
    expect(rows.map((r) => r.role)).not.toContain("session");
    expect(costByRole([])).toEqual([]);
  });
});

describe("TelemetryStore", () => {
  it("recordRun persists the full record and listByCard returns it", async () => {
    const { store, persisted } = makeMemStore();
    const t = new TelemetryStore(store);
    await t.recordRun(rec({ id: "s1" }));
    await t.flush();

    expect(persisted.at(-1)).toEqual([rec({ id: "s1" })]);
    const rows = await t.listByCard("storymap", "card-a");
    expect(rows).toEqual([rec({ id: "s1" })]);
  });

  it("listByCard filters by board+cardId, most-recent first, honoring limit", async () => {
    const { store } = makeMemStore();
    const t = new TelemetryStore(store);
    await t.recordRun(rec({ id: "a1", cardId: "card-a", startedAt: 100 }));
    await t.recordRun(rec({ id: "a2", cardId: "card-a", startedAt: 300 }));
    await t.recordRun(rec({ id: "a3", cardId: "card-a", startedAt: 200 }));
    await t.recordRun(rec({ id: "b1", cardId: "card-b", startedAt: 999 }));
    await t.recordRun(rec({ id: "x1", board: "acme", cardId: "card-a", startedAt: 999 }));

    const rows = await t.listByCard("storymap", "card-a");
    expect(rows.map((r) => r.id)).toEqual(["a2", "a3", "a1"]); // 300 > 200 > 100, board+card scoped

    const limited = await t.listByCard("storymap", "card-a", 2);
    expect(limited.map((r) => r.id)).toEqual(["a2", "a3"]);
  });

  it("boardSummary aggregates cost/turns per card, sorted by cost desc", async () => {
    const { store } = makeMemStore();
    const t = new TelemetryStore(store);
    // card-a: 2 runs, cost 0.1 + 0.3 = 0.4, turns 2 & 4 → avg 3, last @300 status error
    await t.recordRun(rec({ id: "a1", cardId: "card-a", startedAt: 100, costUSD: 0.1, turns: 2, status: "ok" }));
    await t.recordRun(rec({ id: "a2", cardId: "card-a", startedAt: 300, costUSD: 0.3, turns: 4, status: "error" }));
    // card-b: 1 run, cost 0.05, turns null → avgTurns null
    await t.recordRun(rec({ id: "b1", cardId: "card-b", startedAt: 200, costUSD: 0.05, turns: null }));
    // other board ignored
    await t.recordRun(rec({ id: "x1", board: "acme", cardId: "card-z", costUSD: 9 }));

    const sum = await t.boardSummary("storymap");
    expect(sum.boardId).toBe("storymap");
    expect(sum.totalCostUSD).toBeCloseTo(0.45);
    expect(sum.cards.map((c) => c.cardId)).toEqual(["card-a", "card-b"]); // 0.4 > 0.05

    const a = sum.cards[0];
    expect(a).toMatchObject({ cardId: "card-a", totalRuns: 2, avgTurns: 3, lastRunAt: 300, lastStatus: "error" });
    expect(a.totalCostUSD).toBeCloseTo(0.4);
    const b = sum.cards[1];
    expect(b).toMatchObject({ cardId: "card-b", totalRuns: 1, avgTurns: null, lastRunAt: 200 });
  });

  it("treats null costs as zero in aggregation", async () => {
    const { store } = makeMemStore();
    const t = new TelemetryStore(store);
    await t.recordRun(rec({ id: "n1", cardId: "card-a", costUSD: null }));
    await t.recordRun(rec({ id: "n2", cardId: "card-a", costUSD: 0.2 }));
    const sum = await t.boardSummary("storymap");
    expect(sum.cards[0].totalCostUSD).toBeCloseTo(0.2);
    expect(sum.totalCostUSD).toBeCloseTo(0.2);
  });

  it("caps the ledger at 1000 records (drops the oldest)", async () => {
    const { store, current } = makeMemStore();
    const t = new TelemetryStore(store);
    for (let i = 0; i < 1005; i++) {
      await t.recordRun(rec({ id: `r${i}`, startedAt: i }));
    }
    await t.flush();
    expect(current().length).toBe(1000);
    // most-recent first → newest startedAt (1004) retained, oldest (0..4) dropped
    expect(current()[0].startedAt).toBe(1004);
    expect(current().at(-1)!.startedAt).toBe(5);
  });

  it("merges records that landed during an in-flight load (no loss)", async () => {
    // A slow load that resolves AFTER a concurrent recordRun prepended a record.
    let resolveLoad!: (rows: TelemetryRecord[]) => void;
    const store: TelemetryPersistStore = {
      load: () => new Promise<TelemetryRecord[]>((r) => (resolveLoad = r)),
      persist: async () => {},
    };
    const t = new TelemetryStore(store);
    const p = t.recordRun(rec({ id: "live", startedAt: 500 }));
    resolveLoad([rec({ id: "disk", startedAt: 400 })]);
    await p;
    const rows = await t.listByCard("storymap", "card-a");
    expect(rows.map((r) => r.id)).toEqual(["live", "disk"]); // both survive, sorted by startedAt desc
  });
});

describe("diskTelemetryStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "telemetry-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("round-trips records atomically (load sees what persist wrote)", async () => {
    const file = path.join(dir, "telemetry.json");
    const disk = diskTelemetryStore(file);
    const t = new TelemetryStore(disk);
    await t.recordRun(rec({ id: "d1", startedAt: 10 }));
    await t.recordRun(rec({ id: "d2", startedAt: 20 }));
    await t.flush();

    // No leftover temp file (rename is atomic).
    const files = await fsp.readdir(dir);
    expect(files).toEqual(["telemetry.json"]);

    // A fresh store reads it back.
    const t2 = new TelemetryStore(diskTelemetryStore(file));
    const rows = await t2.listByCard("storymap", "card-a");
    expect(rows.map((r) => r.id)).toEqual(["d2", "d1"]);
  });

  it("round-trips a 'cancelled' record (story-vbkazs — the z.enum accepts the new value on load)", async () => {
    const file = path.join(dir, "telemetry.json");
    const disk = diskTelemetryStore(file);
    const t = new TelemetryStore(disk);
    await t.recordRun(rec({ id: "c1", cardId: "card-c", status: "cancelled" }));
    await t.flush();

    // A fresh store re-parses the persisted record through TelemetryRecordSchema.safeParse — it must
    // survive (the enum gained "cancelled"); before the fix it would be DROPPED as an unknown status.
    const t2 = new TelemetryStore(diskTelemetryStore(file));
    const rows = await t2.listByCard("storymap", "card-c");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
  });

  it("round-trips the F4 `summary` (the run's decision) without a TELEMETRY_VERSION bump", async () => {
    const file = path.join(dir, "telemetry.json");
    const t = new TelemetryStore(diskTelemetryStore(file));
    await t.recordRun(rec({ id: "s1", cardId: "card-d", summary: "Corrigi o gate e revalidei." }));
    await t.flush();

    // A fresh store re-parses through TelemetryRecordSchema — the optional `summary` survives, and an
    // OLD record (no summary) still parses (renders without a decision line) rather than being dropped.
    const t2 = new TelemetryStore(diskTelemetryStore(file));
    const rows = await t2.listByCard("storymap", "card-d");
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe("Corrigi o gate e revalidei.");

    await fsp.writeFile(file, JSON.stringify({ version: 1, records: [{ ...rec({ id: "old" }) }] }), "utf8");
    const legacy = await diskTelemetryStore(file).load();
    expect(legacy).toHaveLength(1);
    expect(legacy[0].summary).toBeUndefined();
  });

  it("WS-7 §7.4: round-trips `role` e um registro ANTIGO (sem role) sobrevive ao safeParse por entry", async () => {
    const file = path.join(dir, "telemetry.json");
    const t = new TelemetryStore(diskTelemetryStore(file));
    await t.recordRun(rec({ id: "r1", cardId: "card-r", role: "resolution" }));
    await t.flush();

    const t2 = new TelemetryStore(diskTelemetryStore(file));
    expect((await t2.listByCard("storymap", "card-r"))[0].role).toBe("resolution");

    // Retrocompat: o registro pré-WS-7 (sem o campo) NÃO é dropado — parseia e lê como `run`.
    await fsp.writeFile(file, JSON.stringify({ version: 1, records: [rec({ id: "old" })] }), "utf8");
    const legacy = await diskTelemetryStore(file).load();
    expect(legacy).toHaveLength(1);
    expect(legacy[0].role).toBeUndefined();
    expect(roleOf(legacy[0])).toBe("run");
  });

  it("WS-7 §7.4: um role DESCONHECIDO (servidor mais novo) degrada o campo, não derruba o registro", async () => {
    // Por que `.catch(undefined)` e não um z.enum seco como `status`: um ledger forense não pode perder o
    // CUSTO de um run por causa de uma dimensão que ele ainda não conhece. O run continua contabilizado
    // (sob `run`, o default), só sem o rótulo novo.
    const file = path.join(dir, "telemetry.json");
    await fsp.writeFile(
      file,
      JSON.stringify({ version: 1, records: [{ ...rec({ id: "future", costUSD: 0.42 }), role: "quantum-steward" }] }),
      "utf8",
    );
    const rows = await diskTelemetryStore(file).load();
    expect(rows).toHaveLength(1);
    expect(rows[0].costUSD).toBe(0.42);
    expect(rows[0].role).toBeUndefined();
  });

  it("starts clean on a foreign/old-schema or malformed file", async () => {
    const file = path.join(dir, "telemetry.json");
    await fsp.writeFile(file, JSON.stringify({ version: 999, records: [rec()] }), "utf8");
    expect(await diskTelemetryStore(file).load()).toEqual([]);
    await fsp.writeFile(file, "not json", "utf8");
    expect(await diskTelemetryStore(file).load()).toEqual([]);
  });
});
