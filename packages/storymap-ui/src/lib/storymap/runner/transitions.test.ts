import { describe, expect, it, afterEach, vi } from "vitest";
import {
  appendTransition,
  commitInstantMs,
  compactTransitions,
  ledgerCatchUp,
  parseTransitionsLines,
  reconcileLedgerWithCards,
  rehomeTransitionsRaw,
  setTransitionSink,
  resetTransitionSink,
  statusMovedSince,
  TRANSITIONS_VERSION,
  type Transition,
} from "./transitions";

// Collect appended lines through the injectable sink — no real file, deterministic.
function collector() {
  const lines: string[] = [];
  return { sink: { append: async (line: string) => void lines.push(line) }, lines };
}

afterEach(() => resetTransitionSink());

describe("appendTransition (WS2) — writers-only, serialized, fail-open", () => {
  it("writes ONE versioned record with all fields + an ISO timestamp", async () => {
    const { sink, lines } = collector();
    setTransitionSink(sink);
    await appendTransition({ board: "b", cardId: "s1", from: "revisar-codigo", to: "stage", actor: "run:harness-do", runId: "r1", note: "advance" });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as Transition;
    expect(rec).toMatchObject({ v: TRANSITIONS_VERSION, board: "b", cardId: "s1", from: "revisar-codigo", to: "stage", actor: "run:harness-do", runId: "r1", note: "advance" });
    expect(typeof rec.at).toBe("string");
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
    expect(lines[0].endsWith("\n")).toBe(true);
  });

  it("serializes concurrent appends — every line lands, no interleave", async () => {
    const { sink, lines } = collector();
    setTransitionSink(sink);
    await Promise.all([
      appendTransition({ board: "b", cardId: "s1", from: null, to: "a", actor: "human" }),
      appendTransition({ board: "b", cardId: "s1", from: "a", to: "b", actor: "cascade" }),
      appendTransition({ board: "b", cardId: "s1", from: "b", to: "c", actor: "system" }),
    ]);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow(); // each line is a whole record
  });

  it("FAIL-OPEN: a sink that throws resolves (never rejects) so the caller is never broken", async () => {
    setTransitionSink({ append: async () => { throw new Error("disk full"); } });
    await expect(appendTransition({ board: "b", cardId: "s1", from: "a", to: "b", actor: "human" })).resolves.toBeUndefined();
  });
});

describe("parseTransitionsLines (WS2) — tolerant reader", () => {
  const line = (t: Partial<Transition>) => JSON.stringify({ v: 1, at: "2026-07-09T00:00:00Z", board: "b", cardId: "s1", from: null, to: "x", actor: "human", ...t });

  it("parses well-formed lines, skips blank + malformed (safeParse)", () => {
    const raw = [line({ to: "a" }), "", "{ not json", line({ to: "b" }), '{"partialwrite'].join("\n");
    const recs = parseTransitionsLines(raw);
    expect(recs.map((r) => r.to)).toEqual(["a", "b"]);
  });

  it("filters by cardId and board", () => {
    const raw = [line({ cardId: "s1", to: "a" }), line({ cardId: "s2", to: "b" }), line({ board: "other", cardId: "s1", to: "c" })].join("\n");
    expect(parseTransitionsLines(raw, { cardId: "s1" }).map((r) => r.to)).toEqual(["a", "c"]);
    expect(parseTransitionsLines(raw, { cardId: "s1", board: "b" }).map((r) => r.to)).toEqual(["a"]);
  });

  it("drops records missing the required to/cardId (schema guard)", () => {
    const raw = ['{"v":1,"board":"b","from":null,"actor":"human"}', line({ to: "ok" })].join("\n");
    expect(parseTransitionsLines(raw).map((r) => r.to)).toEqual(["ok"]);
  });
});

