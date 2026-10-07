"use client";

// A COLUNA ENTREGA — o TREM. Os cards de entrega não aparecem como cards aqui (eles estão no fluxo, em cima): a coluna
// mostra o 1º do merge train («No trem · 1º»: o tempo estimado, a funcionalidade, o tipo, o estado e a barra de
// progresso) e, embaixo, «+N na fila · Ver fila», que abre a fila inteira. Tudo do MESMO snapshot do train que o resto
// do app lê (useMergeQueue); o tempo estimado e o preenchimento da barra só aparecem quando há tempo médio REAL
// medido no próprio train — sem medida, nada de número inventado (a trilha da barra fica, vazia). Raia Entrega vazia =
// um card de estado vazio («Nada esperando para entrar · As entregas prontas aparecem aqui.», sem «1º» nem
// barra); trem vazio com itens esperando fora dele = o card com «No trem» (sem «1º») e o «+N na fila».
//
// Sem o contador «N/M jobs» do desenho: o snapshot do train não carrega o progresso do gate por job (só o status e o
// log da falha) — mostrar um número aqui seria inventá-lo.
//
// O que está na raia Entrega e AINDA NÃO entrou no trem (o card na fila da publicação, sem entrada no merge train
// ainda) entra no «+N na fila» e na fila aberta, depois do trem — senão a raia mostraria 12 caixinhas e um trem vazio
// que dizia «Fim da fila». O que espera o DONO ou deu erro já aparece como card embaixo e não se conta de novo.
//
// A fila aberta termina no link do INBOX do board: a Esteira saiu na fase 3, e o que ela oferecia de alavanca (publicar
// o que está pronto, refazer um pedido, o stage parado) virou item do Inbox — é lá que o que espera alguém está.

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { isParkedMergeStatus, trainInFlight } from "@/lib/storymap/runner/merge-status";
import { featureOf, kindOf } from "@/lib/storymap/kanban-features";
import type { MergeQueueEntry } from "@/lib/storymap/runner/types";
import type { OwnerCardDecision } from "@/lib/storymap/inbox/decidir-set";
import type { Card } from "@/lib/storymap/types";
import { useMergeQueue } from "@/components/RunnerStatusProvider";
import { useDismiss } from "./KanbanFilterMenu";
import { TRAIN_LABEL } from "@/lib/storymap/kanban-copy";
import { inboxHref } from "@/lib/storymap/deep-links";
import { POPOVER_CLS } from "./kanban-tokens";

type TrainState = "stage" | "fila" | "travado" | "voce" | "pausado";

const TRAIN_STATE: Readonly<Record<TrainState, { label: string; dot: string; ink: string; bar: string; row: string }>> = {
  stage: { label: TRAIN_LABEL.stage, dot: "bg-st-run", ink: "text-st-run", bar: "bg-st-run", row: "" },
  fila: { label: TRAIN_LABEL.fila, dot: "bg-st-forgot", ink: "text-fg-subtle", bar: "bg-st-forgot", row: "" },
  travado: { label: TRAIN_LABEL.travado, dot: "bg-st-err", ink: "text-st-err-ink", bar: "bg-st-err", row: "bg-st-err/[0.06]" },
  voce: { label: TRAIN_LABEL.voce, dot: "bg-st-attn", ink: "text-st-attn-ink", bar: "bg-st-attn", row: "bg-st-attn/[0.08]" },
  pausado: { label: TRAIN_LABEL.pausado, dot: "bg-st-forgot", ink: "text-fg-subtle", bar: "bg-st-forgot", row: "" },
};

/** As entradas do train DESTE board que ainda ocupam a fila (as vivas + a re-execução), a que roda primeiro. PURA. */
export function boardTrain(entries: readonly MergeQueueEntry[] | undefined, boardId: string): MergeQueueEntry[] {
  const mine = (entries ?? []).filter((e) => e.board === boardId && trainInFlight(e.status));
  const moving = (e: MergeQueueEntry) => (e.status === "gate-running" || e.status === "merging" ? 0 : 1);
  return mine.sort((a, b) => moving(a) - moving(b) || a.enqueuedAt - b.enqueuedAt);
}

/** O tempo médio REAL de um item no train deste board (as integrações concluídas que o snapshot carrega), em min. PURA. */
export function trainAvgMinutes(entries: readonly MergeQueueEntry[] | undefined, boardId: string): number | null {
  const done = (entries ?? []).filter((e) => e.board === boardId && e.status === "done" && e.mergeStartedAt && e.mergeEndedAt);
  if (!done.length) return null;
  const sum = done.reduce((n, e) => n + (e.mergeEndedAt! - e.mergeStartedAt!), 0);
  return sum / done.length / 60_000;
}

function trainState(e: MergeQueueEntry, owner: ReadonlyMap<string, OwnerCardDecision>, paused: boolean): TrainState {
  if (e.cardId && owner.has(e.cardId)) return "voce";
  if (isParkedMergeStatus(e.status)) return "travado";
  if (e.status === "waiting") return paused ? "pausado" : "fila";
  return "stage";
}

