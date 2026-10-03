// O ESCOPO DE TIPOS visto pelo DONO, de ponta a ponta. Um board fictício (uma livraria) com seis cards, o modo «Só
// consertos e manutenção» ligado, e as funções REAIS de ponta a ponta:
//   changeBoardScope (a ação) → o arquivo de ritmo de verdade (num diretório temporário) → o portão → evaluateAutorunOnEntry
//   (a entrada de coluna e o despacho do condutor) → sweepBoardPace (o prazo) → a catraca do tipo.
// O IO de fora é injetado: o engine (só registra o que mandariam rodar), o despacho do condutor (idem), a leitura do board e
// dos cards (em memória) e a FILA do engine (um vetor). Nada aqui toca o board de ninguém.
//
// A pergunta que cada teste responde é a do dono: «com o modo ligado, o que o board começa e o que ele deixa esperando — e
// o que volta sozinho quando eu desligo?».

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const { mockRunSkill, mockDispatchConductor, mockRunEntryEffect, mockUpdateCardOnDisk, world } = vi.hoisted(() => ({
  mockRunSkill: vi.fn((..._a: unknown[]) => ({ ok: true as const })),
  mockDispatchConductor: vi.fn(async (..._a: unknown[]) => {}),
  mockRunEntryEffect: vi.fn(async (..._a: unknown[]) => {}),
  mockUpdateCardOnDisk: vi.fn(async (_b: string, id: string, mutate: (c: { id: string; status: string | null }) => unknown) => mutate({ id, status: "desenvolver" })),
  // o «disco» do teste: os cards do board e a fila do engine (ids de card)
  world: { cards: [] as unknown[], queue: [] as string[] },
}));

vi.mock("@/lib/storymap/runner/engine", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/engine")>();
  return {
    ...actual,
    getRunnerEngine: () => ({
      runSkill: mockRunSkill,
      onComplete: () => () => {},
      lastRun: async () => undefined,
      recentlyCancelledAgeMs: () => null,
      clearRecentlyCancelled: () => {},
    }),
  };
});
vi.mock("@/lib/storymap/runner/telemetry", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/telemetry")>();
  return { ...actual, getTelemetryStore: () => ({ listByCard: async () => [], recordRun: async () => {}, boardSummary: async () => ({ boardId: "livraria", cards: [], totalCostUSD: 0 }) }) };
});
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  const on = { ...actual.DEFAULT_RUNNER_SETTINGS, autorun: { ...actual.DEFAULT_RUNNER_SETTINGS.autorun, enabled: true } };
  return { ...actual, loadRunnerConfig: vi.fn(() => on) };
});
vi.mock("@/lib/storymap/runner/fleet-deps", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/fleet-deps")>();
  return { ...actual, dispatchConductorOnEntry: mockDispatchConductor };
});
vi.mock("@/lib/storymap/runner/entry-effects", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/entry-effects")>();
  return { ...actual, runEntryEffect: mockRunEntryEffect };
});
vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readBoardConfig: vi.fn(), readCards: vi.fn() };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return { ...actual, updateCardOnDisk: mockUpdateCardOnDisk };
});

import { evaluateAutorunOnEntry } from "@/lib/notifications/server/channels/autorun-eval";
import { coerceCard, readBoardConfig, readCards } from "@/lib/storymap/repo";
import {
  boardPaceViewNow,
  changeBoardScope,
  sweepBoardPace,
  type BoardPaceDeps,
  type BoardScopeOutcome,
} from "./board-pace-actions";
import { effectiveScope, FIXES_ONLY_TYPES, gateAdmitsCard, storyTypeChangeLine, storyTypeChangeRefusal, type PaceActor, type ScopeCard } from "./board-pace";
import { boardGateNow, boardPaceRow, mutateBoardPace, readBoardPace } from "./board-pace-store";

const BOARD = "livraria";
const OWNER: PaceActor = { kind: "owner" };
const AGENT: PaceActor = { kind: "agent", id: "TOKEN_COPILOTO" };
const T0 = Date.parse("2026-03-10T12:00:00.000Z");
const MIN = 60_000;

