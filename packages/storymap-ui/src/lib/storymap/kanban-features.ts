// O KANBAN POR FUNCIONALIDADE — a parte pura do quadro novo (fase 1 do redesenho: o fluxo vira o cabeçalho das
// colunas e cada informação aparece uma vez só).
//
// O dono lê o Kanban perguntando «onde está cada coisa que estou construindo e o que precisa de mim». Um card por
// story respondia a pergunta errada: uma funcionalidade com quatro itens ocupava quatro cards na mesma coluna, e o que
// importava (o item parado com erro) ficava no meio deles. Aqui cada FUNCIONALIDADE aparece UMA vez por raia,
// representada pelo seu item mais urgente ali; os outros viram «+N itens aqui».
//
// Tudo o que o quadro decide sem tocar React mora aqui, e cada regra tem teste (kanban-features.test.ts):
//   • as RAIAS do quadro (board.yaml `view.lanes`, sem a raia do dono — «precisa de você» é ESTADO do card agora);
//   • a FUNCIONALIDADE de um card (a do PRD — feature-key.ts; sem funcionalidades no PRD, o passo do mapa que ele
//     serve) e o TIPO dele (Novidade / Correção / Manutenção);
//   • a LINHA do item no card: o prefixo pelo estado («Agora:», «Próximo:», «Precisa de você:») e o lote;
//   • o ESTADO do desenho, da linha de estado viva (card-live-status.ts) + a decisão do dono + o ritmo do board;
//   • o agrupamento, a escolha do item, a ordem dentro da coluna e as contagens do filtro «Mostrar»;
//   • as LEGENDAS do fluxo e o encaixe das caixinhas (o `p5place` do protótipo).
//
// PURO e isomórfico (zero `node:*`, zero React). Nada aqui conhece um id de status: as raias e os status vêm da config.

import { boardLanes } from "./lanes";
import { kanbanColumnStatuses } from "./views";
import { placementOrder } from "./order";
import { featureHref } from "./deep-links";
import { featureKeyOf, type FeatureCtx, type FeatureKey } from "./feature-key";
import { displayTitle } from "./display-title";
import type { CardLiveKind, CardPresence } from "./card-live-status";
import type { BoardConfig, Card } from "./types";

// ── os estados do desenho ───────────────────────────────────────────────────────────────────────────

/**
 * O estado de um item no quadro novo. Diferente das seis presenças (presence-tone.ts): o desenho separa o que espera
 * VAGA de condutor (`waiting`) do que só está na fila da etapa (`queued`), o board pausado (`paused`) e o item que
 * ficou para trás (`forgotten`). `live` = no ar (a raia do fim do fluxo).
 */
export type FlowState = "running" | "waiting" | "error" | "attention" | "queued" | "delivering" | "paused" | "forgotten" | "live";

/** O que o filtro «Mostrar» escolhe (o MESMO union de `KanbanShowMode`, do componente da barra). */
export type ShowMode = "exc" | "all" | "running" | "attention" | "error" | "queued" | "delivering" | "paused";

/** Os estados que o modo «Exceções» mostra como card — o resto aparece só como caixinha no fluxo. */
export const EXCEPTION_STATES: ReadonlySet<FlowState> = new Set(["running", "error", "attention", "paused"]);

/** O rótulo de cada estado, em português simples (o mesmo do protótipo). */
export const FLOW_STATE_LABEL: Readonly<Record<FlowState, string>> = {
  running: "Rodando",
  waiting: "Esperando condutor",
  error: "Erro",
  attention: "Precisa de você",
  queued: "Na fila",
  delivering: "Sistema entregando",
  paused: "Pausado",
  forgotten: "Esquecido",
  live: "No ar",
};

/** Sem atividade há mais que isto (e sem nada bloqueando) = esquecido. */
export const FORGOTTEN_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

export interface DesignStateInput {
  /** a linha de estado viva do card (card-live-status.ts) — null = nada vivo nem provado. */
  live: { kind: CardLiveKind; presence: CardPresence } | null;
  /** o card está no Decidir do Inbox (a única fonte de «precisa de você»). */
  owner: boolean;
  /** o ritmo do board segura tudo agora (pausado). */
  boardPaused: boolean;
  /** como a pausa trata o que já roda: `drain` (deixa terminar o passo) ou `stop` (guarda e para). Ausente = drain. */
  pauseMode?: "drain" | "stop";
  /** a última escrita do card (epoch ms) — a idade de quem não tem ator. */
  updatedMs?: number;
  /** o card foi guardado para depois pelo dono («Adiar») — nunca é «esquecido». */
  deferred?: boolean;
  /** o card tem um bloqueio aberto (aviso `blocker`) — parado por motivo, não esquecido. */
  blocked?: boolean;
  now: number;
}

/**
 * O estado do desenho de um item. PURA. A ordem, e por quê:
 *   1. a decisão do DONO vence tudo (é o que o dono abre o quadro para achar);
 *   2. parou e ninguém cuida (falha, conflito, prompt sem resposta) = erro;
 *   3. trabalho PROVADO agora = rodando; com o board pausado no modo «Parar agora» ele é «pausado» (o desenho pausa
 *      o que roda junto com o board);
 *   4. a vez do sistema = entregando; no ar = no ar;
 *   5. a espera: a sessão que PAROU com o board pausado (o que rodava e terminou o passo) é «pausado»; na fila do
 *      condutor é «esperando condutor»; o resto, «na fila» — o que só esperava a vez continua na fila (o desenho).
 *   6. sem ator nenhum: «esquecido» depois de 5 dias sem escrita (o adiado e o bloqueado nunca), senão «na fila».
 *
 * DESVIO CONSCIENTE do desenho: no modo «Deixar terminar», quem ainda trabalha com prova continua «rodando» até
 * terminar o passo — dizer «Terminou o passo atual e parou» de um agente que ainda escreve seria mentir. Assim que o
 * passo acaba (a sessão fica quieta), ele vira «pausado», como no desenho.
 */
