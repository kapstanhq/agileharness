// The board VIEW in lanes — the pure placement + the lint. Each case is a promise the owner relies on:
//   • absent `view.lanes` ⇒ no lane view at all (the legacy Kanban renders, byte-identical);
//   • every card lands somewhere — an unmapped/unknown status goes to a VISIBLE "Outros", never nowhere;
//   • a card with an open question sits in "Precisa de você" whatever its status (the demand rule);
//   • a map that is wrong says so in words (unmapped, duplicated, unknown, two demand lanes).

import { beforeAll, describe, expect, it } from "vitest";
import {
  boardLanes,
  groupStoriesByLane,
  LANE_OTHERS_ID,
  laneDropStatus,
  laneOfCard,
  laneStatusTags,
  laneViewProblems,
  type ResolvedLane,
} from "./lanes";
import { readBoardConfig } from "./repo";
import { FIXTURE_BOARD } from "./board-fixture";
import type { BoardConfig, Card, LaneDef } from "./types";

// The owner's six lanes over the canonical `_base` pipeline (the nook example of the plan) + the reopen
// executors in Moldando. The archive terminals need no lane (they never render on the Kanban).
const SIX: LaneDef[] = [
  { id: "triagem", label: "Triagem", statuses: ["capturando", "triage", "priorizar", "pronta"] },
  { id: "moldando", label: "Moldando", statuses: ["grill", "enriquecer", "interview", "design-ux", "design-ui", "refinar", "corrigir", "descontinuar"] },
  { id: "voce", label: "Precisa de você", statuses: ["com-design", "ready", "revisao", "release"], demand: true },
  { id: "construindo", label: "Construindo", statuses: ["plano-tecnico", "desenvolver"] },
  { id: "verificando", label: "Verificando", statuses: ["revisar-codigo", "qa-automatizado", "merge", "stage", "deploy"] },
  { id: "no-ar", label: "No ar", statuses: ["concluida"] },
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

describe("boardLanes — a vista só existe quando declarada", () => {
  it("sem `view.lanes` ⇒ null (o Kanban legado renderiza intacto)", () => {
    expect(boardLanes(base)).toBeNull();
    expect(boardLanes({ ...base, view: {} })).toBeNull();
    expect(boardLanes({ ...base, view: { lanes: [] } })).toBeNull();
  });

  it("`demand: true` resolve para o default (pergunta aberta); lista explícita é mantida", () => {
    const lanes = boardLanes(withLanes([
      { id: "a", label: "A", statuses: [], demand: true },
      { id: "b", label: "B", statuses: [], demand: ["blocker"] },
      { id: "c", label: "C", statuses: [] },
    ]))!;
    expect(lanes.map((l) => l.demand)).toEqual([["question"], ["blocker"], null]);
  });
});

describe("laneViewProblems — o mapa torto se explica em palavras", () => {
  it("o mapa das seis raias cobre o pipeline canônico sem nenhum problema", () => {
    expect(laneViewProblems(withLanes(SIX))).toEqual([]);
  });

  it("board sem vista ⇒ nenhum problema (nada a validar)", () => {
    expect(laneViewProblems(base)).toEqual([]);
  });

  it("status sem raia é nomeado, com o destino dos cards ('Outros')", () => {
    const lanes = SIX.map((l) => (l.id === "no-ar" ? { ...l, statuses: [] } : l));
    const problems = laneViewProblems(withLanes(lanes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/'concluida'.*nenhuma raia.*Outros/);
  });

  it("status em duas raias, status inexistente, id repetido/reservado e duas raias de demanda", () => {
    const lanes: LaneDef[] = [
      ...SIX.map((l) => (l.id === "construindo" ? { ...l, statuses: [...l.statuses, "revisao", "fantasma"] } : l)),
      { id: "no-ar", label: "Dup", statuses: [] },
      { id: LANE_OTHERS_ID, label: "Reservada", statuses: [], demand: ["blocker"] },
    ];
    const problems = laneViewProblems(withLanes(lanes)).join("\n");
    expect(problems).toMatch(/'revisao' está em 2 raias \(Precisa de você, Construindo\)/);
    expect(problems).toMatch(/'fantasma'.*não existe/);
    expect(problems).toMatch(/duas raias com o id 'no-ar'/);
    expect(problems).toMatch(/id reservado/);
    expect(problems).toMatch(/2 raias puxam por demanda/);
  });

  it("os terminais de ARQUIVO não precisam de raia (nunca aparecem no Kanban)", () => {
    const problems = laneViewProblems(withLanes(SIX)).join("\n");
    for (const archived of ["arquivados", "duplicado", "cancelado", "capturado"]) expect(problems).not.toMatch(archived);
  });
});

describe("laneOfCard / groupStoriesByLane — todo card em UMA raia, nada some", () => {
  it("cada status vai para a raia que o declara", () => {
    const lanes = boardLanes(withLanes(SIX))!;
    const none = new Set<never>();
    expect(laneOfCard({ status: "triage" }, lanes, none)).toBe("triagem");
    expect(laneOfCard({ status: "design-ui" }, lanes, none)).toBe("moldando");
    expect(laneOfCard({ status: "revisao" }, lanes, none)).toBe("voce");
    expect(laneOfCard({ status: "desenvolver" }, lanes, none)).toBe("construindo");
    expect(laneOfCard({ status: "merge" }, lanes, none)).toBe("verificando");
    expect(laneOfCard({ status: "concluida" }, lanes, none)).toBe("no-ar");
  });

  it("status desconhecido / ausente / sem raia cai em 'Outros', que só aparece quando tem card", () => {
    const cfg = withLanes(SIX.map((l) => (l.id === "no-ar" ? { ...l, statuses: [] } : l)));
    const lanes = boardLanes(cfg)!;
    const empty = groupStoriesByLane([story("a", "triage")], cfg, lanes);
    expect(empty.lanes.map((l) => l.id)).not.toContain(LANE_OTHERS_ID);

    const { lanes: shown, byLane } = groupStoriesByLane(
      [story("a", "triage"), story("b", "status-futuro"), story("c", null), story("d", "concluida")],
      cfg,
      lanes,
    );
    expect(shown.at(-1)).toMatchObject({ id: LANE_OTHERS_ID, label: "Outros", others: true });
    expect(byLane.get(LANE_OTHERS_ID)!.map((c) => c.id).sort()).toEqual(["b", "c", "d"]);
    // conservação: nenhum card some e nenhum aparece duas vezes
    const all = [...byLane.values()].flat().map((c) => c.id).sort();
    expect(all).toEqual(["a", "b", "c", "d"]);
  });

  it("a REGRA DA DEMANDA: pergunta aberta puxa o card para 'Precisa de você' em qualquer status", () => {
    const cfg = withLanes(SIX);
    const lanes = boardLanes(cfg)!;
    const asked = { questions: [{ id: "q1", text: "Qual público?", status: "open" as const }] };
    const answered = { questions: [{ id: "q1", text: "Qual público?", status: "answered" as const, answer: "x" }] };
    const { byLane } = groupStoriesByLane(
      [
        story("moldando-com-pergunta", "grill", asked),
        story("construindo-com-pergunta", "desenvolver", asked),
        story("moldando-respondida", "grill", answered),
        story("construindo-limpa", "desenvolver"),
      ],
      cfg,
      lanes,
    );
    expect(byLane.get("voce")!.map((c) => c.id).sort()).toEqual(["construindo-com-pergunta", "moldando-com-pergunta"]);
    expect(byLane.get("moldando")!.map((c) => c.id)).toEqual(["moldando-respondida"]);
    expect(byLane.get("construindo")!.map((c) => c.id)).toEqual(["construindo-limpa"]);
  });

  it("sem raia de demanda, a pergunta NÃO move o card (o status decide sozinho)", () => {
    const cfg = withLanes(SIX.map((l) => ({ ...l, demand: undefined })));
    const { byLane } = groupStoriesByLane(
      [story("q", "desenvolver", { questions: [{ id: "q1", text: "?", status: "open" }] })],
      cfg,
      boardLanes(cfg)!,
    );
    expect(byLane.get("construindo")!.map((c) => c.id)).toEqual(["q"]);
  });

  it("uma raia que puxa por `blocker` puxa o bloqueio aberto (e não a pergunta)", () => {
    const lanes: ResolvedLane[] = [
      { id: "x", label: "X", statuses: ["desenvolver"], demand: null },
      { id: "b", label: "B", statuses: [], demand: ["blocker"] },
    ];
    expect(laneOfCard({ status: "desenvolver" }, lanes, new Set(["blocker"]))).toBe("b");
    expect(laneOfCard({ status: "desenvolver" }, lanes, new Set(["question"]))).toBe("x");
  });
});

describe("laneDropStatus / laneStatusTags", () => {
  it("soltar numa raia = o primeiro status visível dela (o gate ainda decide); 'Outros' não aceita", () => {
    const cfg = withLanes(SIX);
    const lanes = boardLanes(cfg)!;
    expect(laneDropStatus(lanes.find((l) => l.id === "triagem")!, cfg)).toBe("triage"); // capturando é oculto
    expect(laneDropStatus(lanes.find((l) => l.id === "construindo")!, cfg)).toBe("plano-tecnico");
    expect(laneDropStatus({ id: LANE_OTHERS_ID, label: "Outros", statuses: [], demand: null, others: true }, cfg)).toBeNull();
  });

  it("a etiqueta é o status REAL; passagem do train ⇒ `integrando`; passo do deploy ⇒ `publicando`", () => {
    expect(laneStatusTags({ status: "desenvolver" }, base)).toEqual(["Desenvolver"]);
    expect(laneStatusTags({ status: "merge" }, base)).toContain("integrando");
    expect(laneStatusTags({ status: "stage" }, base)).toContain("integrando");
    expect(laneStatusTags({ status: "deploy" }, base)).toContain("publicando");
    expect(laneStatusTags({ status: "revisao" }, base)).toHaveLength(1);
    expect(laneStatusTags({ status: "status-futuro" }, base)).toEqual(["status-futuro"]);
    expect(laneStatusTags({ status: null }, base)).toEqual(["sem status"]);
  });
});
