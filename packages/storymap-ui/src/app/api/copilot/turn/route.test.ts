import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { POST } from "./route";
import { boardScope, viewScope, reserveCopilotTurnSlot } from "@/lib/storymap/copilot/agent-session";
import { classifyTurnRejection } from "@/lib/storymap/copilot/outbox";

// WS-3/3.4 — a fresh turn (no sessionId) for a board that already has a live turn must 409, so a double-click /
// duplicate tab can't spawn two Jidos writing the same board. We seed the globalThis-pinned registry directly
// (the same Map the route reads) so the guard fires BEFORE runCopilotTurn — no real `claude` is spawned.
interface FakeEntry {
  boardId: string;
  scope: string;
  sessionId: string;
  child: ChildProcess;
  startedAt: number;
  settle: () => void;
}
const g = globalThis as unknown as {
  __copilotLiveTurns?: Map<string, FakeEntry>;
  __copilotReservedTurns?: Map<string, number>;
  __copilotSessionScope?: Map<string, string>;
};
const LIVE = (): Map<string, FakeEntry> => (g.__copilotLiveTurns ??= new Map());
const RESERVED = (): Map<string, number> => (g.__copilotReservedTurns ??= new Map());
const SESSION_SCOPE = (): Map<string, string> => (g.__copilotSessionScope ??= new Map());
const NEST = boardScope("acme");

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/copilot/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const clearAll = () => {
  LIVE().clear();
  RESERVED().clear();
  SESSION_SCOPE().clear();
};
beforeEach(clearAll);
afterEach(clearAll);

describe("POST /api/copilot/turn — fresh-turn guard (WS-3/3.4)", () => {
  it("a second FRESH turn (no sessionId) for a board with a live turn gets 409", async () => {
    LIVE().set(`${NEST}::inflight`, {
      boardId: "acme",
      scope: NEST,
      sessionId: "inflight",
      child: { pid: undefined } as unknown as ChildProcess,
      startedAt: Date.now(),
      settle: () => {},
    });
    const res = await post({ boardId: "acme", text: "continue" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { ok: boolean; error: string; reason?: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/turno em andamento/i);
    // O contrato que a FILA do cliente consome: `reason` transitório ⇒ ela ESPERA e reenvia sozinha, em vez de
    // devolver a mensagem ao operador como falha (o incidente de 2026-07-25).
    expect(json.reason).toBe("turn-in-flight");
    expect(classifyTurnRejection(res.status, JSON.stringify(json))).toEqual({ kind: "busy", reason: "turn-in-flight" });
  });

  it("um slot RESERVADO (turno em setup de spawn, ainda sem registro) já barra o segundo POST", async () => {
    const slot = reserveCopilotTurnSlot(NEST);
    expect(slot.ok).toBe(true);
    const res = await post({ boardId: "acme", text: "continue" });
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({ ok: false, reason: "turn-in-flight" });
  });

  it("sessão atrelada a OUTRA raia → 409 PERMANENTE, que a fila classifica como falha (nunca laço de retry)", async () => {
    SESSION_SCOPE().set("s-de-outro-board", boardScope("orbit"));
    const res = await post({ boardId: "acme", text: "oi", sessionId: "s-de-outro-board" });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { reason?: string };
    expect(json.reason).toBe("session-board-mismatch");
    expect(classifyTurnRejection(res.status, JSON.stringify(json))).toEqual({ kind: "fatal" });
  });

  it("uma sessão que nasceu na conversa de uma TELA não pode ser retomada no chat do board", async () => {
    // Sem isto, o `--resume` despejaria a conversa da tela no thread do Jido: mesmo processo, mesmo
    // transcript, contexto de outra conversa.
    SESSION_SCOPE().set("s-de-ideias", viewScope("acme", "ideias"));
    const res = await post({ boardId: "acme", text: "oi", sessionId: "s-de-ideias" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason?: string }).reason).toBe("session-board-mismatch");
  });

  // NOTE: the guard-PASS path is deliberately not unit-tested here — the route's ReadableStream `start` runs on
  // construction and would spawn a real `claude`. The pass-through logic (board-scoped liveness) is covered by
  // agent-session.test.ts (hasLiveCopilotTurnForBoard).

  it("rejects malformed input before the guard (400)", async () => {
    expect((await post({ boardId: "NOT VALID SLUG", text: "x" })).status).toBe(400);
    expect((await post({ boardId: "acme", text: "   " })).status).toBe(400);
    // A view entra na CHAVE da raia — um nome com barra/dois-pontos poderia colidir com outra raia.
    expect((await post({ boardId: "acme", text: "x", view: "../outro:board" })).status).toBe(400);
  });

  // Chat por TELA. Uma tela SEM entrada no registro de superfícies não ganha um chat genérico por acidente:
  // cada conversa que existe é uma decisão declarada (persona, poder, rótulo).
  it("uma tela sem chat declarado é recusada (fail-closed), não vira conversa genérica", async () => {
    const res = await post({ boardId: "acme", text: "oi", view: "priorizacao" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/sem chat para a tela/i);
  });

  it("o slot e o gate do tick são do CHAT DO BOARD — a conversa de uma tela corre ao lado", () => {
    // Não dá para provar POSTando: o caminho que PASSA do guard constrói o stream e spawna um `claude` de
    // verdade (ver a nota acima). A prova possível aqui é o registro que os guards leem.
    expect(reserveCopilotTurnSlot(NEST).ok).toBe(true);
    expect(reserveCopilotTurnSlot(viewScope("acme", "ideias")).ok).toBe(true);
  });
});
