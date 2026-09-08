import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardMetrics } from "./runner/telemetry";

// WS-12.2 (D16) — o Inbox carimba nos items os que o Jido autônomo DESISTIU (backoff por-item), lendo
// o estado durável do orquestrador. Mockamos as fontes de IO da dobra (o board + os 5 sidecars/ledgers) para
// isolar o carimbo; `mockNoopByItem` é o estado real de 2026-07-16 do acme.
const { mockGetBoard, mockNoopByItem, mockReadBoardConfig } = vi.hoisted(() => ({
  mockGetBoard: vi.fn(),
  mockNoopByItem: vi.fn(() => ({}) as Record<string, { streak: number; doctrine: string }>),
  mockReadBoardConfig: vi.fn(),
}));
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...(await orig<typeof import("./repo")>()),
  getBoard: mockGetBoard,
  readBoardConfig: mockReadBoardConfig,
}));
vi.mock("@/lib/storymap/runner/telemetry", () => ({ getTelemetryStore: () => ({ boardSummary: async () => ({ cards: [] }) }) }));
vi.mock("@/lib/storymap/runner/registry", () => ({ getRunnerRegistry: () => ({ mergeQueueSnapshot: () => ({ entries: [] }) }) }));
vi.mock("@/lib/storymap/sidecars", () => ({ listGovernanceDrafts: async () => [], readProposal: async () => null, readWireframe: async () => null }));
vi.mock("@/lib/storymap/approvals", () => ({ listApprovalRequests: async () => [] }));
vi.mock("@/lib/storymap/runner/orchestrator-state", async (orig) => {
  const actual = await orig<typeof import("./runner/orchestrator-state")>();
  return { ...actual, readOrchestratorState: async () => ({ v: 1, budget: { day: "", ticksToday: 0, costToday: 0, pushesToday: 0 }, noopByItem: mockNoopByItem() }) };
});

import { collectActionableCockpit, collectBoardCockpitItems, isStuckCardMetric } from "./cockpit-collect";
import { PER_ITEM_NOOP_MAX } from "./runner/orchestrator-state";
import { coerceCard } from "./repo";
import type { BoardConfig } from "./types";
import { AUTONOMO_DOCTRINE_VERSION } from "@/lib/storymap/copilot/tier";

// story-mzpzb0 — o Inbox deriva "TRAVADO" do telemetry durável (lastStatus ∈ falhas). O bug: um run
// que SAIU SUJO mas cujo card AVANÇOU (sucesso-com-aviso) grava o mesmo lastStatus cru ("exit") que uma
// falha real, então os dois viram TRAVADO. Com o sinal durável `lastAdvanced`, o predicado exclui o
// sucesso-com-aviso do lane travado — sem perder a falha real (sem avanço) nem quebrar registros antigos
// (sem lastAdvanced ⇒ tratados como antes: travado).
const m = (over: Partial<CardMetrics>): CardMetrics => ({
  cardId: "c1",
  totalRuns: 1,
  totalCostUSD: 0,
  avgTurns: null,
  lastRunAt: 1,
  lastStatus: null,
  ...over,
});

describe("isStuckCardMetric — separa falha real de sucesso-com-aviso no Inbox", () => {
  it("outcome de falha SEM avanço ⇒ travado", () => {
    for (const s of ["error", "exit", "timeout", "oom-killed", "no-op"] as const) {
      expect(isStuckCardMetric(m({ lastStatus: s, lastAdvanced: false }))).toBe(true);
    }
  });

  it("outcome de falha COM avanço (sucesso-com-aviso) ⇒ NÃO travado", () => {
    for (const s of ["exit", "timeout", "oom-killed", "error"] as const) {
      expect(isStuckCardMetric(m({ lastStatus: s, lastAdvanced: true }))).toBe(false);
    }
  });

  it("registro antigo sem lastAdvanced ⇒ travado (retrocompatível)", () => {
    expect(isStuckCardMetric(m({ lastStatus: "exit" }))).toBe(true);
  });

  it("sucesso/cancel/resumível/sem-run ⇒ NÃO travado", () => {
    expect(isStuckCardMetric(m({ lastStatus: "ok" }))).toBe(false);
    expect(isStuckCardMetric(m({ lastStatus: "cancelled" }))).toBe(false);
    expect(isStuckCardMetric(m({ lastStatus: "max-turns" }))).toBe(false);
    expect(isStuckCardMetric(m({ lastStatus: null }))).toBe(false);
  });
});

