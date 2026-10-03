"use client";

// O INBOX — UM só, para todos os boards. Cada item leva o selo do board; o filtro no alto
// mostra um board só («?board=<id>»). É a tela de chegada do dono (`/`→`/inbox`), e a mesma tela aparece dentro da
// casca de um board (`/board/<id>/inbox`), com a navegação dele. A antiga «Central de ações» (/perguntas), que
// mostrava uma lista DIFERENTE montada pelo modelo legado, saiu — o link dela redireciona para cá.

import { useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import type { InboxSnapshot } from "@/lib/storymap/inbox/collect";
import { SystemDriftPanel } from "@/components/SystemDriftPanel";
import { emptyDecidirText } from "@/lib/storymap/inbox/entries";
import { InboxSections } from "./InboxSections";
import { ResolvedToday } from "./ResolvedToday";
import type { InboxBoardCtx } from "./InboxItemCard";
import { useInboxChanged } from "./useInboxChanged";
import { useNow } from "./useNow";

export function InboxHome({
  snapshot,
  boardLinks = false,
}: {
  snapshot: InboxSnapshot;
  /** na tela de chegada (fora da casca de um board), a lista dos boards — senão o celular não teria como entrar num. */
  boardLinks?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow();
  const wanted = params.get("board");
  const filter = wanted && snapshot.boards.some((b) => b.id === wanted) ? wanted : null;

  const boards = useMemo<Record<string, InboxBoardCtx>>(
    () => Object.fromEntries(Object.entries(snapshot.contexts).map(([id, c]) => [id, { config: c.config, cardsById: new Map(c.cards.map((x) => [x.id, x])) }])),
    [snapshot.contexts],
  );
  const entries = useMemo(() => (filter ? snapshot.entries.filter((e) => e.boardId === filter) : snapshot.entries), [snapshot.entries, filter]);
  const resolved = useMemo(() => (filter ? snapshot.resolved.filter((e) => e.boardId === filter) : snapshot.resolved), [snapshot.resolved, filter]);
  const totalDecidir = snapshot.boards.reduce((n, b) => n + b.decidir, 0);

  // `inbox.changed` (passo 8): o Inbox de um board mostrado mudou — um card, um sidecar, um ledger, a fila do train ou a
  // telemetria. Uma recarga do servidor, com um respiro; filtrado por board, nenhum poll.
  useInboxChanged(() => router.refresh(), { boards: filter ? [filter] : null });

  const hrefFor = (board: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (board) next.set("board", board);
    else next.delete("board");
    next.delete("item");
    const q = next.toString();
    return q ? `${pathname}?${q}` : pathname;
  };
  const chip = (active: boolean) =>
    cn(
      "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-medium transition",
      active ? "border-fg bg-fg text-surface" : "border-line bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg",
    );

  return (
    <div className="space-y-4">
      <nav aria-label="Filtrar por board" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <Link href={hrefFor(null)} scroll={false} prefetch={false} className={chip(!filter)} aria-current={!filter ? "page" : undefined}>
          Todos os boards <span className="tabular-nums opacity-80">{totalDecidir}</span>
        </Link>
        {snapshot.boards.map((b) => (
          <Link key={b.id} href={hrefFor(b.id)} scroll={false} prefetch={false} className={chip(filter === b.id)} aria-current={filter === b.id ? "page" : undefined}>
            {b.name} <span className="tabular-nums opacity-80">{b.decidir}</span>
          </Link>
        ))}
      </nav>

      <InboxSections
        entries={entries}
        boards={boards}
        now={now}
        showBoard={!filter}
        emptyDecidir={emptyDecidirText(snapshot.boards, filter)}
        acompanharExtra={(filter ? [filter] : snapshot.boards.map((b) => b.id)).map((id) => (
          <SystemDriftPanel key={id} boardId={id} boardName={filter ? undefined : snapshot.boards.find((b) => b.id === id)?.name} />
        ))}
        resolved={<ResolvedToday entries={resolved} now={now} showBoard={!filter} />}
      />

      {boardLinks && snapshot.boards.length > 0 && (
        <nav aria-label="Boards" className="space-y-1 border-t border-line pt-4">
          <h2 className="px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-fg-subtle">Boards</h2>
          <ul className="flex flex-wrap gap-x-5">
            {snapshot.boards.map((b) => (
              <li key={b.id}>
                <Link href={`/board/${b.id}/inicio`} prefetch={false} className="inline-flex min-h-11 items-center text-[14px] font-medium text-accent-ink hover:underline">
                  {b.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
