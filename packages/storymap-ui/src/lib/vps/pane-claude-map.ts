// "Which Claude session is running in THIS tmux pane?" — the join that lets the web terminal show a
// real context reading instead of a guess.
//
// This is the whole difficulty of the feature. The Claude CLI writes its transcript to
// `<configDir>/projects/<slug(cwd)>/<sessionId>.jsonl`, but from OUTSIDE the process neither the
// pane nor the process advertises that sessionId: a bare interactive `claude` has the literal
// argv `claude`, an empty `environ` as far as session identity goes, and — measured on this box —
// ZERO regular files among its 40+ open fds (the CLI opens, appends and closes).
//
// MEASURED AND REJECTED — newest-mtime attribution. Picking the most recently modified transcript in
// the resolved project dir returned ANOTHER session's 384,725 tokens for a pane actually holding
// 146,979, on 5 of 5 samples: a silent 2.6× lie, and worse than showing nothing. `findNewTranscript`
// (claude-transcript.ts) is never called from here, and no directory is ever scanned or ranked.
// The regression test that pins this is "NUNCA escolhe por mtime" in the co-located suite.
//
// So the resolution is EXACT or absent, in three tiers, each of which knows the id rather than
// inferring it:
//   1. registry — a fleet `AgentSession` pinned `transcriptFile` when it spawned the session.
//   2. pidfile  — `<configDir>/sessions/<pid>.json`, which the CLI itself maintains for every live
//                 process (interactive AND headless), keyed by pid and carrying the sessionId, the
//                 cwd, the agent's self-chosen name and its busy/idle status. See claude-pidfile.ts.
//   3. argv     — the `--session-id`/`--resume` uuid a headless run carries, paired with the
//                 process cwd.
// Nothing below tier 3. "I could not tell" is a first-class answer (`unmapped`), and the UI renders
// it as such.
//
// Server-only (spawns tmux/ps, reads /proc). `resolvePaneSession` is PURE over injected snapshots so
// every tier and every refusal is unit-testable with no box state at all.

import os from "node:os";
import path from "node:path";
import { readlinkSync } from "node:fs";
import { listProcesses, listPaneOwners } from "./tmux";
import { attributeClaudeProcesses, sessionIdOf, type PaneOwner, type ProcRow } from "./process-attribution";
import { readPidfiles, type ClaudePidfile } from "./claude-pidfile";
import { allSessions, type AgentSession } from "@/lib/storymap/runner/session-worktree";

/** Why a pane has no context reading. Each renders as a DIFFERENT sentence — see the meter route. */
export type ContextAbsentReason = "no-claude" | "unmapped" | "unreadable" | "no-usage";

/** Which tier answered. Exposed so the UI can say where a number came from, and so a regression
 *  that silently demotes tier 1 to tier 3 is visible instead of invisible. */
export type MapSource = "registry" | "pidfile" | "argv";

/** The live Claude process behind a pane, as the CLI's own pidfile describes it. */
export interface PaneClaude {
  pid: number;
  /** the name the agent derived for itself (e.g. `meu-monorepo-b7`), or null */
  name: string | null;
  /** the CLI's own busy/idle flag — a truer "what is it doing" than any heuristic we could build */
  status: string | null;
  /** epoch ms em que esse flag foi gravado — sem ele, `status` é uma afirmação sem data (ver
   *  `ClaudePidfile.statusUpdatedAt` e `cliFlagExpired`) */
  statusUpdatedAt: number | null;
  version: string | null;
}

export interface ResolvedPane {
  source: MapSource;
  /** null only when tier 1 knew a path without an id */
  sessionId: string | null;
  transcriptPath: string;
  cwd: string | null;
  /** model as the SPAWNER pinned it — may carry a `[1m]` suffix the transcript never does */
  model: string | null;
  claude: PaneClaude | null;
}

export type PaneResolution =
  | { ok: true; pane: ResolvedPane }
  | { ok: false; reason: "no-claude" | "unmapped"; claude: PaneClaude | null };

/** `$CLAUDE_CONFIG_DIR ?? <home>/.claude` — the same rule claude-pidfile.ts applies. */
function configDir(home?: string): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(home ?? os.homedir(), ".claude");
}

