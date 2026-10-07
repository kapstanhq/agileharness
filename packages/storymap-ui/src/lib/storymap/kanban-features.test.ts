// O Kanban por funcionalidade — a parte pura. Cada caso é uma promessa que o dono lê no quadro:
//   • cada funcionalidade aparece UMA vez por raia, pelo item mais urgente (erro > você > rodando > pausado > fila);
//   • a funcionalidade é o passo do mapa que o card serve (o ticket de entrega herda a da story que ele serve);
//   • o estado do desenho sai da linha viva + Decidir + ritmo — nunca de um palpite por status;
//   • nenhum card some: um status fora do mapa de raias cai na raia vizinha;
//   • as caixinhas do fluxo encaixam como no protótipo (solo não empilha; até 3 de altura).
// Fixtures INVENTADAS no vocabulário da livraria de demonstração.

import { describe, expect, it } from "vitest";
import {
  agentTimeWords,
  arrivalOrder,
  kanbanColumnStatusesOf,
  columnRank,
  crateDashed,
  crateFill,
  crateProgress,
  designState,
  featureOf,
  flowCaption,
  FORGOTTEN_AFTER_MS,
  featureTitleHref,
  groupByFeature,
  groupingWords,
  itemLine,
  itemLinePrefix,
  batchKindWords,
  batchLineWords,
  kanbanLanes,
  kindOf,
  laneDesignState,
  laneIndexOf,
  offBoardTerminals,
  laneStep,
  liveArrivals,
  matchesShowMode,
  mixLabel,
  moreItemsWords,
  othersBeyondLot,
  p5place,
  quietBoardWords,
  quietLaneWords,
  showModeCounts,
  queuedIncludesWords,
  captionParts,
  tokensWords,
  visibleEntries,
  type FlowState,
} from "./kanban-features";
import { placementOrder } from "./order";
import { featureCtx } from "./feature-key";
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

const step = card("step-carrinho", { type: "step", title: "Montar o carrinho", storyType: null, parent: "act-comprar" });
const activity = card("act-comprar", { type: "activity", title: "Comprar", storyType: null });
const byIdOf = (cs: Card[]) => new Map(cs.map((c) => [c.id, c]));
/** A chave no MODO MAPA (board sem funcionalidades no PRD) — o agrupamento de antes da fase 7. */
const mapCtx = (byId: ReadonlyMap<string, Card>) => featureCtx(byId, [], false);

const CONFIG = {
  statuses: [
    { id: "triage", name: "Triagem" },
    { id: "enriquecer", name: "Especificar" },
    { id: "pronta", name: "A fazer" },
    { id: "desenvolver", name: "Desenvolver" },
    { id: "passo-novo", name: "Passo novo" },
    { id: "revisao", name: "Aprovar entrega", laneStep: true },
    { id: "merge", name: "Integrar", laneStep: true },
    { id: "concluida", name: "No ar", terminal: true },
  ],
  view: {
    lanes: [
      { id: "dono", label: "Precisa de você", statuses: [], demand: true },
      { id: "triagem", label: "Triagem", statuses: ["triage"] },
      { id: "moldando", label: "Moldando", statuses: ["enriquecer", "pronta"] },
      { id: "construindo", label: "Construindo", statuses: ["desenvolver"] },
      { id: "envio", label: "Envio", statuses: ["revisao", "merge"] },
      { id: "fim", label: "Fim", statuses: ["concluida"] },
    ],
  },
} as unknown as BoardConfig;