export function designState(input: DesignStateInput): FlowState {
  const { live, owner, boardPaused, pauseMode, updatedMs, deferred, blocked, now } = input;
  if (owner) return "attention";
  if (live) {
    switch (live.presence) {
      case "owner":
        return "attention";
      case "stopped":
        return "error";
      case "working":
        return boardPaused && pauseMode === "stop" ? "paused" : "running";
      case "delivering":
        return "delivering";
      case "live":
        return "live";
      case "waiting":
        if (live.kind === "queued") return "waiting";
        if (boardPaused && live.kind === "quiet") return "paused";
        return "queued";
    }
  }
  // `now` 0 = o relógio ainda não andou (o 1º render, igual ao do servidor): ninguém é esquecido antes do mount.
  if (!deferred && !blocked && now > 0 && updatedMs != null && now - updatedMs > FORGOTTEN_AFTER_MS) return "forgotten";
  return "queued";
}

/**
 * O estado pela RAIA onde o item está (o `pipe5` do protótipo): o que só espera a vez em Construindo espera um
 * CONDUTOR (quando o board tem vaga de condutor — sem condutor, dizer isso seria mentir); o que espera a vez na Entrega
 * está nas mãos do SISTEMA (a publicação o leva sozinho). O resto não muda. PURA.
 */
export function laneDesignState(state: FlowState, role: LaneRole, conductorSlots: number): FlowState {
  if (state !== "queued") return state;
  if (role === "building" && conductorSlots > 0) return "waiting";
  if (role === "delivery") return "delivering";
  return state;
}

/** A urgência de um item para representar a funcionalidade: erro > precisa de você > rodando > pausado > fila. */
const URGENCY: Readonly<Record<FlowState, number>> = {
  error: 0,
  attention: 1,
  running: 2,
  paused: 3,
  waiting: 4,
  queued: 5,
  delivering: 6,
  forgotten: 7,
  live: 8,
};

/** A ORDEM dentro da coluna: erro, precisa de você, rodando, demais. */
export function columnRank(state: FlowState): number {
  return state === "error" ? 0 : state === "attention" ? 1 : state === "running" ? 2 : 3;
}

/** O estado passa no modo «Mostrar»? «Na fila» junta a fila, a espera de condutor e o esquecido. PURA. */
export function matchesShowMode(state: FlowState, mode: ShowMode): boolean {
  if (mode === "all") return true;
  if (mode === "exc") return EXCEPTION_STATES.has(state);
  if (mode === "queued") return state === "queued" || state === "waiting" || state === "forgotten";
  return state === mode;
}

/**
 * As contagens do filtro «Mostrar». `all` = todos; os outros pela mesma regra do filtro — e, À PARTE, o que «Na fila»
 * junta além da fila: quem espera condutor (`waiting`) e o esquecido (`forgotten`). O card diz «Esquecido» e «Esperando
 * condutor»; o menu conta os dois dentro de «Na fila» e diz isso (`queuedIncludesWords`) — senão o número de «Na fila»
 * não batia com o que os cards dizem. PURA.
 */
export type ShowModeCounts = Record<Exclude<ShowMode, "exc">, number> & { waiting: number; forgotten: number };

export function showModeCounts(states: Iterable<FlowState>): ShowModeCounts {
  const out = { all: 0, running: 0, attention: 0, error: 0, queued: 0, delivering: 0, paused: 0, waiting: 0, forgotten: 0 };
  for (const s of states) {
    out.all++;
    for (const m of ["running", "attention", "error", "queued", "delivering", "paused"] as const) if (matchesShowMode(s, m)) out[m]++;
    if (s === "waiting") out.waiting++;
    if (s === "forgotten") out.forgotten++;
  }
  return out;
}

/**
 * O que a linha «Na fila» do «Mostrar» junta além da fila, dito por extenso: «inclui 2 esperando condutor e 1
 * esquecido». Vazio quando é só fila. PURA.
 */
export function queuedIncludesWords(c: { waiting?: number; forgotten?: number }): string {
  const parts = [
    c.waiting ? `${c.waiting} esperando condutor` : "",
    c.forgotten ? plural(c.forgotten, "esquecido", "esquecidos") : "",
  ].filter(Boolean);
  return parts.length ? `inclui ${parts.join(" e ")}` : "";
}

/**
 * O texto da coluna que o recorte «Exceções» deixou sem card, mas que TEM itens: «Nada fora do trilho» e o atalho
 * «ver os 11 itens» (que troca o recorte para «Tudo»). Sem itens, só a frase. PURA.
 */
export function quietLaneWords(items: number): { text: string; link: string } {
  const text = "Nada fora do trilho";
  if (items <= 0) return { text, link: "" };
  return { text, link: items === 1 ? "ver o item" : `ver os ${items} itens` };
}

/**
 * A linha única sob a barra quando NENHUMA raia tem exceção no recorte «Exceções» (o board pausado, ou tudo andando,
 * parecia vazio — «Nada fora do trilho» em toda coluna): quantos itens andam e o atalho «Mostrar tudo». null = há
 * exceção em alguma raia, ou nada andando. `states` = os estados dos itens fora do No ar e do trem.
 *
 * `inboxDecisions` = as decisões do dono no Inbox deste board (o número do ícone). Sem card pedindo nada, elas são do
 * BOARD (uma proposta para o PRD, uma pergunta geral): dizer «Nada precisa de você agora» com o ícone mostrando «1»
 * era contradição. Aí a linha diz que nada nos CARDS precisa do dono e leva ao Inbox («1 decisão no Inbox»). PURA.
 */
export function quietBoardWords(
  states: readonly FlowState[],
  inboxDecisions = 0,
): { text: string; inbox: string; rest: string; link: string } | null {
  if (!states.length || states.some((s) => EXCEPTION_STATES.has(s))) return null;
  const n = states.length;
  const pending = Math.max(0, Math.floor(inboxDecisions));
  return {
    text: pending ? "Nada nos cards precisa de você" : "Nada precisa de você agora",
    inbox: pending ? `${plural(pending, "decisão", "decisões")} no Inbox` : "",
    rest: `${plural(n, "item andando", "itens andando")} normalmente`,
    link: "Mostrar tudo",
  };
}

