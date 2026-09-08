import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { decodeRouteParam } from "@/lib/storymap/deep-links";
import { IdeaDocScreen } from "@/components/IdeaDocScreen";
import { ToastProvider } from "@/components/Toast";

export const dynamic = "force-dynamic";

/** Uma Ideia como DOCUMENTO em tela cheia (ADR-066). A listagem fica em `/ideias` (plural). */
export default async function IdeaPage(props: {
  params: Promise<{ boardId: string; id: string }>;
  // Next 15: `searchParams` é PROMISE. O corpo já dava `await` (o codemod acertou a leitura e
  // deixou o TIPO para trás — `await` sobre não-Promise é no-op, então nada quebrou e nada
  // acusou). Quem acusa é o tipo GERADO em `.next/types/`, que só entra no `tsc` depois de um
  // build ter rodado na mesma árvore.
  searchParams?: Promise<{ editar?: string }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // O App Router NÃO decodifica params — ver decodeRouteParam.
  const card = board.cards.find((c) => c.id === decodeRouteParam(params.id));
  if (!card || card.type !== "idea") notFound();

  return (
    <ToastProvider>
      {/* `?editar=1` chega da criação. Lido no SERVIDOR e passado por prop em vez de useSearchParams
          no cliente: o modo inicial tem de valer já na primeira pintura, sem flash de leitura. */}
      <IdeaDocScreen
        board={board}
        boards={boards}
        card={card}
        initialMode={searchParams?.editar === "1" ? "edit" : "read"}
      />
    </ToastProvider>
  );
}