describe("as raias do quadro", () => {
  it("tiram a raia do dono e dão o papel pelo id do _base, senão pela estrutura", () => {
    const lanes = kanbanLanes(CONFIG);
    expect(lanes.map((l) => [l.id, l.role])).toEqual([
      ["triagem", "intake"],
      ["moldando", "shaping"],
      ["construindo", "building"],
      ["envio", "delivery"],
      ["fim", "live"],
    ]);
  });

  it("board sem raias declaradas ⇒ os passos AGRUPADOS nas raias do desenho (a coluna de sistema fica fora)", () => {
    const legacy = {
      ...CONFIG,
      view: undefined,
      columns: [
        { id: "entrada", name: "Entrada" },
        { id: "fazendo", name: "Fazendo" },
        { id: "pronto", name: "Pronto" },
        { id: "arquivo", name: "Arquivo", system: true },
      ],
      statuses: [
        { id: "triage", name: "Triagem", column: "entrada", staging: true },
        { id: "desenvolver", name: "Desenvolver", column: "fazendo", trigger: "harness-do" },
        { id: "concluida", name: "No ar", column: "pronto", terminal: true },
        { id: "arquivada", name: "Arquivada", column: "arquivo", terminal: true },
      ],
    } as unknown as BoardConfig;
    expect(kanbanLanes(legacy).map((l) => [l.id, l.statuses, l.role])).toEqual([
      ["triagem", ["triage"], "intake"],
      ["construindo", ["desenvolver"], "building"],
      ["noar", ["concluida"], "live"],
    ]);
  });

  it("board sem raias e sem colunas ⇒ no MÁXIMO seis raias; passo sem sinal herda o papel do anterior", () => {
    const lanes = kanbanLanes({ ...CONFIG, view: undefined, columns: undefined });
    // nenhum passo do CONFIG tem skill: a posição manda — tudo antes da entrega colapsada fica na Triagem
    expect(lanes.map((l) => [l.id, l.statuses])).toEqual([
      ["triagem", ["triage", "enriquecer", "pronta", "desenvolver", "passo-novo"]],
      ["entrega", ["revisao", "merge"]],
      ["noar", ["concluida"]],
    ]);
  });

  it("pipeline próprio de 19 passos ⇒ seis raias pela skill e pelo gate; só o terminal de ENTREGA é No ar", () => {
    const own = {
      statuses: [
        { id: "entrada", name: "Entrada", staging: true },
        { id: "especificar", name: "Especificar", trigger: "harness-enrich" },
        // a priorização saiu na fase 5 (sem skill de pontuar): o passo de triagem com skill é o da captura
        { id: "capturar", name: "Capturar", trigger: "harness-capture" },
        { id: "aprovada", name: "Aprovada" },
        { id: "desenhar", name: "Desenhar", trigger: "harness-ux" },
        { id: "desenho-ok", name: "Desenho ok" },
        { id: "planejar", name: "Planejar", trigger: "harness-plan" },
        { id: "tarefas", name: "Tarefas", trigger: "harness-tasks" },
        { id: "codar", name: "Codar", trigger: "harness-do" },
        { id: "revisar", name: "Revisar", trigger: "harness-review" },
        { id: "testar", name: "Testar", trigger: "harness-qa" },
        { id: "aceite", name: "Aceite", gate: "hasQaPassed" },
        { id: "melhorar", name: "Melhorar", trigger: "harness-refine" },
        { id: "consertar", name: "Consertar", trigger: "harness-fix" },
        { id: "aposentar", name: "Aposentar", trigger: "harness-retire" },
        { id: "publicada", name: "Publicada", terminal: true, delivered: true },
        { id: "guardada", name: "Guardada", terminal: true },
        { id: "repetida", name: "Repetida", terminal: true },
        { id: "desistida", name: "Desistida", terminal: true },
      ],
    } as unknown as BoardConfig;
    const lanes = kanbanLanes(own);
    expect(lanes.map((l) => [l.id, l.role, l.statuses])).toEqual([
      ["triagem", "intake", ["entrada", "capturar", "aprovada"]],
      ["moldando", "shaping", ["especificar", "desenhar", "desenho-ok", "melhorar", "consertar", "aposentar"]],
      ["construindo", "building", ["planejar", "tarefas", "codar"]],
      ["verificando", "verifying", ["revisar", "testar"]],
      ["entrega", "delivery", ["aceite"]],
      ["noar", "live", ["publicada"]],
    ]);
    // o terminal que não é entrega sai do Kanban (como o arquivo do `_base`) — nunca aparece «no ar»
    expect(laneIndexOf("guardada", lanes, own)).toBe(-1);
    expect(laneIndexOf("desistida", lanes, own)).toBe(-1);
    expect(laneIndexOf("publicada", lanes, own)).toBe(5);
  });

  it("um status NÃO terminal fora de toda raia nunca cai no No ar (mesmo vindo logo depois do terminal)", () => {
    const cfg = {
      statuses: [
        { id: "entrada", name: "Entrada", staging: true },
        { id: "codar", name: "Codar", trigger: "harness-do" },
        { id: "publicada", name: "Publicada", terminal: true },
        { id: "oculto", name: "Oculto", hidden: true },
      ],
    } as unknown as BoardConfig;
    const lanes = kanbanLanes(cfg);
    expect(lanes.map((l) => l.id)).toEqual(["triagem", "construindo", "noar"]);
    expect(laneIndexOf("oculto", lanes, cfg)).toBe(1);
  });

  it("um status que nenhuma raia lista cai na raia do status ANTERIOR (nunca some)", () => {
    const lanes = kanbanLanes(CONFIG);
    expect(laneIndexOf("desenvolver", lanes, CONFIG)).toBe(2);
    expect(laneIndexOf("passo-novo", lanes, CONFIG)).toBe(2);
    expect(laneIndexOf("desconhecido", lanes, CONFIG)).toBe(0);
    expect(laneIndexOf(null, lanes, CONFIG)).toBe(0);
  });

  it("o passo dentro da raia: «i de n» com o nome do board", () => {
    const moldando = kanbanLanes(CONFIG)[1];
    expect(laneStep("pronta", moldando, CONFIG)).toEqual({ index: 2, total: 2, name: "A fazer" });
    expect(laneStep("passo-novo", moldando, CONFIG)).toEqual({ index: 0, total: 2, name: "Passo novo" });
  });
});

describe("a funcionalidade e o tipo", () => {
  it("o passo do mapa que o card tem por pai é a funcionalidade", () => {
    const s = card("story-ex9801", { parent: step.id, title: "Ver o frete antes de pagar" });
    expect(featureOf(s, byIdOf([step, activity, s]))).toEqual({ id: step.id, title: "Montar o carrinho", self: false });
  });

  it("o ticket de entrega que SERVE uma story herda a funcionalidade dela", () => {
    const s = card("story-ex9802", { parent: step.id });
    const t = card("story-ex9803", { storyType: "technical", serves: s.id, parent: null });
    expect(featureOf(t, byIdOf([step, s, t])).id).toBe(step.id);
  });

  it("sem pai, o próprio card é a funcionalidade (e o item some)", () => {
    const s = card("story-ex9804", { title: "Lista de desejos" });
    expect(featureOf(s, byIdOf([s]))).toEqual({ id: s.id, title: "Lista de desejos", self: true });
  });

  it("um `serves` que não resolve cai no `parent` — o card continua na funcionalidade do pai", () => {
    const s = card("story-ex9807", { parent: step.id, serves: "story-ex9899" });
    expect(featureOf(s, byIdOf([step, activity, s]))).toEqual({ id: step.id, title: "Montar o carrinho", self: false });
  });

  it("ciclo de serves não trava", () => {
    const a = card("story-ex9805", { serves: "story-ex9806" });
    const b = card("story-ex9806", { serves: "story-ex9805" });
    expect(featureOf(a, byIdOf([a, b])).id).toBe("story-ex9806");
  });

  it("bug (ou modo de conserto) = Correção; chore = Manutenção; o resto = Novidade", () => {
    expect(kindOf({ storyType: "bug" })).toBe("Correção");
    expect(kindOf({ storyType: "user", mode: "fix" })).toBe("Correção");
    expect(kindOf({ storyType: "chore" })).toBe("Manutenção");
    expect(kindOf({ storyType: "technical" })).toBe("Novidade");
    expect(kindOf({ storyType: null })).toBe("Novidade");
  });
});

