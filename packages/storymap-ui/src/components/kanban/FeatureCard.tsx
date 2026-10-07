"use client";

// O CARD DO KANBAN POR FUNCIONALIDADE (fiel ao desenho 6a). Em cima o tipo (Novidade / Correção / Manutenção), há
// quanto tempo e o chevron de ações; o título é a FUNCIONALIDADE — e leva à PÁGINA dela (fase 7) — e, menor, a linha do
// item que anda nela, com o prefixo pelo estado («Agora:», «Próximo:», «Precisa de você:»; um lote diz «Agora: 3
// correções»), que abre o ITEM direto (o item some quando o card é a própria funcionalidade). Embaixo, UMA seção pelo
// estado:
//   • AÇÃO (precisa de você / erro): o bloco no tom do estado, o motivo em linguagem simples e o botão primário escuro —
//     que RODA a ação primária da decisão do dono (um clique) e só abre o chat com o pedido escrito quando não há ação
//     direta («Investigar» um erro);
//   • RODANDO: a marca do agente, a última mensagem ao vivo (anima ao trocar), a barra dos passos da raia, «Passo · i de
//     n» e o custo curto que, no hover, abre a grade com os números que existem;
//   • QUIETO para o resto: bolinha + rótulo + a mensagem ou o passo.
// O chevron abre, dentro do card, as ações. Duas mudam a VEZ do card na coluna, direto («Fazer antes» leva ao topo,
// «Pode esperar» ao fim — a ordem do trabalho é a posição, não há nota de prioridade); as demais abrem o chat do Jido
// com o card em contexto e o pedido escrito. Clicar no corpo abre a página da funcionalidade. Sem arrastar nesta fase.
//
// A linha viva vem da MESMA régua do resto do app (useCardLiveStatus → card-live-status.ts); a decisão do dono, do
// Decidir do Inbox (useOwnerDecisionFor). Nenhum card é região viva (`role=status`): o anúncio do board é um só.

