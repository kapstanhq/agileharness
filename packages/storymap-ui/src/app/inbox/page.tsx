import { collectInbox } from "@/lib/storymap/inbox/collect";
import { listBoards, readBoardConfig } from "@/lib/storymap/repo";
import { AppTopBar } from "@/components/nav/TopBar";
import { BoardHeader } from "@/components/BoardHeader";
import { ToastProvider } from "@/components/Toast";
import { InboxHome } from "@/components/inbox/InboxHome";
import { readSystemRegistry } from "@/components/inbox/registry";
import { RunnerStatusProvider } from "@/components/RunnerStatusProvider";
import { composerGutter } from "@/lib/ui";

export const dynamic = "force-dynamic";

// /inbox — o INBOX de todos os boards (fase 3). Um coletor só (lib/storymap/inbox/collect.ts): a mesma leitura do
// ícone da barra e da página do item. A antiga «Central de ações» (/perguntas) redireciona para cá.
//
// A casca é a da fase 1 — a MESMA barra das telas de board (seletor de projeto, cota, Inbox, engrenagem) e o compositor
// do Jido no rodapé, com a reserva dele. Não há board «de todos»: a barra e o Jido são os do primeiro board (a casa,
// para onde a marca leva), e o seletor troca de projeto como em qualquer tela. Só o Inbox da barra é de TODOS
// (`inboxScope="all"`): o número dele é o mesmo do «Precisa de você» desta página.
export default async function InboxPage() {
  const [snapshot, boards] = await Promise.all([collectInbox(), listBoards().catch(() => [])]);
  const registry = await readSystemRegistry(snapshot.boards);
  const home = boards[0] ? await readBoardConfig(boards[0].id).catch(() => null) : null;
  return (
    <ToastProvider>
      {/* o SSE vivo: o anel da cota da barra lê a métrica da MESMA conexão (fora do provider ele ficaria no fantasma) */}
      <RunnerStatusProvider>
        {/* sem nenhum board legível (instalação vazia) não há barra de board: fica a barra mínima do app */}
        {home ? <BoardHeader boards={boards} config={home} view="inbox" inboxScope="all" /> : <AppTopBar title="Inbox" />}
        <main className={`mx-auto w-full max-w-3xl px-4 pt-5 sm:px-8 ${home ? composerGutter : "pb-16"}`}>
          <InboxHome snapshot={snapshot} scope="all" registry={registry} />
        </main>
      </RunnerStatusProvider>
    </ToastProvider>
  );
}
