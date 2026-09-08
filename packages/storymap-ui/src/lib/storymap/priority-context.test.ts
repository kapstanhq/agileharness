import { describe, expect, it } from "vitest";
import { prdDigest } from "./doc/prd-digest";
import { projectLegacyPrd } from "./doc/schemas/prd-legacy";
import { bodySection, cardSignal } from "./card-signal";
import { deliveredIndex, deliveredStatusIds } from "./delivered";
import { ANCHOR_COUNT, anchorSet, buildPriorityContext, hasStrategy, rankableCards, unscoredCount } from "./priority-context";
import type { BoardConfig, Card, StatusDef } from "./types";
import type { WsjfCall } from "./wsjf";

const STATUSES: StatusDef[] = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "priorizar", name: "Estimar" },
  { id: "desenvolver", name: "Desenvolver" },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
  { id: "arquivados", name: "Arquivados", terminal: true },
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

const scored = (id: string, o: Partial<WsjfCall>, rank: 0 | 1 | 2 | 3 = 2) =>
  card({
    id,
    title: id,
    status: "priorizar",
    priorityCall: { rank, rationale: `porque ${id}`, source: "agent", assessedAt: "2026-07-29T00:00:00.000Z", wsjf: wsjf(o) },
  });

// ── bodySection — as duas armadilhas reais do disco ───────────────────────────────────────────────

describe("bodySection", () => {
  const body = [
    "## Contexto & problema",
    "bla",
    "## Entrevistas (3 usuários)", // ← SUFIXO: `^## Entrevistas$` não casaria
    "### 1. Curioso — representativo",
    "- **Dores:** não tem repertório local",
    "### Síntese",
    "must-have: uma mensagem só",
    "## QA",
    "outra coisa",
  ].join("\n");

  it("casa um heading COM sufixo (o que existe no disco é `## Entrevistas (3 usuários)`)", () => {
    expect(bodySection(body, "Entrevistas")).toContain("Curioso");
  });

  it("NÃO para nos sub-headings `###` — eles são o conteúdo da seção", () => {
    const sec = bodySection(body, "Entrevistas") ?? "";
    expect(sec).toContain("Síntese");
    expect(sec).toContain("must-have");
  });

  it("para no próximo heading de mesmo nível", () => {
    expect(bodySection(body, "Entrevistas")).not.toContain("outra coisa");
  });

  it("devolve null quando a seção não existe ou o corpo é vazio", () => {
    expect(bodySection(body, "Inexistente")).toBeNull();
    expect(bodySection("", "Entrevistas")).toBeNull();
  });
});

// ── cardSignal ───────────────────────────────────────────────────────────────────────────────────

describe("cardSignal", () => {
  it("card NU produz sinal mínimo, sem lançar, com basis vazio (o caso do PRD recém-importado)", () => {
    const sig = cardSignal(card({ id: "story-nu", title: "Fazer algo" }), { config: cfg() });
    expect(sig.basis).toEqual([]);
    expect(sig.text).toContain("story-nu");
    expect(sig.text.split("\n")).toHaveLength(1);
  });

  it("registra em basis APENAS os sinais que existem de fato", () => {
    const sig = cardSignal(
      card({
        narrative: { role: "op", want: "x", soThat: "o release acontecer sem abrir 4 telas" },
        acceptance: ["Dado A, Quando B, Então C", "Dado D", "Dado E"],
        tasks: [{ id: "t1", title: "a", done: false }],
      }),
      { config: cfg() },
    );
    expect(sig.basis).toEqual(["soThat", "aceite", "esforco"]);
    expect(sig.text).toContain("aceite(3):"); // mostra 2, declara o total
  });

  it("resolve persona nos DOIS formatos do schema bimodal (prompt vs pains/gains)", () => {
    const comPrompt = cfg({ personas: [{ id: "op", name: "Operador", color: "#000", role: "O humano dono do board", prompt: "Você é..." }] });
    const comPains = cfg({ personas: [{ id: "op", name: "Operador", color: "#000", role: "O humano dono do board", pains: ["não confio no que não vi"] }] });
    const c = card({ personas: ["op"] });
    expect(cardSignal(c, { config: comPrompt }).text).toContain("Operador — O humano dono do board");
    const comDor = cardSignal(c, { config: comPains }).text;
    expect(comDor).toContain("Operador — O humano dono do board");
    expect(comDor).toContain("dor: não confio");
    // o `prompt` inteiro (que no board storymap é um system prompt longo) NUNCA entra
    expect(cardSignal(c, { config: comPrompt }).text).not.toContain("Você é");
  });

  it("severidade entra — é o insumo de urgência que faz um blocker existir na fila", () => {
    const sig = cardSignal(card({ severity: "blocker", hasWorkaround: false, frequency: "always" }), { config: cfg() });
    expect(sig.text).toContain("severidade: blocker · sem contorno");
    expect(sig.basis).toContain("severidade");
  });

  it("extrai a Síntese da entrevista quando ela existe", () => {
    const body = "## Entrevistas (3 usuários)\n### 1. Alguém\n- bla\n### Síntese\nmust-have: uma mensagem só\n## QA\nx";
    const sig = cardSignal(card({ body }), { config: cfg() });
    expect(sig.text).toContain("entrevista: must-have: uma mensagem só");
    expect(sig.basis).toContain("entrevista");
  });

  it("mantém o bloco compacto mesmo com card rico (orçamento de prompt)", () => {
    const sig = cardSignal(
      card({
        narrative: { role: "op", want: "x".repeat(400), soThat: "y".repeat(400) },
        acceptance: Array.from({ length: 8 }, (_, i) => `criterio ${i} ${"z".repeat(300)}`),
        tasks: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: "a", done: false })),
        body: `## Entrevistas (3)\n### Síntese\n${"w".repeat(2000)}`,
      }),
      { config: cfg() },
    );
    expect(sig.text.length).toBeLessThan(900);
  });
});

