import { describe, expect, it, afterEach } from "vitest";
import {
  appendTransition,
  compactTransitions,
  parseTransitionsLines,
  setTransitionSink,
  resetTransitionSink,
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
