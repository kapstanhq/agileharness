import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { readSystemDecisions } from "@/lib/storymap/runner/decision-log";
import { followUpItems } from "@/lib/storymap/system-decisions";
import { AcompanharView } from "@/components/AcompanharView";

export const dynamic = "force-dynamic";

// «Acompanhar» (política só-negócio) — a lista SIMPLES do que o sistema decidiu em nome do dono, com o porquê e o
// «Desfazer». É a superfície provisória: o redesenho do Inbox (onda 2) a absorve como seção. A projeção é pura
// (`followUpItems`); a pré-condição de cada desfazer é checada de novo no servidor, sob o lock.
export default async function AcompanharPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;
  const [board, boards, entries] = await Promise.all([getBoard(params.boardId), listBoards(), readSystemDecisions({ board: params.boardId })]);
  if (!board) notFound();
  return <AcompanharView board={board} boards={boards} items={followUpItems(entries, { board: board.config.id })} />;
}
