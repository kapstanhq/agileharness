// A busca do Kanban — o recorte puro que a barra usa. Cada caso é uma promessa ao operador que limpa uma
// coluna cheia e precisa ACHAR um card: pelo id inteiro ou por um pedaço dele, por uma palavra do título
// sem se preocupar com acento, pelo tipo (no nome técnico ou no rótulo que o card MOSTRA), pelo passo/
// atividade onde a story mora; e o recorte vai para a URL sem apagar os outros parâmetros da tela.

import { describe, expect, it } from "vitest";
import {
  cardTypeKeys,
  cardTypeLabel,
  EMPTY_KANBAN_FILTER,
  isKanbanFilterActive,
  matchesCardQuery,
  readKanbanFilter,
  writeKanbanFilter,
} from "./kanban-filter";
import type { Card } from "./types";

const card = (id: string, title: string, extra: Partial<Card> = {}): Card =>
  ({
    id,
    type: "story",
    title,
    storyType: "user",
    status: "triage",
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    tasks: [],
    acceptance: [],
    body: "",
    ...extra,
  }) as unknown as Card;

const activity = card("act-estante", "Comprar livros", { type: "activity", storyType: null, status: null });
const step = card("step-busca", "Achar o livro certo", { type: "step", storyType: null, status: null, parent: "act-estante" });
const s1 = card("story-ex0044", "Sessão expira no meio do cadastro", { parent: "step-busca" });
const s2 = card("story-despacho", "Lista de pedidos com descrição curta", { storyType: "bug", parent: "step-busca" });
const s3 = card("story-c4ch3x", "Suíte roda em menos de um minuto", { storyType: "chore" });
const s4 = card("story-s4f4r1", "Login falha no Safari", { mode: "fix" });
const cardsById = new Map([activity, step, s1, s2, s3, s4].map((c) => [c.id, c]));

describe("matchesCardQuery — texto livre", () => {
  it("consulta vazia (ou só espaços) casa tudo", () => {
    expect(matchesCardQuery(s1, "")).toBe(true);
    expect(matchesCardQuery(s1, "   ")).toBe(true);
  });

  it("acha pelo id inteiro e por um pedaço dele, sem diferenciar caixa", () => {
    expect(matchesCardQuery(s1, "story-ex0044")).toBe(true);
    expect(matchesCardQuery(s1, "ex0044")).toBe(true);
    expect(matchesCardQuery(s1, "EX0044")).toBe(true);
    expect(matchesCardQuery(s2, "ex0044")).toBe(false);
  });

  it("ignora acento nos dois sentidos", () => {
    expect(matchesCardQuery(s1, "sessao")).toBe(true);
    expect(matchesCardQuery(card("story-x", "Sessao sem til"), "sessão")).toBe(true);
    expect(matchesCardQuery(s3, "SUITE")).toBe(true);
  });

  it("várias palavras = E (todas precisam aparecer, em qualquer ordem)", () => {
    expect(matchesCardQuery(s2, "pedidos lista")).toBe(true);
    expect(matchesCardQuery(s2, "lista zebra")).toBe(false);
    // uma palavra no id e outra no título também vale
    expect(matchesCardQuery(s2, "despacho curta")).toBe(true);
  });

  it("acha pelo tipo — o id técnico e o rótulo em português que o card mostra", () => {
    expect(matchesCardQuery(s2, "bug")).toBe(true);
    expect(matchesCardQuery(s3, "chore")).toBe(true);
    expect(matchesCardQuery(card("story-t", "Cache", { storyType: "technical" }), "tecnica")).toBe(true);
    expect(matchesCardQuery(card("story-t", "Cache", { storyType: "technical" }), "technical")).toBe(true);
    // sem storyType o card se apresenta como User Story
    expect(matchesCardQuery(card("story-u", "Qualquer", { storyType: null }), "user story")).toBe(true);
    expect(matchesCardQuery(s1, "bug")).toBe(false);
  });

  it("um card em modo fix se apresenta como Bug — e é achado como bug", () => {
    expect(matchesCardQuery(s4, "bug")).toBe(true);
  });

  it("acha pelo passo e pela atividade onde a story mora (com o índice do board)", () => {
    expect(matchesCardQuery(s1, "achar livro", { cardsById })).toBe(true);
    expect(matchesCardQuery(s1, "comprar livros", { cardsById })).toBe(true);
    // sem o índice, só o próprio card conta
    expect(matchesCardQuery(s1, "achar livro")).toBe(false);
  });

  it("um parent em ciclo não trava a busca", () => {
    const a = card("story-a", "Alfa", { parent: "story-b" });
    const b = card("story-b", "Beta", { parent: "story-a" });
    const idx = new Map([a, b].map((c) => [c.id, c]));
    expect(matchesCardQuery(a, "beta", { cardsById: idx })).toBe(true);
    expect(matchesCardQuery(a, "gama", { cardsById: idx })).toBe(false);
  });
});

