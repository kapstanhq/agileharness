import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardPaceView } from "@/lib/storymap/runner/board-pace";

// A ação do servidor que muda o ESCOPO de tipos do board (o segundo eixo do ritmo). A regra de quem pode e o que acontece
// com a fila moram em runner/board-pace-actions.ts (testada lá); aqui se fixa a ponte: quem é o ator (sessão ⇒ dono,
// token escopado ⇒ agente), que cada botão vira a lista certa de tipos, o prazo só vale para limitar, a trilha de
// auditoria do dono e que a recusa chega com a frase.

const { mockScope, mockView, mockCaller, mockReadConfig, mockUpdateConfig } = vi.hoisted(() => ({
  mockScope: vi.fn(),
  mockView: vi.fn(),
  mockCaller: vi.fn(),
  mockReadConfig: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => {}, resolveActionCaller: async () => mockCaller() }));
vi.mock("@/lib/storymap/repo", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/repo")>()), readBoardConfig: mockReadConfig }));
vi.mock("@/lib/storymap/write", async (orig) => ({ ...(await orig<typeof import("@/lib/storymap/write")>()), updateBoardConfigOnDisk: mockUpdateConfig }));
vi.mock("@/lib/storymap/runner/board-pace-actions", () => ({
  boardPaceViewNow: mockView,
  changeBoardPaceNow: vi.fn(),
  changeBoardScopeNow: mockScope,
}));
vi.mock("@/lib/storymap/board-registry", () => ({ setBoardAutorun: vi.fn() }));

import { setBoardScopeAction, setConductorSlotsAction } from "./board-pace-actions";
import type { BoardConfig } from "@/lib/storymap/types";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { flushAgentActions, resetAgentActionSink, setAgentActionSink, type AgentAction } from "@/lib/storymap/runner/agent-actions";

const view = (over: Partial<BoardPaceView> = {}): BoardPaceView => ({
  board: "oficina",
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
const FIXES = ["bug", "technical", "chore", "spike"];
const fixesView = view({ scope: { types: ["bug", "technical", "chore", "spike"], preset: "fixes", by: { kind: "owner" }, since: new Date().toISOString(), reason: null, until: null, ownerTypes: null } });

let lines: AgentAction[];
beforeEach(() => {
  lines = [];
  setAgentActionSink({ append: async (l) => void lines.push(JSON.parse(l) as AgentAction) });
  mockScope.mockReset().mockResolvedValue({ ok: true, changed: true, purged: 0, released: 0, rescanned: 0, rewritten: false });
  mockView.mockReset().mockResolvedValue(fixesView);
});
afterEach(() => resetAgentActionSink());

describe("setBoardScopeAction", () => {
  it("«Só consertos e manutenção» pelo dono: a lista de tipos certa, o prazo, e a trilha de auditoria", async () => {
    mockScope.mockResolvedValue({ ok: true, changed: true, purged: 2, released: 0, rescanned: 0, rewritten: false });
    const r = await setBoardScopeAction({ boardId: "oficina", preset: "fixes", forMinutes: 60, reason: "  semana de manutenção " });
    expect(mockScope).toHaveBeenCalledWith({ board: "oficina", types: FIXES, forMinutes: 60, reason: "semana de manutenção", by: { kind: "owner" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.message).toMatch(/Só consertos e manutenção/);
      expect(r.data.message).toMatch(/2 trabalhos na fila saíram do caminho/);
      expect(r.data.message).toMatch(/o que já está rodando termina/);
    }
    await flushAgentActions();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: "human:board-header", tool: "setBoardScopeAction", outcome: "executed", board: "oficina" });
    expect(lines[0].note).toBe("escopo=fixes · prazo=60min · motivo=semana de manutenção");
  });

  it("«Tudo» alarga: manda 'all', ignora o prazo (prazo vale para limitar, não para liberar) e diz quantos cards voltaram", async () => {
    mockView.mockResolvedValue(view());
    mockScope.mockResolvedValue({ ok: true, changed: true, purged: 0, released: 3, rescanned: 1, rewritten: false });
    const r = await setBoardScopeAction({ boardId: "oficina", preset: "all", forMinutes: 60 });
    expect(mockScope).toHaveBeenCalledWith({ board: "oficina", types: "all", forMinutes: undefined, reason: undefined, by: { kind: "owner" } });
    expect(r.ok && r.data.message).toMatch(/Tudo/);
    expect(r.ok && r.data.message).toMatch(/3 cards voltaram a andar/);
  });

  it("pedir o que já está em vigor diz isso, sem alarde", async () => {
    mockScope.mockResolvedValue({ ok: true, changed: false, purged: 0, released: 0, rescanned: 0, rewritten: false });
    const r = await setBoardScopeAction({ boardId: "oficina", preset: "fixes" });
    expect(r.ok && r.data.message).toBe("O board já estava em «Só consertos e manutenção».");
  });

  it("um token ESCOPADO que chame a action é tratado como AGENTE (com o rótulo dele) e não escreve a trilha do dono", async () => {
    await runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, () => setBoardScopeAction({ boardId: "oficina", preset: "fixes" }));
    expect(mockScope).toHaveBeenCalledWith(expect.objectContaining({ by: { kind: "agent", id: "mcp:orch(AGILEHARNESS_MCP_TOKEN_ORCH)" } }));
    await flushAgentActions();
    expect(lines).toEqual([]);
  });

  it("a recusa da regra do dono chega com a frase, sem trilha nem mensagem de sucesso", async () => {
    mockScope.mockResolvedValue({ ok: false, error: "O dono limitou este board a Erro: só ele alarga o que pode começar." });
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => setBoardScopeAction({ boardId: "oficina", preset: "all" }));
    expect(r).toEqual({ ok: false, error: "O dono limitou este board a Erro: só ele alarga o que pode começar." });
    await flushAgentActions();
    expect(lines).toEqual([]);
  });

  it("preset desconhecido é recusado antes de tocar em qualquer coisa", async () => {
    const r = await setBoardScopeAction({ boardId: "oficina", preset: "tudo-menos-bug" as never });
    expect(r.ok).toBe(false);
    expect(mockScope).not.toHaveBeenCalled();
  });

  it("board que não existe mais depois da mudança é erro claro, não um estouro", async () => {
    mockView.mockResolvedValue(null);
    const r = await setBoardScopeAction({ boardId: "oficina", preset: "fixes" });
    expect(r).toEqual({ ok: false, error: "Este board não existe ou não pôde ser lido." });
  });
});