describe("o estado do desenho", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const base = { live: null, owner: false, boardPaused: false, now };

  it("a decisão do dono vence tudo", () => {
    expect(designState({ ...base, owner: true, live: { kind: "working", presence: "working" } })).toBe("attention");
  });

  it("parou e ninguém cuida = erro; trabalho provado = rodando (pausado deixando terminar, ainda rodando)", () => {
    expect(designState({ ...base, live: { kind: "stopped", presence: "stopped" } })).toBe("error");
    expect(designState({ ...base, boardPaused: true, live: { kind: "working", presence: "working" } })).toBe("running");
    expect(designState({ ...base, boardPaused: true, pauseMode: "drain", live: { kind: "working", presence: "working" } })).toBe("running");
  });

  it("board pausado: o que RODAVA vira pausado (parado agora, ou quando o passo acabou); a fila continua fila", () => {
    expect(designState({ ...base, boardPaused: true, pauseMode: "stop", live: { kind: "working", presence: "working" } })).toBe("paused");
    expect(designState({ ...base, boardPaused: true, live: { kind: "quiet", presence: "waiting" } })).toBe("paused");
    expect(designState({ ...base, boardPaused: true, live: { kind: "queued", presence: "waiting" } })).toBe("waiting");
    expect(designState({ ...base, boardPaused: true, live: { kind: "waiting", presence: "waiting" } })).toBe("queued");
    expect(designState({ ...base, boardPaused: true })).toBe("queued");
  });

  it("a fila do condutor = esperando condutor; a vez do sistema = entregando", () => {
    expect(designState({ ...base, live: { kind: "queued", presence: "waiting" } })).toBe("waiting");
    expect(designState({ ...base, live: { kind: "quiet", presence: "waiting" } })).toBe("queued");
    expect(designState({ ...base, live: { kind: "integrating", presence: "delivering" } })).toBe("delivering");
    expect(designState({ ...base, live: { kind: "live", presence: "live" } })).toBe("live");
  });

  it("sem ator: esquecido depois de 5 dias sem escrita — o adiado e o bloqueado nunca", () => {
    const old = now - FORGOTTEN_AFTER_MS - 1;
    expect(designState({ ...base, updatedMs: old })).toBe("forgotten");
    expect(designState({ ...base, updatedMs: old, deferred: true })).toBe("queued");
    expect(designState({ ...base, updatedMs: old, blocked: true })).toBe("queued");
    expect(designState({ ...base, updatedMs: now - 1000 })).toBe("queued");
  });
});

describe("o agrupamento por funcionalidade", () => {
  const s1 = card("story-ex9811", { parent: step.id, order: 30 });
  const s2 = card("story-ex9812", { parent: step.id, order: 10 });
  const s3 = card("story-ex9813", { title: "Cupom na primeira compra", order: 20 });
  const s4 = card("story-ex9814", { title: "Busca por autor", order: 5 });
  const byId = byIdOf([step, activity, s1, s2, s3, s4]);
  const states: Record<string, FlowState> = { "story-ex9811": "error", "story-ex9812": "queued", "story-ex9813": "running", "story-ex9814": "queued" };
  const stateOf = (id: string) => states[id];

  it("uma entrada por funcionalidade, pelo item mais urgente; a coluna ordena erro, você, rodando, resto", () => {
    const entries = groupByFeature([s1, s2, s3, s4], stateOf, mapCtx(byId));
    expect(entries.map((e) => [e.key, e.items.map((i) => i.id)])).toEqual([
      [step.id, ["story-ex9811", "story-ex9812"]],
      ["story-ex9813", ["story-ex9813"]],
      ["story-ex9814", ["story-ex9814"]],
    ]);
  });

  it("o recorte mostra a entrada pelo item que passa, e o «+N» conta os outros da raia", () => {
    const entries = groupByFeature([s1, s2, s3, s4], stateOf, mapCtx(byId));
    const onlyQueued = visibleEntries(entries, stateOf, (c) => matchesShowMode(stateOf(c.id), "queued"));
    expect(onlyQueued.map((e) => [e.key, e.item.id, e.more])).toEqual([
      ["story-ex9814", "story-ex9814", 0],
      [step.id, "story-ex9812", 1],
    ]);
    const exc = visibleEntries(entries, stateOf, (c) => matchesShowMode(stateOf(c.id), "exc"));
    expect(exc.map((e) => [e.item.id, e.state])).toEqual([
      ["story-ex9811", "error"],
      ["story-ex9813", "running"],
    ]);
  });

  it("o «+N» do card diz o QUE são os outros itens: a mistura de tipos", () => {
    expect(moreItemsWords([])).toBe("");
    expect(moreItemsWords([{ storyType: "bug" }])).toBe("+1 correção desta funcionalidade");
    expect(moreItemsWords([{ storyType: "user" }, { storyType: "user" }])).toBe("+2 novidades desta funcionalidade");
    expect(moreItemsWords([{ storyType: "user" }, { storyType: "chore" }, { storyType: "user" }])).toBe(
      "+3 itens desta funcionalidade · 2 novidades, 1 manutenção",
    );
    const entries = groupByFeature([s1, s2, s3, s4], stateOf, mapCtx(byId));
    const all = visibleEntries(entries, stateOf, () => true);
    expect(all.find((e) => e.key === step.id)?.others.map((c) => c.id)).toEqual(["story-ex9812"]);
  });

  it("a lista que o «+N» abre leva o estado de cada outro item, na mesma ordem (do mais urgente ao menos)", () => {
    const s5 = card("story-ex9815", { parent: step.id, order: 40, storyType: "bug" });
    const st: Record<string, FlowState> = { ...states, "story-ex9815": "attention" };
    const of = (id: string) => st[id];
    const entries = groupByFeature([s1, s2, s5], of, mapCtx(byIdOf([step, activity, s1, s2, s5])));
    const [e] = visibleEntries(entries, of, () => true);
    expect(e.item.id).toBe("story-ex9811");
    expect(e.others.map((c) => c.id)).toEqual(["story-ex9815", "story-ex9812"]);
    expect(e.otherStates).toEqual(["attention", "queued"]);
  });

  it("a ordem da coluna", () => {
    expect(["queued", "running", "attention", "error"].map((s) => columnRank(s as FlowState))).toEqual([3, 2, 1, 0]);
  });

  // A ORDEM DO TRABALHO é a posição (fase 5, sem prioridade): dentro de cada estado do desenho, a coluna anda pelo
  // `order` do card — nunca por quem foi mexido por último. «Fazer antes» grava um `order` menor e o card sobe.
  it("dentro do mesmo estado, a coluna anda pelo `order` (não pela data da última mudança)", () => {
    const a = card("story-ex9821", { title: "Lista de desejos", order: 50, updatedMs: 9_000 });
    const b = card("story-ex9822", { title: "Frete por CEP", order: 10, updatedMs: 1_000 });
    const c = card("story-ex9823", { title: "Cupom de aniversário", order: 30, updatedMs: 5_000 });
    const of = () => "queued" as FlowState;
    const ids = (cs: Card[]) => visibleEntries(groupByFeature(cs, of, mapCtx(byIdOf(cs))), of, () => true).map((e) => e.item.id);
    expect(ids([a, b, c])).toEqual(["story-ex9822", "story-ex9823", "story-ex9821"]);
    // «Fazer antes» no último: o order dele passa a ser o menor da coluna menos o passo
    expect(ids([{ ...a, order: 0 }, b, c])).toEqual(["story-ex9821", "story-ex9822", "story-ex9823"]);
    // um estado mais urgente continua na frente, qualquer que seja o order
    const erro = (id: string) => (id === "story-ex9821" ? "error" : "queued") as FlowState;
    expect(visibleEntries(groupByFeature([a, b, c], erro, mapCtx(byIdOf([a, b, c]))), erro, () => true)[0].item.id).toBe("story-ex9821");
  });
});

