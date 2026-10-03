import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { decodeRouteParam } from "@/lib/storymap/deep-links";
import { CardDocScreen } from "@/components/CardDocScreen";
import { boardStrategy } from "@/lib/storymap/board-strategy";

export const dynamic = "force-dynamic";

/** A card as a fullscreen PAGE (the drawer stays for quick edits on the kanban). */
export default async function CardPage(props: { params: Promise<{ boardId: string; id: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // Next does not decode App-Router params — see decodeRouteParam. Safe today only because card ids
  // are slugs; decoding makes it a property of the CODE instead of of the current data.
  const card = board.cards.find((c) => c.id === decodeRouteParam(params.id));
  if (!card) notFound();

  const strategy = await boardStrategy(board.config.id, board.config);
  return <CardDocScreen board={board} boards={boards} card={card} strategy={strategy} />;
}