// ── o tipo e a funcionalidade ────────────────────────────────────────────────────────────────────────

export type FeatureKind = "Novidade" | "Correção" | "Manutenção";

/** O tipo do item, para quem lê: bug (ou o modo de conserto) = Correção; chore = Manutenção; o resto = Novidade. */
export function kindOf(card: Pick<Card, "storyType" | "mode">): FeatureKind {
  if (card.storyType === "bug" || card.mode === "fix") return "Correção";
  if (card.storyType === "chore") return "Manutenção";
  return "Novidade";
}

// A funcionalidade de um card (`featureOf`, o modo mapa) e a chave de agrupamento (`featureKeyOf`) moram em
// feature-key.ts — a fonte única do Kanban, da página da funcionalidade e do despacho do condutor. Reexportadas aqui
// para quem já as importava deste módulo.
export { featureOf, featureKeyOf, OUTROS_FEATURE } from "./feature-key";
export type { FeatureRef, FeatureKey, FeatureCtx, FeatureSource } from "./feature-key";

// ── as raias ─────────────────────────────────────────────────────────────────────────────────────────

/** O PAPEL de uma raia no desenho — decide a legenda do fluxo e a coluna especial (trem / no ar). */
export type LaneRole = "intake" | "shaping" | "building" | "verifying" | "delivery" | "live" | "generic";

export interface KanbanLane {
  id: string;
  label: string;
  statuses: string[];
  role: LaneRole;
}

/** As raias do `_base` pelo id — o papel delas é o do desenho. Raia de outro board cai no papel pela estrutura. */
const ROLE_BY_ID: Readonly<Record<string, LaneRole>> = {
  triagem: "intake",
  moldando: "shaping",
  construindo: "building",
  verificando: "verifying",
  entrega: "delivery",
  noar: "live",
};

function roleOf(id: string, statuses: readonly string[], config: Pick<BoardConfig, "statuses">): LaneRole {
  if (ROLE_BY_ID[id]) return ROLE_BY_ID[id];
  const defs = statuses.map((s) => config.statuses.find((d) => d.id === s)).filter((d) => !!d);
  if (defs.length && defs.every((d) => d!.terminal === true)) return "live";
  if (defs.length && defs.every((d) => d!.laneStep === true)) return "delivery";
  return "generic";
}

/** As seis raias do desenho, na ordem do fluxo — o vocabulário em que um pipeline próprio é agrupado. */
const CANONICAL_LANES: ReadonlyArray<{ id: string; label: string; role: Exclude<LaneRole, "generic"> }> = [
  { id: "triagem", label: "Triagem", role: "intake" },
  { id: "moldando", label: "Moldando", role: "shaping" },
  { id: "construindo", label: "Construindo", role: "building" },
  { id: "verificando", label: "Verificando", role: "verifying" },
  { id: "entrega", label: "Entrega", role: "delivery" },
  { id: "noar", label: "No ar", role: "live" },
];

/**
 * O papel de um passo pela SKILL que o executa — o vocabulário da própria ferramenta (as skills `harness-*` viajam com
 * ela), não o de um produto. Um passo sem skill (uma parada humana, um passo novo) herda o papel do passo anterior.
 */
const TRIGGER_ROLE: Readonly<Record<string, LaneRole>> = {
  "harness-capture": "intake",
  "harness-grill": "shaping",
  "harness-enrich": "shaping",
  "harness-interview": "shaping",
  "harness-ux": "shaping",
  "harness-ui": "shaping",
  "harness-refine": "shaping",
  "harness-fix": "shaping",
  "harness-retire": "shaping",
  "harness-plan": "building",
  "harness-tasks": "building",
  "harness-tests": "building",
  "harness-do": "building",
  "harness-review": "verifying",
  "harness-qa": "verifying",
};

/** O papel pelo GATE de entrada, para a parada humana sem skill: entrar com o QA aprovado = esperar o ok da entrega. */
const GATE_ROLE: Readonly<Record<string, LaneRole>> = { hasQaPassed: "delivery" };

/**
 * Os status terminais que NÃO são «no ar» (arquivado, duplicado, cancelado) quando o board marca qual terminal é a
 * entrega (`delivered: true`) — o `_base` os põe na coluna de sistema (fora do Kanban, na lixeira); um pipeline
 * próprio sem essa coluna recebe a mesma regra aqui. Sem nenhum terminal marcado, todo terminal é o fim do fluxo. PURA.
 */
export function offBoardTerminals(config: Pick<BoardConfig, "statuses">): Set<string> {
  const terminals = config.statuses.filter((s) => s.terminal === true);
  if (!terminals.some((s) => s.delivered === true)) return new Set();
  return new Set(terminals.filter((s) => s.delivered !== true).map((s) => s.id));
}

/**
 * As raias de um board que NÃO declara `view.lanes` (o que optou por não herdar o pipeline do `_base`, ou um `_base`
 * de alvo sem `view`): os passos dele AGRUPADOS nas seis raias do desenho — nunca uma raia por passo (dezoito colunas
 * espremidas não se leem). PURA. O papel de cada passo que o Kanban lista (o oculto e o de sistema ficam fora):
 *   • terminal ⇒ No ar (só o que é entrega — `offBoardTerminals` tira o arquivo); NENHUM passo não terminal vai para
 *     No ar;
 *   • `laneStep` (a entrega colapsada) ⇒ Entrega; `staging` (a caixa de entrada) ⇒ Triagem;
 *   • a skill do passo (`TRIGGER_ROLE`) ou o gate de entrada (`GATE_ROLE`);
 *   • sem sinal, o papel do passo anterior (pela posição no pipeline); o primeiro sem sinal é Triagem.
 * Só as raias com algum passo aparecem, na ordem do desenho.
 */
