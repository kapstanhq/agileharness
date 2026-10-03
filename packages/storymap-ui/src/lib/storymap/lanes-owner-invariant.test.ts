// O INVARIANTE da raia do dono: os cards da raia `demand` são EXATAMENTE os cards em Decidir do coletor do
// Inbox — nem um a mais, nem um a menos — e o que Decidir conta sem card na raia é dito como «fora do quadro».
//
// Num caso real a raia do dono tinha mais cards que Decidir: os desvios eram cards parados em Liberar/Revisão cujo item
// estava em ACOMPANHAR (o Jido republicando, o gate do sistema). A raia os puxava pelo STATUS.
//
// A prova roda o modelo REAL do Inbox (cardCockpitItems → itemEntries → foldByCard → ownerDecisionsFromEntries) sobre um
// corpus sintético — cada status do pipeline × pergunta técnica / pergunta de dinheiro / bloqueio / publicação que
// só o dono destrava / publicação que o sistema refaz / nada × board humano / board só-negócio — e compara a raia com
// Decidir. O corpus passa pelos dois mapas: o antigo (status na raia do dono) e o novo.

import { beforeAll, describe, expect, it } from "vitest";
import { cardCockpitItems, DEPLOY_FAILURE_FINDING_ID } from "./demands";
import { foldByCard, inboxSummary, itemEntries, type InboxEntry } from "./inbox/entries";
import { ownerDecisionsFromEntries } from "./inbox/decidir-set";
import { boardLanes, groupStoriesByLane, LANE_OTHERS_ID } from "./lanes";
import { readBoardConfig } from "./repo";
import { FIXTURE_BOARD } from "./board-fixture";
import { kanbanStories } from "./views";
import type { BoardConfig, Card, CardQuestion, Finding, LaneDef } from "./types";

const NOW = Date.parse("2026-10-01T22:45:00Z");

const OLD_MAP: LaneDef[] = [
  { id: "entrada", label: "Entrada", statuses: ["capturando", "triage", "priorizar", "pronta", "grill"] },
  { id: "desenho", label: "Desenho", statuses: ["enriquecer", "interview", "design-ux", "design-ui", "refinar", "corrigir", "descontinuar"] },
  { id: "obra", label: "Obra", statuses: ["plano-tecnico", "desenvolver", "revisar-codigo"] },
  { id: "voce", label: "Precisa de você", statuses: ["ready", "com-design", "revisao", "release"], demand: true },
  { id: "conferencia", label: "Conferência", statuses: ["qa-automatizado", "merge", "stage", "deploy"] },
  { id: "feito", label: "Feito", statuses: ["concluida"] },
];
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

const question = (category: CardQuestion["category"], text: string): CardQuestion => ({ id: "q1", text, status: "open", category }) as CardQuestion;
const finding = (extra: Partial<Finding>): Finding =>
  ({ id: "f1", title: "achado", lens: "general", severity: "blocker", status: "open", detail: "", ...extra }) as Finding;

/** Os casos que mudam quem decide — cada um em cada status. */
const CASES: Record<string, Partial<Card>> = {
  nada: {},
  "pergunta-tecnica": { questions: [question("technical", "Uso o índice composto ou o simples?")] },
  "pergunta-dinheiro": { questions: [question("money", "Qual fornecedor de SMS contratar?")] },
  bloqueio: { findings: [finding({ id: "b1", severity: "blocker" })] },
  "publicacao-do-dono": { findings: [finding({ id: DEPLOY_FAILURE_FINDING_ID, severity: "high", lens: "general", deployPhase: "needs-human" })] },
  "publicacao-do-sistema": { findings: [finding({ id: DEPLOY_FAILURE_FINDING_ID, severity: "high", lens: "general" })] },
};

function corpus(config: BoardConfig): Card[] {
  const out: Card[] = [];
  for (const s of config.statuses) {
    for (const [name, extra] of Object.entries(CASES)) {
      out.push({
        id: `${s.id}--${name}`,
        type: "story",
        title: `${s.name} · ${name}`,
        storyType: "user",
        status: s.id,
        parent: "step-x",
        release: null,
        personas: [],
        systems: [],
        links: [],
        acceptance: ["Dado algo, quando algo, então algo"],
        tasks: [],
        body: "",
        order: 0,
        created: "2026-09-25",
        updated: "2026-09-25",
        ...extra,
      } as Card);
    }
  }
  return out;
}