// ── delivered ────────────────────────────────────────────────────────────────────────────────────

describe("deliveredIndex — FAIL-CLOSED", () => {
  const entregue = (id: string, title: string, parent: string | null = "step-1") =>
    card({ id, title, status: "concluida", parent, systems: ["web"] });

  it("board SEM a faceta declarada ⇒ índice VAZIO (nunca inventa capacidade)", () => {
    const semFaceta = cfg({ statuses: STATUSES.map((s) => ({ ...s, delivered: undefined })) });
    const out = deliveredIndex([entregue("a", "Coisa entregue")], semFaceta);
    expect(deliveredStatusIds(semFaceta).size).toBe(0);
    expect(out).toEqual({ text: "", count: 0, anchors: 0 });
  });

  it("terminal ≠ entregue — cancelado/arquivado NÃO viram capacidade viva", () => {
    const cards = [
      entregue("a", "Responder com imagem"),
      card({ id: "b", title: "Ideia abandonada", status: "cancelado", parent: "step-1" }),
      card({ id: "c", title: "Duplicado", status: "arquivados", parent: "step-1" }),
      card({ id: "step-1", type: "step", title: "Receber a resposta", status: null }),
    ];
    const out = deliveredIndex(cards, cfg());
    expect(out.count).toBe(1);
    expect(out.text).toContain("Responder com imagem");
    expect(out.text).not.toContain("Ideia abandonada");
    expect(out.text).not.toContain("Duplicado");
  });

  it("agrupa por âncora do mapa, com o título do nó como cabeçalho", () => {
    const cards = [
      card({ id: "step-1", type: "step", title: "Receber a resposta", status: null }),
      entregue("a", "Responder com imagem"),
      entregue("b", "Formatar no WhatsApp"),
    ];
    const out = deliveredIndex(cards, cfg());
    expect(out.anchors).toBe(1);
    expect(out.text).toBe("### Receber a resposta\n- Responder com imagem [web]\n- Formatar no WhatsApp [web]");
  });

  it("card entregue sem lugar no mapa não é perdido", () => {
    const out = deliveredIndex([entregue("a", "Solta", null)], cfg());
    expect(out.text).toContain("Sem lugar no mapa");
  });
});

// ── âncoras + contexto ───────────────────────────────────────────────────────────────────────────

describe("anchorSet — a calibração que faz a pontuação incremental funcionar", () => {
  it("cobre a FAIXA (topo e base inclusos), não uma amostra do meio", () => {
    const cards = [
      scored("alto", { value: 13, urgency: 13, unlock: 13, size: 1 }), // 39
      scored("m1", { value: 8, urgency: 5, unlock: 5, size: 3 }), // 6
      scored("m2", { value: 3, urgency: 3, unlock: 3, size: 3 }), // 3
      scored("m3", { value: 2, urgency: 2, unlock: 2, size: 5 }), // 1,2
      scored("baixo", { value: 1, urgency: 1, unlock: 1, size: 13 }), // 0,23
    ];
    const ids = anchorSet(cards).map((c) => c.id);
    expect(ids).toContain("alto");
    expect(ids).toContain("baixo");
    expect(ids).toHaveLength(ANCHOR_COUNT);
  });

  it("é DETERMINÍSTICO — mesmo board, mesmo conjunto (re-pontuar não muda a régua)", () => {
    const cards = Array.from({ length: 20 }, (_, i) => scored(`s${i}`, { value: 3, urgency: 3, unlock: 3, size: ((i % 5) + 1) as never }));
    expect(anchorSet(cards).map((c) => c.id)).toEqual(anchorSet([...cards].reverse()).map((c) => c.id));
  });

  it("ignora cards sem score e devolve vazio no COLD START", () => {
    expect(anchorSet([card({ id: "a" }), card({ id: "b" })])).toEqual([]);
  });

  it("com poucos pontuados, devolve todos", () => {
    expect(anchorSet([scored("a", {}), scored("b", {})])).toHaveLength(2);
  });
});

