"use client";

// Per-board Inbox cockpit — the primary day-to-day surface for the human orchestrator on ONE
// board. Renders a typed inbox: each CockpitItem kind has its own renderer + actions (the registry).
// Adding a new kind = one function in KIND_RENDERER + one entry in the CockpitItemKind union in
// demands.ts. No kind bleeds into another's renderer.
//
// Architecture:
//   CockpitView (exported, ToastProvider shell)
//   └── CockpitViewInner (state: localCards, SSE refresh)
//       └── per-lane section
//           └── CockpitItemRow (dispatches to KIND_RENDERER[item.kind])
//               ├── QuestionRenderer  — prompt + options (radio/checkbox) + free textarea; NO advance
//               ├── BlockerRenderer   — title/lens/suggestion; Resolver / Não corrigir; NO advance
//               ├── ApprovalRenderer  — gate label; Aprovar & avançar (moveCardAction); Abrir card
//               ├── ReviewRenderer    — triage flag; Abrir card only
//               ├── StuckRenderer      — run failure; Tentar novamente + Ver console + Abrir card
//               ├── ConflictRenderer   — merge conflict/gate-failed; Resolver + Ver Processos + Abrir card
//               └── GovernanceRenderer — owner:human field proposals; Aprovar / Rejeitar (story-w9n03r)

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { sharedEventSource } from "@/lib/sse-bus";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  COCKPIT_GROUP_LABEL,
  COCKPIT_GROUP_ORDER,
  type ApprovalCockpitItem,
  type DeployFailedCockpitItem,
  type GateCockpitItem,
  type BlockerCockpitItem,
  type FindingCockpitItem,
  type CockpitGroup,
  type CockpitItem,
  type CockpitItemKind,
  type ConflictCockpitItem,
  type DesignCockpitItem,
  type GovernanceCockpitItem,
  type ProposalCockpitItem,
  type QuestionCockpitItem,
  type ReviewCockpitItem,
  type StuckCockpitItem,
  type DeployUnsettledCockpitItem,
  type ReleaseAgingCockpitItem,
  type MergeFailedCockpitItem,
} from "@/lib/storymap/demands";
import type {
  BoardConfig,
  BoardSummary,
  Card,
  CanvasBlock,
  CanvasTag,
  FindingSeverity,
  GovernanceChange,
} from "@/lib/storymap/types";
import { blockToReviewText } from "@/lib/storymap/canvas";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";
import {
  applyReanchor,
  cascadeSelect,
  effectiveSelectedCount,
  selectAll,
  type ReanchorPatch,
} from "@/lib/storymap/smart-capture/proposal-tree";
import { ProposalTree } from "@/components/ProposalTree";
import { moveTargets } from "@/lib/storymap/move-targets";
import { BoardHeader } from "@/components/BoardHeader";
import { DesignCanvas } from "@/components/wireframe/DesignCanvas";
import { unresolvedChanges } from "@/lib/storymap/design-canvas";
import { SystemDriftPanel } from "@/components/SystemDriftPanel";
import { ToastProvider, useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { prettyCanonicalArgs, quickActionsFor, QUICK_ACTIONS_OF, type QuickActionSet } from "@/lib/storymap/quick-actions";
import { escalationRefFor, type EscalationRef } from "@/lib/storymap/copilot/escalation";
import { dejargonText, lensLabel } from "@/lib/storymap/copilot/dejargon";
import { cardHref, processesMergeHref } from "@/lib/storymap/deep-links";
import { QuickActionButton } from "@/components/QuickActionButton";
import { COCKPIT_DEMAND_LABEL, cockpitItemShowsStatus } from "@/components/inicio/cockpit-labels";
import { EscalateButton } from "@/components/copilot/EscalateButton";
import {
  acceptProposalAction,
  answerQuestionAction,
  approveActionRequestAction,
  approveGovernanceDraftAction,
  chooseWireframeAction,
  deleteCardAction,
  submitDesignFeedbackAction,
  getDeployFailureLogAction,
  moveCardAction,
  rejectActionRequestAction,
  refineProposalAction,
  rejectGovernanceDraftAction,
  requestDesignChangeAction,
} from "@/app/actions";
import { rearmCopilotItemAction } from "@/app/copilot-actions";
import { cn } from "@/lib/cn";
import {
  ALL_OR_NOTHING_NOTE,
  summarizeAnalysis,
  type EntryResolutionAnalysis,
  type VerdictKind,
} from "@/lib/storymap/resolution-analysis";

// ── Lane visuals ──────────────────────────────────────────────────────────────
const LANE_DOT: Record<CockpitGroup, string> = {
  travado: "bg-rose-500",
  pergunta: "bg-amber-400",
  aprovar: "bg-emerald-500",
};

const LANE_LABEL_COLOR: Record<CockpitGroup, string> = {
  travado: "text-rose-600 dark:text-rose-400",
  pergunta: "text-amber-700 dark:text-amber-400",
  aprovar: "text-emerald-700 dark:text-emerald-400",
};

// ── Renderer context ──────────────────────────────────────────────────────────
interface RendererCtx {
  boardId: string;
  config: BoardConfig;
  card: Card | undefined;
  /** all board cards by id — resolves proposal anchors + addresses/serves targets to titles. */
  cardsById: Map<string, Card>;
  onOpenCard: (cardId: string) => void;
  /** optimistic local removal after a delete (the server `items` refetch removes the row). */
  onDeleted: (cardId: string) => void;
}

// ── KIND REGISTRY — add a kind = add one renderer function here ──────────────
// Each renderer receives the typed item + ctx (boardId, config, card, onOpenCard).
// Renderers are responsible only for their kind; they share NO state with each other.
const KIND_RENDERER: Record<CockpitItemKind, (item: CockpitItem, ctx: RendererCtx) => React.ReactNode> = {
  question:  (item, ctx) => <QuestionRenderer  item={item as QuestionCockpitItem}  ctx={ctx} />,
  blocker:   (item, ctx) => <BlockerRenderer   item={item as BlockerCockpitItem}   ctx={ctx} />,
  finding:   (item, ctx) => <FindingRenderer   item={item as FindingCockpitItem}   ctx={ctx} />,
  "deploy-failed": (item, ctx) => <DeployFailedRenderer item={item as DeployFailedCockpitItem} ctx={ctx} />,
  // F8 — `gate` (o card espera VOCÊ empurrar) e `approval` (o Jido espera VOCÊ decidir) são kinds
  // distintos desde a F8. WS-3 §3.3 extraiu o corpo comum (gateLabel + Aprovar&avançar/Devolver) para
  // GateRenderer; ApprovalRenderer trata SÓ o pedido `apr:` do Jido e delega o fallback
  // `<cardId>:data-deletion` (kind `approval`, sem prefixo `apr:`) ao mesmo GateRenderer.
  gate:      (item, ctx) => <GateRenderer      item={item as GateCockpitItem}      ctx={ctx} />,
  approval:  (item, ctx) => <ApprovalRenderer  item={item as ApprovalCockpitItem}  ctx={ctx} />,
  review:    (item, ctx) => <ReviewRenderer    item={item as ReviewCockpitItem}    ctx={ctx} />,
  stuck:     (item, ctx) => <StuckRenderer     item={item as StuckCockpitItem}     ctx={ctx} />,
  conflict:  (item, ctx) => <ConflictRenderer  item={item as ConflictCockpitItem}  ctx={ctx} />,
  proposal:   (item, ctx) => <ProposalRenderer   item={item as ProposalCockpitItem}   ctx={ctx} />,
  design:     (item, ctx) => <DesignRenderer     item={item as DesignCockpitItem}     ctx={ctx} />,
  governance: (item, ctx) => <GovernanceRenderer item={item as GovernanceCockpitItem} ctx={ctx} />,
  // WS-5 (D9) — the 3 new kinds (deploy-unsettled/release-aging/merge-failed) join the exhaustive Record.
  "deploy-unsettled": (item, ctx) => <DeployUnsettledRenderer item={item as DeployUnsettledCockpitItem} ctx={ctx} />,
  "release-aging": (item, ctx) => <ReleaseAgingRenderer item={item as ReleaseAgingCockpitItem} ctx={ctx} />,
  "merge-failed": (item, ctx) => <MergeFailedRenderer item={item as MergeFailedCockpitItem} ctx={ctx} />,
};

// ── Shell: ToastProvider wrapper ──────────────────────────────────────────────
// Os toasts de ação precisam disto; mesmo padrão do KanbanBoard.
export function CockpitView({
  boards,
  config,
  boardId,
  items,
  cards,
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  boardId: string;
  /** a lista INTEIRA. Esta tela nunca filtra: a marca de visto do carrossel da home não chega aqui. */
  items: CockpitItem[];
  cards: Card[];
}) {
  return (
    <ToastProvider>
      <CockpitViewInner
        boards={boards}
        config={config}
        boardId={boardId}
        items={items}
        cards={cards}
      />
    </ToastProvider>
  );
}

// ── Inner view: state, SSE, modal, lane grouping ──────────────────────────────
function CockpitViewInner({
  boards,
  config,
  boardId,
  items,
  cards,
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  boardId: string;
  items: CockpitItem[];
  cards: Card[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusCardId = searchParams.get("focus");

  const [localCards, setLocalCards] = useState<Card[]>(cards);

  // Deep-link focus: ?focus=<cardId> scrolls to + temporarily rings the FIRST item of that card.
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);

  // Keep local card list in sync when server re-renders
  useEffect(() => { setLocalCards(cards); }, [cards]);

  // Q5 — memoizado: o handler SSE dispara router.refresh() em alta frequência e localCards carrega
  // TODOS os cards do board; reconstruir a Map a cada render era O(N) desnecessário. Ninguém muta a Map.
  const cardsById = useMemo(() => new Map(localCards.map((c) => [c.id, c])), [localCards]);

  // Abrir um card NAVEGA para a página dele — o Inbox abria uma gaveta que era uma segunda
  // superfície de detalhe, com estado próprio, sem URL e sem Voltar. A página é a única superfície
  // de card do app, e o Voltar (useHistoryBack) devolve a este Inbox, na posição em que ele estava.
  const openCardPage = useCallback(
    (cardId: string) => router.push(cardHref(boardId, cardId)),
    [router, boardId],
  );

  const handleDeleted = useCallback((id: string) => {
    setLocalCards((cs) => cs.filter((x) => x.id !== id));
  }, []);

  // SSE live refresh — any card mutation (ask/answer/move/finding) may change the inbox
  useEffect(() => {
    const es = sharedEventSource("/api/notifications/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(t); t = setTimeout(() => router.refresh(), 300); };
    es.addEventListener("agileharness", refresh as EventListener);
    return () => { clearTimeout(t); es.close(); };
  }, [router]);

  // Group items by lane preserving COCKPIT_GROUP_ORDER (travado → pergunta → aprovar)
  const byLane = new Map<string, CockpitItem[]>();
  for (const item of items) {
    const bucket = byLane.get(item.lane) ?? [];
    bucket.push(item);
    byLane.set(item.lane, bucket);
  }
  const visibleLanes = COCKPIT_GROUP_ORDER.filter((g) => (byLane.get(g)?.length ?? 0) > 0);
  const total = items.length;

  // Deep-link: when ?focus=<cardId> matches an item, scroll it into view + ring it for ~2s.
  const focusTargetId = focusCardId ? items.find((it) => it.cardId === focusCardId)?.id ?? null : null;
  useEffect(() => {
    if (!focusTargetId) return;
    const el = rowRefs.current.get(focusTargetId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFocusedItemId(focusTargetId);
    const t = setTimeout(() => setFocusedItemId(null), 2000);
    return () => clearTimeout(t);
  }, [focusTargetId]);

  return (
    <div className="flex h-screen flex-col">
      <BoardHeader boards={boards} config={config} view="inbox" />

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6 pb-24 sm:p-10 md:pb-10">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Inbox</h1>
          <p className="mt-0.5 text-sm text-fg-muted">
            {total > 0
              ? `${total} pendência${total === 1 ? "" : "s"} aguardando você neste board.`
              : "Nada precisa de você neste board agora. Os agentes seguem sozinhos."}
          </p>
        </header>

        {/* Drift dos sistemas — detecção automática, sincronização sob 1 clique (story system-resync).
            Independente do inbox de cards: aparece quando o código de um sistema mudou desde o último
            sync, some quando tudo está sincronizado. */}
        <SystemDriftPanel boardId={boardId} />

        {total === 0 ? (
          <p className="rounded-md border border-line bg-surface p-6 text-center text-sm text-fg-muted">
            Quando um agente levantar uma incógnita, deixar um bloqueio de revisão, ou um card chegar
            a uma parada humana (aprovar design, publicar, resolver conflito), aparece aqui.
          </p>
        ) : (
          <div className="space-y-8">
            {visibleLanes.map((lane) => {
              const laneItems = byLane.get(lane) ?? [];
              return (
                <section key={lane}>
                  <h2 className="mb-3 flex items-center gap-2">
                    <span
                      className={cn("h-2 w-2 shrink-0 rounded-full", LANE_DOT[lane])}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "text-[11px] font-semibold uppercase tracking-wide",
                        LANE_LABEL_COLOR[lane],
                      )}
                    >
                      {COCKPIT_GROUP_LABEL[lane]}
                    </span>
                    <span className="text-[11px] text-fg-subtle">· {laneItems.length}</span>
                  </h2>

                  <ul className="space-y-3">
                    {laneItems.map((item) => (
                      <CockpitItemRow
                        key={item.id}
                        item={item}
                        focused={focusedItemId === item.id}
                        registerRef={(el) => {
                          if (el) rowRefs.current.set(item.id, el);
                          else rowRefs.current.delete(item.id);
                        }}
                        ctx={{
                          boardId,
                          config,
                          card: cardsById.get(item.cardId),
                          cardsById,
                          onOpenCard: openCardPage,
                          onDeleted: handleDeleted,
                        }}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </main>

    </div>
  );
}

// ── Shared row shell ──────────────────────────────────────────────────────────
// Card-header (title + status chip + id) + renderer body. Stub kinds return null → no shell.

function CockpitItemRow({
  item,
  ctx,
  focused = false,
  registerRef,
  bare = false,
}: {
  item: CockpitItem;
  ctx: RendererCtx;
  focused?: boolean;
  registerRef?: (el: HTMLLIElement | null) => void;
  /** ver {@link CockpitItemDetail} — sem cabeçalho e sem moldura (o cartão de papel do Inbox). */
  bare?: boolean;
}) {
  const statusName = ctx.config.statuses.find((s) => s.id === item.status)?.name ?? null;
  // A régua de "o status diz algo?" mora em cockpit-labels (era um `kind !== "proposal"` à mão aqui,
  // e as outras superfícies não a conheciam).
  const showStatus = cockpitItemShowsStatus(item);
  const body = KIND_RENDERER[item.kind](item, ctx);
  if (body === null) return null;

  if (bare) return <li ref={registerRef}>{body}</li>;

  return (
    <li
      ref={registerRef}
      className={cn(
        "overflow-hidden rounded-md border border-line bg-surface transition-shadow",
        focused && "ring-2 ring-accent",
      )}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-hover px-3 py-2">
        {/* Proposta de captura: cabeçalho LIMPO — o prompt cru não é título, e o status interno
            (CAPTURANDO) + o id do container efêmero são ruído. O conteúdo vem no summary do corpo. */}
        {item.kind === "proposal" ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg">
              <span aria-hidden>💡</span> {COCKPIT_DEMAND_LABEL.proposal}
            </span>
            <DeleteProposalButton boardId={ctx.boardId} cardId={item.cardId} onDeleted={ctx.onDeleted} />
          </>
        ) : item.cardId ? (
          <button
            type="button"
            onClick={() => ctx.onOpenCard(item.cardId)}
            className="text-[13px] font-medium text-fg transition hover:text-accent"
            title="Abrir card"
          >
            {item.cardTitle}
          </button>
        ) : (
          <span className="text-[13px] font-medium text-fg">{item.cardTitle}</span>
        )}
        {showStatus && statusName && (
          <>
            <span className="text-[11px] text-fg-subtle">·</span>
            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
              {statusName}
            </span>
          </>
        )}
        {/* WS-12.2 (D16) — o Jido DESISTIU deste item: o chip torna explícita a divisão de trabalho ("este
            agora é seu") e oferece o re-arm de 1 clique. Sem ele, o item só ficava aqui parado — visível, mas
            sem nada dizendo que ninguém mais viria buscá-lo (a desistência invisível da colisão #7). */}
        {item.copilotBackoff && (
          <CopilotBackoffChip boardId={ctx.boardId} itemId={item.id} streak={item.copilotBackoff.streak} />
        )}
        {item.kind !== "proposal" && item.cardId && (
          <span className="ml-auto font-mono text-[10px] text-fg-subtle">{item.cardId}</span>
        )}
      </header>

      <div className="px-3 py-3">{body}</div>
    </li>
  );
}

/**
 * ONE cockpit item as a STANDALONE detail — the body of o Inbox item's dedicated page (Início
 * Agêntico — item individual). It reuses the EXACT per-kind renderer + its inline actions
 * (answer/approve/resolve/…), wired to the same server actions, inside the ToastProvider they need and
 * a self-refresh on the shared SSE. After an action resolves the item, `router.refresh()` re-runs the
 * page's RSC; when the item is gone the page renders its "resolvido" state. Kept in THIS file so it can
 * reach the module-private KIND_RENDERER / CockpitItemRow — the same reason the cockpit lives here.
 */
export function CockpitItemDetail({
  config,
  boardId,
  item,
  cards,
  bare = false,
}: {
  config: BoardConfig;
  boardId: string;
  item: CockpitItem;
  cards: Card[];
  /** `true` = só o CORPO do kind (sem o cabeçalho título/status/id, sem moldura). É o modo que o
   *  cartão de papel do Inbox usa: a folha JÁ escreveu o título e o id — repeti-los dentro dela
   *  daria dois títulos e dois botões "Pular" na mesma folha. */
  bare?: boolean;
}) {
  return (
    <ToastProvider>
      <CockpitItemDetailInner config={config} boardId={boardId} item={item} cards={cards} bare={bare} />
    </ToastProvider>
  );
}

function CockpitItemDetailInner({
  config,
  boardId,
  item,
  cards,
  bare,
}: {
  config: BoardConfig;
  boardId: string;
  item: CockpitItem;
  cards: Card[];
  bare: boolean;
}) {
  const router = useRouter();

  // Same shared-SSE live refresh as CockpitViewInner — an action here (or elsewhere) that mutates the
  // card re-runs the page RSC, which re-resolves (or drops) this item.
  useEffect(() => {
    const es = sharedEventSource("/api/notifications/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(t);
      t = setTimeout(() => router.refresh(), 300);
    };
    es.addEventListener("agileharness", refresh as EventListener);
    return () => {
      clearTimeout(t);
      es.close();
    };
  }, [router]);

  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const ctx: RendererCtx = {
    boardId,
    config,
    card: item.cardId ? cardsById.get(item.cardId) : undefined,
    cardsById,
    // On this dedicated page "abrir card" navigates to the card page; a delete returns to the cockpit.
    onOpenCard: (cardId) => router.push(`/board/${boardId}/card/${cardId}`),
    onDeleted: () => router.push(`/board/${boardId}/inbox`),
  };

  return (
    <ul className="space-y-3">
      <CockpitItemRow item={item} ctx={ctx} bare={bare} />
    </ul>
  );
}

/** WS-12.2/12.3 (D16) — "o Jido desistiu deste item" + o re-arm de 1 clique (a saída HUMANA do backoff
 *  por-item). O chip diz o FATO (quantas tentativas sem progresso) em vez de deixar o item parado sem dono
 *  aparente; o botão limpa o streak e o próximo ciclo volta a tentar. O router.refresh() re-lê os items do
 *  servidor, então o chip some sozinho quando o streak é zerado. */
function CopilotBackoffChip({ boardId, itemId, streak }: { boardId: string; itemId: string; streak: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const rearm = async () => {
    setBusy(true);
    const res = await rearmCopilotItemAction({ boardId, itemId });
    setBusy(false);
    if (res.ok) {
      toast("Re-armado — o Jido tenta de novo no próximo ciclo.", "success");
      router.refresh();
    } else {
      toast(res.error ?? "Não consegui re-armar este item.");
    }
  };

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
      title={`O copiloto autônomo tentou ${streak}× sem progresso e parou de re-tentar este item — ele é seu. Re-armar faz o próximo ciclo tentar de novo.`}
    >
      <span aria-hidden>🤖</span>
      <span className="font-medium">copiloto desistiu · {streak} tentativas</span>
      <button
        type="button"
        onClick={rearm}
        disabled={busy}
        className="rounded px-1 font-semibold underline underline-offset-2 transition hover:text-amber-900 disabled:opacity-50 dark:hover:text-amber-200"
      >
        {busy ? "Re-armando…" : "Re-armar"}
      </button>
    </span>
  );
}

/** Excluir uma proposta de captura (container efêmero + sidecar) — confirmação inline em 2 toques.
 *  A linha some no refetch de `items` (router.refresh); onDeleted faz a remoção otimista local. */
function DeleteProposalButton({
  boardId,
  cardId,
  onDeleted,
}: {
  boardId: string;
  cardId: string;
  onDeleted: (cardId: string) => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const del = async () => {
    setBusy(true);
    const res = await deleteCardAction({ boardId, cardId });
    setBusy(false);
    if (res.ok) {
      onDeleted(cardId);
      router.refresh();
    } else {
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle transition hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
        title="Excluir esta proposta"
      >
        <span aria-hidden>🗑</span> Excluir
      </button>
    );
  }
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]">
      <span className="text-fg-muted">Excluir esta proposta?</span>
      <button
        type="button"
        onClick={del}
        disabled={busy}
        className="rounded bg-red-600 px-2 py-0.5 font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
      >
        {busy ? "Excluindo…" : "Excluir"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="rounded px-2 py-0.5 font-medium text-fg-subtle transition hover:bg-surface hover:text-fg disabled:opacity-50"
      >
        Cancelar
      </button>
    </span>
  );
}

// ── A GRAMÁTICA ÚNICA DE AÇÃO ─────────────────────────────────────────────────
//
// As duas classes que um botão de renderer usa quando a ação NÃO é uma quick-action serializável (um
// submit de formulário inline). Casam altura e peso com o <QuickActionButton> (md = h-8 / sm = h-7),
// para que a fileira saia da mesma régua vertical venha o botão de onde vier.
//
// Todo item do Inbox termina na MESMA fileira, na MESMA ordem, com os MESMOS pesos:
//
//     [ AÇÃO PRINCIPAL ] [ alternativas ] [ afordâncias do kind ] [ Abrir card ] [ Jido ]
//       ^ md, tom cheio    ^ sm, discretas   ^ sm (ver log/processos)  ^ leitura   ^ HITL
//
// Antes cada um dos 15 renderers montava a própria fileira à mão: mesmo `flex flex-wrap gap-2`, mas com
// ordens diferentes (num deles o Jido vinha ANTES do primário), pesos iguais entre decidir e só olhar, e
// o "Abrir card" ora primeiro ora último. Para quem despacha a pilha item a item isso custa uma releitura
// por folha — o olho não pode aprender onde fica a decisão se ela muda de lugar. Aqui ela é sempre a
// PRIMEIRA e a única com peso de botão cheio; ler (Abrir card) e delegar (Jido) ficam no fim, discretos.
//
// `lead` é a ação principal PRÓPRIA do renderer — o submit de um formulário inline (Responder, Criar N
// cards, Aprovar design), que não é uma quick-action serializável. Quando existe, ele OCUPA o lugar do
// primário; o registry então só contribui secundárias.
const PRIMARY_BTN =
  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md bg-primary px-3 text-[13px] font-medium text-primary-fg transition enabled:hover:bg-primary-hover disabled:opacity-40";
const SECONDARY_BTN =
  "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md border border-line px-2 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-40";

function ItemActions({
  ctx,
  cardId,
  qa,
  escRef,
  lead,
  trail,
  openCard = true,
  openCardLabel = "Abrir card",
  openCardTitle = "Abre o card completo — narrativa, critérios de aceite, tarefas e detalhes — para ler ou editar. Não decide nada.",
}: {
  ctx: RendererCtx;
  cardId?: string;
  /** o conjunto do registry (quick-actions.ts). Omita quando o kind não tem nenhuma. */
  qa?: QuickActionSet;
  escRef?: EscalationRef | null;
  /** a ação principal própria do renderer (formulário inline) — entra ANTES de tudo. */
  lead?: React.ReactNode;
  /** afordâncias específicas do kind (Ver log, Ver processos, …) — depois das alternativas. */
  trail?: React.ReactNode;
  /** `false` em item sem card (governança) — não há o que abrir. */
  openCard?: boolean;
  openCardLabel?: string;
  openCardTitle?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {lead}
      {qa?.primary && (
        <QuickActionButton
          boardId={ctx.boardId}
          cardId={cardId}
          action={qa.primary}
          surface="inbox"
          size="md"
          withDestination
        />
      )}
      {qa?.secondary.map((a) => (
        <QuickActionButton
          key={a.id}
          boardId={ctx.boardId}
          cardId={cardId}
          action={a}
          surface="inbox"
          withDestination
          subdued
        />
      ))}
      {trail}
      {openCard && cardId && (
        <button
          type="button"
          onClick={() => ctx.onOpenCard(cardId)}
          title={openCardTitle}
          className={SECONDARY_BTN}
        >
          {openCardLabel}
        </button>
      )}
      {escRef && <EscalateButton target={escRef} surface="inbox" />}
    </div>
  );
}

// ── RENDERER: question ────────────────────────────────────────────────────────
// Prompt + structured options (radio/checkbox) + free textarea.
// ⌘/Ctrl+Enter submits. Refreshes via router.refresh() on success.
// NO advance/console/run actions — questions are NOT gates.

function QuestionRenderer({ item, ctx }: { item: QuestionCockpitItem; ctx: RendererCtx }) {
  const router = useRouter();
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const hasOptions = item.options.length > 0;
  const canSubmit = answer.trim().length > 0 || selectedIds.length > 0;
  const escRef = escalationRefFor(item, ctx.boardId); // WS-3 §3.6

  // `context` / `recommendation` live on the card question; cardCockpitItems does not (yet) copy them
  // onto the cockpit item. Read defensively so we surface them the moment the projection does — and
  // render nothing until then (no demands.ts edit; contract mismatch noted in the summary).
  const context = (item as { context?: string }).context;
  const recommendation = (item as { recommendation?: string }).recommendation;

  const toggleOption = (id: string) => {
    if (item.mode === "single") {
      setSelectedIds((prev) => (prev.includes(id) ? [] : [id]));
    } else {
      setSelectedIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    }
  };

  const submit = () => {
    if (!canSubmit || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await answerQuestionAction({
        boardId: ctx.boardId,
        cardId: item.cardId,
        questionId: item.questionId,
        answer: answer.trim(),
        selectedOptionIds: selectedIds.length > 0 ? selectedIds : undefined,
      });
      if (res.ok) {
        setAnswer("");
        setSelectedIds([]);
        router.refresh();
      } else {
        setError(res.error);
        toast(res.error);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="space-y-3">
      {/* Prompt */}
      <div className="flex items-start gap-2">
        <span className="mt-0.5 select-none font-mono text-[11px] text-fg-subtle">{item.questionId}</span>
        <p className="flex-1 text-[13px] leading-snug text-fg">{dejargonText(item.prompt)}</p>
      </div>

      {/* Por quê — the stakes/context that help the human decide (when the agent provided it) */}
      {context && (
        <p className="pl-7 text-[12px] leading-snug text-fg-muted">
          <span className="font-medium text-fg-subtle">Por quê:</span> {dejargonText(context)}
        </p>
      )}

      {/* Asked-by / timestamp */}
      {(item.askedBy || item.since) && (
        <p className="pl-7 text-[10px] text-fg-subtle">
          {item.askedBy && <span className="font-medium">{item.askedBy}</span>}
          {item.askedBy && item.since && " · "}
          {item.since}
        </p>
      )}

      {/* Structured options: radio (single) or checkbox (multi), each with pros/cons + recommended badge */}
      {hasOptions && (
        <fieldset className="pl-7 space-y-1.5">
          <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            {item.mode === "multi" ? "Selecione uma ou mais" : "Selecione uma opção"}
          </legend>
          {item.options.map((opt) => {
            const checked = selectedIds.includes(opt.id);
            const hasDetail = (opt.pros?.length ?? 0) > 0 || (opt.cons?.length ?? 0) > 0;
            return (
              <label
                key={opt.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-[13px] transition select-none",
                  checked
                    ? "border-accent/50 bg-accent/8 text-fg"
                    : "border-line bg-inset text-fg-muted hover:border-line-emphasis hover:text-fg",
                )}
              >
                <input
                  type={item.mode === "multi" ? "checkbox" : "radio"}
                  name={`q-${item.questionId}`}
                  value={opt.id}
                  checked={checked}
                  onChange={() => toggleOption(opt.id)}
                  className="accent-accent mt-0.5 shrink-0"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span>{opt.label}</span>
                    {opt.recommended && (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                        ★ recomendado
                      </span>
                    )}
                  </span>
                  {hasDetail && (
                    <span className="mt-1 block space-y-0.5">
                      {opt.pros?.map((p, i) => (
                        <span key={`p${i}`} className="flex gap-1 text-[11px] leading-snug text-emerald-700 dark:text-emerald-400">
                          <span aria-hidden>+</span>
                          <span className="flex-1">{p}</span>
                        </span>
                      ))}
                      {opt.cons?.map((c, i) => (
                        <span key={`c${i}`} className="flex gap-1 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                          <span aria-hidden>−</span>
                          <span className="flex-1">{c}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {/* Free-text questions: the agent's prose suggestion (when there are no discrete options) */}
      {recommendation && (
        <p className="pl-7 text-[12px] leading-snug text-fg-subtle">
          <span className="font-medium">Sugestão do agente:</span> {dejargonText(recommendation)}
        </p>
      )}

      {/* Free-text answer — always available regardless of options */}
      <div className="pl-7">
        <textarea
          ref={taRef}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={
            hasOptions
              ? "Adicione contexto ou instrua o agente… (⌘/Ctrl+Enter)"
              : "Responda ou instrua o agente… (⌘/Ctrl+Enter)"
          }
          className="w-full resize-y rounded-md border border-line bg-inset px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
        <div className="mt-1.5">
          <ItemActions
            ctx={ctx}
            cardId={item.cardId}
            escRef={escRef}
            lead={
              <button
                onClick={submit}
                disabled={pending || !canSubmit}
                title="Envia sua resposta ao agente. A automação do card destrava e segue com a sua decisão."
                className={PRIMARY_BTN}
              >
                {pending ? "Enviando…" : "Responder"}
              </button>
            }
            trail={error ? <span className="text-[11px] text-rose-600 dark:text-rose-300">{error}</span> : undefined}
          />
        </div>
      </div>
    </div>
  );
}

// ── RENDERER: finding (aviso non-blocker) ─────────────────────────────────────
// O par do BlockerRenderer para um aviso ABERTO. Mesma FORMA (título · lens/sugestão · ações do registry),
// duas diferenças que são o ponto do kind: a severity aparece (um `low` e um `high` não pedem a mesma
// atenção) e o primário é "Registrar como conhecido", não "Marcar resolvido" — ver QUICK_ACTIONS_OF.finding.

const FINDING_SEV_LABEL: Record<Exclude<FindingSeverity, "blocker">, string> = {
  high: "alta",
  medium: "média",
  low: "baixa",
};

function FindingRenderer({ item, ctx }: { item: FindingCockpitItem; ctx: RendererCtx }) {
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);

  return (
    <div className="space-y-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-fg-subtle">
          {FINDING_SEV_LABEL[item.findingSeverity]}
        </span>
        <p className="text-[13px] font-medium text-fg">{dejargonText(item.title)}</p>
      </div>

      {(item.lens || item.suggestion) && (
        <div className="space-y-1 rounded-md border border-line bg-inset px-2.5 py-2 text-[12px] text-fg-muted">
          {item.lens && (
            <p>
              <span className="font-medium text-fg-subtle">Área:</span> {lensLabel(item.lens)}
            </p>
          )}
          {item.suggestion && (
            <p>
              <span className="font-medium text-fg-subtle">Sugestão:</span> {dejargonText(item.suggestion)}
            </p>
          )}
        </div>
      )}

      <ItemActions ctx={ctx} cardId={item.cardId} qa={qa} escRef={escRef} />
    </div>
  );
}

// ── RENDERER: blocker ─────────────────────────────────────────────────────────
// Open code-review blocker finding. Actions: Resolver (fixed) / Não corrigir (wontfix) / Abrir card.
// Clearing the last blocker satisfies hasNoBlockers automatically — no manual advance needed.

function BlockerRenderer({ item, ctx }: { item: BlockerCockpitItem; ctx: RendererCtx }) {
  // WS-3 §3.1/§3.6 — Resolver/Não corrigir migram pro registry (Marcar resolvido = qa.primary, Não
  // corrigir = qa.secondary); title/lens/suggestion (FORM/CONTEÚDO) ficam byte-idênticos.
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-medium text-fg">{dejargonText(item.title)}</p>

      {(item.lens || item.suggestion) && (
        <div className="space-y-1 rounded-md border border-line bg-inset px-2.5 py-2 text-[12px] text-fg-muted">
          {item.lens && (
            <p>
              <span className="font-medium text-fg-subtle">Área:</span> {lensLabel(item.lens)}
            </p>
          )}
          {item.suggestion && (
            <p>
              <span className="font-medium text-fg-subtle">Sugestão:</span> {dejargonText(item.suggestion)}
            </p>
          )}
        </div>
      )}

      <ItemActions ctx={ctx} cardId={item.cardId} qa={qa} escRef={escRef} />
    </div>
  );
}

// ── RENDERER: approval ────────────────────────────────────────────────────────
// Post-work human gate: the automation produced work and waits the operator's OK to advance.
// Action: Aprovar & avançar (moveCardAction to the recommended next status) + Abrir card.
// This is the ONLY place in the cockpit where an advance action is correct and expected.

/**
 * F8 — 🔴 O PUBLISH DE PRODUÇÃO FALHOU. O card foi revertido para "Liberar" e o código NÃO está no ar. Antes
 * disto, esta falha não tinha superfície alguma no cockpit (o finding era `high`, e todo o alarme do AgileHarness
 * se apoiava em `blocker`): o card revertido aparecia na lane VERDE, com o rótulo "Liberar", idêntico a um card
 * saudável esperando publicação. Este renderer existe para que a lane vermelha diga a verdade.
 *
 * NÃO oferece "Resolver" (como o BlockerRenderer): marcar o finding como resolvido sem re-publicar apagaria o
 * alarme e deixaria o card mentindo de novo. A saída é UMA — reentrar no Deploy — e é ela que o botão oferece.
 */
function DeployFailedRenderer({ item, ctx }: { item: DeployFailedCockpitItem; ctx: RendererCtx }) {
  // WS-3 §3.4 (risco 5) — "Re-publicar" vem do registry (moveCardAction real p/ o step
  // promote-and-deploy, travado sob deployFiredAt). Board sem esse step → primary null →
  // degrada para o botão de sempre (a única saída nunca some). NEVER updateFindingStatusAction
  // aqui (risco 7) — o finding só se resolve pelo settle do webhook (docstring acima).
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);
  const [logOpen, setLogOpen] = useState(false);
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-medium text-fg">{dejargonText(item.title)}</p>
      {item.suggestion && (
        <div className="rounded-md border border-line bg-inset px-2.5 py-2 text-[12px] text-fg-muted">
          <span className="font-medium text-fg-subtle">Sugestão:</span> {dejargonText(item.suggestion)}
        </div>
      )}
      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        qa={qa}
        escRef={escRef}
        // Board sem step promote-and-deploy ⇒ sem primária no registry: a saída degrada para abrir o card,
        // e é ELA que assume o peso de ação principal (a única saída nunca some).
        lead={
          qa.primary ? undefined : (
            <button
              type="button"
              onClick={() => ctx.onOpenCard(item.cardId)}
              title="Abre o card para você reenviar a publicação — o código está pronto mas não está no ar."
              className={PRIMARY_BTN}
            >
              Abrir card e reentrar no Deploy
            </button>
          )
        }
        openCard={Boolean(qa.primary)}
        /* WS-3 §3.2 (triste) — read-only: fetches the decoded finding + self-deploy.log tail; NEVER marks
           the finding resolved (that stays the settle webhook's job — see the docstring above). */
        trail={
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            title="Mostra o log da falha (só leitura) para você entender por que a publicação não foi ao ar."
            className={SECONDARY_BTN}
          >
            Ver log
          </button>
        }
      />
      {logOpen && (
        <DeployFailureLogModal boardId={ctx.boardId} cardId={item.cardId} onClose={() => setLogOpen(false)} />
      )}
    </div>
  );
}

/**
 * WS-3 §3.2 — read-only modal (overlay pattern of ConfirmDialog) showing the deploy-failure evidence:
 * the decoded finding + the self-deploy.log tail. Fetches lazily on mount (only while open). Zero
 * mutation — never passes through the QuickActionButton dispatcher, never generates a D7 audit entry.
 */
function DeployFailureLogModal({
  boardId,
  cardId,
  onClose,
}: {
  boardId: string;
  cardId: string;
  onClose: () => void;
}) {
  type LogState =
    | { status: "loading" }
    | { status: "error"; error: string }
    | {
        status: "ok";
        findingTitle: string | null;
        findingDetail: string | null;
        selfDeployLogTail: string | null;
        logPath: string;
      };
  const [state, setState] = useState<LogState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getDeployFailureLogAction({ boardId, cardId });
      if (cancelled) return;
      if (res.ok && res.data) {
        setState({
          status: "ok",
          findingTitle: res.data.findingTitle,
          findingDetail: res.data.findingDetail,
          selfDeployLogTail: res.data.selfDeployLogTail,
          logPath: res.data.logPath,
        });
      } else {
        setState({ status: "error", error: !res.ok ? res.error : "Falha ao carregar o log." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, cardId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = () => {
    if (state.status !== "ok") return;
    const text = [
      state.findingTitle ? `Finding: ${state.findingTitle}\n${state.findingDetail ?? ""}` : "",
      state.selfDeployLogTail ? `\nself-deploy.log (tail):\n${state.selfDeployLogTail}` : "",
      `\n${state.logPath}`,
    ].join("\n");
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-line bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold text-fg">Log da falha de deploy</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover"
          >
            Fechar
          </button>
        </div>

        {state.status === "loading" && <p className="text-[12px] text-fg-muted">Carregando…</p>}
        {state.status === "error" && <p className="text-[12px] text-rose-600 dark:text-rose-400">{state.error}</p>}
        {state.status === "ok" && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">Finding</p>
              {state.findingTitle ? (
                <>
                  <p className="text-[13px] font-medium text-fg">{state.findingTitle}</p>
                  {state.findingDetail && (
                    <pre className="mt-1 max-h-56 overflow-auto rounded-md border border-line bg-inset px-2.5 py-2 font-mono text-[11px] leading-snug text-fg-muted">
                      {state.findingDetail}
                    </pre>
                  )}
                </>
              ) : (
                <p className="text-[12px] text-fg-subtle">Nenhum finding deploy-failure aberto.</p>
              )}
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">self-deploy.log (tail)</p>
              {state.selfDeployLogTail ? (
                <pre className="max-h-56 overflow-auto rounded-md border border-line bg-inset px-2.5 py-2 font-mono text-[11px] leading-snug text-fg-muted">
                  {state.selfDeployLogTail}
                </pre>
              ) : (
                <p className="text-[12px] text-fg-subtle">Log indisponível ({state.logPath}).</p>
              )}
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-fg-subtle">{state.logPath}</p>
              <button
                type="button"
                onClick={copy}
                className="rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                Copiar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalRenderer({ item, ctx }: { item: ApprovalCockpitItem; ctx: RendererCtx }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmingApprove, setConfirmingApprove] = useState(false);

  // F5.4/5.8 — an action-approval REQUEST from the autonomous copiloto (id `apr:<id>`): the decision is
  // GRANT/REJECT the request, NOT advance a card. Distinct from the post-work gate below (which advances).
  const approvalReqId = item.id.startsWith("apr:") ? item.id.slice(4) : null;
  if (!approvalReqId) {
    // WS-3 §3.3 — the `<cardId>:data-deletion` fallback (no `apr:` prefix, story-ql5mjm): the retire
    // wipe approval is a plain post-work gate, so it shares the SAME extracted GateRenderer (the real
    // grant/reject for the wipe lives in the drawer, CardRetirement.tsx → approveDataDeletionAction).
    return <GateRenderer item={item} ctx={ctx} />;
  }

  const decide = (grant: boolean) =>
    startTransition(async () => {
      const res = await (grant ? approveActionRequestAction : rejectActionRequestAction)({ boardId: ctx.boardId, approvalId: approvalReqId });
      if (res.ok) {
        toast(grant ? "Ação aprovada — o Jido pode prosseguir." : "Ação rejeitada.", "success");
        router.refresh();
      } else {
        toast(res.error);
      }
    });

  const hasArgs = Boolean(item.args);
  const dangerConfirm = item.riskClass === "deploy" || item.riskClass === "destructive";
  const escRef = escalationRefFor(item, ctx.boardId); // WS-3 §3.6

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] text-fg-muted">
        O copiloto autônomo pede permissão:{" "}
        <span className="font-medium text-fg">{item.gateLabel}</span>
      </p>

      {/* WS-3 §3.5 (D12) — the full canonical args, verbatim: fim da aprovação às cegas. */}
      {item.args && (
        <div className="rounded-md border border-line bg-inset px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-wide text-fg-subtle">
            {item.tool} · {item.riskClass}
            {item.requestedAt ? ` · pedido ${item.requestedAt}` : ""}
          </p>
          <pre className="mt-1 max-h-48 overflow-auto font-mono text-[11px] leading-snug text-fg-muted">
            {prettyCanonicalArgs(item.args)}
          </pre>
          {item.args.length >= 2048 && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400">⚠ args truncados em 2KB na criação.</p>
          )}
        </div>
      )}

      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        escRef={escRef}
        lead={
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirmingApprove(true)}
            title="Autoriza o Jido a executar exatamente esta ação (com estes argumentos). Ele pediu sua permissão antes de agir."
            className={PRIMARY_BTN}
          >
            {pending ? "…" : "Aprovar ação"}
          </button>
        }
        trail={
          <button
            type="button"
            disabled={pending}
            onClick={() => decide(false)}
            title="Nega o pedido — o Jido não executa esta ação e segue sem ela."
            className={SECONDARY_BTN}
          >
            Rejeitar
          </button>
        }
        openCard={Boolean(item.cardId)}
      />

      {/* WS-3 §3.5 (D12) — the confirm REPEATS the args; no grant is decidable without seeing them. An
          item that arrived without args (sidecar vanished between collect and click) fails CLOSED. */}
      {confirmingApprove && (
        <ConfirmDialog
          title={`Aprovar "${item.tool ?? item.gateLabel}"?`}
          description={
            hasArgs
              ? `O grant é 1-shot e vale para EXATAMENTE estes argumentos (byte a byte).${item.expiresAt ? ` Expira ${item.expiresAt}.` : ""}`
              : "(argumentos indisponíveis — abra o board e recarregue antes de aprovar)"
          }
          tone={dangerConfirm ? "danger" : "default"}
          confirmDisabled={pending || !hasArgs}
          onConfirm={() => {
            setConfirmingApprove(false);
            decide(true);
          }}
          onCancel={() => setConfirmingApprove(false)}
        >
          {hasArgs && (
            <pre className="max-h-48 overflow-auto rounded-md border border-line bg-inset px-2.5 py-2 font-mono text-[11px] leading-snug text-fg-muted">
              {prettyCanonicalArgs(item.args!)}
            </pre>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

// ── RENDERER: gate ────────────────────────────────────────────────────────────
// WS-3 §3.3 — extracted from the former non-`apr:` branch of ApprovalRenderer (byte-identical body:
// gateLabel + "Próximo: …"). Actions come DIRECTLY from the registry's `gate` entry
// (QUICK_ACTIONS_OF.gate — NOT the kind-keyed `quickActionsFor` facade): the delegated data-deletion
// fallback carries `item.kind === "approval"`, which the facade would route to the WRONG entry; the
// gate entry itself only reads boardId/cardId/ctx.card, so the cast is safe regardless of caller.
// Aprovar & avançar (feliz) + Devolver (triste, ao step anterior elegível).
//
// O DESTINO mora no BOTÃO (`withDestination`), nunca solto ao lado dele. Este bloco já mostrou três nomes de
// passo ao mesmo tempo — o chip do cabeçalho (onde o card ESTÁ), uma linha "Próximo: …" (para onde o Aprovar
// leva) e uma seta sem legenda (para onde o Devolver leva) — sem nada amarrando cada nome ao botão que o usa.
// A seta era a do Devolver, então lia-se como um avanço INVERTIDO. Agora cada botão diz para onde ele mesmo
// manda ("Aprovar & avançar → Plano & Tarefas"), que é como o merge box do GitHub ("Merge into main") e os
// seletores de status do Linear/Jira resolvem a mesma ambiguidade: um destino, no gatilho que o realiza.

function GateRenderer({ item, ctx }: { item: GateCockpitItem | ApprovalCockpitItem; ctx: RendererCtx }) {
  const qa = QUICK_ACTIONS_OF.gate(item as GateCockpitItem, { config: ctx.config, card: ctx.card });
  const escRef = escalationRefFor(item, ctx.boardId);

  // Num gate de pipeline o `gateLabel` É o nome do passo atual — que o chip do cabeçalho já mostra. Repeti-lo
  // como "Aguardando aprovação: Pronto p/ dev" fazia o passo ATUAL parecer o ALVO da aprovação. Só imprimimos
  // o rótulo quando ele acrescenta algo (ex.: "Aprovar exclusão de dados (irreversível)", do retire).
  const statusName = ctx.config.statuses.find((s) => s.id === item.status)?.name ?? null;
  const extraLabel = item.gateLabel && item.gateLabel !== statusName ? item.gateLabel : null;

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-muted">
        {extraLabel ? (
          <>
            Aguardando sua aprovação: <span className="font-medium text-fg">{extraLabel}</span>
          </>
        ) : (
          <>Este card parou aqui e espera sua aprovação para seguir.</>
        )}
      </p>

      <ItemActions ctx={ctx} cardId={item.cardId} qa={qa} escRef={escRef} />
    </div>
  );
}

// ── RENDERER: review ──────────────────────────────────────────────────────────
// A triagem entrou com POUCA CONFIANÇA no que classificou — o item existe justamente para um humano
// dizer sim ou não. As duas saídas são de 1 clique AQUI: "Aceitar" o põe no fluxo (na raia que o tipo
// pede, impressa no botão) e "Descartar" o manda para a lixeira do board.
//
// Até aqui este renderer dizia "revise e aceite ou rejeite no card" e oferecia só "Abrir card" — mas o
// card não tem aceitar nem rejeitar, e a quick-action do kind era "Abrir no Inbox". Inbox → card →
// Inbox: um laço fechado sobre uma ação de servidor (acceptTriageCardAction) que existia desde a Opção
// B e que só o MCP `accept_triage` sabia chamar. Um agente aceitava; o operador humano, não.

function ReviewRenderer({ item, ctx }: { item: ReviewCockpitItem; ctx: RendererCtx }) {
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] text-fg-muted">
        {qa.primary
          ? "A triagem não teve confiança na classificação — confirme que isto vira trabalho, ou descarte."
          : "Item de triagem com baixa confiança — revise e decida no card."}
      </p>
      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        qa={qa}
        escRef={escRef}
        openCardTitle="Abre o card completo para ler o reporte e, se precisar, corrigir o tipo antes de aceitar."
      />
    </div>
  );
}

// ── RENDERER: stuck ───────────────────────────────────────────────────────────
// A headless run ended in failure. Actions:
//   • Tentar novamente — runCardSkillAction (same engine path as the manual ▶ button on the card)
//   • Abrir card       — a página do card (o operador pode precisar inspecionar/corrigir antes)
// "Ver console" is intentionally omitted: the console is in-memory and survives only for the
// process lifetime; by the time a stuck item surfaces, the console is usually gone. The operator
// can open /processes for live runs.

function StuckRenderer({ item, ctx }: { item: StuckCockpitItem; ctx: RendererCtx }) {
  // WS-3 §3.4 (D15) — "Tentar novamente" vem do registry já rotulado por failureClass (o hint some
  // automaticamente via QuickActionButton); "Ver processos" migra pra secondary (link:processes).
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);

  return (
    <div className="space-y-2.5">
      {/* Failure summary */}
      <p className="text-[13px] text-fg">
        Run falhou:{" "}
        <span className="font-mono text-[12px] text-rose-600 dark:text-rose-400">{item.outcome ?? "erro desconhecido"}</span>
      </p>
      {item.trigger && (
        <p className="text-[11px] text-fg-subtle">
          Skill: <span className="font-medium text-fg-muted">{item.trigger}</span>
        </p>
      )}

      <ItemActions ctx={ctx} cardId={item.cardId} qa={qa} escRef={escRef} />
    </div>
  );
}

// ── WS-10.5 (D14): the semantic ladder's per-hunk analysis ────────────────────
// When the train hits a TEXT divergence it climbs a ladder (convergence → whitespace → LLM judge) BEFORE
// bothering the human. When it escalates, it attaches the judge's per-hunk verdicts to the entry precisely so
// this panel exists: the operator decides holding "hunk X é substantivo PORQUE …", not a `git merge` stderr.
// Every derivation is in the PURE `resolution-analysis` module (unit-tested); this component only paints.
// Rendered ONLY when the entry carries an analysis — absent ⇒ the ladder never climbed, and an empty box here
// would read as "the judge cleared it", which is the one lie this panel must never tell.

const VERDICT_STYLE: Record<VerdictKind, string> = {
  // The operator's own decisions shout; what the machine already vouched for recedes; an unproven verdict is
  // amber — visibly NOT cleared, because an unknown string is doubt, and invariant 6 sends doubt to the human.
  substantive: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  cosmetic: "bg-surface-hover text-fg-muted",
  unknown: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function ResolutionAnalysisPanel({ analysis }: { analysis: EntryResolutionAnalysis }) {
  const s = useMemo(() => summarizeAnalysis(analysis), [analysis]);

  return (
    <div className="rounded-md border border-line bg-surface-hover/40 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Análise do juiz</span>
        <span className="font-mono text-[10px] text-fg-subtle">{s.outcome}</span>
      </div>
      <p className="mt-1 text-[12px] text-fg">{s.detail}</p>

      {s.total > 0 && (
        <p className="mt-1 text-[11px] text-fg-subtle">
          {s.total} hunk{s.total > 1 ? "s" : ""} em {s.files.length} arquivo{s.files.length > 1 ? "s" : ""} ·{" "}
          <span className="font-medium text-rose-600 dark:text-rose-400">{s.substantive} substantivo{s.substantive === 1 ? "" : "s"}</span>
          {" · "}
          {s.cosmetic} cosmético{s.cosmetic === 1 ? "" : "s"}
          {s.unknown > 0 && <span className="text-amber-700 dark:text-amber-400"> · {s.unknown} sem veredito</span>}
        </p>
      )}

      {/* Substantive first — the operator's first question is "which one is genuinely mine to decide?". The
          hunk TEXT is collapsed: the rationale is what decides, the diff is what confirms. */}
      <ul className="mt-2 space-y-1.5">
        {s.hunks.map((h, i) => (
          <li key={`${h.file}:${i}`} className="rounded border border-line bg-surface p-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                  VERDICT_STYLE[h.kind],
                )}
              >
                {h.label}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted" title={h.file}>
                {h.file}
              </span>
            </div>
            <p className="mt-1 text-[12px] leading-snug text-fg">{h.rationale}</p>
            {h.hunk && (
              <details className="mt-1 group/hunk">
                <summary className="cursor-pointer list-none text-[10px] font-medium text-fg-subtle transition hover:text-fg-muted">
                  <span className="group-open/hunk:hidden">▸ ver trecho</span>
                  <span className="hidden group-open/hunk:inline">▾ ocultar trecho</span>
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-hover p-1.5 font-mono text-[10px] leading-relaxed text-fg-muted">
                  {h.hunk}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>

      {/* NAME the all-or-nothing rule at the point of confusion: an operator seeing cosmetic hunks in a parked
          merge will ask why the machine didn't at least take those. The answer belongs here, not in a doc. */}
      {s.allOrNothing && <p className="mt-2 text-[11px] italic text-fg-subtle">({ALL_OR_NOTHING_NOTE})</p>}
    </div>
  );
}

// ── RENDERER: conflict ────────────────────────────────────────────────────────
// A merge-train entry paused on a content conflict (conflictKind "merge-conflict") or a
// red integration gate (conflictKind "merge-gate-failed"). Actions:
//   • Resolver (merged)  — operator integrated manually in the shell → mark done
//   • Abortar            — drop the branch entirely → queue resumes
//   • Retry gate         — (gate-failed only) reset to waiting so the gate re-runs
//   • Ver no Processos   — link to /processes where the merge-train panel lives

function ConflictRenderer({ item, ctx }: { item: ConflictCockpitItem; ctx: RendererCtx }) {
  // WS-3 §3.1/§3.6 — Resolver/Abortar/Tentar-gate migram pro registry. A ÚNICA mudança de label
  // sancionada: "Integrado manualmente" → "Marcar integrado" (semântica idêntica). "Ver processos" NÃO
  // está no registry (o `conflict` entry só cobre merge/gate actions) — fica local, preservado.
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);
  const isGateFailed = item.conflictKind === "merge-gate-failed";

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] text-fg">
        Merge travado:{" "}
        <span className="font-medium text-rose-600 dark:text-rose-400">
          {isGateFailed ? "gate de integração falhou" : "conflito de conteúdo"}
        </span>
      </p>
      {item.runId && (
        <p className="text-[11px] text-fg-subtle">
          Run: <span className="font-mono text-fg-muted">{item.runId}</span>
        </p>
      )}

      {/* WS-10.5 — the ladder's verdicts, ABOVE the actions: the analysis is what the buttons are answering. */}
      {item.resolutionAnalysis && <ResolutionAnalysisPanel analysis={item.resolutionAnalysis} />}

      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        qa={qa}
        escRef={escRef}
        trail={
          <Link
            href={item.runId ? processesMergeHref(item.runId) : "/processes"}
            title="Abre a página de Processos no painel de integração deste run, para inspecionar o conflito."
            className={SECONDARY_BTN}
          >
            Ver processos
          </Link>
        }
      />
    </div>
  );
}

// ── RENDERER: proposal ────────────────────────────────────────────────────────
// A smart-capture container produced a card proposal (summary + N proposed items). Actions:
//   • Aceitar e criar (N)  — acceptProposalAction creates the CHECKED items + consumes the container
//   • Refinar ↻            — refineProposalAction appends free-text feedback and re-fires harness-capture
// While the container is still generating (the proposal sidecar has no items yet) we show a generating
// state — the list/buttons only appear once the proposal landed. The container now RESTS in "capturando"
// (hidden lane) WITH items once harness-capture finishes — it no longer advances to a separate "proposto"
// step — so "generating" keys off items, NOT status. Lane is "aprovar".

function ProposalRenderer({ item, ctx }: { item: ProposalCockpitItem; ctx: RendererCtx }) {
  const router = useRouter();
  const toast = useToast();
  const escRef = escalationRefFor(item, ctx.boardId); // WS-3 §3.6
  const [feedback, setFeedback] = useState("");
  // O texto livre nasce FECHADO: a caixa vazia dominava o item e empurrava a árvore (e a decisão real,
  // que é "isto entra?") para fora da tela. Ela é a saída de exceção, não o caminho principal.
  const [refineOpen, setRefineOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => selectAll(item.items));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [pending, startTransition] = useTransition();

  // Still generating: the proposal sidecar has no items yet (harness-capture hasn't written them). The container
  // now RESTS in "capturando" WITH items once harness-capture finishes (it no longer advances to "proposto"), so
  // we key off items.length — NOT status — else a ready proposal would show "Gerando…" forever and the human
  // could never Accept/Refine it.
  const generating = item.items.length === 0;

  // Reancoragem de 1 clique, igual à do modal: o aceite manda os itens que estão NA TELA, então a troca
  // de âncora vive aqui, sem server action. A assinatura amarra os patches À PROPOSTA que os recebeu —
  // se o agente regenerar o lote (refino), eles são descartados em vez de recair sobre outros itens.
  const signature = `${item.rounds}|${item.items.map((i) => i.tempId).join(",")}`;
  const [patched, setPatched] = useState<{ sig: string; items: ProposedItem[] }>({
    sig: signature,
    items: item.items,
  });
  const items = patched.sig === signature ? patched.items : item.items;
  const onReanchor = (tempId: string, patch: ReanchorPatch) =>
    setPatched({ sig: signature, items: applyReanchor(items, tempId, patch) });

  // Seleção em CASCATA DURA (parent-closed → zero órfãos) — a lógica pura vive em proposal-tree.
  const onSelect = (tempId: string, on: boolean) =>
    setSelected((s) => cascadeSelect(items, s, tempId, on));
  const onToggleCollapse = (tempId: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(tempId)) next.delete(tempId);
      else next.add(tempId);
      return next;
    });

  const chosen = items.filter((i) => selected.has(i.tempId));

  const accept = () => {
    if (!chosen.length || pending) return;
    startTransition(async () => {
      const res = await acceptProposalAction({
        boardId: ctx.boardId,
        containerId: item.cardId,
        items: chosen,
      });
      if (res.ok) {
        toast(`${chosen.length} ${chosen.length === 1 ? "item criado" : "itens criados"}.`, "success");
        // 4.1 — a placement the proposal asked for that couldn't be honored is surfaced (was dropped silently):
        // one advisory toast per degraded card so the operator knows to re-place it, with a link that opens the
        // card's drawer (ctx.onOpenCard) so they can fix the parent/serves in the "Posição no mapa" block.
        for (const w of res.data?.warnings ?? []) {
          toast(
            w.detail,
            "error",
            w.cardId ? { label: "Ver card", onClick: () => ctx.onOpenCard(w.cardId!) } : undefined,
          );
        }
        router.refresh();
      } else {
        toast(res.error);
      }
    });
  };

  const refine = () => {
    const fb = feedback.trim();
    if (!fb || pending) return;
    startTransition(async () => {
      const res = await refineProposalAction({
        boardId: ctx.boardId,
        containerId: item.cardId,
        feedback: fb,
      });
      if (res.ok) {
        setFeedback("");
        setRefineOpen(false);
        toast("Refinando a proposta…", "success");
        router.refresh();
      } else {
        toast(res.error);
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      refine();
    }
  };

  if (generating) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-fg-muted">
        <span aria-hidden>⏳</span> Gerando proposta…
      </p>
    );
  }

  // O rótulo do botão diz o que VAI ACONTECER. Um item em modo ESTENDER não cria card nenhum (só
  // acrescenta tasks a um card que já existe), então "Criar N cards" mentiria quando ele está no lote.
  const creations = chosen.filter((i) => !i.targetCardId).length;
  const n = effectiveSelectedCount(selected);
  const acceptLabel =
    creations === n ? `Criar ${n} ${n === 1 ? "card" : "cards"}` : `Aplicar ${n} ${n === 1 ? "item" : "itens"}`;

  return (
    <div className="space-y-3">
      {/* Como o agente leu o texto — o enquadramento, em prosa, antes da lista. */}
      <p className="text-[12px] leading-snug text-fg-muted">{item.summary || "Proposta de captura"}</p>

      {/* Onde cada item entra (caminho em texto) × o que entra (os cards novos), com cascata dura. */}
      <ProposalTree
        items={items}
        selected={selected}
        onSelect={onSelect}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        cards={ctx.cardsById}
        config={ctx.config}
        onSelectAll={() => setSelected(selectAll(items))}
        onSelectNone={() => setSelected(new Set())}
        onReanchor={onReanchor}
      />

      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        escRef={escRef}
        openCard={false}
        lead={
          <button
            type="button"
            disabled={pending || chosen.length === 0}
            onClick={accept}
            title={
              chosen.length === 0
                ? "Marque ao menos um item para criar."
                : "Cria de verdade os itens marcados no board e descarta esta proposta."
            }
            className={PRIMARY_BTN}
          >
            {pending ? "Criando…" : acceptLabel}
          </button>
        }
        trail={
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => setRefineOpen((v) => !v)}
              title="Escreve um comentário para o agente refazer a proposta — nenhum card é criado ainda."
              className={cn(SECONDARY_BTN, refineOpen && "bg-surface-hover text-fg")}
            >
              Pedir ajustes
            </button>
            {item.rounds > 0 && (
              <span className="text-[11px] text-fg-subtle">
                {item.rounds} refino{item.rounds === 1 ? "" : "s"}
              </span>
            )}
          </>
        }
      />

      {refineOpen && (
        <div className="space-y-1.5">
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="O que ajustar? Ex.: junte as duas primeiras; a segunda é technical, não user story."
            className="w-full resize-y rounded-md border border-line bg-inset px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending || !feedback.trim()}
              onClick={refine}
              className="rounded-md border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-40"
            >
              Reanalisar ↻
            </button>
            <button
              type="button"
              onClick={() => {
                setRefineOpen(false);
                setFeedback("");
              }}
              className="rounded-md px-2 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:text-fg"
            >
              Cancelar
            </button>
            <span className="text-[11px] text-fg-subtle">⌘/Ctrl+Enter</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RENDERER: design ──────────────────────────────────────────────────────────
// The "approve design" human stop (gate hasWireframe): the agent composed a design CANVAS and the
// human reviews it PER CARD — the journey is the first canvas card (own feedback field), then
// screens/components/flows/notes (one-tap approve, change request, switch primary). ONE way to
// write feedback (the composers on the cards) and ONE adaptive primary action — a standing second
// button was operator-flagged as noise (2026-07-22):
//   • 0 pendências  → "Aprovar design": advances to the recommended next status
//   • N pendências  → the SAME button becomes "Enviar para redesenho (N)": requestDesignChangeAction
//     with the accumulated unresolved entries (design-ui for screen-only tweaks; design-ux when the
//     journey/whole-design channel is questioned)
// Shares DesignCanvas (journey embedded) with the card drawer — ONE render path for both surfaces.

function DesignRenderer({ item, ctx }: { item: DesignCockpitItem; ctx: RendererCtx }) {
  const router = useRouter();
  const toast = useToast();
  const escRef = escalationRefFor(item, ctx.boardId); // WS-3 §3.6
  const [pending, startTransition] = useTransition();

  const docView = {
    artifacts: item.artifacts,
    options: item.options,
    chosenOptionId: item.chosenId,
    feedback: item.feedback,
  };
  const pendingChanges = unresolvedChanges(docView).length;

  const approve = () => {
    if (!item.chosenId || pending) return;
    startTransition(async () => {
      // Advance to the recommended next status — same moveTargets the kanban/approval use.
      const recommended = ctx.card
        ? moveTargets(ctx.card, ctx.config).find((t) => t.recommended) ?? null
        : null;
      if (!recommended) {
        toast("Sem próximo passo recomendado — avance pelo board.");
        return;
      }
      const moved = await moveCardAction({ boardId: ctx.boardId, cardId: item.cardId, status: recommended.status.id });
      if (!moved.ok) {
        toast(moved.error);
        return;
      }
      toast(`Design aprovado · avançado para "${recommended.status.name}".`, "success");
      router.refresh();
    });
  };

  const setPrimary = (artifactId: string) => {
    if (pending) return;
    startTransition(async () => {
      const res = await chooseWireframeAction({ boardId: ctx.boardId, cardId: item.cardId, optionId: artifactId });
      if (!res.ok) {
        toast(res.error);
        return;
      }
      router.refresh();
    });
  };

  const sendFeedback = (artifactId: string | null, note: string, kind: "change" | "approve") => {
    if (pending) return;
    startTransition(async () => {
      const res = await submitDesignFeedbackAction({ boardId: ctx.boardId, cardId: item.cardId, artifactId, note, kind });
      if (!res.ok) {
        toast(res.error);
        return;
      }
      router.refresh();
    });
  };

  const requestChange = () => {
    if (pendingChanges === 0 || pending) return;
    startTransition(async () => {
      const res = await requestDesignChangeAction({ boardId: ctx.boardId, cardId: item.cardId, feedback: "" });
      if (res.ok) {
        toast("Ajuste pedido — o agente vai redesenhar incorporando o feedback.", "success");
        router.refresh();
      } else {
        toast(res.error);
      }
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-fg-muted">
        Avalie o canvas: aprove/comente por card (a jornada é o primeiro) e troque a tela principal.
        Sem pendências, aprove o design; com pedidos de mudança, envie para redesenho.
      </p>

      <DesignCanvas
        doc={docView}
        journey={item.journey}
        busy={pending}
        compact
        onSetPrimary={setPrimary}
        onFeedback={sendFeedback}
      />

      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        escRef={escRef}
        lead={
          <>
        {/* ONE adaptive primary: approve when the canvas is clean, send-to-redesign when there are
            pending change-requests — never a standing idle button. */}
        {pendingChanges === 0 ? (
          <button
            type="button"
            disabled={pending || !item.chosenId}
            onClick={approve}
            title="Aprova o design (a tela principal já está definida) e avança o card para o próximo passo."
            className={PRIMARY_BTN}
          >
            {pending ? "Aplicando…" : "Aprovar design"}
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={requestChange}
            title="Devolve o design para o agente redesenhar incorporando os pedidos de mudança pendentes."
            className={PRIMARY_BTN}
          >
            {pending ? "Aplicando…" : `Enviar para redesenho (${pendingChanges})`}
          </button>
        )}
      </>
    }
  />
    </div>
  );
}

// ── RENDERER: governance ──────────────────────────────────────────────────────
// Inbox cockpit surface for GovernanceDraft proposals (story-w9n03r).
// Shows: reason + origin chip + per-change before/after diff in opt-3 style.
// Conflict warning (before ≠ canonical) shown in amber above the action row.
// Actions: Aprovar (promotes all changes to canonical) · Rejeitar (discard).
// Lane is always "aprovar".

/**
 * The human-readable form of a governance value. Most artifacts are prose and print as-is; the Lean
 * Canvas is not — a block is a list of ITEMS and a tag vocabulary is a list of names. Dumping raw JSON
 * here would make the one screen where an AGENT's canvas proposal is approved the least legible one.
 */
function governanceValueToText(change: GovernanceChange, value: unknown): string {
  if (value == null) return "(vazio)";
  if (typeof value === "string") return value;
  if (change.artifact === "canvas") {
    const text = blockToReviewText(value as CanvasBlock, null);
    return text || "(vazio)";
  }
  if (change.artifact === "canvasTags" && Array.isArray(value)) {
    return (value as CanvasTag[]).map((t) => `• ${t.name}${t.color ? ` (${t.color})` : ""}`).join("\n") || "(vazio)";
  }
  return JSON.stringify(value, null, 2);
}

// ── WS-5 (D9) — renderers for the 3 new kinds (fed by the registry, like the WS-3-migrated renderers) ──
function DeployUnsettledRenderer({ item, ctx }: { item: DeployUnsettledCockpitItem; ctx: RendererCtx }) {
  const escRef = escalationRefFor(item, ctx.boardId);
  const [logOpen, setLogOpen] = useState(false);
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-medium text-fg">Deploy disparado sem confirmação (settle não chegou)</p>
      <p className="text-[12px] text-fg-muted">Disparado em {item.deployFiredAt} — verifique se o serviço subiu.</p>
      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        escRef={escRef}
        /* Read-only "Ver status" — reuses the deploy-failure log surface. NEVER a settle/re-fire 1-click (D6). */
        trail={
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            title="Mostra o status/log do deploy (só leitura) para você conferir se o serviço realmente subiu."
            className={SECONDARY_BTN}
          >
            Ver status
          </button>
        }
      />
      {logOpen && <DeployFailureLogModal boardId={ctx.boardId} cardId={item.cardId} onClose={() => setLogOpen(false)} />}
    </div>
  );
}

function ReleaseAgingRenderer({ item, ctx }: { item: ReleaseAgingCockpitItem; ctx: RendererCtx }) {
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-medium text-fg">Código staged há {item.ageDays}d sem release</p>
      <ItemActions ctx={ctx} cardId={item.cardId} qa={qa} escRef={escRef} />
    </div>
  );
}

function MergeFailedRenderer({ item, ctx }: { item: MergeFailedCockpitItem; ctx: RendererCtx }) {
  const qa = quickActionsFor(item, ctx.config, ctx.card);
  const escRef = escalationRefFor(item, ctx.boardId);
  return (
    <div className="space-y-2.5">
      <p className="text-[13px] font-medium text-fg">Integração falhou (run {item.runId})</p>
      {item.failureReason && (
        <p className="truncate text-[12px] text-fg-muted" title={item.failureReason}>
          {item.failureReason}
        </p>
      )}
      <ItemActions ctx={ctx} cardId={item.cardId} qa={qa} escRef={escRef} />
    </div>
  );
}

function GovernanceRenderer({ item, ctx }: { item: GovernanceCockpitItem; ctx: RendererCtx }) {
  const router = useRouter();
  const toast = useToast();
  const escRef = escalationRefFor(item, ctx.boardId); // WS-3 §3.6
  const [pending, startTransition] = useTransition();

  const approve = () => {
    if (pending) return;
    startTransition(async () => {
      const res = await approveGovernanceDraftAction({ boardId: ctx.boardId, draftId: item.draftId });
      if (!res.ok) {
        toast(res.error);
        return;
      }
      toast("Proposta aprovada — mudanças aplicadas ao board.", "success");
      router.refresh();
    });
  };

  const reject = () => {
    if (pending) return;
    startTransition(async () => {
      const res = await rejectGovernanceDraftAction({ boardId: ctx.boardId, draftId: item.draftId });
      if (!res.ok) {
        toast(res.error);
        return;
      }
      toast("Proposta rejeitada.", "success");
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      {/* Origin + reason */}
      <div className="flex flex-wrap items-start gap-2">
        <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
          ⚙ GOV
        </span>
        {item.origin?.skill && (
          <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle">
            {item.origin.skill}
          </span>
        )}
      </div>
      {item.reason && (
        <p className="text-[12px] text-fg-muted">{item.reason}</p>
      )}

      {/* Conflict warning — canonical changed since the proposal: approve is BLOCKED (q1=o1).
          No blind overwrite; the proposal must be re-made over the current value. */}
      {item.conflicts.length > 0 && (
        <div className="rounded-md border border-amber-400/40 bg-amber-400/8 px-2.5 py-1.5">
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            ⚠ Conflito: o valor canônico mudou desde a proposta ({item.conflicts.join(", ")}).
            Aprovar está bloqueado — a proposta precisa ser refeita sobre o valor atual.
          </p>
        </div>
      )}

      {/* Before / After diff — opt-3 style */}
      <div className="space-y-2">
        {item.changes.map((change, i) => {
          const label = change.label ?? (change.field ? `${change.artifact}.${change.field}` : change.artifact);
          const beforeStr = governanceValueToText(change, change.before);
          const afterStr = governanceValueToText(change, change.after);
          return (
            <div key={i} className="rounded-md border border-line bg-inset px-2.5 py-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</p>
              <div className="rounded bg-surface px-2 py-1">
                <p className="text-[10px] text-fg-subtle mb-0.5">− antes</p>
                <p className="whitespace-pre-wrap text-[12px] text-fg-muted leading-snug">{beforeStr}</p>
              </div>
              <div className="rounded bg-emerald-500/8 border border-emerald-500/20 px-2 py-1">
                <p className="text-[10px] text-emerald-700 dark:text-emerald-400 mb-0.5">+ depois</p>
                <p className="whitespace-pre-wrap text-[12px] text-emerald-900 dark:text-emerald-300 leading-snug">{afterStr}</p>
              </div>
            </div>
          );
        })}
      </div>

      <ItemActions
        ctx={ctx}
        cardId={item.cardId}
        escRef={escRef}
        openCard={Boolean(item.cardId)}
        lead={
          <button
            type="button"
            disabled={pending || item.conflicts.length > 0}
            title={
              item.conflicts.length > 0
                ? "Conflito: re-proponha sobre o valor atual antes de aprovar."
                : "Aplica estas mudanças ao board de verdade (viram o valor oficial)."
            }
            onClick={approve}
            className={PRIMARY_BTN}
          >
            {pending ? "Aplicando…" : "Aprovar"}
          </button>
        }
        trail={
          <button
            type="button"
            disabled={pending}
            onClick={reject}
            title="Descarta a proposta — o board fica como está."
            className={SECONDARY_BTN}
          >
            Rejeitar
          </button>
        }
      />
    </div>
  );
}
