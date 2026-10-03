import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { collectBoardInbox } from "@/lib/storymap/inbox/collect";
import { listRunningServices } from "@/lib/vps/processes";
import { InicioScreen } from "@/components/inicio/InicioScreen";

export const dynamic = "force-dynamic";

/**
 * "Início Agêntico" — the board home. Aggregates the three things the operator needs at a glance —
 * what needs YOU (Inbox/attention inbox), the live terminals, and the kanban flow — with the Jido
 * copilot one click away in the header. A server component: all the IO (board, cockpit, processes)
 * runs here, then a single client island (wrapped by the board layout's RunnerStatusProvider) makes
 * it live. Clicking any item opens its dedicated page (card / inbox item / terminal).
 */
export default async function InicioPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();

  // A home recebe as entradas do Inbox (a MESMA leitura da tela do Inbox, da barra e da aba do celular).
  const [inbox, services] = await Promise.all([collectBoardInbox(params.boardId), listRunningServices()]);

  return <InicioScreen board={board} boards={boards} inboxEntries={inbox?.entries ?? []} services={services} />;
}
