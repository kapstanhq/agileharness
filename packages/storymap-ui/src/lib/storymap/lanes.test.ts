// The board VIEW in lanes — the pure placement + the lint. Each case is a promise the owner relies on:
//   • absent `view.lanes` ⇒ no lane view at all (the legacy Kanban renders, byte-identical);
//   • every card lands somewhere — an unmapped/unknown status goes to a VISIBLE "Outros", never nowhere;
//   • the owner's lane holds EXACTLY the Inbox's Decidir, in the Inbox's order, whatever the status — and no status
//     pulls a card into it (a lane that counted by status once showed more cards than Decidir did);
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
  laneDropStatus,
  laneOfCard,
  laneSections,
  laneStatusTags,
  laneViewProblems,
  type ResolvedLane, LANE_DEFERRED_ID } from "./lanes";
import { readBoardConfig } from "./repo";
import { FIXTURE_BOARD } from "./board-fixture";
import type { OwnerDecisions } from "./inbox/decidir-set";
import type { CardLiveKind } from "./card-live-status";
import type { BoardConfig, Card, LaneDef } from "./types";

// The old-style map: the owner's lane listing four fixed statuses. The lint must accuse it.
const OLD_MAP: LaneDef[] = [
  { id: "entrada", label: "Entrada", statuses: ["capturando", "triage", "priorizar", "pronta", "grill"] },
  { id: "desenho", label: "Desenho", statuses: ["enriquecer", "interview", "design-ux", "design-ui", "refinar", "corrigir", "descontinuar"] },
  { id: "obra", label: "Obra", statuses: ["plano-tecnico", "desenvolver", "revisar-codigo"] },
  { id: "voce", label: "Precisa de você", statuses: ["ready", "com-design", "revisao", "release"], demand: true },
  { id: "conferencia", label: "Conferência", statuses: ["qa-automatizado", "merge", "stage", "deploy"] },
  { id: "feito", label: "Feito", statuses: ["concluida"] },
];