function derivedLanes(config: Pick<BoardConfig, "statuses" | "columns">): KanbanLane[] {
  const shown = kanbanColumnStatuses(config as BoardConfig);
  const off = offBoardTerminals(config);
  const byRole = new Map<LaneRole, string[]>();
  let prev: LaneRole = "intake";
  for (const s of shown) {
    if (off.has(s.id)) continue;
    let role: LaneRole;
    if (s.terminal === true) role = "live";
    else {
      role =
        (s.laneStep === true ? "delivery" : undefined) ??
        (s.staging === true ? "intake" : undefined) ??
        (s.trigger ? TRIGGER_ROLE[s.trigger] : undefined) ??
        (s.gate ? GATE_ROLE[s.gate] : undefined) ??
        prev;
      prev = role;
    }
    byRole.set(role, [...(byRole.get(role) ?? []), s.id]);
  }
  return CANONICAL_LANES.flatMap((l) => {
    const statuses = byRole.get(l.role);
    return statuses?.length ? [{ id: l.id, label: l.label, statuses, role: l.role }] : [];
  });
}

/**
 * As raias do quadro: as do board (`view.lanes`), SEM a raia do dono — «precisa de você» é estado do card, que fica
 * na raia do status dele. Board sem raias declaradas ⇒ os passos dele agrupados nas seis raias do desenho
 * (`derivedLanes`): o quadro nunca abre vazio nem espremido. PURA.
 */
export function kanbanLanes(config: Pick<BoardConfig, "view" | "statuses" | "columns">): KanbanLane[] {
  const declared = boardLanes(config);
  if (!declared) return derivedLanes(config);
  return declared
    .filter((l) => !l.demand)
    .map((l) => ({ id: l.id, label: l.label, statuses: l.statuses, role: roleOf(l.id, l.statuses, config) }));
}

/**
 * A raia de um card pelo status. Um status que nenhuma raia lista (mapa torto, passo novo, passo oculto) NÃO some:
 * cai na raia do status anterior mais próximo na ordem do pipeline (senão do seguinte) — nunca na raia No ar, que é só
 * de status terminal. -1 sem raia nenhuma, ou para o terminal que não é entrega (arquivado, duplicado, cancelado —
 * `offBoardTerminals`): esse sai do Kanban, como o arquivo do `_base`. PURA.
 */
export function laneIndexOf(status: string | null, lanes: readonly KanbanLane[], config: Pick<BoardConfig, "statuses">): number {
  if (!lanes.length) return -1;
  if (status != null) {
    const direct = lanes.findIndex((l) => l.statuses.includes(status));
    if (direct >= 0) return direct;
    if (offBoardTerminals(config).has(status)) return -1;
    const order = config.statuses.map((s) => s.id);
    const at = order.indexOf(status);
    const terminal = config.statuses[at]?.terminal === true;
    const laneOf = (id: string) => lanes.findIndex((l) => (terminal || l.role !== "live") && l.statuses.includes(id));
    if (at >= 0) {
      for (let i = at - 1; i >= 0; i--) {
        const k = laneOf(order[i]);
        if (k >= 0) return k;
      }
      for (let i = at + 1; i < order.length; i++) {
        const k = laneOf(order[i]);
        if (k >= 0) return k;
      }
    }
  }
  return 0;
}

/**
 * Os status que formam a COLUNA do card no Kanban — a MESMA conta do quadro: a raia do status ({@link kanbanLanes},
 * declarada ou derivada) e todo status que {@link laneIndexOf} põe nela (inclusive o que nenhuma raia lista e cai ali
 * por vizinhança). É a régua de posição de «Fazer antes»/«Pode esperar» e da chegada numa coluna. Status fora do
 * quadro (sem raia) ⇒ só ele. PURA.
 */
export function kanbanColumnStatusesOf(config: Pick<BoardConfig, "view" | "statuses" | "columns">, status: string): string[] {
  const lanes = kanbanLanes(config);
  const at = laneIndexOf(status, lanes, config);
  if (at < 0) return [status];
  const ids = config.statuses.map((s) => s.id).filter((id) => laneIndexOf(id, lanes, config) === at);
  return ids.includes(status) ? ids : [...ids, status];
}

/**
 * O `order` de um card que CHEGA a outra coluna do Kanban (mudança real de status para um passo de outra raia): o FIM
 * da coluna de destino, para a fila seguir por ordem de chegada (FIFO) até o dono usar «Fazer antes». `null` = nada a
 * gravar: mesma coluna (andar entre passos da mesma raia não rebaixa quem o dono pôs no topo), coluna vazia, ou o card
 * já está depois de todos. Sem isto o card chegava com o `order` antigo (a posição de irmão no mapa) e furava a fila ao
 * acaso. PURA.
 */
export function arrivalOrder(
  cards: readonly Pick<Card, "id" | "status" | "order">[],
  config: Pick<BoardConfig, "view" | "statuses" | "columns">,
  card: Pick<Card, "id" | "order">,
  fromStatus: string | null | undefined,
  toStatus: string,
): number | null {
  if (fromStatus === toStatus) return null;
  const column = kanbanColumnStatusesOf(config, toStatus);
  if (fromStatus && column.includes(fromStatus)) return null;
  const others = cards.filter((c) => c.id !== card.id);
  return placementOrder([...others, { id: card.id, status: toStatus, order: card.order }], column, card.id, "bottom");
}

export interface LaneStep {
  /** 1-based; 0 quando o status não é um passo da raia (caiu nela por vizinhança). */
  index: number;
  total: number;
  /** o nome do passo no board. */
  name: string;
}

