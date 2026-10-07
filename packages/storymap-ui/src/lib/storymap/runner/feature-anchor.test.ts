import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, CardQuestion } from "@/lib/storymap/types";
import {
  ANCHOR_ASKED_BY,
  ANCHOR_CARDS_PER_RUN,
  ANCHOR_FAILURE_BACKOFF_MS,
  ANCHOR_INTERVAL_MS,
  ANCHOR_LEAVE_OPTION,
  anchorAnswers,
  anchorCandidates,
  applyAnswersToState,
  decideAnchorRun,
  featuresHashOf,
  runFeatureAnchorTick,
  runningStillLive,
  settleAnchorRun,
  type AnchorRunInput,
  type FeatureAnchorBoardState,
  type FeatureAnchorDeps,
  type FeatureAnchorFile,
} from "./feature-anchor";

// Fixtures inventadas: uma livraria de demonstração.
const CONFIG = {
  statuses: [
    { id: "triage", name: "Triagem" },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "concluida", name: "Concluída", terminal: true },
  ],
} as unknown as BoardConfig;

const FEATURES = [
  { id: "busca-no-catalogo", name: "Busca no catálogo", markdown: "Achar livros pelo título e pelo autor." },
  { id: "lista-de-desejos", name: "Lista de desejos", markdown: "Guardar livros para depois." },
];

const NOW = Date.parse("2026-10-07T12:00:00Z");

function card(id: string, over: Partial<Card> = {}): Card {
  return { id, type: "story", title: `Card ${id}`, status: "desenvolver", ...over } as Card;
}

describe("featuresHashOf", () => {
  it("muda quando uma funcionalidade é renomeada, criada ou apagada; igual para a mesma lista", () => {
    const h = featuresHashOf(FEATURES);
    expect(featuresHashOf([...FEATURES])).toBe(h);
    expect(featuresHashOf([{ ...FEATURES[0], name: "Busca" }, FEATURES[1]])).not.toBe(h);
    expect(featuresHashOf([FEATURES[0]])).not.toBe(h);
  });
});

describe("anchorCandidates — a mesma régua do Kanban («Outros»)", () => {
  const cards = [
    card("story-ex9001"),
    card("story-ex9002", { feature: "busca-no-catalogo" }),
    card("story-ex9003", { feature: "funcionalidade-que-sumiu" }),
    card("story-ex9004", { serves: "story-ex9002" }),
    card("story-ex9005", { status: "concluida" }),
    card("story-ex9006", { capture: true }),
    card("step-ex9007", { type: "step" } as Partial<Card>),
  ];
  it("pega o sem funcionalidade e o de id que sumiu do PRD; quem herda pelo `serves` já tem dono; nó do mapa e captura ficam fora", () => {
    expect(anchorCandidates(cards, CONFIG, FEATURES, false).map((c) => c.id)).toEqual(["story-ex9001", "story-ex9003"]);
  });
  it("os terminais só entram na primeira passada (o «Feito» da página)", () => {
    expect(anchorCandidates(cards, CONFIG, FEATURES, true).map((c) => c.id)).toEqual(["story-ex9001", "story-ex9003", "story-ex9005"]);
  });
  it("board sem funcionalidades no PRD ⇒ nada", () => {
    expect(anchorCandidates(cards, CONFIG, [], true)).toEqual([]);
  });
});