describe("compactTransitions (6.2) — card-scoped retention", () => {
  const NOW = Date.parse("2026-07-10T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  // one hop line, `daysAgo` days before NOW, for (board, cardId), with a distinguishing `to`.
  const hop = (board: string, cardId: string, to: string, daysAgo: number) =>
    JSON.stringify({ v: 1, at: new Date(NOW - daysAgo * DAY).toISOString(), board, cardId, from: null, to, actor: "human" });

  it("a noisy board NEVER evicts a quiet board's live-card history (the regression the blind slice caused)", () => {
    const noisy = Array.from({ length: 60 }, (_, i) => hop("noisy", "n1", `n${i}`, 0)); // 60 fresh hops flood the file
    const quiet = [hop("quiet", "q1", "q-old-1", 40), hop("quiet", "q1", "q-old-2", 40)]; // 2 OLD hops of a live card
    const out = compactTransitions([...noisy, ...quiet].join("\n"), { now: NOW, keepPerCard: 50, windowMs: 30 * DAY });
    expect(parseTransitionsLines(out, { board: "quiet" }).map((r) => r.to)).toEqual(["q-old-1", "q-old-2"]);
  });

  it("keeps the LAST keepPerCard hops when all are older than the window", () => {
    const out = compactTransitions(
      Array.from({ length: 60 }, (_, i) => hop("b", "c1", `h${i}`, 40)).join("\n"),
      { now: NOW, keepPerCard: 50, windowMs: 30 * DAY },
    );
    const recs = parseTransitionsLines(out, { cardId: "c1" });
    expect(recs.map((r) => r.to)).toEqual(Array.from({ length: 50 }, (_, i) => `h${i + 10}`)); // h10..h59
  });

  it("the 30-day window OVERRIDES the per-card cap (keeps > N when all are recent)", () => {
    const out = compactTransitions(
      Array.from({ length: 60 }, (_, i) => hop("b", "c1", `h${i}`, 1)).join("\n"),
      { now: NOW, keepPerCard: 50, windowMs: 30 * DAY },
    );
    expect(parseTransitionsLines(out, { cardId: "c1" })).toHaveLength(60);
  });

  it("PROPERTY — never removes the last (most-recent) hop of any card", () => {
    const cards = ["a", "b", "c", "d", "e"];
    const raw = cards
      .flatMap((c, ci) => Array.from({ length: (ci + 1) * 15 }, (_, i) => hop("b", c, `${c}-${i}`, 40)))
      .join("\n");
    const out = compactTransitions(raw, { now: NOW, keepPerCard: 50, windowMs: 30 * DAY });
    for (const c of cards) {
      const count = (cards.indexOf(c) + 1) * 15;
      const recs = parseTransitionsLines(out, { cardId: c });
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.some((r) => r.to === `${c}-${count - 1}`)).toBe(true); // the highest index = the last hop
    }
  });

  it("drops unparseable / attribution-less lines but keeps valid hops (divergence from the blind slice)", () => {
    const raw = ["", "{ not json", '{"v":1,"board":"b","from":null,"actor":"human"}', hop("b", "c1", "ok", 1)].join("\n");
    expect(parseTransitionsLines(compactTransitions(raw, { now: NOW })).map((r) => r.to)).toEqual(["ok"]);
  });

  it("preserves chronological (input) order for the survivors", () => {
    const raw = [hop("b", "c1", "x1", 5), hop("b", "c2", "y1", 4), hop("b", "c1", "x2", 3), hop("b", "c2", "y2", 2)].join("\n");
    const out = compactTransitions(raw, { now: NOW, keepPerCard: 50, windowMs: 30 * DAY });
    expect(parseTransitionsLines(out).map((r) => r.to)).toEqual(["x1", "y1", "x2", "y2"]);
  });

  it("a hop with an invalid `at`, beyond the last-N and not in-window, is dropped without a NaN crash", () => {
    const bad = JSON.stringify({ v: 1, at: "garbage", board: "b", cardId: "c1", from: null, to: "bad", actor: "human" });
    const filler = Array.from({ length: 3 }, (_, i) => hop("b", "c1", `f${i}`, 1)); // fresh → fill the tiny budget
    const out = compactTransitions([bad, ...filler].join("\n"), { now: NOW, keepPerCard: 2, windowMs: 30 * DAY });
    const tos = parseTransitionsLines(out, { cardId: "c1" }).map((r) => r.to);
    expect(tos).not.toContain("bad");
    expect(tos).toContain("f2");
  });
});