describe("buildPriorityContext", () => {
  const base = [
    card({ id: "step-1", type: "step", title: "Um passo", status: null }),
    card({ id: "entregue-1", title: "Já no ar", status: "concluida", parent: "step-1" }),
    scored("anc-1", { value: 13, urgency: 8, unlock: 8, size: 2 }),
    scored("anc-2", { value: 1, urgency: 1, unlock: 1, size: 8 }),
    card({ id: "novo-1", title: "Card novo", status: "triage" }),
    card({ id: "novo-2", title: "Outro novo", status: "triage" }),
  ];

  it("rankableCards exclui terminais e cards sem status", () => {
    expect(rankableCards(base, cfg()).map((c) => c.id).sort()).toEqual(["anc-1", "anc-2", "novo-1", "novo-2"]);
  });

  it("sem targetIds, os ALVOS são exatamente os ranqueáveis sem score (o semeio)", () => {
    const ctx = buildPriorityContext({ config: cfg(), cards: base, strategy: "" });
    expect(ctx.targets.map((c) => c.id).sort()).toEqual(["novo-1", "novo-2"]);
    expect(unscoredCount(base, cfg())).toBe(2);
  });

  it("com targetIds, pontua só aquele card — o caminho INCREMENTAL", () => {
    const ctx = buildPriorityContext({ config: cfg(), cards: base, strategy: "", targetIds: ["novo-1"] });
    expect(ctx.targets.map((c) => c.id)).toEqual(["novo-1"]);
    expect(ctx.anchorsText).toContain("valor 13"); // as âncoras viajam junto
  });

  it("um card NUNCA é sua própria âncora", () => {
    const ctx = buildPriorityContext({ config: cfg(), cards: base, strategy: "", targetIds: ["anc-1"] });
    expect(ctx.anchors.map((a) => a.id)).not.toContain("anc-1");
  });

  it("NENHUM card entregue aparece entre os ranqueáveis, mas o entregue vira CONTEXTO", () => {
    const ctx = buildPriorityContext({ config: cfg(), cards: base, strategy: "" });
    expect(ctx.targetsText).not.toContain("Já no ar");
    expect(ctx.queueText).not.toContain("Já no ar");
    expect(ctx.deliveredText).toContain("Já no ar");
    expect(ctx.deliveredCount).toBe(1);
  });

  it("a fila mostra o score de quem já tem e marca quem não tem", () => {
    const ctx = buildPriorityContext({ config: cfg(), cards: base, strategy: "", targetIds: ["novo-1"] });
    expect(ctx.queueText).toContain("(sem avaliação)");
  });

  it("cohortSize conta os ranqueáveis, não o board inteiro", () => {
    expect(buildPriorityContext({ config: cfg(), cards: base, strategy: "" }).cohortSize).toBe(4);
  });

  it("hasStrategy detecta um board sem norte declarado", () => {
    expect(hasStrategy("")).toBe(false);
    expect(hasStrategy("   \n  ")).toBe(false);
    expect(hasStrategy("Resultado-alvo: dobrar o WAU")).toBe(true);
  });

  it("um board que declarou a escada ANTIGA continua tendo norte depois da migração", () => {
    // A cadeia inteira, que é a promessa da migração preguiçosa: `board.yaml` → projeção do PRD →
    // digest → gate de priorização. Se ela quebrar, um board que sempre teve norte passaria a ser
    // tratado como board sem norte — e a tela pararia de pontuar sem ninguém ter mudado nada.
    expect(hasStrategy(prdDigest(projectLegacyPrd(cfg({ desiredOutcome: "dobrar o WAU" }))))).toBe(true);
    expect(prdDigest(projectLegacyPrd(cfg({ desiredOutcome: "dobrar o WAU" })))).toContain("dobrar o WAU");
    expect(hasStrategy(prdDigest(projectLegacyPrd(cfg())))).toBe(false);
  });
});