describe("as funcionalidades do PRD no quadro (fase 7)", () => {
  const FEATURES = [
    { id: "carrinho", name: "Carrinho de compras" },
    { id: "busca", name: "Busca no catálogo" },
  ];
  const a = card("story-ex9831", { feature: "carrinho", parent: step.id, order: 10 });
  const b = card("story-ex9832", { feature: "busca", order: 20 });
  // um ticket de entrega que serve a story `a` herda a funcionalidade dela (um salto)
  const t = card("story-ex9833", { storyType: "technical", serves: a.id, order: 30 });
  // sem funcionalidade (ou com uma que o PRD não tem mais): fora do PRD
  const u = card("story-ex9834", { parent: step.id, order: 40 });
  const v = card("story-ex9835", { feature: "nao-existe-mais", order: 50 });
  const byId = byIdOf([step, activity, a, b, t, u, v]);
  const q = () => "queued" as FlowState;

  it("agrupa pela funcionalidade do PRD, com «Outros (fora do PRD)» para o que não cabe em nenhuma", () => {
    const entries = groupByFeature([a, b, t, u, v], q, featureCtx(byId, FEATURES, true));
    expect(entries.map((e) => [e.key, e.feature.title, e.feature.source, e.items.map((i) => i.id)])).toEqual([
      ["carrinho", "Carrinho de compras", "prd", ["story-ex9831", "story-ex9833"]],
      ["busca", "Busca no catálogo", "prd", ["story-ex9832"]],
      ["outros", "Outros (fora do PRD)", "outros", ["story-ex9834", "story-ex9835"]],
    ]);
  });

  it("antes da 1ª passada da âncora, o card sem funcionalidade fica no passo do mapa (nunca um «Outros» gigante)", () => {
    const entries = groupByFeature([a, u], q, featureCtx(byId, FEATURES, false));
    expect(entries.map((e) => [e.key, e.feature.source])).toEqual([
      ["carrinho", "prd"],
      [step.id, "map"],
    ]);
  });

  it("o título leva à página da funcionalidade; o card que é a própria funcionalidade abre o item", () => {
    expect(featureTitleHref("loja", { id: "carrinho", self: false }, "/board/loja/card/story-ex9831")).toBe("/board/loja/funcionalidade/carrinho");
    expect(featureTitleHref("loja", { id: "outros", self: false }, "/x")).toBe("/board/loja/funcionalidade/outros");
    expect(featureTitleHref("loja", { id: "story-ex9836", self: true }, "/board/loja/card/story-ex9836")).toBe("/board/loja/card/story-ex9836");
  });
});

describe("a linha do item no card (fase 7)", () => {
  it("o prefixo pelo estado: as três palavras do dono, a palavra do quadro no pausado e no esquecido, nada no ar", () => {
    const all: FlowState[] = ["attention", "error", "running", "delivering", "queued", "waiting", "paused", "forgotten", "live"];
    expect(all.map(itemLinePrefix)).toEqual([
      "Precisa de você:",
      "Precisa de você:",
      "Agora:",
      "Agora:",
      "Próximo:",
      "Próximo:",
      "Pausado:",
      "Esquecido:",
      "",
    ]);
  });

  it("o lote: «Agora: 3 correções», a mistura por tipo, e o prefixo do estado", () => {
    const bug = { storyType: "bug" as const };
    const chore = { storyType: "chore" as const };
    expect(batchLineWords([bug, bug, bug])).toBe("Agora: 3 correções");
    expect(batchLineWords([bug, chore, bug])).toBe("Agora: 2 correções, 1 manutenção");
    expect(batchLineWords([bug, { storyType: "user" as const, mode: "fix" as const }], "attention")).toBe("Precisa de você: 2 correções");
    expect(batchKindWords([])).toBe("");
  });

  it("a linha diz o item, ou o lote quando 2+ itens do mesmo lote estão na raia", () => {
    const mark = (id: string) => ({ id, lead: "story-ex9841", sessionId: "sess-ex1", at: "2026-10-07T10:00:00Z" });
    const lead = card("story-ex9841", { storyType: "bug", title: "Frete some no carrinho", batch: mark("lote-ex1") });
    const mate = card("story-ex9842", { storyType: "chore", batch: mark("lote-ex1") });
    const other = card("story-ex9843", { storyType: "bug", batch: mark("lote-ex2") });
    expect(itemLine({ item: lead, state: "running", others: [mate, other] })).toEqual({ prefix: "Agora:", text: "1 correção, 1 manutenção", batch: 2 });
    // sozinho na raia (o resto do lote em outra raia), a linha volta a ser o item
    expect(itemLine({ item: lead, state: "running", others: [other] })).toEqual({ prefix: "Agora:", text: "Frete some no carrinho", batch: 0 });
    expect(itemLine({ item: card("story-ex9844", { title: "Lista de desejos" }), state: "queued", others: [] })).toEqual({
      prefix: "Próximo:",
      text: "Lista de desejos",
      batch: 0,
    });
    // a etiqueta de máquina do começo não aparece na linha (o título gravado não muda)
    const tagged = card("story-ex9845", { title: "[vigia:frete:sem_preco] Frete sem preço na loja" });
    expect(itemLine({ item: tagged, state: "queued", others: [] }).text).toBe("Frete sem preço na loja");
    expect(tagged.title).toBe("[vigia:frete:sem_preco] Frete sem preço na loja");
  });
});

describe("as frases da legenda, separadas (o «·» nunca sobra no fim da linha)", () => {
  it("separa o resto nas frases curtas, sem vazias", () => {
    expect(captionParts("2 sem condutor · 2 itens · 1 funcionalidade")).toEqual(["2 sem condutor", "2 itens", "1 funcionalidade"]);
    expect(captionParts("")).toEqual([]);
    expect(captionParts(undefined)).toEqual([]);
    expect(captionParts("Andando")).toEqual(["Andando"]);
  });
});

