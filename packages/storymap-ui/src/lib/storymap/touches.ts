// A MEDIDA de TOQUES HUMANOS por história — quantas vezes o dono teve de mexer para uma história
// andar, e em quê. PURA (zero IO; o MCP `touches_per_story` lê o ledger e os cards e chama isto).
//
// A fonte é o ledger de transições (runner/transitions.ts), que grava o ATOR de cada salto: `human` é o dono;
// `cascade`/`system`/`merge` são o sistema; `run:<x>` é um agente (o Jido e toda sessão pelo token do orquestrador,
// o juiz da triagem, uma skill). Cada salto humano é classificado pelo PONTO DE DECISÃO que ele resolveu — aceitar da
// triagem, aprovar a entrega, publicar, desfazer, reabrir, ou um move qualquer — e pela CLASSE: é NEGÓCIO quando o
// card toca uma classe do dono (`businessClasses`), senão técnico. As perguntas que o dono respondeu entram à parte,
// pela classe da própria pergunta (decision-class.ts), porque não são saltos de status.
//
// Linha de base: numa história técnica o mínimo é aceitar da triagem, aprovar a entrega e publicar (3 toques);
// uma publicação que falha e é repetida soma um salto por tentativa, e um aceite feito por um agente pelo token do
// orquestrador não conta como toque humano. Meta: 0 em história técnica; em história de usuário, só os pontos de
// negócio.

import { questionVerdict } from "./decision-class";
import { isDeployStep } from "./demands";
import { isDeliveryApprovalStep } from "./delivery-audit";
import type { BoardConfig, Card } from "./types";
import type { Transition } from "./runner/transitions";

export type ActorKind = "human" | "system" | "agent";

/** Quem é quem no ledger. PURA. */
export function classifyActor(actor: string): ActorKind {
  if (actor === "human") return "human";
  if (actor.startsWith("run:")) return "agent";
  return "system";
}

/** O ponto de decisão que um salto resolveu. */
export type TouchPoint = "triage-accept" | "delivery-approval" | "publish" | "undo" | "reopen" | "move";

/** O ponto de decisão de um salto, pelo passo de onde ele saiu / para onde foi e pela nota do escritor. PURA. */
export function touchPoint(t: Pick<Transition, "from" | "to" | "note">, config: Pick<BoardConfig, "statuses">): TouchPoint {
  const def = (id: string | null) => (id ? config.statuses.find((s) => s.id === id) : undefined);
  const note = t.note ?? "";
  if (note.startsWith("undo:")) return "undo";
  if (note.startsWith("reopen:")) return "reopen";
  if (note.startsWith("accept-triage") || def(t.from)?.staging) return "triage-accept";
  if (isDeliveryApprovalStep(def(t.from))) return "delivery-approval";
  if (isDeployStep(def(t.to))) return "publish";
  return "move";
}

export interface TouchRecord {
  at: string;
  from: string | null;
  to: string;
  actor: string;
  point: TouchPoint;
  class: "business" | "technical";
}

export interface StoryTouches {
  cardId: string;
  title?: string;
  /** os saltos do DONO: quantos, os pontos de decisão distintos (na ordem em que apareceram), e a classe. */
  human: { hops: number; points: TouchPoint[]; business: number; technical: number };
  /** saltos de agentes (run:*) — e os pontos de decisão que um agente resolveu (ex.: um aceite pelo token ORCH). */
  agent: number;
  agentPoints: TouchPoint[];
  /** saltos do sistema (cascata, settle, merge). */
  system: number;
  /** perguntas respondidas pelo dono (não pelo proxy nem pelo Jido), pela classe da pergunta. */
  answers: { business: number; technical: number };
  touches: TouchRecord[];
}

export interface TouchesReport {
  board: string;
  since?: string;
  until?: string;
  stories: StoryTouches[];
  summary: {
    stories: number;
    humanHops: number;
    business: number;
    technical: number;
    /** média de toques humanos (saltos) por história. */
    meanHumanHops: number;
    /** média de pontos de decisão humanos DISTINTOS por história — a medida ("3 toques por história"). */
    meanHumanPoints: number;
  };
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Os toques por história do board no período (`since`/`until` em ISO, inclusivos). Só histórias (type story) com ao
 * menos um salto no período entram. PURA.
 */
export function touchesPerStory(
  transitions: readonly Transition[],
  opts: { board: string; cards: readonly Card[]; config: Pick<BoardConfig, "statuses" | "autonomy">; since?: string; until?: string },
): TouchesReport {
  const byId = new Map(opts.cards.map((c) => [c.id, c]));
  const within = (at: string) => (!opts.since || at >= opts.since) && (!opts.until || at <= opts.until);
  const grouped = new Map<string, Transition[]>();
  for (const t of transitions) {
    if (t.board !== opts.board || !within(t.at)) continue;
    const card = byId.get(t.cardId);
    if (card && card.type !== "story") continue;
    grouped.set(t.cardId, [...(grouped.get(t.cardId) ?? []), t]);
  }
  const stories: StoryTouches[] = [];
  for (const [cardId, list] of grouped) {
    const card = byId.get(cardId);
    const business = !!card?.businessClasses?.ids.length;
    const ordered = [...list].sort((a, b) => a.at.localeCompare(b.at));
    const touches: TouchRecord[] = [];
    const agentPoints: TouchPoint[] = [];
    let agent = 0;
    let system = 0;
    for (const t of ordered) {
      const kind = classifyActor(t.actor);
      if (kind === "system") {
        system++;
        continue;
      }
      const point = touchPoint(t, opts.config);
      if (kind === "agent") {
        agent++;
        if (point !== "move") agentPoints.push(point);
        continue;
      }
      touches.push({ at: t.at, from: t.from, to: t.to, actor: t.actor, point, class: business ? "business" : "technical" });
    }
    const answers = { business: 0, technical: 0 };
    for (const q of card?.questions ?? []) {
      if (q.status !== "answered" || (q.answeredBy && q.answeredBy !== "human")) continue;
      if (q.answer?.startsWith("(sem resposta")) continue; // resolvida sozinha num terminal — não foi toque
      if (q.answeredAt && !within(`${q.answeredAt}T12:00:00Z`)) continue;
      answers[questionVerdict(q, opts.config).ownerClass || business ? "business" : "technical"]++;
    }
    stories.push({
      cardId,
      ...(card?.title ? { title: card.title } : {}),
      human: {
        hops: touches.length,
        points: uniq(touches.map((t) => t.point)),
        business: touches.filter((t) => t.class === "business").length,
        technical: touches.filter((t) => t.class === "technical").length,
      },
      agent,
      agentPoints: uniq(agentPoints),
      system,
      answers,
      touches,
    });
  }
  stories.sort((a, b) => a.cardId.localeCompare(b.cardId));
  const n = stories.length;
  const humanHops = stories.reduce((s, x) => s + x.human.hops, 0);
  return {
    board: opts.board,
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
    stories,
    summary: {
      stories: n,
      humanHops,
      business: stories.reduce((s, x) => s + x.human.business, 0),
      technical: stories.reduce((s, x) => s + x.human.technical, 0),
      meanHumanHops: n ? humanHops / n : 0,
      meanHumanPoints: n ? stories.reduce((s, x) => s + x.human.points.length, 0) / n : 0,
    },
  };
}
