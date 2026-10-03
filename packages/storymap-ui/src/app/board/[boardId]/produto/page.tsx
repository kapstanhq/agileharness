import { redirect } from "next/navigation";

// 🟩 O radical da seção PRODUTO não é mais um hub de cartões — o clique no bloco abre a ferramenta
// DEFAULT (User Story Mapping), e as irmãs (Ideias · Priorização · Personas & Sistemas) vivem
// na barra de abas. Este redirect só preserva bookmarks/deep-links antigos que ainda apontem para
// /produto.
export default async function ProdutoPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  redirect(`/board/${params.boardId}/mapa`);
}
