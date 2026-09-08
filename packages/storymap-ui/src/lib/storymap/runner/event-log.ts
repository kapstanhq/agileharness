import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { RunnerEngine, RunCompletion } from "./engine";

export interface RunEvent extends RunCompletion {
  type: "settled";
  at: number;
}

// story-harness-adk A3: cap mirroring telemetry's MAX_RECORDS (1000) and journal's MAX_DONE_RETAINED
// (200) — events.jsonl was the ONLY runner ledger WITHOUT one. An append-only file on a long-lived
// systemd service (the never-kill guardrail discourages restarts) grows unbounded for days and inflates
// the SSE `tail -f` backlog.
const MAX_EVENT_LINES = 2000;

/** Appends a JSONL line to storymap/.runner/events.jsonl. Fire-and-forget — never throws. */
function appendEvent(ev: RunEvent): void {
  try {
    const dir = runnerStateDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(ev) + "\n", "utf8");
  } catch (err) {
    console.error("[harness-event-log] failed to append event", err instanceof Error ? err.message : err);
  }
}

/**
 * story-harness-adk A3: trim events.jsonl to its last `maxLines` lines, atomically (tmp+rename). Run
 * ONCE per boot (setupEventLog), NEVER per append: the SSE `id: <lineNumber>` resume (event-stream.ts)
 * is POSITIONAL, so renumbering lines is safe only across a restart — when every client reconnects and
 * re-establishes its cursor anyway. Best-effort: an absent/unreadable file is a no-op and it never
 * throws on the boot path. Pure I/O over `dir`; exported for tests.
 */
export function rotateEventLog(dir: string, maxLines = MAX_EVENT_LINES): void {
  const file = path.join(dir, "events.jsonl");
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
    if (lines.length <= maxLines) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, lines.slice(lines.length - maxLines).join("\n") + "\n", "utf8");
    renameSync(tmp, file); // atomic; overwrites on win32 via MoveFileEx
  } catch {
    // absent / unreadable → nothing to rotate; best-effort, never throw on boot
  }
}

/** Subscribes to engine.onComplete and appends every settled run to events.jsonl. */
export function setupEventLog(engine: RunnerEngine): void {
  rotateEventLog(runnerStateDir()); // A3: cap the backlog once per boot, before the SSE tail resumes
  engine.onComplete((ev: RunCompletion) => {
    appendEvent({ ...ev, type: "settled", at: Date.now() });
  });
}
