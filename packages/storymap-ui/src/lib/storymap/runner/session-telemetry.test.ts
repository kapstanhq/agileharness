// The conductor's spend in the card's ledger — so cardBudgetUSD (which sums the ledger) finally sees it.

import { describe, expect, it } from "vitest";
import { isRecordableSession, recordSessionSpend, sessionTelemetryId, type SessionTelemetryDeps } from "./session-telemetry";
import { roleOf, type TelemetryRecord } from "./telemetry";
import type { AgentSession } from "./session-worktree";
import type { SessionCostEstimate } from "@/lib/vps/session-cost";

const conductor: AgentSession = {
  sessionId: "sess-1",
  agentId: "sess-1",
  role: "implement",
  board: "b",
  cardId: "c",
  task: "/harness-conductor b/c",
  driver: "conductor",
  worktreePath: "/repo/.worktrees/agent-sess-1",
  openedAt: new Date(Date.now() - 60_000).toISOString(),
  heartbeatAt: new Date().toISOString(),
};

const estimate: SessionCostEstimate = {
  costUSD: 3.21,
  inputTokens: 1000,
  outputTokens: 200,
  requests: 12,
  model: "claude-opus-4-8",
  approximate: false,
  unpricedModels: [],
};

function deps(cost: SessionCostEstimate | null = estimate): SessionTelemetryDeps & { records: TelemetryRecord[]; reads: number } {
  const records: TelemetryRecord[] = [];
  const box = { reads: 0 };
  return {
    telemetry: {
      recordRun: async (r) => {
        records.push(r);
      },
      listByCard: async (board, cardId) => records.filter((r) => r.board === board && r.cardId === cardId),
    },
    readCost: async () => {
      box.reads += 1;
      return cost;
    },
    log: () => {},
    records,
    get reads() {
      return box.reads;
    },
  };
}

describe("recordSessionSpend", () => {
  it("grava UMA linha role `session` no ledger do card — a que o cardBudgetUSD soma", async () => {
    const d = deps();
    expect(await recordSessionSpend(d, conductor)).toBe("recorded");
    expect(d.records).toHaveLength(1);
    const r = d.records[0];
    expect(r).toMatchObject({ id: sessionTelemetryId("sess-1"), board: "b", cardId: "c", costUSD: 3.21, trigger: "harness-conductor", status: "ok" });
    expect(roleOf(r)).toBe("session");
    // o somatório que o backstop por card lê agora inclui a sessão
    const spent = (await d.telemetry.listByCard("b", "c")).reduce((s, x) => s + (x.costUSD ?? 0), 0);
    expect(spent).toBeCloseTo(3.21);
  });

  it("sem `summary`: a sessão nunca vira o 'handoff' do próximo run de coluna", async () => {
    const d = deps();
    await recordSessionSpend(d, conductor);
    expect(d.records[0].summary).toBeNull();
  });

  it("idempotente: o óbito que se repete a cada tick NÃO regrava — e nem relê os transcripts", async () => {
    const d = deps();
    await recordSessionSpend(d, conductor);
    expect(await recordSessionSpend(d, conductor)).toBe("already");
    expect(d.records).toHaveLength(1);
    expect(d.reads).toBe(1);
  });

  it("só sessões CONDUTORAS com card entram (uma sessão comum não mexe no orçamento do card)", async () => {
    expect(isRecordableSession({ ...conductor, driver: undefined })).toBe(false);
    expect(isRecordableSession({ ...conductor, cardId: undefined })).toBe(false);
    const d = deps();
    expect(await recordSessionSpend(d, { ...conductor, driver: undefined })).toBe("not-recordable");
    expect(d.records).toHaveLength(0);
  });

  it("sem transcript legível: nada é gravado (nunca um $0 fabricado)", async () => {
    const d = deps(null);
    expect(await recordSessionSpend(d, conductor)).toBe("no-transcript");
    expect(d.records).toHaveLength(0);
  });

  it("modelo sem preço: grava os tokens com custo null (desconhecido ≠ grátis)", async () => {
    const d = deps({ ...estimate, costUSD: null, approximate: true, unpricedModels: ["x"] });
    await recordSessionSpend(d, conductor);
    expect(d.records[0].costUSD).toBeNull();
    expect(d.records[0].inputTokens).toBe(1000);
  });
});

// A porta do "fim da sessão" pelo DESCARTE: o condutor descarta a árvore ao terminar — é o último instante em
// que o serviço ainda conhece a linha (depois dela o registro esquece a sessão, e o óbito do tmux nunca mais é
// notado). O gancho precisa rodar ANTES de a linha sumir, e nunca pode travar o descarte.
describe("discardSessionWorktree — onSessionEnd roda com a linha AINDA no registro", () => {
  it("o gancho recebe a sessão; um gancho que lança não impede o descarte", async () => {
    const { discardSessionWorktree } = await import("./session-worktree");
    let saved: AgentSession[] = [{ ...conductor, adopted: true, worktreePath: undefined }];
    const seen: string[] = [];
    const deps = {
      store: {
        load: async () => saved.map((s) => ({ ...s })),
        persist: async (s: AgentSession[]) => {
          saved = s;
        },
      },
      exec: (async () => {
        throw new Error("git inesperado — sessão adotada não tem árvore");
      }) as never,
      fs: {} as never,
      repoRoot: "/repo",
      ensureRunBase: async () => "base",
      enqueueMerge: async () => {},
      liveRunIds: async () => [],
      onSessionEnd: async (s: AgentSession) => {
        seen.push(`${s.sessionId}:${saved.length}`); // a linha ainda está lá
        throw new Error("o registro de custo falhou");
      },
    };
    const res = await discardSessionWorktree(deps, { sessionId: "sess-1" });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["sess-1:1"]);
    expect(saved).toEqual([]); // descartada mesmo com o gancho lançando
  });
});
