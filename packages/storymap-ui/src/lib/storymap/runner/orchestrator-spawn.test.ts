import { describe, expect, it } from "vitest";
import * as legacy from "./orchestrator-spawn";
import { buildOrchestratorMcpConfig, buildOrchestratorPrompt } from "./orchestrator-spawn";

// Fase 6 — o lançador do tique antigo (que RETOMAVA a conversa do chat para «avançar o board») saiu: quem acorda por
// causa agora é a Sentinela (sentinel*.ts — sessão nova, Sonnet, lista branca de tools, registro de cada despertar). As
// garantias de contenção dele (sem shell, sem skip-permissions, tetos de turno/dinheiro/relógio) vivem nos testes da
// Sentinela (sentinel.test.ts / sentinel-spawn.test.ts). Aqui fica a prova de que o caminho antigo não volta.
describe("o tique antigo do Jido não existe mais", () => {
  it("nenhum lançador nem prompt de acordar sobrou no módulo", () => {
    expect(Object.keys(legacy).sort()).toEqual(["buildOrchestratorMcpConfig", "buildOrchestratorPrompt"]);
  });
});

describe("buildOrchestratorMcpConfig — aponta o filho ao MCP AgileHarness deste serviço (PURE)", () => {
  it("monta o http endpoint com token na URL e a porta dada", () => {
    const cfg = JSON.parse(buildOrchestratorMcpConfig("tok", 3008));
    expect(cfg.mcpServers.storymap).toEqual({ type: "http", url: "http://localhost:3008/api/mcp/tok/mcp" });
  });
});

describe("buildOrchestratorPrompt — o motivo do wake vai p/ o agente", () => {
  it("sem motivo: o prompt do tick periódico", () => {
    expect(buildOrchestratorPrompt("acme", "autonomous")).toBe("/harness-orchestrator acme autonomous --tick");
  });

  it("com motivo: o evento que o acordou entra como contexto", () => {
    expect(buildOrchestratorPrompt("acme", "autonomous", "card X travou")).toBe(
      '/harness-orchestrator acme autonomous --tick --motivo "card X travou"',
    );
  });

  it("achata aspas e quebras de linha do motivo (o prompt fica legível, argv nunca vira shell)", () => {
    const p = buildOrchestratorPrompt("acme", "autonomous", 'Blocker em "Login"\nsegunda linha');
    expect(p).not.toContain("\n");
    expect(p).toBe('/harness-orchestrator acme autonomous --tick --motivo "Blocker em Login segunda linha"');
  });
});
