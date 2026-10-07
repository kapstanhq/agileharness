// The board VIEW in lanes — the pure placement + the lint. Each case is a promise the owner relies on:
//   • absent `view.lanes` ⇒ no lane view at all (the legacy Kanban renders, byte-identical);
//   • every card lands somewhere — an unmapped/unknown status goes to a VISIBLE "Outros", never nowhere;
//   • the owner's lane holds EXACTLY the Inbox's Decidir, in the Inbox's order, whatever the status — and no status
//     pulls a card into it (a lane that counts by status drifts from Decidir);
//   • a map that is wrong says so in words (unmapped, duplicated, unknown, two demand lanes, statuses in the owner's
//     lane — the map a board used to carry).
//
// Reescrito de propósito (WP4-B): os casos «a pergunta aberta puxa o card para a raia do dono pelo cardDemands» e
// «`integrando`/`publicando` por status» travavam exatamente o comportamento que o diagnóstico posterior mandou mudar.

import { beforeAll, describe, expect, it } from "vitest";
import {
  boardLanes,
  groupStoriesByLane,
  LANE_OTHERS_ID,
  laneOfCard,
  laneViewProblems,
  type ResolvedLane, LANE_DEFERRED_ID } from "./lanes";
import { readBoardConfig } from "./repo";
import { FIXTURE_BOARD } from "./board-fixture";
import type { OwnerDecisions } from "./inbox/decidir-set";
import type { BoardConfig, Card, LaneDef } from "./types";

// The old-style map: the owner's lane listing fixed statuses. The lint must accuse it.
const OLD_MAP: LaneDef[] = [
  { id: "chegada", label: "Chegada", statuses: ["capturando", "triage", "grill", "descontinuar"] },
  { id: "risco", label: "Risco", statuses: ["enriquecer", "interview", "design-ux", "design-ui", "com-design", "refinar", "corrigir"] },
  { id: "dono", label: "Com o dono", statuses: ["pronta", "stage", "deploy"], demand: true },
  { id: "mesa", label: "Mesa", statuses: ["ready", "plano-tecnico", "desenvolver", "revisar-codigo", "qa-automatizado", "revisao", "merge", "release", "concluida"] },
];

// The map that mirrors the invariant: the owner's lane status-free (anywhere in the row), every status in one ordinary lane.
const NEW_MAP: LaneDef[] = [
  { id: "fila", label: "Fila", statuses: ["capturando", "triage", "grill", "descontinuar"] },
  { id: "dono", label: "Com o dono", statuses: [], demand: true },
  { id: "forma", label: "Forma", statuses: ["pronta", "enriquecer", "interview", "design-ux", "design-ui", "com-design", "refinar"] },
  { id: "bancada", label: "Bancada", statuses: ["ready", "plano-tecnico", "desenvolver", "corrigir"] },
  { id: "prova", label: "Prova", statuses: ["revisar-codigo", "qa-automatizado", "revisao", "merge"] },
  { id: "envio", label: "Envio", statuses: ["stage", "deploy", "release", "concluida"] },
];
let base: BoardConfig;
beforeAll(async () => {
  base = await readBoardConfig(FIXTURE_BOARD);
});
const withLanes = (lanes: LaneDef[]): BoardConfig => ({ ...base, view: { lanes } });

const story = (id: string, status: string | null, extra: Partial<Card> = {}): Card =>
  ({
    id,
    type: "story",
    title: id,
    storyType: "user",
    status,
    parent: "step-x",
    release: null,
    personas: [],
    systems: [],
    links: [],
    acceptance: [],
    tasks: [],
    body: "",
    order: 0,
    created: "2026-09-25",
    updated: "2026-09-25",
    ...extra,
  }) as Card;

/** The Inbox's Decidir of a board, as decidir-set.ts would hand it (cards in the Inbox's order). */
const owner = (ids: string[], extra: { total?: number; more?: Record<string, number> } = {}): OwnerDecisions => ({
  boardId: "demo",
  total: extra.total ?? ids.length + Object.values(extra.more ?? {}).reduce((n, k) => n + k, 0),
  cards: ids.map((cardId, rank) => ({ cardId, itemId: `${cardId}:x`, what: "Decidir", rank, more: extra.more?.[cardId] ?? 0, primary: null })),
});