// Os seis cards da livraria. Ids de exemplo (story-ex99NN) — a gravação em disco não existe, só o que o teste devolve ao kernel.
const BUSCA = "story-ex9950"; // funcionalidade nova, construindo
const DESEJOS = "story-ex9951"; // funcionalidade nova, esperando o go (o board despacharia o condutor)
const CARRINHO = "story-ex9952"; // erro, construindo
const FRETE = "story-ex9953"; // erro RECÉM-CAPTURADO: nasce com o tipo padrão (user), na especificação
const BIBLIOTECA = "story-ex9954"; // manutenção, construindo
const INDICE = "story-ex9955"; // trabalho técnico, esperando o go

const config = (): BoardConfig => ({
  id: BOARD,
  name: "Livraria",
  statuses: [
    { id: "grill", name: "Dúvidas", trigger: "harness-grill", autorun: true },
    { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true },
    { id: "pronta", name: "Pronta", autorun: false },
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: true },
    { id: "revisar-codigo", name: "Revisar código", trigger: "harness-review", autorun: true },
    { id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true },
    { id: "revisao", name: "Revisão", autorun: false },
    { id: "concluida", name: "Concluída", terminal: true, delivered: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  conductor: { enabled: true, fromStatus: "pronta" },
});

const mk = (id: string, data: Record<string, unknown>): Card => coerceCard(id, { type: "story", title: id, ...data }, "");
const livraria = (): Card[] => [
  mk(BUSCA, { status: "desenvolver", storyType: "user" }),
  mk(DESEJOS, { status: "pronta", storyType: "user" }),
  mk(CARRINHO, { status: "desenvolver", storyType: "bug" }),
  mk(FRETE, { status: "enriquecer" }), // sem tipo: o padrão de quem acabou de capturar
  mk(BIBLIOTECA, { status: "desenvolver", storyType: "chore" }),
  mk(INDICE, { status: "pronta", storyType: "technical" }),
];
const cardsNow = () => world.cards as Card[];
const byId = (id: string) => cardsNow().find((c) => c.id === id) as Card;

/** As portas da AÇÃO do ritmo: o arquivo de ritmo REAL (diretório temporário), a fila do engine em memória, e a devolução que
 *  roda a entrada de coluna de verdade — o mesmo caminho da produção (`defaultBoardPaceDeps.rearm`). */
function deps(extra: { parked?: string[]; kicks?: { n: number } } = {}): BoardPaceDeps {
  return {
    readConfig: async () => config(),
    snapshot: () => readBoardPace(),
    mutate: (fn) => mutateBoardPace(fn),
    stopRuns: async (_board, _reason, opts) => {
      const out: string[] = [];
      for (const id of [...world.queue]) {
        if (!opts.only || (await opts.only(id))) {
          out.push(id);
          world.queue = world.queue.filter((q) => q !== id);
        }
      }
      return out.map((cardId) => ({ cardId }));
    },
    readCards: async () => cardsNow(),
    parkConductors: async () => {
      extra.parked?.push(BOARD);
      return [];
    },
    rearm: async (board, entry) => {
      await evaluateAutorunOnEntry(board, entry.cardId);
    },
    kick: () => {
      if (extra.kicks) extra.kicks.n += 1;
    },
    now: () => Date.now(),
    log: () => {},
  };
}

const scopeOf = (): ReturnType<typeof effectiveScope> => effectiveScope(boardPaceRow(BOARD) ?? null, Date.now());
const ran = (): Array<{ id: string; skill: string }> => mockRunSkill.mock.calls.map((c) => ({ id: c[1] as string, skill: c[2] as string }));
const dispatched = (): string[] => mockDispatchConductor.mock.calls.map((c) => c[1] as string);
const okOutcome = (o: BoardScopeOutcome) => {
  if (!o.ok) throw new Error(`recusado: ${o.error}`);
  return o;
};
const resetCalls = () => {
  mockRunSkill.mockClear();
  mockDispatchConductor.mockClear();
};

let dir: string;
let prevDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "board-pace-scope-"));
  prevDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = dir;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  world.cards = livraria();
  world.queue = [];
  resetCalls();
  vi.mocked(readBoardConfig).mockImplementation(async () => config());
  vi.mocked(readCards).mockImplementation(async () => cardsNow());
});

