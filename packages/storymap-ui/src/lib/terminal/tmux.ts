// tmux query layer for the web terminal (/terminal).
//
// The terminal page can only ATTACH to a session whose name it already knows (it arrives in the
// `?b=` arg). To offer a session PICKER — and to tell the user honestly whether the session being
// opened already exists or is about to be created (attach vs create) — the page needs to see what
// the tmux server is actually hosting. That is what this module provides.
//
// Server-only (spawns `tmux`). Parsing is split out as a PURE function so it is testable without a
// tmux server: `parseSessionList` takes the raw stdout, the IO wrappers run the commands.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** One live tmux session, as the picker needs it. */
export interface TmuxSession {
  name: string;
  /** windows in the session — a rough "how much is going on here" */
  windows: number;
  /** epoch ms the session was created */
  createdAt: number;
  /** a client is currently attached (another tab, or the desktop) */
  attached: boolean;
  /** cwd of the active pane — what `ls` would list there */
  path: string;
  /** command running in the active pane (e.g. `claude`, `bash`) */
  command: string;
  /** pane title (OSC-2 / tmux `set-titles`) — a program-or-agent-set "what is this doing now" line.
   *  Usually the tmux default (hostname/command) until something sets it; the enrich layer only
   *  surfaces it when it looks intentional. */
  paneTitle: string;
}

// Field separator: TAB, and this is NOT interchangeable with a "nicer" control byte.
//
// MEASURED on the VPS (tmux 3.4): `-F` output does NOT pass control bytes through — tmux rewrites
// non-printable characters as their OCTAL ESCAPE, as TEXT. Asking for 0x1f gave back the four
// literal characters `\037`, so the split never matched and EVERY field landed inside `name`
// (which is why path/command came back empty and `attached` was always false). TAB (0x09) is the
// exception that survives verbatim — verified against the live server.
//
// It is safe as a separator because every field we ask for is tab-free in practice: the session
// name is a strict slug (attach-session.sh), and paths/commands with a tab do not occur here.
// Exported so a test can assert the format never regresses to a rewritten control byte.
export const SEP = "\t";
export const LIST_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{session_created}",
  "#{session_attached}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_title}",
].join(SEP);

/**
 * PURE: raw `tmux list-sessions -F <LIST_FORMAT>` stdout → sessions.
 * Unparseable lines are skipped rather than thrown on — a partially readable list is far more
 * useful to a picker than an error, and tmux versions differ in which formats they support.
 */
export function parseSessionList(stdout: string): TmuxSession[] {
  const out: TmuxSession[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // pane_title can itself carry no tab (tmux rewrites control bytes), so a fixed-arity split is
    // safe; `paneTitle` is the LAST field so a title with an unexpected char can't shift the others.
    const [name, windows, created, attached, panePath, command, paneTitle] = line.split(SEP);
    if (!name) continue;
    out.push({
      name,
      windows: Number.parseInt(windows ?? "", 10) || 1,
      // tmux reports session_created in SECONDS; the UI works in ms.
      createdAt: (Number.parseInt(created ?? "", 10) || 0) * 1000,
      // `||`, not `??`: an EMPTY field (older tmux that doesn't know the format) must read as
      // not-attached. With `??` it stayed "" — and "" !== "0" — so every session showed up as
      // attached, which the picker renders as "someone else is watching this".
      attached: (attached || "0") !== "0",
      path: panePath ?? "",
      command: command ?? "",
      paneTitle: paneTitle ?? "",
    });
  }
  return out;
}

/**
 * Live sessions, newest first. Returns [] (never throws) when there is no tmux server at all —
 * to the picker, "no server" and "no sessions" are the same thing.
 */
export async function listSessions(): Promise<TmuxSession[]> {
  try {
    const { stdout } = await exec("tmux", ["list-sessions", "-F", LIST_FORMAT], { timeout: 5_000 });
    return parseSessionList(stdout).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/**
 * Snapshot of a session's visible output, used to tell whether it is still producing.
 * `-p` prints to stdout; `-S -<n>` starts n lines above the bottom of the pane.
 * Returns null when the session is gone — the caller treats that as "stop watching".
 */
export async function capturePane(session: string, lines = 40): Promise<string | null> {
  try {
    const { stdout } = await exec("tmux", ["capture-pane", "-p", "-t", session, "-S", `-${lines}`], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}
