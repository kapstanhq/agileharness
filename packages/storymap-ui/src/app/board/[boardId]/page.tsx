import { notFound, redirect } from "next/navigation";
import { getBoard } from "@/lib/storymap/repo";

export const dynamic = "force-dynamic";

// A raiz do board ganhou uma HOME de verdade: em vez de renderizar o mapa USM (que agora mora em
// /mapa), /board/[id] REDIRECIONA para o Início — espelhando o front-door `/` (app), para que o
// default do app e o default do board finalmente concordem. Assim qualquer URL truncada até a raiz,
// bookmark pelado ou fallback de navegação cai na home, e nunca mais no mapa por acidente.
export default async function BoardPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const board = await getBoard(params.boardId);
  if (!board) notFound();
  redirect(`/board/${params.boardId}/inicio`);
}
