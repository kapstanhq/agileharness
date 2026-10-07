"use client";

// UM ITEM do Inbox — a MESMA anatomia em toda superfície (a lista, a página do item, a faixa do host e a linha curta de
// «Os agentes estão cuidando»; o painel da barra usa a linha de link `InboxItemRow`). Fase 3: refeito do zero.
//
//   [board ▪] · Pergunta · há 12 min                   ← a linha de contexto
//   O que aconteceu: …                                  ← decision.happened
//   O que eu preciso de você: …                         ← decision.ask
//   [ Opção primária ] [ Opção 2 ] [ Opção 3 ]          ← UM clique cada (InboxOptions)
//   Mais detalhes ▸                                     ← fechado: se ignorar, o que cada opção faz, o corpo, ids…
//
// UM CLIQUE: nenhum diálogo e nenhum formulário antes do botão. A opção que pedia um motivo roda já, com o texto padrão
// que o modelo põe no invoke, e o recibo oferece o `addNote` dela («Adicionar um motivo»); a que não tem volta diz isso
// no rótulo, e o recibo oferece «Desfazer» quando a ação volta atrás. A régua continua no servidor: a recusa aparece
// no lugar do recibo, com o motivo. Depois do clique o item vira o recibo, no
// mesmo lugar; a lista (InboxHome) o segura por {@link RECEIPT_MS} mesmo que a recarga já o tenha tirado, e leva o
// foco ao próximo item.
//
// O TEXTO não mora aqui: vem pronto do modelo (lib/storymap/inbox/decision.ts), que os testes guardam contra o
// glossário. Aqui só se formata o tempo no fuso de quem lê e se desenha.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { primaryOption, type DecisionOption, type ReceiptUndo } from "@/lib/storymap/inbox/decision";
import { formatDecisionText, localTimeFormatter, quoted, relativeWithClock, staleLabel } from "@/lib/storymap/inbox/copy";
import { receiptUndoLabel } from "@/lib/storymap/inbox/receipts";
import { inboxItemHref, inboxListItemHref } from "@/lib/storymap/deep-links";
import type { ActionOutcome } from "@/lib/storymap/action-outcome";
import { approveBatchDeliveryAction, recordInboxReceiptAction } from "@/app/actions";
import { batchApprovalWords, batchStopCards } from "@/lib/storymap/demands";
import { auditHumanClick, escalateHref, isScreenInvoke, runServerInvoke, type InvokePayload } from "@/components/quick-action-run";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";
import { InboxOptions } from "./InboxOptions";
import { facetLinks, isUndoLike, kindNoun, needOf, RECEIPT_MS } from "./inbox-ui";
import { subscribeToPush } from "@/lib/notifications/client/push-channel";
import { InboxDetailsBody, InboxPreview } from "./InboxBodies";
import { UndoControl } from "./UndoControl";
import { PublishStatusModal } from "./PublishStatusModal";

/** O board de um item — o corpo de alguns kinds (a árvore da proposta) precisa dele. */
export interface InboxBoardCtx {
  config: BoardConfig;
  cardsById: Map<string, Card>;
}

/** Um celular, ou o app instalado na tela de início — onde o aviso no celular faz sentido ser ativado. */
function isPhoneContext(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return standalone || Boolean(window.matchMedia?.("(pointer: coarse)").matches);
}

/** O selo do board — no Inbox de todos os boards, cada item diz de onde vem. */
export function BoardChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1 truncate rounded-[5px] border border-line bg-inset px-1.5 py-px text-[11px] font-semibold text-fg-muted">
      {name}
    </span>
  );
}

/** Quantos OUTROS cards a causa desta entrada segura (as facetas de outros cards, sem repetir). */
function otherCards(entry: InboxEntry): number {
  return new Set(entry.facets.filter((f) => f.cardId && f.cardId !== entry.cardId).map((f) => f.cardId)).size;
}

