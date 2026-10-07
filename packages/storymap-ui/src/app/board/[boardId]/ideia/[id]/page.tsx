import { permanentRedirect } from "next/navigation";
import { cardHref, decodeRouteParam } from "@/lib/storymap/deep-links";

// A página de UMA ideia saiu junto com a bancada de Ideias (fase 2). A ideia é um card: o link antigo abre a
// página dele.
export default async function RedirectPage(props: { params: Promise<{ boardId: string; id: string }> }) {
  const { boardId, id } = await props.params;
  permanentRedirect(cardHref(boardId, decodeRouteParam(id)));
}
