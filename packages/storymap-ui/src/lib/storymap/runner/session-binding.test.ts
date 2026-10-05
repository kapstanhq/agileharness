// O vínculo do servidor entre a requisição e a sessão (session-binding.ts) e a prova que o sustenta (session-proof.ts):
// só o rótulo com a prova CERTA, de uma sessão VIVA no registro, liga; o resto vale só como atribuição e fica no log
// (uma vez por sessão e motivo, por hora). Fixtures inventadas.

import { beforeEach, describe, expect, it } from "vitest";
import { resetSessionBindingLogForTests, sessionBindingOf } from "./session-binding";
import { parseSessionProof, sessionProofFor, verifySessionProof } from "@/lib/storymap/mcp/session-proof";
import type { McpActor } from "@/lib/storymap/mcp/actor";

const SECRET = "segredo-de-teste-da-bancada-0123456789";
const sessions = [
  { sessionId: "s-viva", agentId: "s-viva", role: "worker", board: "oficina", cardId: "story-ex7301", task: "t", openedAt: "", heartbeatAt: "" },
  { sessionId: "s-morta", agentId: "s-morta", role: "worker", board: "oficina", cardId: "story-ex7302", task: "t", openedAt: "", heartbeatAt: "", endedAt: "2026-02-01T00:00:00Z" },
] as never[];
const actor = (id: string, proof?: string | null): McpActor => ({ level: "orch", caller: { kind: "session", id, ...(proof ? { proof } : {}) } });

let logs: string[] = [];
const d = () => ({ sessions: async () => sessions, secret: () => SECRET, log: (l: string) => void logs.push(l), now: () => 1_000 });
beforeEach(() => {
  logs = [];
  resetSessionBindingLogForTests();
});

describe("sessionProofFor / verifySessionProof", () => {
  it("a prova é por sessão e por segredo; sem segredo utilizável não há prova", () => {
    const p = sessionProofFor("s-viva", SECRET)!;
    expect(p).toMatch(/^[0-9a-f]{32}$/);
    expect(verifySessionProof("s-viva", p, SECRET)).toBe(true);
    expect(verifySessionProof("s-morta", p, SECRET)).toBe(false);
    expect(verifySessionProof("s-viva", p, `${SECRET}x`)).toBe(false);
    expect(verifySessionProof("s-viva", "zz", SECRET)).toBe(false);
    expect(sessionProofFor("s-viva", "curto")).toBeNull();
    expect(parseSessionProof(` ${p.toUpperCase()} `)).toBe(p);
    expect(parseSessionProof("texto livre")).toBeNull();
  });
});

describe("sessionBindingOf", () => {
  it("sem rótulo de sessão ⇒ none", async () => {
    expect(await sessionBindingOf({ level: "orch" }, d())).toEqual({ state: "none" });
    expect(await sessionBindingOf(undefined, d())).toEqual({ state: "none" });
  });

  it("rótulo com a prova certa de sessão viva ⇒ bound", async () => {
    const b = await sessionBindingOf(actor("s-viva", sessionProofFor("s-viva", SECRET)), d());
    expect(b).toMatchObject({ state: "bound", session: { sessionId: "s-viva" } });
  });

  it("rótulo sem prova, com prova de outra sessão, de sessão encerrada ou fora do registro ⇒ unproven e registrado", async () => {
    expect((await sessionBindingOf(actor("s-viva"), d())).state).toBe("unproven");
    expect((await sessionBindingOf(actor("s-viva", sessionProofFor("s-morta", SECRET)), d())).state).toBe("unproven");
    expect((await sessionBindingOf(actor("s-morta", sessionProofFor("s-morta", SECRET)), d())).state).toBe("unproven");
    expect((await sessionBindingOf(actor("s-nenhuma", sessionProofFor("s-nenhuma", SECRET)), d())).state).toBe("unproven");
    expect(logs).toHaveLength(4);
    expect(logs[0]).toMatch(/IGNORADO/);
  });

  it("o mesmo rótulo inválido repetido não inunda o log (uma vez por hora)", async () => {
    await sessionBindingOf(actor("s-viva"), d());
    await sessionBindingOf(actor("s-viva"), d());
    expect(logs).toHaveLength(1);
  });
});