describe("o «+N» não conta de novo o que o lote já resume (fase 7)", () => {
  const mark = (id: string) => ({ id, lead: "story-ex9851", sessionId: "sess-ex2", at: "2026-10-07T11:00:00Z" });
  const lead = card("story-ex9851", { storyType: "bug", batch: mark("lote-ex3") });
  const mate = card("story-ex9852", { storyType: "chore", batch: mark("lote-ex3") });
  const loose = card("story-ex9853", { storyType: "chore" });

  it("o item do lote sai do «+N» quando a linha do card já é a do lote", () => {
    const entry = { item: lead, state: "running" as FlowState, others: [mate, loose], otherStates: ["running", "queued"] as FlowState[] };
    expect(itemLine(entry).text).toBe("1 correção, 1 manutenção");
    const extra = othersBeyondLot(entry);
    expect(extra.others.map((c) => c.id)).toEqual(["story-ex9853"]);
    expect(extra.states).toEqual(["queued"]);
    expect(moreItemsWords(extra.others)).toBe("+1 manutenção desta funcionalidade");
  });

  it("só o lote na raia ⇒ nada de «+N»; sem lote ⇒ os outros de sempre", () => {
    expect(othersBeyondLot({ item: lead, others: [mate], otherStates: ["running"] }).others).toEqual([]);
    const plain = card("story-ex9854", { storyType: "bug" });
    expect(othersBeyondLot({ item: plain, others: [mate, loose], otherStates: ["running", "queued"] })).toEqual({ others: [mate, loose], states: ["running", "queued"] });
    // o lote do item com UM só na raia: a linha é o item, então o «+N» segue contando os outros
    expect(othersBeyondLot({ item: lead, others: [loose], otherStates: ["queued"] }).others).toEqual([loose]);
  });
});

describe("o filtro «Mostrar»", () => {
  it("Exceções = rodando, erro, precisa de você, pausado; «Na fila» junta fila, espera de condutor e esquecido", () => {
    expect(matchesShowMode("running", "exc")).toBe(true);
    expect(matchesShowMode("queued", "exc")).toBe(false);
    expect(matchesShowMode("waiting", "queued")).toBe(true);
    expect(matchesShowMode("forgotten", "queued")).toBe(true);
    expect(matchesShowMode("live", "all")).toBe(true);
  });

  it("conta por item", () => {
    expect(showModeCounts(["running", "error", "waiting", "queued", "live"] as FlowState[])).toEqual({
      all: 5,
      running: 1,
      attention: 0,
      error: 1,
      queued: 2,
      delivering: 0,
      paused: 0,
      waiting: 1,
      forgotten: 0,
    });
  });

  it("«Na fila» conta o esquecido e quem espera condutor — e o menu diz isso, para o número bater com os cards", () => {
    const c = showModeCounts(["queued", "forgotten", "forgotten", "waiting"] as FlowState[]);
    expect(c.queued).toBe(4);
    expect(c.forgotten).toBe(2);
    expect(queuedIncludesWords(c)).toBe("inclui 1 esperando condutor e 2 esquecidos");
    expect(queuedIncludesWords({ waiting: 0, forgotten: 1 })).toBe("inclui 1 esquecido");
    expect(queuedIncludesWords({ waiting: 0, forgotten: 0 })).toBe("");
    expect(queuedIncludesWords({})).toBe("");
  });
});

describe("a legenda curta do computador baixo", () => {
  it("com o agrupamento por funcionalidade, a legenda leva o resto SEM ele (a linha única não corta no meio)", () => {
    const none = () => 0;
    expect(flowCaption("intake", { count: none, total: 11, paused: false, features: 2 })).toEqual(["Nada parado", "11 itens · 2 funcionalidades", "11 na triagem"]);
    const waiting = (s: FlowState) => (s === "waiting" ? 2 : 0);
    expect(flowCaption("building", { count: waiting, total: 2, paused: true, features: 1 })).toEqual(["Pausado", "2 sem condutor · 2 itens · 1 funcionalidade", "2 sem condutor"]);
    // sem agrupamento, nada a encurtar
    expect(flowCaption("intake", { count: none, total: 3, paused: false, features: 3 })).toEqual(["Nada parado", "3 na triagem"]);
  });
});

