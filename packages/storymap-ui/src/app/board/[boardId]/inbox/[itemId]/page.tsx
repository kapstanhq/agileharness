import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { decodeInboxItemId, findInboxItem } from "@/lib/storymap/deep-links";
import { governanceDraftIdFromItemId } from "@/lib/storymap/demands";
import { readGovernanceDraft } from "@/lib/storymap/sidecars";
import { InboxItemScreen } from "@/components/inicio/InboxItemScreen";
import { inboxAbsentState } from "@/components/inicio/cockpit-labels";

export const dynamic = "force-dynamic";

/**
 * A single Inbox attention item as a dedicated FULL PAGE (the "página individual" the Início
 * Agêntico feed links to). Mirrors the card page's shape: it resolves the item out of the same
 * collector the cockpit uses (collectBoardCockpitItems), so the page shows the SAME item with the
 * SAME inline actions the inbox has. `params.itemId` arrives PERCENT-ENCODED (Next does not decode
 * App-Router params) — and sometimes encoded TWICE by whatever rendered the link; findInboxItem peels
 * the layers. An absent item renders a graceful state (never a 404) — an action taken here can remove
 * the item under the reader — and that state says only what is known: the real outcome of a
 * governance draft still on disk, otherwise "not in the Inbox (resolved, or a broken link)".
 */
export default async function InboxItemPage(props: {
  params: Promise<{ boardId: string; itemId: string }>;
}) {
  const params = await props.params;

  const [board, boards, items] = await Promise.all([
    getBoard(params.boardId),
    listBoards(),
    collectBoardCockpitItems(params.boardId),
  ]);
  if (!board) notFound();

  const item = findInboxItem(items, params.itemId);

  // Ausente: a proposta de governança em disco sabe o próprio desfecho (um arquivo só); o resto não sabe.
  let absent = null;
  if (!item) {
    const draftId = governanceDraftIdFromItemId(decodeInboxItemId(params.itemId));
    const draft = draftId ? await readGovernanceDraft(board.config.id, draftId) : null;
    absent = inboxAbsentState(draft);
  }

  return <InboxItemScreen board={board} boards={boards} item={item} absent={absent} />;
}
