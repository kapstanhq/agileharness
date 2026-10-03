"use client";

import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/cn";
import { cardEyebrow, cardSurface, cardSurfaceHover } from "@/lib/ui";
import { cardPriorityTier, priorityGlyph, priorityScore } from "@/lib/storymap/priority";
import { STORY_TYPE_BY_ID } from "@/lib/storymap/frameworks";
import { cardTypeLabel } from "@/lib/storymap/kanban-filter";
import { isDeliveryStory, needsPlacement, servesTarget } from "@/lib/storymap/unplaced";
import { effectiveAutonomy } from "@/lib/storymap/autonomy";
import { isConducted } from "@/lib/storymap/driver";
import { deferralText } from "@/lib/storymap/deferral";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";
import { VocabChips } from "./Chip";
import {
  KanbanCardActionsMenu,
  KanbanCardConsoleButton,
  KanbanCardHistoryButton,
  KanbanCardNextAction,
  KanbanCardRunButton,
  MoveToPopover,
} from "./RunnerStatusProvider";
import { cardLiveRail, CardLiveStatusLine, useCardLiveStatus } from "./CardLiveStatus";

/**
 * A story card inside a kanban column — sortable + draggable across columns.
 *
 * Notion-clean redesign (6-column kanban): the granularity of the pipeline lives ON THE CARD, not in
 * stacked step-lanes. The card answers "do que se trata, por quê e onde está" with black, typographic IA —
 * a quiet TYPE label + the black expressive TITLE + a discreet WHY line (narrative.soThat, with the type's
 * connector) + a STATUS LINE (a mini dot-trail of the phase's steps + the active step's name — progress
 * within the phase; omitted when the phase has a single navigable step). The footer carries the priority
 * TIER as a monochrome glyph (signal bars; «!» for Crítica — priority.ts `priorityGlyph`), hidden on a terminal card.
 * No coloured chips/dots: the one attention treatment is the AMBER "Precisa de você" pill (the same amber as the
 * Inbox chip in the nav — presence-tone.ts) when the card is in the Inbox's Decidir. The LIVE STATUS LINE under the
 * title (CardLiveStatus.tsx — who acts now, doing what, since when, and how much changed) and the left rail in its
 * presence are the only operational colour. Detail
 * (tasks, RICE/KANO, links) opens in the drawer. The entrega lane swaps the status line for the
 * DeliveryStepper (per-card 2-touch Aprovar/Publicar).
 */
interface KanbanCardProps {
  card: Card;
  config: BoardConfig;
  /** click handler — the board interprets it (1st click focuses, 2nd opens the editor) */
  onOpen: (id: string) => void;
  overlay?: boolean;
  /** when false (default), persona/system chips are hidden to keep cards compact */
  showMeta?: boolean;
  /** this card currently holds the focus (1st click) → ring + lifted above the dim */
  focused?: boolean;
  /** all board cards by id — resolves the served backbone node for the story↔item breadcrumb. */
  cardsById?: Map<string, Card>;
  /** Delivery stepper: advance this card to the next delivery step (Aprovar/Publicar). Only
   *  wired by the DeliveryStepperLane — a card in a `laneStep` status shows the inline stepper + buttons. */
  onAdvance?: (cardId: string, toStatus: string) => void;
  /** LANE VIEW (lanes.ts): the card's real status (+ integrando/publicando) as tags — the lane folds the steps
   *  away, so the card carries them. Absent (the legacy Kanban) ⇒ the phase progress line as before. */
  laneTags?: string[];
}

