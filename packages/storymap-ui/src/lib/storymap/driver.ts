// The card DRIVER — who moves a card through the pipeline when it is not the column cascade.
//
// PURE and dependency-light on purpose: the cascade kernel (cascade-decision.ts), the engine's dispatch
// guard (runner/engine.ts), the move risk class (entry-effect.ts) and the conductor dispatcher
// (runner/conductor.ts) all ask the SAME question — "is this card conducted?" — and a predicate each of them
// re-derived would be four chances for the answers to drift apart (one of them stays silent, another spawns).

import { CONDUCTOR_DEFAULT_MAX_SESSIONS } from "./types";
import type { BoardConfig, Card, CardDriver, CardRouting, ModelTier } from "./types";

/** Is this card driven by a conductor session instead of the column cascade? PURE. */
export function isConducted(card: Pick<Card, "routing"> | null | undefined): boolean {
  return card?.routing?.driver === "conductor";
}

/** The ids of the conducted cards among `cards` — what the copiloto tick and the steward must leave alone. PURE. */
export function conductedCardIds(cards: ReadonlyArray<Pick<Card, "id" | "routing">>): Set<string> {
  return new Set(cards.filter((c) => isConducted(c)).map((c) => c.id));
}

/**
 * The card's routing with `driver` set — or null when it already carries that driver (no write needed, which
 * keeps a re-dispatch or a watcher echo from producing a card write that re-triggers the watcher). An absent
 * routing block is born with `skips: []` — an EMPTY skip set leaves the deterministic skip rules deciding
 * live (routeSkip only honours ids it finds), so marking the driver changes nothing else about the route.
 * PURE.
 */
export function withDriver(
  card: Pick<Card, "routing">,
  driver: CardDriver,
  today: string,
): CardRouting | null {
  if (card.routing?.driver === driver) return null;
  if (card.routing) return { ...card.routing, driver };
  return { skips: [], decidedBy: "rules", decidedAt: today, driver };
}

/**
 * The card's routing with the driver REMOVED — or `undefined` when there is no driver to remove (no write).
 * A routing block that existed only to carry the driver (no skips, no profile, no caps) collapses to null,
 * i.e. back to "the rules decide live", exactly as if the driver had never been set. PURE.
 */
export function withoutDriver(card: Pick<Card, "routing">): CardRouting | null | undefined {
  const r = card.routing;
  if (!r?.driver) return undefined;
  const { driver: _drop, ...rest } = r;
  const meaningful = rest.skips.length > 0 || !!rest.profile || !!rest.modelCap || !!rest.effortCap;
  return meaningful ? rest : null;
}

/**
 * A route edit (`set_card_route` — skips/profile/caps) must not touch WHO drives the card: replacing `routing`
 * wholesale would silently hand a conducted card back to the column cascade, whose next entry would spawn the
 * stale column run the driver exists to prevent. So the fresh driver rides along on a new route, and survives a
 * CLEAR of the route as a routing block that carries only the driver. A card without a driver gets `next`
 * untouched. PURE.
 */
export function preserveDriver(
  next: CardRouting | null,
  prev: CardRouting | null | undefined,
  today: string,
): CardRouting | null {
  const driver = prev?.driver;
  if (!driver) return next;
  if (next) return { ...next, driver };
  return { skips: [], decidedBy: prev?.decidedBy ?? "rules", decidedAt: prev?.decidedAt || today, driver };
}

/** The skill a conductor session runs — the ONE place the slug lives (spawn prompt, recycle, telemetry). */
export const CONDUCTOR_SKILL = "harness-conductor";

/** The slash command that leads a conductor session's first prompt: `/harness-conductor <board>/<cardId>`. PURE. */
export function conductorCommand(board: string, cardId: string): string {
  return `/${CONDUCTOR_SKILL} ${board}/${cardId}`;
}

// ── the CONDUCTOR dispatch policy (board.yaml `conductor`) — pure, read by runner/conductor.ts and by the move
//    risk class (entry-effect.ts), so a scoped agent moving a card into `fromStatus` is classed as what it is: a spawn.

