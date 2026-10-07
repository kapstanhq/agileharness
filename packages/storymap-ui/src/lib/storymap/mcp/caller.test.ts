import { describe, expect, it } from "vitest";
import { callerAttribution, callerTag, callerWords, credentialBoundCaller, demoteUnprovenServiceCaller, docChatCaller, isCopilotCaller, isDocChatOf, parseCallerTag, toWhomWords } from "./caller";
import { approvalRequesterText } from "@/lib/storymap/approval-requester";
import { buildOrchestratorMcpConfig } from "@/lib/storymap/runner/orchestrator-spawn";
import { MCP_CALLER_HEADER } from "./caller";

describe("quem chama uma tool — o rótulo que o agente declara de si", () => {
  it("vai e volta pelo cabeçalho; o que não é do formato é ignorado (nunca texto livre)", () => {
    for (const c of [
      { kind: "session", id: "0f3a-9c" },
      { kind: "copilot-tick", id: "acme" },
      { kind: "copilot-chat", id: "acme" },
      { kind: "doc-chat", id: "acme.produto" },
      { kind: "external", id: "orquestrador.v2" },
    ] as const) {
      expect(parseCallerTag(callerTag(c))).toEqual(c);
    }
    for (const bad of [null, undefined, "", "session", "session:", ":abc", "dono:eu", "session:a b", "session:../x", "session:" + "a".repeat(65), "external:<script>", " ".repeat(200)]) {
      expect(parseCallerTag(bad), String(bad)).toBeNull();
    }
    expect(parseCallerTag("  session:abc  ")).toEqual({ kind: "session", id: "abc" });
  });

  it("a atribuição diz o que a sessão É no registro: condutor de um card, ou uma sessão de trabalho", () => {
    expect(callerAttribution(null)).toBeNull();
    expect(callerAttribution({ kind: "copilot-tick", id: "acme" })).toBe("copilot:acme");
    expect(callerAttribution({ kind: "copilot-chat", id: "acme" })).toBe("copilot:acme");
    expect(callerAttribution({ kind: "external", id: "orq" })).toBe("external:orq");
    // a conversa de uma página de documento é o Jido do board: a página não muda quem fala
    expect(callerAttribution(docChatCaller("acme", "produto"))).toBe("copilot:acme");
    expect(callerAttribution({ kind: "session", id: "s1" }, { driver: "conductor", cardId: "story-x", name: "agent-conductor-story-x" })).toBe("conductor:story-x");
    expect(callerAttribution({ kind: "session", id: "s1" }, { name: "agent-fix" })).toBe("session:agent-fix");
    expect(callerAttribution({ kind: "session", id: "s1" }, null)).toBe("session:s1"); // saiu do registro
    expect(isCopilotCaller({ kind: "copilot-tick", id: "acme" })).toBe(true);
    expect(isCopilotCaller({ kind: "session", id: "s1" })).toBe(false);
    expect(isCopilotCaller(undefined)).toBe(false);
  });

  it("as palavras: o Jido, o condutor do card, uma sessão, um agente de fora — e null para o que não é rótulo", () => {
    expect(callerWords("copilot:acme")).toBe("O Jido");
    expect(callerWords("conductor:story-x")).toBe("O condutor do card story-x");
    expect(callerWords("session:agent-fix")).toBe("Uma sessão de agente (agent-fix)");
    // o uuid que a ferramenta cunhou não diz nada a quem lê (story-ex9603)
    expect(callerWords("session:00000000-0000-4000-8000-0000000000a1")).toBe("Uma sessão de trabalho");
    expect(callerWords("external:orq")).toBe("Um agente de fora (orq)");
    for (const other of [null, "", "run:orch", "mcp:write(TOKEN)", "handle:h1", "conductor:"]) expect(callerWords(other)).toBeNull();
    expect(toWhomWords("O condutor do card story-x")).toBe("ao condutor do card story-x");
    expect(toWhomWords("Uma sessão de agente (a)")).toBe("a uma sessão de agente (a)");
    expect(toWhomWords("Um agente")).toBe("a um agente");
  });

  it("o pedido de aprovação diz quem pediu pelo rótulo; os formatos antigos seguem como eram", () => {
    expect(approvalRequesterText("conductor:story-x")).toBe("O condutor do card story-x");
    expect(approvalRequesterText("copilot:acme")).toBe("O Jido");
    expect(approvalRequesterText("mcp:write(AGILEHARNESS_MCP_TOKEN_ORCH)")).toBe("Um agente com a credencial AGILEHARNESS_MCP_TOKEN_ORCH");
    expect(approvalRequesterText("run:orch")).toBe("Um agente autônomo");
    expect(approvalRequesterText(undefined)).toBe("Um agente");
  });

  it("a configuração de MCP que a ferramenta escreve para o agente leva o rótulo num cabeçalho — e só quando há um", () => {
    const named = JSON.parse(buildOrchestratorMcpConfig("tok", 3008, { kind: "session", id: "s1" }));
    expect(named.mcpServers.storymap).toMatchObject({ type: "http", headers: { [MCP_CALLER_HEADER]: "session:s1" } });
    expect(JSON.parse(buildOrchestratorMcpConfig("tok", 3008)).mcpServers.storymap.headers).toBeUndefined();
  });
});

