import { describe, expect, it } from "vitest";
import {
  agentSessionIdFromBranch,
  branchLiveness,
  isSessionAlive,
  publishEmbargoTtlMs,
  PUBLISH_EMBARGO_TTL_MS,
  SESSION_HEARTBEAT_TTL_MS,
  type SessionLiveness,
} from "./session-liveness";

const NOW = 1_700_000_000_000;
const row = (over: Partial<SessionLiveness> = {}): SessionLiveness => ({
  sessionId: "s1",
  heartbeatAt: new Date(NOW - 60_000).toISOString(), // 1 min atrás
  worktreePath: "/w/agent-s1",
  task: "trabalhando",
  ...over,
});

describe("isSessionAlive", () => {
  it("viva dentro do TTL, morta depois", () => {
    expect(isSessionAlive(row(), NOW)).toBe(true);
    expect(isSessionAlive(row({ heartbeatAt: new Date(NOW - SESSION_HEARTBEAT_TTL_MS - 1).toISOString() }), NOW)).toBe(false);
  });

  it("carimbo ILEGÍVEL lê como VIVA (fail-closed)", () => {
    // Um erro de parse jamais pode autorizar apagar a árvore de quem está trabalhando.
    expect(isSessionAlive(row({ heartbeatAt: "não é data" }), NOW)).toBe(true);
    expect(isSessionAlive(row({ heartbeatAt: "" }), NOW)).toBe(true);
  });
});

describe("agentSessionIdFromBranch", () => {
  it("extrai só de agent/*", () => {
    expect(agentSessionIdFromBranch("agent/abc-123")).toBe("abc-123");
    expect(agentSessionIdFromBranch("run/abc")).toBeNull();
    expect(agentSessionIdFromBranch("main")).toBeNull();
    expect(agentSessionIdFromBranch(undefined)).toBeNull();
  });
});

describe("branchLiveness — a decisão que protege a árvore", () => {
  it("branch de sessão viva ⇒ live, com o id e a tarefa (para o log dizer QUEM)", () => {
    const r = branchLiveness("agent/s1", [row()], NOW);
    expect(r).toMatchObject({ live: true, sessionId: "s1", task: "trabalhando" });
  });

  it("heartbeat vencido ⇒ liberado (é o lixo que o reaper existe para colher)", () => {
    const velha = row({ heartbeatAt: new Date(NOW - SESSION_HEARTBEAT_TTL_MS - 1).toISOString() });
    expect(branchLiveness("agent/s1", [velha], NOW)).toEqual({ live: false, reason: "heartbeat-expired" });
  });

  it("branch que não é de sessão (run/*) ⇒ liberado", () => {
    expect(branchLiveness("run/xyz", [row()], NOW)).toEqual({ live: false, reason: "not-a-session-branch" });
  });

  it("sessão fora do registro ⇒ liberado", () => {
    expect(branchLiveness("agent/desconhecida", [row()], NOW)).toEqual({ live: false, reason: "unknown-session" });
  });

  it("registro ILEGÍVEL ⇒ 'unknown', NUNCA false", () => {
    // Colapsar isto em `false` é exatamente o bug que já varreu uma frota inteira: uma falha de
    // leitura virando "todo mundo morreu". O chamador trata `unknown` como recusa.
    expect(branchLiveness("agent/s1", null, NOW)).toEqual({ live: "unknown", reason: "registry-unreadable" });
  });
});

// A janela do EMBARGO de publicação. Ela existe SEPARADA do TTL da reaper porque as duas decisões têm
// risco oposto: apagar a árvore de um agente é destrutivo (erra ⇒ perde trabalho), enquanto deixar de
// embargar não toca em nada da outra sessão (erra ⇒ conflito no submit, que é o caminho desenhado).
// Herdar as 6h aqui foi o que deixou uma sessão morta às 23:33 segurar a publicação do board inteiro.
describe("publishEmbargoTtlMs — a janela do embargo é MENOR que a da reaper, e por quê", () => {
  it("default de 90min — menor que o TTL de liveness", () => {
    expect(publishEmbargoTtlMs({})).toBe(PUBLISH_EMBARGO_TTL_MS);
    expect(PUBLISH_EMBARGO_TTL_MS).toBeLessThan(SESSION_HEARTBEAT_TTL_MS);
  });

  it("o operador ajusta pelo env", () => {
    expect(publishEmbargoTtlMs({ AGILEHARNESS_PUBLISH_EMBARGO_TTL_MS: "60000" })).toBe(60_000);
  });

  it("lixo / zero / negativo caem no default — a guarda nunca é desligada por acidente", () => {
    for (const v of ["", "abc", "0", "-1"]) {
      expect(publishEmbargoTtlMs({ AGILEHARNESS_PUBLISH_EMBARGO_TTL_MS: v })).toBe(PUBLISH_EMBARGO_TTL_MS);
    }
  });

  it("TETO no TTL de liveness: quem já está MORTO para o resto do sistema não segue embargando", () => {
    expect(publishEmbargoTtlMs({ AGILEHARNESS_PUBLISH_EMBARGO_TTL_MS: String(SESSION_HEARTBEAT_TTL_MS * 10) })).toBe(
      SESSION_HEARTBEAT_TTL_MS,
    );
  });

  it("uma sessão calada há 4h NÃO embarga, mas ainda é VIVA para a reaper — os dois fatos coexistem", () => {
    const quatroHoras = { heartbeatAt: new Date(NOW - 4 * 60 * 60 * 1000).toISOString() };
    expect(isSessionAlive(quatroHoras, NOW, publishEmbargoTtlMs({}))).toBe(false); // não segura a publicação
    expect(isSessionAlive(quatroHoras, NOW)).toBe(true); // e a árvore dela segue protegida
  });
});