/** O Inbox do board, pelo modelo real — o que `collectBoardInbox().entries` entrega (sem os ledgers). */
function inboxOf(config: BoardConfig, cards: Card[]): InboxEntry[] {
  const items = cards.flatMap((c) => cardCockpitItems(c, config, "demo", { now: NOW }));
  return foldByCard(itemEntries(items, { boardId: "demo", boardName: config.name, config, cardsById: new Map(cards.map((c) => [c.id, c])), now: NOW }));
}

describe.each([
  ["humano", undefined],
  ["só-negócio", { mode: "ultra" as const }],
])("board %s", (_mode, autonomy) => {
  it.each([
    ["mapa antigo", OLD_MAP],
    ["mapa novo", NEW_MAP],
  ])("%s: a raia do dono == os cards em Decidir, e |raia| + segundas + fora do quadro == o número do Inbox", (_m, map) => {
    const config: BoardConfig = { ...base, view: { lanes: map }, ...(autonomy ? { autonomy } : {}) };
    const cards = corpus(config);
    const entries = inboxOf(config, cards);
    const owner = ownerDecisionsFromEntries(entries, "demo");
    const stories = kanbanStories(cards, config);
    const { byLane, outside } = groupStoriesByLane(stories, boardLanes(config)!, { owner });

    const lane = byLane.get("voce")!.map((c) => c.id);
    const shown = new Set(stories.map((c) => c.id));
    const decidir = [...new Set(entries.filter((e) => e.decision.bucket === "decidir" && !e.decision.banner && shown.has(e.cardId)).map((e) => e.cardId))];
    // anti-vácuo: o corpus TEM o que decidir e o que não decidir
    expect(decidir.length).toBeGreaterThan(0);
    expect(decidir.length).toBeLessThan(shown.size);
    expect(new Set(lane)).toEqual(new Set(decidir));
    // a ordem da raia é a do Inbox
    expect(lane).toEqual(owner.cards.filter((d) => shown.has(d.cardId)).map((d) => d.cardId));
    const more = owner.cards.filter((d) => shown.has(d.cardId)).reduce((n, d) => n + d.more, 0);
    expect(lane.length + more + outside).toBe(inboxSummary(entries).decidir);
    // nada some: todo card do Kanban está em exatamente uma raia
    const placed = [...byLane.values()].flat().map((c) => c.id);
    expect(placed.length).toBe(stories.length);
    expect(new Set(placed).size).toBe(stories.length);
  });
});

describe("os 4 desvios típicos (Liberar/Revisão com o item em Acompanhar)", () => {
  // O item deles estava em ACOMPANHAR — o Jido republicando, o gate com o sistema —, então não são decisão do dono.
  const card = (id: string, status: string) => ({ id, type: "story", title: id, status, findings: [], questions: [] }) as unknown as Card;
  const following = (cardId: string, kind: InboxEntry["kind"]): InboxEntry =>
    ({
      key: `demo/${cardId}:${kind}`,
      boardId: "demo",
      boardName: "Demo",
      itemId: `${cardId}:${kind}`,
      cardId,
      cardTitle: cardId,
      kind,
      facets: [],
      decision: { bucket: "acompanhar", ask: "O sistema está cuidando", options: [], dot: "amber", since: null, next: { who: "jido", label: "Jido" } },
    }) as unknown as InboxEntry;
  const live = [card("story-lib-a", "release"), card("story-lib-b", "release"), card("story-lib-c", "release"), card("story-rev-d", "revisao")];
  const entries = [
    following("story-lib-a", "deploy-failed"),
    following("story-lib-b", "deploy-failed"),
    following("story-lib-c", "deploy-failed"),
    following("story-rev-d", "gate"),
  ];

  it.each([
    ["mapa antigo", OLD_MAP, LANE_OTHERS_ID],
    ["mapa novo", NEW_MAP, "saida"],
  ])("%s: nenhum dos 4 entra na raia do dono (vão para %s)", (_m, map, where) => {
    const config: BoardConfig = { ...base, view: { lanes: map } };
    const { byLane, outside } = groupStoriesByLane(live, boardLanes(config)!, { owner: ownerDecisionsFromEntries(entries, "demo") });
    expect(byLane.get("voce")).toEqual([]);
    expect(byLane.get(where)!.map((c) => c.id).sort()).toEqual(live.map((c) => c.id).sort());
    expect(outside).toBe(0);
  });
});
