import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { boardFeatures, boardWithPersonas } from "@/lib/storymap/board-strategy";
import { boardDecidirCardIds } from "@/lib/storymap/inbox/decidir-ids";
import { decodeRouteParam } from "@/lib/storymap/deep-links";
import { deliveryProofOf } from "@/lib/storymap/delivery-audit";
import { featureCtx } from "@/lib/storymap/feature-key";
import { featureHead, featureItems } from "@/lib/storymap/feature-page";
import { kanbanCard } from "@/lib/storymap/kanban-payload";
import { liveArrivals } from "@/lib/storymap/kanban-features";
import { featureAnchoredOnce } from "@/lib/storymap/runner/feature-anchor";
import { readTransitions } from "@/lib/storymap/runner/transitions";
import { FeaturePage } from "@/components/feature/FeaturePage";

export const dynamic = "force-dynamic";

// A PÁGINA DA FUNCIONALIDADE (fase 7) — o título do card do Kanban abre aqui. O id é o da funcionalidade do PRD, o
// grupo `outros` (fora do PRD) ou, num board sem funcionalidades no PRD, o nó do mapa. Lê TODOS os cards do board (não
// só os do Kanban, que tira o arquivo): o «Feito» mostra também o que já foi arquivado com Prova da entrega.
export default async function FuncionalidadePage(props: { params: Promise<{ boardId: string; featureId: string }> }) {
  const params = await props.params;
  const featureId = decodeRouteParam(params.featureId);

  const [board, boards, owner, anchoredOnce, transitions] = await Promise.all([
    getBoard(params.boardId).then((b) => b && boardWithPersonas(b)),
    listBoards(),
    boardDecidirCardIds(params.boardId),
    featureAnchoredOnce(params.boardId).catch(() => false),
    readTransitions({ board: params.boardId }).catch(() => []),
  ]);
  if (!board) notFound();
  const features = await boardFeatures(board.config.id, board.config).catch(() => []);

  const byId = new Map(board.cards.map((c) => [c.id, c] as const));
  const head = featureHead(featureId, features, byId);
  if (!head) notFound();

  const items = featureItems(board.cards, head.id, featureCtx(byId, features, anchoredOnce));
  const terminal = new Set(board.config.statuses.filter((s) => s.terminal === true).map((s) => s.id));
  // a Prova da entrega sai do corpo do card, aqui no servidor: o corpo não vai ao navegador (o card aberto lê o seu)
  const proofs: Record<string, string | null> = {};
  for (const c of items) if (c.status != null && terminal.has(c.status)) proofs[c.id] = deliveryProofOf(c.body);
  const ids = new Set(items.map((c) => c.id));
  const arrivals = Object.fromEntries([...liveArrivals(transitions, terminal)].filter(([id]) => ids.has(id)));

  return (
    <FeaturePage
      config={board.config}
      boards={boards}
      owner={owner}
      feature={head}
      items={items.map((c) => kanbanCard(c, terminal.has(c.status ?? "")))}
      proofs={proofs}
      arrivals={arrivals}
    />
  );
}