/** A linha de contexto: o board, o tipo, a idade com o relógio (ou «parado há N dias») e quantos cards a causa afeta. */
function ContextLine({ entry, now, showBoard }: { entry: InboxEntry; now: number; showBoard: boolean }) {
  const tz = useOwnerTimeZone();
  const when = now ? relativeWithClock(entry.decision.since, now, tz) : null;
  const bits: React.ReactNode[] = [];
  const noun = kindNoun(entry.kind);
  if (noun) bits.push(<span key="kind">{noun}</span>);
  if (entry.stale) {
    const day = when?.split(" · ")[1];
    bits.push(
      <span key="stale" className="font-semibold text-amber-800 dark:text-amber-300">
        {staleLabel(entry.stale.days)}
        {day ? ` · ${day}` : ""}
      </span>,
    );
  } else if (when) bits.push(<span key="when">{when}</span>);
  const others = otherCards(entry);
  if (others > 0) bits.push(<span key="cards">afeta mais {others === 1 ? "1 card" : `${others} cards`}</span>);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-snug text-fg-subtle">
      {showBoard && <BoardChip name={entry.boardName} />}
      {bits.map((b, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 || showBoard ? <span aria-hidden>·</span> : null}
          {b}
        </span>
      ))}
    </p>
  );
}

/** A linha de um item no painel da barra: o contexto e o que o agente precisa — um link para o item na lista. */
export function InboxItemRow({ entry, now, showBoard }: { entry: InboxEntry; now: number; showBoard: boolean }) {
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  return (
    <Link
      href={inboxListItemHref(entry.boardId, entry.itemId)}
      prefetch={false}
      data-inbox-item={entry.itemId}
      className="block min-h-11 rounded-md px-2 py-2 text-left transition hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      <ContextLine entry={entry} now={now} showBoard={showBoard} />
      <span className="mt-0.5 block line-clamp-2 text-[13px] font-semibold leading-snug text-fg">{formatDecisionText(needOf(entry.decision), fmt)}</span>
    </Link>
  );
}

type Receipt = { text: string; id?: string; undo?: ReceiptUndo; addNote?: NonNullable<DecisionOption["addNote"]> };

/**
 * UM item do Inbox. `full` = a anatomia inteira (a lista e a página); `banner` = a faixa de uma linha do aviso do host;
 * `short` = a linha de «Os agentes estão cuidando» (o que acontece e quem cuida — só os botões de desfazer/reabrir).
 */
