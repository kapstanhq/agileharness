import { describe, expect, it } from "vitest";
import { buildWsjfPrompt, parseWsjfResponse } from "./wsjf-prompt";
import { buildPriorityContext } from "./priority-context";
import type { BoardConfig, Card, StatusDef } from "./types";
import type { WsjfCall } from "./wsjf";

const STATUSES: StatusDef[] = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "priorizar", name: "Estimar" },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
  { id: "cancelado", name: "Cancelado", terminal: true },
];

const cfg = (over: Partial<BoardConfig> = {}): BoardConfig => ({
  id: "b",
  name: "B",
  statuses: STATUSES,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  ...over,
});

const card = (over: Partial<Card>): Card =>
  ({
    id: "story-x",
    type: "story",
    title: "t",
    storyType: "user",
    status: "triage",
    parent: null,
    personas: [],
    systems: [],
    links: [],
    acceptance: [],
    tasks: [],
    body: "",
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    ...over,
  }) as Card;

const wsjf = (o: Partial<WsjfCall>): WsjfCall => ({
  value: 3,
  urgency: 3,
  unlock: 3,
  size: 3,
  basis: [],
  cohortSize: 0,
  cohortAt: "",
  ...o,
});

const scored = (id: string, o: Partial<WsjfCall>) =>
  card({
    id,
    title: `titulo de ${id}`,
    status: "priorizar",
    priorityCall: { rank: 2, rationale: `porque ${id}`, source: "agent", assessedAt: "2026-07-29T00:00:00.000Z", wsjf: wsjf(o) },
  });

describe("buildWsjfPrompt", () => {
  const cards = [
    card({ id: "step-1", type: "step", title: "Um passo", status: null }),
    card({ id: "feito", title: "Capacidade que já existe", status: "concluida", parent: "step-1" }),
    scored("anc-alto", { value: 13, urgency: 8, unlock: 8, size: 2 }),
    scored("anc-baixo", { value: 1, urgency: 1, unlock: 1, size: 8 }),
    card({ id: "alvo", title: "O card a pontuar", status: "triage" }),
    card({ id: "vizinho", title: "Outro na fila", status: "triage" }),
  ];

  const promptFor = (targetIds?: string[]) =>
    buildWsjfPrompt(buildPriorityContext({ strategy: "", config: cfg({ desiredOutcome: "dobrar o WAU" }), cards, targetIds }));

  it("carrega a escala fechada e os quatro eixos", () => {
    const p = promptFor(["alvo"]);
    expect(p).toContain("1, 2, 3, 5, 8, 13");
    for (const eixo of ["VALOR", "URGÊNCIA", "DESTRAVAMENTO", "TAMANHO"]) expect(p).toContain(eixo);
  });

  it("manda pontuar CONTRA as âncoras e mostra os ordinais delas aplicados", () => {
    const p = promptFor(["alvo"]);
    expect(p).toContain("Âncoras — itens JÁ pontuados");
    expect(p).toContain("valor 13");
    expect(p).toContain("porque anc-alto"); // o porquê da âncora viaja: régua APLICADA, não descrita
  });

  it("no COLD START avisa que este lote vira a régua, em vez de fingir âncoras", () => {
    const semScore = [card({ id: "a", title: "A", status: "triage" }), card({ id: "b", title: "B", status: "triage" })];
    const p = buildWsjfPrompt(buildPriorityContext({ strategy: "", config: cfg(), cards: semScore }));
    expect(p).toContain("PRIMEIRO lote");
    expect(p).not.toContain("Âncoras — itens JÁ pontuados");
  });

  it("inclui o que o produto JÁ FAZ como contexto, e diz para NÃO pontuá-lo", () => {
    const p = promptFor(["alvo"]);
    expect(p).toContain("JÁ FAZ hoje");
    expect(p).toContain("Capacidade que já existe");
    expect(p).toMatch(/JÁ FAZ hoje \(entregue — contexto, NÃO pontue\)/);
  });

  it("NENHUM card terminal entra na lista a pontuar", () => {
    const comCancelado = [...cards, card({ id: "morto", title: "Cancelado ontem", status: "cancelado" })];
    const p = buildWsjfPrompt(buildPriorityContext({ strategy: "", config: cfg(), cards: comCancelado }));
    const secao = p.slice(p.indexOf("# Os itens a pontuar"));
    expect(secao).not.toContain("Cancelado ontem");
    expect(secao).not.toContain("Capacidade que já existe");
  });

  it("declara quantos itens está pedindo (o parser confere contra isso)", () => {
    expect(promptFor(["alvo"])).toContain("# Os itens a pontuar (1)");
    expect(promptFor()).toContain("# Os itens a pontuar (2)"); // alvo + vizinho, os sem score
  });

  it("board SEM norte declarado avisa o modelo em vez de fingir estratégia", () => {
    const p = buildWsjfPrompt(buildPriorityContext({ strategy: "", config: cfg(), cards }));
    expect(p).toContain("(não declarado — pontue com cautela e evite tiers altos)");
  });

  it("proíbe explicitamente repriorizar âncora ou fila", () => {
    expect(promptFor(["alvo"])).toContain("NÃO repriorize as âncoras nem os itens da fila");
  });

  it("um lote de 40 cards nus cabe folgado no orçamento", () => {
    const muitos = Array.from({ length: 40 }, (_, i) =>
      card({ id: `prd-${i}`, title: `Story ${i} vinda do PRD`, status: "triage" }),
    );
    const p = buildWsjfPrompt(buildPriorityContext({ strategy: "", config: cfg({ desiredOutcome: "x" }), cards: muitos }));
    expect(p.length / 3.6).toBeLessThan(6000); // ~tokens
  });
});