// A sessionId is a uuid, but we validate by SHAPE rather than by uuid-ness: the id is about to
// become a path segment, so the only thing that matters is that it cannot escape the directory.
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

/**
 * PURE. `<configDir>/projects/<slug>/<sessionId>.jsonl`, where the slug replaces every `/` and `.`
 * of the cwd with `-` (so `/root/meu-monorepo/.artifacts` → `-root-meu-monorepo--artifacts`).
 * Returns null for a sessionId that fails the traversal guard, or an empty cwd.
 *
 * CONSTRUCTED, never searched: this is what keeps the mtime lie out of the system.
 */
export function transcriptPathFor(sessionId: string, cwd: string, home?: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (!cwd) return null;
  // EVERY non-alphanumeric byte becomes `-`, which is the CLI's own rule (read out of the shipped
  // bundle). Slugging only `/` and `.` agrees with it on every path that happens to exist on this box,
  // but silently diverges the moment a cwd contains `_` or a space — and a wrong directory reads as
  // "transcript indisponível", i.e. the feature quietly disappearing for that pane.
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(configDir(home), "projects", slug, `${sessionId}.jsonl`);
}

function claudeOf(f: ClaudePidfile | undefined, pid: number): PaneClaude {
  return {
    pid,
    name: f?.name ?? null,
    status: f?.status ?? null,
    statusUpdatedAt: f?.statusUpdatedAt ?? null,
    version: f?.version ?? null,
  };
}

/**
 * PURE over injected snapshots. Walks the three tiers in order and refuses rather than guesses.
 *
 * `no-claude` (there is no live Claude in this pane) is checked FIRST and is not a failure: a plain
 * bash shell has no context, and the UI must render nothing rather than an empty gauge. A stale
 * registry row for a pane whose agent already died must NOT resurrect a reading — which is exactly
 * why the process check comes before the registry lookup.
 */
export function resolvePaneSession(input: {
  tmuxSession: string;
  panes: PaneOwner[];
  procs: ProcRow[];
  registry: AgentSession[];
  pidfiles: Map<number, ClaudePidfile>;
  /** `/proc/<pid>/cwd`, injected so the argv tier stays testable without a live process */
  cwdOf?: (pid: number) => string | null;
  home?: string;
}): PaneResolution {
  // Reuse the ONE definition of "a claude process, and who owns it" (process-attribution.ts). An
  // empty knownRunSessionIds is deliberate: we want the pane that HOSTS the agent, whether or not
  // the runner also claims it as a card run.
  const agents = attributeClaudeProcesses({
    procs: input.procs,
    panes: input.panes,
    knownRunSessionIds: new Set<string>(),
  });
  const hosted = agents.find((a) => a.owner.kind === "tmux" && a.owner.session === input.tmuxSession);
  if (!hosted) {
    // An EMPTY process table is impossible on a live box, so it means `ps` failed — and `no-claude` is
    // rendered as "nothing at all" (a bash shell legitimately has no context). Reporting that on a
    // failed probe would make the reading silently vanish for every pane, looking exactly like a box
    // with no agents. `unmapped` renders a muted "ctx —", which is the honest "I could not tell".
    if (input.procs.length === 0) return { ok: false, reason: "unmapped", claude: null };
    return { ok: false, reason: "no-claude", claude: null };
  }

  const pid = hosted.proc.pid;
  const pidfile = input.pidfiles.get(pid);
  const claude = claudeOf(pidfile, pid);
  const row = input.registry.find((s) => s.tmuxSession === input.tmuxSession);

  // Tier 1 — the CLI's OWN pidfile, keyed by the pid we just found in this pane's process tree and
  // already validated against /proc starttime. This is the only tier whose evidence ties the answer to
  // the actual living process, so it goes first.
  if (pidfile) {
    const p = transcriptPathFor(pidfile.sessionId, pidfile.cwd, input.home);
    if (p) {
      return {
        ok: true,
        pane: {
          source: "pidfile",
          sessionId: pidfile.sessionId,
          transcriptPath: p,
          cwd: pidfile.cwd,
          model: row?.model ?? null,
          claude,
        },
      };
    }
  }

  // Tier 2 — the fleet registry's pinned transcript. DELIBERATELY BELOW the pidfile, and this ordering
  // is the finding of a review, not a preference: `AgentSession.transcriptFile` is written by
  // session-spawn.ts as `findTranscript(startedAt)`, wired in production to `findNewTranscript` — the
  // newest-mtime scan over ~/.claude/projects that this module's header rejects. Trusting it FIRST
  // would have re-imported the 2.6x misattribution through the back door, wearing the highest-
  // confidence label. It is also matched only by tmux NAME, with no liveness check, so a stale row for
  // a reused session name can describe a long-dead agent. Kept as a fallback because for a pane whose
  // pidfile is missing (older CLI, or a process killed with SIGKILL leaving no file) it is still the
  // best evidence available — but it never outranks a fact.
  if (row?.transcriptFile) {
    return {
      ok: true,
      pane: {
        source: "registry",
        sessionId: row.sessionId ?? null,
        transcriptPath: row.transcriptFile,
        cwd: row.cwd ?? pidfile?.cwd ?? null,
        model: row.model ?? null,
        claude,
      },
    };
  }

  // Tier 3 — the uuid a headless run carries in its argv, paired with a cwd we can still establish.
  const argvId = sessionIdOf(hosted.proc);
  if (argvId) {
    const cwd = row?.cwd ?? (input.cwdOf ? input.cwdOf(pid) : null) ?? null;
    const p = cwd ? transcriptPathFor(argvId, cwd, input.home) : null;
    if (p) {
      return {
        ok: true,
        pane: { source: "argv", sessionId: argvId, transcriptPath: p, cwd, model: row?.model ?? null, claude },
      };
    }
  }

  // A live agent we could not name. Saying so is the honest answer; picking the newest file is not.
  return { ok: false, reason: "unmapped", claude };
}

