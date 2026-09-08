// WS-6.4 + Gap 1.3c — the fleet JOIN. The bugs this file guards are all lies-by-join: a claim shown on the
// wrong agent, a dead session that looks busy, a live session declared dead because it has no tmux handle,
// and (1.3c) a card-less integration failure that no surface in the product can show.

import { describe, expect, it } from "vitest";
import { buildFleetRows, fleetAttention, type FleetInputs } from "./fleet-view";
import { sessionClaimActor, type CardClaim } from "./claims";
import type { AgentSession } from "./session-worktree";
import type { MergeQueueEntry } from "./types";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: "s-1",
    agentId: "a-1",
    role: "implement",
    task: "arrumar o login",
    branch: "agent/s-1",
    worktreePath: "/repo/.worktrees/agent-s-1",
    baseCommit: "base",
    tmuxSession: "agent-s1",
    openedAt: iso(60_000),
    heartbeatAt: iso(1_000),
    ...over,
  };
}

function claim(over: Partial<CardClaim> = {}): CardClaim {
  return {
    board: "acme",
    cardId: "story-1",
    actor: sessionClaimActor("a-1"),
    kind: "implement",
    scope: "both",
    acquiredAt: iso(60_000),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    heartbeatAt: iso(1_000),
    ...over,
  };
}

function entry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    runId: "s-1",
    kind: "session",
    board: "",
    branch: "agent/s-1",
    status: "returned-to-session",
    enqueuedAt: NOW - 120_000,
    pinnedSha: "abc1234",
    ...over,
  };
}

function inputs(over: Partial<FleetInputs> = {}): FleetInputs {
  return {
    sessions: [session()],
    claims: [],
    entries: [],
    liveTmux: new Set(["agent-s1"]),
    contextBySession: new Map(),
    recycleThresholdPct: 50,
    ...over,
  };
}

describe("buildFleetRows — a linha do agente é o JOIN de quatro registros", () => {
  it("casa o claim pelo ATOR LÓGICO (session:<agentId>), não pelo processo", () => {
    const [row] = buildFleetRows(inputs({ sessions: [session({ board: "acme", cardId: "story-1" })], claims: [claim()] }), NOW);
    expect(row.claim).toMatchObject({ kind: "implement", scope: "both" });
  });

  it("NÃO mostra o claim de outro agente na minha linha", () => {
    const [row] = buildFleetRows(
      inputs({ sessions: [session({ board: "acme", cardId: "story-1" })], claims: [claim({ actor: sessionClaimActor("outro") })] }),
      NOW,
    );
    expect(row.claim).toBeNull();
  });

  it("um claim VENCIDO não aparece como reserva viva", () => {
    const [row] = buildFleetRows(
      inputs({
        sessions: [session({ board: "acme", cardId: "story-1" })],
        claims: [claim({ expiresAt: new Date(NOW - 1).toISOString() })],
      }),
      NOW,
    );
    expect(row.claim).toBeNull();
  });

  it("sessão SEM tmux não é dada como morta (ausência de handle ≠ morte)", () => {
    const [row] = buildFleetRows(inputs({ sessions: [session({ tmuxSession: undefined })], liveTmux: new Set() }), NOW);
    expect(row.processAlive).toBeNull();
    expect(row.alive).toBe(true);
  });

  it("tmux sumido ⇒ processAlive false (e nada de reciclar um morto)", () => {
    const [row] = buildFleetRows(inputs({ liveTmux: new Set(), contextBySession: new Map([["s-1", 90]]) }), NOW);
    expect(row.processAlive).toBe(false);
    expect(row.suggestRecycle).toBe(false); // sugerir reciclar um processo morto é ruído, não ação
  });

  it("contexto no teto ⇒ sugere reciclagem (antes de estourar)", () => {
    const [row] = buildFleetRows(inputs({ contextBySession: new Map([["s-1", 62]]) }), NOW);
    expect(row.suggestRecycle).toBe(true);
  });

  it("sessão adotada carrega o warning de dívida visível", () => {
    const [row] = buildFleetRows(
      inputs({ sessions: [session({ adopted: true, worktreePath: undefined, branch: undefined })] }),
      NOW,
    );
    expect(row.warning).toContain("SEM ISOLAMENTO");
  });
});