// WP5-F1 — o ledger nunca fica atrás do arquivo do card, mas o salto de reconciliação só sai quando a divergência NASCEU
// da aterrissagem que está sendo reconciliada. Caso típico: o arquivo diz `corrigir` porque um
// restore o REGREDIU, e o ledger termina em `release` (deploy:reverted). Ali o lado errado é o ARQUIVO: um
// salto `release → corrigir` com actor merge legitimaria a regressão e apagaria a evidência — e qualquer run que
// aterrissasse narrativa/tasks nesse card o gravaria. Divergência antiga vira alerta; quem decide o lado é o integrador.
describe("ledgerCatchUp / reconcileLedgerWithCards — o ledger acompanha o arquivo sem legitimar regressão", () => {
  const card = { board: "b", cardId: "s1", before: "revisar-codigo", after: "qa-automatizado" };

  it("regressão: divergência ANTERIOR e esta aterrissagem não mudou o status ⇒ nenhum salto, só a divergência relatada", () => {
    const res = ledgerCatchUp({ to: "release", actor: "cascade" }, { ...card, before: "corrigir", after: "corrigir" }, "merge-back", "r1");
    expect(res).toEqual({ kind: "divergent", board: "b", cardId: "s1", ledger: "release", file: "corrigir" });
  });

  it("divergência anterior deixada pelo settle de OUTRO run ⇒ também não é desta aterrissagem: nenhum salto", () => {
    const res = ledgerCatchUp({ to: "qa-automatizado", actor: "run:harness-do", runId: "r0" }, { ...card, before: "corrigir", after: "corrigir" }, "merge-back", "r1");
    expect(res).toMatchObject({ kind: "divergent", ledger: "qa-automatizado", file: "corrigir" });
  });

  it("main venceu o status (o último salto é o settle otimista DESTE run) ⇒ UM salto merge do que o run disse até o arquivo", () => {
    // o run gravou no settle revisar-codigo → qa-automatizado (o que o worktree dizia); main tinha movido o card para
    // `corrigir` depois do corte e o merge-back manteve o de main — o settle otimista é que ficou errado.
    const res = ledgerCatchUp({ to: "qa-automatizado", actor: "run:harness-do", runId: "r1" }, { ...card, before: "corrigir", after: "corrigir" }, "merge-back", "r1");
    expect(res).toEqual({
      kind: "hop",
      hop: { board: "b", cardId: "s1", from: "qa-automatizado", to: "corrigir", actor: "merge", runId: "r1", note: "reconcile:merge-back" },
    });
  });

  it("um salto humano com o mesmo runId não passa por settle deste run (só `run:*` conta)", () => {
    const res = ledgerCatchUp({ to: "qa-automatizado", actor: "human", runId: "r1" }, { ...card, before: "corrigir", after: "corrigir" }, "merge-back", "r1");
    expect(res).toMatchObject({ kind: "divergent" });
  });

  it("esta aterrissagem MUDOU o status e o ledger não a acompanha ⇒ UM salto de onde o LEDGER parou até o arquivo", () => {
    expect(ledgerCatchUp({ to: "revisar-codigo", actor: "cascade" }, card, "merge-back", "r1")).toEqual({
      kind: "hop",
      hop: { board: "b", cardId: "s1", from: "revisar-codigo", to: "qa-automatizado", actor: "merge", runId: "r1", note: "reconcile:merge-back" },
    });
  });

  it("ledger já no status do arquivo (o salto do run gravado no settle) ⇒ nada (sem registro duplicado)", () => {
    expect(ledgerCatchUp({ to: "qa-automatizado", actor: "run:harness-do", runId: "r1" }, card, "merge-back", "r1")).toBeNull();
  });

  it("sem histórico: só registra quando a escrita MUDOU o status", () => {
    expect(ledgerCatchUp(undefined, { ...card, after: "revisar-codigo" }, "merge-back")).toBeNull();
    expect(ledgerCatchUp(undefined, card, "merge-back")).toMatchObject({ kind: "hop", hop: { from: "revisar-codigo", to: "qa-automatizado", actor: "merge" } });
  });

  it("lê o ledger uma vez, usa o ÚLTIMO salto de cada card, grava só os saltos desta aterrissagem e relata as divergências antigas", async () => {
    const { sink, lines } = collector();
    setTransitionSink(sink);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ledger = [
      { v: 1, at: "2026-06-01T20:20:42Z", board: "b", cardId: "s1", from: "stage", to: "release", actor: "cascade" },
      { v: 1, at: "2026-06-01T20:21:02Z", board: "b", cardId: "s2", from: "a", to: "b", actor: "human" },
      { v: 1, at: "2026-06-01T20:22:00Z", board: "b", cardId: "s1", from: "release", to: "deploy", actor: "cascade" },
      { v: 1, at: "2026-06-01T20:23:00Z", board: "b", cardId: "s3", from: "x", to: "y", actor: "run:harness-do", runId: "r9" },
    ] as Transition[];
    const res = await reconcileLedgerWithCards(
      [
        { board: "b", cardId: "s1", before: "corrigir", after: "corrigir" }, // divergência anterior (ex0070)
        { board: "b", cardId: "s2", before: "b", after: "b" }, // em dia
        { board: "b", cardId: "s3", before: "z", after: "z" }, // main venceu o settle deste run
      ],
      { origin: "merge-back", runId: "r9", read: async () => ledger },
    );
    expect(res.hops).toEqual([{ board: "b", cardId: "s3", from: "y", to: "z", actor: "merge", runId: "r9", note: "reconcile:merge-back" }]);
    expect(res.divergent).toEqual([{ kind: "divergent", board: "b", cardId: "s1", ledger: "deploy", file: "corrigir" }]);
    expect(lines.map((l) => JSON.parse(l).cardId)).toEqual(["s3"]); // nada gravado para s1
    expect(warn.mock.calls.flat().join(" ")).toMatch(/b\/s1.*deploy.*corrigir/);
    warn.mockRestore();
  });

  it("FAIL-OPEN: ledger ilegível não lança e não grava nada", async () => {
    const { sink, lines } = collector();
    setTransitionSink(sink);
    const res = await reconcileLedgerWithCards([card], { origin: "merge-back", read: async () => { throw new Error("EIO"); } });
    expect(res).toEqual({ hops: [], divergent: [] });
    expect(lines).toEqual([]);
  });
});

