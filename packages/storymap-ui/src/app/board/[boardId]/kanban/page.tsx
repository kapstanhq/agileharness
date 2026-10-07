import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { boardFeatures, boardWithPersonas } from "@/lib/storymap/board-strategy";
import { boardDecidirCardIds } from "@/lib/storymap/inbox/decidir-ids";
import { featureAnchoredOnce } from "@/lib/storymap/runner/feature-anchor";
import { KanbanBoard } from "@/components/KanbanBoard";
import { kanbanBoard, kanbanFeatures } from "@/lib/storymap/kanban-payload";

export const dynamic = "force-dynamic";

export default async function KanbanPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  // O Decidir do Inbox vem junto com o board: a raia do dono abre já certa, sem esperar a leitura do cliente.
  // As funcionalidades do PRD (fase 7) agrupam os cards; sem nenhuma, o quadro agrupa pelo passo do mapa.
  const [board, boards, owner, anchoredOnce] = await Promise.all([
    getBoard(params.boardId).then((b) => b && boardWithPersonas(b)),
    listBoards(),
    boardDecidirCardIds(params.boardId),
    featureAnchoredOnce(params.boardId).catch(() => false),
  ]);
  if (!board) notFound();
  const features = await boardFeatures(board.config.id, board.config).catch(() => []);
  // kanbanBoard: só o que o quadro lê vai ao navegador (o board inteiro pesava megabytes por abertura).
  return <KanbanBoard board={kanbanBoard(board)} boards={boards} owner={owner} features={{ list: kanbanFeatures(features), anchoredOnce }} />;
}
