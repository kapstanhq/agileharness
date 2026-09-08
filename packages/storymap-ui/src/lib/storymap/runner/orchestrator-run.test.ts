import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTickDeps } from "./orchestrator-run";
import { bumpNoopByAttempt, itemsInNoopBackoff, PER_ITEM_NOOP_MAX } from "./orchestrator-state";
import { AUTONOMO_DOCTRINE_VERSION } from "@/lib/storymap/copilot/tier";
import type { NoopStreak } from "./orchestrator-state";

// WS-5.4 — the per-item backoff filter reads the actionable set + the durable per-item streak. Mock BOTH the
// cockpit read and the state read (keeping the real pure helpers bumpNoopByItem/itemsInNoopBackoff) to prove
// hasWork EXCLUDES an item that hit the cap even while OTHER items churn.
// WS-4.2 — hasWork also consults the card CLAIMS (skip a card another actor already holds). Mocked so the
// tick's filter is deterministic without touching the real registry; `mockClaimedCards` is the set of cards
// held by SOMEONE ELSE (empty = nobody, the default for the WS-5.4 tests below).
// WS-12 — o BUMP por-item saiu do spawn (recordTick) e virou atribuição no RESULTADO do run; o diário do
// stand-down passou a contar quem ficou em backoff. Capturamos as escritas de estado (mockWriteState) e as
// linhas do diário (mockActivity) para provar as duas coisas sem tocar em disco.
const { mockCollect, mockReadState, mockWriteState, mockClaimedCards, mockActivity } = vi.hoisted(() => ({
  mockCollect: vi.fn(async (_b: string) => ({
    count: 0,
    sig: "",
    ids: [] as string[],
    itemCards: [] as Array<{ id: string; cardId: string }>,
  })),
  mockReadState: vi.fn(async (_b: string) => ({ v: 1, budget: { day: "", ticksToday: 0, costToday: 0, pushesToday: 0 } })),
  mockWriteState: vi.fn(async (_b: string, _s: unknown) => {}),
  mockClaimedCards: vi.fn(async (_b: string, _except?: string) => new Set<string>()),
  mockActivity: vi.fn(async (_b: string, _e: { kind: string; text: string }) => {}),
}));
vi.mock("@/lib/storymap/cockpit-collect", () => ({ collectActionableCockpit: mockCollect }));
vi.mock("./claims", () => ({ getCardClaims: () => ({ claimedCardIds: mockClaimedCards }) }));
vi.mock("./orchestrator-state", async (orig) => {
  const actual = await orig<typeof import("./orchestrator-state")>();
  return { ...actual, readOrchestratorState: mockReadState, writeOrchestratorState: mockWriteState };
});
vi.mock("@/lib/storymap/copilot/activity", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/copilot/activity")>();
  return { ...actual, appendCopilotActivity: mockActivity };
});

describe("buildTickDeps — fábrica compartilhada das deps do tick (Item 2)", () => {
  it("com overrideBoards, activeBoards devolve EXATAMENTE o conjunto passado (tick imediato board-scoped)", async () => {
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.activeBoards()).toEqual([{ board: "acme", mode: "autonomous" }]);
  });

  it("expõe a superfície completa de deps (spawn/hasWork/budget/lease/record) que runOrchestratorTick consome", () => {
    const deps = buildTickDeps([]) as unknown as Record<string, unknown>;
    for (const k of ["activeBoards", "hasWork", "shouldBackoff", "leaseHeldByHuman", "budgetOk", "spawn", "recordTick", "recordOutcome"]) {
      expect(typeof deps[k]).toBe("function");
    }
    expect(typeof deps.enabled).toBe("boolean");
  });

  it("sem override, activeBoards é lazy (só varre o repo quando chamado) — a fábrica em si não faz IO de boards", () => {
    // Construir as deps NÃO deve varrer boards; activeBoards é uma função a ser chamada pelo tick.
    const deps = buildTickDeps();
    expect(typeof deps.activeBoards).toBe("function");
  });
});

