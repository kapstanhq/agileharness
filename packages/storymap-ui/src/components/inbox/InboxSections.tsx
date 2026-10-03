"use client";

// AS SEÇÕES do Inbox: Decidir, Acompanhar e Resolvido hoje.
//   • DECIDIR — só o que depende do dono e tem ao menos uma opção que funciona. É o ÚNICO número do badge.
//   • ACOMPANHAR — o que o sistema, o Jido ou um agente está resolvendo, e o que o dono combinou rever (o aceite da
//     triagem de uma história de usuário, as amostras — inbox/system-entries.ts). Fechado, contado em voz baixa; «sem
//     ninguém cuidando» aparece quando o técnico parou e ninguém vai pegá-lo sozinho. O resto do que o sistema decidiu
//     mora no registro do board (/board/<b>/acompanhar), com o «Desfazer» — o link fica no fim da seção.
//   • RESOLVIDO HOJE — o desfecho do que saiu do Inbox (passo 5).
// Sob Decidir, quando há itens parados há mais de 30 dias: «Arquivar os antigos» (passo 6), confirmado e reversível.
// Nada some: as seções fechadas continuam na tela, com a contagem. O agrupamento é por FATO (quem age a seguir).

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { findInboxItem } from "@/lib/storymap/deep-links";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { archivableStale, inboxSections, inboxSummary, summaryLine, type InboxEntry } from "@/lib/storymap/inbox/entries";
import { InboxItemCard, type InboxBoardCtx, type InboxReceipt } from "./InboxItemCard";
import { InboxList } from "./InboxList";
import { StaleArchive } from "./StaleArchive";

function SectionHeading({ title, count, id }: { title: string; count: number; id: string }) {
  return (
    <h2 id={id} className="flex items-baseline justify-between px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-fg-subtle">
      <span>{title}</span>
      <span className="tabular-nums">{count}</span>
    </h2>
  );
}

/**
 * Onde mora o RESTO do que o sistema decidiu por você: Acompanhar mostra só o que você combinou rever e o trabalho em
 * andamento; cada decisão segue no registro do board, com o porquê e o «Desfazer».
 */
function RegistryLinks({ boards }: { boards: Record<string, InboxBoardCtx> }) {
  const list = Object.entries(boards);
  if (list.length === 0) return null;
  return (
    <p className="px-1 text-[12.5px] leading-snug text-fg-muted" data-inbox-registry>
      O que o sistema decidiu por você fica no registro, com o porquê e o «Desfazer»:{" "}
      {list.map(([id, b], i) => (
        <span key={id}>
          {i > 0 ? " · " : ""}
          <Link href={`/board/${id}/acompanhar`} prefetch={false} className="font-semibold text-accent-ink underline-offset-2 hover:underline">
            {b.config.name}
          </Link>
        </span>
      ))}
    </p>
  );
}

export function InboxSections({
  entries,
  boards,
  now,
  showBoard,
  emptyDecidir,
  acompanharExtra,
  resolved,
  onDone,
}: {
  entries: InboxEntry[];
  boards: Record<string, InboxBoardCtx>;
  now: number;
  showBoard: boolean;
  /** o que Decidir diz quando está vazio (a tela sabe onde há Acompanhar). */
  emptyDecidir: React.ReactNode;
  /** o que mais mora em Acompanhar e não é item (a linha do drift dos sistemas). */
  acompanharExtra?: React.ReactNode;
  /** a seção «Resolvido hoje» (passo 5). */
  resolved?: React.ReactNode;
  onDone?: (r: InboxReceipt) => void;
}) {
  const { decidir, acompanhar, banners } = useMemo(() => inboxSections(entries), [entries]);
  const summary = useMemo(() => inboxSummary(entries), [entries]);
  const stale = useMemo(() => archivableStale(decidir), [decidir]);
  // o link de um item (`?item=`) que mora em Acompanhar abre a seção — senão ele cairia numa seção fechada
  const wanted = useSearchParams().get("item");
  const [openFollow, setOpenFollow] = useState(() => Boolean(wanted && findInboxItem(acompanhar.map((e) => ({ id: e.itemId })), wanted)));

  return (
    <div className="space-y-6">
      <p className="text-[14px] text-fg-muted" data-inbox-summary>
        {summaryLine(summary)}
      </p>

      {banners.map((b) => (
        <div key={b.key} data-host-notice={b.kind} className="overflow-hidden rounded-xl border border-rose-600/30 bg-rose-600/5">
          <InboxItemCard entry={b} density="row" now={now} />
        </div>
      ))}

      <section aria-labelledby="inbox-decidir" className="space-y-2">
        <SectionHeading title="Decidir" count={decidir.length} id="inbox-decidir" />
        {decidir.length > 0 ? (
          <InboxList entries={decidir} boards={boards} now={now} showBoard={showBoard} sectionLabel="Decidir" onDone={onDone} />
        ) : (
          <div className="rounded-xl border border-dashed border-line px-5 py-6 text-center text-[14px] text-fg-muted" data-inbox-empty>
            {emptyDecidir}
          </div>
        )}
        {/* sempre montado: depois de arquivar, o recibo («Desfazer tudo») fica mesmo com Decidir vazio */}
        <StaleArchive entries={stale} />
      </section>

      <section aria-labelledby="inbox-acompanhar" className="space-y-2">
        <button
          type="button"
          aria-expanded={openFollow}
          onClick={() => setOpenFollow((v) => !v)}
          className="flex min-h-12 w-full items-center gap-2 rounded-xl border border-line bg-inset/60 px-4 text-left transition hover:bg-surface-hover"
        >
          <ChevronRight className={cn("h-4 w-4 shrink-0 text-fg-subtle transition", openFollow && "rotate-90")} aria-hidden />
          <span id="inbox-acompanhar" className="flex-1 text-[14px] font-semibold text-fg">
            Acompanhar <span className="font-normal text-fg-muted">({acompanhar.length})</span>
          </span>
          {summary.stalled > 0 && <span className="text-[12.5px] font-semibold text-amber-800 dark:text-amber-300">{summary.stalled} sem ninguém cuidando</span>}
        </button>
        {openFollow && (
          <div className="space-y-2">
            {acompanhar.length > 0 ? (
              <InboxList entries={acompanhar} boards={boards} now={now} showBoard={showBoard} sectionLabel="Acompanhar" onDone={onDone} />
            ) : (
              <p className="px-1 text-[13.5px] text-fg-muted">Nada em andamento agora.</p>
            )}
            {acompanharExtra}
            <RegistryLinks boards={boards} />
          </div>
        )}
      </section>

      {resolved}
    </div>
  );
}