// «Condutores ao mesmo tempo» (2ª barra do Kanban): quantas sessões longas o board leva por vez — `conductor.maxSessions`
// no board.yaml. Cada vaga gasta cota, então é chave do OPERADOR (como o modo «só organização»): só a sessão do navegador
// muda, num board que já usa condutor, e a gravação passa pelo read-modify-write atômico da config.
describe("setConductorSlotsAction", () => {
  const withConductor = (maxSessions?: number) =>
    ({ id: "oficina", name: "Oficina", statuses: [], conductor: { enabled: true, fromStatus: "pronta", ...(maxSessions ? { maxSessions } : {}) } }) as unknown as BoardConfig;
  let disk: BoardConfig;
  beforeEach(() => {
    mockCaller.mockReset().mockReturnValue("operator-session");
    disk = withConductor(2);
    mockReadConfig.mockReset().mockImplementation(async () => disk);
    mockUpdateConfig.mockReset().mockImplementation(async (_b: string, mutate: (c: BoardConfig) => BoardConfig | null) => {
      const next = mutate(disk);
      if (next) disk = next;
      return next;
    });
  });

  it("o OPERADOR passa de 2 para 1: grava só `conductor.maxSessions` (o resto da política fica) e deixa a trilha", async () => {
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 1 });
    expect(r).toMatchObject({ ok: true, data: { slots: 1 } });
    expect(disk.conductor).toEqual({ enabled: true, fromStatus: "pronta", maxSessions: 1 });
    if (r.ok) expect(r.data.message).toMatch(/1 condutor por vez/);
    await flushAgentActions();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ actor: "human:board-header", tool: "setConductorSlotsAction", outcome: "executed", board: "oficina", note: "condutores=2→1" });
  });

  it("pedir o que já está em vigor não regrava nem deixa trilha", async () => {
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 2 });
    expect(r).toMatchObject({ ok: true, data: { slots: 2, message: expect.stringContaining("já") } });
    await flushAgentActions();
    expect(lines).toEqual([]);
  });

  it("sem `maxSessions` gravado, pedir o PADRÃO (2) também não regrava nem deixa trilha", async () => {
    disk = { ...disk, conductor: { ...disk.conductor!, maxSessions: undefined } } as BoardConfig;
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 2 });
    expect(r).toMatchObject({ ok: true, data: { slots: 2, message: expect.stringContaining("já") } });
    expect(disk.conductor?.maxSessions).toBeUndefined();
    await flushAgentActions();
    expect(lines).toEqual([]);
  });

  it("um agente pelo MCP é recusado e o arquivo não muda", async () => {
    mockCaller.mockReturnValue("mcp-token");
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 1 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("operador") });
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(disk.conductor?.maxSessions).toBe(2);
  });

  it("o próprio serviço (chamada interna) também é recusado", async () => {
    mockCaller.mockReturnValue("in-process");
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 1 });
    expect(r.ok).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("board sem condutor: não liga o condutor por um botão de vagas", async () => {
    disk = { id: "oficina", name: "Oficina", statuses: [] } as unknown as BoardConfig;
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 1 });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("não usa condutores") });
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(disk.conductor).toBeUndefined();
  });

  it("número fora da faixa é recusado antes de ler qualquer coisa", async () => {
    for (const slots of [0, -1, 1.5, 99, Number.NaN]) {
      const r = await setConductorSlotsAction({ boardId: "oficina", slots });
      expect(r.ok).toBe(false);
    }
    expect(mockReadConfig).not.toHaveBeenCalled();
  });

  it("sem `maxSessions` escrito (vale o padrão, 2): escolher 1 grava o número", async () => {
    disk = withConductor();
    const r = await setConductorSlotsAction({ boardId: "oficina", slots: 1 });
    expect(r.ok).toBe(true);
    expect(disk.conductor?.maxSessions).toBe(1);
    await flushAgentActions();
    expect(lines[0].note).toBe("condutores=2→1");
  });
});

describe("por construção: as vagas de condutor só mudam pela tela", () => {
  it("nenhum arquivo das tools MCP chama setConductorSlotsAction", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const mcpDir = path.join(__dirname, "..", "lib", "storymap", "mcp");
    const files = readdirSync(mcpDir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => readFileSync(path.join(mcpDir, f), "utf8").includes("setConductorSlotsAction"))).toEqual([]);
  });
});