describe("decideAnchorRun — o gatilho", () => {
  const cards = [card("story-ex9001"), card("story-ex9002")];
  const hash = featuresHashOf(FEATURES);
  const base = (over: Partial<FeatureAnchorBoardState> = {}): FeatureAnchorBoardState => ({ attempted: [], featuresHash: hash, anchoredOnce: true, lastRunAt: new Date(NOW - 60_000).toISOString(), ...over });

  it("sem funcionalidades no PRD não roda", () => {
    expect(decideAnchorRun({ state: undefined, features: [], cards, config: CONFIG, now: NOW, running: false })).toMatchObject({ action: "skip", why: "no-features" });
  });

  it("primeira passada (sem estado): roda já, com os cards sem funcionalidade", () => {
    const d = decideAnchorRun({ state: undefined, features: FEATURES, cards, config: CONFIG, now: NOW, running: false });
    expect(d).toMatchObject({ action: "run", firstPass: true, cardIds: ["story-ex9001", "story-ex9002"] });
    expect(d.state.featuresHash).toBe(hash);
  });

  it("depois da primeira passada: espera 6 h desde a última execução", () => {
    expect(decideAnchorRun({ state: base(), features: FEATURES, cards, config: CONFIG, now: NOW, running: false })).toMatchObject({ action: "skip", why: "not-due" });
    const late = base({ lastRunAt: new Date(NOW - ANCHOR_INTERVAL_MS).toISOString() });
    expect(decideAnchorRun({ state: late, features: FEATURES, cards, config: CONFIG, now: NOW, running: false })).toMatchObject({ action: "run", firstPass: false });
  });

  it("o PRD mudou (hash): roda já e `attempted` zera", () => {
    const d = decideAnchorRun({ state: base({ featuresHash: "antigo", attempted: ["story-ex9001", "story-ex9002"] }), features: FEATURES, cards, config: CONFIG, now: NOW, running: false });
    expect(d).toMatchObject({ action: "run", cardIds: ["story-ex9001", "story-ex9002"] });
    expect(d.state.attempted).toEqual([]);
  });

  it("os já tentados não voltam; sem nada novo, nada roda", () => {
    const d = decideAnchorRun({ state: base({ attempted: ["story-ex9001", "story-ex9002"], lastRunAt: undefined }), features: FEATURES, cards, config: CONFIG, now: NOW, running: false });
    expect(d).toMatchObject({ action: "skip", why: "nothing" });
  });

  it("a primeira passada termina quando não sobra nada a tentar (desliga a ponte do Kanban)", () => {
    const d = decideAnchorRun({ state: base({ anchoredOnce: false, attempted: ["story-ex9001", "story-ex9002"] }), features: FEATURES, cards, config: CONFIG, now: NOW, running: false });
    expect(d).toMatchObject({ action: "skip", why: "nothing" });
    expect(d.state.anchoredOnce).toBe(true);
  });

  it("no máximo uma sessão por board: viva ⇒ espera", () => {
    expect(decideAnchorRun({ state: undefined, features: FEATURES, cards, config: CONFIG, now: NOW, running: true })).toMatchObject({ action: "skip", why: "running" });
  });

  it("uma execução que falhou segura a próxima pelo recuo (a primeira passada não vira laço de falhas)", () => {
    const failed = base({ anchoredOnce: false, lastFailedAt: new Date(NOW - 60_000).toISOString() });
    expect(decideAnchorRun({ state: failed, features: FEATURES, cards, config: CONFIG, now: NOW, running: false })).toMatchObject({ action: "skip", why: "backoff" });
    expect(decideAnchorRun({ state: failed, features: FEATURES, cards, config: CONFIG, now: NOW + ANCHOR_FAILURE_BACKOFF_MS, running: false })).toMatchObject({ action: "run" });
  });

  it(`no máximo ${ANCHOR_CARDS_PER_RUN} cards por prompt, os não terminais primeiro`, () => {
    const many = [card("story-ex9100", { status: "concluida" }), ...Array.from({ length: 40 }, (_, i) => card(`story-ex92${String(i).padStart(2, "0")}`))];
    const d = decideAnchorRun({ state: undefined, features: FEATURES, cards: many, config: CONFIG, now: NOW, running: false });
    if (d.action !== "run") throw new Error("devia rodar");
    expect(d.cardIds).toHaveLength(ANCHOR_CARDS_PER_RUN);
    expect(d.cardIds).not.toContain("story-ex9100");
  });
});

