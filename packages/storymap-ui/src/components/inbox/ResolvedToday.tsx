"use client";

// O DESFECHO do que saiu do Inbox — uma lista de linhas (o que VOCÊ decidiu, com «Desfazer» quando a ação volta atrás;
// o que um AGENTE decidiu por você, com o «Desfazer» dele; o que um PRAZO decidiu). Mora dentro de «Os agentes estão
// cuidando» (AgentsCaring): «Resolvido hoje» e o registro dos dias anteriores usam a mesma linha.

import { useMemo } from "react";
import { formatDecisionText, localTimeFormatter, relativeWithClock } from "@/lib/storymap/inbox/copy";
import type { ResolvedEntry } from "@/lib/storymap/inbox/receipts";
import { BoardChip } from "./InboxItem";
import { UndoControl } from "./UndoControl";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";

function ResolvedRow({ entry, now, showBoard }: { entry: ResolvedEntry; now: number; showBoard: boolean }) {
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  const text = (t: string) => formatDecisionText(t, fmt);
  const when = now ? relativeWithClock(entry.at, now, tz) : null;
  return (
    <li className="space-y-1.5 px-4 py-3" data-resolved={entry.who} data-inbox-item={entry.itemId}>
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

export function ResolvedList({ entries, now, showBoard }: { entries: ResolvedEntry[]; now: number; showBoard: boolean }) {
  return (
    <ul className="divide-y divide-line-muted overflow-hidden rounded-xl border border-line bg-surface">
      {entries.map((e) => (
        <ResolvedRow key={e.key} entry={e} now={now} showBoard={showBoard} />
      ))}
    </ul>
  );
}
