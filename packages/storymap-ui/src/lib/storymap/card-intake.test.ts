// A VERIFICAÇÃO DE ENTRADA DE CARD, camada 1 (regras puras): o board pelos arquivos, o padrão de criação, a duplicata e
// a dúvida que (só ela) chama o modelo pequeno. Fixtures inventadas: um alvo com três boards — uma oficina de
// bicicletas (app), um balcão de vendas (app) e o galpão (a infraestrutura comum).

import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { intakeRules, jaccard, otherBoardsMentioned, pathsIn, significantWords, titleProblems, type IntakeCandidate, type IntakeContext } from "./card-intake";
import type { BoardFootprint } from "./card-routing";
import type { BoardConfig, Card } from "./types";

const OFICINA: BoardFootprint = { id: "oficina", name: "Oficina", package: "apps/oficina" };
const BALCAO: BoardFootprint = { id: "balcao", name: "Balcão", package: "apps/balcao", sharedPackages: ["libs/comum"] };
const GALPAO: BoardFootprint = { id: "galpao", name: "Galpão", package: "libs/comum", ownsPaths: ["ops/publicar/", "tarefas.toml"] };
const BOARDS = [OFICINA, BALCAO, GALPAO];

const CONFIG: Pick<BoardConfig, "statuses" | "columns"> = {
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "concluida", name: "No ar", terminal: true },
    { id: "arquivado", name: "Arquivado", column: "lixo" },
  ],
  columns: [{ id: "lixo", name: "Arquivo", system: true }],
} as Pick<BoardConfig, "statuses" | "columns">;

const story = (id: string, title: string, status = "desenvolver", over: Partial<Card> = {}): Card => ({
  ...coerceCard(id, { type: "story", title, status }, ""),
  ...over,
});

const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
  board: OFICINA,
  boards: BOARDS,
  config: CONFIG,
  cards: [story("story-ex9701", "Trocar a corrente da bicicleta sem perder o pedido")],
  similarity: 0.75,
  ...over,
});

const cand = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  title: "Mostrar o prazo de entrega da revisão no pedido",
  type: "story",
  storyType: "technical",
  body: "",
  acceptance: [],
  files: [],
  landsInQuarantine: true,
  ...over,
});

describe("intakeRules — o board pelos arquivos", () => {
  it("arquivos de OUTRO board ⇒ recusa com o board certo", () => {
    const v = intakeRules(cand({ files: ["ops/publicar/etapa.mjs", "tarefas.toml"] }), ctx());
    expect(v).toMatchObject({ verdict: "refuse", reason: "board", suggestBoard: "galpao" });
    expect((v as { why: string }).why).toMatch(/Galpão/);
  });

  it("caminhos citados no CORPO também contam (o agente não passou `files`)", () => {
    const v = intakeRules(cand({ body: "O erro mora em apps/balcao/caixa/troco.ts quando o troco passa de 100." }), ctx());
    expect(v).toMatchObject({ verdict: "refuse", reason: "board", suggestBoard: "balcao" });
  });

  it("arquivos do próprio board ⇒ aceita", () => {
    expect(intakeRules(cand({ files: ["apps/oficina/pedido/prazo.ts"] }), ctx())).toMatchObject({ verdict: "accept" });
  });

  it("arquivos divididos entre dois outros boards ⇒ dúvida (vai ao modelo), não recusa", () => {
    const v = intakeRules(cand({ files: ["apps/balcao/x.ts", "ops/publicar/y.mjs"] }), ctx());
    expect(v.verdict).toBe("uncertain");
  });

  it("sem arquivos e sem citar outro board ⇒ aceita no board pedido, sem modelo", () => {
    expect(intakeRules(cand(), ctx())).toMatchObject({ verdict: "accept" });
  });

  it("sem arquivos, mas o texto fala de OUTRO board ⇒ dúvida", () => {
    const v = intakeRules(cand({ body: "Isto é do Galpão: a etapa de publicar trava." }), ctx());
    expect(v).toMatchObject({ verdict: "uncertain" });
    expect((v as { candidates: string[] }).candidates).toContain("galpao");
  });
});

