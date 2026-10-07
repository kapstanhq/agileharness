// The board VIEW in LANES — a presentation over the existing statuses, never a data migration.
//
// The owner's rule: "o detalhe de cada etapa aparece como etiqueta dentro do card, não como
// coluna". A board declares, in board.yaml,
//
//   view:
//     lanes:
//       - { id: owner,   label: Needs you,   statuses: [], demand: true }
//       - { id: intake,  label: Intake,      statuses: [capturando, triage] }
//       - { id: shaping, label: Shaping,     statuses: [grill, enriquecer, design-ux] }
//       …
//
// and the Kanban renders those lanes instead of the status columns. Every card keeps its status; it is SHOWN in the
// lane that lists it, with the real status as a tag. Two rules make this a view the owner can trust:
//
//   • NOTHING DISAPPEARS. A status no lane lists (a typo, a column added later) puts its cards in a visible
//     "Outros" lane, never nowhere — the same "never lose an active card" rule the legacy Kanban keeps (views.ts).
//     The lint below names every such hole in words, so the owner fixes the map instead of hunting cards.
//   • THE OWNER'S LANE IS THE INBOX'S «DECIDIR». A lane with `demand` holds EXACTLY the cards the Inbox puts in
//     Decidir (inbox/decidir-set.ts — the same collector the Inbox list, the badge and the push read), in the Inbox's
//     order, and NOTHING else: it lists no status. It used to mix fixed statuses with the legacy
//     `cardDemands` model, so the lane and the Inbox counted different cards: the owner saw cards the system was
//     still integrating and could miss the one item only they could unblock. A status written in a demand lane is
//     now IGNORED (its cards fall in "Outros") and the lint says so.
//
// PURE (no IO, no React) and board-agnostic: nothing here knows a status id — the lanes and the statuses come from the
// board's config, the owner's set from the Inbox.

import { isDeployStep } from "./demands";
import { isDeliveryApprovalStep } from "./delivery-audit";
import { archivedKanbanStatusIds } from "./views";
import type { OwnerDecisions } from "./inbox/decidir-set";
import type { BoardConfig, Card, StatusDef } from "./types";

/** The synthetic lane for cards whose status no declared lane lists. Reserved id (the lint refuses it). */
export const LANE_OTHERS_ID = "__outros__";
export const LANE_OTHERS_LABEL = "Outros";
/** A raia sintética do «Adiado — não agora» (deferral.ts): o que o dono guardou para depois. Id reservado. */
export const LANE_DEFERRED_ID = "__adiado__";
export const LANE_DEFERRED_LABEL = "Adiado — não agora";

/** A lane ready to render. */
export interface ResolvedLane {
  id: string;
  label: string;
  /** the statuses it shows — always [] for the owner's lane (it mirrors Decidir, never a status). */
  statuses: string[];
  /** the OWNER'S lane: holds exactly the cards in the Inbox's Decidir, in the Inbox's order. */
  demand: boolean;
  /** the synthetic catch-all lane ({@link LANE_OTHERS_ID}) — and the deferred one, which behaves like it (no drops). */
  others?: true;
  /** the synthetic «Adiado — não agora» lane ({@link LANE_DEFERRED_ID}). */
  deferred?: true;
}

/** Um rótulo de raia que promete que o SISTEMA age (o lint da aprovação da entrega). */
const SYSTEM_CLAIM = /\b(sistema|system|autom[aá]tic)/i;

const declaresDemand = (l: { demand?: boolean | unknown[] }) => l.demand === true || (Array.isArray(l.demand) && l.demand.length > 0);