import { memo, useContext, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { ageWords } from "@/lib/storymap/inbox/copy";
import { isConducted } from "@/lib/storymap/driver";
import { isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import { formatMoney } from "@/lib/storymap/currency";
import { displayTitle } from "@/lib/storymap/display-title";
import {
  agentTimeWords,
  itemLine,
  itemLinePrefix,
  kindOf,
  moreItemsWords,
  othersBeyondLot,
  tokensWords,
  type LaneStep,
  type VisibleEntry,
} from "@/lib/storymap/kanban-features";
import { ACTION_LABEL, CRATE_REASON, DRAFT, placementWords } from "@/lib/storymap/kanban-copy";
import type { ColumnPlacement } from "@/lib/storymap/order";
import type { CardMetrics } from "@/lib/storymap/runner/telemetry";
import type { BoardConfig } from "@/lib/storymap/types";
import { placeCardInColumnAction } from "@/app/card-order-actions";
import { openJidoChat } from "@/components/chat/jido-bus";
import { useCardLiveStatus } from "@/components/CardLiveStatus";
import { BoardLiveContext, useOwnerDecisionFor } from "@/components/OwnerDecisionsContext";
import { QuickActionButton } from "@/components/QuickActionButton";
import { useToast } from "@/components/Toast";
import { AgentMark } from "./AgentMark";
import { PRIMARY_BTN, STATE_TONE } from "./kanban-tokens";

/** As duas ações de POSIÇÃO na coluna — gravam o `order` direto (placeCardInColumnAction), sem passar pelo chat. */
const ORDER_ITEMS: ReadonlyArray<{ label: string; where: ColumnPlacement }> = [
  { label: ACTION_LABEL.doFirst, where: "top" },
  { label: ACTION_LABEL.canWait, where: "bottom" },
];

export interface FeatureCardProps {
  config: BoardConfig;
  entry: VisibleEntry;
  step: LaneStep;
  /** para onde o TÍTULO leva: a página da funcionalidade (o card que é a própria funcionalidade: a do item). */
  href: string;
  /** a página de qualquer card (a lista dos outros itens da funcionalidade abre cada um). */
  hrefOf: (cardId: string) => string;
  now: number;
  metrics?: CardMetrics;
  highlighted: boolean;
  onHover: (cardId: string | null) => void;
}


/**
 * O card cujo chevron recebe o foco depois de «Fazer antes»/«Pode esperar». O `router.refresh()` reordena a coluna e a
 * instância que mostrava o card pode passar a mostrar outro (a chave é a funcionalidade): o foco dado ANTES do refresh
 * caía no card errado. Quem segura o pedido é o id; a instância que estiver com aquele card, depois do refresh, o atende.
 */
let pendingChevronFocus: string | null = null;

export const FeatureCard = memo(function FeatureCard({ config, entry, step, href, hrefOf, now, metrics, highlighted, onHover }: FeatureCardProps) {
  const card = entry.item;
  const state = entry.state;
  const tone = STATE_TONE[state];
  const live = useCardLiveStatus(config.id, card, config);
  const decision = useOwnerDecisionFor(card.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const [costOpen, setCostOpen] = useState(false);
  // a lista dos OUTROS itens da funcionalidade nesta raia, aberta pelo «+N … desta funcionalidade»
  const [othersOpen, setOthersOpen] = useState(false);
  const othersId = useId();
  const boardLive = useContext(BoardLiveContext);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    // Esc fecha o menu; com o foco num item dele, o foco volta ao chevron (o item some e o teclado cairia no <body>).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const hadFocus = !!menuRef.current?.contains(document.activeElement);
      setMenuOpen(false);
      if (hadFocus) chevronRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  // Aberto, o menu ROLA para a vista — acima do compositor do Jido (fixo no rodapé; o `scroll-margin` reserva a altura
  // dele): no celular os últimos itens nasciam embaixo da caixa de escrever.
  useEffect(() => {
    if (!menuOpen) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    menuRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [menuOpen]);

  useEffect(() => {
    if (pendingChevronFocus !== card.id) return;
    pendingChevronFocus = null;
    chevronRef.current?.focus();
  }, [card.id, card.order]);

  const ask = (draft: string) => {
    setMenuOpen(false);
    // fechada a conversa, o foco volta ao chevron do card (de onde a pessoa veio)
    openJidoChat({ cardId: card.id, cardTitle: card.title, card, draft, returnFocus: chevronRef.current });
  };

  // «Fazer antes» / «Pode esperar»: a posição na coluna é a ordem do trabalho (o condutor e o `suggest_work` leem a
  // mesma). Grava só o `order` deste card; já no lugar, só avisa. O foco volta ao chevron do card (o menu fecha) — depois
  // que o refresh reordena a coluna, pelo id (`pendingChevronFocus`), não pela instância.
  const place = async (where: ColumnPlacement) => {
    setPlacing(true);
    const r = await placeCardInColumnAction({ boardId: config.id, cardId: card.id, where }).catch(() => null);
    setPlacing(false);
    setMenuOpen(false);
    chevronRef.current?.focus();
    if (!r?.ok) return toast(r?.error ?? "Não consegui mudar a vez do card.");
    toast(placementWords(where, r.data.changed), "success");
    if (r.data.changed) {
      const id = card.id;
      pendingChevronFocus = id;
      router.refresh();
      // o pedido não sobrevive ao refresh: um card que sumiu da vista não rouba o foco minutos depois
      window.setTimeout(() => {
        if (pendingChevronFocus === id) pendingChevronFocus = null;
      }, 3000);
    }
  };

  const running = state === "running";
  const isAct = state === "attention" || state === "error";
  const anchor = live?.since ?? card.updatedMs;
  const since = anchor && now > 0 ? ageWords(now - anchor) : "";
  const stepText = step.index > 0 ? `${step.name} · ${step.index} de ${step.total}` : step.name;
  const message = live ? (live.note ?? live.label) : "";

  // O menu (o do protótipo, sem «Mudar autonomia» — fase 4). «Rodar» só onde há o que rodar e ninguém já está no card;
  // «Parar o condutor» só no card conduzido que roda. Num board só de organização nada que dispara execução aparece.
  const organizeOnly = isOrganizeOnly(config);
  const hasTrigger = !!config.statuses.find((s) => s.id === card.status)?.trigger;
  const busy = isConducted(card) || state === "waiting" || state === "delivering";
  const runItem = running
    ? isConducted(card) && !organizeOnly
      ? { label: ACTION_LABEL.stop, draft: DRAFT.stop }
      : null
    : hasTrigger && !busy && !organizeOnly
      ? { label: ACTION_LABEL.run, draft: DRAFT.run }
      : null;
  // A posição só manda onde há uma vez a esperar: no trem (Entrega) e no ar a ordem não decide mais nada.
  const orderable = state !== "delivering" && state !== "live";
  const menu = [
    { label: ACTION_LABEL.talk, draft: DRAFT.talk },
    { label: ACTION_LABEL.move, draft: DRAFT.move },
    ...(runItem ? [runItem] : []),
    { label: ACTION_LABEL.deferMenu, draft: DRAFT.defer },
    { label: ACTION_LABEL.bug, draft: DRAFT.bug },
    ...(!organizeOnly ? [{ label: ACTION_LABEL.sync, draft: DRAFT.sync }] : []),
    { label: ACTION_LABEL.remove, draft: DRAFT.remove },
  ];

  // O motivo do bloco de ação: a decisão do dono em uma frase; o erro como a linha viva o diz.
  const actReason =
    state === "attention"
      ? (decision?.what ?? (live ? [live.label, live.note].filter(Boolean).join(". ") : CRATE_REASON.attention))
      : live
        ? [live.label, live.note].filter(Boolean).join(". ")
        : CRATE_REASON.error;

  // O custo do card (a telemetria do board, em lote): o curto é em TOKENS, como no desenho; a grade, Tokens · Tempo de
  // agente · Custo · Turnos — só as células com número real (sem relato, a célula some).
  const tokens = metrics?.totalTokens != null && metrics.totalTokens > 0 ? tokensWords(metrics.totalTokens) : null;
  const money = metrics && metrics.totalCostUSD > 0 ? formatMoney(metrics.totalCostUSD, { code: "USD" }) : null;
  const costRows = [
    ...(tokens ? [{ k: "Tokens", v: tokens.replace(/ tokens$/, "") }] : []),
    ...(metrics?.totalDurationMs != null && metrics.totalDurationMs > 0 ? [{ k: "Tempo de agente", v: agentTimeWords(metrics.totalDurationMs) }] : []),
    ...(money ? [{ k: "Custo", v: money }] : []),
    ...(metrics?.totalTurns != null && metrics.totalTurns > 0 ? [{ k: "Turnos", v: String(metrics.totalTurns) }] : []),
  ];
  const cost = tokens ?? money;

  const lit = highlighted && !menuOpen;
  const line = itemLine(entry);
  // o «+N» não repete o que a linha do lote já resume («Agora: 1 correção, 1 manutenção»)
  const extra = othersBeyondLot(entry);

  return (
    <div
      // O contorno escuro é o ELO card ↔ caixinha (passar o mouse acende os dois): só com MOUSE — no toque o
      // mouseenter emulado grudava e o card inteiro parecia selecionado — e nunca com o menu do card aberto.
      onPointerEnter={(e) => e.pointerType === "mouse" && onHover(card.id)}
      onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)}
      className={cn(
        "relative flex flex-none flex-col overflow-hidden rounded-[10px] border bg-surface transition-shadow",
        running && !lit ? "ah-run-glow border-transparent" : "border-line-muted",
        lit ? "shadow-[0_0_0_2px_rgb(var(--fg))]" : !running && "shadow-[0_1px_2px_rgba(15,15,15,.04)]",
      )}
    >
      <div className="flex items-center gap-1.5 pl-3 pr-2 pt-[9px] text-[12px] text-fg-subtle">
        <span className="font-medium">{kindOf(card)}</span>
        <span className="flex-1" />
        {since && <span className="tabular-nums">{since}</span>}
        <button
          ref={chevronRef}
          type="button"
          onClick={() => setMenuOpen((o) => !o)}
          title="Ações"
          aria-label={`Ações do card ${displayTitle(card.title)}`}
          aria-expanded={menuOpen}
          className={cn(
            "relative z-[1] flex h-[22px] w-[22px] items-center justify-center rounded-md transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:h-10 max-md:w-10",
            menuOpen && "bg-surface-hover",
          )}
        >
          <ChevronDown className="h-[11px] w-[11px]" strokeWidth={2.4} aria-hidden />
        </button>
      </div>

      <div className="flex flex-col gap-1 px-3 pb-3 pt-0.5">
        {/* O título é o LINK da página da FUNCIONALIDADE, esticado sobre o card inteiro (`after:inset-0`): clicar no
            corpo abre a funcionalidade, e a linha do item e os botões de dentro ficam por cima (z-[1]) sem link
            aninhado. */}
        <Link
          href={href}
          className="text-[14px] font-semibold leading-[1.3] tracking-[-0.01em] text-fg-strong [text-wrap:pretty] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-[10px] focus-visible:after:ring-2 focus-visible:after:ring-accent"
        >
          {/* sem a etiqueta de máquina do começo (display-title.ts): o card que é a própria funcionalidade mostra o título
              do item — o gravado não muda */}
          {displayTitle(entry.feature.title)}
        </Link>
        {!entry.feature.self && (
          // A linha do ITEM abre o item direto (acima do link esticado), com o prefixo pelo estado — o que o dono lê
          // primeiro. No celular, alvo de toque de 40px.
          <Link
            href={hrefOf(card.id)}
            title={card.title}
            className="relative z-[1] -mx-1 flex items-center self-start rounded-md px-1 text-[13px] leading-[1.4] text-fg-subtle transition [text-wrap:pretty] hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-10"
          >
            <span>
              {line.prefix && <span className={cn("font-semibold", tone.ink)}>{line.prefix} </span>}
              {line.text}
            </span>
          </Link>
        )}
        {extra.others.length > 0 && (
          // O «+N» é um BOTÃO que abre, dentro do card, os outros itens da funcionalidade nesta raia: o cabeçalho conta
          // itens, a coluna mostra um card por funcionalidade — aqui a pessoa vê o que o card junta.
          <button
            type="button"
            onClick={() => setOthersOpen((o) => !o)}
            aria-expanded={othersOpen}
            aria-controls={othersId}
            // na cor de destaque (pedido do dono, 07/10): «11 itens» no cabeçalho e 2 cards na coluna confundiam — a cor
            // mostra que o «+N» abre os itens que o card junta
            className="relative z-[1] -mx-1 flex items-center self-start rounded-md px-1 text-left text-[12px] font-medium text-accent-ink transition hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-10"
          >
            <span className="[text-wrap:pretty]">
              {moreItemsWords(extra.others)}
              {/* o chevron segue a última palavra (numa coluna estreita a frase quebra e ele não fica solto à direita) */}
              <ChevronDown
                aria-hidden
                strokeWidth={2.4}
                className={cn("ml-1 inline h-[11px] w-[11px] align-[-1px] transition-transform motion-reduce:transition-none", othersOpen && "rotate-180")}
              />
            </span>
          </button>
        )}
        {extra.others.length > 0 && othersOpen && (
          <ul id={othersId} aria-label={`Outros itens de ${entry.feature.title} nesta raia`} className="relative z-[1] -mx-1 flex flex-col">
            {extra.others.map((o, k) => {
              const st = extra.states[k] ?? "queued";
              const at = boardLive?.get(o.id)?.since ?? o.updatedMs;
              const age = at && now > 0 ? ageWords(now - at) : "";
              return (
                <li key={o.id}>
                  {/* O prefixo e o título num TEXTO SÓ, que quebra nas palavras em até duas linhas: numa coluna estreita (o
                      computador de 1366px) o prefixo fixo deixava ~50px ao título, cortado no meio da palavra
                      («Esquecido: Condut…»). A bolinha e a idade ficam na 1ª linha. */}
                  <Link
                    href={hrefOf(o.id)}
                    title={`${o.title} · ${STATE_TONE[st].label}`}
                    className="flex min-w-0 items-start gap-1.5 rounded-md px-1 py-1 text-[12px] leading-[1.35] text-fg transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-10 max-md:items-center"
                  >
                    <span aria-hidden className={cn(STATE_TONE[st].quietDot, "mt-[5px] max-md:mt-0")} />
                    <span className="line-clamp-2 min-w-0 flex-1 break-words">
                      {itemLinePrefix(st) ? (
                        <span className={cn("font-semibold", STATE_TONE[st].ink)}>{itemLinePrefix(st)} </span>
                      ) : (
                        <span className="sr-only">{STATE_TONE[st].label}: </span>
                      )}
                      {displayTitle(o.title)}
                    </span>
                    {age && <span className="shrink-0 tabular-nums text-fg-subtle">{age}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {isAct && (
        <div className={cn("relative z-[1] mx-1.5 mb-1.5 flex flex-col gap-2 rounded-lg p-2.5", tone.tint)}>
          <span className={cn("flex items-center gap-1.5 text-[12px] font-semibold", tone.ink)}>
            <span aria-hidden className={tone.quietDot} />
            {tone.label}
          </span>
          <span className="text-[13px] leading-[1.4] text-fg [text-wrap:pretty]">{actReason}</span>
          {state === "attention" && decision?.primary ? (
            <span className="self-start">
              <QuickActionButton boardId={config.id} cardId={card.id} action={decision.primary} surface="kanban" size="sm" className={cn(PRIMARY_BTN, "max-md:h-10")} />
            </span>
          ) : (
            <button
              type="button"
              onClick={() => ask(state === "attention" ? DRAFT.answer : DRAFT.investigate)}
              className={cn(PRIMARY_BTN, "self-start max-md:h-10")}
            >
              {state === "attention" ? ACTION_LABEL.answer : ACTION_LABEL.investigate}
            </button>
          )}
        </div>
      )}

      {running && (
        <div className="flex flex-col gap-[9px] border-t border-surface-hover px-3 pb-3 pt-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <AgentMark kind={isConducted(card) ? "condutor" : "execucao"} size={20} animated />
            <span key={message} title={message} className="ah-tick-in min-w-0 flex-1 truncate text-[13px] leading-[1.35] text-fg">
              {message}
            </span>
          </div>
          <div
            className="relative z-[1] flex flex-col gap-[5px]"
            // Hover só para MOUSE: no toque o mouseenter emulado abriria e o clique logo em seguida fecharia.
            onPointerEnter={(e) => e.pointerType === "mouse" && setCostOpen(true)}
            onPointerLeave={(e) => e.pointerType === "mouse" && setCostOpen(false)}
          >
            <span aria-hidden className="flex gap-0.5">
              {Array.from({ length: step.total }, (_, i) => (
                <span key={i} className={cn("h-[3px] flex-1 rounded-sm", i < step.index ? "bg-st-run" : "bg-line-muted")} />
              ))}
            </span>
            <span className="flex justify-between gap-2 text-[12px] tabular-nums text-fg-subtle">
              <span className="min-w-0 truncate">{stepText}</span>
              {cost && (
                <button
                  type="button"
                  onClick={() => setCostOpen((o) => !o)}
                  onBlur={() => setCostOpen(false)}
                  aria-expanded={costOpen}
                  className="relative shrink-0 whitespace-nowrap border-b border-dotted border-line-emphasis after:absolute after:-inset-x-1 after:-inset-y-3 after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {cost}
                </button>
              )}
            </span>
          </div>
          {costOpen && costRows.length > 0 && (
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-1.5 rounded-lg bg-surface-soft px-2.5 py-2 text-[12px] text-fg-muted">
              {costRows.map((r) => (
                <span key={r.k} className="flex flex-col gap-px">
                  <span className="text-[11px] font-semibold uppercase tracking-[.04em] text-fg-subtle">{r.k}</span>
                  <b className="font-semibold tabular-nums text-fg">{r.v}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {!isAct && !running && (
        <div className="flex min-w-0 items-center gap-1.5 border-t border-surface-hover px-3 pb-2.5 pt-2 text-[12px] text-fg-subtle">
          <span aria-hidden className={tone.quietDot} />
          <span className={cn("shrink-0 font-semibold", tone.ink)}>{tone.label}</span>
          <span aria-hidden className="text-line-emphasis">·</span>
          <span className="min-w-0 truncate">{state !== "queued" && state !== "forgotten" && message ? message : stepText}</span>
        </div>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="relative z-[1] flex scroll-mb-[calc(var(--jido-composer-h,0px)_+_12px)] flex-col border-t border-surface-hover bg-board p-1"
        >
          {orderable && (
            <>
              <span className="px-2 pb-1.5 pt-1 text-[11px] text-fg-subtle">{ACTION_LABEL.orderHint}</span>
              {ORDER_ITEMS.map((o) => (
                <button
                  key={o.where}
                  type="button"
                  disabled={placing}
                  onClick={() => void place(o.where)}
                  title={o.label}
                  className="flex h-7 min-w-0 items-center rounded-md px-2 text-left text-[12px] text-fg transition hover:bg-surface-press focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 max-md:h-10"
                >
                  <span className="min-w-0 truncate">{o.label}</span>
                </button>
              ))}
              <span aria-hidden className="mx-2 my-1 h-px bg-surface-hover" />
            </>
          )}
          <span className="px-2 pb-1.5 pt-1 text-[11px] text-fg-subtle">{ACTION_LABEL.menuHint}</span>
          {menu.map((m) => (
            <button
              key={m.label}
              type="button"
              onClick={() => ask(m.draft)}
              // Linhas de 28px, uma linha só (os rótulos são curtos; o que não couber numa coluna estreita trunca, com o
              // nome inteiro no `title`); no toque, 40px.
              title={m.label}
              className="flex h-7 min-w-0 items-center rounded-md px-2 text-left text-[12px] text-fg transition hover:bg-surface-press focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:h-10"
            >
              <span className="min-w-0 truncate">{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
