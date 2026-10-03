"use client";

// O INBOX dentro da casca de um board — o MESMO Inbox de todos os boards (InboxHome: o filtro de board, as seções
// Decidir, Acompanhar e Resolvido hoje, cada item desenhado pelo cartão único). Depois do redesenho: os 17
// renderers por kind, as tabelas de cor de raia e as fileiras de botão montadas à mão saíram; o texto de cada item vem
// do modelo (lib/storymap/inbox/decision.ts).

import { BoardHeader } from "@/components/BoardHeader";
import { ToastProvider } from "@/components/Toast";
import { InboxHome } from "@/components/inbox/InboxHome";
import type { InboxSnapshot } from "@/lib/storymap/inbox/collect";
import type { BoardConfig, BoardSummary } from "@/lib/storymap/types";

export function CockpitView({ boards, config, snapshot }: { boards: BoardSummary[]; config: BoardConfig; snapshot: InboxSnapshot }) {
  return (
    <ToastProvider>
      <div className="flex h-screen flex-col">
        <BoardHeader boards={boards} config={config} view="inbox" />
        <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 pb-24 sm:px-8 md:pb-10">
          <h1 className="mb-3 text-xl font-semibold tracking-tight text-fg">Inbox</h1>
          <InboxHome snapshot={snapshot} />
        </main>
      </div>
    </ToastProvider>
  );
}
