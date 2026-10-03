// As INVARIANTES do roster de conversas: uma aberta, as anteriores recuperáveis, e nada some por troca.
// Puro (sem fs) — o shell com lock/disco é exercitado em session-store.test.ts.

import { describe, it, expect } from "vitest";
import {
  EMPTY_ROSTER,
  MAX_RECOVERABLE_CHATS,
  activateChat,
  activeChat,
  forgetChats,
  recordChatTurn,
  recoverableChats,
  resumeChat,
  setChatTitle,
  startNewChat,
  trimRoster,
  type ChatRoster,
} from "./chat-roster";

const T = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

/** Abre N conversas em sequência, cada uma com um turno — o caminho real (turno abre + turno fecha). */
function withChats(n: number, from = 0): ChatRoster {
  let r = EMPTY_ROSTER;
  for (let i = from; i < from + n; i++) {
    r = activateChat(r, `s${i}`, T(i));
    r = recordChatTurn(r, `s${i}`, { contextTokens: 100 + i, costUSD: 1 }, T(i));
    r = startNewChat(r);
  }
  return r;
}

describe("chat-roster — uma conversa aberta, as anteriores recuperáveis", () => {
  it("abrir uma sessão a torna a ativa e a põe na frente do MRU", () => {
    const r = activateChat(activateChat(EMPTY_ROSTER, "a", T(0)), "b", T(1));
    expect(r.activeSessionId).toBe("b");
    expect(r.chats.map((c) => c.sessionId)).toEqual(["b", "a"]);
    expect(activeChat(r)?.sessionId).toBe("b");
  });

  it("re-abrir a que já está aberta não mexe em nada (idempotente)", () => {
    const r = activateChat(EMPTY_ROSTER, "a", T(0));
    expect(activateChat(r, "a", T(5))).toBe(r); // mesma identidade ⇒ nenhuma escrita a jusante
  });

  it('"Nova conversa" ARQUIVA em vez de apagar: nada aberto, mas a conversa segue recuperável', () => {
    let r = activateChat(EMPTY_ROSTER, "a", T(0));
    r = recordChatTurn(r, "a", { contextTokens: 500, costUSD: 2 }, T(1));
    r = startNewChat(r);
    expect(r.activeSessionId).toBeNull();
    expect(activeChat(r)).toBeNull();
    expect(recoverableChats(r).map((c) => c.sessionId)).toEqual(["a"]); // o histórico continua lá
    expect(recoverableChats(r)[0].contextTokens).toBe(500); // …com o medidor dela intacto
  });

  it("retomar uma conversa do histórico a reabre e fecha a anterior (só uma aberta)", () => {
    let r = activateChat(EMPTY_ROSTER, "a", T(0));
    r = startNewChat(r);
    r = activateChat(r, "b", T(1));
    const back = resumeChat(r, "a");
    expect(back).not.toBeNull();
    expect(back!.activeSessionId).toBe("a");
    expect(back!.chats.map((c) => c.sessionId)).toEqual(["a", "b"]); // a retomada vai para a frente
    expect(recoverableChats(back!).map((c) => c.sessionId)).toEqual(["b"]); // e a outra vira histórico
  });

  it("retomar uma sessão que não está no roster é recusado (um id qualquer não vira ponteiro do board)", () => {
    expect(resumeChat(activateChat(EMPTY_ROSTER, "a", T(0)), "forasteira")).toBeNull();
  });

  // ── O TETO ────────────────────────────────────────────────────────────────────────────────────────────
  it(`guarda ${MAX_RECOVERABLE_CHATS} anteriores + a aberta, e expulsa a MAIS ANTIGA`, () => {
    let r = withChats(MAX_RECOVERABLE_CHATS + 1); // 6 conversas fechadas
    expect(r.chats).toHaveLength(MAX_RECOVERABLE_CHATS); // sem nada aberto, o teto é o das recuperáveis
    expect(r.chats.map((c) => c.sessionId)).not.toContain("s0"); // a mais antiga saiu
    r = activateChat(r, "nova", T(99)); // e a aberta cabe ALÉM das 5
    expect(r.chats).toHaveLength(MAX_RECOVERABLE_CHATS + 1);
    expect(recoverableChats(r)).toHaveLength(MAX_RECOVERABLE_CHATS);
    expect(r.activeSessionId).toBe("nova");
  });

  it("a conversa ABERTA nunca é expulsa pelo teto, mesmo sendo a mais antiga", () => {
    let r = activateChat(EMPTY_ROSTER, "velha", T(0));
    // 6 outras conversas, todas mais recentes, entram e saem enquanto "velha" segue aberta.
    for (let i = 0; i < MAX_RECOVERABLE_CHATS + 1; i++) {
      r = { ...r, chats: [{ sessionId: `x${i}`, startedAt: T(i + 1), lastTurnAt: T(i + 1), turns: 1, contextTokens: 1, costUSD: 0 }, ...r.chats] };
      r = trimRoster(r);
    }
    expect(r.chats.map((c) => c.sessionId)).toContain("velha");
    expect(recoverableChats(r)).toHaveLength(MAX_RECOVERABLE_CHATS);
  });

  // ── O TOMBSTONE (o straggler do turno em voo) ────────────────────────────────────────────────────────
  it("um turno em voo da conversa arquivada NÃO a reabre sozinho", () => {
    let r = activateChat(EMPTY_ROSTER, "a", T(0));
    r = startNewChat(r);
    r = activateChat(r, "a", T(1)); // início de turno/tick atrasado
    r = recordChatTurn(r, "a", { contextTokens: 9, costUSD: 9 }, T(2)); // fim de turno atrasado
    expect(r.activeSessionId).toBeNull();
    expect(recoverableChats(r).map((c) => c.sessionId)).toEqual(["a"]); // continua no histórico, e fechada
  });

  it("…mas a retomada EXPLÍCITA do operador supera o tombstone", () => {
    let r = startNewChat(activateChat(EMPTY_ROSTER, "a", T(0)));
    const back = resumeChat(r, "a")!;
    expect(back.activeSessionId).toBe("a");
    expect(back.discardedSessionId).toBeNull();
    r = activateChat(back, "a", T(3)); // e a partir daí os turnos dela voltam a fluir
    expect(r.activeSessionId).toBe("a");
  });

  it("um straggler de uma conversa ANTIGA atualiza o medidor dela sem roubar a tela", () => {
    let r = activateChat(EMPTY_ROSTER, "a", T(0));
    r = startNewChat(r); // tombstone = a
    r = activateChat(r, "b", T(1));
    r = startNewChat(r); // tombstone = b — "a" agora é histórico comum
    r = activateChat(r, "c", T(2));
    r = recordChatTurn(r, "a", { contextTokens: 42, costUSD: 0.5 }, T(3));
    expect(r.activeSessionId).toBe("c"); // quem está na tela não muda
    expect(r.chats.map((x) => x.sessionId)).toEqual(["c", "b", "a"]); // nem a ordem
    expect(r.chats.find((x) => x.sessionId === "a")?.contextTokens).toBe(42); // mas o medidor DELA fica certo
  });

  it("um straggler de uma sessão já EXPULSA do roster não a ressuscita", () => {
    const r = withChats(MAX_RECOVERABLE_CHATS + 1);
    const after = recordChatTurn(r, "s0", { contextTokens: 1, costUSD: 1 }, T(50));
    expect(after).toBe(r);
  });

  // ── Medidor ──────────────────────────────────────────────────────────────────────────────────────────
  it("o contexto SUBSTITUI (é medida) e o custo SOMA (é acumulador); startedAt não anda", () => {
    let r = activateChat(EMPTY_ROSTER, "a", T(0));
    r = recordChatTurn(r, "a", { contextTokens: 100, costUSD: 1 }, T(1));
    r = recordChatTurn(r, "a", { contextTokens: 150, costUSD: 2 }, T(2));
    r = recordChatTurn(r, "a", { contextTokens: null, costUSD: 0.5 }, T(3)); // turno sem medida de contexto
    const c = activeChat(r)!;
    expect(c.turns).toBe(3);
    expect(c.contextTokens).toBe(150); // mantém o último conhecido
    expect(c.costUSD).toBeCloseTo(3.5);
    expect(c.startedAt).toBe(T(0));
    expect(c.lastTurnAt).toBe(T(3));
  });

  // ── Rótulo + poda ────────────────────────────────────────────────────────────────────────────────────
  it("o rótulo é cacheado sem mexer em ordem nem em quem está aberto", () => {
    let r = activateChat(activateChat(EMPTY_ROSTER, "a", T(0)), "b", T(1));
    r = setChatTitle(r, "a", "  Investigar o merge train  ");
    expect(r.chats.find((c) => c.sessionId === "a")?.title).toBe("Investigar o merge train");
    expect(r.activeSessionId).toBe("b");
    expect(setChatTitle(r, "a", "Investigar o merge train")).toBe(r); // sem mudança ⇒ sem escrita
    expect(setChatTitle(r, "inexistente", "x")).toBe(r);
  });

  it("esquecer transcripts sumidos tira-os da lista (e fecha a aberta, se era ela)", () => {
    let r = activateChat(EMPTY_ROSTER, "a", T(0));
    r = startNewChat(r);
    r = activateChat(r, "b", T(1));
    const after = forgetChats(r, ["b"]);
    expect(after.activeSessionId).toBeNull();
    expect(after.chats.map((c) => c.sessionId)).toEqual(["a"]);
    expect(forgetChats(r, [])).toBe(r);
  });
});
