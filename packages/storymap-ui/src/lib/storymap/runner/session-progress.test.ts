import { describe, expect, it } from "vitest";
import { nextSessionProgress, reportSessionProgress, type AgentSession, type SessionStore } from "./session-worktree";
import { riskClassForTool } from "@/lib/storymap/mcp/register";

const T0 = Date.parse("2026-09-28T22:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();

function memStore(rows: AgentSession[]): SessionStore & { rows: AgentSession[] } {
  const box = { rows: structuredClone(rows) };
  return {
    get rows() {
      return box.rows;
    },
    async load() {
      return structuredClone(box.rows);
    },
    async persist(s) {
      box.rows = structuredClone(s);
    },
  };
}

const row = (over: Partial<AgentSession>): AgentSession => ({
  sessionId: "s",
  agentId: "s",
  role: "implement",
  task: "t",
  openedAt: iso(T0),
  heartbeatAt: iso(T0),
  board: "armazem",
  cardId: "story-ex0004",
  ...over,
});

describe("nextSessionProgress — o relato seguinte", () => {
  it("o mesmo bloco preserva desde quando ele começou; um bloco novo zera", () => {
    const a = nextSessionProgress(undefined, { board: "b", cardId: "c", phase: "construir" }, iso(T0));
    expect(a.phaseSince).toBe(iso(T0));
    const b = nextSessionProgress(a, { board: "b", cardId: "c", phase: "construir", note: "tarefa 2" }, iso(T0 + 60_000));
    expect(b.phaseSince).toBe(iso(T0));
    expect(b.at).toBe(iso(T0 + 60_000));
    const c = nextSessionProgress(b, { board: "b", cardId: "c", phase: "verificar" }, iso(T0 + 120_000));
    expect(c.phaseSince).toBe(iso(T0 + 120_000));
  });

  it("a espera vale só no relato que a traz, e a hora inválida é descartada", () => {
    const w = nextSessionProgress(undefined, { board: "b", cardId: "c", phase: "construir", waiting: "a janela de ações", until: "2026-09-28T23:00:00Z" }, iso(T0));
    expect(w.waiting).toBe("a janela de ações");
    expect(w.until).toBe("2026-09-28T23:00:00.000Z");
    const back = nextSessionProgress(w, { board: "b", cardId: "c", phase: "construir" }, iso(T0 + 1));
    expect(back.waiting).toBeUndefined();
    expect(back.until).toBeUndefined();
    const bad = nextSessionProgress(undefined, { board: "b", cardId: "c", phase: "construir", waiting: "x", until: "amanhã" }, iso(T0));
    expect(bad.until).toBeUndefined();
  });

  it("a nota é uma linha curta", () => {
    const p = nextSessionProgress(undefined, { board: "b", cardId: "c", phase: "moldar", note: `  a\n  b ${"x".repeat(400)}` }, iso(T0));
    expect(p.note!.startsWith("a b ")).toBe(true);
    expect(p.note!.length).toBe(200);
  });
});

describe("reportSessionProgress — grava na SESSÃO do card, nunca no card", () => {
  it("acha o condutor do card e grava o relato + o heartbeat", async () => {
    const store = memStore([
      row({ sessionId: "free", heartbeatAt: iso(T0 + 5_000) }),
      row({ sessionId: "cond", driver: "conductor" }),
      row({ sessionId: "other", cardId: "story-x", driver: "conductor" }),
    ]);
    const res = await reportSessionProgress({ store, now: () => T0 + 60_000 }, { board: "armazem", cardId: "story-ex0004", phase: "construir", note: "5/5 tarefas" });
    expect(res.ok).toBe(true);
    const cond = store.rows.find((s) => s.sessionId === "cond")!;
    expect(cond.progress).toEqual({ phase: "construir", note: "5/5 tarefas", at: iso(T0 + 60_000), phaseSince: iso(T0 + 60_000) });
    expect(cond.heartbeatAt).toBe(iso(T0 + 60_000));
    // relatar é trabalhar: o relato é prova de atividade, não só de vida (agent-presence.ts)
    expect(cond.lastActivityAt).toBe(iso(T0 + 60_000));
    expect(store.rows.find((s) => s.sessionId === "free")!.progress).toBeUndefined();
    expect(store.rows.find((s) => s.sessionId === "other")!.progress).toBeUndefined();
  });

  it("sem sessão no card, recusa com o motivo (não inventa uma)", async () => {
    const store = memStore([row({ cardId: "story-x" })]);
    const res = await reportSessionProgress({ store, now: () => T0 }, { board: "armazem", cardId: "story-ex0004", phase: "moldar" });
    expect(res.ok).toBe(false);
    expect(store.rows[0].progress).toBeUndefined();
  });

  it("report_progress é da classe de leitura — o limite de ações nunca o freia (ele relata o próprio limite)", () => {
    expect(riskClassForTool("report_progress")).toBe("read");
  });
});