describe("intakeRules — o padrão de criação", () => {
  it.each([
    ["curto demais", "Prazo", /curto demais/],
    ["id cru de card", "Consertar o que ficou de story-ex9790 no pedido", /id de um card/],
    ["caminho de arquivo", "Corrigir apps/oficina/pedido/prazo.ts no pedido", /caminho de arquivo/],
    ["código em crase", "Trocar `calcularPrazo()` pelo novo cálculo", /código em crase/],
    ["tudo em maiúsculas", "MOSTRAR O PRAZO DA REVISÃO", /maiúsculas/],
  ])("título %s ⇒ recusa dizendo o que corrigir", (_n, title, re) => {
    const v = intakeRules(cand({ title }), ctx());
    expect(v).toMatchObject({ verdict: "refuse", reason: "pattern" });
    expect((v as { why: string }).why).toMatch(re);
  });

  it("título longo demais ⇒ recusa", () => {
    expect(intakeRules(cand({ title: "Mostrar ".repeat(30) }), ctx())).toMatchObject({ verdict: "refuse", reason: "pattern" });
  });

  it("bug sem dizer o que acontece e o esperado ⇒ recusa; com o relato ⇒ passa", () => {
    expect(intakeRules(cand({ storyType: "bug", body: "quebrou" }), ctx())).toMatchObject({ verdict: "refuse", reason: "pattern" });
    expect(intakeRules(cand({ storyType: "bug", body: "Ao salvar o pedido o prazo some; o esperado é o prazo ficar visível." }), ctx())).toMatchObject({ verdict: "accept" });
    expect(intakeRules(cand({ storyType: "bug", bugReport: { actual: "some", expected: "aparece" } }), ctx())).toMatchObject({ verdict: "accept" });
  });

  it("user story FORA da Triagem sem critério ⇒ recusa; na Triagem ⇒ passa (a triagem cobra depois)", () => {
    expect(intakeRules(cand({ storyType: "user", landsInQuarantine: false }), ctx())).toMatchObject({ verdict: "refuse", reason: "pattern" });
    expect(intakeRules(cand({ storyType: "user", landsInQuarantine: false, acceptance: ["Dado um pedido, quando abro, então vejo o prazo"] }), ctx())).toMatchObject({ verdict: "accept" });
    expect(intakeRules(cand({ storyType: "user" }), ctx())).toMatchObject({ verdict: "accept" });
  });

  it("atividade e passo não passam pela régua de título (são nós do mapa)", () => {
    expect(intakeRules(cand({ type: "step", title: "Pagar" }), ctx())).toMatchObject({ verdict: "accept" });
  });
});

describe("intakeRules — a duplicata", () => {
  it("título quase igual a um card ABERTO ⇒ recusa apontando o existente", () => {
    const v = intakeRules(cand({ title: "Trocar a corrente da bicicleta sem perder pedido" }), ctx());
    expect(v).toMatchObject({ verdict: "refuse", reason: "duplicate", duplicateOf: "story-ex9701" });
  });

  it("o parecido que já está No ar ou arquivado não conta", () => {
    const cards = [story("story-ex9702", "Trocar a corrente da bicicleta sem perder o pedido", "concluida"), story("story-ex9703", "Trocar a corrente da bicicleta sem perder o pedido", "arquivado")];
    expect(intakeRules(cand({ title: "Trocar a corrente da bicicleta sem perder o pedido" }), ctx({ cards }))).toMatchObject({ verdict: "accept" });
  });

  it("o limiar é configurável", () => {
    const t = "Trocar a corrente e o pedal da bicicleta";
    expect(intakeRules(cand({ title: t }), ctx({ similarity: 0.95 }))).toMatchObject({ verdict: "accept" });
    expect(intakeRules(cand({ title: t }), ctx({ similarity: 0.3 }))).toMatchObject({ verdict: "refuse", reason: "duplicate" });
  });
});

describe("as peças", () => {
  it("pathsIn só pega caminho que algum board declara (URL e frase ficam de fora)", () => {
    expect(pathsIn("veja https://exemplo.test/apps/oficina e apps/oficina/a.ts, e/ou ops/publicar/x.mjs.", BOARDS).sort()).toEqual(["apps/oficina/a.ts", "ops/publicar/x.mjs"]);
  });

  it("titleProblems vazio para um título bom; jaccard e palavras", () => {
    expect(titleProblems("Mostrar o prazo de entrega da revisão no pedido")).toEqual([]);
    expect(jaccard(significantWords("Corrente da bicicleta"), significantWords("bicicleta corrente"))).toBe(1);
  });

  it("otherBoardsMentioned acha nome, id e pasta do pacote de OUTRO board", () => {
    expect(otherBoardsMentioned("no balcao de vendas", ctx())).toEqual(["balcao"]);
    expect(otherBoardsMentioned("a pasta comum quebrou", ctx())).toEqual(["galpao"]);
    expect(otherBoardsMentioned("a Oficina", ctx())).toEqual([]);
  });
});

describe("custo", () => {
  it("camada 1 em board com 500 cards: menos de 50 ms", () => {
    const cards = Array.from({ length: 500 }, (_, i) => story(`story-ex${String(1000 + i)}`, `Ajustar o item ${i} do catálogo de peças número ${i * 7}`));
    const c = ctx({ cards });
    intakeRules(cand(), c); // aquece
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) intakeRules(cand({ title: `Mostrar o prazo de entrega da revisão no pedido ${i}`, body: "toca apps/oficina/pedido/prazo.ts" }), c);
    const per = (performance.now() - t0) / 10;
    expect(per).toBeLessThan(50);
  });
});
