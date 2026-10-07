"use client";

// O INBOX — fase 3, refeito do zero. Uma tela, duas portas: `/inbox` (todos os boards; chips de filtro quando mais de
// um board tem o que decidir) e `/board/<b>/inbox` (só este board, com «Ver de todos os boards»).
//
//   Precisa de você (N)                         ← o título curto, com o número (o mesmo da barra)
//   [faixa do host]                             ← o medidor parado, uma linha, com a ação que destrava
//   [chips de board]                            ← só no Inbox de todos, e só com mais de um board com itens
//   item · item · item                          ← InboxItem, a anatomia inteira, mais antigo primeiro na mesma cor
//   Arquivar os antigos                          ← quando há itens parados há mais de 30 dias
//   ▸ Os agentes estão cuidando (N)             ← recolhido (AgentsCaring): o que era Acompanhar e o registro
//
// Vazio: «Nada precisa de você agora. Os agentes seguem sozinhos.» Ao vivo: `inbox.changed` → `router.refresh()`.
// O clique num item vira o recibo no mesmo lugar: a lista SEGURA o item (mesmo que a recarga já o tenha tirado) até o
// recibo cumprir o tempo, e o foco vai para o próximo item.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import type { InboxSnapshot } from "@/lib/storymap/inbox/collect";
import { archivableStale, inboxSections, type InboxEntry } from "@/lib/storymap/inbox/entries";
import type { ResolvedEntry } from "@/lib/storymap/inbox/receipts";
import { findInboxItem } from "@/lib/storymap/deep-links";
import { InboxItem, type InboxBoardCtx } from "./InboxItem";
import { AgentsCaring } from "./AgentsCaring";
import { StaleArchive } from "./StaleArchive";
import { useInboxChanged } from "./useInboxChanged";
import { useNow } from "./useNow";
import { INBOX_EMPTY_TEXT, withHeld } from "./inbox-ui";

