import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BoardPaceView } from "@/lib/storymap/runner/board-pace";

// As três tools do RITMO DO BOARD (board_pace · pause_board · resume_board): a casca MCP sobre
// runner/board-pace-actions. As regras (quem pode, o que para, o que volta) têm os testes delas; aqui se fixa o que só a
// casca decide — QUEM é o ator, que pause_board só desacelera, e que o erro chega com a frase.

const { mockChange, mockScope, mockView, mockListBoards } = vi.hoisted(() => ({
  mockChange: vi.fn(),
  mockScope: vi.fn(),
  mockView: vi.fn(),
  mockListBoards: vi.fn(async () => [{ id: "acme" }, { id: "other" }]),
}));

vi.mock("@/lib/storymap/runner/board-pace-actions", () => ({ changeBoardPaceNow: mockChange, changeBoardScopeNow: mockScope, boardPaceViewNow: mockView }));
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
  scope: null,
  scopeWaiting: 0,
  scopeHistory: [],
  featuresToShip: 0,
  ...over,
});
const ok = { ok: true, changed: true, stopped: 2, parked: 1, released: 3, rewritten: false };
const scopeOk = { ok: true, changed: true, purged: 1, released: 2, rescanned: 1, rewritten: false };
const FIXES = ["bug", "technical", "chore", "spike"];
const fixesScope = (over: Record<string, unknown> = {}): BoardPaceView["scope"] => ({
  types: ["bug", "technical", "chore", "spike"],
  preset: "fixes",
  by: { kind: "agent" },
  since: "2026-10-03T10:00:00.000Z",
  reason: null,
  until: null,
  ownerTypes: null,
  ...over,
} as BoardPaceView["scope"]);

