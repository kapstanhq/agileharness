import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { boardDecidirCardIds } from "@/lib/storymap/inbox/decidir-ids";
import { KanbanBoard } from "@/components/KanbanBoard";
import { kanbanBoard } from "@/lib/storymap/kanban-payload";

export const dynamic = "force-dynamic";

export default async function KanbanPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  // O Decidir do Inbox vem junto com o board: a raia do dono abre já certa, sem esperar a leitura do cliente.
  const [board, boards, owner] = await Promise.all([getBoard(params.boardId), listBoards(), boardDecidirCardIds(params.boardId)]);
  if (!board) notFound();
  // kanbanBoard: só o que o quadro lê vai ao navegador (o board inteiro pesava megabytes por abertura).
  return <KanbanBoard board={kanbanBoard(board)} boards={boards} owner={owner} />;
}
