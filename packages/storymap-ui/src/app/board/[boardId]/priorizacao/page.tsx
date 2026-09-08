import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { PrioritizationView } from "@/components/PrioritizationView";
import { boardStrategy } from "@/lib/storymap/board-strategy";

export const dynamic = "force-dynamic";

export default async function PrioritizationPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // O norte vem do PRD, resolvido AQUI (servidor) e entregue por prop: sem ele a tela não sabe
  // distinguir "ainda não priorizado" de "não há norte contra o que priorizar" — e o segundo é o
  // caso em que pontuar produz ruído confiante.
  const strategy = await boardStrategy(board.config.id, board.config);
  return <PrioritizationView board={board} boards={boards} strategy={strategy} />;
}
