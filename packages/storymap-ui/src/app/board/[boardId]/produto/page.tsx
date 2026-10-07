import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { SchemaDocPage } from "@/components/doc/DocPage";
import { PRD_DOC_TYPE } from "@/lib/storymap/doc/schemas/prd";
import { loadDoc } from "@/lib/storymap/doc/schema-doc-io";
import { pendingDraftsForDoc } from "@/lib/storymap/doc/doc-governance";
import { listGovernanceDrafts } from "@/lib/storymap/sidecars";
import { prdBacklogSeed, boardWithPersonas } from "@/lib/storymap/board-strategy";
import { docProposalNotices } from "@/components/inbox/cockpit-labels";

export const dynamic = "force-dynamic";

// 🟩 PRODUTO — a página do PRD (`docs/prd.md`), o documento de NEGÓCIO do produto. O contexto técnico para os
// agentes (`docs/contexto.md`) não tem página: os agentes o leem e mantêm pelo MCP.
export default async function ProdutoPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId).then((b) => b && boardWithPersonas(b)), listBoards()]);
  if (!board) notFound();

  const loaded = await loadDoc(board.config.id, PRD_DOC_TYPE, board.config);
  if (!loaded) notFound();

  // O recorte que semeia o `/criar` desta página — resolvido aqui porque `loadDoc` é de servidor. Vazio enquanto o
  // PRD não disser o que construir: aí o `/criar` abre a captura em branco, nunca uma proposta inventada.
  const backlogSeed = await prdBacklogSeed(board.config.id, board.config);

  // O que está na tela é a versão APROVADA. Uma proposta de PRD pendente espera no Inbox — sem este aviso,
  // quem abre o documento lê a versão velha achando que é a última.
  const drafts = await listGovernanceDrafts(board.config.id);
  const pendingProposals = docProposalNotices(pendingDraftsForDoc(drafts, PRD_DOC_TYPE), board.config.id);

  return (
    <SchemaDocPage
      board={board}
      boards={boards}
      docType={PRD_DOC_TYPE}
      view="produto"
      initialDoc={loaded.doc}
      initialViolations={loaded.violations}
      pendingProposals={pendingProposals}
      backlogSeed={backlogSeed}
    />
  );
}
