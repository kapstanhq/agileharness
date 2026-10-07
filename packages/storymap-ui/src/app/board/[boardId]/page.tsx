import { notFound, redirect } from "next/navigation";
import { getBoard } from "@/lib/storymap/repo";
import { boardHomeHref } from "@/components/nav/nav-groups";

export const dynamic = "force-dynamic";

// A raiz do board REDIRECIONA para a casa dele — o Kanban (o Início foi eliminado) —, espelhando a porta `/`
// do app, para que o default do app e o default do board concordem. Qualquer URL truncada até a raiz, bookmark
// pelado ou fallback de navegação cai no Kanban.
export default async function BoardPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const board = await getBoard(params.boardId);
  if (!board) notFound();
  redirect(boardHomeHref(params.boardId));
}
