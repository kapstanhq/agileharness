"use client";

// O INBOX dentro da casca de um board (fase 3): a barra do board e o Inbox DESTE board (InboxHome `scope={board}`), com
// o link para o de todos os boards. O texto de cada item vem do modelo (lib/storymap/inbox/decision.ts); a anatomia é
// a do InboxItem.

import { BoardHeader } from "@/components/BoardHeader";
import { ToastProvider } from "@/components/Toast";
import { InboxHome } from "@/components/inbox/InboxHome";
import type { InboxSnapshot } from "@/lib/storymap/inbox/collect";
import type { ResolvedEntry } from "@/lib/storymap/inbox/receipts";
import type { BoardConfig, BoardSummary } from "@/lib/storymap/types";
import { composerGutter } from "@/lib/ui";

export function CockpitView({
  boards,
  config,
  snapshot,
  registry,
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  snapshot: InboxSnapshot;
  registry: ResolvedEntry[];
}) {
  return (
    <ToastProvider>
      <div className="flex h-screen flex-col">
        <BoardHeader boards={boards} config={config} view="inbox" />
        <main className={`mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-6 sm:px-8 ${composerGutter}`}>
          <InboxHome snapshot={snapshot} scope={{ board: config.id }} registry={registry} />
        </main>
      </div>
    </ToastProvider>
  );
}
