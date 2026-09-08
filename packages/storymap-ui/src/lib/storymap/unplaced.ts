// SM-02 — hierarchy gate for orphan stories.
//
// The map only hangs a story under its step (`parent === stepId`), so a story with
// `parent: null` has no branch to live on (it shows only in the flat KanbanBoard —
// the outline surfaces it in a dedicated "Sem lugar no mapa" group). To stop write
// paths from silently minting placeless stories, a
// parentless story is auto-routed to the "Backlog não-mapeado" lane via a sparse
// `unplaced: true` flag (the soft gate, Opção B). These pure, isomorphic classifiers
// are the single source of truth for that decision and the two render buckets — shared
// by the server action (commitProposalAction) and the client board components.

import type { Card, CardType } from "./types";
import type { StoryType } from "./frameworks";

/**
 * True for an ephemeral capture/style CONTAINER card — it holds free text (`capture`) or a
 * style-guide generation (`container`) and is reviewed on its OWN surface (Inbox / Estilo),
 * never as a board work item, regardless of its type or status. It is NOT a real backbone or
 * delivery story, so it has no map placement and is not kanban work — the single classifier both
 * the kanban filter (views.ts kanbanStories) and the placement-debt lint ({@link isPlacementDebt})
 * read, so they can't drift.
 */
export function isContainerCard(card: Card): boolean {
  return card.capture === true || card.container != null;
}

/**
 * The soft-gate decision at CREATION time: a `story` with no parent must be routed to
 * the unmapped backlog (`unplaced: true`) rather than minted as a silent orphan.
 * activities/steps are valid parentless backbone roots and are NEVER unplaced.
 */
export function shouldBeUnplaced(type: CardType, parent: string | null): boolean {
  return type === "story" && parent == null;
}

/**
 * `serves` conta como LUGAR NO MAPA? Só para um item de ENTREGA (storyType technical/bug/chore/spike): a
 * prateleira de entrega o pendura sob a user story que ele serve. Numa USER story o campo é descartado no
 * commit (isDelivery=false) — aceitá-lo como placement mintaria um órfão silencioso, que é exatamente o bug
 * que esta regra fecha.
 *
 * Fonte ÚNICA da regra: ela é lida pelo chokepoint de escrita (commitProposalAction) E pelo pre-check do
 * `create_card` (MCP). Duas cópias de uma regra sutil como esta é drift garantido — o dia em que uma mudasse,
 * um dos caminhos voltaria a criar órfão. PURE.
 */
export function servesIsPlacement(
  storyType: StoryType | null | undefined,
  serves: string | null | undefined,
): boolean {
  return !!serves && storyType != null && storyType !== "user";
}

/**
 * A story that lives in the "Backlog não-mapeado" lane (AC1/AC2): it was created
 * unplaced AND has no parent. The `parent == null` guard keeps a story that was later
 * dragged onto a step out of the lane even if a stale `unplaced: true` lingers on disk.
 */
export function isUnplacedStory(card: Card): boolean {
  return card.type === "story" && card.unplaced === true && card.parent == null;
}

/**
 * A LEGACY orphan (AC3): a parentless story WITHOUT the intentional `unplaced` flag that is ALSO
 * unattributed on the map — i.e. one created before this gate existed and not rescued by a `serves`
 * override. It has no branch on the map (no step parent, no served node), so the
 * KanbanBoard flags it with a warning badge instead of hiding it silently. A delivery story with an
 * explicit `serves` (parent null but attributed to a node — see {@link servesTarget}) is NOT an
 * orphan: it shows on that node's shelf, so it must not carry the warning.
 */
export function isLegacyOrphan(card: Card): boolean {
  return (
    card.type === "story" && card.parent == null && card.unplaced !== true && servesTarget(card) == null
  );
}

/**
 * Does this card belong on the User Story Map backbone? A Story Map (Jeff Patton) is a
 * backbone of the USER's narrative — activities → steps → user stories. Only
 * `storyType: "user"` stories are user-facing; technical/bug/chore/spike are DELIVERY
 * work (the "how"), which belongs in the Kanban view, not on the map — otherwise the
 * backbone fills with system noise and stops telling the user's story. `storyType` is
 * never null for a story (coerceCard defaults it to "user" — repo.ts), so this also
 * keeps legacy stories visible. Mirrors `needsUiDesign` (pipeline-routing.ts): the same
 * user-vs-delivery line that already drives the UI-design/QA skips.
 */
export function isBackboneStory(card: Card): boolean {
  return card.type === "story" && card.storyType === "user";
}

/**
 * The exact inverse of {@link isBackboneStory} over stories: a DELIVERY story is `type:story`
 * with a non-user storyType (technical/bug/chore/spike) — the "how", not the user-facing "what".
 * Delivery work doesn't sit on the backbone; it's attributed to the map node it serves and shown
 * on that node's collapsed delivery shelf (kanban is its primary home). `storyType` is the single
 * authority for this split (already so at pipeline-routing.ts/gates.ts/priority.ts) — never a
 * stored classification, so the two helpers can't drift. coerceCard guarantees a story's storyType
 * is non-null (defaults "user"); the explicit null-guard keeps the predicate total for any input.
 */
export function isDeliveryStory(card: Card): boolean {
  return card.type === "story" && card.storyType != null && card.storyType !== "user";
}

/**
 * The EFFECTIVE map-node a delivery story is attributed to — the single value every consumer
 * (the map's delivery shelf, the lint, the WARN badge) reads. `serves` is an OVERRIDE on top of
 * `parent`: a delivery story with no explicit `serves` falls back to its `parent` (the 100%-covered
 * case → zero data churn). Returns null for non-delivery cards (user stories, activities, steps) and
 * for a delivery story with neither serves nor parent (an unattributed orphan — surfaced by a badge).
 */