describe("as legendas do fluxo", () => {
  const counts = (m: Partial<Record<FlowState, number>>) => (s: FlowState) => m[s] ?? 0;

  it("as frases do protótipo, por papel", () => {
    expect(flowCaption("intake", { count: counts({ attention: 1 }), total: 2, paused: false })).toEqual(["1 espera você", "entra ou não?"]);
    expect(flowCaption("shaping", { count: counts({ error: 1, forgotten: 3 }), total: 12, paused: false })).toEqual(["1 com erro · 3 esquecidos", ""]);
    expect(flowCaption("shaping", { count: counts({}), total: 4, paused: false })).toEqual(["Andando", ""]);
    expect(flowCaption("building", { count: counts({ running: 2, waiting: 1 }), total: 3, paused: false })).toEqual(["2 rodando", "1 sem condutor"]);
    expect(flowCaption("building", { count: counts({}), total: 3, paused: true })[0]).toBe("Pausado");
    expect(flowCaption("verifying", { count: counts({}), total: 1, paused: false })).toEqual(["Em QA", ""]);
    expect(flowCaption("verifying", { count: counts({ attention: 1 }), total: 1, paused: false })).toEqual(["1 espera você", ""]);
    // a aprovação do dono mora na raia de ENTREGA no pipeline do `_base`
    expect(flowCaption("delivery", { count: counts({ attention: 1 }), total: 3, paused: false })).toEqual(["Espera seu ok", "QA pronto"]);
  
  });

  it("raia com itens que precisam de você (ou com erro) ABRE com isso — nunca «Andando» com bolinhas âmbar", () => {
    expect(flowCaption("shaping", { count: counts({ attention: 4 }), total: 19, paused: false })).toEqual(["4 esperam você", "o resto andando"]);
    expect(flowCaption("shaping", { count: counts({ attention: 4 }), total: 4, paused: false })).toEqual(["4 esperam você", ""]);
    expect(flowCaption("shaping", { count: counts({ attention: 2, error: 1, forgotten: 3 }), total: 19, paused: false })).toEqual([
      "2 esperam você · 1 com erro",
      "3 esquecidos · o resto andando",
    ]);
    expect(flowCaption("intake", { count: counts({ attention: 3 }), total: 5, paused: false })).toEqual(["3 esperam você", "entra ou não?"]);
    expect(flowCaption("intake", { count: counts({ error: 1 }), total: 5, paused: false })).toEqual(["1 com erro", "5 na triagem"]);
    expect(flowCaption("building", { count: counts({ attention: 1, running: 2, waiting: 1 }), total: 4, paused: false })).toEqual([
      "1 espera você",
      "2 rodando · 1 sem condutor",
    ]);
    expect(flowCaption("building", { count: counts({ error: 1 }), total: 2, paused: true })).toEqual(["1 com erro", "Pausado"]);
    expect(flowCaption("verifying", { count: counts({ attention: 3 }), total: 8, paused: false })).toEqual(["3 esperam você", "o resto em QA"]);
    expect(flowCaption("generic", { count: counts({ attention: 1, running: 1 }), total: 3, paused: false })).toEqual(["1 espera você", "1 rodando"]);
    // a Entrega mantém a frase do desenho; o erro entra como resto (ou abre, sem aprovação pendente)
    expect(flowCaption("delivery", { count: counts({ attention: 1, error: 1 }), total: 3, paused: false })).toEqual(["Espera seu ok", "QA pronto · 1 com erro"]);
    expect(flowCaption("delivery", { count: counts({ error: 2 }), total: 3, paused: false, avgMinutes: 11.6 })).toEqual(["2 com erro", "Gargalo · ~12 min por item"]);
  });

  it("a Triagem sem nada esperando o dono diz «Nada parado» e, em cinza, quantos estão nela (nunca um «Nada parado» seco)", () => {
    expect(flowCaption("intake", { count: counts({ queued: 13 }), total: 13, paused: false })).toEqual(["Nada parado", "13 na triagem"]);
    expect(flowCaption("intake", { count: counts({}), total: 0, paused: false })).toEqual(["Nada parado", ""]);
    expect(flowCaption("intake", { count: counts({ attention: 2 }), total: 13, paused: false })).toEqual(["2 esperam você", "entra ou não?"]);
  });

  it("o resto em cinza conta o que espera a vez: «N na fila» em Construindo sem condutor e na Entrega sem tempo medido", () => {
    expect(flowCaption("building", { count: counts({ queued: 11 }), total: 11, paused: false })).toEqual(["0 rodando", "11 na fila"]);
    expect(flowCaption("building", { count: counts({ waiting: 2 }), total: 2, paused: true })).toEqual(["Pausado", "2 sem condutor"]);
    expect(flowCaption("delivery", { count: counts({ delivering: 12 }), total: 12, paused: false, avgMinutes: null })).toEqual(["Gargalo", "12 na fila"]);
  });

  it("número que não existe é omitido, nunca inventado", () => {
    expect(flowCaption("delivery", { count: counts({}), total: 5, paused: false, avgMinutes: null })).toEqual(["Gargalo", ""]);
    expect(flowCaption("delivery", { count: counts({}), total: 5, paused: false, avgMinutes: 11.6 })).toEqual(["Gargalo", "~12 min por item"]);
    expect(flowCaption("live", { count: counts({}), total: 9, paused: false, today: 2, perDay: null })).toEqual(["+2 hoje", ""]);
    expect(flowCaption("live", { count: counts({}), total: 9, paused: false, today: 2, perDay: 1.43 })).toEqual(["+2 hoje", "1,4/dia na semana"]);
  });

  it("itens agrupados em menos cards: o resto conta os dois («11 itens · 2 funcionalidades»), e a frase de atenção segue abrindo", () => {
    expect(groupingWords(11, 2)).toBe("11 itens · 2 funcionalidades");
    expect(groupingWords(2, 1)).toBe("2 itens · 1 funcionalidade");
    // cada item é o seu card: nada a explicar
    expect(groupingWords(3, 3)).toBe("");
    expect(groupingWords(3, undefined)).toBe("");
    // a Triagem troca o «11 na triagem» pelo agrupamento (o mesmo número, e mais)
    expect(flowCaption("intake", { count: counts({ queued: 11 }), total: 11, paused: false, features: 2 })).toEqual(["Nada parado", "11 itens · 2 funcionalidades", "11 na triagem"]);
    expect(flowCaption("intake", { count: counts({ queued: 4 }), total: 4, paused: false, features: 4 })).toEqual(["Nada parado", "4 na triagem"]);
    // a atenção e o erro continuam ABRINDO a legenda; o agrupamento vem no resto
    expect(flowCaption("intake", { count: counts({ attention: 1, queued: 10 }), total: 11, paused: false, features: 2 })).toEqual([
      "1 espera você",
      "entra ou não? · 11 itens · 2 funcionalidades",
      "entra ou não?",
    ]);
    expect(flowCaption("shaping", { count: counts({}), total: 5, paused: false, features: 2 })).toEqual(["Andando", "5 itens · 2 funcionalidades", ""]);
    expect(flowCaption("building", { count: counts({ running: 1, queued: 2 }), total: 3, paused: false, features: 1 })).toEqual([
      "1 rodando",
      "2 na fila · 3 itens · 1 funcionalidade",
      "2 na fila",
    ]);
    // a Entrega (o trem mostra os itens) e o No ar não agrupam
    expect(flowCaption("delivery", { count: counts({}), total: 5, paused: false, avgMinutes: null, features: 1 })).toEqual(["Gargalo", ""]);
    expect(flowCaption("live", { count: counts({}), total: 9, paused: false, today: 2, perDay: null, features: 1 })).toEqual(["+2 hoje", ""]);
  });

  it("a mistura do concluído esconde a manutenção abaixo de 1/3", () => {
    expect(mixLabel(3, 2, 1)).toBe("3 novidades · 2 correções");
    expect(mixLabel(1, 0, 1)).toBe("1 novidade · 1 manutenção");
  });
});

