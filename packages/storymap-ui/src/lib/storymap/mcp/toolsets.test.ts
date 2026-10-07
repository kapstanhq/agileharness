// O conjunto de tools por PAPEL: estreita a superfície que o nível do token monta (contexto), nunca alarga (autoridade).

import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ANCHOR_TOOLSET, CONDUCTOR_TOOLSET, SENTINEL_TOOLSET, parseToolset, toolsetAllows, toolsetTools, type McpToolset } from "./toolsets";
import { setServerLevel, setServerToolset, levelAllows, annotatedToolNames } from "./register";
import { registerStorymapTools } from "./tools";
import { registerDevTools } from "./dev-tools";
import { registerOnboarding } from "./onboarding";
import type { McpLevel } from "@/lib/storymap/types";

/** As tools que UMA construção do servidor registra, com o nível e o papel carimbados como o route.ts faz. */
function mounted(level: McpLevel, toolset?: McpToolset): Set<string> {
  const names = new Set<string>();
  const server = { registerTool: (name: string) => void names.add(name), registerResource: () => undefined } as unknown as McpServer;
  setServerLevel(server, level);
  setServerToolset(server, toolset);
  registerOnboarding(server);
  registerStorymapTools(server);
  registerDevTools(server);
  return names;
}

describe("parseToolset / toolsetAllows", () => {
  it("só os papéis conhecidos; ausente, vazio ou desconhecido ⇒ sem recorte", () => {
    expect(parseToolset("conductor")).toBe("conductor");
    expect(parseToolset(" Conductor ")).toBe("conductor");
    expect(parseToolset("sentinel")).toBe("sentinel");
    // os críticos do serviço não montam MCP nenhum: o papel não existe (um conjunto sem quem o use seria código morto)
    expect(parseToolset("critic")).toBeUndefined();
    expect(parseToolset("toString")).toBeUndefined();
    expect(parseToolset("admin")).toBeUndefined();
    expect(parseToolset("")).toBeUndefined();
    expect(parseToolset(null)).toBeUndefined();
    expect(toolsetAllows(undefined, "deploy")).toBe(true);
    expect(toolsetAllows("conductor", "get_card")).toBe(true);
    expect(toolsetAllows("conductor", "deploy")).toBe(false);
  });

  it("os conjuntos não têm repetição e toolsetTools devolve cópia", () => {
    expect(new Set(CONDUCTOR_TOOLSET).size).toBe(CONDUCTOR_TOOLSET.length);
    expect(new Set(SENTINEL_TOOLSET).size).toBe(SENTINEL_TOOLSET.length);
    const c = toolsetTools("conductor");
    c.push("deploy");
    expect(toolsetAllows("conductor", "deploy")).toBe(false);
  });
});

describe("o filtro no ponto único (defineTool): nível E papel", () => {
  const orch = mounted("orch");
  const conductor = mounted("orch", "conductor");

  it("o condutor monta EXATAMENTE o conjunto dele que o nível `orch` permite — bem menos que a superfície inteira", () => {
    const expected = CONDUCTOR_TOOLSET.filter((t) => orch.has(t));
    expect([...conductor].sort()).toEqual([...expected].sort());
    expect(conductor.size).toBeLessThan(orch.size / 2);
    // o conjunto não lista nada que o `orch` não monte (uma tool do conjunto sumiria sem ninguém ver)
    expect(CONDUCTOR_TOOLSET.filter((t) => !orch.has(t))).toEqual([]);
  });

  it("as tools que o condutor mais usa estão lá; as saídas do operador e a publicação, não", () => {
    for (const t of ["get_card", "update_card", "move_card", "set_tasks", "worktree_submit", "wait_for_submit", "report_progress", "ask_question", "request_budget", "get_card_plan"]) {
      expect(conductor.has(t), t).toBe(true);
    }
    for (const t of ["approve_qa", "approve_review", "answer_question", "deploy", "publish_when_idle", "write_doc", "delete_card"]) {
      expect(conductor.has(t), t).toBe(false);
    }
  });

  it("o papel NUNCA alarga: com um token `ro`, o conjunto do condutor não ganha escrita", () => {
    const ro = mounted("ro");
    const roConductor = mounted("ro", "conductor");
    expect([...roConductor].filter((t) => !ro.has(t))).toEqual([]);
    expect(roConductor.has("update_card")).toBe(false);
    expect(roConductor.has("move_card")).toBe(false);
    // e cada tool montada passa pelo nível, como antes
    for (const t of roConductor) expect(levelAllows("ro", t, undefined) || ro.has(t)).toBe(true);
  });

  it("fase 6 — a Sentinela monta o conjunto dela (todo ele existe no `orch`) e nunca o que mexe em história ou publica", () => {
    const sentinel = mounted("orch", "sentinel");
    expect(SENTINEL_TOOLSET.filter((t) => !orch.has(t))).toEqual([]);
    expect([...sentinel].sort()).toEqual([...SENTINEL_TOOLSET].sort());
    for (const t of ["update_card", "move_card", "answer_question", "accept_triage", "deploy", "publish_when_idle", "claude_kill", "claude_send", "delete_card"]) {
      expect(sentinel.has(t), t).toBe(false);
    }
    // com o token `ro` do modo diagnóstico, nada de escrita entra pelo papel
    const ro = mounted("ro");
    expect([...mounted("ro", "sentinel")].filter((t) => !ro.has(t))).toEqual([]);
  });

  it("fase 7 — o condutor monta claim_batch e batch_drop (o lote); a âncora, só leitura + update_card/propose_change/ask_question", () => {
    expect(conductor.has("claim_batch")).toBe(true);
    expect(conductor.has("batch_drop")).toBe(true);
    expect(orch.has("claim_batch") && orch.has("batch_drop")).toBe(true);
    expect(parseToolset("anchor")).toBe("anchor");
    const anchor = mounted("orch", "anchor");
    expect([...anchor].sort()).toEqual([...ANCHOR_TOOLSET].sort());
    for (const t of ["move_card", "create_card", "claim_batch", "worktree_submit", "deploy"]) expect(anchor.has(t), t).toBe(false);
  });

  it("sem papel, a superfície é a de sempre (nada muda para o operador nem para quem não declara papel)", () => {
    expect(mounted("orch", undefined)).toEqual(orch);
    expect(annotatedToolNames().length).toBeGreaterThan(orch.size / 2);
  });
});
