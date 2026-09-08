// The transport core for `GET /api/runner/events`: a `tail -f` over
// storymap/.runner/events.jsonl exposed as a Server-Sent Events stream. Kept out of
// the route handler so the polling/resume logic is unit-testable against temp files
// (the route just wires auth + the Last-Event-ID header into this).
//
// Design (see plans/story-080fo9.md):
// - Size-based polling, NOT fs.watch — simpler and portable (poll-mode FS, bind mounts).
// - Each physical line gets `id: <lineNumber>` so a reconnecting client can resume via
//   Last-Event-ID with no duplicates and no server-side session state.
// - A partial trailing line (write in progress) is buffered, never emitted, until its
//   newline arrives on a later tick.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface EventsStreamOptions {
  /** First physical line index to emit (Last-Event-ID + 1). Lines below it are skipped. */
  startLine?: number;
  /** Tail poll interval in ms (how fast new appends are picked up). */
  pollMs?: number;
  /** SSE keep-alive comment interval in ms. */
  heartbeatMs?: number;
}

const DEFAULT_POLL_MS = 200;
const DEFAULT_HEARTBEAT_MS = 25_000;

/**
 * Parse an SSE `Last-Event-ID` header into the next line index to emit.
 * Absent / blank / non-numeric / negative all mean "stream from the top" (0); a valid
 * `n` resumes at `n + 1` so the last line the client already received is never re-sent.
 */
export function startLineFromLastEventId(header: string | null): number {
  if (header == null) return 0;
  const n = Number.parseInt(header, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return n + 1;
}

/** Format one events.jsonl line as an SSE frame, keyed by its physical line number. */
export function formatEventFrame(lineNumber: number, rawLine: string): string {
  return `id: ${lineNumber}\ndata: ${rawLine}\n\n`;
}

/** Read the bytes appended since `fromOffset`. Throws if the file is missing (caller retries). */
function readNewBytes(filePath: string, fromOffset: number): { text: string; newOffset: number } {
  const st = statSync(filePath); // throws ENOENT while the file does not exist yet
  if (st.size <= fromOffset) return { text: "", newOffset: fromOffset };
  const fd = openSync(filePath, "r");
  try {
    const len = st.size - fromOffset;
    const buf = Buffer.alloc(len);
    const bytesRead = readSync(fd, buf, 0, len, fromOffset);
    return { text: buf.toString("utf8", 0, bytesRead), newOffset: fromOffset + bytesRead };
  } finally {
    closeSync(fd);
  }
}

/**
 * Build the SSE `ReadableStream` for an events.jsonl file. The stream emits every existing
 * line at/after `startLine`, then tails new appends via polling, with periodic heartbeats.
 * All timers are torn down on `cancel()` (client disconnect) or when an enqueue fails
 * (stream already closed).
 */
export function createEventsStream(filePath: string, opts: EventsStreamOptions = {}): ReadableStream<Uint8Array> {
  const startLine = Math.max(0, opts.startLine ?? 0);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const encoder = new TextEncoder();

  let poll: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cursor = 0; // bytes consumed from the file so far
  let lineNumber = 0; // next physical line index (counts skipped + blank lines too, so ids == file position)
  let partial = ""; // buffered trailing bytes without a terminating newline

  const teardown = () => {
    if (poll) clearInterval(poll);
    if (heartbeat) clearInterval(heartbeat);
    poll = heartbeat = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string): boolean => {
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false; // stream already closed
        }
      };

      const drainNewLines = () => {
        let chunk: { text: string; newOffset: number };
        try {
          chunk = readNewBytes(filePath, cursor);
        } catch {
          return; // file missing or transiently unreadable — retry on the next tick
        }
        if (!chunk.text) return;
        cursor = chunk.newOffset;
        partial += chunk.text;
        let idx: number;
        while ((idx = partial.indexOf("\n")) !== -1) {
          const raw = partial.slice(0, idx);
          partial = partial.slice(idx + 1);
          const n = lineNumber++;
          if (n >= startLine && raw.length > 0) {
            if (!safeEnqueue(formatEventFrame(n, raw))) {
              teardown();
              return;
            }
          }
        }
      };

      safeEnqueue(": connected\n\n");
      drainNewLines(); // emit the backlog immediately, before the first poll tick
      poll = setInterval(drainNewLines, pollMs);
      heartbeat = setInterval(() => {
        if (!safeEnqueue(": ping\n\n")) teardown();
      }, heartbeatMs);
    },
    cancel() {
      teardown();
    },
  });
}