// WP5-F2 — main mexeu no status depois da base do run, mesmo que tenha voltado ao valor dela (A→C→A)?
describe("statusMovedSince — o ledger prova o move que a base não vê", () => {
  const hop = (at: string, over: Partial<Transition> = {}): Transition => ({ v: 1, at, board: "b", cardId: "c", from: "a", to: "b", actor: "human", ...over });
  const CARD = { board: "b", cardId: "c" };
  // a base do run: o card estava em «a» no commit-base
  const BASE = { atMs: Date.parse("2026-06-01T20:00:00Z"), status: "a" };
  it("salto que SAI do status da base depois dela (humano/cascata/MCP/outro run) ⇒ sim; antes, ou só deste run ⇒ não", () => {
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z")], CARD, BASE, "r1")).toBe(true);
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z", { actor: "cascade" })], CARD, BASE, "r1")).toBe(true);
    expect(statusMovedSince([hop("2026-06-01T19:59:00Z")], CARD, BASE, "r1")).toBe(false);
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z", { actor: "run:harness-do", runId: "r1" }), hop("2026-06-01T20:06:00Z", { actor: "merge", runId: "r1" })], CARD, BASE, "r1")).toBe(false);
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z", { actor: "run:harness-do", runId: "r2" })], CARD, BASE, "r1")).toBe(true);
  });
  it("A→C→A depois da base ⇒ sim (o salto A→C é a prova, mesmo com o card de volta em A)", () => {
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z", { from: "a", to: "c" }), hop("2026-06-01T20:06:00Z", { from: "c", to: "a" })], CARD, BASE, "r1")).toBe(true);
  });
  // Revisão do WP5-F2: contar QUALQUER salto posterior à base descartava o avanço do run no caso comum.
  it("salto CONSULTIVO (from == to: merge:approved/parked, resolve:*) de outro run, logo depois do commit de aterrissagem ⇒ não", () => {
    const consult = (note: string) => hop("2026-06-01T20:00:02Z", { from: "a", to: "a", actor: "merge", runId: "r0", note });
    for (const note of ["merge:approved", "merge:reproved", "merge:parked", "resolve:resolved-cosmetic"]) {
      expect(statusMovedSince([consult(note)], CARD, BASE, "r1")).toBe(false);
    }
  });
  it("o salto que LEVOU o card ao status da base no mesmo segundo do commit (%ct é em segundos) ⇒ não", () => {
    expect(statusMovedSince([hop("2026-06-01T20:00:00.400Z", { from: "priorizar", to: "a", actor: "cascade" })], CARD, BASE, "r1")).toBe(false);
  });
  it("outro card, base sem instante legível ou sem status ⇒ não", () => {
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z", { cardId: "x" })], CARD, BASE)).toBe(false);
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z")], CARD, { atMs: Number.NaN, status: "a" })).toBe(false);
    expect(statusMovedSince([hop("2026-06-01T20:05:00Z")], CARD, { atMs: BASE.atMs, status: null })).toBe(false);
  });
});

