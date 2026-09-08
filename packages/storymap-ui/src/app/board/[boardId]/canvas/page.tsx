import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { CanvasScreen } from "@/components/CanvasScreen";
import { LEAN_CANVAS_DOC_TYPE } from "@/lib/storymap/doc/schemas/lean-canvas";
import { loadDoc } from "@/lib/storymap/doc/schema-doc-io";

export const dynamic = "force-dynamic";

export default async function CanvasPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // `loadDoc` é o caminho único: disco, com a projeção do `board.yaml` como piso enquanto o
  // `docs/lean-canvas.md` não existir (migração preguiçosa). A tela abre com o conteúdo de sempre e o
  // primeiro save grava o .md — nada roda antes, nada é sobrescrito, e o corte da prosa antiga em
  // ITENS é revisado por um humano aqui, em vez de por um script que ninguém conferiria.
  const loaded = await loadDoc(board.config.id, LEAN_CANVAS_DOC_TYPE, board.config);
  if (!loaded) notFound();

  return (
    <CanvasScreen
      board={board}
      boards={boards}
      initialDoc={loaded.doc}
      initialViolations={loaded.violations}
    />
  );
}
