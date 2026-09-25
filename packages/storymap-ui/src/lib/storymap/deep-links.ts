// WS-4 (copilot-actionability) — the single source of the deep-link URLs BETWEEN pages: the ONE
// per-card link (→ Inbox, focused+ringed) and the /processes anchoring links (§4.6). Zero
// IO/React — only strings + `import type` (invariant 5). Every surface that used to hand-roll a
// `/board/<id>/kanban` literal imports these instead (the URLs-only-via-helpers invariant of this WS).

import type { Demand } from "./demands";

/**
 * The ONLY deep-link by card in the app (CockpitView.tsx's focus effect — scrolls to + rings the
 * FIRST CockpitItem of the card for ~2s). `cardId` is encoded — it rides a hostile-input query value;
 * `boardId` is a validated slug (SLUG_RE in copilot/escalation.ts) and stays a plain path segment,
 * matching every existing `/board/<id>/...` literal in the app.
 */
export function inboxFocusHref(boardId: string, cardId: string): string {
  return `/board/${boardId}/inbox?focus=${encodeURIComponent(cardId)}`;
}

/**
 * The dedicated FULL PAGE of a SINGLE Inbox item (Início Agêntico — item individual). Unlike
 * {@link inboxFocusHref} (which rings a card's first item inside the cockpit list), this is a route
 * per attention item. `itemId` is the opaque composite `CockpitItem.id` (`<cardId>:q:<qid>`,
 * `apr:<id>`, `gov:<draftId>`…) so it rides ENCODED in the path segment. Read it back with
 * {@link decodeInboxItemId} — NEVER with `params.itemId` raw. `boardId` is a validated slug and
 * stays a plain segment.
 */
export function inboxItemHref(boardId: string, itemId: string): string {
  return `/board/${boardId}/inbox/${encodeURIComponent(itemId)}`;
}

/**
 * Read ANY dynamic route segment back into the value that built it. Use this on every `params.*` that
 * is compared, looked up, or matched — it is the read half of `encodeURIComponent` on the write half.
 *
 * Next.js does **not** decode App-Router `params`. A `story-x:q:1` link arrives as `story-x%3Aq%3A1`,
 * so comparing `params.itemId` straight against `item.id` never matches — that is exactly how the
 * Inbox item page rendered "este item já foi resolvido" for an item that was very much open.
 * (Next normalizes a literal `:` into `%3A` as well, so writing the raw id in the URL bar doesn't
 * save you either.)
 *
 * The class is wider than that one page: a route is safe only while its ids happen to be pure slugs,
 * which is a property of today's DATA, not of the code. Decode on read and the route is correct for
 * whatever the write path lets in.
 *
 * Malformed input (a stray `%`) makes `decodeURIComponent` throw; a hand-typed URL must render the
 * graceful not-found, never a 500 — so we fall back to the raw segment, which simply won't match.
 */
