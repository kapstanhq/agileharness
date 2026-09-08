import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { decodeRouteParam } from "@/lib/storymap/deep-links";
import { VocabDocScreen } from "@/components/VocabDocScreen";

export const dynamic = "force-dynamic";

/** Detail page of ONE persona/system as a Notion-style doc (the listing stays in /vocabulario). */
export default async function VocabDetailPage(props: {
  params: Promise<{ boardId: string; kind: string; id: string }>;
}) {
  const params = await props.params;

  const kind = params.kind === "persona" ? "persona" : params.kind === "sistema" ? "system" : null;
  if (!kind) notFound();

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // Next does not decode App-Router params, and this route's WRITE path is genuinely open: the MCP
  // save_persona/save_system take `id: z.string()` with no slugify, so an id with an accent, a space
  // or a `:` is storable TODAY — and would arrive here percent-encoded, matching nothing, forever.
  const entityId = decodeRouteParam(params.id);

  const entity =
    kind === "persona"
      ? board.config.personas.find((p) => p.id === entityId)
      : board.config.systems.find((s) => s.id === entityId);
  if (!entity) notFound();

  const referencedByCount = board.cards.filter((card) =>
    kind === "persona" ? card.personas.includes(entityId) : card.systems.includes(entityId),
  ).length;

  return (
    <VocabDocScreen
      board={board}
      boards={boards}
      kind={kind}
      entity={entity}
      referencedByCount={referencedByCount}
    />
  );
}
