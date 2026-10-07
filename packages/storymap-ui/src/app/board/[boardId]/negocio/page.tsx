import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { boardWithPersonas } from "@/lib/storymap/board-strategy";
import { SchemaDocPage } from "@/components/doc/DocPage";
import { loadDoc } from "@/lib/storymap/doc/schema-doc-io";
import { pendingDraftsForDoc } from "@/lib/storymap/doc/doc-governance";
import { listGovernanceDrafts } from "@/lib/storymap/sidecars";
import { docProposalNotices } from "@/components/inbox/cockpit-labels";
import { BMC_DOC_TYPE } from "@/lib/storymap/doc/schemas/business-model-canvas";

export const dynamic = "force-dynamic";

// 🟨 NEGÓCIO — a página do Business Model Canvas (`docs/business-model-canvas.md`), os nove blocos num quadro.
// `loadDoc` é o caminho único de leitura: um board que ainda tem o Lean Canvas antigo chega aqui já migrado (a
// migração roda no boot do serviço e, em memória, na leitura).
export default async function NegocioPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId).then((b) => b && boardWithPersonas(b)), listBoards()]);
  if (!board) notFound();

  const loaded = await loadDoc(board.config.id, BMC_DOC_TYPE, board.config);
  if (!loaded) notFound();

  // A versão aprovada é a que está na tela; a proposta pendente (o canvas é do dono) espera no Inbox.
  const drafts = await listGovernanceDrafts(board.config.id);
  const pendingProposals = docProposalNotices(pendingDraftsForDoc(drafts, BMC_DOC_TYPE), board.config.id);

  return (
    <SchemaDocPage
      board={board}
      boards={boards}
      docType={BMC_DOC_TYPE}
      view="negocio"
      initialDoc={loaded.doc}
      initialViolations={loaded.violations}
      pendingProposals={pendingProposals}
    />
  );
}
