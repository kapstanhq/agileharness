import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { PrdScreen } from "@/components/PrdScreen";
import { PRD_DOC_TYPE } from "@/lib/storymap/doc/schemas/prd";
import { loadDoc } from "@/lib/storymap/doc/schema-doc-io";
import { prdBacklogSeed } from "@/lib/storymap/board-strategy";

export const dynamic = "force-dynamic";

export default async function PrdPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // `loadDoc` é o caminho único: disco, com a projeção da escada estratégica (`positioning` /
  // `businessMetric` / `desiredOutcome` do `board.yaml`) como piso enquanto o `docs/prd.md` não
  // existir. Um board que já declarou norte abre com o norte no lugar certo e o esqueleto do que
  // faltava; o primeiro save grava o `.md` e o YAML vira vestígio. Nada roda antes, nada é
  // sobrescrito, e o corte da prosa antiga em itens é revisado por um humano AQUI.
  const loaded = await loadDoc(board.config.id, PRD_DOC_TYPE, board.config);
  if (!loaded) notFound();

  // O recorte que semeia a captura — resolvido aqui porque `loadDoc` é de servidor. Vazio enquanto o
  // PRD não disser o que construir, e é o próprio botão que some: gerar backbone a partir de nada
  // devolveria uma proposta inventada com a mesma cara de uma boa.
  const backlogSeed = await prdBacklogSeed(board.config.id, board.config);

  return (
    <PrdScreen
      board={board}
      boards={boards}
      initialDoc={loaded.doc}
      initialViolations={loaded.violations}
      backlogSeed={backlogSeed}
    />
  );
}
