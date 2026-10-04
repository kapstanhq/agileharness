import { describe, expect, it } from "vitest";
import { callerAttribution, callerTag, callerWords, isCopilotCaller, parseCallerTag, toWhomWords } from "./caller";
import { approvalRequesterText } from "@/lib/storymap/approval-requester";
import { buildOrchestratorMcpConfig } from "@/lib/storymap/runner/orchestrator-spawn";
import { MCP_CALLER_HEADER } from "./caller";

describe("quem chama uma tool — o rótulo que o agente declara de si", () => {
  it("vai e volta pelo cabeçalho; o que não é do formato é ignorado (nunca texto livre)", () => {
    for (const c of [
      { kind: "session", id: "0f3a-9c" },
      { kind: "copilot-tick", id: "acme" },
      { kind: "copilot-chat", id: "acme" },
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