describe("settleAnchorRun — o desfecho", () => {
  const state: FeatureAnchorBoardState = { attempted: ["story-ex9009"], featuresHash: "h", anchoredOnce: false, running: { since: "x" } };
  it("quem segue sem funcionalidade entra em `attempted`, menos o que a sessão deixou para depois; o `running` sai", () => {
    const s = settleAnchorRun(state, {
      cardIds: ["story-ex9001", "story-ex9002", "story-ex9003"],
      stillUnanchored: new Set(["story-ex9002", "story-ex9003"]),
      now: NOW,
      ok: true,
      costUSD: 0.31,
      verdict: { outros: ["story-ex9002"], depois: ["story-ex9003"] },
    });
    expect(s.attempted.sort()).toEqual(["story-ex9002", "story-ex9009"]);
    expect(s.running).toBeUndefined();
    expect(s.lastRun).toMatchObject({ cards: 3, anchored: 1, costUSD: 0.31, outcome: "ok" });
  });
  it("uma falha não marca ninguém e arma o recuo", () => {
    const s = settleAnchorRun(state, { cardIds: ["story-ex9001"], stillUnanchored: new Set(["story-ex9001"]), now: NOW, ok: false, costUSD: 0 });
    expect(s.attempted).toEqual(["story-ex9009"]);
    expect(s.lastFailedAt).toBe(new Date(NOW).toISOString());
  });
});

describe("anchorAnswers — a resposta do dono", () => {
  const q = (over: Partial<CardQuestion>): CardQuestion => ({
    id: "q1",
    text: "Em qual funcionalidade fica este item?",
    status: "answered",
    askedBy: ANCHOR_ASKED_BY,
    options: [
      { id: "o1", label: "Busca no catálogo" },
      { id: "o2", label: ANCHOR_LEAVE_OPTION },
    ],
    ...over,
  }) as CardQuestion;
  const host = (questions: CardQuestion[]) => card("story-ex9001", { questions });

  it("a opção com o NOME de uma funcionalidade liga o card que a pergunta cita (o `(card <id>)` do contexto)", () => {
    const got = anchorAnswers([host([q({ selectedOptionIds: ["o1"], context: "[humano] O item fala de filtros. (card story-ex9004)" })])], FEATURES, new Set());
    expect(got).toEqual([{ key: "story-ex9001:q1", cardId: "story-ex9004", featureId: "busca-no-catalogo" }]);
  });
  it("«Deixar em Outros» ⇒ null; resposta livre ⇒ sem funcionalidade (a próxima execução lê); já aplicada ⇒ some", () => {
    const cards = [host([q({ id: "q1", selectedOptionIds: ["o2"] }), q({ id: "q2", selectedOptionIds: [], answer: "depende do frete" }), q({ id: "q3", status: "open" })])];
    expect(anchorAnswers(cards, FEATURES, new Set())).toEqual([
      { key: "story-ex9001:q1", cardId: "story-ex9001", featureId: null },
      { key: "story-ex9001:q2", cardId: "story-ex9001" },
    ]);
    expect(anchorAnswers(cards, FEATURES, new Set(["story-ex9001:q1", "story-ex9001:q2"]))).toEqual([]);
  });
  it("só as perguntas da âncora", () => {
    expect(anchorAnswers([host([q({ askedBy: "harness-grill", selectedOptionIds: ["o1"] })])], FEATURES, new Set())).toEqual([]);
  });
  it("a resposta re-arma o card: ligado ou livre sai de `attempted`; «Outros» fica", () => {
    const s = applyAnswersToState({ attempted: ["story-ex9001", "story-ex9002"], featuresHash: "h", anchoredOnce: true }, [
      { key: "a:q1", cardId: "story-ex9001", featureId: "busca-no-catalogo" },
      { key: "a:q2", cardId: "story-ex9002" },
      { key: "a:q3", cardId: "story-ex9003", featureId: null },
    ]);
    expect(s.attempted.sort()).toEqual(["story-ex9003"]);
    expect(s.appliedAnswers).toEqual(["a:q1", "a:q2", "a:q3"]);
  });
});

describe("runningStillLive", () => {
  it("vale com o pid vivo dentro do relógio; pid morto ou velho demais ⇒ não", () => {
    const since = new Date(NOW - 60_000).toISOString();
    expect(runningStillLive({ since, pid: 7 }, NOW, () => true)).toBe(true);
    expect(runningStillLive({ since, pid: 7 }, NOW, () => false)).toBe(false);
    expect(runningStillLive({ since: new Date(NOW - 3 * 60 * 60_000).toISOString(), pid: 7 }, NOW, () => true)).toBe(false);
    expect(runningStillLive(undefined, NOW, () => true)).toBe(false);
  });
});