/** A board's conductor policy with the defaults applied. */
export interface ResolvedConductorPolicy {
  /** every status whose ENTRY is the "go" — the string form resolves to a one-element list. */
  fromStatuses: string[];
  maxSessions: number;
  model: ModelTier;
}

/** The authored `fromStatus` (string or list) as a list of non-empty ids. PURE. */
export function conductorFromStatuses(fromStatus: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(fromStatus) ? fromStatus : fromStatus ? [fromStatus] : [];
  return [...new Set(raw.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))];
}

/** The tier a conductor runs on when the board names none: one context carries the whole story. */
export const CONDUCTOR_DEFAULT_MODEL: ModelTier = "opus";

/** The board's conductor policy, resolved — or null when absent or not enabled. PURE. */
export function resolveConductorPolicy(config: Pick<BoardConfig, "conductor"> | null | undefined): ResolvedConductorPolicy | null {
  const c = config?.conductor;
  const fromStatuses = conductorFromStatuses(c?.fromStatus);
  if (!c || c.enabled !== true || !fromStatuses.length) return null;
  return {
    fromStatuses,
    maxSessions: c.maxSessions && c.maxSessions >= 1 ? Math.floor(c.maxSessions) : CONDUCTOR_DEFAULT_MAX_SESSIONS,
    model: c.model ?? CONDUCTOR_DEFAULT_MODEL,
  };
}

/** The human-readable task of a conductor session (/processes, the claim note, the retry-spawn key). PURE. */
export function conductorTask(board: string, cardId: string): string {
  return `${conductorCommand(board, cardId)} — conduzir a story de ponta a ponta`;
}

export type ConductorEntryVerdict = { dispatch: true } | { dispatch: false; reason: string };

/**
 * Does the card's CURRENT status make it a conductor dispatch? PURE — the shell calls it on every entry.
 * Only STORY cards are conducted (activities/steps are map structure; a capture container or a style-guide
 * container is not a unit of delivery), and only a non-terminal `fromStatus` (a terminal status is "done").
 */
export function conductorEntryVerdict(card: Pick<Card, "type" | "status" | "capture" | "container">, config: BoardConfig): ConductorEntryVerdict {
  const policy = resolveConductorPolicy(config);
  if (!policy) return { dispatch: false, reason: "conductor desligado neste board" };
  if (!card.status || !policy.fromStatuses.includes(card.status)) {
    return { dispatch: false, reason: `status '${card.status}' fora de fromStatus [${policy.fromStatuses.join(", ")}]` };
  }
  if (card.type !== "story") return { dispatch: false, reason: `card do tipo '${card.type}' não é conduzido (só story)` };
  if (card.capture || card.container) return { dispatch: false, reason: "contêiner (captura/guia) não é conduzido" };
  if (config.statuses.find((s) => s.id === card.status)?.terminal) return { dispatch: false, reason: "fromStatus é terminal" };
  return { dispatch: true };
}


/**
 * Why a board's `conductor` block can never fire — or null. PURE. An `enabled: true` whose `fromStatus` names no
 * status of the board (a typo, a renamed column) would be the worst kind of failure: declared, accepted by the
 * contract, and silently inert. The board reader surfaces it as a LOUD drift alarm (it never refuses the read —
 * a board does not go dark over a knob), and the lint half is here so it can be tested.
 */
export function conductorConfigProblem(config: Pick<BoardConfig, "conductor" | "statuses">): string | null {
  const c = config.conductor;
  if (!c?.enabled) return null;
  // Each id of the list is judged on its own: ONE typo in a list of four is a quarter of the acceptances that
  // never get a conductor — as inert as a wrong single status, just harder to notice.
  for (const id of conductorFromStatuses(c.fromStatus)) {
    const st = config.statuses.find((s) => s.id === id);
    if (!st) return `conductor.fromStatus '${id}' não é um status deste board — a dispatch do condutor NUNCA dispararia para ele`;
    if (st.terminal) return `conductor.fromStatus '${id}' é terminal — um card pronto nunca ganha condutor`;
  }
  return null;
}