afterEach(() => {
  vi.useRealTimers();
  if (prevDir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("só consertos e manutenção — o board da livraria, do ponto de vista do dono", () => {
  it("SEM escopo: tudo começa como sempre (o ponto de partida do contraste)", async () => {
    for (const id of [BUSCA, DESEJOS, CARRINHO, BIBLIOTECA, INDICE]) await evaluateAutorunOnEntry(BOARD, id);
    expect(ran().map((r) => r.id).sort()).toEqual([BIBLIOTECA, BUSCA, CARRINHO].sort());
    expect(dispatched().sort()).toEqual([DESEJOS, INDICE].sort());
  });

  it("LIGAR: a funcionalidade nova não despacha condutor nem entra em coluna de construção; erro, manutenção e trabalho técnico seguem", async () => {
    const out = okOutcome(await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER, reason: "semana de arrumar a casa" }));
    expect(out.changed).toBe(true);
    expect(scopeOf()?.types).toEqual(["bug", "technical", "chore", "spike"]);
    // o ritmo NÃO mudou: o escopo é outro eixo
    expect(out.gate).toMatchObject({ level: "normal", held: false });

    for (const id of [BUSCA, DESEJOS, CARRINHO, BIBLIOTECA, INDICE]) await evaluateAutorunOnEntry(BOARD, id);

    // a construção: só o erro e a manutenção rodam; a Busca (funcionalidade) não
    expect(ran()).toEqual(expect.arrayContaining([{ id: CARRINHO, skill: "harness-do" }, { id: BIBLIOTECA, skill: "harness-do" }]));
    expect(ran().map((r) => r.id)).not.toContain(BUSCA);
    // o condutor: o trabalho técnico despacha, a lista de desejos (funcionalidade) não
    expect(dispatched()).toEqual([INDICE]);
  });

  it("a funcionalidade barrada fica ANOTADA como retida pelo escopo (volta sozinha), uma entrada por card", async () => {
    await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER });
    await evaluateAutorunOnEntry(BOARD, BUSCA);
    await evaluateAutorunOnEntry(BOARD, BUSCA); // o eco do vigia de arquivos: a anotação não duplica
    const held = boardPaceRow(BOARD)?.held ?? [];
    expect(held.filter((h) => h.cardId === BUSCA)).toEqual([expect.objectContaining({ cardId: BUSCA, why: "scope" })]);
  });

  it("o erro recém-capturado (tipo padrão: funcionalidade) ANDA nas colunas de dúvidas e especificação — e é classificado", async () => {
    await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER });
    // captura/triagem/dúvidas/especificação nunca são barradas: senão o bug nunca seria reconhecido como bug
    byId(FRETE).status = "grill";
    await evaluateAutorunOnEntry(BOARD, FRETE);
    byId(FRETE).status = "enriquecer";
    await evaluateAutorunOnEntry(BOARD, FRETE);
    expect(ran()).toEqual([
      { id: FRETE, skill: "harness-grill" },
      { id: FRETE, skill: "harness-enrich" },
    ]);

    // quem especifica (um agente) classifica o card NOVO: permitido, mesmo sob escopo
    expect(storyTypeChangeRefusal(scopeOf(), byId(FRETE), "bug", AGENT)).toBeNull();
    byId(FRETE).storyType = "bug";
    byId(FRETE).status = "desenvolver";
    resetCalls();
    await evaluateAutorunOnEntry(BOARD, FRETE);
    // agora é um erro de verdade: entra na construção
    expect(ran()).toEqual([{ id: FRETE, skill: "harness-do" }]);
  });

  it("e se o recém-capturado era mesmo uma funcionalidade, ele chega à construção e ESPERA lá (não gasta)", async () => {
    await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER });
    byId(FRETE).status = "enriquecer";
    await evaluateAutorunOnEntry(BOARD, FRETE); // especificar anda
    byId(FRETE).status = "desenvolver"; // o tipo ficou user
    resetCalls();
    await evaluateAutorunOnEntry(BOARD, FRETE);
    expect(ran()).toEqual([]);
    expect(boardPaceRow(BOARD)?.held?.map((h) => h.cardId)).toContain(FRETE);
  });

  it("a FILA do engine: ao estreitar sai só a funcionalidade (anotada); ao alargar volta sozinha — e o que esperava no go também", async () => {
    world.queue = [BUSCA, CARRINHO, BIBLIOTECA];
    const parked: string[] = [];
    const kicks = { n: 0 };
    const narrow = okOutcome(await changeBoardScope(deps({ parked, kicks }), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER }));
    expect(narrow.purged).toBe(1);
    expect(world.queue).toEqual([CARRINHO, BIBLIOTECA]); // o que cabe no escopo segue na fila
    expect(parked).toEqual([]); // condutores vivos não são estacionados
    expect(boardPaceRow(BOARD)?.held).toEqual([expect.objectContaining({ cardId: BUSCA, why: "scope" })]);

    // a lista de desejos chega ao go com o escopo ligado: o condutor NÃO é despachado, e o disparo fica anotado
    await evaluateAutorunOnEntry(BOARD, DESEJOS);
    expect(dispatched()).toEqual([]);
    expect(boardPaceRow(BOARD)?.held).toEqual(expect.arrayContaining([expect.objectContaining({ cardId: DESEJOS, why: "scope" })]));

    // o dono volta ao normal
    resetCalls();
    const wide = okOutcome(await changeBoardScope(deps({ kicks }), { board: BOARD, types: "all", by: OWNER }));
    expect(wide.released).toBeGreaterThanOrEqual(1);
    expect(scopeOf()).toBeNull();
    expect(boardPaceRow(BOARD)?.held ?? []).toEqual([]);
    expect(kicks.n).toBeGreaterThanOrEqual(1);
    // a Busca voltou pela mesma porta de uma entrada de coluna: a construção dela rodou
    expect(ran()).toEqual(expect.arrayContaining([{ id: BUSCA, skill: "harness-do" }]));
    // a lista de desejos (esperava o condutor, na coluna do go) também não ficou para trás
    expect(dispatched()).toContain(DESEJOS);
  });

  it("alargar sem nada anotado re-varre os cards de construção (a anotação sozinha não basta)", async () => {
    // a Busca foi barrada ANTES de qualquer anotação existir (arquivo de ritmo de outro processo, teto de 500 estourado…)
    await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER });
    await mutateBoardPace((rows) => rows.map((r) => ({ ...r, held: undefined })));
    expect(boardPaceRow(BOARD)?.held ?? []).toEqual([]);
    resetCalls();
    const wide = okOutcome(await changeBoardScope(deps(), { board: BOARD, types: "all", by: OWNER }));
    expect(wide.rescanned).toBeGreaterThanOrEqual(1);
    expect(ran()).toEqual(expect.arrayContaining([{ id: BUSCA, skill: "harness-do" }]));
  });

  it("o PRAZO do escopo do agente vence na varredura: volta ao normal sozinho e devolve o que esperava", async () => {
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: AGENT, reason: "cota apertada", forMinutes: 60 }));
    expect(scopeOf()?.by).toEqual(AGENT);
    await evaluateAutorunOnEntry(BOARD, BUSCA);
    expect(ran().map((r) => r.id)).not.toContain(BUSCA);

    // 59 minutos: ainda vale; a varredura não faz nada
    vi.setSystemTime(T0 + 59 * MIN);
    expect(await sweepBoardPace(deps())).toEqual({ resumed: [] });
    expect(scopeOf()).not.toBeNull();

    // 61 minutos: o portão já responde «tudo» (o prazo vencido não conta), e a varredura DEVOLVE o trabalho
    vi.setSystemTime(T0 + 61 * MIN);
    expect(boardGateNow(BOARD, {}).scope ?? null).toBeNull();
    expect(gateAdmitsCard(boardGateNow(BOARD, {}), byId(BUSCA), "column")).toEqual({ admit: true, why: "" });
    resetCalls();
    const report = await sweepBoardPace(deps());
    expect(report.scopeExpired).toEqual([expect.objectContaining({ board: BOARD })]);
    expect(ran()).toEqual(expect.arrayContaining([{ id: BUSCA, skill: "harness-do" }]));
    expect(boardPaceRow(BOARD)?.agentScope).toBeUndefined();
  });

  // C4 («deixa terminar»): o escopo barra o COMEÇO da construção. Uma funcionalidade cujo desenvolvimento terminou DEPOIS de o dono
  // estreitar chega à revisão de código e à QA e segue até a entrega — não fica parada e anotada com o código escrito.
  it("O QUE JÁ COMEÇOU TERMINA: a funcionalidade que acabou de desenvolver passa pela revisão e pela QA mesmo com o escopo ligado", async () => {
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER }));
    resetCalls();
    world.cards = [mk("story-ex9960", { status: "revisar-codigo", storyType: "user" }), mk("story-ex9961", { status: "qa-automatizado", storyType: "user" }), ...livraria()];
    await evaluateAutorunOnEntry(BOARD, "story-ex9960");
    await evaluateAutorunOnEntry(BOARD, "story-ex9961");
    expect(ran()).toEqual([
      { id: "story-ex9960", skill: "harness-review" },
      { id: "story-ex9961", skill: "harness-qa" },
    ]);
    // …mas uma funcionalidade que ainda NÃO começou a construir segue barrada
    resetCalls();
    await evaluateAutorunOnEntry(BOARD, BUSCA);
    expect(ran()).toEqual([]);
    // e as que o escopo segura não incluem as que estão terminando
    const view = await boardPaceViewNow(BOARD);
    expect(view?.scopeWaiting).toBe(2); // Busca (construção) e Lista de desejos (despacho do condutor) — não as duas que terminam
  });

  it("o AGENTE não alarga o que o dono limitou — nem com «tudo», nem com um tipo a mais; estreitar por dentro pode", async () => {
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER }));
    const before = JSON.stringify(boardPaceRow(BOARD));

    // «Tudo» de um agente = tirar a camada DELE (C11): sem camada de agente é no-op, e o dono segue mandando
    const all = await changeBoardScope(deps(), { board: BOARD, types: "all", by: AGENT });
    expect(all.ok).toBe(true);
    expect(scopeOf()?.types).toEqual(["bug", "technical", "chore", "spike"]);
    const more = await changeBoardScope(deps(), { board: BOARD, types: ["user", "bug"], by: AGENT });
    expect(more.ok).toBe(false);
    if (!more.ok) expect(more.error).toMatch(/dono/i);
    expect(JSON.stringify(boardPaceRow(BOARD))).toBe(before);

    // por dentro do que o dono admite: estreitar ainda mais é permitido (a interseção manda)
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: ["bug"], by: AGENT }));
    expect(scopeOf()?.types).toEqual(["bug"]);
    resetCalls();
    await evaluateAutorunOnEntry(BOARD, BIBLIOTECA); // manutenção: o dono admite, mas o agente estreitou para só erro
    expect(ran()).toEqual([]);
    await evaluateAutorunOnEntry(BOARD, CARRINHO);
    expect(ran()).toEqual([{ id: CARRINHO, skill: "harness-do" }]);

    // e só o DONO alarga: ao gravar o escopo dele, o do agente sai
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: "all", by: OWNER }));
    expect(scopeOf()).toBeNull();
    expect(boardPaceRow(BOARD)?.agentScope).toBeUndefined();
  });

  it("sem limite do dono, o agente desfaz o PRÓPRIO escopo (o freio de agente é dele)", async () => {
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: AGENT }));
    expect(scopeOf()).not.toBeNull();
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: "all", by: AGENT }));
    expect(scopeOf()).toBeNull();
  });

  it("TROCA DE TIPO: o agente não transforma em manutenção uma funcionalidade já classificada; o dono pode; o card novo o agente classifica", async () => {
    // sem escopo ninguém é barrado
    expect(storyTypeChangeRefusal(scopeOf(), byId(BUSCA), "chore", AGENT)).toBeNull();

    await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER });
    const scope = scopeOf();
    expect(scope).not.toBeNull();

    // user → chore por agente, num card que já passou da especificação: recusado, e a frase diz o que fazer
    const refusal = storyTypeChangeRefusal(scope, byId(BUSCA), "chore", AGENT);
    expect(refusal).toMatch(/dono/);
    expect(refusal).toMatch(/Funcionalidade nova/);
    expect(refusal).toMatch(/troque o tipo|peça/i);
    // o dono troca livremente
    expect(storyTypeChangeRefusal(scope, byId(BUSCA), "chore", OWNER)).toBeNull();
    // um card ainda novo (especificação) o agente classifica
    expect(storyTypeChangeRefusal(scope, byId(FRETE), "bug", AGENT)).toBeNull();
    // e quem não era funcionalidade pode mudar entre os tipos de conserto
    expect(storyTypeChangeRefusal(scope, byId(CARRINHO), "chore", AGENT)).toBeNull();
    // a trilha de auditoria diz antes, depois e quem
    const line = storyTypeChangeLine(byId(BUSCA), "chore", AGENT);
    expect(line).toContain(BUSCA);
    expect(line).toContain("Funcionalidade nova");
    expect(line).toContain("Manutenção");
    expect(line).toContain("TOKEN_COPILOTO");
  });

  it("a PUBLICAÇÃO não é barrada: o que já chegou à entrega segue, e o painel conta as funcionalidades que vão junto", async () => {
    await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER });
    // uma funcionalidade já construída, esperando na revisão: o escopo só controla o INÍCIO do trabalho
    world.cards = [...livraria(), mk("story-ex9956", { status: "revisao", storyType: "user" })];
    expect(gateAdmitsCard(boardGateNow(BOARD, {}), byId("story-ex9956"), "column").admit).toBe(true);

    const view = await boardPaceViewNow(BOARD);
    expect(view?.scope).toMatchObject({ preset: "fixes", types: ["bug", "technical", "chore", "spike"] });
    // as duas funcionalidades que o escopo segura: a Busca (construção) e a Lista de desejos (`pronta`, onde o condutor deste board despacha)
    expect(view?.scopeWaiting).toBe(2);
    // a que já está na revisão vai junto na próxima publicação
    expect(view?.featuresToShip).toBe(1);
  });

  it("PAUSA e ESCOPO são eixos separados: pausar segura tudo, e retomar não apaga o escopo (nem o contrário)", async () => {
    okOutcome(await changeBoardScope(deps(), { board: BOARD, types: FIXES_ONLY_TYPES, by: OWNER }));
    await mutateBoardPace((rows) => rows.map((r) => ({ ...r, owner: { level: "paused" as const, by: OWNER, at: new Date(Date.now()).toISOString() } })));
    resetCalls();
    await evaluateAutorunOnEntry(BOARD, CARRINHO); // pausado: nem o erro roda
    expect(ran()).toEqual([]);
    expect(boardGateNow(BOARD, {})).toMatchObject({ level: "paused", held: true });
    expect(scopeOf()).not.toBeNull(); // o escopo continua escrito debaixo da pausa

    await mutateBoardPace((rows) => rows.map((r) => ({ ...r, owner: undefined })));
    expect(boardGateNow(BOARD, {})).toMatchObject({ level: "normal", held: false });
    expect(scopeOf()?.types).toEqual(["bug", "technical", "chore", "spike"]);
    const c: ScopeCard = byId(BUSCA);
    expect(gateAdmitsCard(boardGateNow(BOARD, {}), c, "column").admit).toBe(false);
  });
});
