"use client";

// A COLUNA NO AR — o que CHEGOU ao ar desde a sua última visita (bolinha azul, tipo, quando, título), «Novas desde
// <data>» + «Marcar vistas»; sem novidade, «Nada novo por enquanto» tracejado; e por fim «Ver histórico (N no ar)», que
// abre no lugar os últimos 20 entregues. Num board maduro esta raia tem centenas de cards: nada aqui desenha a raia
// inteira — as novidades e o histórico param em HISTORY_CAP cada (com «+N» / «Ver todos» para abrir o resto a pedido).
// Com BUSCA o teto sai do histórico: a busca mostra tudo o que casou (ela já é o recorte).
//
// A CHEGADA ao ar é a transição para o status terminal (`arrivals`, do ledger) — nunca a última escrita do card (um
// sync ou um campo atualizado faria uma entrega velha parecer nova). Card sem chegada conhecida não é «novo».
//
// A última visita mora no localStorage do navegador, por board, com try/catch (janela privada, armazenamento
// bloqueado): sem registro, «desde» é 24 h atrás — e nada é gravado até a pessoa marcar como vistas.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { ageWords } from "@/lib/storymap/inbox/copy";
import { kindOf } from "@/lib/storymap/kanban-features";
import { cardHref } from "@/lib/storymap/deep-links";
import type { Card } from "@/lib/storymap/types";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";
import { liveSeenKey } from "./kanban-tokens";

/** Quantos entregues o histórico abre — a raia nunca desenha centenas de cards. */
export const HISTORY_CAP = 20;
const DAY = 86_400_000;

function readSeen(boardId: string): number | null {
  try {
    const v = window.localStorage.getItem(liveSeenKey(boardId));
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSeen(boardId: string, at: number): void {
  try {
    window.localStorage.setItem(liveSeenKey(boardId), String(at));
  } catch {
    /* sem armazenamento: a marca vale só nesta tela */
  }
}

/** «ontem, 18:40» / «hoje, 09:12» / «03/10, 18:40» — no fuso do dono. */
function visitWords(at: number, now: number, timeZone?: string): string {
  const day = (t: number) => new Date(t).toLocaleDateString("pt-BR", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const clock = new Date(at).toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" });
  if (day(at) === day(now)) return `hoje, ${clock}`;
  if (day(at) === day(now - DAY)) return `ontem, ${clock}`;
  return `${new Date(at).toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "2-digit" })}, ${clock}`;
}

export function LiveColumn({
  boardId,
  cards,
  arrivals,
  now,
  query,
  searching = false,
}: {
  boardId: string;
  cards: readonly Card[];
  /** quando cada card chegou ao ar (epoch ms) — a transição do ledger. */
  arrivals: ReadonlyMap<string, number>;
  now: number;
  query: (c: Card) => boolean;
  /** há texto na busca: o histórico mostra TUDO o que casou (sem o teto). */
  searching?: boolean;
}) {
  const timeZone = useOwnerTimeZone();
  // `null` até o mount: o servidor não lê o localStorage, e o primeiro render tem de concordar com ele.
  const [seen, setSeen] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [history, setHistory] = useState(false);
  const [allFresh, setAllFresh] = useState(false);
  const [allHistory, setAllHistory] = useState(false);
  useEffect(() => {
    setSeen(readSeen(boardId));
    setMounted(true);
  }, [boardId]);

  const since = seen ?? now - DAY;
  const arrivedAt = (c: Card) => arrivals.get(c.id) ?? null;
  const sorted = useMemo(
    () => [...cards].filter(query).sort((a, b) => (arrivals.get(b.id) ?? 0) - (arrivals.get(a.id) ?? 0) || a.id.localeCompare(b.id)),
    [cards, query, arrivals],
  );
  const freshAll = mounted && now > 0 ? sorted.filter((c) => (arrivedAt(c) ?? 0) > since) : [];
  const fresh = allFresh ? freshAll : freshAll.slice(0, HISTORY_CAP);
  const freshMore = freshAll.length - fresh.length;
  const historyUncapped = searching || allHistory;
  const shownHistory = historyUncapped ? sorted : sorted.slice(0, HISTORY_CAP);
  const historyMore = sorted.length - shownHistory.length;

  const markSeen = () => {
    writeSeen(boardId, now);
    setSeen(now);
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1.5">
        {fresh.map((c) => (
          <Link
            key={c.id}
            href={cardHref(boardId, c.id)}
            className="flex flex-col gap-[3px] rounded-[10px] border border-line-muted bg-surface px-3 pb-[11px] pt-[9px] shadow-[0_1px_2px_rgba(15,15,15,.04)] transition hover:border-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <span className="flex items-center gap-1.5 text-[12px] text-fg-subtle">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-st-new" />
              <span className="font-medium">{kindOf(c)}</span>
              <span className="flex-1" />
              {arrivedAt(c) != null && now > 0 && <span className="tabular-nums">{ageWords(now - arrivedAt(c)!)}</span>}
            </span>
            <span className="text-[14px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg-strong [text-wrap:pretty]">{c.title}</span>
          </Link>
        ))}
        {freshMore > 0 && (
          <button
            type="button"
            onClick={() => setAllFresh(true)}
            className="self-start px-0.5 text-[12px] font-medium text-fg-muted transition hover:text-fg max-md:min-h-10"
          >
            +{freshMore} {freshMore === 1 ? "nova" : "novas"} · Ver todas
          </button>
        )}
        {fresh.length === 0 ? (
          <span className="rounded-[10px] border border-dashed border-line px-3 py-2.5 text-[13px] text-fg-subtle">Nada novo por enquanto</span>
        ) : (
          <span className="flex items-baseline gap-1.5 px-0.5 text-[12px] text-fg-subtle">
            <span>Novas desde {visitWords(since, now, timeZone)}</span>
            <span className="flex-1" />
            <button type="button" onClick={markSeen} className="whitespace-nowrap font-medium text-fg-muted transition hover:text-fg max-md:min-h-10">
              Marcar vistas
            </button>
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setHistory((h) => !h)}
        aria-expanded={history}
        className="self-start px-0.5 text-[12px] font-medium text-fg-muted transition hover:text-fg max-md:min-h-10"
      >
        {history ? "Esconder histórico" : `Ver histórico (${sorted.length} no ar)`}
      </button>
      {history && (
        <ul className="flex flex-col gap-0.5">
          {shownHistory.map((c) => (
            <li key={c.id}>
              <Link
                href={cardHref(boardId, c.id)}
                className={cn("flex items-baseline gap-2 rounded-md px-1.5 py-1.5 text-[12.5px] text-fg transition hover:bg-surface-hover")}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {arrivedAt(c) != null && now > 0 && (
                  <span className="shrink-0 text-[11.5px] tabular-nums text-fg-subtle">{ageWords(now - arrivedAt(c)!)}</span>
                )}
              </Link>
            </li>
          ))}
          {historyMore > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setAllHistory(true)}
                className="px-1.5 py-1.5 text-[12px] font-medium text-fg-muted transition hover:text-fg max-md:min-h-10"
              >
                Ver todos ({sorted.length})
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
