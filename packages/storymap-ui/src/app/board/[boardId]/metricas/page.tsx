import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { getTelemetryStore } from "@/lib/storymap/runner/telemetry";
import { BoardMetricsView } from "@/components/BoardMetricsView";
import { getCapacityGovernor } from "@/lib/storymap/runner/capacity-service";

export const dynamic = "force-dynamic";

// Board cost/turns telemetry panel (story-observabilidade-runs-telemetria, AC3). Reads the durable
// ledger directly (server-side, like the other board views read the repo) and renders the sortable
// per-card metrics table.
export default async function BoardMetricsPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards, summary] = await Promise.all([
    getBoard(params.boardId),
    listBoards(),
    getTelemetryStore().boardSummary(params.boardId),
  ]);
  if (!board) notFound();
  // O governador de capacidade: o custo em dólar desta página é NOCIONAL numa assinatura; o limite que existe é
  // a janela de uso — então ela abre a página. Um retrato ilegível vira null (o painel diz que está indisponível).
  let capacity = null;
  try {
    capacity = getCapacityGovernor().snapshot();
  } catch {
    capacity = null;
  }
  return <BoardMetricsView board={board} boards={boards} summary={summary} capacity={capacity} />;
}