/** O passo do card DENTRO da raia: «Desenvolver · 2 de 3». PURA. */
export function laneStep(status: string | null, lane: Pick<KanbanLane, "statuses">, config: Pick<BoardConfig, "statuses">): LaneStep {
  const at = status != null ? lane.statuses.indexOf(status) : -1;
  const def = status != null ? config.statuses.find((s) => s.id === status) : undefined;
  return { index: at + 1, total: Math.max(1, lane.statuses.length), name: def?.name || status || "Sem etapa" };
}

// ── o agrupamento por funcionalidade ─────────────────────────────────────────────────────────────────

export interface FeatureEntry {
  /** a chave estável da entrada na raia (a funcionalidade). */
  key: string;
  /** a funcionalidade: a do PRD, o grupo «Outros (fora do PRD)» ou, no board sem funcionalidades no PRD, o passo do mapa. */
  feature: FeatureKey;
  /** os itens da funcionalidade nesta raia, do mais urgente ao menos. */
  items: Card[];
}

const byOrderThenId = (a: Card, b: Card) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

/**
 * Os cards de UMA raia agrupados por funcionalidade ({@link featureKeyOf}: a do PRD, «Outros», ou o passo do mapa no
 * board sem funcionalidades no PRD), cada grupo com os itens do mais urgente ao menos (empate: `order`, depois id). A
 * ordem dos grupos é a da coluna (erro, precisa de você, rodando, demais) pelo item que o representa. PURA.
 */
export function groupByFeature(cards: readonly Card[], stateOf: (id: string) => FlowState, ctx: FeatureCtx): FeatureEntry[] {
  const groups = new Map<string, FeatureEntry>();
  for (const c of cards) {
    const f = featureKeyOf(c, ctx);
    const g = groups.get(f.id);
    if (g) g.items.push(c);
    else groups.set(f.id, { key: f.id, feature: f, items: [c] });
  }
  const urg = (c: Card) => URGENCY[stateOf(c.id)];
  for (const g of groups.values()) g.items.sort((a, b) => urg(a) - urg(b) || byOrderThenId(a, b));
  return sortEntries([...groups.values()], stateOf);
}

function sortEntries(entries: FeatureEntry[], stateOf: (id: string) => FlowState): FeatureEntry[] {
  return entries.sort((a, b) => {
    const ra = columnRank(stateOf(a.items[0].id));
    const rb = columnRank(stateOf(b.items[0].id));
    return ra - rb || byOrderThenId(a.items[0], b.items[0]);
  });
}

export interface VisibleEntry {
  key: string;
  feature: FeatureKey;
  /** o item que representa a funcionalidade na tela (o mais urgente dos que passam no filtro). */
  item: Card;
  state: FlowState;
  /** quantos OUTROS itens da funcionalidade estão nesta raia (o «+N itens aqui»). */
  more: number;
  /** esses outros itens (o «+N» diz o que eles são — `moreItemsWords`), do mais urgente ao menos. */
  others: Card[];
  /** o estado de cada um dos outros, na mesma ordem (a bolinha da lista que o «+N» abre dentro do card). */
  otherStates: FlowState[];
}

/**
 * O «+N» do card, dito por extenso — o QUE são os outros itens da funcionalidade nesta raia: de um tipo só, o tipo
 * («+1 correção desta funcionalidade», «+3 novidades desta funcionalidade»); misturados, a mistura do desenho («5 itens
 * · 1 chore, 4 técnicas») — «+3 itens desta funcionalidade · 2 novidades, 1 manutenção». Vazio sem outros. PURA.
 */
export function moreItemsWords(others: readonly Pick<Card, "storyType" | "mode">[]): string {
  if (!others.length) return "";
  const n = others.length;
  const kinds = { n: 0, c: 0, k: 0 };
  for (const o of others) {
    const k = kindOf(o);
    if (k === "Correção") kinds.c++;
    else if (k === "Manutenção") kinds.k++;
    else kinds.n++;
  }
  const mix = [
    kinds.n ? plural(kinds.n, "novidade", "novidades") : "",
    kinds.c ? plural(kinds.c, "correção", "correções") : "",
    kinds.k ? plural(kinds.k, "manutenção", "manutenções") : "",
  ].filter(Boolean);
  if (mix.length === 1) return `+${mix[0]} desta funcionalidade`;
  return `+${n} itens desta funcionalidade · ${mix.join(", ")}`;
}

/**
 * O recorte da tela: uma entrada aparece se ALGUM item dela passa no filtro, representada pelo mais urgente dos que
 * passam; o «+N» conta os outros itens da raia (passem ou não — eles estão lá). Mantém a ordem da coluna. PURA.
 */
export function visibleEntries(entries: readonly FeatureEntry[], stateOf: (id: string) => FlowState, pass: (card: Card) => boolean): VisibleEntry[] {
  const out: VisibleEntry[] = [];
  for (const e of entries) {
    const item = e.items.find(pass);
    if (!item) continue;
    const others = e.items.filter((c) => c !== item);
    out.push({ key: e.key, feature: e.feature, item, state: stateOf(item.id), more: others.length, others, otherStates: others.map((c) => stateOf(c.id)) });
  }
  return out.sort((a, b) => columnRank(a.state) - columnRank(b.state) || byOrderThenId(a.item, b.item));
}

// ── a linha do item no card (fase 7) ────────────────────────────────────────────────────────────────

/**
 * O PREFIXO da linha do item no card e nas linhas do «+N»: o que o dono lê primeiro. As três palavras da decisão do
 * dono — «Precisa de você:» (decisão dele ou erro), «Agora:» (rodando, ou o sistema entregando), «Próximo:» (na fila,
 * esperando condutor) —; o pausado e o esquecido mantêm a palavra que o quadro já usa; o que está no ar não tem
 * prefixo. PURA.
 */
export function itemLinePrefix(state: FlowState): string {
  switch (state) {
    case "attention":
    case "error":
      return "Precisa de você:";
    case "running":
    case "delivering":
      return "Agora:";
    case "queued":
    case "waiting":
      return "Próximo:";
    case "paused":
    case "forgotten":
      return `${FLOW_STATE_LABEL[state]}:`;
    case "live":
      return "";
  }
}

