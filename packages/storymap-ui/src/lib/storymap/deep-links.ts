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

/** Named alias at the Inbox call site — the item id is the one that provably needed it. */
export const decodeInboxItemId = decodeRouteParam;

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