describe("o «Exceções» sem exceção não parece vazio", () => {
  it("a coluna com itens e nenhuma exceção oferece ver todos; sem itens, só a frase", () => {
    expect(quietLaneWords(11)).toEqual({ text: "Nada fora do trilho", link: "ver os 11 itens" });
    expect(quietLaneWords(1)).toEqual({ text: "Nada fora do trilho", link: "ver o item" });
    expect(quietLaneWords(0)).toEqual({ text: "Nada fora do trilho", link: "" });
  });

  it("o board inteiro sem exceção ganha UMA linha: quantos andam e «Mostrar tudo»; com exceção (ou vazio), nenhuma", () => {
    expect(quietBoardWords(["queued", "waiting", "delivering", "forgotten"] as FlowState[])).toEqual({
      text: "Nada precisa de você agora",
      inbox: "",
      rest: "4 itens andando normalmente",
      link: "Mostrar tudo",
    });
    expect(quietBoardWords(["queued"] as FlowState[])?.rest).toBe("1 item andando normalmente");
    for (const exc of ["running", "error", "attention", "paused"] as FlowState[]) expect(quietBoardWords(["queued", exc])).toBeNull();
    expect(quietBoardWords([])).toBeNull();
  });

  it("com decisão do BOARD no Inbox (nenhuma em card), a linha não diz «nada precisa de você»: diz que é nos cards e leva ao Inbox", () => {
    expect(quietBoardWords(["queued", "queued"] as FlowState[], 1)).toEqual({
      text: "Nada nos cards precisa de você",
      inbox: "1 decisão no Inbox",
      rest: "2 itens andando normalmente",
      link: "Mostrar tudo",
    });
    expect(quietBoardWords(["queued"] as FlowState[], 3)?.inbox).toBe("3 decisões no Inbox");
    // o «0» (ou a leitura que ainda não voltou) fica com a frase de sempre
    expect(quietBoardWords(["queued"] as FlowState[], 0)?.text).toBe("Nada precisa de você agora");
    // exceção num card continua vencendo: sem linha
    expect(quietBoardWords(["attention"] as FlowState[], 2)).toBeNull();
  });
});

describe("o estado pela raia", () => {
  it("a vez em Construindo espera condutor (só com vaga de condutor); a vez na Entrega é do sistema; o resto não muda", () => {
    expect(laneDesignState("queued", "building", 2)).toBe("waiting");
    expect(laneDesignState("queued", "building", 0)).toBe("queued");
    expect(laneDesignState("queued", "delivery", 0)).toBe("delivering");
    expect(laneDesignState("attention", "delivery", 1)).toBe("attention");
    expect(laneDesignState("forgotten", "building", 1)).toBe("forgotten");
    expect(laneDesignState("queued", "shaping", 1)).toBe("queued");
  });
});

describe("as caixinhas do fluxo", () => {
  it("cada item quer a coluna do progresso; o solo não empilha; até maxH de altura", () => {
    const placed = p5place(
      [
        { id: "a", p: 1, state: "queued" as FlowState },
        { id: "b", p: 1, state: "queued" as FlowState },
        { id: "c", p: 1, state: "running" as FlowState },
        { id: "d", p: 0, state: "queued" as FlowState },
      ],
      7,
      2,
    );
    const at = Object.fromEntries(placed.map((p) => [p.item.id, [p.slot, p.lvl]]));
    expect(at).toEqual({ a: [6, 0], b: [6, 1], c: [5, 0], d: [0, 0] });
  });

  it("toda BOLINHA (precisa de você, erro) é desenhada: elas entram primeiro e empilham entre si; o que sobra é quieto", () => {
    // 8 «esperam você» + 11 na fila numa raia de 7 × 3 (a Moldando da demonstração): no protótipo só 4 bolinhas cabiam
    const list = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, p: 0.5, state: "attention" as FlowState })),
      { id: "e0", p: 0.9, state: "error" as FlowState },
      ...Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, p: i / 10, state: "queued" as FlowState })),
    ];
    const placed = p5place(list, 7, 3);
    const ids = new Set(placed.map((p) => p.item.id));
    for (const it of list.filter((x) => x.state !== "queued")) expect(ids.has(it.id), it.id).toBe(true);
    // o «+N» (o que não coube) é só de itens quietos
    expect(list.filter((x) => !ids.has(x.id)).every((x) => x.state === "queued")).toBe(true);
    // as pilhas não se misturam: numa coluna, ou só bolinhas, ou só quietas
    const kinds = new Map<number, Set<string>>();
    for (const p of placed) kinds.set(p.slot, (kinds.get(p.slot) ?? new Set()).add(p.item.state === "queued" ? "q" : "dot"));
    for (const k of kinds.values()) expect(k.size).toBe(1);
  });

  it("a caixinha com MARCA em cima (rodando, pausado, esperando condutor) segue sozinha na coluna", () => {
    const placed = p5place(
      [
        { id: "r", p: 1, state: "running" as FlowState },
        { id: "a", p: 1, state: "attention" as FlowState },
        { id: "q", p: 1, state: "queued" as FlowState },
      ],
      7,
      3,
    );
    const at = Object.fromEntries(placed.map((p) => [p.item.id, [p.slot, p.lvl]]));
    expect(at).toEqual({ a: [6, 0], r: [5, 0], q: [4, 0] });
  });

  it("quem não cabe fica de fora", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, p: 0.5, state: "running" as FlowState }));
    expect(p5place(many, 7, 3)).toHaveLength(7);
  });

  it("enche pela posição no pipeline (o p5box); a triagem não enche; a entrega vai cheia; o esquecido fica no começo", () => {
    const lanes = kanbanLanes(CONFIG); // triagem · moldando · construindo · envio · fim — 2 raias do meio
    expect(crateFill(0, { index: 1, total: 1 }, lanes)).toBe(0);
    expect(crateFill(1, { index: 1, total: 2 }, lanes)).toBe(0.25);
    expect(crateFill(1, { index: 0, total: 2 }, lanes)).toBe(0.12);
    expect(crateFill(2, { index: 1, total: 1 }, lanes)).toBe(1);
    expect(crateFill(3, { index: 1, total: 2 }, lanes)).toBe(1);
    expect(crateDashed(0, "queued")).toBe(true);
    expect(crateDashed(2, "queued")).toBe(false);
    expect(crateDashed(2, "forgotten")).toBe(true);
    expect(crateProgress({ index: 3, total: 4 }, "forgotten")).toBe(0);
    expect(crateProgress({ index: 3, total: 4 }, "queued")).toBe(0.75);
  });
});

