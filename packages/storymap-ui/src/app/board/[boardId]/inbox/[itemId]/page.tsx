import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { decodeInboxItemId } from "@/lib/storymap/deep-links";
import { InboxItemScreen } from "@/components/inicio/InboxItemScreen";

export const dynamic = "force-dynamic";

/**
 * A single Inbox attention item as a dedicated FULL PAGE (the "página individual" the Início
 * Agêntico feed links to). Mirrors the card page's shape: it resolves the item out of the same
 * collector the cockpit uses (collectBoardCockpitItems), so the page shows the SAME item with the
 * SAME inline actions the inbox has. `params.itemId` arrives PERCENT-ENCODED (Next does not decode
 * App-Router params) — decodeInboxItemId is the inverse of the link builder. A resolved/absent
 * item renders a graceful "resolvido" state (never a 404) — an action taken here can remove the item
 * under the reader.
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

  const itemId = decodeInboxItemId(params.itemId);
  const item = items.find((i) => i.id === itemId) ?? null;

  return <InboxItemScreen board={board} boards={boards} item={item} />;
}
