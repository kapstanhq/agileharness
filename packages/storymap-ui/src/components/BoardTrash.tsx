"use client";

import { useCallback, useEffect, useState } from "react";
import { sharedEventSource } from "@/lib/sse-bus";
import { RotateCcw, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getArchivedCardsAction, reviveCardAction, type ArchivedCardRow } from "@/app/actions";

export type BoardTrashState = {
  count: number;
  items: ArchivedCardRow[];
  q: string;
  setQ: (v: string) => void;
  reviving: string | null;
  revive: (id: string) => Promise<void>;
  load: () => void;
};

/**
 * Board ARCHIVE state — the tombstones (arquivados/duplicado/cancelado/capturado, a `system`
 * column) that no longer eat a kanban lane. Kept live via the board SSE bus + a slow poll.
 * Mount this ONCE (in the ⋯ overflow menu) so the count badge stays fresh without opening a
 * duplicate EventSource per consumer; pass the returned state to <TrashDrawer/>.
 *
 * `enabled` liga a assinatura só quando ela pode ser VISTA (menu aberto ou gaveta aberta): a
 * contagem só aparece dentro do menu, mas o hook varria o board inteiro (`getArchivedCardsAction`)
 * a cada 60s + a cada evento SSE em TODA página de board, aberto ou não.
 */
export function useBoardTrash(boardId: string, enabled = true): BoardTrashState {
  const [items, setItems] = useState<ArchivedCardRow[]>([]);
  const [q, setQ] = useState("");
  const [reviving, setReviving] = useState<string | null>(null);

  const load = useCallback(() => {
    getArchivedCardsAction({ boardId }).then((r) => {
      if (r.ok) setItems(r.data!.items);
    });
  }, [boardId]);

  // Badge count: load on mount + refresh on the board SSE bus (any mutation may archive a card).
  useEffect(() => {
    if (!enabled) return;
    load();
    const es = sharedEventSource("/api/notifications/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const onEvent = () => {
      clearTimeout(t);
      t = setTimeout(load, 400);
    };
    es.addEventListener("agileharness", onEvent as EventListener);
    const poll = setInterval(load, 60_000);
    return () => {
      clearTimeout(t);
      clearInterval(poll);
      es.close();
    };
  }, [load, enabled]);

  const revive = useCallback(
    async (id: string) => {
      setReviving(id);
      const r = await reviveCardAction({ boardId, cardId: id });
      setReviving(null);
      if (r.ok) setItems((xs) => xs.filter((x) => x.id !== id));
    },
    [boardId],
  );

  return { count: items.length, items, q, setQ, reviving, revive, load };
}

/**
 * Board archive DRAWER — a right-side panel listing the tombstones with search + "Reviver"
 * (reviveCardAction). Presentational shell: the caller owns the state (via useBoardTrash) so the
 * count badge can render in the menu while the drawer is closed.
 */
export function TrashDrawer({
  open,
  onClose,
  trash,
}: {
  open: boolean;
  onClose: () => void;
  trash: BoardTrashState;
}) {
  const { items, q, setQ, reviving, revive, count } = trash;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? items.filter((it) => `${it.title} ${it.id}`.toLowerCase().includes(needle))
    : items;

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-sm flex-col border-l border-line bg-surface shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Trash2 className="h-4 w-4 text-fg-subtle" />
          <span className="flex-1 text-sm font-semibold text-fg">Arquivo</span>
          <span className="text-[11px] text-fg-subtle">
            {count} item{count === 1 ? "" : "ns"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="border-b border-line px-3 py-2">
          <div className="flex items-center gap-2 rounded-md border border-line bg-inset px-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar arquivados…"
              className="h-8 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12px] text-fg-subtle">
              {count === 0 ? "Nada arquivado neste board." : "Nenhum resultado."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {filtered.map((it) => (
                <li
                  key={it.id}
                  className="group flex items-start gap-2 rounded-lg px-2 py-2 transition hover:bg-surface-hover"
                >
                  <span className="mt-0.5 shrink-0 rounded bg-surface-hover px-1 text-[9px] font-medium uppercase tracking-wide text-fg-subtle">
                    {it.statusName}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-fg" title={it.title}>
                      {it.title}
                    </span>
                    <span className="block truncate text-[10px] text-fg-subtle">
                      {it.id}
                      {it.duplicateOf ? ` → ${it.duplicateOf}` : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => revive(it.id)}
                    disabled={reviving === it.id}
                    title="Reviver — voltar ao fluxo"
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-accent opacity-0 transition hover:bg-accent/10 group-hover:opacity-100 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {reviving === it.id ? "…" : "Reviver"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
