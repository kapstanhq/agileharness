import { permanentRedirect } from "next/navigation";

// A página de UMA persona/sistema (`/vocabulario/<tipo>/<id>`) saiu junto com Personas & Sistemas (fase 2): as
// personas são a seção «Personas» do PRD. O link antigo cai na página de Produto.
export default async function RedirectPage(props: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await props.params;
  permanentRedirect(`/board/${boardId}/produto`);
}
