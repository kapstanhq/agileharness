import { describe, expect, it } from "vitest";
import { actorRole, currentMcpActor, isScopedActor, noteResolvedRole, roleKindOf, runWithMcpActor, transitionActorLabel } from "./actor";
import { isAgentTransitionActor } from "@/lib/storymap/runner/transitions";

describe("mcp actor (F5.1) — AsyncLocalStorage identity", () => {
  it("currentMcpActor is undefined outside a request context (internal call → fail-open)", () => {
    expect(currentMcpActor()).toBeUndefined();
    expect(isScopedActor()).toBe(false);
    expect(transitionActorLabel()).toBe("human");
  });

  it("propagates the actor through the sync + async chain", async () => {
    await runWithMcpActor({ level: "write", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, async () => {
      expect(currentMcpActor()).toEqual({ level: "write", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" });
      expect(isScopedActor()).toBe(true);
      // fase 6: um agente escopado que não se nomeou é `external:anon` — nunca mais `run:orch` para todo mundo
      expect(transitionActorLabel()).toBe("external:anon");
      // survives an await (the ALS store rides the async chain)
      await Promise.resolve();
      expect(isScopedActor()).toBe(true);
    });
    // store is gone after the callback returns
    expect(currentMcpActor()).toBeUndefined();
  });

  it("a `full` operator token is NOT a scoped actor (the guard must not gate the human)", () => {
    runWithMcpActor({ level: "full", tokenEnv: "AGILEHARNESS_MCP_TOKEN" }, () => {
      expect(isScopedActor()).toBe(false);
      expect(transitionActorLabel()).toBe("human");
    });
  });

  it("a `ro` token is scoped too (read-only agent still isn't the operator)", () => {
    runWithMcpActor({ level: "ro" }, () => {
      expect(isScopedActor()).toBe(true);
      expect(transitionActorLabel()).toBe("external:anon");
    });
  });
});

describe("atribuição por PAPEL (fase 6)", () => {
  it("cada rótulo vira o papel real — condutor, Sentinela, chat, procurador, crítico, agente de fora, sessão", () => {
    const w = (caller: Parameters<typeof actorRole>[0] extends infer A ? (A extends { caller?: infer C } ? C : never) : never) => ({ level: "write" as const, caller });
    expect(actorRole(w({ kind: "session", id: "s1" }), { driver: "conductor", cardId: "story-ex9001" })).toBe("conductor:story-ex9001");
    expect(actorRole(w({ kind: "session", id: "s1" }), { driver: null, name: "trabalho" })).toBe("session:trabalho");
    expect(actorRole(w({ kind: "session", id: "s1" }), null)).toBe("session:s1");
    expect(actorRole(w({ kind: "sentinel", id: "livraria" }))).toBe("sentinel");
    expect(actorRole(w({ kind: "copilot-tick", id: "livraria" }))).toBe("sentinel");
    expect(actorRole(w({ kind: "proxy", id: "livraria" }))).toBe("proxy");
    expect(actorRole(w({ kind: "critic", id: "story-ex9001" }))).toBe("critic");
    expect(actorRole(w({ kind: "external", id: "meu-script" }))).toBe("external:meu-script");
    // o chat do Copiloto usa o token full e continua sendo o chat, não o dono
    expect(actorRole({ level: "full", caller: { kind: "copilot-chat", id: "livraria" } })).toBe("chat");
    expect(actorRole({ level: "full", caller: { kind: "doc-chat", id: "livraria.prd" } })).toBe("chat");
    expect(actorRole({ level: "full" })).toBe("human");
    expect(actorRole(undefined)).toBe("human");
  });

  it("o papel que a guarda resolveu (com o registro de sessões) é o que o salto de status grava na mesma requisição", () => {
    const actor = { level: "write" as const, caller: { kind: "session" as const, id: "s9" } };
    runWithMcpActor(actor, () => {
      expect(transitionActorLabel()).toBe("session:s9");
      noteResolvedRole(actor, "conductor:story-ex9002");
      expect(transitionActorLabel()).toBe("conductor:story-ex9002");
    });
  });

  it("roleKindOf é a chave do balde por hora; todo papel de agente conta como salto de agente", () => {
    expect(roleKindOf("conductor:story-ex9001")).toBe("conductor");
    expect(roleKindOf("sentinel")).toBe("sentinel");
    expect(roleKindOf("external:anon")).toBe("external");
    expect(roleKindOf("qualquer-coisa")).toBe("external");
    for (const a of ["conductor:story-ex9001", "sentinel", "chat", "proxy", "critic", "external:anon", "session:x", "run:orch"]) expect(isAgentTransitionActor(a)).toBe(true);
    for (const a of ["human", "cascade", "system", "merge", "run:harness-enrich"]) expect(isAgentTransitionActor(a)).toBe(false);
  });
});
