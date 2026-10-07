"use client";

// «OS AGENTES ESTÃO CUIDANDO (N)» — uma linha recolhida no fim do Inbox (decisão do dono, 06/10). É o que era a seção
// Acompanhar e a página /acompanhar, juntas:
//   • o que o sistema, o Jido ou um agente está resolvendo — no formato curto (o que acontece e quem cuida), sem
//     botões, salvo os de desfazer/reabrir; «sem ninguém cuidando» em âmbar quando o técnico parou e ninguém pega;
//   • os sistemas que mudaram desde a última sincronização (SystemDriftPanel — nada quando nada mudou);
//   • o que saiu do Inbox hoje (o seu recibo, a decisão de um agente, o prazo) com o «Desfazer»;
//   • o que os agentes decidiram por você nos dias anteriores — o registro, com o porquê e o «Desfazer».
// Fechada, ela é uma linha só; nada some — a contagem fica à vista.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import type { ResolvedEntry } from "@/lib/storymap/inbox/receipts";
import { SystemDriftPanel } from "@/components/SystemDriftPanel";
import { InboxItem } from "./InboxItem";
import { ResolvedList } from "./ResolvedToday";

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-1 pt-2 text-[12px] font-semibold text-fg-subtle">{children}</h3>;
}

export function AgentsCaring({
  entries,
  resolved,
  registry,
  boards,
  now,
  showBoard,
  defaultOpen = false,
}: {
  entries: InboxEntry[];
  resolved: ResolvedEntry[];
  registry: ResolvedEntry[];
  /** os boards mostrados (a linha do drift dos sistemas é por board). */
  boards: ReadonlyArray<{ id: string; name: string }>;
  now: number;
  showBoard: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const stalled = entries.filter((e) => e.decision.next.stalled).length;
  // nada em andamento, nada resolvido hoje e nada no registro: a linha fica apagada e não abre (abrir só dizia «Nada em
  // andamento agora»). O drift dos sistemas segue montado — ele não desenha nada quando nada mudou.
  if (entries.length === 0 && resolved.length === 0 && registry.length === 0) {
    return (
      <section aria-labelledby="inbox-cuidando" className="space-y-2" data-inbox-caring data-empty>
        <p id="inbox-cuidando" className="flex min-h-12 items-center px-4 text-[13.5px] text-fg-subtle">
          Os agentes não estão cuidando de nada agora.
        </p>
        {boards.map((b) => (
          <SystemDriftPanel key={b.id} boardId={b.id} boardName={showBoard ? b.name : undefined} />
        ))}
      </section>
    );
  }
  return (
    <section aria-labelledby="inbox-cuidando" className="space-y-2" data-inbox-caring>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="inbox-cuidando-body"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-line bg-inset/60 px-4 py-2 text-left transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-fg-subtle transition motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
        <span id="inbox-cuidando" className="min-w-[min(calc(100%_-_1.5rem),14rem)] flex-1 text-[14px] font-semibold text-fg">
          Os agentes estão cuidando <span className="font-normal tabular-nums text-fg-muted">({entries.length})</span>
        </span>
        {stalled > 0 && <span className="text-[12.5px] font-semibold text-amber-800 dark:text-amber-300">{stalled} sem ninguém cuidando</span>}
      </button>
      {open && (
        <div id="inbox-cuidando-body" className="space-y-2">
          {entries.length > 0 ? (
            <ul className="divide-y divide-line-muted overflow-hidden rounded-xl border border-line bg-surface">
              {entries.map((e) => (
                <li key={e.key}>
                  <InboxItem entry={e} now={now} variant="short" showBoard={showBoard} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-1 text-[13.5px] text-fg-muted">Nada em andamento agora.</p>
          )}
          {boards.map((b) => (
            <SystemDriftPanel key={b.id} boardId={b.id} boardName={showBoard ? b.name : undefined} />
          ))}
          <SubHeading>Resolvido hoje</SubHeading>
          {resolved.length > 0 ? (
            <ResolvedList entries={resolved} now={now} showBoard={showBoard} />
          ) : (
            <p className="px-1 text-[13.5px] text-fg-muted">Nada saiu do Inbox nas últimas 24 horas.</p>
          )}
          {registry.length > 0 && (
            <>
              <SubHeading>O que os agentes decidiram por você nos últimos dias</SubHeading>
              <ResolvedList entries={registry} now={now} showBoard={showBoard} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
