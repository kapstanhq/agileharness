import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// O furo que sobrou do C1: um agente escopado que chama enqueue/enqueue_batch entra no engine como automação, e o engine só
// completa o card do escopo DEPOIS (leitura assíncrona) — com a vaga livre o job saía da fila no mesmo instante. A tool já LEU o
// card para resolver o gatilho: aqui se fixa que ela o repassa ao engine (`scopeCard`), para o pump decidir sem esperar.
// (O `run_skill` delega a `runCardSkillAction`; o repasse dele está em app/move-autorun.test.ts.)

const { enqueueWithDeps } = vi.hoisted(() => ({
  enqueueWithDeps: vi.fn((board: string, cardId: string, ..._rest: unknown[]) => ({ id: cardId, board, lane: "heavy", position: 0, estimatedStart: null, blocked: false })),
}));
vi.mock("@/lib/storymap/runner/engine", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/runner/engine")>()), getRunnerEngine: () => ({ enqueueWithDeps }) }));
vi.mock("@/lib/storymap/runner/config", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/runner/config")>()), loadRunnerConfig: () => ({ autorun: { enabled: true } }) as never }));
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));

const config = {
  id: "oficina",
  name: "Oficina",
  statuses: [{ id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true }],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as unknown as BoardConfig;
const feature = (id: string): Card => ({ id, type: "story", title: id, storyType: "user", mode: undefined, status: "desenvolver" }) as unknown as Card;
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/repo")>()),
  readBoardConfig: async () => config,
  readCards: async () => [feature("story-a"), feature("story-b")],
}));

import { registerStorymapTools } from "./tools";

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _meta: unknown, handler: ToolHandler) => void out.set(name, handler) } as unknown as McpServer);
  return out;
}

beforeEach(() => enqueueWithDeps.mockClear());

describe("enqueue / enqueue_batch repassam o scopeCard ao engine", () => {
  it("enqueue: o card lido para resolver o gatilho vai como scopeCard", async () => {
    const r = await handlers().get("enqueue")!({ board: "oficina", cardId: "story-a" });
    expect(r.isError).toBeUndefined();
    expect(enqueueWithDeps).toHaveBeenCalledTimes(1);
    const opts = enqueueWithDeps.mock.calls[0][5] as { scopeCard?: Record<string, unknown> };
    expect(opts.scopeCard).toMatchObject({ id: "story-a", type: "story", storyType: "user", status: "desenvolver" });
  });

  it("enqueue_batch: CADA card do lote leva o seu scopeCard", async () => {
    const r = await handlers().get("enqueue_batch")!({
      cards: [
        { board: "oficina", cardId: "story-a" },
        { board: "oficina", cardId: "story-b" },
      ],
      deps: [{ from: "oficina/story-a", to: "oficina/story-b" }],
    });
    expect(r.isError).toBeUndefined();
    expect(enqueueWithDeps).toHaveBeenCalledTimes(2);
    const byCard = new Map(enqueueWithDeps.mock.calls.map((c) => [c[1] as string, (c[5] as { scopeCard?: { id: string } }).scopeCard]));
    expect(byCard.get("story-a")).toMatchObject({ id: "story-a", storyType: "user", status: "desenvolver" });
    expect(byCard.get("story-b")).toMatchObject({ id: "story-b", storyType: "user", status: "desenvolver" });
  });
});
