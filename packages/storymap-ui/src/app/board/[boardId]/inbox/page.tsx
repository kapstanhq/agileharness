import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { CockpitView } from "@/components/CockpitView";

export const dynamic = "force-dynamic";

// /board/[boardId]/inbox — the per-board "Inbox" cockpit. The CockpitItem folding (cards +
// stuck + conflict + proposal + design, with telemetry/merge-queue/sidecar IO) lives in
// collectBoardCockpitItems (lib/storymap/cockpit-collect) — the SINGLE source of truth shared with the
// top-nav demand badge (getBoardDemandsAction), so the badge count can never diverge from this page.
// /perguntas remains the secondary cross-board aggregate view.
//
// ESTA TELA MOSTRA TUDO, SEMPRE. O "Pular" do carrossel da home é navegação — deixa uma marca de
// visto (inbox-seen.ts) e nada mais. Nenhum filtro chega aqui: a lista é a verdade inteira do board,
// e é para cá que o operador vem quando quer ver o que existe, não o que sobrou.

export default async function InboxPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const boardId = params.boardId;
  const [board, boards, items] = await Promise.all([
    getBoard(boardId),
    listBoards(),
    collectBoardCockpitItems(boardId),
  ]);
  if (!board) notFound();

  return (
    <CockpitView
      boards={boards}
      config={board.config}
      boardId={boardId}
      items={items}
      cards={board.cards}
    />
  );
}