/** «3 correções» / «2 correções, 1 manutenção» — o que um LOTE junta, por tipo. Vazio sem itens. PURA. */
export function batchKindWords(items: readonly Pick<Card, "storyType" | "mode">[]): string {
  const kinds = { c: 0, k: 0, n: 0 };
  for (const it of items) {
    const k = kindOf(it);
    if (k === "Correção") kinds.c++;
    else if (k === "Manutenção") kinds.k++;
    else kinds.n++;
  }
  return [
    kinds.c ? plural(kinds.c, "correção", "correções") : "",
    kinds.k ? plural(kinds.k, "manutenção", "manutenções") : "",
    kinds.n ? plural(kinds.n, "novidade", "novidades") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/** «Agora: 3 correções» — a linha de um LOTE (uma sessão do condutor fazendo vários itens juntos). PURA. */
export function batchLineWords(items: readonly Pick<Card, "storyType" | "mode">[], state: FlowState = "running"): string {
  return [itemLinePrefix(state), batchKindWords(items)].filter(Boolean).join(" ");
}

/** Os itens do MESMO lote do item nesta lista (ele incluso), pela marca `card.batch.id`. Sem lote ⇒ []. PURA. */
export function batchMates(item: Pick<Card, "batch">, items: readonly Card[]): Card[] {
  const id = item.batch?.id;
  return id ? items.filter((c) => c.batch?.id === id) : [];
}

/**
 * Os outros itens que o «+N» do card conta e lista: os da funcionalidade nesta raia MENOS os do lote que a linha do item
 * já resume («Agora: 1 correção, 1 manutenção») — senão o mesmo item aparecia duas vezes no card, na linha do lote e no
 * «+1 manutenção desta funcionalidade». Os estados vêm na mesma ordem. PURA.
 */
export function othersBeyondLot(entry: Pick<VisibleEntry, "item" | "others" | "otherStates">): { others: Card[]; states: FlowState[] } {
  const mates = batchMates(entry.item, [entry.item, ...entry.others]);
  if (mates.length < 2) return { others: entry.others, states: entry.otherStates };
  const inLot = new Set(mates.map((c) => c.id));
  const others: Card[] = [];
  const states: FlowState[] = [];
  entry.others.forEach((c, k) => {
    if (inLot.has(c.id)) return;
    others.push(c);
    states.push(entry.otherStates[k] ?? "queued");
  });
  return { others, states };
}

export interface ItemLine {
  /** «Agora:» / «Próximo:» / «Precisa de você:»… — vazio no ar. */
  prefix: string;
  /** o título do item, ou o que o lote junta («3 correções»). */
  text: string;
  /** quantos itens do lote a linha resume (0 = um item só). */
  batch: number;
}

/**
 * A linha do item no card: o prefixo pelo estado e o título do item — ou, quando o item que representa a
 * funcionalidade está num LOTE e há 2 ou mais itens desse lote na raia, o que o lote junta («Agora: 3 correções»).
 * PURA.
 */
export function itemLine(entry: Pick<VisibleEntry, "item" | "state" | "others">): ItemLine {
  const prefix = itemLinePrefix(entry.state);
  const mates = batchMates(entry.item, [entry.item, ...entry.others]);
  if (mates.length >= 2) return { prefix, text: batchKindWords(mates), batch: mates.length };
  // o título sem a etiqueta de máquina do começo (display-title.ts) — o gravado não muda
  return { prefix, text: displayTitle(entry.item.title), batch: 0 };
}

/**
 * Para onde o TÍTULO do card leva: a página da funcionalidade. O card que é a própria funcionalidade (no board sem
 * funcionalidades no PRD, a story sem passo do mapa) não tem página de funcionalidade — o título abre o item. PURA.
 */
export function featureTitleHref(boardId: string, feature: Pick<FeatureKey, "id" | "self">, itemHref: string): string {
  return feature.self ? itemHref : featureHref(boardId, feature.id);
}

// ── as legendas do fluxo ─────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface CaptionInput {
  /** quantos itens da raia em cada estado. */
  count: (s: FlowState) => number;
  total: number;
  paused: boolean;
  /** delivery: o tempo médio REAL por item no trem, em minutos (ausente = omite o número). */
  avgMinutes?: number | null;
  /** live: quantos chegaram ao ar hoje, e a média por dia na semana (ausente = omite). */
  today?: number;
  perDay?: number | null;
  /** quantas FUNCIONALIDADES (cards na tela, no «Tudo») os itens da raia formam — menos que o total ⇒ a legenda conta
   *  as duas coisas («11 itens · 2 funcionalidades»), para o número do cabeçalho não brigar com os cards à vista. */
  features?: number;
}

/**
 * «11 itens · 2 funcionalidades» — o que o cabeçalho conta (itens) contra o que a coluna mostra (um card por
 * funcionalidade). Vazio quando cada item é o seu próprio card (nada a explicar). PURA.
 */
export function groupingWords(items: number, features: number | undefined): string {
  if (features == null || features <= 0 || features >= items) return "";
  return `${plural(items, "item", "itens")} · ${plural(features, "funcionalidade", "funcionalidades")}`;
}

/** «1,4» — o número curto com vírgula. */
export function decimalWords(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
}

/** «1 espera você» / «4 esperam você». PURA. */
export function waitsYou(n: number): string {
  return `${n} ${n === 1 ? "espera" : "esperam"} você`;
}

/**
 * A legenda de uma faixa do fluxo: a parte em negrito e o resto (frases curtas que cabem na largura, sem
 * reticências). PURA.
 *
 * A regra geral vem ANTES das frases de cada raia: uma raia com itens que PRECISAM DE VOCÊ (ou com erro) abre com
 * isso — «4 esperam você · 1 com erro» — e o texto próprio da raia vira o resto. Uma raia com quatro bolinhas
 * âmbar não pode dizer «Andando». As frases do desenho valem onde ele as escreveu: a Triagem («entra ou não?») e a
 * Entrega («Espera seu ok · QA pronto»).
 */
/**
 * A legenda: a parte em negrito, o resto, e — quando o resto ganhou o agrupamento por funcionalidade — o resto CURTO,
 * sem ele, que o computador baixo mostra (lá a legenda tem UMA linha, e «11 itens · 2 funcionalidades» depois do
 * negrito saía cortada no meio). A frase inteira segue no `title`.
 */
export type FlowCaption = [lead: string, rest: string, compactRest?: string];

/** O separador das frases curtas de uma legenda («2 sem condutor · 2 itens»). */
export const CAPTION_SEP = " · ";

/** As frases de um resto de legenda, separadas — a tela as desenha uma a uma, e o «·» nunca sobra no fim da linha. PURA. */
export function captionParts(rest: string | undefined): string[] {
  return (rest ?? "").split(CAPTION_SEP).map((p) => p.trim()).filter(Boolean);
}

export function flowCaption(role: LaneRole, c: CaptionInput): FlowCaption {
  const [lead, rest] = laneCaption(role, c);
  // a Entrega (o trem mostra os itens) e o No ar (um item por linha) não agrupam: o resto deles fica como está
  if (role === "delivery" || role === "live") return [lead, rest];
  const grouped = groupingWords(c.total, c.features);
  if (!grouped) return [lead, rest];
  // a Triagem dizia «11 na triagem» — o agrupamento diz o mesmo número e mais; nas outras ele vem depois do resto
  if (role === "intake" && rest === `${c.total} na triagem`) return [lead, grouped, rest];
  return [lead, [rest, grouped].filter(Boolean).join(CAPTION_SEP), rest];
}

/** A legenda própria de cada raia (sem o agrupamento por funcionalidade). PURA. */
function laneCaption(role: LaneRole, c: CaptionInput): [string, string] {
  const a = c.count("attention");
  const e = c.count("error");
  const fg = c.count("forgotten");
  const r = c.count("running");
  const w = c.count("waiting") + c.count("paused");
  const q = c.count("queued");
  const join = (...xs: string[]) => xs.filter(Boolean).join(CAPTION_SEP);
  const errors = e ? `${e} com erro` : "";
  const forgotten = fg ? plural(fg, "esquecido", "esquecidos") : "";
  const trouble = join(errors, forgotten);
  /** o que precisa de alguém, em negrito: quem espera você e o que deu erro. */
  const needs = join(a ? waitsYou(a) : "", errors);
  /** sobra item que não é exceção: a frase própria da raia vira o resto («o resto andando»). */
  const others = c.total > a + e + fg;
  switch (role) {
    case "live":
      return [`+${c.today ?? 0} hoje`, c.perDay != null ? `${decimalWords(c.perDay)}/dia na semana` : ""];
    case "delivery": {
      if (!c.total) return ["Nada na entrega", ""];
      // A aprovação do dono («Aprovar entrega», depois do QA) mora na raia de ENTREGA no pipeline do `_base` — é aqui
      // que «Espera seu ok · QA pronto» diz a verdade (no protótipo ela estava na raia de verificação).
      if (a) return ["Espera seu ok", join("QA pronto", errors)];
      // sem tempo médio medido, o resto é quantos esperam a vez (nunca um número inventado)
      const waiting = c.count("delivering") + q;
      const pace = c.avgMinutes != null && c.avgMinutes > 0 ? `~${Math.round(c.avgMinutes)} min por item` : waiting ? `${waiting} na fila` : "";
      if (e) return [errors, join("Gargalo", pace)];
      return ["Gargalo", pace];
    }
    case "intake": {
      if (a) return [waitsYou(a), join("entra ou não?", errors)];
      // sem nada esperando o dono, o resto em cinza diz quantos estão na triagem (um «Nada parado» seco sobre 13
      // caixinhas lia como raia vazia)
      const inbox = c.total ? `${c.total} na triagem` : "";
      return e ? [errors, inbox] : ["Nada parado", inbox];
    }
    case "shaping":
      if (a) return [needs, join(forgotten, others ? "o resto andando" : "")];
      return [trouble || (c.total ? "Andando" : "Nada aqui"), ""];
    case "building": {
      // o que espera a vez sem condutor (board sem vaga de condutor) entra como «na fila» — o resto da legenda
      const rest = join(w ? `${w} sem condutor` : "", q ? `${q} na fila` : "");
      const flow = join(c.paused ? "Pausado" : r ? `${r} rodando` : "", rest);
      if (needs) return [needs, flow];
      return [c.paused ? "Pausado" : `${r} rodando`, rest];
    }
    case "verifying":
      if (a) return [needs, join(forgotten, others ? "o resto em QA" : "")];
      return [trouble || (c.total ? "Em QA" : "Nada aqui"), ""];
    case "generic":
      if (a) return [needs, join(r ? `${r} rodando` : "", forgotten)];
      return [trouble || (r ? `${r} rodando` : c.total ? "Andando" : "Nada aqui"), ""];
  }
}

/** «1,8 M tokens» / «450 mil tokens» / «980 tokens» — o custo curto do card que roda (o desenho fala em tokens). PURA. */
export function tokensWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 tokens";
  if (n >= 1_000_000) return `${decimalWords(n / 1_000_000)} M tokens`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} mil tokens`;
  return `${Math.round(n)} tokens`;
}

/** «4 h 10 min» / «12 min» / «menos de 1 min» — o tempo de agente gasto num card. PURA. */
export function agentTimeWords(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** «2 novidades · 1 correção» — a manutenção só aparece quando passa de 1/3 do total. PURA. */
export function mixLabel(n: number, c: number, k: number): string {
  const t = n + c + k;
  const out: string[] = [];
  if (n) out.push(plural(n, "novidade", "novidades"));
  if (c) out.push(plural(c, "correção", "correções"));
  if (k && k / t >= 1 / 3) out.push(plural(k, "manutenção", "manutenções"));
  return out.join(" · ");
}

// ── as caixinhas do fluxo ────────────────────────────────────────────────────────────────────────────

/** Estados com MARCA em cima da caixinha (o agente, a vaga de condutor): ocupam uma pilha sozinhos — o solo do protótipo. */
const MARKED: ReadonlySet<FlowState> = new Set(["running", "paused", "waiting"]);
/** Estados com a BOLINHA no canto (precisa de você, erro): desenhados ANTES de todos, para nenhuma bolinha ficar no «+N». */
const DOTTED: ReadonlySet<FlowState> = new Set(["attention", "error"]);

type CrateKind = "mark" | "dot" | "plain";
const crateKind = (s: FlowState): CrateKind => (MARKED.has(s) ? "mark" : DOTTED.has(s) ? "dot" : "plain");

export interface PlaceInput {
  id: string;
  /** progresso na raia, 0..1. */
  p: number;
  state: FlowState;
}

export interface Placed<T extends PlaceInput> {
  item: T;
  /** a coluna de encaixe (0..nSlots-1). */
  slot: number;
  /** a altura na pilha (0 = no chão). */
  lvl: number;
}

/**
 * O ENCAIXE das caixinhas (o `p5place` do protótipo): `nSlots` colunas, até `maxH` de altura. Cada item quer a coluna
 * do seu progresso e procura a mais próxima livre (primeiro para trás). Quem não cabe fica de fora (o «+N» da raia
 * conta). PURA.
 *
 * Duas regras além do protótipo, para o poço nunca esconder o que pede alguém:
 *   • quem tem BOLINHA (precisa de você, erro) é encaixado PRIMEIRO — uma raia com 8 «esperam você» desenha as 8
 *     bolinhas, e o «+N» sobra só para os itens quietos (no protótipo eles eram solos e só cabiam 7 por poço);
 *   • as pilhas não se misturam: a caixinha com MARCA em cima (rodando, pausado, esperando condutor) fica sozinha na
 *     coluna; as de bolinha empilham só entre si (a bolinha não cobre uma caixinha quieta); as quietas, entre si.
 * Dentro de cada grupo, do mais adiantado ao menos.
 */
export function p5place<T extends PlaceInput>(list: readonly T[], nSlots: number, maxH: number): Placed<T>[] {
  const slots = Array.from({ length: nSlots }, () => ({ n: 0, kind: null as CrateKind | null }));
  const out: Placed<T>[] = [];
  const byP = (a: T, b: T) => b.p - a.p;
  const dotted = list.filter((it) => DOTTED.has(it.state)).sort(byP);
  const rest = list.filter((it) => !DOTTED.has(it.state)).sort(byP);
  for (const it of [...dotted, ...rest]) {
    const want = Math.round(it.p * (nSlots - 1));
    const kind = crateKind(it.state);
    const order: number[] = [];
    for (let d = 0; d < nSlots; d++) {
      if (want - d >= 0) order.push(want - d);
      if (d && want + d < nSlots) order.push(want + d);
    }
    for (const k of order) {
      const sl = slots[k];
      if (sl.n >= maxH) continue;
      if (sl.n > 0 && (kind === "mark" || sl.kind !== kind)) continue;
      out.push({ item: it, slot: k, lvl: sl.n });
      sl.n++;
      sl.kind = kind;
      break;
    }
  }
  return out;
}

/**
 * Quanto a caixinha está cheia (de baixo para cima) — o `p5box` do protótipo: a posição no PIPELINE inteiro, não só
 * na raia. A 1ª raia (a triagem) não enche (a caixinha é tracejada lá); as raias do meio enchem pela ordem delas mais
 * o passo dentro da raia (`(i - 1 + passo) / raias do meio`); a entrega e o no ar vão cheios. PURA.
 */
export function crateFill(laneIndex: number, step: Pick<LaneStep, "index" | "total">, lanes: readonly Pick<KanbanLane, "role">[]): number {
  const role = lanes[laneIndex]?.role;
  if (role === "delivery" || role === "live") return 1;
  if (laneIndex <= 0) return 0;
  const middle = lanes.filter((l, i) => i > 0 && l.role !== "delivery" && l.role !== "live").length;
  const prog = Math.min(1, Math.max(0, step.index / Math.max(1, step.total)));
  return Math.max(0.12, Math.min(1, (laneIndex - 1 + prog) / Math.max(1, middle)));
}

/** A caixinha é tracejada na 1ª raia (o que ainda nem entrou no fluxo) e quando esquecida — o `p5box`. PURA. */
export function crateDashed(laneIndex: number, state: FlowState): boolean {
  return laneIndex === 0 || state === "forgotten";
}

/** O progresso de um item na raia para o encaixe: o esquecido fica no começo. PURA. */
export function crateProgress(step: Pick<LaneStep, "index" | "total">, state: FlowState): number {
  if (state === "forgotten") return 0;
  return Math.min(1, Math.max(0, step.index / Math.max(1, step.total)));
}

// ── a chegada ao ar ──────────────────────────────────────────────────────────────────────────────────

/**
 * QUANDO cada card chegou ao ar: a ÚLTIMA transição do ledger para um status terminal (epoch ms). A última escrita do
 * arquivo do card NÃO serve — um sync, um campo atualizado pelo MCP ou o train reescrevendo o card fariam uma entrega
 * velha parecer nova. Card sem transição legível fica fora do mapa (quem lê omite o número). PURA.
 */
export function liveArrivals(
  transitions: Iterable<{ cardId: string; to: string; at: string }>,
  terminal: ReadonlySet<string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of transitions) {
    if (!terminal.has(t.to)) continue;
    const at = Date.parse(t.at);
    if (!Number.isFinite(at)) continue;
    const prev = out.get(t.cardId);
    if (prev == null || at > prev) out.set(t.cardId, at);
  }
  return out;
}

/** Quantas caixinhas a raia Entrega desenha antes do «+N». */
export const DELIVERY_CRATES = 14;
