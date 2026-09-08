import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rotateEventLog } from "./event-log";

// story-harness-adk A3: the events.jsonl ledger gained a boot-time cap (it was the only runner ledger
// without one). rotateEventLog is the pure I/O primitive — tested here against temp files.
describe("rotateEventLog (story-harness-adk A3)", () => {
  let dir: string;
  const file = () => path.join(dir, "events.jsonl");
  const lines = (n: number, prefix = "e"): string => Array.from({ length: n }, (_, i) => `{"${prefix}":${i}}`).join("\n") + "\n";

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "evlog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op (never throws) when the file is absent", () => {
    expect(() => rotateEventLog(dir, 10)).not.toThrow();
  });

  it("leaves the file untouched when it is at/under the cap", () => {
    writeFileSync(file(), lines(5), "utf8");
    rotateEventLog(dir, 10);
    expect(readFileSync(file(), "utf8")).toBe(lines(5));
  });

  it("trims to the LAST maxLines lines when over the cap", () => {
    writeFileSync(file(), lines(20), "utf8");
    rotateEventLog(dir, 5);
    const kept = readFileSync(file(), "utf8").trim().split("\n");
    expect(kept).toHaveLength(5);
    // The most recent lines are kept (15..19), the oldest dropped.
    expect(kept[0]).toBe('{"e":15}');
    expect(kept[4]).toBe('{"e":19}');
  });

  it("preserves each kept line's raw JSON byte-for-byte (so the SSE tail still parses)", () => {
    const raw = '{"type":"settled","board":"storymap","cardId":"c1","at":1}';
    writeFileSync(file(), `{"old":1}\n{"old":2}\n${raw}\n`, "utf8");
    rotateEventLog(dir, 1);
    expect(readFileSync(file(), "utf8")).toBe(`${raw}\n`);
  });

  it("ignores blank lines when counting (a trailing newline doesn't inflate the count)", () => {
    writeFileSync(file(), lines(3) + "\n\n", "utf8");
    rotateEventLog(dir, 3); // 3 real lines, under/at cap → untouched
    expect(readFileSync(file(), "utf8").trim().split("\n").filter((l) => l.length > 0)).toHaveLength(3);
  });
});
