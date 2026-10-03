import { notFound } from "next/navigation";
import { getBoard, listBoards, readCards } from "@/lib/storymap/repo";
import { IdeiasView } from "@/components/IdeiasView";

export const dynamic = "force-dynamic";

// 🟩 Produto · Ideias (OST) — a bancada do espaço do problema (Fase 3c). Server component:
// busca board + cards e delega o CRUD à view (client), que cria/edita as ideias (statement/
// evidência via AssistedEditor + status) e mostra quantas stories cada uma endereça (edge `addresses`).
export default async function IdeiasPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards, cards] = await Promise.all([
    getBoard(params.boardId),
    listBoards(),
    readCards(params.boardId),
  ]);
  if (!board) notFound();
  return <IdeiasView board={board} boards={boards} cards={cards} />;
}
