import { describe, expect, it } from "vitest";
import {
  attributeClaudeProcesses,
  isClaudeProcess,
  isHeadless,
  parseProcessTable,
  sessionIdOf,
  type PaneOwner,
} from "./process-attribution";

// A VERBATIM capture from the VPS (2026-07-14) — the exact box state that made /processes report
// "5 rodando" when the pipeline was idle. Every false positive we fixed is present here:
//   753341  a *bash* whose command line MENTIONS claude (the tmux session wrapper)
//   753347  the real agent inside that wrapper
//   1734208 an interactive claude over SSH … 1734634 a second one … 1734860 a CHILD of 1734208
//   1735894 a Bash tool call sourcing /root/.claude/shell-snapshots/… (the page counting itself)
const COMM_TABLE = `
  87906       1  6-04:45:21 tmux: server
  87907   87906  6-04:45:21 bash
 753341   87906  3-09:43:05 bash
 753347  753341  3-09:43:05 claude
1037374       1  9-01:12:00 sshd
1733830 1037374       12:40 sshd
1733934 1733830       12:39 bash
1734208 1733934       10:11 claude
1734296 1037374       09:02 sshd
1734399 1734296       08:50 bash
1734634 1734399       08:48 claude
1734860 1734208       07:10 claude
1735894 1734208       00:00 bash
 680688       1  2-01:00:00 next-server
 999001  680688       00:42 claude
`;

const ARGS_TABLE = `
  87906 tmux new-session -d -s shell
  87907 -bash
 753341 bash -lc cd /root/meu-monorepo && IS_SANDBOX=1 claude --continue --dangerously-skip-permissions; exec bash
 753347 claude --continue --dangerously-skip-permissions
1037374 sshd: root@notty
1733830 sshd: root@pts/0
1733934 -bash
1734208 claude
1734296 sshd: root@pts/1
1734399 -bash
1734634 claude
1734860 claude
1735894 /bin/bash -c source /root/.claude/shell-snapshots/snapshot-bash-1784065621014.sh && ps -eo pid,args
 680688 next-server (v15.5.4)
 999001 claude -p --output-format stream-json --session-id 46a972d4-d610-4cfc-968c-625b87a2f4c3 /harness-do
`;

const PANES: PaneOwner[] = [
  { session: "continue-session", pid: 753341 },
  { session: "shell", pid: 87907 },
];

const rows = parseProcessTable(COMM_TABLE, ARGS_TABLE);
const row = (pid: number) => rows.find((r) => r.pid === pid)!;

describe("parseProcessTable — two ps tables joined by pid", () => {
  it("parses a comm that CONTAINS A SPACE (`tmux: server`) — the reason we ask for two tables", () => {
    expect(row(87906).comm).toBe("tmux: server");
    expect(row(87906).args).toBe("tmux new-session -d -s shell");
  });

  it("keeps pid/ppid/etime and pairs every row with its command line", () => {
    expect(row(753347)).toMatchObject({ ppid: 753341, etime: "3-09:43:05", comm: "claude" });
    expect(row(1735894).args).toContain("/root/.claude/shell-snapshots/");
  });
});

describe("isClaudeProcess — identity (the executable), never the command LINE", () => {
  it("is TRUE for the agent itself", () => {
    expect(isClaudeProcess(row(753347))).toBe(true); // comm=claude
    expect(isClaudeProcess(row(1734208))).toBe(true);
  });

  it("is FALSE for a bash that merely MENTIONS claude in its args (the tmux wrapper)", () => {
    expect(isClaudeProcess(row(753341))).toBe(false);
  });

  it("is FALSE for a Bash tool call sourcing /root/.claude/… (the page counting itself)", () => {
    expect(isClaudeProcess(row(1735894))).toBe(false);
  });

  it("accepts a launcher/shim whose argv[0] basename is claude", () => {
    expect(isClaudeProcess({ comm: "node", args: "/root/.local/bin/claude --continue" })).toBe(true);
  });

  it("aceita o binário NATIVO `claude.exe` — 6 dos 8 claude vivos na VPS liam assim (CLI 2.1.220)", () => {
    // Captura literal desta caixa em 2026-07-31: todo filho/fork nasce com esse comm, e `/usr/bin/claude`
    // é um symlink para ele. Recusá-lo fazia a página perder o agente por causa de como ele foi lançado.
    expect(isClaudeProcess({ comm: "claude.exe", args: "" })).toBe(true);
    expect(
      isClaudeProcess({
        comm: "claude.exe",
        args:
          "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --session-id " +
          "4e02437b-d8ad-495e-9b77-95178ca8338e --fork-session --resume /root/.claude/…",
      }),
    ).toBe(true);
  });

  it("continua recusando quem só MENCIONA claude.exe na linha de comando", () => {
    expect(isClaudeProcess({ comm: "bash", args: "bash -lc 'claude.exe --help'" })).toBe(false);
  });

  it("rejects a path that merely lives under a claude directory", () => {
    expect(isClaudeProcess({ comm: "node", args: "node /root/.claude/hooks/runner.js post-bash" })).toBe(false);
  });
});