describe("parseWsjfResponse", () => {
  const ok = (id: string) => ({ id, value: 8, urgency: 3, unlock: 5, size: 2, rationale: "porque sim" });

  it("lê a resposta feliz", () => {
    const r = parseWsjfResponse(JSON.stringify({ items: [ok("a")] }), ["a"]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: "a", value: 8, size: 2 });
    expect(r.missing).toEqual([]);
  });

  it("tolera cercas de código e preâmbulo", () => {
    const raw = 'Claro! Aqui está:\n```json\n{"items":[{"id":"a","value":8,"urgency":3,"unlock":5,"size":2,"rationale":"x"}]}\n```';
    expect(parseWsjfResponse(raw, ["a"]).items).toHaveLength(1);
  });

  it("REPORTA o que faltou em vez de engolir — a cobertura parcial é visível", () => {
    const r = parseWsjfResponse(JSON.stringify({ items: [ok("a"), ok("b")] }), ["a", "b", "c", "d"]);
    expect(r.items).toHaveLength(2);
    expect(r.missing).toEqual(["c", "d"]);
  });

  it("descarta item FORA do conjunto pedido (não reescreve julgamento alheio)", () => {
    const r = parseWsjfResponse(JSON.stringify({ items: [ok("a"), ok("ancora-nao-pedida")] }), ["a"]);
    expect(r.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("descarta duplicata do mesmo id", () => {
    const r = parseWsjfResponse(JSON.stringify({ items: [ok("a"), { ...ok("a"), value: 1 }] }), ["a"]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].value).toBe(8);
  });

  it("coage ordinal fora da escala em vez de perder o item", () => {
    const r = parseWsjfResponse(JSON.stringify({ items: [{ ...ok("a"), value: 4, urgency: 6 }] }), ["a"]);
    expect(r.items[0]).toMatchObject({ value: 3, urgency: 5 });
  });

  it("item sem rationale não conta — a ordem sem o porquê é planilha", () => {
    const r = parseWsjfResponse(JSON.stringify({ items: [{ ...ok("a"), rationale: "  " }] }), ["a"]);
    expect(r.items).toEqual([]);
    expect(r.missing).toEqual(["a"]);
  });

  it("resposta lixo devolve tudo como faltante, sem lançar", () => {
    for (const raw of ["", "não consegui", "{", '{"items":"nope"}']) {
      expect(parseWsjfResponse(raw, ["a", "b"]).missing).toEqual(["a", "b"]);
    }
  });
});
