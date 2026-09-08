// claude-pidfile — the pid → Claude-session registry the CLI itself maintains, and the ONLY exact way
// to say "the session running in THIS tmux pane is <sessionId>".
//
// WHY THIS EXISTS. A bare interactive `claude` carries no session id anywhere we can reach: `/proc/<pid>/
// cmdline` is literally `claude` and the uuid is absent from `environ` — so the argv path
// (`sessionIdOf`, process-attribution.ts:70) resolves only the headless runs the runner spawned with
// `--session-id`. Everything else would have to be GUESSED, and the guess we reproduced live
// (newest-mtime transcript in the cwd dir) returned another session's 384,725 tok for a pane actually
// holding 146,979 — a silent 2.6× lie on 5/5 samples. The CLI, meanwhile, already writes the exact
// mapping down. We read it. No hook of ours, no ledger of ours, no new machinery to keep in sync.
//
// WHAT IS ON DISK (measured on this box, claude 2.1.218 — verbatim sample):
//   <configDir>/sessions/<pid>.json, one file per LIVE claude process, e.g.
//   {"pid":4125152,"sessionId":"4aa0a1a0-…","cwd":"/root/meu-monorepo","startedAt":1784813927749,
//    "procStart":"420700166","version":"2.1.218","peerProtocol":1,"kind":"interactive",
//    "entrypoint":"cli","name":"meu-monorepo-b7","nameSource":"derived","status":"busy",
//    "updatedAt":1784813994111,"statusUpdatedAt":1784813994111}
//   configDir = $CLAUDE_CONFIG_DIR ?? ~/.claude. Both interactive and headless (`-p`) runs write one.
//
// THE TWO FACTS THAT MAKE IT TRUSTWORTHY, and the trap each closes:
//   • `procStart` is EXACTLY field 22 (starttime, in clock ticks) of `/proc/<pid>/stat` — verified by
//     direct comparison against two live pids. It is the PID-REUSE GUARD: a recycled pid gets a new
//     starttime, so a stale file can never be attributed to the process that inherited its pid. Without
//     this check the module would eventually hand an operator a dead session's context number for a
//     live pane — the exact class of silent lie it was built to kill.
//   • The file is created at process start and REMOVED on clean exit (watched a headless `claude -p`
//     appear at t=2s and vanish by t=4s). So a LEFTOVER file means the process was SIGKILLed, and the
//     liveness probe below is what catches it.
//
// PARSING `/proc/<pid>/stat` — the real bug this avoids: field 2 (`comm`) is wrapped in parentheses and
// MAY CONTAIN SPACES AND PARENTHESES (the kernel does not escape it). A `split(/\s+/)` on the whole line
// silently shifts every field for such a process. We slice after the LAST ")" and index from there.
//
// WHAT THIS MODULE MUST NEVER DO:
//   • never WRITE into that directory — it is the CLI's state, we are a reader (a second writer would
//     race the CLI's own lifecycle and could resurrect a session the CLI just retired);
//   • never treat a pidfile as proof of a live session without the liveness probe (leftovers exist);
//   • never fall back to mtime/newest-file heuristics when a pid is unmapped — absent is a value,
//     a guess is a lie;
//   • never throw: every IO entry point degrades to null / an empty Map so the caller can render an
//     honest "não sei" instead of a fabricated number.
//
// SERVER-ONLY (node:fs, /proc → Linux).

import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** One `<configDir>/sessions/<pid>.json`, coerced. Only `pid`/`sessionId` are guaranteed; every other
 *  field degrades (a future CLI may drop or rename any of them and this must keep working). */
export interface ClaudePidfile {
  pid: number;
  sessionId: string;
  /** the session's working dir; "" when the file omits it (the interface cannot carry null here) */
  cwd: string;
  startedAt: number | null;
  /** field 22 of /proc/<pid>/stat, as written by the CLI — compared as a STRING, never as a number */
  procStart: string | null;
  version: string | null;
  /** "interactive" for a CLI session; headless runs report their own kind */
  kind: string | null;
  name: string | null;
  nameSource: string | null;
  status: string | null;
  updatedAt: number | null;
  /**
   * epoch ms em que o CLI gravou o `status` ATUAL — a IDADE do flag busy/idle, e a diferença entre
   * "está num turno" e "ficou latchado". O arquivo não é heartbeat: medido nesta caixa, um turno em
   * andamento NÃO reescreve o campo (18s de trabalho contínuo, valor idêntico), então isto é
   * literalmente "há quanto tempo o CLI mudou de estado pela última vez". Um `busy` de 42,6h já foi
   * observado aqui. Ver `cliFlagExpired`.
   */
  statusUpdatedAt: number | null;
}

