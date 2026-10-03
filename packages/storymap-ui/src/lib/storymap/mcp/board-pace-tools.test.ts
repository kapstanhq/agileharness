import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardPaceView } from "@/lib/storymap/runner/board-pace";

// As três tools do RITMO DO BOARD (board_pace · pause_board · resume_board): a casca MCP sobre
// runner/board-pace-actions. As regras (quem pode, o que para, o que volta) têm os testes delas; aqui se fixa o que só a
// casca decide — QUEM é o ator, que pause_board só desacelera, e que o erro chega com a frase.

const { mockChange, mockView, mockListBoards } = vi.hoisted(() => ({
  mockChange: vi.fn(),
  mockView: vi.fn(),
  mockListBoards: vi.fn(async () => [{ id: "acme" }, { id: "other" }]),
}));

vi.mock("@/lib/storymap/runner/board-pace-actions", () => ({ changeBoardPaceNow: mockChange, boardPaceViewNow: mockView }));
vi.mock("@/lib/storymap/repo", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/repo")>()), listBoards: mockListBoards }));
// A guarda (matriz de risco do board, limite por hora) tem os testes dela (guard.test.ts): aqui ela deixa passar, para o
// teste enxergar o que a tool faz com um ator escopado.
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));

import { registerStorymapTools } from "./tools";
import { runWithMcpActor } from "./actor";

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<CallToolResult>;
function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _meta: unknown, handler: ToolHandler) => void out.set(name, handler) } as unknown as McpServer);
  return out;
}
const body = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

const view = (over: Partial<BoardPaceView> = {}): BoardPaceView => ({
  board: "acme",
  level: "normal",
  label: "Normal",
  held: false,
  source: "default",
  why: "ritmo normal",
  by: null,
  since: null,
  reason: null,
  until: null,
  mode: null,
  ownerLimit: null,
  waiting: 0,
  history: [],
  suggestion: null,
  ...over,
});
const ok = { ok: true, changed: true, stopped: 2, parked: 1, released: 3, rewritten: false };

describe("as tools do ritmo do board", () => {
  beforeEach(() => {
    mockChange.mockReset().mockResolvedValue(ok);
    mockView.mockReset().mockImplementation(async (board: string) => (board === "ghost" ? null : view({ board })));
  });

  it("pause_board de um token ESCOPADO grava como AGENTE (com o nome do token); do operador, como dono", async () => {
    const pause = handlers().get("pause_board")!;
    const args = { board: "acme", level: "paused", reason: "cota apertada", mode: "stop", forMinutes: 30 };
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, () => pause(args));
    expect(mockChange).toHaveBeenLastCalledWith({ ...args, by: { kind: "agent", id: "AGILEHARNESS_MCP_TOKEN_ORCH" } });
    expect(body(r)).toMatchObject({ ok: true, changed: true, stopped: 2, parked: 1 });
    await runWithMcpActor({ level: "full" }, () => pause(args));
    expect(mockChange).toHaveBeenLastCalledWith({ ...args, by: { kind: "owner" } });
    // o agente que se nomeou (mcp/caller.ts) é registrado pelo rótulo dele, não pela credencial que a frota divide
    await runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", caller: { kind: "session", id: "sess-1" } }, () => pause(args));
    expect(mockChange).toHaveBeenLastCalledWith({ ...args, by: { kind: "agent", id: "session:sess-1" } });
  });

  it("pause_board só DESACELERA: pedir devagar num board pausado é acelerar — recusa e aponta resume_board, sem gravar", async () => {
    mockView.mockResolvedValue(view({ level: "paused", label: "Pausado", held: true, source: "pace" }));
    const r = await handlers().get("pause_board")!({ board: "acme", level: "slow", reason: "voltar aos poucos" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/resume_board/);
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("resume_board vai para normal por padrão, e a recusa da regra do dono chega com a frase", async () => {
    const resume = handlers().get("resume_board")!;
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => resume({ board: "acme" }));
    expect(mockChange).toHaveBeenLastCalledWith({ board: "acme", level: "normal", reason: undefined, by: { kind: "agent", id: "T" } });
    expect(body(r)).toMatchObject({ ok: true, released: 3 });
    mockChange.mockResolvedValue({ ok: false, error: "O dono segurou este board em «Pausado»: só ele retoma ou acelera além disso." });
    const refused = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => resume({ board: "acme", level: "slow" }));
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/só ele retoma/);
  });

  it("board_pace lê um board, ou todos; board que não existe é erro com a dica", async () => {
    const read = handlers().get("board_pace")!;
    expect(body(await read({ board: "acme" }))).toMatchObject({ board: "acme", level: "normal" });
    expect(body(await read({})).boards.map((b: BoardPaceView) => b.board)).toEqual(["acme", "other"]);
    const ghost = await read({ board: "ghost" });
    expect(ghost.isError).toBe(true);
    expect(text(ghost)).toMatch(/list_boards/);
    const pauseGhost = await handlers().get("pause_board")!({ board: "ghost", level: "paused", reason: "teste" });
    expect(pauseGhost.isError).toBe(true);
  });
});
