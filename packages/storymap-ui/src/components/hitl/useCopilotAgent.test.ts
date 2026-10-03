import { describe, expect, it } from "vitest";
import { deriveTurnError } from "./useCopilotAgent";

// WS-3/3.3 — a failed turn must never surface the raw `{ok:false,...}` envelope as a chat bubble. The bubble text
// is built from deriveTurnError, so asserting on the pure fn IS the "no bubble contains {"ok":false" guarantee.
describe("deriveTurnError (WS-3/3.3)", () => {
  it("409 TRANSITÓRIO → mensagem amigável que aponta a FILA (não pede reenvio: a fila reenvia sozinha)", () => {
    for (const body of [
      JSON.stringify({ ok: false, error: "o Jido autônomo está agindo neste board agora", reason: "autonomous-tick" }),
      JSON.stringify({ ok: false, error: "já há um turno em andamento neste board", reason: "turn-in-flight" }),
      JSON.stringify({ ok: false, error: "já há um turno em andamento neste board" }), // servidor antigo, sem reason
    ]) {
      const msg = deriveTurnError(409, body);
      expect(msg).toContain("copiloto trabalhando");
      expect(msg).toContain("fila");
    }
  });

  it("409 PERMANENTE (sessão de outro board) → o erro real, nunca a copy de ocupado (esperar não resolveria)", () => {
    const msg = deriveTurnError(409, JSON.stringify({ ok: false, error: "sessão atrelada a outro board", reason: "session-board-mismatch" }));
    expect(msg).toBe("sessão atrelada a outro board");
  });

  it("non-409 JSON envelope → the parsed .error, never the raw body", () => {
    expect(deriveTurnError(400, JSON.stringify({ ok: false, error: "invalid boardId" }))).toBe("invalid boardId");
  });

  it("500 with a non-JSON text body → HTTP 500", () => {
    expect(deriveTurnError(500, "Internal Server Error")).toBe("HTTP 500");
  });

  it("empty / unparseable body → HTTP <status>", () => {
    expect(deriveTurnError(502, "")).toBe("HTTP 502");
    expect(deriveTurnError(503, "<html>bad gateway</html>")).toBe("HTTP 503");
  });

  it('a JSON envelope with a blank .error falls back to HTTP <status> (never leaks "{}")', () => {
    expect(deriveTurnError(500, JSON.stringify({ ok: false, error: "   " }))).toBe("HTTP 500");
  });

  it('no derived message ever contains the literal {"ok":false', () => {
    for (const status of [409, 400, 500, 502]) {
      const body = JSON.stringify({ ok: false, error: "boom" });
      expect(deriveTurnError(status, body)).not.toContain('{"ok":false');
    }
  });
});