/** `/proc/<pid>/stat` fields after the closing ")" start at field 3 (state), so field 22 sits at 19. */
const STARTTIME_INDEX_AFTER_COMM = 19;

/** `<pid>.json` and nothing else — anything the CLI (or a stray editor) leaves behind is ignored. */
const PIDFILE_NAME = /^(\d+)\.json$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** $CLAUDE_CONFIG_DIR ?? ~/.claude — read at CALL time, so a test (or an operator) can redirect it. */
function sessionsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "sessions");
}

/**
 * PURE + TOLERANT. `null` on anything that is not a JSON object carrying an integer `pid` and a
 * non-empty `sessionId` — those two ARE the mapping, and a record missing either maps nothing. Every
 * other field degrades to null (empty strings included: an empty `procStart` must not read as "this
 * file carries a starttime", or `isPidfileLive` would compare against "" and reject a live process).
 */
export function parsePidfile(raw: string): ClaudePidfile | null {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const pid = obj.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  const sessionId = str(obj.sessionId);
  if (!sessionId) return null;

  return {
    pid,
    sessionId,
    cwd: typeof obj.cwd === "string" ? obj.cwd : "",
    startedAt: num(obj.startedAt),
    procStart: str(obj.procStart),
    version: str(obj.version),
    kind: str(obj.kind),
    name: str(obj.name),
    nameSource: str(obj.nameSource),
    status: str(obj.status),
    updatedAt: num(obj.updatedAt),
    statusUpdatedAt: num(obj.statusUpdatedAt),
  };
}

/**
 * PURE over an injected probe (so it is exhaustively testable with no /proc at all).
 *
 * True only when the probe reports the pid as ALIVE and — when the pidfile carries a `procStart` — the
 * two starttimes match EXACTLY. A mismatch is a recycled pid wearing a dead session's file, and it is
 * the single most dangerous case here: it would attribute a stale sessionId (and therefore someone
 * else's transcript) to a live process.
 *
 * A pidfile with NO `procStart` (an older CLI that did not write the field) is accepted on mere
 * liveness — degraded but honest: we lose the reuse guard, we do not lose the mapping.
 */
export function isPidfileLive(f: ClaudePidfile, probe: { procStartOf(pid: number): string | null }): boolean {
  const live = probe.procStartOf(f.pid);
  if (live === null) return false;
  if (f.procStart === null) return true;
  return f.procStart === live;
}

/**
 * PURE. Field 22 (starttime) of a `/proc/<pid>/stat` line, as a string.
 *
 * Slices after the LAST ")" because field 2 (`comm`) is parenthesised and may contain spaces and
 * parentheses — `"123 (weird (name) here) S 1 2 3 …"` is a legal line, and a naive whitespace split
 * would read field 22 off by however many spaces the process name happens to contain.
 * `null` when the line has no ")", too few fields, or a non-numeric starttime.
 */
export function parseProcStatStarttime(raw: string): string | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  const after = raw.slice(close + 1).trim();
  if (!after) return null;
  const starttime = after.split(/\s+/)[STARTTIME_INDEX_AFTER_COMM];
  return starttime && /^\d+$/.test(starttime) ? starttime : null;
}

/**
 * IO. The live starttime of `pid`, or null on ANY failure — no /proc (non-Linux), dead pid (ENOENT),
 * or EACCES. Null means "cannot prove this pid is alive", never "it is dead but here is a 0".
 */
export function procStartOf(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStatStarttime(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * IO. Every LIVE Claude session on the box, keyed by pid. Never throws — an empty Map on a missing
 * directory, an unreadable dir, or a box with no claude running.
 *
 * Three filters, each dropping a distinct lie:
 *   1. the filename must be `<digits>.json` (ignores anything else living in that dir);
 *   2. the parsed `pid` must EQUAL the filename's pid (a copied/renamed file would otherwise register
 *      a session under a pid that never ran it);
 *   3. `isPidfileLive` against real /proc (drops SIGKILL leftovers and recycled pids).
 */
export function readPidfiles(): Map<number, ClaudePidfile> {
  const out = new Map<number, ClaudePidfile>();
  const dir = sessionsDir();

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }

  for (const name of names) {
    try {
      const m = PIDFILE_NAME.exec(name);
      if (!m) continue;
      const filePid = Number(m[1]);
      const parsed = parsePidfile(readFileSync(path.join(dir, name), "utf8"));
      if (!parsed || parsed.pid !== filePid) continue;
      if (!isPidfileLive(parsed, { procStartOf })) continue;
      out.set(parsed.pid, parsed);
    } catch {
      /* one bad file never costs us the rest of the box */
    }
  }
  return out;
}
