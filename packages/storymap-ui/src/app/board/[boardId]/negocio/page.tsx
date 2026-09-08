import { redirect } from "next/navigation";

// 🟨 O radical da seção NEGÓCIO não é mais um hub de cartões — o clique no bloco abre a ferramenta
// DEFAULT (Lean Canvas), e as irmãs (Posicionamento) vivem na barra de abas. Este redirect só preserva
// bookmarks/deep-links antigos que ainda apontem para /negocio.
export default async function NegocioPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  redirect(`/board/${params.boardId}/canvas`);
}
