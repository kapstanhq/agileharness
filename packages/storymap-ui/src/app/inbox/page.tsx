import { collectInbox } from "@/lib/storymap/inbox/collect";
import { AppTopBar } from "@/components/nav/TopBar";
import { ToastProvider } from "@/components/Toast";
import { InboxHome } from "@/components/inbox/InboxHome";
import { RunnerStatusProvider } from "@/components/RunnerStatusProvider";

export const dynamic = "force-dynamic";

// /inbox — o INBOX de todos os boards e a tela de chegada dele (`/` redireciona para cá).
// Um coletor só (lib/storymap/inbox/collect.ts): a mesma leitura do chip da barra, da aba do celular e da fala do
// Jido. A antiga «Central de ações» (/perguntas) redireciona para cá.
export default async function InboxPage() {
  const snapshot = await collectInbox();
  return (
    <ToastProvider>
      {/* voltar: a home do primeiro board — `/` redireciona para cá, e um fallback para cá mesmo seria um laço */}
      <AppTopBar title="Inbox" backHref={snapshot.boards[0] ? `/board/${snapshot.boards[0].id}/inicio` : undefined} />
      <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-5 sm:px-8">
        <h1 className="mb-3 text-xl font-semibold tracking-tight text-fg">Inbox</h1>
        {/* o SSE vivo: a linha de «Acompanhar» diz quem age em cada card agora (a mesma do Kanban) */}
        <RunnerStatusProvider>
          <InboxHome snapshot={snapshot} boardLinks />
        </RunnerStatusProvider>
      </main>
    </ToastProvider>
  );
}