/** The board's declared lanes, resolved — or null when it declares none (the Kanban then derives lanes from the columns — kanban-features `kanbanLanes`). PURE. */
export function boardLanes(config: Pick<BoardConfig, "view">): ResolvedLane[] | null {
  const lanes = config.view?.lanes;
  if (!lanes?.length) return null;
  // Só a PRIMEIRA raia de demanda é a do dono (o lint grita a segunda): duas raias do dono fariam «onde mora a
  // decisão?» depender da ordem da declaração. A segunda vira uma raia comum, pelos status dela.
  let ownerTaken = false;
  return lanes.map((l) => {
    const demand = declaresDemand(l) && !ownerTaken;
    if (demand) ownerTaken = true;
    return { id: l.id, label: l.label, statuses: demand ? [] : l.statuses, demand };
  });
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

/** A step the SYSTEM carries (a train passage, the delivery lane, the deploy) — never the owner's decision. PURE. */
function isSystemPassage(def: StatusDef): boolean {
  return isDeployStep(def) || def.laneStep === true || (def.autorun === true && !def.trigger && !def.terminal && def.hidden !== true);
}

/**
 * Every way the declared lane map is wrong, in words the owner can act on — or [] when it is sound (or absent).
 * PURE. The rules: every (non-archive) status in EXACTLY one ordinary lane; no lane names a status the board does not
 * have; lane ids unique and not the reserved {@link LANE_OTHERS_ID}; at most one lane pulls by demand; and the owner's
 * lane lists NO status (it mirrors the Inbox's Decidir — a status there is ignored and its cards land in "Outros") and
 * no kind list (`demand: true` — the lane is the whole Decidir, never a subset of kinds). The view still renders when
 * this reports problems — unmapped cards fall into "Outros" — but the board reader shouts them (repo.ts) and the view
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

  const demandLanes = lanes.filter(declaresDemand);
  const owner = demandLanes[0];
  if (demandLanes.length > 1) {
    problems.push(
      `${demandLanes.length} raias puxam por demanda (${demandLanes.map((l) => l.label).join(", ")}) — só a primeira vale; declare \`demand\` numa raia só`,
    );
  }
  if (owner && Array.isArray(owner.demand)) {
    problems.push(
      `a raia '${owner.label}' lista tipos em \`demand\` (${owner.demand.join(", ")}) — a raia do dono espelha o Decidir do Inbox inteiro; use \`demand: true\``,
    );
  }
  for (const id of owner?.statuses ?? []) {
    const def = known.get(id);
    if (!def) {
      problems.push(`a raia '${owner!.label}' lista o status '${id}', que não existe neste board (veja list_statuses)`);
      continue;
    }
    const passage = isSystemPassage(def) ? " — e é um passo que o sistema conduz, não uma decisão sua" : "";
    problems.push(
      `a raia '${owner!.label}' espelha o Decidir do Inbox e ignora status: os cards em '${id}' (${def.name}) aparecem em '${LANE_OTHERS_LABEL}'${passage}; mova '${id}' para outra raia`,
    );
  }

  const lanesOf = new Map<string, string[]>();
  for (const l of lanes) {
    if (l === owner) continue;
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
  // A aprovação da ENTREGA espera o dono. Uma raia cujo RÓTULO promete o sistema e que lista esse passo mente para quem
  // lê: o card parado ali, esperando a aprovação, apareceria sob uma promessa de automação. Ele vai para a raia do dono
  // (o Decidir — inbox/decision.ts), mas o rótulo continua prometendo o que o passo não é: o lint pede outro rótulo
  // ou a aprovação numa raia própria. (Um rótulo neutro — «Prova», «Entrega» — não é acusado.)
  for (const l of lanes) {
    if (l === owner || !SYSTEM_CLAIM.test(l.label)) continue;
    const delivery = l.statuses.map((id) => known.get(id)).filter((d): d is StatusDef => !!d && isDeliveryApprovalStep(d));
    if (delivery.length) {
      problems.push(
        `a raia '${l.label}' promete o sistema, mas lista a aprovação da entrega (${delivery.map((d) => `'${d.id}' (${d.name})`).join(", ")}), ` +
          "que espera o dono — troque o rótulo ou ponha a aprovação numa raia própria",
      );
    }
  }
  for (const [id, at] of lanesOf) {
    if (at.length > 1) {
      problems.push(`o status '${id}' está em ${at.length} raias (${at.join(", ")}) — cada status mora em UMA raia só`);
    }
  }
  const saidByOwner = new Set(owner?.statuses ?? []);
  for (const s of statusesToMap(config)) {
    if (!lanesOf.has(s.id) && !saidByOwner.has(s.id)) {
      problems.push(`o status '${s.id}' (${s.name}) não está em nenhuma raia — os cards nele aparecem em '${LANE_OTHERS_LABEL}'`);
    }
  }
  return problems;
}

/**
 * The lane a card renders in. PURE. In order:
 *   1. the owner's lane, when the card is in the Inbox's Decidir (`owner`) — the decision wins over the status;
 *   2. the FIRST ordinary lane that lists the card's status;
 *   3. {@link LANE_OTHERS_ID} — never nowhere.
 */
export function laneOfCard(card: Pick<Card, "id" | "status">, lanes: readonly ResolvedLane[], owner: ReadonlySet<string> | null): string {
  if (owner?.has(card.id)) {
    const mine = lanes.find((l) => l.demand);
    if (mine) return mine.id;
  }
  const byStatus = card.status != null ? lanes.find((l) => !l.demand && l.statuses.includes(card.status!)) : undefined;
  return byStatus ? byStatus.id : LANE_OTHERS_ID;
}

/** Options for {@link groupStoriesByLane}: the Inbox's Decidir of this board (null = unknown — the lane stays empty). */
export interface LaneGroupOpts {
  owner?: OwnerDecisions | null;
}

export interface LaneGrouping {
  lanes: ResolvedLane[];
  byLane: Map<string, Card[]>;
  /**
   * The Decidir entries that put NO card in the owner's lane: an item with no card (a PRD proposal, a loose agent
   * request), a card the Kanban does not show, or a second decision of a card already there. The lane's count plus
   * this always equals the Inbox's number — the lane never silently undercounts what waits for the owner.
   */
  outside: number;
}

/**
 * Place every story in its lane. PURE. Returns the lanes to render — the declared ones in order, plus "Outros" at the
 * end ONLY when some card landed there (an empty catch-all is noise) — the cards per lane id (the owner's lane in the
 * Inbox's order) and how many Decidir entries sit {@link LaneGrouping.outside} the lane.
 */
export function groupStoriesByLane(
  stories: readonly Card[],
  lanes: readonly ResolvedLane[],
  opts: LaneGroupOpts = {},
): LaneGrouping {
  const decided = new Map((opts.owner?.cards ?? []).map((d) => [d.cardId, d] as const));
  const ownerIds = new Set(decided.keys());
  const byLane = new Map<string, Card[]>(lanes.map((l) => [l.id, [] as Card[]]));
  const others: Card[] = [];
  const deferred: Card[] = [];
  for (const card of stories) {
    // «Adiado — não agora»: o dono guardou para depois — não ocupa as raias do fluxo, mora na sua própria faixa.
    if (card.deferred) {
      deferred.push(card);
      continue;
    }
    const id = laneOfCard(card, lanes, ownerIds);
    if (id === LANE_OTHERS_ID) others.push(card);
    else byLane.get(id)!.push(card);
  }
  const ownerLane = lanes.find((l) => l.demand);
  let outside = opts.owner?.total ?? 0;
  if (ownerLane) {
    const mine = byLane.get(ownerLane.id)!;
    mine.sort((a, z) => decided.get(a.id)!.rank - decided.get(z.id)!.rank);
    for (const c of mine) outside -= 1 + decided.get(c.id)!.more;
  }
  const synthetic: ResolvedLane[] = [];
  if (others.length) {
    byLane.set(LANE_OTHERS_ID, others);
    synthetic.push({ id: LANE_OTHERS_ID, label: LANE_OTHERS_LABEL, statuses: [], demand: false, others: true });
  }
  if (deferred.length) {
    byLane.set(LANE_DEFERRED_ID, deferred);
    synthetic.push({ id: LANE_DEFERRED_ID, label: LANE_DEFERRED_LABEL, statuses: [], demand: false, others: true, deferred: true });
  }
  return { lanes: [...lanes, ...synthetic], byLane, outside };
}

// (Saíram na fase 1, com o card e o quadro antigos: `laneDropStatus` — o arraste —, `laneStatusTags` — a etiqueta do
// status na raia — e `laneSections` — a raia dividida por atividade. O quadro novo agrupa por funcionalidade e mostra o
// estado de cada item: kanban-features.ts.)
