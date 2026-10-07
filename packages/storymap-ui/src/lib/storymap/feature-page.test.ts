// A página da funcionalidade — a parte pura. Cada caso é uma promessa que o dono lê na página:
//   • os itens são os da MESMA chave do Kanban (inclusive os já arquivados, para o «Feito»);
//   • «Agora» é o que roda (ou o sistema entrega), «Precisa de você» a decisão do dono ou o erro, «Próximo» o resto;
//   • «Feito» é o que chegou ao fim do fluxo e o arquivado COM Prova da entrega — cancelado e duplicado não foram feitos;
//   • a página não reordena: a ordem é a do quadro; o «Feito» vem do mais novo ao mais velho;
//   • o topo diz de onde vem a funcionalidade (PRD, fora do PRD, passo do mapa); id desconhecido ⇒ 404.
// Fixtures INVENTADAS no vocabulário da livraria de demonstração.

import { describe, expect, it } from "vitest";
import { featureCtx } from "./feature-key";
import { featureHead, featureItems, featurePageSections, newItemDraft, OUTROS_LINE, sectionsSummary } from "./feature-page";
import type { FlowState } from "./kanban-features";
import type { BoardConfig, Card } from "./types";

const card = (id: string, extra: Partial<Card> = {}): Card =>
  ({
    id,
    type: "story",
    title: id,
    storyType: "user",
    status: "desenvolver",
    parent: null,
    personas: [],
    systems: [],
    links: [],
    acceptance: [],
    tasks: [],
    body: "",
    order: 10,
    created: null,
    updated: null,
    ...extra,
  }) as Card;

const CONFIG = {
  statuses: [
    { id: "triage", name: "Triagem" },
    { id: "pronta", name: "A fazer" },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "revisao", name: "Aprovar entrega" },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
    { id: "arquivados", name: "Arquivados", terminal: true },
    { id: "cancelado", name: "Cancelado", terminal: true },
  ],
} as unknown as BoardConfig;

const FEATURES = [
  { id: "carrinho", name: "Carrinho de compras", markdown: "Montar o pedido antes de pagar." },
  { id: "busca", name: "Busca no catálogo", markdown: "" },
];
const step = card("step-ex9901", { type: "step", title: "Achar um livro", storyType: null, body: "Do desejo ao livro certo." });

describe("os itens da funcionalidade", () => {
  it("a mesma chave do Kanban, com os arquivados; o container de captura fica fora", () => {
    const a = card("story-ex9902", { feature: "carrinho" });
    const b = card("story-ex9903", { feature: "carrinho", status: "arquivados" });
    const c = card("story-ex9904", { feature: "busca" });
    const t = card("story-ex9905", { storyType: "technical", serves: a.id });
    const cap = card("story-ex9906", { feature: "carrinho", capture: true } as Partial<Card>);
    const all = [a, b, c, t, cap];
    const ctx = featureCtx(new Map(all.map((x) => [x.id, x])), FEATURES, true);
    expect(featureItems(all, "carrinho", ctx).map((x) => x.id)).toEqual(["story-ex9902", "story-ex9903", "story-ex9905"]);
    expect(featureItems(all, "outros", ctx).map((x) => x.id)).toEqual([]);
  });
});

