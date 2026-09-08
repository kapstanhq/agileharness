// Who is actually a Claude agent on this box, and WHO OWNS IT — the pure core behind the
// /processes list.
//
// The old rule was `ps | grep -i claude` over the WHOLE command line, and it lied three ways:
//   1. it matched a shell that merely MENTIONS claude in its args
//      (`bash -lc "… claude --continue …"` — the tmux wrapper is a *bash*, not an agent);
//   2. it matched ANY command whose path contains `/root/.claude/…` — which is every Bash
//      tool call any Claude session makes, so the page counted the very session reading it;
//   3. with no process tree, one agent surfaced as N rows (wrapper + agent + its children).
//
// The fix is IDENTITY, not string inference:
//   • an agent is a process whose kernel `comm` IS `claude` (or whose argv[0] basename is —
//     covers a shim/launcher). A command LINE that mentions claude proves nothing.
//   • ownership comes from the PROCESS TREE + the run registry, never from a name:
//       – a `--session-id`/`--resume <uuid>` that a live run knows  → that RUN owns it;
//       – an ancestor that is a tmux pane's process                 → that SESSION owns it;
//       – an ancestor that is itself a claude                       → the ROOT agent owns it
//         (sub-agents/tool children fold into their parent, never their own row);
//       – nothing above                                             → genuinely unattributed
//         (a claude started by hand over SSH) — surfaced as "externo", NOT as pipeline work.
//
// PURE + isomorphic (no node imports): `tmux.ts` feeds it the two `ps` tables and the tmux pane
// map; every rule here is unit-tested against a real `ps` capture from the VPS.

/** One row of the box's process table, joined from `ps -eo pid,ppid,etime,comm` + `-eo pid,args`. */
export interface ProcRow {
  pid: number;
  ppid: number;
  /** `ps` elapsed time, e.g. `3-09:43:05` */
  etime: string;
  /** the KERNEL's name for the executable (immune to a command line that merely mentions claude) */
  comm: string;
  /** the full command line */
  args: string;
}

/** A tmux pane's process (`tmux list-panes -a -F '#{session_name} #{pane_pid}'`) — the root of
 *  everything running inside that session. */
export interface PaneOwner {
  session: string;
  pid: number;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Guard against a malformed/cyclic ppid chain (a reparented pid can point anywhere). */
const MAX_ANCESTRY_HOPS = 64;

/** basename of argv[0] — `/root/.local/bin/claude --continue` → `claude`; `/bin/bash -c …` → `bash`. */
function argv0Basename(args: string): string {
  const argv0 = args.trim().split(/\s+/)[0] ?? "";
  return argv0.split("/").pop() ?? "";
}

/**
 * Os nomes de EXECUTÁVEL que são o agente. `claude.exe` é o binário nativo que o pacote instala
 * (`/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`), e o `/usr/bin/claude` do PATH é
 * um symlink para ele — a extensão não indica Windows nenhum.
 *
 * POR QUE ELE PRECISOU ENTRAR. Medido nesta caixa em 2026-07-31 (CLI 2.1.220): dos 8 processos claude
 * vivos, **6 tinham `comm = "claude.exe"`** — todo filho/fork (`--fork-session`, jobs em background)
 * nasce assim, e só as duas raízes lançadas pelo symlink liam `claude`. Um pane cuja raiz fosse um
 * desses caía em `no-claude`: sem contexto, sem estado, e invisível em /processes — a página deixando
 * de ver o agente por causa da forma como ele foi lançado.
 */
const CLAUDE_EXECUTABLES = new Set(["claude", "claude.exe"]);

/**
 * Is this row the Claude Code AGENT itself?
 *
 * Two accepted proofs, both about the EXECUTABLE — never about the rest of the command line:
 *   • `comm` is a known claude executable — what the kernel says it is executing (the normal case), or
 *   • argv[0]'s basename is one — a shim/launcher (e.g. a node wrapper installed as `claude`).
 *
 * Deliberately FALSE for `bash -lc "… claude …"` (comm=bash, argv0=bash) and for every Bash tool
 * call sourcing `/root/.claude/shell-snapshots/…` (comm=bash) — the two false positives that made
 * the page count itself.
 */
export function isClaudeProcess(p: Pick<ProcRow, "comm" | "args">): boolean {
  return CLAUDE_EXECUTABLES.has(p.comm.trim()) || CLAUDE_EXECUTABLES.has(argv0Basename(p.args));
}

/** The `--session-id`/`--resume` uuid a headless run carries in its args, or null. */
export function sessionIdOf(p: Pick<ProcRow, "args">): string | null {
  return p.args.match(UUID)?.[0]?.toLowerCase() ?? null;
}

/** A headless (`-p` / `--print`) agent — the runner's children — vs an interactive one. */
export function isHeadless(p: Pick<ProcRow, "args">): boolean {
  return /(^|\s)-p(\s|$)/.test(p.args) || /(^|\s)--print(\s|$)/.test(p.args);
}

/** Who owns an agent tree. `none` = started outside the system (SSH/manual) — inspectable, not pipeline. */
export type ClaudeOwner =
  | { kind: "run"; sessionId: string }
  | { kind: "tmux"; session: string }
  | { kind: "none" };

/** One AGENT (the root of its process tree), its folded children, and who owns it. */
export interface ClaudeAgent {
  proc: ProcRow;
  /** claude processes descending from this one (sub-agents / tool children) — folded, never own rows */
  childPids: number[];
  owner: ClaudeOwner;
  headless: boolean;
}

/**
 * Fold the box's process table into the AGENTS actually running, each attributed to its owner.
 *
 * Root-first: a claude whose ancestor is another claude is a CHILD (it never gets its own row) —
 * this is what collapsed the "one session, three rows" inflation. Ownership is then resolved for
 * each root in precedence order: a live run's session uuid (card-linked work) beats tmux ancestry
 * (a terminal merely HOSTS the agent), which beats nothing (external).
 */
export function attributeClaudeProcesses(input: {
  procs: ProcRow[];
  panes: PaneOwner[];
  /** session uuids the runner currently knows (live runs + resumable journal entries) */
  knownRunSessionIds: Set<string>;
}): ClaudeAgent[] {
  const byPid = new Map<number, ProcRow>();
  for (const p of input.procs) byPid.set(p.pid, p);

  const claudePids = new Set<number>();
  for (const p of input.procs) if (isClaudeProcess(p)) claudePids.add(p.pid);

  const paneByPid = new Map<number, string>();
  for (const pane of input.panes) paneByPid.set(pane.pid, pane.session);

  /** pids from `p` up to init, `p` first (bounded — a cyclic/self ppid can't hang the page). */
  const ancestry = (p: ProcRow): number[] => {
    const chain: number[] = [p.pid];
    const seen = new Set<number>([p.pid]);
    let cur = p;
    for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop++) {
      const parent = byPid.get(cur.ppid);
      if (!parent || seen.has(parent.pid)) break;
      chain.push(parent.pid);
      seen.add(parent.pid);
      cur = parent;
    }
    return chain;
  };