describe("WS-12.2 (D16) — o Inbox carimba os itens de que o Jido desistiu", () => {
  const config: BoardConfig = {
    id: "acme",
    name: "Nest",
    statuses: [
      { id: "release", name: "Publicar", autorun: false },
      { id: "concluida", name: "No ar", terminal: true },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  };
  const XFLEEX = "story-xfleex:approval:release";

  beforeEach(() => {
    mockGetBoard.mockResolvedValue({
      config,
      cards: [coerceCard("story-xfleex", { type: "story", status: "release", qaPassed: true }, "")],
    });
    mockNoopByItem.mockReturnValue({});
  });

  it("item no cap ⇒ chip com o streak REAL (o operador vê quantas vezes ele tentou antes de largar)", async () => {
    mockNoopByItem.mockReturnValue({ [XFLEEX]: { streak: 4, doctrine: AUTONOMO_DOCTRINE_VERSION } }); // o estado vivo do acme em 2026-07-16
    const items = await collectBoardCockpitItems("acme");
    expect(items.find((i) => i.id === XFLEEX)?.copilotBackoff).toEqual({ streak: 4 });
  });

  // autonomy-endgame WS-4.5 — o chip conta a VERDADE. Um item desistido sob doutrina REVOGADA não é "seu
  // agora": ele volta ao tick sozinho no próximo ciclo (itemsInNoopBackoff filtra pela doutrina viva). Mostrar
  // o chip de hand-off ali convidaria o operador a fazer trabalho que o tick já está retomando.
  it("item no cap mas sob doutrina REVOGADA não leva chip — ele volta pro tick sozinho, não é do humano", async () => {
    mockNoopByItem.mockReturnValue({ [XFLEEX]: { streak: 4, doctrine: "pre" } });
    expect((await collectBoardCockpitItems("acme")).find((i) => i.id === XFLEEX)?.copilotBackoff).toBeUndefined();
  });

  it("item AINDA sob o cap não leva chip — o Jido não desistiu dele (só tentou)", async () => {
    mockNoopByItem.mockReturnValue({ [XFLEEX]: { streak: PER_ITEM_NOOP_MAX - 1, doctrine: AUTONOMO_DOCTRINE_VERSION } });
    expect((await collectBoardCockpitItems("acme")).find((i) => i.id === XFLEEX)?.copilotBackoff).toBeUndefined();
  });

  it("sem estado de backoff, os itens saem limpos (o caso normal)", async () => {
    const items = await collectBoardCockpitItems("acme");
    expect(items).toHaveLength(1);
    expect(items[0].copilotBackoff).toBeUndefined();
  });
});

// A COSTURA que entrega a feature: o conjunto acionável é condicional ao TIER, e o tier sai da MESMA policy
// que o guard por chamada lê. O predicado puro está coberto em demands.test.ts; o que se prova AQUI é que
// collectActionableCockpit de fato consulta a policy do board — sem isto, o tier seria um rótulo inerte (a
// única outra cobertura de collectActionableCockpit é orchestrator-run.test.ts, que o MOCKA por inteiro).
describe("collectActionableCockpit — o acionável do tick é condicional ao TIER do board", () => {
  const config = (orchestrator?: BoardConfig["orchestrator"]): BoardConfig => ({
    id: "acme",
    name: "Nest",
    statuses: [
      { id: "release", name: "Publicar", autorun: false },
      { id: "concluida", name: "No ar", terminal: true },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
    orchestrator,
  });
  // um card que emite os DOIS lados da divisa: um `gate` (base — todo tier ativo pega) e um `blocker`
  // (autonomo — julgamento que o Copiloto escala de volta ao humano).
  const cards = [
    coerceCard(
      "story-xfleex",
      { type: "story", status: "release", qaPassed: true, findings: [{ id: "f1", lens: "security", severity: "blocker", status: "open", title: "regra de Firestore aberta" }] },
      "",
    ),
  ];
  const setTier = (orchestrator?: BoardConfig["orchestrator"]) => {
    mockGetBoard.mockResolvedValue({ config: config(orchestrator), cards });
    mockReadBoardConfig.mockResolvedValue(config(orchestrator));
  };

  beforeEach(() => mockNoopByItem.mockReturnValue({}));

  it("COPILOTO (deploy:ask) ⇒ só o `gate`; o blocker fica com o humano", async () => {
    setTier({ mode: "autonomous", riskMatrix: { deploy: "ask" } });
    const { ids, count } = await collectActionableCockpit("acme");
    expect(ids).toEqual(["story-xfleex:approval:release"]);
    expect(count).toBe(1);
  });

  it("AUTÔNOMO (deploy:auto) ⇒ o MESMO board entrega gate + blocker (paridade com o humano)", async () => {
    setTier({ mode: "autonomous", riskMatrix: { deploy: "auto" } });
    const { ids, count } = await collectActionableCockpit("acme");
    expect(ids).toEqual(["story-xfleex:approval:release", "story-xfleex:b:f1"]);
    expect(count).toBe(2);
  });

  it("board sem policy ⇒ chat ⇒ o conjunto CONSERVADOR (nunca alarga por omissão)", async () => {
    setTier(undefined);
    expect((await collectActionableCockpit("acme")).ids).toEqual(["story-xfleex:approval:release"]);
  });

  it("policy ILEGÍVEL (board.yaml sumiu) ⇒ fail-safe no conservador, não no Autônomo", async () => {
    mockGetBoard.mockResolvedValue({ config: config({ mode: "autonomous", riskMatrix: { deploy: "auto" } }), cards });
    mockReadBoardConfig.mockRejectedValue(new Error("ENOENT"));
    expect((await collectActionableCockpit("acme")).ids).toEqual(["story-xfleex:approval:release"]);
  });
});