describe("runFeatureAnchorTick — a passada (deps injetadas)", () => {
  function harness(over: Partial<FeatureAnchorDeps> = {}, cards: Card[] = [card("story-ex9001"), card("story-ex9002")]) {
    let file: FeatureAnchorFile = { v: 1, boards: {} };
    const spawned: AnchorRunInput[] = [];
    const applied: Array<[string, string]> = [];
    const deps: FeatureAnchorDeps = {
      now: () => NOW,
      masterEnabled: () => true,
      capacityHeld: () => false,
      boards: async () => ["livraria"],
      boardData: async () => ({ config: CONFIG, cards, features: FEATURES, draftPending: false }),
      applyFeature: async (_b, cardId, featureId) => {
        applied.push([cardId, featureId]);
        const c = cards.find((x) => x.id === cardId);
        if (c) c.feature = featureId;
        return true;
      },
      spawn: async (input, onStart) => {
        spawned.push(input);
        onStart(4242);
        // a sessão liga o primeiro card
        const c = cards.find((x) => x.id === input.cards[0]?.id);
        if (c) c.feature = "busca-no-catalogo";
        return { ok: true, costUSD: 0.2, pid: 4242, verdict: { outros: [], depois: [] } };
      },
      pidAlive: () => false,
      store: { load: async () => file, save: async (f) => void (file = f) },
      log: () => {},
      ...over,
    };
    return { deps, spawned, applied, state: () => file.boards.livraria };
  }

  it("abre UMA sessão e, no fim, marca o que sobrou como tentado", async () => {
    const h = harness();
    const r = await runFeatureAnchorTick(h.deps);
    const run = r.find((x) => x.action === "spawned");
    expect(run?.cardIds).toEqual(["story-ex9001", "story-ex9002"]);
    await run?.done;
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].firstPass).toBe(true);
    expect(h.state()?.attempted).toEqual(["story-ex9002"]);
    expect(h.state()?.running).toBeUndefined();
    expect(h.state()?.lastRun).toMatchObject({ anchored: 1, outcome: "ok" });
  });

  it("interruptor geral desligado ⇒ nada; cota segurando ⇒ não abre sessão", async () => {
    const off = harness({ masterEnabled: () => false });
    expect(await runFeatureAnchorTick(off.deps)).toEqual([]);
    const held = harness({ capacityHeld: () => true });
    expect(await runFeatureAnchorTick(held.deps)).toEqual([{ board: "livraria", action: "skipped", why: "capacity" }]);
    expect(held.spawned).toEqual([]);
  });

  it("a resposta do dono que nomeia uma funcionalidade é gravada pelo SERVIÇO antes da decisão", async () => {
    const asked = card("story-ex9001", {
      feature: "busca-no-catalogo",
      questions: [
        {
          id: "q1",
          text: "Em qual funcionalidade fica este item?",
          status: "answered",
          askedBy: ANCHOR_ASKED_BY,
          context: "[humano] Um item sem lugar. (card story-ex9002)",
          options: [{ id: "o1", label: "Lista de desejos" }],
          selectedOptionIds: ["o1"],
        } as CardQuestion,
      ],
    });
    const h = harness({}, [asked, card("story-ex9002")]);
    const r = await runFeatureAnchorTick(h.deps);
    expect(h.applied).toEqual([["story-ex9002", "lista-de-desejos"]]);
    expect(r[0]).toMatchObject({ action: "answers-applied", cardIds: ["story-ex9002"] });
    // nada mais sem funcionalidade: a primeira passada termina sem sessão
    expect(h.spawned).toEqual([]);
    expect(h.state()?.anchoredOnce).toBe(true);
  });

  it("um `running` gravado de uma sessão viva segura o board (restart no meio)", async () => {
    const h = harness({ pidAlive: () => true });
    await h.deps.store.save({ v: 1, boards: { livraria: { attempted: [], featuresHash: featuresHashOf(FEATURES), anchoredOnce: false, running: { since: new Date(NOW - 60_000).toISOString(), pid: 99 } } } });
    const r = await runFeatureAnchorTick(h.deps);
    expect(r).toEqual([{ board: "livraria", action: "skipped", why: "running" }]);
    expect(h.spawned).toEqual([]);
  });
});