describe("WS-5.4 — hasWork exclui itens em backoff por-item (imune ao churn do board)", () => {
  // WS-4.2: o streak passou a carregar a doutrina sob a qual foi tomado. Estes testes falam de CONTAGEM, então
// o helper aceita o número e carimba a doutrina CORRENTE — que é o cenário deles (itens desistidos sob a regra
// em vigor CONTINUAM em backoff). O re-arm por doutrina revogada tem bloco próprio.
const stateWith = (streaks?: Record<string, number>) => ({
    v: 1 as const,
    budget: { day: "2026-07-15", ticksToday: 0, costToday: 0, pushesToday: 0 },
    ...(streaks
      ? {
          noopByItem: Object.fromEntries(
            Object.entries(streaks).map(([id, streak]) => [id, { streak, doctrine: AUTONOMO_DOCTRINE_VERSION }]),
          ),
        }
      : {}),
  });

  it("um item que atingiu o cap (streak 2) SAI do actionable set → hasWork false quando é o único", async () => {
    mockCollect.mockResolvedValue({ count: 1, sig: "s1", ids: ["item-a"], itemCards: [{ id: "item-a", cardId: "story-a" }] });
    mockReadState.mockResolvedValue(stateWith({ "item-a": 2 })); // já no cap
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(false);
  });

  it("um item AINDA sob o cap (streak 1) permanece → hasWork true", async () => {
    mockCollect.mockResolvedValue({ count: 1, sig: "s1", ids: ["item-a"], itemCards: [{ id: "item-a", cardId: "story-a" }] });
    mockReadState.mockResolvedValue(stateWith({ "item-a": 1 }));
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(true);
  });

  it("com um item em backoff E outro vivo, hasWork continua true (o vivo trabalha; o travado fica p/ o humano)", async () => {
    mockCollect.mockResolvedValue({
      count: 2,
      sig: "s2",
      ids: ["item-a", "item-b"],
      itemCards: [
        { id: "item-a", cardId: "story-a" },
        { id: "item-b", cardId: "story-b" },
      ],
    });
    mockReadState.mockResolvedValue(stateWith({ "item-a": 2 })); // a travado, b vivo
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(true);
  });
});

describe("WS-4.2 — hasWork pula cards RESERVADOS por outro ator (claims)", () => {
  const emptyState = { v: 1 as const, budget: { day: "2026-07-16", ticksToday: 0, costToday: 0, pushesToday: 0 } };

  it("o único item acionável está num card reservado por outra sessão → hasWork false (não duplica trabalho)", async () => {
    mockCollect.mockResolvedValue({ count: 1, sig: "s1", ids: ["item-a"], itemCards: [{ id: "item-a", cardId: "story-a" }] });
    mockReadState.mockResolvedValue(emptyState);
    mockClaimedCards.mockResolvedValue(new Set(["story-a"]));
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(false);
  });

  it("com um card reservado E outro livre, o tick ainda tem trabalho (age no livre)", async () => {
    mockCollect.mockResolvedValue({
      count: 2,
      sig: "s2",
      ids: ["item-a", "item-b"],
      itemCards: [
        { id: "item-a", cardId: "story-a" },
        { id: "item-b", cardId: "story-b" },
      ],
    });
    mockReadState.mockResolvedValue(emptyState);
    mockClaimedCards.mockResolvedValue(new Set(["story-a"]));
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(true);
  });

  it("o registro de claims quebrado NÃO tira trabalho do tick (fail-open: claim é anti-desperdício, não gate)", async () => {
    mockCollect.mockResolvedValue({ count: 1, sig: "s1", ids: ["item-a"], itemCards: [{ id: "item-a", cardId: "story-a" }] });
    mockReadState.mockResolvedValue(emptyState);
    mockClaimedCards.mockRejectedValue(new Error("claims store morto"));
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(true);
  });

  it("o tick não é obstáculo para si mesmo (consulta os claims de OUTROS atores)", async () => {
    mockCollect.mockResolvedValue({ count: 1, sig: "s1", ids: ["item-a"], itemCards: [{ id: "item-a", cardId: "story-a" }] });
    mockReadState.mockResolvedValue(emptyState);
    mockClaimedCards.mockResolvedValue(new Set());
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    expect(await deps.hasWork("acme")).toBe(true);
    expect(mockClaimedCards).toHaveBeenCalledWith("acme", "copilot:tick");
  });
});

