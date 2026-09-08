import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { VocabularyManager } from "@/components/VocabularyManager";

export const dynamic = "force-dynamic";

export default async function VocabularyPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();
  return <VocabularyManager board={board} boards={boards} />;
}
