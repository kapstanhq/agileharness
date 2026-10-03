import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { CardCreateScreen } from "@/components/CardCreateScreen";
import type { CardType } from "@/lib/storymap/types";

export const dynamic = "force-dynamic";

const TYPES: CardType[] = ["activity", "step", "story"];

/**
 * CRIAR um card, como PÁGINA — o mesmo documento de sempre, ainda sem disco. Era um modo do
 * CardEditorDrawer (`mode="create"`), e por isso a criação ficava presa à gaveta: sem URL, sem
 * poder ser compartilhada, e obrigando toda tela que cria um card a montar o drawer.
 *
 * O segmento estático `novo` vence o dinâmico `[id]` no App Router, então nenhum card com id "novo"
 * é alcançável por esta rota — o que é aceitável: ids de story são gerados (`randomCardId`) e os de
 * backbone são slugs de título.
 *
 * O contexto inicial vem da QUERY (`?tipo=story&pai=<id>&release=<id>&status=<id>`) — é assim que o
 * "+ story" de uma célula passo×release do Mapa nasce já no lugar certo.
 */
export default async function NewCardPage(props: {
  params: Promise<{ boardId: string }>;
  // Next 15: PROMISE (o corpo já dava `await`; só o tipo ficou para trás). Esta foi a terceira e
  // última — e a que meus dois greps perderam, porque procuravam `{ … }` e aqui o tipo é um
  // `Record`. Quem a achou foi o `tsc` sobre os tipos GERADOS pelo build, que é justamente o
  // passo que este commit acrescenta ao CI.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  const one = (key: string): string | null => {
    const raw = searchParams?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() ? value : null;
  };

  const rawType = one("tipo");
  const type: CardType = TYPES.includes(rawType as CardType) ? (rawType as CardType) : "story";

  return (
    <CardCreateScreen
      board={board}
      boards={boards}
      init={{
        type,
        parent: one("pai"),
        release: one("release"),
        status: one("status"),
      }}
    />
  );
}
