import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { KanbanBoard } from "@/components/KanbanBoard";

export const dynamic = "force-dynamic";

export default async function KanbanPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();
  return <KanbanBoard board={board} boards={boards} />;
}