describe("as seções", () => {
  const items = [
    card("story-ex9911", { status: "pronta", order: 30 }),
    card("story-ex9912", { status: "desenvolver", order: 20 }),
    card("story-ex9913", { status: "triage", order: 10 }),
    card("story-ex9914", { status: "revisao" }),
    card("story-ex9915", { status: "pronta", order: 5, deferred: { reason: "depois" } as Card["deferred"] }),
    card("story-ex9916", { status: "concluida", updatedMs: 1_000 }),
    card("story-ex9917", { status: "concluida", updatedMs: 9_000 }),
    card("story-ex9918", { status: "arquivados" }),
    card("story-ex9919", { status: "arquivados" }),
    card("story-ex9920", { status: "cancelado" }),
    card("story-ex9921", { status: "desenvolver", order: 5 }),
  ];
  const states: Record<string, FlowState> = {
    "story-ex9911": "queued",
    "story-ex9912": "running",
    "story-ex9913": "forgotten",
    "story-ex9914": "attention",
    "story-ex9915": "queued",
    "story-ex9921": "error",
  };
  const proofs: Record<string, string> = { "story-ex9916": "Frete aparece no carrinho.", "story-ex9918": "Busca por autor no ar." };
  const s = featurePageSections(items, { stateOf: (id) => states[id], config: CONFIG, proofOf: (id) => proofs[id] ?? null });
  const ids = (xs: { card: Card }[]) => xs.map((x) => x.card.id);

  it("Agora = rodando; Precisa de você = decisão ou erro; Próximo = o resto aberto, o adiado no fim", () => {
    expect(ids(s.agora)).toEqual(["story-ex9912"]);
    expect(ids(s.precisaDeVoce)).toEqual(["story-ex9921", "story-ex9914"]);
    expect(ids(s.proximo)).toEqual(["story-ex9913", "story-ex9911", "story-ex9915"]);
    expect(s.proximo.at(-1)?.deferred).toBe(true);
  });

  it("Feito = o status de entrega e o arquivado COM prova (do mais novo ao mais velho); cancelado e arquivado sem prova ficam fora", () => {
    expect(ids(s.feito)).toEqual(["story-ex9917", "story-ex9916", "story-ex9918"]);
    expect(s.feito.map((f) => f.proof)).toEqual([null, "Frete aparece no carrinho.", "Busca por autor no ar."]);
  });

  it("a ordem do quadro: a raia dada pela tela vence a ordem do pipeline; a chegada ao ar ordena o Feito", () => {
    const lane: Record<string, number> = { triage: 2, pronta: 0 };
    const r = featurePageSections(items, {
      stateOf: (id) => states[id],
      config: CONFIG,
      proofOf: () => null,
      laneOf: (c) => lane[c.status ?? ""] ?? 1,
      arrivedAt: (id) => (id === "story-ex9916" ? 50_000 : undefined),
    });
    expect(ids(r.proximo)).toEqual(["story-ex9911", "story-ex9913", "story-ex9915"]);
    expect(ids(r.feito)).toEqual(["story-ex9916", "story-ex9917"]);
  });

  it("board sem status de entrega marcado: todo terminal é o fim do fluxo", () => {
    const plain = { statuses: CONFIG.statuses.map((st) => ({ ...st, delivered: undefined })) } as unknown as BoardConfig;
    const r = featurePageSections([card("story-ex9922", { status: "cancelado" })], { stateOf: () => "queued", config: plain, proofOf: () => null });
    expect(ids(r.feito)).toEqual(["story-ex9922"]);
  });

  it("o resumo sob o título conta só o que tem item", () => {
    expect(sectionsSummary(s)).toBe("1 agora · 2 precisam de você · 3 próximos · 3 feitos");
    expect(sectionsSummary({ agora: [], precisaDeVoce: [], proximo: [], feito: [] })).toBe("Nenhum item ainda");
  });
});

describe("o topo da página", () => {
  const byId = new Map([[step.id, step]]);

  it("a funcionalidade do PRD: o nome e o texto dela (vazio ⇒ null)", () => {
    expect(featureHead("carrinho", FEATURES, byId)).toEqual({
      id: "carrinho",
      title: "Carrinho de compras",
      source: "prd",
      description: "Montar o pedido antes de pagar.",
    });
    expect(featureHead("busca", FEATURES, byId)?.description).toBeNull();
  });

  it("«outros» só existe num board com funcionalidades no PRD", () => {
    expect(featureHead("outros", FEATURES, byId)).toEqual({ id: "outros", title: "Outros (fora do PRD)", source: "outros", description: OUTROS_LINE });
    expect(featureHead("outros", [], byId)).toBeNull();
  });

  it("sem funcionalidade no PRD com esse id, o passo do mapa (título + corpo); nada ⇒ null", () => {
    expect(featureHead(step.id, [], byId)).toEqual({ id: step.id, title: "Achar um livro", source: "map", description: "Do desejo ao livro certo." });
    expect(featureHead("nao-existe", FEATURES, byId)).toBeNull();
  });

  it("«Pedir item novo» escreve o pedido com o nome da funcionalidade", () => {
    expect(newItemDraft("Carrinho de compras")).toBe("Quero um item novo em «Carrinho de compras»: ");
  });
});