function KanbanCardImpl({
  card,
  config,
  onOpen,
  overlay,
  showMeta = false,
  focused = false,
  cardsById,
  onAdvance,
  laneTags,
}: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { kind: "story" },
    disabled: overlay,
  });
  const style = overlay ? undefined : { transform: CSS.Translate.toString(transform), transition };

  // A LINHA DE ESTADO (card-live-status.ts): quem age agora, fazendo o quê, desde quando — resolvida UMA vez aqui e
  // usada pela linha e pelo filete à esquerda (a mesma régua do cabeçalho da página do card e do Inbox).
  const live = useCardLiveStatus(config.id, card, config);

  // The active step (StatusDef) — single resolve, reused for the status line, terminal/laneStep
  // guards, and the ▶ Rodar affordance.
  const def: StatusDef | undefined = config.statuses.find((s) => s.id === card.status);
  const hasTrigger = !!def?.trigger;
  const isTerminal = !!def?.terminal;

  // Decision signal: the ARGUED priority tier (priorityCall) when set — reasoning-first — else the legacy
  // WSJF tier. Omitted when the card has neither (an unscored card carries no priority signal). The face
  // shows the tier as monochrome text weighted by rank; the tooltip carries the WHY (argument or WSJF).
  const tier = cardPriorityTier(card);
  const priorityTitle = !tier
    ? undefined
    : card.priorityCall
      ? `Prioridade ${tier.label} · ${card.priorityCall.source === "human" ? "definida por você" : "avaliada pelo agente"}${card.priorityCall.rationale ? `\n${card.priorityCall.rationale}` : ""}`
      : `Prioridade ${tier.label} · WSJF ${priorityScore(card)}`;

  // (c') STEP PROGRESS — where this card sits within its PHASE (column). The 6-column kanban hides the
  // step inside the column, so the card carries "<step> · N de M". We count only the steps THIS card
  // actually traverses (skipForTypes for its storyType are excluded, and hidden reentry steps), so the
  // "N de M" is honest per card. A phase with a single navigable step (e.g. Triagem) shows NO progress
  // line — the column already says where it is. terminal/laneStep already opt out below.
  const phaseSteps = def
    ? config.statuses.filter(
        (s) =>
          s.column === def.column &&
          s.hidden !== true &&
          !(card.storyType && s.skipForTypes?.includes(card.storyType)),
      )
    : [];
  const stepIdx = def ? phaseSteps.findIndex((s) => s.id === def.id) : -1;
  const showProgress = phaseSteps.length > 1 && stepIdx >= 0;

  // The "porquê" — the story's soThat benefit, framed by its type's connector (user/bug → "para",
  // enabler → "de modo que"). Restores the card's rationale (was documented but never rendered).
  const soThat = card.narrative?.soThat?.trim() || null;
  const whyConnector = STORY_TYPE_BY_ID[card.storyType ?? "user"]?.connectors.soThat ?? "para";

  // (a) The MOTHER STORY a ticket belongs to (servesTarget = serves ?? parent) — shown ONLY for delivery
  // tickets (technical/bug/chore/spike); a user story IS the story, so it shows no parent. No kind label.
  const servedId = isDeliveryStory(card) ? servesTarget(card) : null;
  const served = servedId ? (cardsById?.get(servedId) ?? null) : null;

  // (c) A DECISÃO do dono mora agora na linha de estado (kind `owner`, o MESMO modelo do Inbox — cardInboxSignal, com a
  // decisão rotineira da raia de entrega suprimida: o botão da própria raia já é ela; F8 — falha atravessa sempre).
  const showStatus = !overlay && !isTerminal && !def?.laneStep && !!def && !laneTags;
  // Rodar a etapa só faz sentido com o card PARADO: conduzido, com sessão viva, na fila ou integrando, outro ator já
  // está nele (e o motor nem roda coluna num card conduzido).
  const busy =
    isConducted(card) ||
    (live != null && ["working", "waiting", "quiet", "terminal-prompt", "queued", "integrating", "judging"].includes(live.kind));
  // The AUTONOMY KEY on the card (autonomy.ts): the story's OWN exception (set_card_autonomy) is shown — `ultra` on a
  // human board, `humano` on an ultra board. The board-wide mode is not repeated on every card (70 identical chips
  // on an ultra board said nothing; the exception is the information).
  const autonomy = effectiveAutonomy(card, config);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      onClick={(e) => {
        if (overlay) return;
        // Stop the board's click-away (which clears focus) from also firing.
        e.stopPropagation();
        onOpen(card.id);
      }}
      className={cn(
        // Warm-neutral card surface (shared with the Story Map cards via lib/ui): hairline border +
        // a barely-there lift, hover firms it. shrink-0: in a full terminal lane the card is a flex
        // child of a flex-col lane; without it the flexbox squeezes each card to a few px.
        cardSurface,
        "group flex shrink-0 overflow-hidden text-left",
        overlay ? "" : cn("touch-manipulation cursor-grab active:cursor-grabbing", cardSurfaceHover),
        focused && "border-accent ring-2 ring-accent/40",
        isDragging && "opacity-40",
      )}
    >
      {/* Left rail — the card's PRESENCE (presence-tone.ts) for peripheral scan: amber = needs you, blue = acting now,
          violet = the system delivering, grey = stopped/queued, terracotta = failed with nobody on it; transparent
          when nothing lives (and on «No ar»). The lone operational colour on an otherwise monochrome card. */}
      <div className={cn("w-1 shrink-0", cardLiveRail(live))} aria-hidden />

      <div className="min-w-0 flex-1 p-3">
        {/* (a) Mother story — só para tickets de entrega (a user story É a story). Sem rótulo de tipo. */}
        {served && (
          <span
            className="mb-1.5 flex items-center gap-1 text-[11px] leading-snug text-fg-subtle"
            title={`Faz parte de: ${served.title}`}
          >
            <span aria-hidden>↳</span>
            <span className="min-w-0 flex-1 truncate">{served.title}</span>
          </span>
        )}

        {/* (b) Tipo do item (monocromático) + a exceção de autonomia. O estado vivo saiu daqui para a LINHA DE
            ESTADO abaixo do título: o selo de execução daqui não via o condutor e exibia «Terminou» velho. */}
        <div className="flex items-center gap-2">
          <KanbanTypeLabel card={card} />
          {autonomy.source === "card" && (
            <span
              title={
                autonomy.mode === "ultra"
                  ? "Modo ultra (exceção desta story): o proxy responde entrevista e escolha de tela; dinheiro segue com você."
                  : "Modo humano (exceção desta story): você responde tudo, mesmo com o board em ultra."
              }
              // neutro nos dois modos: o âmbar do acento lia como «precisa de você» — a palavra diz o modo
              className="rounded px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-fg-muted ring-1 ring-inset ring-line-emphasis"
            >
              {autonomy.mode === "ultra" ? "ultra" : "humano"}
            </span>
          )}
        </div>

        {/* Title — 14.5px semibold (design-faithful: kanban cards carry a heavier title than map cards). */}
        <span className="mt-1 block text-[14.5px] font-semibold leading-snug tracking-tight text-fg">{card.title}</span>

        {/* A LINHA DE ESTADO — quem age agora e fazendo o quê («Condutor construindo · há 12 min»), o tamanho do
            trabalho («+442 −8 · 14 arquivos») e, na segunda linha, o relato do agente. É a resposta ao dono: «não fica
            claro o que está rodando, em qual etapa, nem o quanto foi alterado». */}
        {!overlay && <CardLiveStatusLine boardId={config.id} card={card} config={config} status={live} className="mt-1.5" />}

        {/* 4.3 — a discreet "sem lugar" pill when the hasPlacement gate would hold this story (CardBadges is
            map-only, so the kanban surfaces it here). Tooltip points to the drawer's Posição no mapa block. */}
        {needsPlacement(card) && !overlay && (
          <span
            title="Sem lugar no mapa (sem pai, sem serves, sem aceite) — o gate a segura antes da construção. Abra o card → Posição no mapa."
            // contorno neutro, não âmbar: âmbar é só «precisa de você», e o gate de lugar é do pipeline
            className="mt-1 inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted ring-1 ring-inset ring-line-emphasis"
          >
            sem lugar
          </span>
        )}

        {/* (b') Porquê — o benefício (soThat) com o conector do tipo. Discreto, 2 linhas no máx. */}
        {soThat && !overlay && (
          <p className="mt-1.5 text-[12.5px] leading-[1.45] text-fg-muted line-clamp-2" title={`${whyConnector} ${soThat}`}>
            {whyConnector} {soThat}
          </p>
        )}

        {/* (c) Status — discreto (mini-trilha de pontos + nome da etapa, o progresso na fase) por padrão; com
            DESTAQUE (sólido preto, clicável) quando depende de ação humana (pergunta/bloqueio/triagem/gate manual
            com trabalho produzido). Omitido quando a fase tem um único step navegável (ex.: Triagem). */}
        {live?.kind !== "owner" && showStatus && showProgress ? (
          <div
            className="mt-2 flex items-center gap-2 text-[11px] text-fg-subtle"
            title={`Etapa ${stepIdx + 1} de ${phaseSteps.length} da fase: ${def!.name}`}
          >
            {/* Segment bar (design-faithful): one segment per step of THIS card's phase — filled (graphite)
                up to and including the current step, light beyond. Progress within the phase at a glance. */}
            <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
              {phaseSteps.map((s, i) => (
                <span
                  key={s.id}
                  className={cn("h-[3px] w-[13px] rounded-full transition", i <= stepIdx ? "bg-fg" : "bg-line")}
                />
              ))}
            </span>
            <span className="min-w-0 truncate">{def!.name}</span>
          </div>
        ) : null}

        {/* LANE VIEW — the step the lane folds away, as quiet tags: the real status first, then the train /
            publish state it rests in. */}
        {laneTags && laneTags.length > 0 && !overlay && (
          <div className="mt-2 flex flex-wrap items-center gap-1" title={`Status: ${laneTags[0]}`}>
            {laneTags.map((t, i) => (
              <span
                key={t}
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10.5px] font-medium leading-none",
                  i === 0 ? "bg-surface-hover text-fg-muted" : "bg-fg/[0.06] uppercase tracking-wide text-fg-subtle",
                )}
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* «Adiado — não agora» (deferral.ts): o motivo e desde quando, em palavras do dono — nada roda sozinho neste card. */}
        {card.deferred && !overlay && (
          <p className="mt-1.5 flex items-start gap-1 text-[11.5px] leading-snug text-fg-muted" title={card.deferred.reason}>
            <span aria-hidden>⏸</span>
            <span className="min-w-0">{deferralText(card.deferred)}</span>
          </p>
        )}

        {/* Entrega: the delivery stepper — evolving step text + counter + Aprovar/Publicar. Only
            renders for a card sitting in a `laneStep` step (the entrega lane); a no-op everywhere else. */}
        {!overlay && <DeliveryStepper card={card} config={config} onAdvance={onAdvance} />}

        {showMeta && <VocabChips card={card} config={config} />}

        {/* Action strip: priority TIER (left, Crítica/Alta/Média/Baixa — omitted when unscored), then
            history, console, the owner's resolve button (KanbanCardNextAction — only for a card in the Inbox's Decidir),
            "Mover", ▶/⏹ Rodar/Parar. */}
        {!overlay && (
          <div className="-mx-3 -mb-3 mt-2 flex items-center gap-1.5 border-t border-line-muted px-3 py-1.5">
            {tier && !isTerminal && <PriorityGlyph rank={tier.rank} label={tier.label} title={priorityTitle} />}
            {/* flex-wrap: num card estreito os BOTÕES inteiros descem de linha — nunca o texto de um
                botão quebra no meio (os filhos são shrink-0 + nowrap por contrato do QuickActionButton
                e dos icon-buttons h-7). Alinhamento vertical vem da régua única h-7. */}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
              {/* Kebab (⋯) — secondary/destructive actions (Sincronizar · Excluir card), revealed on
                  card hover, to the LEFT of the operational icons. */}
              <KanbanCardActionsMenu boardId={config.id} cardId={card.id} card={card} />
              <KanbanCardHistoryButton boardId={config.id} cardId={card.id} card={card} config={config} />
              <KanbanCardConsoleButton boardId={config.id} cardId={card.id} />
              <KanbanCardNextAction boardId={config.id} cardId={card.id} />
              <MoveToPopover boardId={config.id} cardId={card.id} card={card} config={config} />
              <KanbanCardRunButton boardId={config.id} cardId={card.id} hasTrigger={hasTrigger} card={card} busy={busy} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * C2 — memoize the card so board-level re-renders that DON'T touch this card (drag start/end, selection,
 * smart-capture toggle) skip it. The comparator is CONSERVATIVE: it re-renders whenever anything the card
 * reads could have changed. `updatedMs` is the server mtime token (bumped on ANY card write) so it covers
 * every persisted field (title/narrative/priority/personas/…) in a single check; `config`/`cardsById`
 * reference changes cover config edits and served-parent title changes; the visual flags + the two
 * callbacks are compared directly. When in doubt we return false (re-render) — a missed update is a bug,
 * an extra render is not. Live run state arrives via context (not props), so the run rail/badges still
 * update independently of this memo.
 */
function kanbanCardPropsEqual(prev: KanbanCardProps, next: KanbanCardProps): boolean {
  const a = prev.card;
  const b = next.card;
  return (
    a.id === b.id &&
    a.updatedMs === b.updatedMs &&
    a.status === b.status &&
    a.title === b.title &&
    a.order === b.order &&
    prev.overlay === next.overlay &&
    prev.showMeta === next.showMeta &&
    prev.focused === next.focused &&
    prev.onOpen === next.onOpen &&
    prev.onAdvance === next.onAdvance &&
    (prev.laneTags ?? []).join("\u0000") === (next.laneTags ?? []).join("\u0000") &&
    a.autonomyMode === b.autonomyMode &&
    prev.config === next.config &&
    prev.cardsById === next.cardsById
  );
}

export const KanbanCard = memo(KanbanCardImpl, kanbanCardPropsEqual);

/**
 * The priority GLYPH (priority.ts `priorityGlyph`) — 1 to 3 rising bars in the ink, «!» in a filled square for
 * Crítica. Monochrome on purpose: the amber dot it replaced read as «precisa de você». The tier's name is the tooltip
 * and the accessible label, never colour alone.
 */
function PriorityGlyph({ rank, label, title }: { rank: 0 | 1 | 2 | 3; label: string; title?: string }) {
  const { bars, urgent } = priorityGlyph(rank);
  return (
    <span title={title} className="flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
      {urgent ? (
        <span aria-hidden className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-fg text-[10px] font-bold leading-none text-surface">
          !
        </span>
      ) : (
        <span aria-hidden className="flex h-3 items-end gap-[2px]">
          {[1, 2, 3].map((i) => (
            <span key={i} className={cn("w-[3px] rounded-sm", i <= bars ? "bg-fg-muted" : "bg-line", i === 1 ? "h-1" : i === 2 ? "h-2" : "h-3")} />
          ))}
        </span>
      )}
      {label}
    </span>
  );
}

/**
 * The single quiet TYPE label atop a card. An active execution `mode` PREVAILS over the storyType
 * (fix→Bug, refine→Refino, retire→<disposition>); otherwise the storyType's canonical name. Notion-clean:
 * monochrome uppercase muted text — no coloured chip.
 */
function KanbanTypeLabel({ card }: { card: Card }) {
  // A regra mora em cardTypeLabel porque a busca do Kanban acha o card pelo MESMO rótulo que ele mostra.
  const { text, title } = cardTypeLabel(card);
  return (
    <span className={cardEyebrow} title={title}>
      {text}
    </span>
  );
}

/**
 * The on-card DELIVERY STEPPER — shown ONLY for a card sitting in a `laneStep` step (the
 * entrega lane). Collapses the 5 delivery steps into ONE evolving card: a step counter (idx/total) + the
 * current step's name + the TWO human-touch buttons. A human-gate step (autorun:false, not the auto-terminal
 * deploy) shows an advance button to the NEXT step; the automatic steps (merge/stage) show none. The step
 * ids/labels are DERIVED from board.yaml (laneStep + autorun + onEnter), never hardcoded. Buttons are
 * monochrome (Notion): outline = intermediate approve, solid dark = the final commit (Publicar).
 */
function DeliveryStepper({
  card,
  config,
  onAdvance,
}: {
  card: Card;
  config: BoardConfig;
  onAdvance?: (cardId: string, toStatus: string) => void;
}) {
  const curStatus = config.statuses.find((s) => s.id === card.status);
  if (!curStatus?.laneStep) return null; // not a delivery-lane card → no stepper
  // Scope the steps to THIS card's delivery column (not every laneStep status globally).
  const steps = config.statuses.filter((s) => s.laneStep && s.column === curStatus.column);
  const idx = steps.findIndex((s) => s.id === card.status);
  if (idx < 0) return null;
  const cur = steps[idx];
  const next = steps[idx + 1] ?? null;
  // Human-gate steps (autorun:false) expose the advance button; automatic steps (merge/stage)
  // auto-forward, so no button. The publish step is the one whose NEXT carries the promote-and-deploy
  // effect. WS-3: the deploy step ITSELF (onEnter promote-and-deploy) shows NO button —
  // since autoEnterTerminal left the yaml, the card RESTS there until the settle measures, stamps
  // deployProof and advances through the gate; a manual advance would just be rejected by
  // hasDeployProof, so offering the button is a lie. It reads "publicando…" the whole wait instead.
  const isDeployStep = cur.onEnter === "promote-and-deploy";
  const showButton = !!onAdvance && !!next && cur.autorun !== true && !cur.autoEnterTerminal && !isDeployStep;
  const isPublish = next?.onEnter === "promote-and-deploy";
  const working = cur.autorun === true ? "auto…" : cur.autoEnterTerminal || isDeployStep ? "publicando…" : null;
  return (
    <div className="mt-2 rounded-md bg-fg/[0.04] px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-muted">
        <span className="shrink-0 tabular-nums text-fg-subtle">
          {idx + 1}/{steps.length}
        </span>
        <span className="min-w-0 flex-1 truncate">{cur.name}</span>
        {working && <span className="shrink-0 text-[9px] uppercase tracking-wide text-fg-subtle">{working}</span>}
      </div>
      {showButton && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdvance!(card.id, next!.id);
          }}
          className={cn(
            "mt-1.5 inline-flex w-full items-center justify-center rounded px-2 py-1 text-[11px] font-semibold transition",
            isPublish
              ? "bg-fg text-surface hover:bg-fg/85"
              : "border border-line-emphasis text-fg hover:bg-surface-hover",
          )}
        >
          {isPublish ? "Publicar" : "Aprovar entrega"}
        </button>
      )}
    </div>
  );
}
