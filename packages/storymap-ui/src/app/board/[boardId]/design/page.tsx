import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { readStyleGuide } from "@/lib/storymap/sidecars";
import { checkAA, isEmptyStyleGuideDoc } from "@/lib/storymap/style-guide";
import { DesignScreen } from "@/components/design/DesignScreen";

export const dynamic = "force-dynamic";

// 🟥 DESIGN — a página do guia de estilo (`design/style-guide.md`). O kernel do guia (`style-guide.ts`) puxa
// `node:crypto`, então TODA função dele roda aqui, no servidor — o "está vazio?" e o contraste AA de cada par de cor
// — e o cliente recebe só dados.
export default async function DesignPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  const guide = await readStyleGuide(params.boardId);
  const published = guide && !isEmptyStyleGuideDoc(guide) ? guide : null;

  return <DesignScreen board={board} boards={boards} styleGuide={published} aa={published ? checkAA(published) : null} />;
}
