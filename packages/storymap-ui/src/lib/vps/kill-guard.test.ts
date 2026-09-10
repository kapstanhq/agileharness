import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assessKill, readAgentSessionsOrNull, type KillSnapshots } from "./kill-guard";
import type { ClaudeAgent } from "./process-attribution";
import type { TmuxSession } from "./tmux";
import type { AgentSession } from "@/lib/storymap/runner/session-worktree";
import { ATTENTION_SETTLE } from "@/lib/terminal/attention";

// The kill guard is SECURITY-CRITICAL: an over-permissive verdict drops the master, a live run, or an
// agent's uncommitted work. These tests pin every protected class + the genuinely-safe cases. They
// exercise the PURE assessKill over crafted snapshots (no box probing).

const NOW = 1_800_000_000_000;

function tmuxSession(name: string, attached = false): TmuxSession {
  return {
    name,
    windows: 1,
    attached,
    createdAt: NOW - 60_000,
    activityAt: NOW,
    path: "",
    command: "bash",
    paneTitle: "",
    geometry: "120x30",
  };
}

function hostedAgent(session: string, headless: boolean): ClaudeAgent {
  return {
    proc: { pid: 4242, ppid: 1, etime: "05:00", comm: "claude", args: "claude" },
    childPids: [],
    owner: { kind: "tmux", session },
    headless,
  };
}

function agentRow(over: Partial<AgentSession> & { tmuxSession: string; heartbeatAt: string }): AgentSession {
  return {
    sessionId: "sid-1",
    agentId: "sid-1",
    role: "free",
    task: "trabalho",
    openedAt: new Date(NOW).toISOString(),
    ...over,
  } as AgentSession;
}

function snap(over: Partial<KillSnapshots> = {}): KillSnapshots {
  return {
    sessions: [],
    agents: [],
    runningCardSessions: new Set(),
    agentSessions: [],
    now: NOW,
    // Vazio = SEM evidência de tela para ninguém, que num guarda fail-closed significa "todo agente
    // conta como vivo". É o default certo para os testes das outras classes: eles falam de proteção,
    // e a dormência só pode AFROUXAR — quem quiser exercitá-la injeta o mapa (ver o bloco DORMENTE).
    screenStill: new Map(),
    masterPrefix: /^claude(-|$)/,
    protectedNames: new Set(["shell"]),
    ...over,
  };
}

describe("assessKill — classes protegidas (fail-closed)", () => {
  it("MASTER: o master com sufixo (claude-jonatas) é protegido — não só o bare `claude`", () => {
    expect(assessKill("claude-jonatas", snap()).protected).toBe(true);
    expect(assessKill("claude", snap()).protected).toBe(true);
  });

  it("INFRA: `shell` é protegido por nome", () => {
    expect(assessKill("shell", snap()).protected).toBe(true);
  });

  it("LIVE RUN: um card-* pareado com um run RODANDO é protegido", () => {
    const s = snap({ runningCardSessions: new Set(["card-acme__story-x"]) });
    const v = assessKill("card-acme__story-x", s);
    expect(v.protected).toBe(true);
    expect(v.reason).toMatch(/autorun/i);
  });

  it("HOSTS AGENT: uma sessão que hospeda um claude headless vivo é protegida", () => {
    const s = snap({ agents: [hostedAgent("cop-build", true)], sessions: [tmuxSession("cop-build")] });
    expect(assessKill("cop-build", s).protected).toBe(true);
  });

  it("HOSTS AGENT: idem para um claude interativo vivo (cobre SELF — o claude que se mataria)", () => {
    const s = snap({ agents: [hostedAgent("cop-x", false)], sessions: [tmuxSession("cop-x", true)] });
    expect(assessKill("cop-x", s).protected).toBe(true);
  });

  it("LIVE FLEET: um agent-* com registro VIVO (heartbeat recente) é protegido", () => {
    const s = snap({
      agentSessions: [agentRow({ tmuxSession: "agent-abc", heartbeatAt: new Date(NOW - 60_000).toISOString(), task: "mexendo no X" })],
    });
    const v = assessKill("agent-abc", s);
    expect(v.protected).toBe(true);
    expect(v.reason).toContain("mexendo no X");
  });

  it("UNREADABLE: registro nulo + nome agent-* ⇒ protegido (não dá para provar que morreu)", () => {
    const s = snap({ agentSessions: null });
    expect(assessKill("agent-xyz", s).protected).toBe(true);
  });
});

