import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventsStream, formatEventFrame, startLineFromLastEventId } from "./event-stream";

// --- pure helpers ---------------------------------------------------------

describe("startLineFromLastEventId", () => {
  it("returns 0 when the header is absent (fresh connection streams from the top)", () => {
    expect(startLineFromLastEventId(null)).toBe(0);
  });

  it("resumes at id+1 so the last-received line is never re-sent", () => {
    expect(startLineFromLastEventId("0")).toBe(1);
    expect(startLineFromLastEventId("5")).toBe(6);
  });

  it("treats a blank, non-numeric or negative header as a fresh stream (0)", () => {
    expect(startLineFromLastEventId("")).toBe(0);
    expect(startLineFromLastEventId("abc")).toBe(0);
    expect(startLineFromLastEventId("-3")).toBe(0);
  });
});

describe("formatEventFrame", () => {
  it("emits an SSE frame keyed by the physical line number", () => {
    expect(formatEventFrame(2, '{"a":1}')).toBe('id: 2\ndata: {"a":1}\n\n');
  });
});

// --- streaming core (real temp files) ------------------------------------

function parseFrames(buf: string): Array<{ id?: string; data?: string }> {
  return buf
    .split("\n\n")
    .map((block) => {
      const f: { id?: string; data?: string } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) f.id = line.slice(4);
        else if (line.startsWith("data: ")) f.data = line.slice(6);
      }
      return f;
    })
    .filter((f) => f.data !== undefined);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A live reader over the stream that accumulates chunks until a predicate holds. */
function makeReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async waitFor(pred: (buf: string) => boolean, timeoutMs = 1500): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!pred(buf)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timeout; buffer so far:\n${buf}`);
        const res = await Promise.race([
          reader.read(),
          sleep(remaining).then(() => "TIMEOUT" as const),
        ]);
        if (res === "TIMEOUT") throw new Error(`timeout; buffer so far:\n${buf}`);
        if (res.done) break;
        buf += dec.decode(res.value, { stream: true });
      }
      return buf;
    },
    buffer: () => buf,
    async close() {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    },
  };
}

describe("createEventsStream", () => {
  const tmps: string[] = [];
  let open: Array<{ close: () => Promise<void> }> = [];

  function tmpFile(contents = ""): string {
    const dir = mkdtempSync(path.join(tmpdir(), "events-stream-"));
    tmps.push(dir);
    const file = path.join(dir, "events.jsonl");
    writeFileSync(file, contents, "utf8");
    return file;
  }

  afterEach(async () => {
    for (const r of open) await r.close();
    open = [];
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("streams every existing line as an SSE frame keyed by line number", async () => {
    const file = tmpFile('{"n":0}\n{"n":1}\n{"n":2}\n');
    const stream = createEventsStream(file, { pollMs: 20, heartbeatMs: 10_000 });
    const r = makeReader(stream);
    open.push(r);

    const buf = await r.waitFor((b) => parseFrames(b).length >= 3);
    const frames = parseFrames(buf);
    expect(frames).toEqual([
      { id: "0", data: '{"n":0}' },
      { id: "1", data: '{"n":1}' },
      { id: "2", data: '{"n":2}' },
    ]);
  });

  it("resumes after startLine without re-sending earlier lines (Last-Event-ID)", async () => {
    const file = tmpFile('{"n":0}\n{"n":1}\n{"n":2}\n');
    const stream = createEventsStream(file, { startLine: 2, pollMs: 20, heartbeatMs: 10_000 });
    const r = makeReader(stream);
    open.push(r);

    const buf = await r.waitFor((b) => parseFrames(b).length >= 1);
    const frames = parseFrames(buf);
    // Only line index 2 survives; 0 and 1 were already delivered before the disconnect.
    expect(frames).toEqual([{ id: "2", data: '{"n":2}' }]);
  });

  it("tails newly appended lines in real time (no polling on the client)", async () => {
    const file = tmpFile('{"n":0}\n');
    const stream = createEventsStream(file, { pollMs: 20, heartbeatMs: 10_000 });
    const r = makeReader(stream);
    open.push(r);

    await r.waitFor((b) => parseFrames(b).length >= 1);
    appendFileSync(file, '{"n":1}\n', "utf8");

    const buf = await r.waitFor((b) => parseFrames(b).length >= 2);
    expect(parseFrames(buf)).toEqual([
      { id: "0", data: '{"n":0}' },
      { id: "1", data: '{"n":1}' },
    ]);
  });

  it("ignores a partial trailing line until its newline arrives", async () => {
    const file = tmpFile('{"n":0}\n');
    const stream = createEventsStream(file, { pollMs: 20, heartbeatMs: 10_000 });
    const r = makeReader(stream);
    open.push(r);

    await r.waitFor((b) => parseFrames(b).length >= 1);
    appendFileSync(file, '{"n":1', "utf8"); // no trailing newline yet
    await sleep(80);
    expect(parseFrames(r.buffer()).length).toBe(1); // partial line not emitted

    appendFileSync(file, '}\n', "utf8"); // complete it
    const buf = await r.waitFor((b) => parseFrames(b).length >= 2);
    expect(parseFrames(buf)[1]).toEqual({ id: "1", data: '{"n":1}' });
  });

  it("opens the stream even when the file does not exist yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "events-stream-"));
    tmps.push(dir);
    const file = path.join(dir, "does-not-exist-yet.jsonl");
    const stream = createEventsStream(file, { pollMs: 20, heartbeatMs: 10_000 });
    const r = makeReader(stream);
    open.push(r);

    // Connection holds open (": connected" preamble) and the poller picks the file up once written.
    await r.waitFor((b) => b.includes(": connected"));
    writeFileSync(file, '{"n":0}\n', "utf8");
    const buf = await r.waitFor((b) => parseFrames(b).length >= 1);
    expect(parseFrames(buf)).toEqual([{ id: "0", data: '{"n":0}' }]);
  });

  it("sends heartbeat comments to keep the connection alive", async () => {
    const file = tmpFile("");
    const stream = createEventsStream(file, { pollMs: 1000, heartbeatMs: 30 });
    const r = makeReader(stream);
    open.push(r);

    const buf = await r.waitFor((b) => b.includes(": ping"));
    expect(buf).toContain(": ping");
  });

  it("clears its pollers on cancel() (client disconnect)", async () => {
    const file = tmpFile('{"n":0}\n');
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const stream = createEventsStream(file, { pollMs: 20, heartbeatMs: 30 });
    const reader = stream.getReader();
    await reader.read(); // ensure start() ran and the intervals are armed
    await reader.cancel();
    // both the tail poller and the heartbeat interval are torn down
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
