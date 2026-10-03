"use client";

// «RESOLVIDO HOJE» (onda 2, passo 5) — o desfecho de tudo que saiu do Inbox nas últimas 24 horas: o que VOCÊ decidiu
// (com «Desfazer» quando a ação volta atrás), o que o SISTEMA decidiu por você (com o «Desfazer» dele) e o que um PRAZO
// decidiu. Um item que sumiu sempre tem um desfecho à vista. Fechado, contado em voz baixa, como Acompanhar.

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { findInboxItem } from "@/lib/storymap/deep-links";
import { formatDecisionText, localTimeFormatter, relativeWithClock } from "@/lib/storymap/inbox/copy";
import type { ResolvedEntry } from "@/lib/storymap/inbox/receipts";
import { BoardChip } from "./InboxItemCard";
import { UndoControl } from "./UndoControl";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";

function ResolvedRow({ entry, now, showBoard }: { entry: ResolvedEntry; now: number; showBoard: boolean }) {
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  const text = (t: string) => formatDecisionText(t, fmt);
  const when = now ? relativeWithClock(entry.at, now, tz) : null;
  return (
    <li className="space-y-1.5 px-4 py-3" data-resolved={entry.who}>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-snug text-fg-subtle">
        {showBoard && <BoardChip name={entry.boardName} />}
        {showBoard && <span aria-hidden>·</span>}
        <span className="font-semibold text-fg-muted">{entry.whoLabel}</span>
        {when && (
          <>
            <span aria-hidden>·</span>
            <span>{when}</span>
          </>
        )}
      </p>
      {entry.ask ? (
        <>
          <p className="text-[14px] font-semibold leading-snug text-fg">{text(entry.ask)}</p>
          <p className="text-[13.5px] leading-snug text-fg-muted">{text(entry.what)}</p>
        </>
      ) : (
        <p className="text-[14px] leading-snug text-fg">{text(entry.what)}</p>
      )}
      {entry.undoneAt && <p className="text-[12.5px] font-medium text-fg-muted">Desfeito {now ? relativeWithClock(entry.undoneAt, now, tz) : ""}.</p>}
      {entry.undo && <UndoControl boardId={entry.boardId} undo={entry.undo} />}
    </li>
  );
}

export function ResolvedToday({ entries, now, showBoard }: { entries: ResolvedEntry[]; now: number; showBoard: boolean }) {
  // o link de um item que já saiu do Inbox (`?item=`) abre esta seção — é aqui que está o desfecho dele
  const wanted = useSearchParams().get("item");
  const [open, setOpen] = useState(() => Boolean(wanted && findInboxItem(entries.filter((e) => e.itemId).map((e) => ({ id: e.itemId! })), wanted)));
  return (
    <section aria-labelledby="inbox-resolvido" className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full items-center gap-2 rounded-xl border border-line bg-inset/60 px-4 text-left transition hover:bg-surface-hover"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-fg-subtle transition", open && "rotate-90")} aria-hidden />
        <span id="inbox-resolvido" className="flex-1 text-[14px] font-semibold text-fg">
          Resolvido hoje <span className="font-normal text-fg-muted">({entries.length})</span>
        </span>
      </button>
      {open &&
        (entries.length > 0 ? (
          <ul className="divide-y divide-line-muted overflow-hidden rounded-xl border border-line bg-surface">
            {entries.map((e) => (
              <ResolvedRow key={e.key} entry={e} now={now} showBoard={showBoard} />
            ))}
          </ul>
        ) : (
          <p className="px-1 text-[13.5px] text-fg-muted">Nada saiu do Inbox nas últimas 24 horas.</p>
        ))}
    </section>
  );
}
