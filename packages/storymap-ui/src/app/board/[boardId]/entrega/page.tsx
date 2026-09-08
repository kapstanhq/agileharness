import { notFound } from "next/navigation";
import { getBoard, listBoards, readCards } from "@/lib/storymap/repo";
import { collectDelivery } from "@/lib/storymap/runner/delivery-deps";
import { EntregaScreen } from "@/components/EntregaScreen";

export const dynamic = "force-dynamic";

// ESTEIRA — onde cada trabalho está, do worktree até produção. (Rota/símbolos seguem `entrega`.)
//
// É uma view DO BOARD (bloco Software), não uma página app-level: veste o MESMO `BoardHeader` das
// irmãs — Kanban, Métricas, Orquestração, Configurações —, então a barra de topo não é "parecida",
// é a mesma. E é o board que dá o contexto que faltava: com ele dá para nomear cada entrega pelo
// CARD que ela serve e mostrar o estado vivo dele (rodando / na fila / conflito / aguardando).
//
// Server-renderiza o panorama + o índice de títulos de card; a ilha cliente mantém tudo vivo.
export default async function EntregaPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards, delivery, cards] = await Promise.all([
    getBoard(params.boardId),
    listBoards(),
    // ESCOPADO ao board: todas as raias respondem sobre o mesmo recorte (antes só "Em curso" filtrava).
    collectDelivery(undefined, params.boardId).catch(() => ({
      frontiers: [],
      work: [],
      publish: [],
      publishTotals: { published: 0, open: 0 },
      generatedAt: new Date().toISOString(),
    })),
    readCards(params.boardId).catch(() => []),
  ]);
  if (!board) notFound();

  // id → título, para uma entrega poder dizer QUAL card ela serve em vez de cuspir o id.
  const cardTitles: Record<string, string> = {};
  for (const c of cards) cardTitles[c.id] = c.title;

  return (
    <EntregaScreen board={board} boards={boards} initial={delivery} cardTitles={cardTitles} />
  );
}