describe("assessKill — casos SEGUROS (protected:false só quando nenhuma classe vale)", () => {
  it("cop-* ocioso, sem claude vivo dentro, não é protegido", () => {
    const s = snap({ sessions: [tmuxSession("cop-old")] });
    expect(assessKill("cop-old", s).protected).toBe(false);
  });

  it("adhoc num prompt de bash, sem agente, não é protegido", () => {
    expect(assessKill("scratch", snap()).protected).toBe(false);
  });

  it("card-* JÁ liquidado (não está entre os runs rodando, sem claude dentro) não é protegido", () => {
    expect(assessKill("card-acme__story-old", snap()).protected).toBe(false);
  });

  it("um agent-* cujo registro está MORTO (heartbeat expirado) não é protegido", () => {
    const s = snap({
      agentSessions: [agentRow({ tmuxSession: "agent-dead", heartbeatAt: new Date(NOW - 8 * 60 * 60 * 1000).toISOString() })],
    });
    expect(assessKill("agent-dead", s).protected).toBe(false);
  });

  it("um agente hospedado em OUTRA sessão não protege esta", () => {
    const s = snap({ agents: [hostedAgent("cop-other", false)] });
    expect(assessKill("scratch", s).protected).toBe(false);
  });
});

describe("assessKill — agente DORMENTE: a classe 4 protege trabalho, não a existência de um processo", () => {
  const DORMENTE = ATTENTION_SETTLE.staleFlagMs + 60_000;

  const hosting = (over: Partial<KillSnapshots> = {}) =>
    snap({ agents: [hostedAgent("scratch", false)], sessions: [tmuxSession("scratch")], ...over });

  it("tela congelada além do limiar ⇒ deixa de proteger (é o que o operador quer reciclar)", () => {
    // A máquina acumulava sessões com um Claude parado havia horas: a interface as mostrava e a trava
    // recusava encerrá-las, porque "hospeda um agente vivo" não olhava se havia trabalho de fato.
    const v = assessKill("scratch", hosting({ screenStill: new Map([["scratch", DORMENTE]]) }));
    expect(v.protected).toBe(false);
  });

  it("tela viva ⇒ segue protegida (a trava não afrouxou para quem está trabalhando)", () => {
    const v = assessKill("scratch", hosting({ screenStill: new Map([["scratch", 5_000]]) }));
    expect(v.protected).toBe(true);
    expect(v.reason).toMatch(/vivo/i);
  });

  it("SEM evidência de tela ⇒ protegida (fail-closed: ausência de prova não autoriza kill)", () => {
    expect(assessKill("scratch", hosting()).protected).toBe(true);
    expect(assessKill("scratch", hosting({ screenStill: new Map([["outra", DORMENTE]]) })).protected).toBe(true);
  });

  it("dormência NÃO fura as outras classes — cada uma protege por um motivo próprio", () => {
    const still = new Map([
      ["claude-jonatas", DORMENTE],
      ["shell", DORMENTE],
      ["card-acme__story-x", DORMENTE],
      ["agent-abc", DORMENTE],
    ]);
    expect(assessKill("claude-jonatas", snap({ screenStill: still })).protected).toBe(true);
    expect(assessKill("shell", snap({ screenStill: still })).protected).toBe(true);
    expect(
      assessKill("card-acme__story-x", snap({ screenStill: still, runningCardSessions: new Set(["card-acme__story-x"]) }))
        .protected,
    ).toBe(true);
    expect(
      assessKill(
        "agent-abc",
        snap({
          screenStill: still,
          agentSessions: [agentRow({ tmuxSession: "agent-abc", heartbeatAt: new Date(NOW - 60_000).toISOString() })],
        }),
      ).protected,
    ).toBe(true);
  });
});

// O sinal de "ilegível ⇒ null" TEM de ser produzível pela leitura REAL — senão a classe-6 fail-closed
// vira código morto (foi um achado da revisão: makeSessionStore().load() nunca devolve null). Estes
// testes provam que readAgentSessionsOrNull preserva o null que o gatherKillSnapshots repassa.
describe("readAgentSessionsOrNull — o null que arma a classe-6 é alcançável", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    dir = mkdtempSync(path.join(os.tmpdir(), "killguard-"));
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("arquivo ausente ⇒ null (fail-closed), NÃO []", () => {
    expect(readAgentSessionsOrNull()).toBeNull();
  });
  it("JSON corrompido ⇒ null", () => {
    writeFileSync(path.join(dir, "sessions.json"), "{ truncad", "utf8");
    expect(readAgentSessionsOrNull()).toBeNull();
  });
  it("JSON válido mas não-array (nem {sessions:[]}) ⇒ null", () => {
    writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ sessions: "x" }), "utf8");
    expect(readAgentSessionsOrNull()).toBeNull();
  });
  it("array válido ⇒ o array (com tmuxSession preservado para o match)", () => {
    writeFileSync(path.join(dir, "sessions.json"), JSON.stringify([{ sessionId: "s", tmuxSession: "agent-x", task: "t", heartbeatAt: "now" }]), "utf8");
    const rows = readAgentSessionsOrNull();
    expect(rows).not.toBeNull();
    expect(rows![0].tmuxSession).toBe("agent-x");
  });
  it("forma { sessions: [...] } ⇒ o array interno", () => {
    writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ sessions: [{ sessionId: "s", tmuxSession: "agent-y", task: "t", heartbeatAt: "now" }] }), "utf8");
    expect(readAgentSessionsOrNull()?.[0].tmuxSession).toBe("agent-y");
  });
});