export function TrainColumn({
  boardId,
  cardsById,
  owner,
  paused,
  now,
  outside = [],
}: {
  boardId: string;
  cardsById: ReadonlyMap<string, Card>;
  owner: ReadonlyMap<string, OwnerCardDecision>;
  paused: boolean;
  now: number;
  /** os itens da raia que esperam a vez FORA do trem e não aparecem como card (entram no «+N na fila»). */
  outside?: readonly Card[];
}) {
  const mq = useMergeQueue();
  const train = useMemo(() => boardTrain(mq?.entries, boardId), [mq, boardId]);
  const avg = useMemo(() => trainAvgMinutes(mq?.entries, boardId), [mq, boardId]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const titleOf = (e: MergeQueueEntry) => {
    const card = e.cardId ? cardsById.get(e.cardId) : undefined;
    if (!card) return { title: e.cardId ? e.cardId : "Integração sem card", kind: "" };
    return { title: featureOf(card, cardsById).title, kind: kindOf(card) };
  };

  const head = train[0];
  const ht = head ? TRAIN_STATE[trainState(head, owner, paused)] : null;
  const { title, kind } = head ? titleOf(head) : { title: TRAIN_LABEL.empty, kind: "" };
  const elapsed = head?.mergeStartedAt && now > 0 ? Math.max(0, now - head.mergeStartedAt) / 60_000 : null;
  const pct = head && avg && elapsed != null ? Math.min(0.95, elapsed / avg) : 0;
  const eta = head && avg ? (elapsed != null ? Math.max(1, avg - elapsed) : avg) : null;
  const rest = Math.max(0, train.length - 1) + outside.length;

  // NADA na entrega (nem no trem, nem esperando a vez fora dele): o estado vazio, num card só — sem «1º» (não há
  // primeiro), sem a barra de progresso vazia e sem o «Fim da fila» de uma fila que não existe.
  if (!head && rest === 0) {
    return (
      <div className="flex flex-col gap-1 rounded-[10px] border border-dashed border-line-muted px-3 py-2.5 text-[12px] text-fg-subtle">
        <span className="font-medium">{TRAIN_LABEL.headEmpty}</span>
        <span className="text-[14px] font-semibold leading-[1.3] text-fg">{TRAIN_LABEL.empty}</span>
        <span className="text-[13px] leading-[1.4]">{TRAIN_LABEL.emptyNote}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col overflow-hidden rounded-[10px] border border-line-muted bg-surface shadow-[0_1px_2px_rgba(15,15,15,.04)]">
        <div className="flex items-center gap-1.5 px-3 pt-[9px] text-[12px] text-fg-subtle">
          {/* «1º» só com alguém no trem; com o trem vazio e itens esperando fora dele, só «No trem» */}
          <span className="font-medium">{head ? TRAIN_LABEL.head : TRAIN_LABEL.headEmpty}</span>
          <span className="flex-1" />
          {eta != null && <span className="tabular-nums">~{Math.round(eta)} min</span>}
        </div>
        <div className="flex flex-col gap-1 px-3 pb-2.5 pt-0.5">
          <span className="text-[14px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg-strong [text-wrap:pretty]">{title}</span>
          {kind && <span className="text-[13px] leading-[1.4] text-fg-subtle">{kind}</span>}
        </div>
        {/* o estado e a barra só com alguém no trem — vazio, uma barra sem nada era ruído */}
        {ht && (
          <div className="flex flex-col gap-1.5 border-t border-surface-hover px-3 pb-3 pt-2.5">
            <span className={cn("flex items-center gap-1.5 text-[12px] font-semibold", ht.ink)}>
              <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", ht.dot)} />
              {ht.label}
            </span>
            <span aria-hidden className="flex h-[3px] overflow-hidden rounded-sm bg-line-muted">
              <span className={cn("rounded-sm", ht.bar)} style={{ width: `${Math.round(pct * 100)}%` }} />
            </span>
          </div>
        )}
      </div>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-[34px] w-full items-center justify-between gap-2 rounded-[10px] border border-line-muted bg-surface px-3 text-left text-[12px] text-fg-muted transition hover:bg-surface-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:h-10"
        >
          <span className="min-w-0 truncate">{rest > 0 ? `+${rest} na fila` : TRAIN_LABEL.end}</span>
          {rest > 0 && <span className="shrink-0 text-fg-subtle">{TRAIN_LABEL.seeQueue}</span>}
        </button>
        {open && (
          <div role="dialog" aria-label={TRAIN_LABEL.queue} className={cn(POPOVER_CLS, "absolute left-0 right-0 top-[40px] z-20 flex max-h-[380px] flex-col overflow-y-auto p-1.5 md:left-auto md:w-[340px]")}>
            {train.map((e, i) => {
              const st = TRAIN_STATE[trainState(e, owner, paused)];
              return (
                <div key={e.runId} className={cn("grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2 rounded-lg px-2 py-2", st.row)}>
                  <span className="text-[12px] tabular-nums text-fg-subtle">{i + 1}º</span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[13px] font-semibold text-fg">{titleOf(e).title}</span>
                    <span className={cn("flex items-center gap-1.5 text-[12px] font-medium", st.ink)}>
                      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", st.dot)} />
                      {st.label}
                    </span>
                  </span>
                </div>
              );
            })}
            {outside.map((c, i) => (
              <div key={c.id} className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2 rounded-lg px-2 py-2">
                <span className="text-[12px] tabular-nums text-fg-subtle">{train.length + i + 1}º</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-semibold text-fg">{featureOf(c, cardsById).title}</span>
                  <span className={cn("flex items-center gap-1.5 text-[12px] font-medium", TRAIN_STATE.fila.ink)}>
                    <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", TRAIN_STATE.fila.dot)} />
                    {TRAIN_STATE[paused ? "pausado" : "fila"].label}
                  </span>
                </span>
              </div>
            ))}
            <Link
              href={inboxHref(boardId)}
              onClick={() => setOpen(false)}
              className={cn(
                "flex min-h-10 items-center rounded-lg px-2 text-[12px] font-medium text-fg-muted transition hover:bg-surface-soft hover:text-fg md:min-h-8",
                train.length + outside.length > 0 && "mt-1 border-t border-surface-hover",
              )}
            >
              {TRAIN_LABEL.openInbox} →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
