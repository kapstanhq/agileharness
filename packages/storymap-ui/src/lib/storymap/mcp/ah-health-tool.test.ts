import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// O ciclo de conserto — `ah_health` como tool MCP SÓ DE LEITURA: a medida dos 12 sinais de agora, o delta contra a
// leitura gravada e a versão no ar. A lógica mora em health/health-tool.ts (testada com deps injetados); aqui se prova a
// FIAÇÃO: classe de risco `read`, montada até no token `ro`, e o handler que passa pelos deps de produção.

const measureHealthNow = vi.fn();
const readLedger = vi.fn();
vi.mock("@/lib/storymap/health/health-deps", async (orig) => ({
  ...(await orig<typeof import("../health/health-deps")>()),
  measureHealthNow: (...a: unknown[]) => measureHealthNow(...a),
  diskHealthLedger: () => ({ read: () => readLedger() }),
}));
const listBoards = vi.fn();
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("../repo")>()),
  listBoards: (...a: unknown[]) => listBoards(...a),
}));

import { computeHealth, type HealthInputs } from "../health/ah-health";
import { registerStorymapTools } from "./tools";
import { riskClassForTool, setServerLevel } from "./register";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function handlers(level: "full" | "ro" = "full"): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  const server = { registerTool: (name: string, _m: unknown, h: ToolHandler) => out.set(name, h) } as unknown as McpServer;
  setServerLevel(server, level);
  registerStorymapTools(server);
  return out;
}

const NOW = Date.parse("2026-10-02T03:30:00Z");
const empty: HealthInputs = {
  now: NOW,
  inbox: [],
  demandLanes: [],
  cards: [],
  transitions: [],
  deliveredStatuses: {},
  publishWaiting: [],
  publishHeld: [],
  fleetKnown: true,
  fleet: [],
  orphanTerminals: [],
  claims: [],
  conductorQueue: [],
  stall: [],
  toolFailures: [],
  attribution: { actions: 100, attributed: 100 },
  touches: { liveStories: 1, technicalTouches: 0, ownerSessionActions: 0 },
  openTechnicalQuestions: [],
};

const text = (out: CallToolResult) => (out.content[0] as { text: string }).text;

describe("ah_health", () => {
  it("é leitura e monta até no nível `ro` (um token de leitura mede a saúde sem poder mexer em nada)", () => {
    expect(riskClassForTool("ah_health")).toBe("read");
    expect(handlers("ro").has("ah_health")).toBe(true);
    expect(handlers("full").has("ah_health")).toBe(true);
  });

  it("mede pelos deps de produção e devolve os 12 sinais, o resumo e o delta (nada é gravado: só leitura)", async () => {
    listBoards.mockResolvedValue([{ id: "alfa", name: "Alfa" }]);
    measureHealthNow.mockResolvedValue(computeHealth(empty));
    readLedger.mockResolvedValue([]);
    const out = await handlers().get("ah_health")!({});
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(text(out)) as { signals: unknown[]; summary: string; scope: { kind: string }; deltaNote: string; releaseNote: string | null };
    expect(body.signals).toHaveLength(12);
    expect(body.summary).toMatch(/ok/);
    expect(body.scope).toEqual({ kind: "installation" });
    expect(body.deltaNote).toMatch(/ainda não há leitura gravada/);
    expect(measureHealthNow).toHaveBeenLastCalledWith(expect.any(Number), {});
  });

  it("com `board`, mede o recorte; board inexistente volta como erro da tool (isError), com a lista dos que existem", async () => {
    listBoards.mockResolvedValue([{ id: "alfa", name: "Alfa" }]);
    measureHealthNow.mockResolvedValue(computeHealth(empty));
    readLedger.mockResolvedValue([]);
    const ok = await handlers().get("ah_health")!({ board: "alfa" });
    expect(JSON.parse(text(ok)).scope).toMatchObject({ kind: "board", board: "alfa" });
    expect(measureHealthNow).toHaveBeenLastCalledWith(expect.any(Number), { board: "alfa" });

    const bad = await handlers().get("ah_health")!({ board: "nao-existe" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/não existe.*alfa/);
  });
});
