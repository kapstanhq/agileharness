// The board VIEW in LANES — a presentation over the existing statuses, never a data migration.
//
// The owner's rule (plan v3, 2026-09-25): "o detalhe de cada etapa aparece como etiqueta dentro do card, não como
// coluna". A board declares, in board.yaml,
//
//   view:
//     lanes:
//       - { id: triagem,   label: Triagem,          statuses: [capturando, triage, priorizar, pronta] }
//       - { id: moldando,  label: Moldando,         statuses: [grill, enriquecer, interview, design-ux, design-ui] }
//       - { id: voce,      label: Precisa de você,  statuses: [com-design, ready, revisao, release], demand: true }
//       …
//
// and the Kanban renders those lanes instead of the status columns. Every card keeps its status; it is SHOWN in the
// lane that lists it, with the real status as a tag. Two rules make this a view the owner can trust:
//
//   • NOTHING DISAPPEARS. A status no lane lists (a typo, a column added later) puts its cards in a visible
//     "Outros" lane, never nowhere — the same "never lose an active card" rule the legacy Kanban keeps (views.ts).
//     The lint below names every such hole in words, so the owner fixes the map instead of hunting cards.
//   • WHAT NEEDS THE OWNER IS WHERE THE OWNER LOOKS. A lane with `demand` pulls every card that has an OPEN demand
//     of those kinds — an unanswered question, by default — whatever its status. The demand comes from the Inbox's
//     own derivation (`cardDemands`, demands.ts), so the lane and the Inbox can never disagree about who is waiting.
//
// PURE (no IO, no React) and board-agnostic: nothing here knows a status id — the lanes, the statuses and the demand
// kinds all come from the board's config.

import { cardDemands, isDeployStep, type DemandType } from "./demands";
import { archivedKanbanStatusIds } from "./views";
import { LANE_DEFAULT_DEMANDS } from "./types";
import type { BoardConfig, Card, LaneDemand, StatusDef } from "./types";

// A lane may only pull by a REAL demand kind: `LaneDemand` must stay a subset of demands.ts `DemandType`. Checked
// by the compiler — a kind renamed there breaks the build here instead of silently never matching.
type LaneDemandIsDemandType = LaneDemand extends DemandType ? true : never;
const laneDemandIsDemandType: LaneDemandIsDemandType = true;
void laneDemandIsDemandType;

/** The synthetic lane for cards whose status no declared lane lists. Reserved id (the lint refuses it). */
export const LANE_OTHERS_ID = "__outros__";
export const LANE_OTHERS_LABEL = "Outros";

/** A lane ready to render: its statuses, and the demand kinds it pulls (null = none). */
export interface ResolvedLane {
  id: string;
  label: string;
  statuses: string[];
  demand: LaneDemand[] | null;
  /** the synthetic catch-all lane ({@link LANE_OTHERS_ID}). */
  others?: true;
}

/** The board's declared lanes, resolved — or null when it declares none (the legacy Kanban renders). PURE. */
export function boardLanes(config: Pick<BoardConfig, "view">): ResolvedLane[] | null {
  const lanes = config.view?.lanes;
  if (!lanes?.length) return null;
  return lanes.map((l) => ({
    id: l.id,
    label: l.label,
    statuses: l.statuses,
    demand: l.demand === true ? [...LANE_DEFAULT_DEMANDS] : Array.isArray(l.demand) && l.demand.length ? [...l.demand] : null,
  }));
}

/**
 * The statuses a lane map must cover: every status of the board EXCEPT the archive terminals (a `system` column —
 * arquivados/duplicado/cancelado…). Those never render on the Kanban (the trash drawer owns them), so demanding
 * a lane for them would be ceremony. Hidden statuses (the reopen executors, the capture lane) DO count: a card in
 * `corrigir` is active work and must land somewhere legible.
 */
function statusesToMap(config: Pick<BoardConfig, "statuses" | "columns">): StatusDef[] {
  const archived = archivedKanbanStatusIds(config as BoardConfig);
  return config.statuses.filter((s) => !archived.has(s.id));
}

/**
 * Every way the declared lane map is wrong, in words the owner can act on — or [] when it is sound (or absent).
 * PURE. The rules: every (non-archive) status in EXACTLY one lane; no lane names a status the board does not
 * have; lane ids unique and not the reserved {@link LANE_OTHERS_ID}; at most one lane pulls by demand (two would
 * make "where does a card with a question go?" depend on declaration order). The view still renders when this
 * reports problems — unmapped cards fall into "Outros" — but the board reader shouts them (repo.ts) and the view
 * shows them.
 */