/** A lista de decidir: segura o recibo de quem acabou de ser resolvido e leva o foco ao próximo item. */
function DecideList({ entries, boards, now, showBoard }: { entries: InboxEntry[]; boards: Record<string, InboxBoardCtx>; now: number; showBoard: boolean }) {
  const [held, setHeld] = useState<Array<{ entry: InboxEntry; index: number }>>([]);
  const rows = useMemo(() => withHeld(entries, held), [entries, held]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const listRef = useRef<HTMLUListElement>(null);

  const onSettled = useCallback((key: string) => {
    const cur = rowsRef.current;
    const index = cur.findIndex((e) => e.key === key);
    if (index < 0) return;
    setHeld((h) => [...h.filter((x) => x.entry.key !== key), { entry: cur[index], index }]);
    // o foco vai para o próximo item (ou o anterior, no fim da lista) — quem decide em sequência não volta ao topo
    const next = cur[index + 1] ?? cur[index - 1];
    if (next) {
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-inbox-key="${CSS.escape(next.key)}"]`);
        el?.focus({ preventScroll: false });
      });
    }
  }, []);
  const onExpired = useCallback((key: string) => setHeld((h) => h.filter((x) => x.entry.key !== key)), []);

  return (
    <ul ref={listRef} className="divide-y divide-line-muted overflow-hidden rounded-xl border border-line bg-surface" data-inbox-list>
      {rows.map((e) => (
        <li key={e.key}>
          <InboxItem entry={e} now={now} board={boards[e.boardId]} showBoard={showBoard} onSettled={onSettled} onExpired={onExpired} />
        </li>
      ))}
    </ul>
  );
}

export function InboxHome({
  snapshot,
  scope,
  registry = [],
}: {
  snapshot: InboxSnapshot;
  /** `all` = o Inbox de todos os boards (`/inbox`); `{ board }` = só este board (`/board/<b>/inbox`). */
  scope: "all" | { board: string };
  /** o que os agentes decidiram por você nos últimos dias (o antigo «/acompanhar»), com o «Desfazer». */
  registry?: ResolvedEntry[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const now = useNow();
  const boardScope = scope === "all" ? null : scope.board;
  const wanted = params.get("board");
  const filter = boardScope ?? (wanted && snapshot.boards.some((b) => b.id === wanted) ? wanted : null);

  const boards = useMemo<Record<string, InboxBoardCtx>>(
    () => Object.fromEntries(Object.entries(snapshot.contexts).map(([id, c]) => [id, { config: c.config, cardsById: new Map(c.cards.map((x) => [x.id, x])) }])),
    [snapshot.contexts],
  );
  const entries = useMemo(() => (filter ? snapshot.entries.filter((e) => e.boardId === filter) : snapshot.entries), [snapshot.entries, filter]);
  const resolved = useMemo(() => (filter ? snapshot.resolved.filter((e) => e.boardId === filter) : snapshot.resolved), [snapshot.resolved, filter]);
  const older = useMemo(() => (filter ? registry.filter((e) => e.boardId === filter) : registry), [registry, filter]);
  const { decidir, acompanhar, banners } = useMemo(() => inboxSections(entries), [entries]);
  const stale = useMemo(() => archivableStale(decidir), [decidir]);
  const showBoard = !filter;

  // `inbox.changed`: o Inbox de um board mostrado mudou — uma recarga do servidor, com um respiro; nenhum poll.
  useInboxChanged(() => router.refresh(), { boards: filter ? [filter] : null });

  // `?item=<id>` leva ao ITEM: o de decidir ganha o foco; o de «Os agentes estão cuidando» abre a seção
  const item = params.get("item");
  const wantedFollow = useMemo(() => Boolean(item && findInboxItem(acompanhar.map((e) => ({ id: e.itemId })), item)), [item, acompanhar]);
  const openCaring = params.get("cuidando") === "1" || wantedFollow || Boolean(item && findInboxItem(resolved.filter((e) => e.itemId).map((e) => ({ id: e.itemId! })), item));
  useEffect(() => {
    if (!item) return;
    const hit = findInboxItem([...decidir, ...acompanhar].map((e) => ({ id: e.itemId, key: e.key })), item);
    if (!hit) return;
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-inbox-key="${CSS.escape(hit.key)}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.focus({ preventScroll: true });
    }, 50);
    return () => clearTimeout(t);
    // só na chegada pelo link — uma recarga não rouba o foco de quem está decidindo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  // os chips: só no Inbox de todos, e só quando mais de um board tem o que decidir
  const withItems = snapshot.boards.filter((b) => b.decidir > 0);
  const chips = !boardScope && (withItems.length > 1 || (filter && withItems.length > 0));
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
  const caringBoards = filter ? snapshot.boards.filter((b) => b.id === filter) : snapshot.boards;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">
          Precisa de você <span className="tabular-nums text-fg-muted">{decidir.length}</span>
        </h1>
        {boardScope && (
          <Link href="/inbox" prefetch={false} className="inline-flex min-h-11 items-center text-[13.5px] font-medium text-accent-ink hover:underline">
            Ver de todos os boards
          </Link>
        )}
      </header>

      {banners.map((b) => (
        <InboxItem key={b.key} entry={b} now={now} variant="banner" />
      ))}

      {chips && (
        // No celular a fileira ROLA de lado: a borda direita esmaece (o chip cortado lê como «tem mais»); do sm para cima
        // os chips quebram linha.
        <nav
          aria-label="Filtrar por board"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 max-sm:[mask-image:linear-gradient(to_right,#000_calc(100%-40px),transparent)] sm:mx-0 sm:flex-wrap sm:px-0"
        >
          <Link href={hrefFor(null)} scroll={false} prefetch={false} className={chip(!filter)} aria-current={!filter ? "page" : undefined}>
            Todos <span className="tabular-nums opacity-80">{withItems.reduce((n, b) => n + b.decidir, 0)}</span>
          </Link>
          {withItems.map((b) => (
            <Link key={b.id} href={hrefFor(b.id)} scroll={false} prefetch={false} title={b.name} className={chip(filter === b.id)} aria-current={filter === b.id ? "page" : undefined}>
              <span className="max-w-[14rem] truncate">{b.name}</span> <span className="tabular-nums opacity-80">{b.decidir}</span>
            </Link>
          ))}
        </nav>
      )}

      {decidir.length > 0 ? (
        <DecideList entries={decidir} boards={boards} now={now} showBoard={showBoard} />
      ) : (
        <p className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-[14px] text-fg-muted" data-inbox-empty>
          {INBOX_EMPTY_TEXT}
        </p>
      )}
      {/* sempre montado: depois de arquivar, o recibo («Desfazer tudo») fica mesmo com a lista vazia */}
      <StaleArchive entries={stale} />

      <AgentsCaring
        key={openCaring ? "open" : "closed"}
        entries={acompanhar}
        resolved={resolved}
        registry={older}
        boards={caringBoards}
        now={now}
        showBoard={showBoard}
        defaultOpen={openCaring}
      />
    </div>
  );
}