describe("a conversa da PÁGINA de um documento — o rótulo que o write_doc do PRD aceita", () => {
  it("é da página e do board certos; outra página, outro board ou outro tipo de chamador não é", () => {
    const c = docChatCaller("acme", "produto");
    expect(isDocChatOf(c, "acme", "produto")).toBe(true);
    expect(isDocChatOf(c, "acme", "negocio")).toBe(false);
    expect(isDocChatOf(c, "outro", "produto")).toBe(false);
    expect(isDocChatOf({ kind: "copilot-chat", id: "acme.produto" }, "acme", "produto")).toBe(false);
    expect(isDocChatOf(undefined, "acme", "produto")).toBe(false);
    expect(isCopilotCaller(c)).toBe(true);
  });
});

// Fase 6 — os papéis do SERVIÇO escolhem o balde do limite por hora e a voz da trilha: só valem PROVADOS.
describe("papéis do serviço: a credencial prova, o rótulo não", () => {
  it("o handle da Sentinela (rótulo `sentinel:<board>`) é a Sentinela, com o cabeçalho ou sem", () => {
    expect(credentialBoundCaller("sentinel:livraria")).toEqual({ kind: "sentinel", id: "livraria" });
    expect(credentialBoundCaller("sentinel:host")).toEqual({ kind: "sentinel", id: "host" });
    expect(credentialBoundCaller("conector do chat web")).toBeNull();
    expect(credentialBoundCaller(undefined)).toBeNull();
  });

  it("Sentinela, procurador, crítico ou tique DECLARADOS sem prova viram agente de fora (não pegam o balde nem a voz)", () => {
    for (const kind of ["sentinel", "proxy", "critic", "copilot-tick"] as const) {
      const c = demoteUnprovenServiceCaller({ kind, id: "livraria" }, "orch");
      expect(c, kind).toEqual({ kind: "external", id: `${kind}-sem-prova` });
      expect(callerAttribution(c)).toBe(`external:${kind}-sem-prova`);
    }
    expect(demoteUnprovenServiceCaller({ kind: "session", id: "s1" }, "orch")).toEqual({ kind: "session", id: "s1" });
  });

  it("o rótulo do chat numa credencial que o chat nunca usa (escopada) também não vale", () => {
    expect(demoteUnprovenServiceCaller({ kind: "copilot-chat", id: "livraria" }, "orch").kind).toBe("external");
    expect(demoteUnprovenServiceCaller({ kind: "copilot-chat", id: "livraria" }, "full").kind).toBe("copilot-chat");
    expect(demoteUnprovenServiceCaller({ kind: "doc-chat", id: "livraria.prd" }, "ro").kind).toBe("doc-chat");
  });
});