export function InboxItem({
  entry,
  now,
  board,
  showBoard = false,
  variant = "full",
  detailsOpen = false,
  onSettled,
  onExpired,
}: {
  entry: InboxEntry;
  /** o relógio de quem lê (0 antes do mount: sem idade, para o servidor e o cliente não discordarem). */
  now: number;
  board?: InboxBoardCtx;
  /** no Inbox de todos os boards, cada item leva o selo do board. */
  showBoard?: boolean;
  variant?: "full" | "banner" | "short";
  /** a página do item abre «Mais detalhes». */
  detailsOpen?: boolean;
  /** o clique deu certo: a lista segura o item (o recibo) e leva o foco ao próximo. */
  onSettled?: (key: string) => void;
  /** o recibo cumpriu o tempo: a lista o solta. Sem ele (a página do item), o recibo fica. */
  onExpired?: (key: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // fase 7 — a parada de um LOTE do condutor (entrega ou publicação) é UMA decisão para os N itens: a opção de seguir
  // diz isso e roda approveBatchDeliveryAction (cada item pelo caminho de uma aprovação de um card só). Sem desfazer
  // em bloco: cada item volta pelo card.
  const batch = useMemo(() => {
    const item = entry.item;
    const n = item ? batchStopCards(item).length : 0;
    return item?.kind === "gate" && item.batchId && n > 1 ? { id: item.batchId, fromStatus: item.status ?? "", n } : null;
  }, [entry.item]);
  const d = useMemo(() => {
    if (!batch) return entry.decision;
    const swap = (o: DecisionOption): DecisionOption => {
      if (o.id !== "advance" || o.invoke.kind !== "move-card") return o;
      const { undo: _undo, ...rest } = o;
      void _undo;
      return batchApprovalWords(rest, batch.n);
    };
    return { ...entry.decision, options: entry.decision.options.map(swap) };
  }, [batch, entry.decision]);
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  const text = useCallback((t: string) => formatDecisionText(t, fmt), [fmt]);
  const uid = useId();

  // o que o corpo do item coleta para as opções: só a seleção da árvore de uma proposta (a resposta escrita e as
  // alternativas marcadas vão direto no clique). Sem nada aqui, a opção roda com o que o modelo já pôs no invoke.
  const [payload, setPayload] = useState<InvokePayload>({});
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [howto, setHowto] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  // uma orientação (não uma recusa): o que fazer em outro aparelho
  const [hint, setHint] = useState<string | null>(null);
  // o ponteiro ou o foco no recibo seguram o tempo (quem vai apertar «Desfazer» não perde o botão no meio do gesto)
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    if (!receipt || !onExpired || holding) return;
    const t = setTimeout(() => {
      setReceipt(null);
      onExpired(entry.key);
    }, RECEIPT_MS);
    return () => clearTimeout(t);
  }, [receipt, holding, onExpired, entry.key]);

  // «Ativar o aviso no celular»: a permissão e a inscrição são do NAVEGADOR (push-channel), não do servidor. Só num
  // celular (ou no app instalado): no computador o clique inscreveria ESTE navegador, o item sumiria para todos e o
  // celular seguiria sem aviso — ali a tela diz como fazer no celular.
  const enablePush = useCallback(async (option: DecisionOption) => {
    if (!isPhoneContext()) {
      setRefusal(null);
      setHint("Neste computador o aviso tocaria aqui, não no celular. Abra o Inbox no celular (no iPhone, pelo app adicionado à tela de início) e toque em «Ativar o aviso no celular» por lá.");
      return;
    }
    setPending(option.id);
    setRefusal(null);
    const state = await subscribeToPush().catch(() => "unsupported" as const);
    setPending(null);
    if (state === "subscribed") {
      setReceipt({ text: option.done });
      onSettled?.(entry.key);
      router.refresh();
    } else if (state === "denied") setRefusal("O navegador está bloqueando os avisos deste site. Libere nas configurações do navegador e tente de novo.");
    else setRefusal("Este navegador não recebe avisos. No iPhone, adicione o app à tela de início e abra por lá.");
  }, [entry.key, onSettled, router]);

  const run = useCallback(
    async (option: DecisionOption, extra: InvokePayload = {}) => {
      if (option.disabled || pending) return;
      const invoke = option.invoke;
      if (isScreenInvoke(invoke)) {
        if (invoke.kind === "link") router.push(invoke.href);
        else if (invoke.kind === "escalate") {
          const href = escalateHref(invoke.ref, pathname, typeof window === "undefined" ? "" : window.location.search);
          if (pathname && pathname.startsWith(`/board/${invoke.ref.boardId}/`)) router.replace(href);
          else router.push(href);
        } else if (invoke.kind === "howto") setHowto((cur) => (cur === option.id ? null : option.id));
        else if (invoke.kind === "enable-push") void enablePush(option);
        else setStatusOpen(true);
        return;
      }
      const body: InvokePayload = { ...payload, ...extra };
      setPending(option.id);
      setRefusal(null);
      const res =
        batch && option.id === "advance" && invoke.kind === "move-card"
          ? await approveBatchDeliveryAction({ boardId: entry.boardId, batchId: batch.id, fromStatus: batch.fromStatus, status: invoke.status }).catch(
              (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
            )
          : await runServerInvoke(invoke, body);
      if (!res.ok) {
        setPending(null);
        setRefusal(res.error);
        return;
      }
      const outcome = (res.data as { outcome?: ActionOutcome } | undefined)?.outcome;
      if (outcome?.status === "refused") {
        // o servidor aceitou o pedido, mas nada aconteceu — dito como recusa, com o motivo, no lugar do recibo
        setPending(null);
        setRefusal(outcome.message);
        return;
      }
      const done = outcome?.message ?? option.done;
      auditHumanClick({ surface: "inbox", invoke, cls: option.auditCls, boardId: entry.boardId, cardId: entry.cardId || undefined, note: `${entry.kind}:${option.id}` });
      // o recibo DURÁVEL antes da recarga: a página de um item que acabou de sair já acha o desfecho no ledger.
      // Fail-open — um recibo que não grava nunca desfaz a ação, que já aconteceu (só não haverá «Desfazer»).
      const saved = await recordInboxReceiptAction({
        boardId: entry.boardId,
        itemId: entry.itemId,
        cardId: entry.cardId || null,
        kind: entry.kind,
        ask: text(needOf(d)),
        text: done,
        undo: option.undo ?? null,
      }).catch(() => null);
      const receiptId = saved?.ok ? saved.data?.id : undefined;
      setPending(null);
      setReceipt({
        text: done,
        ...(receiptId && option.undo ? { id: receiptId, undo: option.undo } : {}),
        ...(option.addNote ? { addNote: option.addNote } : {}),
      });
      onSettled?.(entry.key);
      router.refresh();
    },
    [router, pathname, payload, pending, entry, d, onSettled, text, enablePush, batch],
  );

  const holdProps = {
    onMouseEnter: () => setHolding(true),
    onMouseLeave: () => setHolding(false),
    onFocus: () => setHolding(true),
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHolding(false);
    },
  };

  const receiptView = receipt && (
    <div role="status" className="space-y-2" {...holdProps} data-inbox-receipt>
      <p className="flex items-start gap-2 text-[14px] leading-snug text-fg">
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span>
          <b className="font-semibold">Feito</b> — {text(receipt.text)}
        </span>
      </p>
      {(receipt.undo || receipt.addNote) && (
        <div className="flex flex-wrap items-start gap-2">
          {receipt.id && receipt.undo && <UndoControl boardId={entry.boardId} undo={{ source: "receipt", id: receipt.id, label: receiptUndoLabel(receipt.undo) }} />}
          {receipt.addNote && <AddReason addNote={receipt.addNote} entry={entry} />}
        </div>
      )}
    </div>
  );

  const refusalView = refusal && (
    <p role="alert" className="text-[13px] font-medium leading-snug text-danger">
      Não deu: {text(refusal)}
    </p>
  );

  // «Mais detalhes»: o mesmo bloco na anatomia inteira e na linha curta da página do item (a de Acompanhar)
  const others = otherCards(entry);
  const facets = facetLinks(entry);
  const detailsView = !receipt && (
        <details className="group" open={detailsOpen || undefined}>
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-fg-subtle hover:text-fg">
            <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" aria-hidden /> Mais detalhes
          </summary>
          <div className="mt-1 space-y-3 border-l-2 border-line pl-3">
            <p className="text-[13px] leading-snug text-fg-muted">
              <span className="font-semibold text-fg-subtle">Se você não fizer nada: </span>
              {text(d.ifIgnored)}
            </p>

            {d.options.length > 0 && (
              <div>
                <p className="text-[12px] font-semibold text-fg-subtle">O que cada opção faz</p>
                <ul className="mt-1 space-y-1">
                  {d.options.map((o) => (
                    <li key={o.id} id={`${uid}-${o.id}`} className="text-[13px] leading-snug text-fg-muted">
                      <span className="font-semibold text-fg">{o.label}:</span> {text(o.consequence)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {entry.item && <InboxDetailsBody entry={entry} board={board} setPayload={setPayload} />}

            {facets.length > 0 && (
              <div>
                <p className="text-[12px] font-semibold text-fg-subtle">{others > 0 ? "A mesma causa, em outros cards" : "Também neste card"}</p>
                <ul className="mt-0.5">
                  {facets.map((f) => (
                    <li key={f.itemId}>
                      <Link href={inboxItemHref(entry.boardId, f.itemId)} prefetch={false} className="inline-flex min-h-11 items-center gap-1 text-[13px] text-accent-ink underline-offset-2 hover:underline">
                        {text(f.label)} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {d.more.length > 0 && (
              <nav aria-label="Mais" className="flex flex-wrap items-center gap-x-4">
                {d.more.map((o) => (
                  <button key={o.id} type="button" onClick={() => void run(o)} className="inline-flex min-h-11 items-center text-[13px] font-medium text-accent-ink hover:underline">
                    {o.label}
                  </button>
                ))}
              </nav>
            )}

            {d.details.length > 0 && (
              <dl className="space-y-1.5">
                {d.details.map((x, i) => (
                  <div key={i} className="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
                    <dt className="text-[11.5px] font-semibold text-fg-subtle">{x.label}</dt>
                    <dd className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-fg-muted">{x.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {!detailsOpen && (
              <Link href={inboxItemHref(entry.boardId, entry.itemId)} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-accent-ink hover:underline">
                Abrir este item numa página
              </Link>
            )}
          </div>
        </details>
  );

  // ── a faixa do host: uma linha, com a opção que destrava ─────────────────────────────────────────────────
  // A frase tem um PISO de largura (`min-w-[min(100%,18rem)]`) e os botões andam JUNTOS num grupo: onde a frase e o
  // grupo não cabem lado a lado (o celular), o grupo QUEBRA para baixo e a frase fica com a largura inteira. Sem o
  // piso, o `flex-1` encolhia a frase até uma palavra por linha ao lado dos botões (visto no ar a 390px).
  if (variant === "banner") {
    const primary = primaryOption(d);
    // a principal primeiro, depois as outras habilitadas (o «Agora não» do aviso no celular) — uma linha só
    const shown = [...(primary ? [primary] : []), ...d.options.filter((o) => o !== primary && !o.disabled && o.invoke.kind !== "howto")];
    return (
      <div data-host-notice={entry.kind} data-inbox-key={entry.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-danger/40 bg-danger/5 px-4 py-2.5">
        {receipt ? (
          receiptView
        ) : (
          <>
            <p className="min-w-[min(100%,18rem)] flex-1 text-[14px] font-semibold leading-snug text-fg">{text(needOf(d))}</p>
            {shown.length > 0 && (
              <div className="flex flex-wrap items-center gap-2" data-host-notice-actions>
                {shown.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => void run(o)}
                    disabled={pending !== null}
                    className={cn(
                      "inline-flex min-h-11 items-center rounded-[10px] px-3.5 text-[13.5px] font-semibold transition disabled:opacity-45",
                      o === primary ? "border border-line bg-surface text-fg hover:bg-surface-hover" : "text-fg-muted hover:text-fg",
                    )}
                  >
                    {pending === o.id ? "Um instante…" : o.label}
                  </button>
                ))}
              </div>
            )}
            {hint && <p className="w-full text-[13px] leading-snug text-fg-muted">{hint}</p>}
            {refusalView && <div className="w-full">{refusalView}</div>}
          </>
        )}
      </div>
    );
  }

  // ── a linha curta de «Os agentes estão cuidando»: o que acontece e quem cuida ─────────────────────────────
  if (variant === "short") {
    const undoers = d.options.filter(isUndoLike);
    return (
      <article data-inbox-key={entry.key} data-inbox-item={entry.itemId} tabIndex={-1} aria-label={text(d.ask)} className="space-y-1 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
        <ContextLine entry={entry} now={now} showBoard={showBoard} />
        <p className="text-[14px] leading-snug text-fg">{text(d.ask)}</p>
        <p className={cn("text-[12.5px] leading-snug", d.next.stalled ? "font-semibold text-amber-800 dark:text-amber-300" : "text-fg-muted")}>{d.next.label}</p>
        {receipt
          ? receiptView
          : undoers.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {undoers.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => void run(o)}
                    disabled={Boolean(o.disabled) || pending !== null}
                    title={text(o.consequence)}
                    className="inline-flex min-h-11 items-center rounded-[10px] border border-line bg-surface px-3.5 text-[13.5px] font-semibold text-fg transition hover:bg-surface-hover disabled:opacity-45"
                  >
                    {pending === o.id ? "Um instante…" : o.label}
                  </button>
                ))}
              </div>
            )}
        {refusalView}
        {detailsOpen && detailsView}
      </article>
    );
  }

  // ── a anatomia inteira ───────────────────────────────────────────────────────────────────────────────────
  const primary = primaryOption(d);
  return (
    <article
      data-inbox-key={entry.key}
      data-inbox-item={entry.itemId}
      tabIndex={-1}
      aria-label={text(needOf(d))}
      className="space-y-2.5 px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent sm:px-5"
    >
      <ContextLine entry={entry} now={now} showBoard={showBoard} />

      {receipt ? (
        receiptView
      ) : (
        <>
          <p className="text-[14px] leading-relaxed text-fg-muted">
            <span className="text-fg-subtle">O que aconteceu: </span>
            {text(d.happened)}
          </p>
          {entry.item?.copilotBackoff && (
            <p className="text-[12.5px] font-medium text-amber-800 dark:text-amber-300">
              O Jido tentou {entry.item.copilotBackoff.streak} vezes sem conseguir e parou. Agora é com você.
            </p>
          )}
          <p className="text-[15px] font-semibold leading-snug text-fg">
            <span className="font-normal text-fg-subtle">O que eu preciso de você: </span>
            {text(needOf(d))}
          </p>

          <InboxPreview entry={entry} />

          <InboxOptions entry={entry} decision={d} primaryId={primary?.id ?? null} pending={pending} howto={howto} describedBy={uid} text={text} payload={payload} onRun={(o, extra) => void run(o, extra)} />
          {refusalView}
        </>
      )}

      {detailsView}

      {statusOpen && entry.cardId && <PublishStatusModal boardId={entry.boardId} cardId={entry.cardId} onClose={() => setStatusOpen(false)} />}
    </article>
  );
}

/** «Adicionar um motivo» — depois do clique de uma opção que rodou com o texto padrão: o texto da pessoa vai como `note`. */
function AddReason({ addNote, entry }: { addNote: NonNullable<DecisionOption["addNote"]>; entry: InboxEntry }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  if (state?.tone === "ok") return <p className="text-[13px] text-fg-muted">{state.text}</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-[10px] px-2 text-[13.5px] font-semibold text-accent-ink hover:underline">
        {addNote.label}
      </button>
    );
  }
  const send = async () => {
    if (!note.trim() || isScreenInvoke(addNote.invoke)) return;
    setPending(true);
    const res = await runServerInvoke(addNote.invoke, { note: note.trim() });
    setPending(false);
    const outcome = res.ok ? (res.data as { outcome?: ActionOutcome } | undefined)?.outcome : undefined;
    if (!res.ok || outcome?.status === "refused") {
      setState({ tone: "err", text: res.ok ? (outcome?.message ?? "") : res.error });
      return;
    }
    setState({ tone: "ok", text: "Motivo enviado ao agente." });
    router.refresh();
  };
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label={`${addNote.label}${entry.cardTitle ? ` sobre ${quoted(entry.cardTitle)}` : ""}`}
        placeholder="O motivo, numa frase"
        className="min-h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-inset px-3 text-[14px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
      />
      <button type="submit" disabled={pending || !note.trim()} className="inline-flex min-h-11 items-center rounded-[10px] border border-line bg-surface px-3.5 text-[13.5px] font-semibold text-fg transition hover:bg-surface-hover disabled:opacity-45">
        {pending ? "Um instante…" : "Enviar"}
      </button>
      {state?.tone === "err" && (
        <p role="alert" className="w-full text-[12.5px] font-medium text-danger">
          Não deu: {state.text}
        </p>
      )}
    </form>
  );
}