describe("Gap 1.3c — a integração órfã de uma sessão CARD-LESS", () => {
  it("sessão MORTA + entry devolvida = demanda do operador (a única superfície que a mostra)", () => {
    const rows = buildFleetRows(
      inputs({
        sessions: [session({ board: undefined, cardId: undefined, task: "self-dev: fix do reaper" })],
        entries: [entry()],
        liveTmux: new Set(), // o tmux sumiu: ninguém leu o veredito
      }),
      NOW,
    );
    expect(rows[0].orphanedIntegration).toMatchObject({ status: "returned-to-session", branch: "agent/s-1", pinnedSha: "abc1234" });
    expect(rows[0].orphanedIntegration?.detail).toContain("morreu antes de ler o veredito");
    expect(fleetAttention(rows)).toHaveLength(1);
    // …e sem card: nenhuma superfície keyed-by-card poderia tê-la mostrado (é o motivo do gap existir).
    expect(rows[0].cardId).toBeNull();
  });

  it("sessão VIVA com entry devolvida NÃO é demanda: ela mesma resolve (G6)", () => {
    const rows = buildFleetRows(inputs({ entries: [entry()] }), NOW);
    expect(rows[0].orphanedIntegration).toBeNull();
    expect(rows[0].train).toMatchObject({ status: "returned-to-session" });
    expect(fleetAttention(rows)).toHaveLength(0);
  });

  it("sessão morta com integração CONCLUÍDA não é demanda (não há o que fazer)", () => {
    const rows = buildFleetRows(inputs({ entries: [entry({ status: "done" })], liveTmux: new Set() }), NOW);
    expect(rows[0].orphanedIntegration).toBeNull();
    expect(fleetAttention(rows)).toHaveLength(0);
  });

  it("gate reprovado com o dono morto também é órfão (o branch fica preservado)", () => {
    const rows = buildFleetRows(inputs({ entries: [entry({ status: "gate-failed" })], liveTmux: new Set() }), NOW);
    expect(rows[0].orphanedIntegration?.status).toBe("gate-failed");
  });

  it("uma entry de OUTRO run não vaza para a linha deste agente", () => {
    const rows = buildFleetRows(inputs({ entries: [entry({ runId: "outro-run" })], liveTmux: new Set() }), NOW);
    expect(rows[0].train).toBeNull();
    expect(rows[0].orphanedIntegration).toBeNull();
  });
});

describe("buildFleetRows — ordem por ATENÇÃO", () => {
  it("órfão primeiro, depois reciclar, depois os vivos, e os mortos por último", () => {
    const rows = buildFleetRows(
      inputs({
        sessions: [
          session({ sessionId: "viva", agentId: "viva", tmuxSession: "t-viva", heartbeatAt: iso(1_000) }),
          session({ sessionId: "morta", agentId: "morta", tmuxSession: "t-morta", heartbeatAt: iso(2_000) }),
          session({ sessionId: "cheia", agentId: "cheia", tmuxSession: "t-cheia", heartbeatAt: iso(3_000) }),
          session({ sessionId: "orfa", agentId: "orfa", tmuxSession: "t-orfa", heartbeatAt: iso(4_000) }),
        ],
        entries: [entry({ runId: "orfa", branch: "agent/orfa" })],
        liveTmux: new Set(["t-viva", "t-cheia"]),
        contextBySession: new Map([["cheia", 80]]),
      }),
      NOW,
    );
    expect(rows.map((r) => r.agentId)).toEqual(["orfa", "cheia", "viva", "morta"]);
  });
});
