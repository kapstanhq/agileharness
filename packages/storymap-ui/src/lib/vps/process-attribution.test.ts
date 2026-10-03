import { describe, expect, it } from "vitest";
import {
  attributeClaudeProcesses,
  isClaudeProcess,
  isHeadless,
  parseProcessTable,
  sessionIdOf,
  type PaneOwner,
} from "./process-attribution";

// A ps-shaped fixture (every value invented) of a host state that made /processes report
// extra agents while the pipeline was idle. Each false positive we fixed is present here:
//   9021   a *zsh* whose command line MENTIONS claude (the tmux session wrapper)
//   9027   the real agent inside that wrapper (with a non-claude helper child, 9030)
//   9140   an agent that IS the pane's root process (no wrapper at all)
//   30622  an interactive claude over SSH … 30977 a CHILD of it … 30981 a Bash tool call sourcing
//          /root/.claude/shell-snapshots/… (the page counting itself)
//   6120   a headless claude started by cron whose session uuid the runner has never heard of
//   7410   a headless run the runner DOES know, child of the runner service (7002)
const COMM_TABLE = `
    812       1 14-02:31:09 tmux: server
    815     812 14-02:31:09 zsh
   9021     812  5-18:20:44 zsh
   9027    9021  5-18:20:43 claude
   9030    9027  5-18:20:40 node
   9140     812     06:17:31 claude
   1204       1 41-07:15:02 sshd
  30511    1204     3:12:08 sshd
  30540   30511     3:12:07 fish
  30622   30540     3:09:51 claude
  30977   30622        2:03 claude
  30981   30977        0:00 bash
   6120       1     01:55:30 claude
   7002       1    22:46:10 node
   7410    7002        0:19 claude
`;

const ARGS_TABLE = `
    812 tmux new-session -d -s scratch
    815 -zsh
   9021 zsh -ic cd /srv/atlas && claude --resume; exec zsh
   9027 claude --resume
   9030 node /opt/helpers/index-watcher.js
   9140 claude
   1204 sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups
  30511 sshd: deploy [priv]
  30540 -fish
  30622 claude
  30977 claude
  30981 /bin/bash -c source /root/.claude/shell-snapshots/snapshot-bash-1781726403117.sh && eval 'ls -la' < /dev/null
   6120 claude -p --output-format json --resume 5e0b9c3a-71d4-4c28-8f06-b3a9d2e41c75 nightly digest
   7002 node /opt/runner/dist/server.mjs
   7410 claude -p --output-format stream-json --session-id 0c7be492-aa13-4d85-9be6-2f58d1e3704b /harness-do
`;

const PANES: PaneOwner[] = [
  { session: "review", pid: 9021 },
  { session: "scratch", pid: 815 },
  { session: "notes", pid: 9140 },
];

const rows = parseProcessTable(COMM_TABLE, ARGS_TABLE);
const row = (pid: number) => rows.find((r) => r.pid === pid)!;

describe("parseProcessTable — two ps tables joined by pid", () => {
  it("parses a comm that CONTAINS A SPACE (`tmux: server`) — the reason we ask for two tables", () => {
    expect(row(812).comm).toBe("tmux: server");
    expect(row(812).args).toBe("tmux new-session -d -s scratch");
  });

  it("keeps pid/ppid/etime and pairs every row with its command line", () => {
    expect(row(9027)).toMatchObject({ ppid: 9021, etime: "5-18:20:43", comm: "claude" });
    expect(row(30981).args).toContain("/root/.claude/shell-snapshots/");
  });
});

describe("isClaudeProcess — identity (the executable), never the command LINE", () => {
  it("is TRUE for the agent itself", () => {
    expect(isClaudeProcess(row(9027))).toBe(true); // comm=claude
    expect(isClaudeProcess(row(30622))).toBe(true);
  });

  it("is FALSE for a bash that merely MENTIONS claude in its args (the tmux wrapper)", () => {
    expect(isClaudeProcess(row(9021))).toBe(false);
  });

  it("is FALSE for a Bash tool call sourcing /root/.claude/… (the page counting itself)", () => {
    expect(isClaudeProcess(row(30981))).toBe(false);
  });

  it("accepts a launcher/shim whose argv[0] basename is claude", () => {
    expect(isClaudeProcess({ comm: "node", args: "/root/.local/bin/claude --continue" })).toBe(true);
  });

  it("aceita o binário NATIVO `claude.exe` — vários claude vivos num host real liam assim", () => {
    // Num host real, todo filho/fork nasce com esse comm, e `/usr/bin/claude`
    // é um symlink para ele. Recusá-lo fazia a página perder o agente por causa de como ele foi lançado.
    expect(isClaudeProcess({ comm: "claude.exe", args: "" })).toBe(true);
    expect(
      isClaudeProcess({
        comm: "claude.exe",
        args:
          "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --session-id " +
          "a7b35c18-92d0-4e6f-b1c4-58e3f0d27a96 --fork-session --resume /root/.claude/…",
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
    expect(sessionIdOf(row(7410))).toBe("0c7be492-aa13-4d85-9be6-2f58d1e3704b");
    expect(isHeadless(row(7410))).toBe(true);
  });

  it("an interactive agent has neither", () => {
    expect(sessionIdOf(row(30622))).toBeNull();
    expect(isHeadless(row(30622))).toBe(false);
  });
});

describe("attributeClaudeProcesses — one row per AGENT, owned by identity", () => {
  const agents = attributeClaudeProcesses({
    procs: rows,
    panes: PANES,
    knownRunSessionIds: new Set(["0c7be492-aa13-4d85-9be6-2f58d1e3704b"]),
  });
  const agent = (pid: number) => agents.find((a) => a.proc.pid === pid);

  it("counts AGENTS, not command lines: 5 — not the larger count the old grep reported", () => {
    // 6120 (cron, headless) · 7410 (headless run) · 9027 (in tmux, behind a wrapper) · 9140 (the pane root itself)
    // · 30622 (ssh, owns a child). The zsh wrapper, the node helper, the Bash tool call and the child agent are NOT rows.
    expect(agents.map((a) => a.proc.pid)).toEqual([6120, 7410, 9027, 9140, 30622]);
  });

  it("folds a CHILD agent into its root instead of giving it a row", () => {
    expect(agent(30977)).toBeUndefined();
    expect(agent(30622)!.childPids).toEqual([30977]);
  });

  it("a tmux-hosted agent is owned by its SESSION (via the wrapper's pane pid), not 'externo'", () => {
    expect(agent(9027)!.owner).toEqual({ kind: "tmux", session: "review" });
  });

  it("an agent that is itself the pane's root process is owned by that session too", () => {
    expect(agent(9140)!.owner).toEqual({ kind: "tmux", session: "notes" });
  });

  it("a headless run is owned by its RUN (session uuid) — a live run beats tmux ancestry", () => {
    expect(agent(7410)!.owner).toEqual({ kind: "run", sessionId: "0c7be492-aa13-4d85-9be6-2f58d1e3704b" });
  });

  it("a hand-started SSH agent is unattributed (externo) — never pipeline work", () => {
    expect(agent(30622)!.owner).toEqual({ kind: "none" });
  });

  it("a headless agent whose uuid the runner never heard of (cron) is headless but not a run", () => {
    expect(agent(6120)!.headless).toBe(true);
    expect(agent(6120)!.owner).toEqual({ kind: "none" });
  });

  it("a run uuid the runner does NOT know does not fake a run owner", () => {
    const [only] = attributeClaudeProcesses({
      procs: rows.filter((r) => r.pid === 7410 || r.pid === 7002),
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