describe("cardTypeKeys / cardTypeLabel — o tipo que o card mostra", () => {
  it("storyType ausente conta como user; modo fix soma bug", () => {
    expect(cardTypeKeys(card("story-u", "x", { storyType: null }))).toEqual(["user"]);
    expect(cardTypeKeys(s2)).toEqual(["bug"]);
    expect(cardTypeKeys(s4)).toEqual(["user", "bug"]);
  });

  it("o rótulo segue o modo antes do tipo", () => {
    expect(cardTypeLabel(s1).text).toBe("User Story");
    expect(cardTypeLabel(s2).text).toBe("Bug");
    expect(cardTypeLabel(s4).text).toBe("Bug");
    expect(cardTypeLabel(card("story-r", "x", { mode: "refine" })).text).toBe("Refino");
    expect(
      cardTypeLabel(card("story-d", "x", { mode: "retire", retirement: { brief: "", disposition: "postergado", level: null } as Card["retirement"] })).text,
    ).toBe("Postergado");
    expect(cardTypeLabel(card("story-d", "x", { mode: "retire" })).text).toBe("Arquivar");
  });
});

describe("isKanbanFilterActive", () => {
  it("filtro vazio (ou só espaços) não conta como ativo", () => {
    expect(isKanbanFilterActive(EMPTY_KANBAN_FILTER)).toBe(false);
    expect(isKanbanFilterActive({ q: "  ", types: [] })).toBe(false);
  });
});

describe("URL — ?q= e ?tipo=", () => {
  it("lê q e tipo; tipo desconhecido é descartado, repetido some, ordem canônica", () => {
    expect(readKanbanFilter(new URLSearchParams("q=sessão&tipo=chore,bug,xyz,bug"))).toEqual({
      q: "sessão",
      types: ["bug", "chore"],
    });
    expect(readKanbanFilter(new URLSearchParams(""))).toEqual(EMPTY_KANBAN_FILTER);
  });

  it("escreve preservando os outros parâmetros da tela", () => {
    const qs = writeKanbanFilter("?focus=story-1&copilot=abc", { q: "lista pedidos", types: ["chore", "bug"] });
    const p = new URLSearchParams(qs);
    expect(p.get("focus")).toBe("story-1");
    expect(p.get("copilot")).toBe("abc");
    expect(p.get("q")).toBe("lista pedidos");
    expect(p.get("tipo")).toBe("bug,chore");
  });

  it("filtro vazio remove os próprios parâmetros e deixa o resto", () => {
    expect(writeKanbanFilter("q=velho&tipo=bug&focus=x", { q: "   ", types: [] })).toBe("focus=x");
    expect(writeKanbanFilter("q=velho", EMPTY_KANBAN_FILTER)).toBe("");
  });

  it("ida e volta preservam acento e espaço", () => {
    const f = { q: "sessão expira", types: ["user" as const] };
    expect(readKanbanFilter(new URLSearchParams(writeKanbanFilter("", f)))).toEqual(f);
  });
});
