import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { boardDecidirCardIds } from "@/lib/storymap/inbox/decidir-ids";
import { KanbanBoard } from "@/components/KanbanBoard";

export const dynamic = "force-dynamic";

export default async function KanbanPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  // O Decidir do Inbox vem junto com o board: a raia do dono abre já certa, sem esperar a leitura do cliente.
  const [board, boards, owner] = await Promise.all([getBoard(params.boardId), listBoards(), boardDecidirCardIds(params.boardId)]);
  if (!board) notFound();
  return <KanbanBoard board={board} boards={boards} owner={owner} />;
}