export function decodeRouteParam(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** How many decode passes an Inbox segment gets — one for the link we build, two more for re-encoders. */
const INBOX_DECODE_PASSES = 3;

/**
 * The successive decodings of an Inbox item segment, shallowest first: `[once, twice, …]`, at most
 * {@link INBOX_DECODE_PASSES}. A pass happens only while the value still carries a `%XX` escape AND decoding
 * changes it, so a raw id, a malformed one and a fully-decoded one all stop at one rung — and nothing throws.
 *
 * Why more than one: the link is sometimes RE-encoded by whatever rendered it (a chat, an e-mail client, a
 * markdown renderer). `gov%3A<id>` arrives as `gov%253A<id>`; one decode leaves `gov%3A<id>`, which names no
 * item, and the page used to tell the owner a still-pending item "was resolved". Measured in production.
 *
 * Only the Inbox gets this — {@link decodeRouteParam} stays ONE pass on purpose: the MCP route compares a
 * SECRET with it (peeling layers in an auth comparison widens what it accepts: `%2541` would equal `A`), and
 * vocabulary ids are open-ended text where a literal `%41` is plausible.
 */
export function inboxItemIdCandidates(segment: string): string[] {
  const rungs = [decodeRouteParam(segment)];
  while (rungs.length < INBOX_DECODE_PASSES) {
    const last = rungs[rungs.length - 1];
    if (!/%[0-9A-Fa-f]{2}/.test(last)) break;
    const next = decodeRouteParam(last);
    if (next === last) break; // malformed — decodeRouteParam fell back to the input
    rungs.push(next);
  }
  return rungs;
}

/**
 * Read an Inbox item segment back into the id — as deep as {@link inboxItemIdCandidates} goes. Use it where
 * there is no list to match against; to FIND the item use {@link findInboxItem}, which prefers the shallowest
 * rung that names one.
 */
export function decodeInboxItemId(segment: string): string {
  const rungs = inboxItemIdCandidates(segment);
  return rungs[rungs.length - 1];
}

/**
 * The item a segment names: the FIRST rung of {@link inboxItemIdCandidates} that matches an item id. Generated
 * ids never carry `%`, but hand-authored card data (a card file stem, a question/finding id written in the
 * frontmatter, a status id in board.yaml) is not validated against it — so an id with a literal `%41` must keep
 * opening through its own link. Shallowest-first gives it that: its single decode matches before any deeper
 * rung is tried.
 */
export function findInboxItem<T extends { id: string }>(items: readonly T[], segment: string): T | null {
  for (const id of inboxItemIdCandidates(segment)) {
    const hit = items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * A visão do documento de um card. Vive aqui — e não na tela — porque quem MANDA alguém para uma
 * visão específica é outra tela (o Kanban manda "Definir o lugar" para os Campos), e importar a
 * página do card só para ler uma constante arrastaria o editor inteiro para o bundle do quadro.
 */
export type CardView = "doc" | "markdown" | "campos";

/**
 * A card's page. The id is a slug today, but the encode/decode pair is what KEEPS the route correct
 * if that ever stops being true — the same reason this file owns every other URL.
 *
 * `view` abre a página JÁ na visão pedida (`?view=campos`): é o que faz um erro de posicionamento
 * aterrissar no formulário onde ele se resolve, em vez de na leitura.
 */
export function cardHref(boardId: string, cardId: string, opts?: { view?: CardView }): string {
  const base = `/board/${boardId}/card/${encodeURIComponent(cardId)}`;
  return opts?.view ? `${base}?view=${opts.view}` : base;
}

/**
 * A página de CRIAÇÃO de um card. O contexto inicial viaja na query — é assim que o "+ story" de uma
 * célula passo×release do Mapa nasce já com pai, release e o status de entrada.
 */
export function newCardHref(
  boardId: string,
  init: { type: string; parent?: string | null; release?: string | null; status?: string | null },
): string {
  const q = new URLSearchParams({ tipo: init.type });
  if (init.parent) q.set("pai", init.parent);
  if (init.release) q.set("release", init.release);
  if (init.status) q.set("status", init.status);
  return `/board/${boardId}/card/novo?${q.toString()}`;
}

/**
 * A vocabulary entity's page. This one is not merely hygiene: the WRITE path is open — the MCP
 * `save_persona`/`save_system` take `id: z.string()` with no slugify — so an agent can legitimately
 * store `"Mãe Solo"` or `"usuario:novo"` today, and without the pair below that entity's page is a
 * permanent 404.
 */
export function vocabEntityHref(boardId: string, kind: "persona" | "sistema", id: string): string {
  return `/board/${boardId}/vocabulario/${kind}/${encodeURIComponent(id)}`;
}

/**
 * Destination of a demand row: `inbox?focus` for every `DemandType` that projects to a
 * `CockpitItemKind` — TRANSITIONAL EXCEPTION: `deploy-unsettled` | `release-aging` have no
 * `CockpitItemKind` yet (the assimetria WS-5 corrects), so pointing `focus` there would land the
 * operator on o Inbox with nothing to ring; they fall back to the kanban until WS-5 promotes them
 * (flip this + the corresponding test when it does).
 */
export function demandHref(d: Pick<Demand, "type" | "boardId" | "cardId">): string {
  if (d.type === "deploy-unsettled" || d.type === "release-aging") {
    return `/board/${d.boardId}/kanban`;
  }
  return inboxFocusHref(d.boardId, d.cardId);
}

/** Anchor a merge-train entry in /processes (receptor §4.6) — `MergeQueueRow`'s key is `mq:<runId>`. */
export function processesMergeHref(runId: string): string {
  return `/processes?run=${encodeURIComponent(runId)}`;
}

/**
 * Anchor a `RunningService` row in /processes; `serviceId` matches the shape of
 * `RunningService.id` (vps/types.ts) — see {@link runServiceId} for the `runner-run` case.
 */
export function processesServiceHref(serviceId: string): string {
  return `/processes?svc=${encodeURIComponent(serviceId)}`;
}

/**
 * The serviceId of a card's run row — mirrors `ProcessesClient.tsx`'s own
 * `` `run:${r.board}/${r.cardId}` `` build (the merge key for the SSE-overlaid `RunningService`).
 * Raw (unencoded): callers that turn it into a URL go through {@link processesServiceHref}.
 */
export function runServiceId(boardId: string, cardId: string): string {
  return `run:${boardId}/${cardId}`;
}