describe("as tools do ritmo do board", () => {
  beforeEach(() => {
    mockChange.mockReset().mockResolvedValue(ok);
    mockScope.mockReset().mockResolvedValue(scopeOk);
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

  // ── o escopo de tipos (o outro eixo) ─────────────────────────────────────────────────────────────

  it("board_pace diz o escopo em chaves que o agente acha sem abrir `scope`: types (os cinco sem limite), waitingByScope, featuresToShip", async () => {
    const read = handlers().get("board_pace")!;
    expect(body(await read({ board: "acme" }))).toMatchObject({ types: ["user", "bug", "technical", "chore", "spike"], waitingByScope: 0, featuresToShip: 0, scope: null });
    mockView.mockResolvedValue(view({ scope: fixesScope(), scopeWaiting: 4, featuresToShip: 2 }));
    expect(body(await read({ board: "acme" }))).toMatchObject({ types: FIXES, waitingByScope: 4, featuresToShip: 2, scope: { preset: "fixes" } });
    // o retrato de todos os boards leva as mesmas chaves
    expect(body(await read({})).boards[0]).toMatchObject({ types: FIXES, waitingByScope: 4 });
  });

  it("pause_board só com `types`: estreita o escopo, NÃO toca no ritmo, e o ator é o do token", async () => {
    const pause = handlers().get("pause_board")!;
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => pause({ board: "acme", types: FIXES, reason: "semana de manutenção", forMinutes: 90 }));
    expect(mockChange).not.toHaveBeenCalled();
    expect(mockScope).toHaveBeenCalledWith({ board: "acme", types: FIXES, reason: "semana de manutenção", forMinutes: 90, by: { kind: "agent", id: "T" } });
    expect(body(r)).toMatchObject({ ok: true, scopeChanged: true, queueCleared: 1 });
    expect(body(r)).not.toHaveProperty("stopped");
  });

  it("pause_board com `level` E `types` muda os dois eixos, o ritmo primeiro", async () => {
    const r = await handlers().get("pause_board")!({ board: "acme", level: "slow", types: ["bug"], reason: "cota apertada" });
    expect(mockChange).toHaveBeenCalledTimes(1);
    expect(mockScope).toHaveBeenCalledTimes(1);
    expect(mockChange.mock.invocationCallOrder[0]).toBeLessThan(mockScope.mock.invocationCallOrder[0]);
    expect(body(r)).toMatchObject({ ok: true, changed: true, scopeChanged: true });
  });

  it("pause_board sem `level` nem `types` não tem o que frear: erro com a dica", async () => {
    const r = await handlers().get("pause_board")!({ board: "acme", reason: "por nada" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/level.*types/);
    expect(mockChange).not.toHaveBeenCalled();
    expect(mockScope).not.toHaveBeenCalled();
  });

  it.each([
    ["limitado a consertos, pedir mais um tipo é alargar", fixesScope(), ["bug", "technical", "chore", "spike", "user"]],
    ["limitado a erro, pedir manutenção é alargar", fixesScope({ types: ["bug"], preset: "custom" }), ["bug", "chore"]],
  ])("pause_board só ESTREITA: %s — recusa e aponta resume_board, sem gravar nada", async (_nome, scope, types) => {
    mockView.mockResolvedValue(view({ scope }));
    const r = await handlers().get("pause_board")!({ board: "acme", types, reason: "tentando alargar" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/ALARGAR.*resume_board/);
    expect(mockScope).not.toHaveBeenCalled();
    expect(mockChange).not.toHaveBeenCalled();
  });

  it("pause_board sem limite hoje: pedir os cinco tipos não alarga nada (é o mesmo que não limitar) e segue para a ação", async () => {
    const r = await handlers().get("pause_board")!({ board: "acme", types: ["user", "bug", "technical", "chore", "spike"], reason: "sem efeito" });
    expect(r.isError).toBeUndefined();
    expect(mockScope).toHaveBeenCalledTimes(1);
  });

  it("pause_board: pedir o MESMO escopo que já vale (ou um menor) passa; a regra do dono é da ação, e a frase dela chega", async () => {
    mockView.mockResolvedValue(view({ scope: fixesScope() }));
    const pause = handlers().get("pause_board")!;
    expect((await pause({ board: "acme", types: FIXES, reason: "reforçando" })).isError).toBeUndefined();
    expect((await pause({ board: "acme", types: ["bug"], reason: "só erros agora" })).isError).toBeUndefined();
    mockScope.mockResolvedValue({ ok: false, error: "O registro de ritmo não pôde ser lido: só o dono o regrava." });
    const refused = await pause({ board: "acme", types: ["bug"], reason: "só erros agora" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/só o dono o regrava/);
  });

  it("pause_board que mudou o ritmo mas o escopo falhou diz as duas coisas (o ritmo mudou; o escopo não)", async () => {
    mockScope.mockResolvedValue({ ok: false, error: "O registro de ritmo não pôde ser lido." });
    const r = await handlers().get("pause_board")!({ board: "acme", level: "paused", types: ["bug"], reason: "teste" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/O ritmo mudou, mas o escopo não/);
  });

  it("resume_board com `types:\"all\"` e sem `level`: alarga SÓ o escopo — o ritmo fica como está (e como o dono pôs)", async () => {
    mockChange.mockResolvedValue({ ok: false, error: "O dono segurou este board em «Pausado»: só ele retoma." });
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => handlers().get("resume_board")!({ board: "acme", types: "all", reason: "feito" }));
    expect(mockChange).not.toHaveBeenCalled();
    expect(mockScope).toHaveBeenCalledWith({ board: "acme", types: "all", reason: "feito", by: { kind: "agent", id: "T" } });
    expect(body(r)).toMatchObject({ ok: true, scopeChanged: true, scopeReleased: 2 });
  });

  it("resume_board sem `types` continua só retomando o ritmo: não toca no escopo (os eixos são independentes)", async () => {
    await handlers().get("resume_board")!({ board: "acme" });
    expect(mockChange).toHaveBeenCalledTimes(1);
    expect(mockScope).not.toHaveBeenCalled();
  });

  it("resume_board com `level` e `types` muda os dois; a recusa do dono sobre o escopo chega com a frase", async () => {
    mockScope.mockResolvedValue({ ok: false, error: "O dono limitou este board a Erro: só ele alarga o que pode começar." });
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => handlers().get("resume_board")!({ board: "acme", level: "normal", types: "all" }));
    expect(mockChange).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/O ritmo mudou, mas o escopo não: O dono limitou/);
  });

  it("resume_board com uma LISTA de tipos define o recorte (alargar para o que o dono admitiu)", async () => {
    await handlers().get("resume_board")!({ board: "acme", types: ["bug", "technical"] });
    expect(mockScope).toHaveBeenCalledWith(expect.objectContaining({ types: ["bug", "technical"] }));
  });
});
