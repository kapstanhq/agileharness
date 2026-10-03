import { redirect } from "next/navigation";
import { listBoards } from "@/lib/storymap/repo";

export const dynamic = "force-dynamic";

// A Esteira (ex-"Entrega") virou uma view DO BOARD (`/board/<id>/entrega`), para vestir o mesmo
// topnav das irmãs e poder nomear cada trabalho pelo card que ele serve. Esta rota sem board fica de
// pé como ATALHO, para os links que já circulam (a página de Processos, um bookmark) continuarem
// valendo. O id da rota segue `entrega` de propósito — o que mudou foi o RÓTULO na tela.
export default async function EntregaRedirect() {
  const boards = await listBoards().catch(() => []);
  redirect(boards.length ? `/board/${boards[0].id}/entrega` : "/");
}
