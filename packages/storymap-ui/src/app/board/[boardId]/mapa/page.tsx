import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { AgileHarnessOutline } from "@/components/AgileHarnessOutline";
import { boardDesiredOutcome } from "@/lib/storymap/board-strategy";

export const dynamic = "force-dynamic";

// O User Story Map (mapa USM) ganhou rota própria. Antes ELE era o default da raiz do board
// (/board/[id]); agora a raiz redireciona para o Início e o mapa mora aqui, em /mapa — a view
// "Produto › User Story Mapping" aponta para cá.
//
// A tela é um OUTLINE (a árvore ação › passo › story › entrega, aberta um nível por vez) e não mais a
// grade 2D passos × releases: quem decide o que aparece, em que ordem e com que resumo é a derivação
// PURA em lib/storymap/outline.ts — o componente só a desenha.
export default async function MapaPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();
  const desiredOutcome = await boardDesiredOutcome(board.config.id, board.config);
  return <AgileHarnessOutline board={board} boards={boards} desiredOutcome={desiredOutcome} />;
}