// The map that mirrors the invariant: the owner's lane first and status-free, the delivery steps in their own lane.
const NEW_MAP: LaneDef[] = [
  { id: "voce", label: "Precisa de você", statuses: [], demand: true },
  { id: "entrada", label: "Entrada", statuses: ["capturando", "triage", "descontinuar"] },
  { id: "preparo", label: "Preparo", statuses: ["priorizar", "pronta", "enriquecer", "interview"] },
  { id: "desenho", label: "Desenho", statuses: ["grill", "design-ux", "design-ui", "com-design", "refinar"] },
  { id: "obra", label: "Obra", statuses: ["ready", "plano-tecnico", "desenvolver", "corrigir"] },
  { id: "conferencia", label: "Conferência", statuses: ["revisar-codigo", "qa-automatizado"] },
  { id: "saida", label: "Saída automática", statuses: ["revisao", "merge", "stage", "release", "deploy"] },
  { id: "feito", label: "Feito", statuses: ["concluida"] },
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
  it("sem `view.lanes` ⇒ null (o Kanban legado renderiza intacto)", () => {
    expect(boardLanes(base)).toBeNull();
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
  it("o mapa novo (dono primeiro e sem status, entrega à parte) cobre o pipeline canônico sem nenhum problema", () => {
    expect(laneViewProblems(withLanes(NEW_MAP))).toEqual([]);
  });

  it("o mapa antigo é acusado: cada status da raia do dono é nomeado, com o destino dos cards e a passagem do sistema", () => {
    const problems = laneViewProblems(withLanes(OLD_MAP));
    expect(problems).toHaveLength(4);
    for (const id of ["com-design", "ready", "revisao", "release"]) {
      expect(problems.join("\n")).toMatch(new RegExp(`ignora status: os cards em '${id}'.*Outros`));
    }
    // revisão e liberação são passos da entrega — o sistema os conduz
    expect(problems.find((p) => p.includes("'release'"))).toMatch(/passo que o sistema conduz/);
    expect(problems.find((p) => p.includes("'ready'"))).not.toMatch(/sistema conduz/);
  });

  it("uma lista de tipos em `demand` é acusada: a raia do dono é o Decidir inteiro", () => {
    const lanes = NEW_MAP.map((l) => (l.id === "voce" ? { ...l, demand: ["question" as const] } : l));
    expect(laneViewProblems(withLanes(lanes)).join("\n")).toMatch(/lista tipos em `demand` \(question\).*use `demand: true`/);
  });

  it("board sem vista ⇒ nenhum problema (nada a validar)", () => {
    expect(laneViewProblems(base)).toEqual([]);
  });

  it("status sem raia é nomeado, com o destino dos cards ('Outros')", () => {
    const lanes = NEW_MAP.map((l) => (l.id === "feito" ? { ...l, statuses: [] } : l));
    const problems = laneViewProblems(withLanes(lanes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/'concluida'.*nenhuma raia.*Outros/);
  });

  it("status em duas raias, status inexistente, id repetido/reservado e duas raias de demanda", () => {
    const lanes: LaneDef[] = [
      ...NEW_MAP.map((l) => (l.id === "obra" ? { ...l, statuses: [...l.statuses, "revisao", "fantasma"] } : l)),
      { id: "feito", label: "Dup", statuses: [] },
      { id: LANE_OTHERS_ID, label: "Reservada", statuses: [], demand: ["blocker"] },
    ];
    const problems = laneViewProblems(withLanes(lanes)).join("\n");
    expect(problems).toMatch(/'revisao' está em 2 raias \(Obra, Saída automática\)/);
    expect(problems).toMatch(/'fantasma'.*não existe/);
    expect(problems).toMatch(/duas raias com o id 'feito'/);
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
    expect(laneOfCard({ id: "a", status: "triage" }, lanes, none)).toBe("entrada");
    expect(laneOfCard({ id: "a", status: "com-design" }, lanes, none)).toBe("desenho");
    expect(laneOfCard({ id: "a", status: "revisao" }, lanes, none)).toBe("saida");
    expect(laneOfCard({ id: "a", status: "desenvolver" }, lanes, none)).toBe("obra");
    expect(laneOfCard({ id: "a", status: "release" }, lanes, none)).toBe("saida");
    expect(laneOfCard({ id: "a", status: "concluida" }, lanes, none)).toBe("feito");
    // no mapa antigo, um status listado na raia do dono SEM decisão cai em Outros (visível), nunca na raia do dono
    expect(laneOfCard({ id: "a", status: "release" }, boardLanes(withLanes(OLD_MAP))!, none)).toBe(LANE_OTHERS_ID);
  });

  it("status desconhecido / ausente / sem raia cai em 'Outros', que só aparece quando tem card", () => {
    const cfg = withLanes(NEW_MAP.map((l) => (l.id === "feito" ? { ...l, statuses: [] } : l)));
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
    expect(byLane.get("voce")!.map((c) => c.id)).toEqual(["entrega-decidir", "obra-decidir"]);
    // a pergunta aberta que NÃO está em Decidir (o proxy responde) fica onde o status a põe
    expect(byLane.get("desenho")!.map((c) => c.id)).toEqual(["pergunta-que-o-proxy-responde"]);
    expect(byLane.get("saida")!.map((c) => c.id)).toEqual(["entrega-do-sistema"]);
    expect(outside).toBe(0);
  });

  it("o que Decidir conta e a raia não mostra é DITO: |raia| + segundas decisões + fora do quadro = o número do Inbox", () => {
    const lanes = boardLanes(withLanes(NEW_MAP))!;
    // 5 em Decidir: 2 cards no quadro (um deles com uma 2ª decisão), 1 card que o Kanban não mostra, 1 proposta sem card
    const d = owner(["a", "arquivado"], { total: 5, more: { a: 1 } });
    const { byLane, outside } = groupStoriesByLane([story("a", "desenvolver"), story("b", "triage")], lanes, { owner: d });
    expect(byLane.get("voce")!.map((c) => c.id)).toEqual(["a"]);
    expect(byLane.get("voce")!.length + 1 + outside).toBe(d.total);
    expect(outside).toBe(3);
  });

  it("sem o Decidir (o Inbox ilegível) a raia do dono fica vazia — nunca volta a adivinhar por status", () => {
    const lanes = boardLanes(withLanes(OLD_MAP))!;
    const { byLane } = groupStoriesByLane([story("x", "revisao", { questions: [{ id: "q", text: "?", status: "open" }] })], lanes, { owner: null });
    expect(byLane.get("voce")).toEqual([]);
  });

  it("sem raia do dono, o Decidir não move o card (o status decide sozinho)", () => {
    const lanes: ResolvedLane[] = boardLanes(withLanes(NEW_MAP.filter((l) => l.id !== "voce")))!;
    const { byLane } = groupStoriesByLane([story("q", "desenvolver")], lanes, { owner: owner(["q"]) });
    expect(byLane.get("obra")!.map((c) => c.id)).toEqual(["q"]);
  });
});

describe("laneDropStatus / laneStatusTags", () => {
  it("soltar numa raia = o primeiro status visível dela (o gate ainda decide); 'Outros' e a raia do dono não aceitam", () => {
    const cfg = withLanes(NEW_MAP);
    const lanes = boardLanes(cfg)!;
    expect(laneDropStatus(lanes.find((l) => l.id === "entrada")!, cfg)).toBe("triage"); // capturando é oculto
    expect(laneDropStatus(lanes.find((l) => l.id === "obra")!, cfg)).toBe("ready");
    expect(laneDropStatus(lanes.find((l) => l.id === "voce")!, cfg)).toBeNull();
    expect(laneDropStatus({ id: LANE_OTHERS_ID, label: "Outros", statuses: [], demand: false, others: true }, cfg)).toBeNull();
  });

  it("a etiqueta é só o status REAL — o que acontece agora é a linha viva do card, não um rótulo fixo por status", () => {
    expect(laneStatusTags({ status: "release" }, base)).toEqual(["Liberar"]);
    expect(laneStatusTags({ status: "merge" }, base)).toEqual(["Integrar"]);
    expect(laneStatusTags({ status: "deploy" }, base)).toEqual(["Publicar"]);
    expect(laneStatusTags({ status: "status-futuro" }, base)).toEqual(["status-futuro"]);
    expect(laneStatusTags({ status: null }, base)).toEqual(["sem status"]);
  });
});

describe("laneSections — a raia dividida pelo que cada card está fazendo", () => {
  it("agindo, esperando, parado, fila (recolhida) e sem ninguém, na ordem fixa; só as seções com card", () => {
    const kinds: Record<string, CardLiveKind | null> = { a: "working", b: "queued", c: "quiet", d: null, e: "integrating", f: "queued", g: "stopped" };
    const cards = Object.keys(kinds).map((id) => story(id, "desenvolver"));
    const sections = laneSections(cards, (id) => kinds[id]);
    expect(sections.map((s) => [s.id, s.cards.map((c) => c.id)])).toEqual([
      ["agindo", ["a", "e"]],
      ["parado", ["c", "g"]],
      ["fila", ["b", "f"]],
      ["sem", ["d"]],
    ]);
    expect(sections.find((s) => s.id === "fila")!.collapsed).toBe(true);
  });
});

describe("«Adiado — não agora» tem a sua faixa", () => {
  const lanes = [
    { id: "a", label: "A", statuses: ["triage"], demand: false },
    { id: "b", label: "B", statuses: ["enriquecer"], demand: false },
  ];
  const c = (id: string, status: string, deferred = false) => ({ id, type: "story", status, ...(deferred ? { deferred: { reason: "x", since: "2026-10-02", by: "human" } } : {}) }) as unknown as Card;

  it("o adiado sai da raia do status e vai para a faixa sintética, sem aceitar soltura", () => {
    const g = groupStoriesByLane([c("1", "triage"), c("2", "enriquecer", true), c("3", "enriquecer")], lanes as never);
    expect(g.byLane.get("a")!.map((x) => x.id)).toEqual(["1"]);
    expect(g.byLane.get("b")!.map((x) => x.id)).toEqual(["3"]);
    expect(g.byLane.get(LANE_DEFERRED_ID)!.map((x) => x.id)).toEqual(["2"]);
    const lane = g.lanes.find((l) => l.id === LANE_DEFERRED_ID)!;
    expect(lane).toMatchObject({ deferred: true, others: true, demand: false });
    expect(laneDropStatus(lane, { statuses: [] } as never)).toBeNull();
  });

  it("sem nenhum adiado a faixa nem existe", () => {
    expect(groupStoriesByLane([c("1", "triage")], lanes as never).lanes.map((l) => l.id)).toEqual(["a", "b"]);
  });
});
