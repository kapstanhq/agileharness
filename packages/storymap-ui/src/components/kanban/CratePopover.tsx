"use client";

// O POPOVER de uma caixinha do fluxo (288px): o título, o estado com a bolinha, o motivo em português simples, onde o
// item está («Raia · passo · i de n · há X») e duas ações — a primária escura e a secundária de borda — pelo estado
// (as do protótipo). As ações que pedem conversa abrem o chat do Jido com o card em contexto e o pedido já escrito
// (sem enviar); a decisão do dono roda a ação primária do Inbox num clique; «Retomar o board» muda o ritmo (e avisa o
// resto da tela pelo board-pace-bus), «Liberar 2º condutor» grava as vagas de verdade e «Fazer antes» (na fila) leva o
// card ao topo da coluna — a ordem do trabalho é a posição, sem nota de prioridade. A secundária é «Ver no board»
// só quando o item vira card na coluna dele; na Entrega (o trem) e no ar é «Perguntar ao Jido».

import { useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ageWords } from "@/lib/storymap/inbox/copy";
import type { FlowState, KanbanLane, LaneStep } from "@/lib/storymap/kanban-features";
import type { CardLiveStatus } from "@/lib/storymap/card-live-status";
import type { Card } from "@/lib/storymap/types";
import { ACTION_LABEL, CRATE_REASON, DRAFT, forgottenReason, placementWords, queuedReason, waitingReason } from "@/lib/storymap/kanban-copy";
import { setBoardPaceAction, setConductorSlotsAction } from "@/app/board-pace-actions";
import { placeCardInColumnAction } from "@/app/card-order-actions";
import { notifyBoardPaceChanged } from "@/components/board-pace-bus";
import { openJidoChat } from "@/components/chat/jido-bus";
import { useOwnerDecisionFor } from "@/components/OwnerDecisionsContext";
import { QuickActionButton } from "@/components/QuickActionButton";
import { useToast } from "@/components/Toast";
import { useDismiss } from "./KanbanFilterMenu";
import { POPOVER_CLS, PRIMARY_BTN, SECONDARY_BTN, STATE_TONE } from "./kanban-tokens";

export interface CratePopoverProps {
  boardId: string;
  card: Card;
  state: FlowState;
  live: CardLiveStatus | null;
  lane: KanbanLane;
  step: LaneStep;
  /** o item vira card na coluna dele (fora do trem e do No ar): a 2ª ação é «Ver no board». */
  findable: boolean;
  now: number;
  /** vagas de condutor do board (o motivo do «esperando condutor»). */
  slots: number;
  /** o que acontece a seguir com o item NA FILA: um agente roda no passo dele? o board está desligado ou pausado? */
  next: { auto: boolean; off: boolean; paused: boolean };
  /** onde o popover pousa dentro da faixa (calculado por quem desenha a caixinha). */
  style: CSSProperties;
  onClose: () => void;
  /** «Ver no board»: busca o card no quadro. */
  onFind: (title: string) => void;
}

/** O motivo, por estado — a frase da linha viva quando ela existe; senão a do protótipo (na fila: o que vem a seguir). */
function reasonOf(
  state: FlowState,
  live: CardLiveStatus | null,
  card: Card,
  now: number,
  slots: number,
  ownerWhat: string | null,
  next: CratePopoverProps["next"],
): string {
  const said = live ? [live.label, live.note].filter(Boolean).join(". ") : "";
  switch (state) {
    case "running":
      return said || CRATE_REASON.running;
    case "paused":
      return CRATE_REASON.paused;
    case "error":
      return said || CRATE_REASON.error;
    case "attention":
      return ownerWhat ?? (said || CRATE_REASON.attention);
    case "forgotten":
      return forgottenReason(card.updatedMs ? ageWords(now - card.updatedMs) : "dias");
    case "queued":
      return queuedReason(next);
    case "waiting":
      return live?.note || waitingReason(slots);
    case "delivering":
      return CRATE_REASON.delivering;
    case "live":
      return CRATE_REASON.live;
  }
}

