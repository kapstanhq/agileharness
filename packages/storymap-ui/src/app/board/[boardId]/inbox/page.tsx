import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { collectInbox } from "@/lib/storymap/inbox/collect";
import { CockpitView } from "@/components/CockpitView";

export const dynamic = "force-dynamic";

// /board/[boardId]/inbox — o MESMO Inbox de todos os boards (decisão 2 do dono), dentro da casca do board (a barra,
// a navegação do celular). O filtro de board fica a um toque. Um coletor só (lib/storymap/inbox/collect): a mesma
// leitura do chip da barra, da aba do celular, da home e da página do item.
//
// ESTA TELA MOSTRA TUDO, SEMPRE. Nenhum filtro chega aqui sem o dono pedir (o `?board=`).

export default async function InboxPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;
  const [board, boards, snapshot] = await Promise.all([getBoard(params.boardId), listBoards(), collectInbox()]);
  if (!board) notFound();
  return <CockpitView boards={boards} config={board.config} snapshot={snapshot} />;
}