describe("WS-12 (D16) — o SPAWN não pune mais por presença; a desistência é dita", () => {
  // WS-4.2: o streak passou a carregar a doutrina sob a qual foi tomado. Estes testes falam de CONTAGEM, então
// o helper aceita o número e carimba a doutrina CORRENTE — que é o cenário deles (itens desistidos sob a regra
// em vigor CONTINUAM em backoff). O re-arm por doutrina revogada tem bloco próprio.
const stateWith = (streaks?: Record<string, number>) => ({
    v: 1 as const,
    budget: { day: "2026-07-16", ticksToday: 0, costToday: 0, pushesToday: 0 },
    ...(streaks
      ? {
          noopByItem: Object.fromEntries(
            Object.entries(streaks).map(([id, streak]) => [id, { streak, doctrine: AUTONOMO_DOCTRINE_VERSION }]),
          ),
        }
      : {}),
  });

  beforeEach(() => {
    mockWriteState.mockClear();
    mockActivity.mockClear();
    mockClaimedCards.mockResolvedValue(new Set());
  });

  it("recordTick NÃO toca no noopByItem — o item presente-mas-não-tentado não apanha pelo spawn (colisão #7)", async () => {
    mockCollect.mockResolvedValue({
      count: 2,
      sig: "s",
      ids: ["story-eqpdtz:deploy-failed", "story-xfleex:approval:release"],
      itemCards: [
        { id: "story-eqpdtz:deploy-failed", cardId: "story-eqpdtz" },
        { id: "story-xfleex:approval:release", cardId: "story-xfleex" },
      ],
    });
    mockReadState.mockResolvedValue(stateWith({ "story-xfleex:approval:release": 1 }));
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    await deps.hasWork("acme"); // popula os ids que ESTE tick viu (como no fluxo real)
    await deps.recordTick("acme");

    const written = mockWriteState.mock.calls.at(-1)?.[1] as { noopByItem?: Record<string, NoopStreak> };
    // o streak de xfleex está EXATAMENTE como estava: quem bumpa agora é o resultado do run, por tentativa.
    expect(written.noopByItem).toEqual({ "story-xfleex:approval:release": { streak: 1, doctrine: AUTONOMO_DOCTRINE_VERSION } });
  });

  it("stand-down com TODOS em backoff: a mensagem conta N e NOMEIA os itens (nada de 'nada acionável')", async () => {
    const ids = ["story-eqpdtz:deploy-failed", "story-xfleex:approval:release"];
    mockCollect.mockResolvedValue({
      count: 2,
      sig: "s",
      ids,
      itemCards: ids.map((id) => ({ id, cardId: id.split(":")[0] })),
    });
    mockReadState.mockResolvedValue(stateWith(Object.fromEntries(ids.map((id) => [id, PER_ITEM_NOOP_MAX + 1]))));
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);

    expect(await deps.hasWork("acme")).toBe(false); // todos em backoff ⇒ o tick não spawna…
    await deps.recordOutcome!("acme", "skipped-no-work");

    const said = mockActivity.mock.calls.at(-1)?.[1] as { text: string };
    expect(said.text).toContain("2 itens acionáveis");
    expect(said.text).toContain("story-xfleex:approval:release");
    expect(said.text).toContain("story-eqpdtz:deploy-failed");
    expect(said.text).not.toContain("nada acionável"); // …e NÃO mente sobre o motivo
  });

  // AC1 — o replay da colisão #7 fechado no GATE que matava o card: o pre-check zero-token. Os itens ruidosos
  // (tentados 2×) saem; o card LIMPO, nunca tentado, continua acionável ⇒ o tick spawna ⇒ o playbook 8.3 do
  // WS-8 é alcançável. Era exatamente aqui que o board acme respondia `skipped-no-work` com xfleex pronto.
  it("REPLAY colisão #7: após 2 runs que só tentaram os ruidosos, o tick AINDA tem trabalho (o card limpo)", async () => {
    const items = [
      { id: "story-eqpdtz:deploy-failed", cardId: "story-eqpdtz" },
      { id: "story-qb8z2c:approval:release", cardId: "story-qb8z2c" },
      { id: "story-xfleex:approval:release", cardId: "story-xfleex" },
    ];
    // o estado como os DOIS runs reais o teriam deixado sob a régua nova (atribuição por tentativa).
    const tried = { anyMutation: true, attemptedCardIds: new Set(["story-eqpdtz", "story-qb8z2c"]) };
    const after = bumpNoopByAttempt(bumpNoopByAttempt(stateWith(), items, tried), items, tried);

    mockCollect.mockResolvedValue({ count: 3, sig: "s", ids: items.map((i) => i.id), itemCards: items });
    mockReadState.mockResolvedValue(after);
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);

    expect(await deps.hasWork("acme")).toBe(true); // ⇐ era false: o card limpo apanhava por tabela e o tick dormia
    expect(itemsInNoopBackoff(after)).toEqual(new Set(["story-eqpdtz:deploy-failed", "story-qb8z2c:approval:release"]));
    expect(itemsInNoopBackoff(after).has("story-xfleex:approval:release")).toBe(false);
  });

  it("stand-down com o board de fato vazio segue dizendo 'nada acionável' (sem inventar desistência)", async () => {
    mockCollect.mockResolvedValue({ count: 0, sig: "", ids: [], itemCards: [] });
    mockReadState.mockResolvedValue(stateWith());
    const deps = buildTickDeps([{ board: "acme", mode: "autonomous" }]);
    await deps.hasWork("acme");
    await deps.recordOutcome!("acme", "skipped-no-work");

    expect((mockActivity.mock.calls.at(-1)?.[1] as { text: string }).text).toContain("nada acionável");
  });
});