export function CratePopover({ boardId, card, state, live, lane, step, findable, now, slots, next, style, onClose, onFind }: CratePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const decision = useOwnerDecisionFor(card.id);
  // Esc com o foco aqui dentro devolve o foco à caixinha que abriu o popover.
  const crateEl = () => document.querySelector<HTMLElement>(`[data-crate="${card.id.replace(/"/g, "")}"]`);
  useDismiss(true, onClose, ref, crateEl);
  const tone = STATE_TONE[state];
  const ask = (draft: string) => {
    onClose();
    // fechada a conversa, o foco volta à caixinha que abriu este popover
    openJidoChat({ cardId: card.id, cardTitle: card.title, card, draft, returnFocus: crateEl() });
  };
  const resume = async () => {
    setBusy(true);
    const r = await setBoardPaceAction({ boardId, level: "normal" }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return toast(r?.error ?? "Não consegui retomar o board.");
    // o quadro (a pílula, a esteira, as caixinhas pausadas) e o mascote do Jido trocam na hora, sem esperar a releitura
    notifyBoardPaceChanged({ boardId, view: r.data.pace });
    toast(r.data.message, "success");
    onClose();
  };
  // «Liberar 2º condutor» grava as vagas de verdade (a action do operador, a mesma do painel de ritmo); a página relê a
  // config para o quadro contar a vaga nova.
  const freeSecondSlot = async () => {
    setBusy(true);
    const r = await setConductorSlotsAction({ boardId, slots: 2 }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return toast(r?.error ?? "Não consegui liberar o 2º condutor.");
    toast(r.data.message, "success");
    router.refresh();
    onClose();
  };

  // «Fazer antes»: grava a posição do card no topo da coluna (a mesma action do menu do card).
  const doFirst = async () => {
    setBusy(true);
    const r = await placeCardInColumnAction({ boardId, cardId: card.id, where: "top" }).catch(() => null);
    setBusy(false);
    if (!r?.ok) return toast(r?.error ?? "Não consegui mudar a vez do card.");
    toast(placementWords("top", r.data.changed), "success");
    if (r.data.changed) router.refresh();
    onClose();
  };

  // A ação primária por estado (o `pipe5` do protótipo). Precisa de você roda a ação do Inbox quando ela existe.
  const primary: { label: string; run: () => void } | null =
    state === "attention" && decision?.primary
      ? null
      : {
          running: { label: ACTION_LABEL.ask, run: () => ask(DRAFT.ask) },
          paused: { label: ACTION_LABEL.resumeBoard, run: () => void resume() },
          error: { label: ACTION_LABEL.investigate, run: () => ask(DRAFT.investigate) },
          attention: { label: ACTION_LABEL.answer, run: () => ask(DRAFT.answer) },
          forgotten: { label: ACTION_LABEL.resume, run: () => ask(DRAFT.resumeCard) },
          queued: { label: ACTION_LABEL.doFirst, run: () => void doFirst() },
          waiting:
            slots <= 1
              ? { label: ACTION_LABEL.secondSlot, run: () => void freeSecondSlot() }
              : { label: ACTION_LABEL.doFirst, run: () => void doFirst() },
          delivering: { label: ACTION_LABEL.follow, run: () => ask(DRAFT.follow) },
          live: { label: ACTION_LABEL.ask, run: () => ask(DRAFT.talk) },
        }[state];
  // «Ver no board» só quando o item VIRA CARD na coluna dele (a busca o revela); o que está no trem e o que está no ar
  // não têm card: lá a segunda ação é conversar sobre ele (o protótipo dá «Perguntar ao Jido» a quem é só caixinha).
  const hasCard = findable;
  const secondary =
    state === "forgotten"
      ? { label: ACTION_LABEL.defer, run: () => ask(DRAFT.defer) }
      : hasCard
        ? {
            label: ACTION_LABEL.findOnBoard,
            run: () => {
              onClose();
              onFind(card.title);
            },
          }
        : { label: ACTION_LABEL.askJido, run: () => ask(DRAFT.talk) };

  const since = card.updatedMs ? ` · há ${ageWords(now - (live?.since ?? card.updatedMs))}` : "";
  const where = step.index > 0 ? `${step.name} · ${step.index} de ${step.total}` : step.name;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={card.title}
      style={style}
      className={cn(POPOVER_CLS, "absolute z-[15] flex w-[288px] flex-col gap-2 px-3.5 py-3 max-md:!left-2 max-md:!right-2 max-md:!w-auto")}
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 text-[14px] font-semibold leading-[1.3] text-fg-strong [text-wrap:pretty]">{card.title}</span>
        <button
          type="button"
          onClick={onClose}
          title="Fechar"
          aria-label="Fechar"
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:h-10 max-md:w-10"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <span className={cn("flex items-center gap-1.5 text-[12px] font-semibold", tone.ink)}>
        <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
        {tone.label}
      </span>
      <span className="text-[13px] leading-[1.45] text-fg [text-wrap:pretty]">
        {reasonOf(state, live, card, now, slots, decision?.what ?? null, next)}
      </span>
      <span className="text-[12px] text-fg-subtle">
        {lane.label} · {where}
        {since}
      </span>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {primary ? (
          <button type="button" disabled={busy} onClick={primary.run} className={cn(PRIMARY_BTN, "max-md:h-10")}>
            {primary.label}
          </button>
        ) : (
          decision?.primary && (
            <QuickActionButton boardId={boardId} cardId={card.id} action={decision.primary} surface="kanban" size="sm" className={cn(PRIMARY_BTN, "rounded-lg max-md:h-10")} />
          )
        )}
        <button type="button" onClick={secondary.run} className={cn(SECONDARY_BTN, "max-md:h-10")}>
          {secondary.label}
        </button>
      </div>
    </div>
  );
}
