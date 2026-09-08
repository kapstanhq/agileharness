import { describe, it, expect } from "vitest";
import { deriveRunAttempt, MUTATING_RISK_CLASSES } from "./noop-attribution";
import type { AgentAction } from "./agent-actions";
import type { RiskClass } from "@/lib/storymap/types";

// WS-12 (D16) — a atribuição é DETERMINÍSTICA e vem do LEDGER DO GUARD: as tool calls que de fato aconteceram,
// com o cardId lido dos args canônicos. Nunca da presença do item no board, nunca do auto-relato do run.

const ORCH = "STORYMAP_MCP_TOKEN_ORCH";
const T0 = Date.parse("2026-07-16T15:00:00Z");
const WINDOW = { board: "acme", from: T0, to: T0 + 60_000, actor: ORCH };

const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  v: 1,
  at: new Date(T0 + 1_000).toISOString(),
  actor: ORCH,
  board: "acme",
  tool: "move_card",
  cls: "write-board",
  disposition: "auto",
  outcome: "executed",
  ...over,
});

describe("WS-12.1 — deriveRunAttempt: quem o run TENTOU, segundo o ledger", () => {
  it("uma ação mutante num card ⇒ aquele card foi tentado (e o run não é no-op)", () => {
    const r = deriveRunAttempt([action({ cardId: "story-eqpdtz" })], WINDOW);
    expect(r.anyMutation).toBe(true);
    expect([...r.attemptedCardIds]).toEqual(["story-eqpdtz"]);
  });

  it("um card SÓ LIDO não foi tentado — olhar não é tentar (cls read fora do conjunto mutante)", () => {
    const r = deriveRunAttempt([action({ cardId: "story-xfleex", cls: "read", tool: "get_card" })], WINDOW);
    expect(r.anyMutation).toBe(false);
    expect(r.attemptedCardIds.size).toBe(0);
  });

  it("as 4 classes MUTANTES contam como tentativa; read/run-free/destructive não", () => {
    for (const cls of ["write-board", "run", "merge-resolve", "deploy"] as RiskClass[]) {
      expect(deriveRunAttempt([action({ cardId: "c", cls })], WINDOW).attemptedCardIds.has("c")).toBe(true);
    }
    for (const cls of ["read", "run-free", "destructive"] as RiskClass[]) {
      expect(deriveRunAttempt([action({ cardId: "c", cls })], WINDOW).attemptedCardIds.has("c")).toBe(false);
    }
    expect([...MUTATING_RISK_CLASSES].sort()).toEqual(["deploy", "merge-resolve", "run", "write-board"]);
  });

  it("uma tentativa RECUSADA/ESCALADA ainda é uma tentativa (o run gastou o turno e o item não moveu)", () => {
    for (const outcome of ["executed", "grant-consumed", "pending", "refused"] as const) {
      const r = deriveRunAttempt([action({ cardId: "c", outcome })], WINDOW);
      expect(r.attemptedCardIds.has("c"), `outcome ${outcome}`).toBe(true);
    }
  });

  it("ação FORA da janela do run não é dele (ledger é global e append-only)", () => {
    const antes = action({ cardId: "c", at: new Date(T0 - 1).toISOString() });
    const depois = action({ cardId: "c", at: new Date(T0 + 60_001).toISOString() });
    expect(deriveRunAttempt([antes, depois], WINDOW).anyMutation).toBe(false);
  });

  it("ação de OUTRO ator escopado na mesma janela NÃO é creditada a este run", () => {
    const r = deriveRunAttempt([action({ cardId: "c", actor: "STORYMAP_MCP_TOKEN_SESSION" })], WINDOW);
    expect(r.anyMutation).toBe(false);
    expect(r.attemptedCardIds.size).toBe(0);
  });

  it("ação provadamente de OUTRO board é ignorada (dois ticks podem correr juntos)", () => {
    const r = deriveRunAttempt([action({ cardId: "c", board: "storymap" })], WINDOW);
    expect(r.anyMutation).toBe(false);
  });

  it("entry LEGADA (sem cardId) não é atribuível — mas prova que o run agiu (fail-safe: pune ninguém)", () => {
    const r = deriveRunAttempt([action({ cardId: undefined })], WINDOW);
    expect(r.anyMutation).toBe(true);
    expect(r.attemptedCardIds.size).toBe(0);
  });

  it("mutante SEM board (resolve_merge → runId) suprime o no-op geral sem atribuir a card", () => {
    const r = deriveRunAttempt([action({ cls: "merge-resolve", tool: "resolve_merge", board: undefined, cardId: undefined })], WINDOW);
    expect(r.anyMutation).toBe(true); // o run AGIU ⇒ não é o no-op verdadeiro ⇒ ninguém apanha por tabela
    expect(r.attemptedCardIds.size).toBe(0);
  });

  it("linha corrompida (at ilegível) é descartada em vez de derrubar a atribuição", () => {
    const r = deriveRunAttempt([action({ cardId: "c", at: "não é data" })], WINDOW);
    expect(r.anyMutation).toBe(false);
  });
});