describe("commitInstantMs — o %ct do commit-base em ms", () => {
  it("segundos ⇒ ms; vazio ou não numérico ⇒ NaN (nunca 0, que contaria o ledger inteiro)", () => {
    expect(commitInstantMs("1759348800\n")).toBe(1759348800_000);
    expect(commitInstantMs("")).toBeNaN();
    expect(commitInstantMs("  ")).toBeNaN();
    expect(commitInstantMs("fatal: bad object")).toBeNaN();
  });
});


describe("rehomeTransitionsRaw — o histórico de status acompanha o card que mudou de board", () => {
  it("só as linhas daquele card naquele board mudam de board; as outras ficam byte a byte (inclusive as ilegíveis)", () => {
    const lines = [
      JSON.stringify({ v: 1, at: "2026-05-01T00:00:00Z", board: "estufa", cardId: "c1", from: null, to: "triage", actor: "human" }),
      "linha torta",
      JSON.stringify({ v: 1, at: "2026-05-02T00:00:00Z", board: "estufa", cardId: "c2", from: null, to: "triage", actor: "human" }),
      JSON.stringify({ v: 1, at: "2026-05-03T00:00:00Z", board: "galpao", cardId: "c1", from: null, to: "triage", actor: "human" }),
      JSON.stringify({ v: 1, at: "2026-05-04T00:00:00Z", board: "estufa", cardId: "c1", from: "triage", to: "enriquecer", actor: "cascade" }),
      "",
    ];
    const out = rehomeTransitionsRaw(lines.join("\n"), "estufa", "c1", "galpao");
    expect(out.moved).toBe(2);
    const back = out.raw.split("\n");
    expect(back[1]).toBe("linha torta");
    expect(back[2]).toBe(lines[2]);
    expect(back[3]).toBe(lines[3]);
    expect(parseTransitionsLines(out.raw, { board: "galpao", cardId: "c1" }).map((t) => t.to)).toEqual(["triage", "triage", "enriquecer"]);
    expect(parseTransitionsLines(out.raw, { board: "estufa", cardId: "c1" })).toEqual([]);
  });
});