describe("os números do custo do card", () => {
  it("tokens em palavras curtas", () => {
    expect(tokensWords(1_812_000)).toBe("1,8 M tokens");
    expect(tokensWords(450_400)).toBe("450 mil tokens");
    expect(tokensWords(980)).toBe("980 tokens");
    expect(tokensWords(0)).toBe("0 tokens");
  });

  it("tempo de agente em horas e minutos", () => {
    expect(agentTimeWords(30_000)).toBe("menos de 1 min");
    expect(agentTimeWords(12 * 60_000)).toBe("12 min");
    expect(agentTimeWords((4 * 60 + 10) * 60_000)).toBe("4 h 10 min");
    expect(agentTimeWords(2 * 3_600_000)).toBe("2 h");
  });
});

describe("a chegada ao ar", () => {
  it("é a ÚLTIMA transição para um status terminal — não a última escrita do card", () => {
    const m = liveArrivals(
      [
        { cardId: "story-ex9811", to: "concluida", at: "2026-10-01T10:00:00Z" },
        { cardId: "story-ex9811", to: "desenvolver", at: "2026-10-02T10:00:00Z" },
        { cardId: "story-ex9811", to: "concluida", at: "2026-10-03T10:00:00Z" },
        { cardId: "story-ex9812", to: "revisao", at: "2026-10-03T11:00:00Z" },
        { cardId: "story-ex9813", to: "concluida", at: "data torta" },
      ],
      new Set(["concluida"]),
    );
    expect(m.get("story-ex9811")).toBe(Date.parse("2026-10-03T10:00:00Z"));
    expect(m.has("story-ex9812")).toBe(false);
    expect(m.has("story-ex9813")).toBe(false);
  });
});

// O board REAL que optou por não herdar o pipeline (`inheritPipeline: false`, sem `view`): o Kanban não pode abrir
// vazio nele — e `/` e `/board/<id>` levam ao Kanban desde a fase 1.
describe("o board que não herda o pipeline (demo-legado)", () => {
  it("ganha raias derivadas e todo card dele cai numa delas", async () => {
    const { readBoardConfig, readCards } = await import("./repo");
    const config = await readBoardConfig("demo-legado");
    expect(config.view?.lanes ?? null).toBeNull();
    const lanes = kanbanLanes(config);
    // agrupado nas seis raias do desenho — nunca uma coluna por passo
    expect(lanes.length).toBeGreaterThan(0);
    expect(lanes.length).toBeLessThanOrEqual(6);
    // No ar só tem terminal
    const live = lanes.filter((l) => l.role === "live").flatMap((l) => l.statuses);
    for (const s of live) expect(config.statuses.find((d) => d.id === s)?.terminal, s).toBe(true);
    const stories = (await readCards("demo-legado")).filter((c) => c.type === "story");
    const off = offBoardTerminals(config);
    for (const c of stories) if (!(c.status && off.has(c.status))) expect(laneIndexOf(c.status, lanes, config), c.id).toBeGreaterThanOrEqual(0);
  });
});

// A ORDEM DO TRABALHO é a posição na coluna. Um card que CHEGA a outra coluna vai para o fim dela (FIFO); andar entre
// passos da MESMA raia não o rebaixa; «Fazer antes» o põe no topo. Antes, o card chegava com o `order` antigo (a
// posição de irmão no mapa: 10/20/30, repetida entre passos) e furava a fila ao acaso.
describe("arrivalOrder — quem chega a uma coluna vai para o fim dela", () => {
  const cfg = {
    statuses: [
      { id: "enriquecer", name: "Especificar" },
      { id: "pronta", name: "A fazer" },
      { id: "desenvolver", name: "Desenvolver" },
    ],
    view: {
      lanes: [
        { id: "moldar", label: "Moldar", statuses: ["enriquecer"] },
        { id: "fila", label: "A fazer", statuses: ["pronta"] },
        { id: "construir", label: "Construir", statuses: ["desenvolver"] },
      ],
    },
  } as unknown as BoardConfig;
  const sorted = (cards: Card[], status: string) => cards.filter((c) => c.status === status).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((c) => c.id);
  const arrive = (cards: Card[], id: string, to: string): Card[] =>
    cards.map((c) => (c.id === id ? { ...c, status: to, order: arrivalOrder(cards, cfg, c, c.status, to) ?? c.order } : c));

  it("duas chegadas seguem por chegada (mesmo com order antigo menor), e «Fazer antes» põe a segunda no topo", () => {
    let cards = [
      card("story-ex9201", { status: "pronta", order: 30 }),
      card("story-ex9202", { status: "enriquecer", order: 40 }),
      card("story-ex9203", { status: "enriquecer", order: 10 }),
    ];
    cards = arrive(cards, "story-ex9202", "pronta");
    cards = arrive(cards, "story-ex9203", "pronta"); // order antigo 10: sem a régua, furaria as duas
    expect(sorted(cards, "pronta")).toEqual(["story-ex9201", "story-ex9202", "story-ex9203"]);
    const top = placementOrder(cards, kanbanColumnStatusesOf(cfg, "pronta"), "story-ex9203", "top");
    cards = cards.map((c) => (c.id === "story-ex9203" ? { ...c, order: top ?? c.order } : c));
    expect(sorted(cards, "pronta")).toEqual(["story-ex9203", "story-ex9201", "story-ex9202"]);
  });

  it("mesma coluna, coluna vazia ou mesmo status ⇒ nada a gravar", () => {
    const same = { ...cfg, view: { lanes: [{ id: "tudo", label: "Tudo", statuses: ["enriquecer", "pronta", "desenvolver"] }] } } as unknown as BoardConfig;
    const cards = [card("story-ex9211", { status: "enriquecer", order: 5 }), card("story-ex9212", { status: "pronta", order: 50 })];
    expect(arrivalOrder(cards, same, cards[0], "enriquecer", "pronta")).toBeNull();
    expect(arrivalOrder(cards, cfg, cards[1], "pronta", "desenvolver")).toBeNull();
    expect(arrivalOrder(cards, cfg, cards[0], "enriquecer", "enriquecer")).toBeNull();
  });

  it("a coluna é a do Kanban: board sem raias declaradas usa as raias derivadas", () => {
    const bare = { statuses: cfg.statuses } as unknown as BoardConfig;
    const column = kanbanColumnStatusesOf(bare, "pronta");
    expect(column).toContain("pronta");
    expect(kanbanColumnStatusesOf(cfg, "pronta")).toEqual(["pronta"]);
  });
});