/** IO: `/proc/<pid>/cwd`. Null on any failure (dead pid, EACCES, non-Linux). */
export function procCwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`) || null;
  } catch {
    return null;
  }
}

// Memo: one box snapshot serves every request inside the window. The meter polls every 15s per
// client, so a 5s TTL means a burst of tabs costs one probe, while a session that starts is picked
// up within a poll. Deliberately NOT shared with the kill guard, whose verdict must stay fresh.
const SNAPSHOT_TTL_MS = 5_000;
let snapAt = 0;
let snap: { panes: PaneOwner[]; procs: ProcRow[]; registry: AgentSession[]; pidfiles: Map<number, ClaudePidfile> } | null =
  null;

export function clearPaneMapCache(): void {
  snap = null;
  snapAt = 0;
}

/** IO. The live snapshot the resolver needs, memoised. Never throws — a failed probe degrades to an
 *  empty list, which resolves to `no-claude`/`unmapped` rather than to a wrong answer. */
async function snapshot(now: number): Promise<NonNullable<typeof snap>> {
  if (snap && now - snapAt < SNAPSHOT_TTL_MS) return snap;
  const [panes, procs, registry] = await Promise.all([
    listPaneOwners().catch(() => [] as PaneOwner[]),
    listProcesses().catch(() => [] as ProcRow[]),
    allSessions().catch(() => [] as AgentSession[]),
  ]);
  snap = { panes, procs, registry, pidfiles: readPidfiles() };
  snapAt = now;
  return snap;
}

/** IO. Resolve ONE pane, using the memoised box snapshot. */
export async function resolvePaneLive(tmuxSession: string, now: number = Date.now()): Promise<PaneResolution> {
  const s = await snapshot(now);
  return resolvePaneSession({ tmuxSession, ...s, cwdOf: procCwdOf });
}

/** IO. `sessionName → resolution` for every pane the box currently hosts. */
export async function paneClaudeMap(now: number = Date.now()): Promise<Map<string, PaneResolution>> {
  const s = await snapshot(now);
  const out = new Map<string, PaneResolution>();
  for (const pane of s.panes) {
    if (out.has(pane.session)) continue;
    out.set(pane.session, resolvePaneSession({ tmuxSession: pane.session, ...s, cwdOf: procCwdOf }));
  }
  return out;
}
