// A sessão que o serviço abre leva a prova dela na configuração de MCP (ao lado do rótulo) — é o que a liga à sessão no
// servidor. Outros chamadores (o copiloto) não levam prova. Fixtures inventadas.

import { describe, expect, it } from "vitest";
import { buildOrchestratorMcpConfig } from "@/lib/storymap/runner/orchestrator-spawn";
import { MCP_CALLER_HEADER } from "./caller";
import { SESSION_PROOF_HEADER } from "./session-proof";

const headersOf = (json: string) => JSON.parse(json).mcpServers.storymap.headers as Record<string, string> | undefined;

describe("buildOrchestratorMcpConfig — a prova da sessão", () => {
  it("sessão com prova: rótulo e prova nos cabeçalhos", () => {
    const h = headersOf(buildOrchestratorMcpConfig("tok", 3999, { kind: "session", id: "s-1" }, "0".repeat(32)))!;
    expect(h[MCP_CALLER_HEADER]).toBe("session:s-1");
    expect(h[SESSION_PROOF_HEADER]).toBe("0".repeat(32));
  });

  it("copiloto (não-sessão) nunca leva prova, mesmo se alguém passar uma", () => {
    const h = headersOf(buildOrchestratorMcpConfig("tok", 3999, { kind: "copilot-tick", id: "oficina" }, "0".repeat(32)))!;
    expect(h[SESSION_PROOF_HEADER]).toBeUndefined();
  });

  it("sessão sem segredo utilizável: só o rótulo (atribuição)", () => {
    const h = headersOf(buildOrchestratorMcpConfig("tok", 3999, { kind: "session", id: "s-1" }, null))!;
    expect(h[SESSION_PROOF_HEADER]).toBeUndefined();
  });
});
