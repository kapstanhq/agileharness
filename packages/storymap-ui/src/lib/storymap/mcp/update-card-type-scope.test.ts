import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardPaceRow } from "@/lib/storymap/runner/board-pace";
import type { Card } from "@/lib/storymap/types";

// R6 na porta do AGENTE: o update_card recusa, com a frase que diz o que fazer, a troca de tipo de uma funcionalidade já
// classificada enquanto o escopo limita o board — antes de gravar e deixando a recusa na trilha. A ação de servidor repete
// a régua (app/card-type-scope.test.ts); aqui se fixa a tool.

const { mockUpdate, mockReadCard } = vi.hoisted(() => ({ mockUpdate: vi.fn(), mockReadCard: vi.fn() }));
let row: BoardPaceRow | null = null;
vi.mock("@/lib/storymap/runner/board-pace-store", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/runner/board-pace-store")>()), boardPaceRow: () => row }));
vi.mock("@/lib/storymap/repo", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/repo")>()), readCard: mockReadCard }));
vi.mock("@/app/actions", async (orig) => ({ ...(await orig<typeof import("@/app/actions")>()), updateCardAction: mockUpdate }));
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));

import { registerStorymapTools } from "./tools";
import { runWithMcpActor } from "./actor";
import { flushAgentActions, resetAgentActionSink, setAgentActionSink, type AgentAction } from "@/lib/storymap/runner/agent-actions";

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
function updateCard(): ToolHandler {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _meta: unknown, handler: ToolHandler) => void out.set(name, handler) } as unknown as McpServer);
  return out.get("update_card")!;
}
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const card = (over: Partial<Card> = {}): Card =>
  ({
    id: "story-ex9903",
    type: "story",
    title: "Afinar os freios",
    storyType: "user",
    status: "desenvolver",
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    findings: [],
    ...over,
  }) as Card;
const ownerFixes = (): BoardPaceRow => ({ board: "oficina", ownerScope: { types: ["bug", "technical", "chore", "spike"], by: { kind: "owner" }, at: new Date().toISOString() } });
const agent = <T>(fn: () => T) => runWithMcpActor({ level: "orch", tokenEnv: "T" }, fn);

let lines: AgentAction[];
beforeEach(() => {
  lines = [];
  setAgentActionSink({ append: async (l) => void lines.push(JSON.parse(l) as AgentAction) });
  row = null;
  mockUpdate.mockReset().mockResolvedValue({ ok: true, data: { card: card({ storyType: "chore" }) } });
  mockReadCard.mockReset().mockResolvedValue(card());
});
afterEach(() => resetAgentActionSink());

describe("update_card — a catraca do tipo", () => {
  it("com escopo, o agente que reclassifica uma funcionalidade já classificada é recusado, sem gravar, com a frase e a trilha", async () => {
    row = ownerFixes();
    const r = await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", storyType: "chore" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/só o dono troca o tipo dele/);
    expect(mockUpdate).not.toHaveBeenCalled();
    await flushAgentActions();
    expect(lines.filter((l) => l.tool === "update_card")).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "refused", board: "oficina", cardId: "story-ex9903" });
    expect(lines[0].note).toContain("Funcionalidade nova → Manutenção");
  });

  it("o dono (token completo) troca; a trilha do executado é da ação de servidor", async () => {
    row = ownerFixes();
    const r = await runWithMcpActor({ level: "full" }, () => updateCard()({ board: "oficina", cardId: "story-ex9903", storyType: "chore" }));
    expect(r.isError).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("o agente classifica um card ainda novo (na especificação): passa para a ação", async () => {
    row = ownerFixes();
    mockReadCard.mockResolvedValue(card({ status: "enriquecer" }));
    const r = await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", storyType: "bug" }));
    expect(r.isError).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("sem escopo, ou sem mudar o tipo, nada muda: passa", async () => {
    expect((await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", storyType: "chore" }))).isError).toBeUndefined();
    row = ownerFixes();
    expect((await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", title: "Afinar os freios traseiros" }))).isError).toBeUndefined();
    expect((await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", storyType: "user" }))).isError).toBeUndefined();
    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });
  // C13 — `mode` (fix conta como erro) e `type` (ideia → story) não são graváveis por esta tool: o agente não tem aqui uma
  // segunda porta para mudar o tipo EFETIVO do card. (O «Reportar bug», que re-tipa pelo modo, tem a catraca dele em
  // app/card-type-scope.test.ts.)
  it("C13: `mode` é campo do pipeline — o agente que tenta pôr `mode: fix` num card de funcionalidade é recusado, sem gravar", async () => {
    row = ownerFixes();
    const r = await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", mode: "fix" }));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/não escreve campos do pipeline.*mode/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("C13: `type` (ideia → story) não existe no esquema da tool: mesmo enviado, o card gravado mantém o `type` que tinha", async () => {
    row = ownerFixes();
    mockReadCard.mockResolvedValue(card({ type: "idea" as Card["type"] }));
    await agent(() => updateCard()({ board: "oficina", cardId: "story-ex9903", type: "story", title: "novo título" }));
    const sent = mockUpdate.mock.calls[0]?.[0] as { card: Card } | undefined;
    expect(sent?.card.type).toBe("idea");
  });
});