describe("sessionIdOf / isHeadless", () => {
  it("reads the run uuid out of a headless run's args", () => {
    expect(sessionIdOf(row(999001))).toBe("46a972d4-d610-4cfc-968c-625b87a2f4c3");
    expect(isHeadless(row(999001))).toBe(true);
  });

  it("an interactive agent has neither", () => {
    expect(sessionIdOf(row(1734208))).toBeNull();
    expect(isHeadless(row(1734208))).toBe(false);
  });
});

describe("attributeClaudeProcesses — one row per AGENT, owned by identity", () => {
  const agents = attributeClaudeProcesses({
    procs: rows,
    panes: PANES,
    knownRunSessionIds: new Set(["46a972d4-d610-4cfc-968c-625b87a2f4c3"]),
  });
  const agent = (pid: number) => agents.find((a) => a.proc.pid === pid);

  it("counts AGENTS, not command lines: 4 — not the 5+ the old grep reported", () => {
    // 753347 (in tmux) · 1734208 (ssh, owns a child) · 1734634 (ssh) · 999001 (headless run).
    // The bash wrapper, the Bash tool call and the child agent are NOT rows.
    expect(agents.map((a) => a.proc.pid)).toEqual([753347, 999001, 1734208, 1734634]);
  });

  it("folds a CHILD agent into its root instead of giving it a row", () => {
    expect(agent(1734860)).toBeUndefined();
    expect(agent(1734208)!.childPids).toEqual([1734860]);
  });

  it("a tmux-hosted agent is owned by its SESSION (via the wrapper's pane pid), not 'externo'", () => {
    expect(agent(753347)!.owner).toEqual({ kind: "tmux", session: "continue-session" });
  });

  it("a headless run is owned by its RUN (session uuid) — a live run beats tmux ancestry", () => {
    expect(agent(999001)!.owner).toEqual({ kind: "run", sessionId: "46a972d4-d610-4cfc-968c-625b87a2f4c3" });
  });

  it("a hand-started SSH agent is unattributed (externo) — never pipeline work", () => {
    expect(agent(1734208)!.owner).toEqual({ kind: "none" });
    expect(agent(1734634)!.owner).toEqual({ kind: "none" });
  });

  it("a run uuid the runner does NOT know does not fake a run owner", () => {
    const [only] = attributeClaudeProcesses({
      procs: rows.filter((r) => r.pid === 999001 || r.pid === 680688),
      panes: [],
      knownRunSessionIds: new Set(), // the registry/journal never heard of it
    });
    expect(only.owner).toEqual({ kind: "none" });
  });

  it("survives a cyclic ppid chain (a reparented pid) without hanging", () => {
    const cyclic = [
      { pid: 10, ppid: 11, etime: "1:00", comm: "claude", args: "claude" },
      { pid: 11, ppid: 10, etime: "1:00", comm: "bash", args: "-bash" },
    ];
    const out = attributeClaudeProcesses({ procs: cyclic, panes: [], knownRunSessionIds: new Set() });
    expect(out).toHaveLength(1);
    expect(out[0].owner).toEqual({ kind: "none" });
  });

  it("no processes → no agents (ps unavailable degrades to an empty list, never throws)", () => {
    expect(attributeClaudeProcesses({ procs: [], panes: PANES, knownRunSessionIds: new Set() })).toEqual([]);
  });
});