export function servesTarget(card: Card): string | null {
  if (!isDeliveryStory(card)) return null;
  return card.serves ?? card.parent ?? null;
}

/**
 * Fase 4.3 — the badge/affordance predicate: a `story` that the `hasPlacement` gate will HOLD at construction
 * because it has no decided place on the map — no `parent` (the step), no `serves` (the user-story it serves),
 * and no explicit `unplacedAck`. MIRRORS gate-core.js `hasPlacement.ok` EXACTLY (same `nonEmpty` semantics —
 * a ""/whitespace parent/serves counts as absent) so the "sem lugar" badge and the gate never disagree at the
 * empty-string edge. Distinct from {@link isLegacyOrphan} (which ignores `unplacedAck` and requires
 * `unplaced !== true`): an acknowledged orphan is NOT `needsPlacement` (the gate passes) but may still be a
 * legacy orphan on the map. Pure/node-unit-testable.
 */
export function needsPlacement(card: Card): boolean {
  const nonEmpty = (v: unknown) => v != null && String(v).trim() !== "";
  return card.type === "story" && !nonEmpty(card.parent) && !nonEmpty(card.serves) && card.unplacedAck == null;
}

/**
 * Placement DEBT — the board-integrity WS6 lint's scope: a LIVE story that genuinely owes a decided
 * place on the map ({@link needsPlacement}) and SHOULD be flagged. It EXCLUDES cards that legitimately
 * have no map placement and are therefore not debt:
 *   • ephemeral capture/style CONTAINERS ({@link isContainerCard}) — their own surface, never on the map;
 *   • TERMINAL cards (concluída/arquivados/duplicado/cancelado/capturado) — done/archived, out of the
 *     "Em aberto" view, so their placement is moot (a shipped orphan is history, not forward debt);
 *   • STAGING cards (the `triage`/Triagem intake pen) — pre-map BY DESIGN: a card RESTS in the inbox
 *     until a human/agent triages it (accept / duplicate / decline), so it has no place YET and that is
 *     not debt. The symmetric twin of the terminal exemption (terminal = past the map; staging = before
 *     it). Without it, EVERY un-triaged inbox card counted as debt and FAIL-CLOSED the merge gate — an
 *     idle pipeline still couldn't ship until someone emptied the inbox (the reported bug).
 * Deliberately SEPARATE from {@link needsPlacement} (which mirrors the `hasPlacement` GATE and must stay
 * total over the empty-string edge for badge↔gate parity) — WS6 is a repo-hygiene lint, not the gate; the
 * gate correctly still requires a placement to LEAVE triage.
 * Pure: receives the board's terminal + staging status ids (views.ts terminalStatusIds / stagingStatusIds)
 * so it never reads config.
 */
export function isPlacementDebt(
  card: Card,
  terminalIds: ReadonlySet<string>,
  stagingIds: ReadonlySet<string>,
): boolean {
  if (isContainerCard(card)) return false;
  if (card.status != null && terminalIds.has(card.status)) return false;
  if (card.status != null && stagingIds.has(card.status)) return false;
  return needsPlacement(card);
}

/**
 * Group DELIVERY stories by the backbone node they serve ({@link servesTarget}). A delivery ticket
 * is attributed to — and rendered on the shelf of — the node it serves: a user STORY (the shelf
 * inside its card) OR a STEP (the shelf row under that step on the map). Broadening the old
 * user-story-only attribution is the map fix: a bug/technical ticket that serves a STEP (the common
 * case — `parent: step-*`) was invisible on the map and lived only in the Kanban; now it shows under
 * its step. Activities and non-existent/other targets are skipped here (those cards remain visible in
 * the Kanban, the guaranteed home for all delivery work). `keep` applies the board's view filter
 * (default keeps all). Pure — the caller sorts each list. In the outline (lib/storymap/outline.ts) a
 * delivery card is a CHILD row of the node it serves — under the story, or under the step.
 */
export function groupDeliveryByNode(
  cards: Card[],
  keep: (c: Card) => boolean = () => true,
): Map<string, Card[]> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const m = new Map<string, Card[]>();
  for (const c of cards) {
    if (!isDeliveryStory(c) || !keep(c)) continue;
    const target = servesTarget(c);
    if (!target) continue;
    const node = byId.get(target);
    if (!node) continue;
    const attaches = (node.type === "story" && node.storyType === "user") || node.type === "step";
    if (!attaches) continue;
    (m.get(target) ?? m.set(target, []).get(target)!).push(c);
  }
  return m;
}

/**
 * The "surface health" of a card OTHER deliveries are attributed to (typically a user story): how many
 * delivery cards SERVE it (`servesTarget === target.id`) and how many of those are OPEN REGRESSIONS (a
 * bug/fix not yet in a terminal status). Powers the owner-card rollup chip ("N entregas · X regressões
 * abertas"). This is the SERVES axis (delivery → story), NOT the `addresses` edge (story → idea)
 * resolved by getAddressedIdea — don't confuse them. Pure: receives the pool + the terminal
 * status ids (terminalStatusIds(config)) so it never reads config and stays node-unit-testable.
 */
export function surfaceHealth(
  target: Card,
  pool: Card[],
  terminalIds: ReadonlySet<string>,
): { serving: number; openRegressions: number } {
  const serving = pool.filter((c) => c.id !== target.id && servesTarget(c) === target.id);
  const openRegressions = serving.filter(
    (c) => (c.storyType === "bug" || c.mode === "fix") && !(c.status != null && terminalIds.has(c.status)),
  );
  return { serving: serving.length, openRegressions: openRegressions.length };
}