export function laneViewProblems(config: Pick<BoardConfig, "view" | "statuses" | "columns">): string[] {
  const lanes = config.view?.lanes;
  if (!lanes?.length) return [];
  const problems: string[] = [];
  const known = new Map(config.statuses.map((s) => [s.id, s]));

  const seenIds = new Set<string>();
  for (const l of lanes) {
    if (l.id === LANE_OTHERS_ID) problems.push(`a raia '${l.label}' usa o id reservado '${LANE_OTHERS_ID}' — escolha outro id`);
    if (seenIds.has(l.id)) problems.push(`há duas raias com o id '${l.id}' — cada raia precisa de um id próprio`);
    seenIds.add(l.id);
  }

  const lanesOf = new Map<string, string[]>();
  for (const l of lanes) {
    for (const id of l.statuses) {
      if (!known.has(id)) {
        problems.push(`a raia '${l.label}' lista o status '${id}', que não existe neste board (veja list_statuses)`);
        continue;
      }
      const at = lanesOf.get(id) ?? [];
      if (!at.includes(l.label)) at.push(l.label);
      lanesOf.set(id, at);
    }
  }
  for (const [id, at] of lanesOf) {
    if (at.length > 1) {
      problems.push(`o status '${id}' está em ${at.length} raias (${at.join(", ")}) — cada status mora em UMA raia só`);
    }
  }
  for (const s of statusesToMap(config)) {
    if (!lanesOf.has(s.id)) {
      problems.push(`o status '${s.id}' (${s.name}) não está em nenhuma raia — os cards nele aparecem em '${LANE_OTHERS_LABEL}'`);
    }
  }

  const demandLanes = lanes.filter((l) => l.demand === true || (Array.isArray(l.demand) && l.demand.length > 0));
  if (demandLanes.length > 1) {
    problems.push(
      `${demandLanes.length} raias puxam por demanda (${demandLanes.map((l) => l.label).join(", ")}) — só a primeira vale; declare \`demand\` numa raia só`,
    );
  }
  return problems;
}

/**
 * The lane a card renders in. PURE. In order:
 *   1. the FIRST lane that pulls by demand and whose kinds meet one of the card's open demands — the "needs you"
 *      rule wins over the status, which is the whole point of it;
 *   2. the FIRST lane that lists the card's status;
 *   3. {@link LANE_OTHERS_ID} — never nowhere.
 */
export function laneOfCard(
  card: Pick<Card, "status">,
  lanes: readonly ResolvedLane[],
  openDemands: ReadonlySet<DemandType>,
): string {
  if (openDemands.size) {
    const pulled = lanes.find((l) => l.demand?.some((k) => openDemands.has(k)));
    if (pulled) return pulled.id;
  }
  const byStatus = card.status != null ? lanes.find((l) => l.statuses.includes(card.status!)) : undefined;
  return byStatus ? byStatus.id : LANE_OTHERS_ID;
}

/** Options for {@link groupStoriesByLane} — the demand clock, like cardDemands (tests inject `now`). */
export interface LaneGroupOpts {
  now?: number;
}

/**
 * Place every story in its lane. PURE. Returns the lanes to render — the declared ones in order, plus
 * "Outros" at the end ONLY when some card landed there (an empty catch-all is noise) — and the cards per lane id.
 * A lane that pulls by demand is the only one that asks for the card's demands (cardDemands), so a board without
 * one pays nothing for it.
 */
export function groupStoriesByLane(
  stories: readonly Card[],
  config: BoardConfig,
  lanes: readonly ResolvedLane[],
  opts: LaneGroupOpts = {},
): { lanes: ResolvedLane[]; byLane: Map<string, Card[]> } {
  const byLane = new Map<string, Card[]>(lanes.map((l) => [l.id, [] as Card[]]));
  const pulls = lanes.some((l) => l.demand?.length);
  const others: Card[] = [];
  for (const card of stories) {
    const open = pulls
      ? new Set(cardDemands(card, config, config.id, opts.now != null ? { now: opts.now } : undefined).map((d) => d.type))
      : new Set<DemandType>();
    const id = laneOfCard(card, lanes, open);
    if (id === LANE_OTHERS_ID) others.push(card);
    else byLane.get(id)!.push(card);
  }
  if (!others.length) return { lanes: [...lanes], byLane };
  byLane.set(LANE_OTHERS_ID, others);
  return {
    lanes: [...lanes, { id: LANE_OTHERS_ID, label: LANE_OTHERS_LABEL, statuses: [], demand: null, others: true }],
    byLane,
  };
}

/**
 * The status a card DROPPED on a lane moves to: the lane's first status that exists on the board and is not
 * hidden (the hidden reopen/capture lanes are entered by their own actions, never by a drag). The move still goes
 * through `moveCardAction`, so the status's gate decides — a lane never opens a way around one. "Outros" and a
 * lane with no droppable status accept no drop (null). PURE.
 */
export function laneDropStatus(lane: ResolvedLane, config: Pick<BoardConfig, "statuses">): string | null {
  if (lane.others) return null;
  for (const id of lane.statuses) {
    const def = config.statuses.find((s) => s.id === id);
    if (def && def.hidden !== true) return def.id;
  }
  return null;
}

/**
 * The TAGS a card carries in the lane view — the detail the lane folds away. PURE:
 *   - the card's real status, by its board name (the unknown id itself when the board does not know it);
 *   - `integrando` while it rests in a train passage (a trigger-less autorun step — the merge → stage hand-offs
 *     the cascade forwards on its own), `publicando` while it rests in the deploy step (deploy-truth: it waits
 *     there for the settle). Both are read from the status's declared behaviour, never from its id.
 * The live run state (rodando / integrando now / conflito) is the card's own badge, from the runner snapshots.
 */
export function laneStatusTags(card: Pick<Card, "status">, config: Pick<BoardConfig, "statuses">): string[] {
  if (!card.status) return ["sem status"];
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def) return [card.status];
  const tags = [def.name || def.id];
  if (isDeployStep(def)) tags.push("publicando");
  else if (def.autorun === true && !def.trigger && !def.terminal && def.hidden !== true) tags.push("integrando");
  return tags;
}
