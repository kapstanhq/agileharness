import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { activeEnvOverrides, readFileSettings } from "@/lib/storymap/runner/config";
import { assembleConfigCockpit } from "@/lib/storymap/config-cockpit";
import { orchestratorOverviewAction } from "@/app/copilot-actions";
import { AutorunSettingsPanel } from "@/components/AutorunSettingsPanel";

export const dynamic = "force-dynamic";

export default async function ConfigPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();
  // Global runner settings (file values only — env overrides are flagged, not merged).
  const settings = readFileSettings();
  const envOverrides = activeEnvOverrides();
  // Fase 5 — the cockpit tabs' read models (Copiloto overview + routes/specialists/toolkit/mcpTokens).
  const [overview, cockpit] = await Promise.all([
    orchestratorOverviewAction(params.boardId),
    assembleConfigCockpit(params.boardId, board.config),
  ]);
  return (
    <AutorunSettingsPanel
      board={board}
      boards={boards}
      settings={settings}
      envOverrides={envOverrides}
      overview={overview}
      cockpit={cockpit}
    />
  );
}