  // The ROOT agent of a claude = its topmost claude ancestor (itself when it has none).
  const rootOf = new Map<number, number>();
  for (const pid of claudePids) {
    const proc = byPid.get(pid)!;
    const chain = ancestry(proc);
    let root = pid;
    for (const anc of chain) if (claudePids.has(anc)) root = anc; // chain is child→parent, so the LAST hit is topmost
    rootOf.set(pid, root);
  }

  const agents: ClaudeAgent[] = [];
  for (const pid of claudePids) {
    if (rootOf.get(pid) !== pid) continue; // a child agent — folded into its root below
    const proc = byPid.get(pid)!;
    const childPids = [...claudePids].filter((c) => c !== pid && rootOf.get(c) === pid).sort((a, b) => a - b);

    // Ownership, in precedence order.
    let owner: ClaudeOwner = { kind: "none" };
    const sid = sessionIdOf(proc);
    if (sid && input.knownRunSessionIds.has(sid)) {
      owner = { kind: "run", sessionId: sid };
    } else {
      for (const anc of ancestry(proc)) {
        const session = paneByPid.get(anc);
        if (session) {
          owner = { kind: "tmux", session };
          break;
        }
      }
    }
    agents.push({ proc, childPids, owner, headless: isHeadless(proc) });
  }
  return agents.sort((a, b) => a.proc.pid - b.proc.pid);
}

/**
 * Join the two `ps` tables into one process table.
 *
 * Two invocations, not one, ON PURPOSE: `comm` can contain a SPACE (`tmux: server`), so a single
 * `ps -eo pid,ppid,etime,comm,args` cannot be column-split unambiguously. Asking for `comm` as the
 * LAST field of one table and `args` as the last of the other makes both parses exact.
 */
export function parseProcessTable(commTable: string, argsTable: string): ProcRow[] {
  const args = new Map<number, string>();
  for (const line of argsTable.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) args.set(Number(m[1]), m[2].trim());
  }
  const rows: ProcRow[] = [];
  for (const line of commTable.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    rows.push({ pid, ppid: Number(m[2]), etime: m[3], comm: m[4].trim(), args: args.get(pid) ?? "" });
  }
  return rows;
}