describe("boardLanes — a vista só existe quando declarada", () => {
  it("sem `view.lanes` ⇒ null (o mapa de raias não é inventado aqui; o Kanban deriva as raias das colunas — kanban-features `kanbanLanes`)", () => {
    // O board de demonstração HERDA as seis raias do `_base` (fase 1) — a ausência é provada tirando a vista dele.
    expect(boardLanes({ ...base, view: undefined })).toBeNull();
    expect(boardLanes({ ...base, view: {} })).toBeNull();
    expect(boardLanes({ ...base, view: { lanes: [] } })).toBeNull();
  });

  it("a raia do dono (`demand`, verdadeiro OU lista) nunca carrega status; uma segunda raia de demanda vira raia comum", () => {
    const lanes = boardLanes(withLanes([
      { id: "a", label: "A", statuses: ["revisao"], demand: true },
      { id: "b", label: "B", statuses: ["desenvolver"], demand: ["blocker"] },
      { id: "c", label: "C", statuses: [] },
    ]))!;
    expect(lanes.map((l) => [l.id, l.demand, l.statuses])).toEqual([
      ["a", true, []],
      ["b", false, ["desenvolver"]],
      ["c", false, []],
    ]);
  });
});

describe("laneViewProblems — o mapa torto se explica em palavras", () => {
  it("o mapa novo (raia do dono sem status) cobre o pipeline canônico sem nenhum problema", () => {
    expect(laneViewProblems(withLanes(NEW_MAP))).toEqual([]);
  });

  it("o mapa antigo é acusado: cada status da raia do dono é nomeado, com o destino dos cards e a passagem do sistema", () => {
    const problems = laneViewProblems(withLanes(OLD_MAP));
    expect(problems).toHaveLength(3);
    for (const id of ["pronta", "stage", "deploy"]) {
      expect(problems.join("\n")).toMatch(new RegExp(`ignora status: os cards em '${id}'.*Outros`));
    }
    // publicar é passo da entrega — o sistema o conduz; «pronta» não
    expect(problems.find((p) => p.includes("'deploy'"))).toMatch(/passo que o sistema conduz/);
    expect(problems.find((p) => p.includes("'pronta'"))).not.toMatch(/sistema conduz/);
  });

  it("uma lista de tipos em `demand` é acusada: a raia do dono é o Decidir inteiro", () => {
    const lanes = NEW_MAP.map((l) => (l.id === "dono" ? { ...l, demand: ["question" as const] } : l));
    expect(laneViewProblems(withLanes(lanes)).join("\n")).toMatch(/lista tipos em `demand` \(question\).*use `demand: true`/);
  });

  it("board sem vista ⇒ nenhum problema (nada a validar)", () => {
    expect(laneViewProblems(base)).toEqual([]);
  });

  it("status sem raia é nomeado, com o destino dos cards ('Outros')", () => {
    const lanes = NEW_MAP.map((l) => (l.id === "envio" ? { ...l, statuses: l.statuses.filter((s) => s !== "concluida") } : l));
    const problems = laneViewProblems(withLanes(lanes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/'concluida'.*nenhuma raia.*Outros/);
  });

  it("status em duas raias, status inexistente, id repetido/reservado e duas raias de demanda", () => {
    const lanes: LaneDef[] = [
      ...NEW_MAP.map((l) => (l.id === "bancada" ? { ...l, statuses: [...l.statuses, "revisao", "fantasma"] } : l)),
      { id: "envio", label: "Dup", statuses: [] },
      { id: LANE_OTHERS_ID, label: "Reservada", statuses: [], demand: ["blocker"] },
    ];
    const problems = laneViewProblems(withLanes(lanes)).join("\n");
    expect(problems).toMatch(/'revisao' está em 2 raias \(Bancada, Prova\)/);
    expect(problems).toMatch(/'fantasma'.*não existe/);
    expect(problems).toMatch(/duas raias com o id 'envio'/);
    expect(problems).toMatch(/id reservado/);
    expect(problems).toMatch(/2 raias puxam por demanda/);
  });

  it("os terminais de ARQUIVO não precisam de raia (nunca aparecem no Kanban)", () => {
    const problems = laneViewProblems(withLanes(NEW_MAP)).join("\n");
    for (const archived of ["arquivados", "duplicado", "cancelado", "capturado"]) expect(problems).not.toMatch(archived);
  });
});

describe("laneOfCard / groupStoriesByLane — todo card em UMA raia, nada some", () => {
  it("cada status vai para a raia que o declara; a raia do dono nunca recebe por status", () => {
    const lanes = boardLanes(withLanes(NEW_MAP))!;
    const none = new Set<string>();
    expect(laneOfCard({ id: "a", status: "triage" }, lanes, none)).toBe("fila");
    expect(laneOfCard({ id: "a", status: "com-design" }, lanes, none)).toBe("forma");
    expect(laneOfCard({ id: "a", status: "revisao" }, lanes, none)).toBe("prova");
    expect(laneOfCard({ id: "a", status: "desenvolver" }, lanes, none)).toBe("bancada");
    expect(laneOfCard({ id: "a", status: "release" }, lanes, none)).toBe("envio");
    expect(laneOfCard({ id: "a", status: "concluida" }, lanes, none)).toBe("envio");
    // no mapa antigo, um status listado na raia do dono SEM decisão cai em Outros (visível), nunca na raia do dono
    expect(laneOfCard({ id: "a", status: "deploy" }, boardLanes(withLanes(OLD_MAP))!, none)).toBe(LANE_OTHERS_ID);
  });

  it("status desconhecido / ausente / sem raia cai em 'Outros', que só aparece quando tem card", () => {
    const cfg = withLanes(NEW_MAP.map((l) => (l.id === "envio" ? { ...l, statuses: l.statuses.filter((s) => s !== "concluida") } : l)));
    const lanes = boardLanes(cfg)!;
    const empty = groupStoriesByLane([story("a", "triage")], lanes);
    expect(empty.lanes.map((l) => l.id)).not.toContain(LANE_OTHERS_ID);

    const { lanes: shown, byLane } = groupStoriesByLane(
      [story("a", "triage"), story("b", "status-futuro"), story("c", null), story("d", "concluida")],
      lanes,
    );
    expect(shown.at(-1)).toMatchObject({ id: LANE_OTHERS_ID, label: "Outros", others: true });
    expect(byLane.get(LANE_OTHERS_ID)!.map((c) => c.id).sort()).toEqual(["b", "c", "d"]);
    // conservação: nenhum card some e nenhum aparece duas vezes
    const all = [...byLane.values()].flat().map((c) => c.id).sort();
    expect(all).toEqual(["a", "b", "c", "d"]);
  });

  it("A REGRA DO DONO: só o Decidir do Inbox entra na raia, na ordem do Inbox, em qualquer status", () => {
    const lanes = boardLanes(withLanes(NEW_MAP))!;
    const asked = { questions: [{ id: "q1", text: "Qual público?", status: "open" as const }] };
    const { byLane, outside } = groupStoriesByLane(
      [
        story("obra-decidir", "desenvolver"),
        story("pergunta-que-o-proxy-responde", "grill", asked),
        story("entrega-decidir", "release"),
        story("entrega-do-sistema", "release"),
      ],
      lanes,
      { owner: owner(["entrega-decidir", "obra-decidir"]) },
    );
    // a ordem é a do Inbox (a mais urgente primeiro), não a do arquivo
    expect(byLane.get("dono")!.map((c) => c.id)).toEqual(["entrega-decidir", "obra-decidir"]);
    // a pergunta aberta que NÃO está em Decidir (o proxy responde) fica onde o status a põe
    expect(byLane.get("fila")!.map((c) => c.id)).toEqual(["pergunta-que-o-proxy-responde"]);
    expect(byLane.get("envio")!.map((c) => c.id)).toEqual(["entrega-do-sistema"]);
    expect(outside).toBe(0);
  });

  it("o que Decidir conta e a raia não mostra é DITO: |raia| + segundas decisões + fora do quadro = o número do Inbox", () => {
    const lanes = boardLanes(withLanes(NEW_MAP))!;
    // 5 em Decidir: 2 cards no quadro (um deles com uma 2ª decisão), 1 card que o Kanban não mostra, 1 proposta sem card
    const d = owner(["a", "arquivado"], { total: 5, more: { a: 1 } });
    const { byLane, outside } = groupStoriesByLane([story("a", "desenvolver"), story("b", "triage")], lanes, { owner: d });
    expect(byLane.get("dono")!.map((c) => c.id)).toEqual(["a"]);
    expect(byLane.get("dono")!.length + 1 + outside).toBe(d.total);
    expect(outside).toBe(3);
  });

  it("sem o Decidir (o Inbox ilegível) a raia do dono fica vazia — nunca volta a adivinhar por status", () => {
    const lanes = boardLanes(withLanes(OLD_MAP))!;
    const { byLane } = groupStoriesByLane([story("x", "revisao", { questions: [{ id: "q", text: "?", status: "open" }] })], lanes, { owner: null });
    expect(byLane.get("dono")).toEqual([]);
  });

  it("sem raia do dono, o Decidir não move o card (o status decide sozinho)", () => {
    const lanes: ResolvedLane[] = boardLanes(withLanes(NEW_MAP.filter((l) => l.id !== "dono")))!;
    const { byLane } = groupStoriesByLane([story("q", "desenvolver")], lanes, { owner: owner(["q"]) });
    expect(byLane.get("bancada")!.map((c) => c.id)).toEqual(["q"]);
  });
});

describe("«Adiado — não agora» tem a sua faixa", () => {
  const lanes = [
    { id: "a", label: "A", statuses: ["triage"], demand: false },
    { id: "b", label: "B", statuses: ["enriquecer"], demand: false },
  ];
  const c = (id: string, status: string, deferred = false) => ({ id, type: "story", status, ...(deferred ? { deferred: { reason: "x", since: "2026-10-02", by: "human" } } : {}) }) as unknown as Card;

  it("o adiado sai da raia do status e vai para a faixa sintética", () => {
    const g = groupStoriesByLane([c("1", "triage"), c("2", "enriquecer", true), c("3", "enriquecer")], lanes as never);
    expect(g.byLane.get("a")!.map((x) => x.id)).toEqual(["1"]);
    expect(g.byLane.get("b")!.map((x) => x.id)).toEqual(["3"]);
    expect(g.byLane.get(LANE_DEFERRED_ID)!.map((x) => x.id)).toEqual(["2"]);
    const lane = g.lanes.find((l) => l.id === LANE_DEFERRED_ID)!;
    expect(lane).toMatchObject({ deferred: true, others: true, demand: false });
  });

  it("sem nenhum adiado a faixa nem existe", () => {
    expect(groupStoriesByLane([c("1", "triage")], lanes as never).lanes.map((l) => l.id)).toEqual(["a", "b"]);
  });
});

// A aprovação da entrega espera o dono: uma raia cujo rótulo promete o sistema não pode listá-la (o card parado ali
// apareceria sob uma promessa de automação). Rótulo neutro não é acusado.
describe("laneViewProblems — a raia cujo rótulo promete o sistema não lista a aprovação da entrega", () => {
  const withDelivery = (lanes: LaneDef[]): BoardConfig => ({
    ...withLanes(lanes),
    statuses: base.statuses.map((s) => (s.id === "revisao" ? { ...s, gate: "hasQaPassed", autorun: false } : s)),
  });
  it("rótulo que promete o sistema + aprovação da entrega ⇒ acusado, nomeando o passo", () => {
    const lanes = NEW_MAP.map((l) => (l.id === "prova" ? { ...l, label: "Bancada do sistema" } : l));
    const problems = laneViewProblems(withDelivery(lanes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/'Bancada do sistema' promete o sistema.*'revisao'.*espera o dono/);
  });
  it("rótulo neutro com a mesma lista ⇒ nada", () => {
    expect(laneViewProblems(withDelivery(NEW_MAP))).toEqual([]);
  });
  it("rótulo que promete o sistema SEM a aprovação da entrega ⇒ nada", () => {
    const lanes = NEW_MAP.map((l) => (l.id === "envio" ? { ...l, label: "Envio · automático" } : l));
    expect(laneViewProblems(withDelivery(lanes))).toEqual([]);
  });
});
