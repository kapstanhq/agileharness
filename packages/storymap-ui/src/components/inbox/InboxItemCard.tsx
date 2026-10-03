"use client";

// O CARTÃO DE UM ITEM do Inbox — UM componente para toda superfície (a lista, a folha aberta, a página do item, o
// popover da barra e a home). Parte do redesenho do Inbox.
//
// A ANATOMIA, sempre na mesma ordem (ux-report §4.2):
//   1. a decisão — uma pergunta com o objeto dentro (em Acompanhar, o fato em andamento);
//   2. o que aconteceu — uma ou duas linhas, sem termo técnico;
//   3. as opções — cada botão com a CONSEQUÊNCIA impressa embaixo (o celular não tem tooltip); a bloqueada diz por
//      quê e o que a libera;
//   4. se você não fizer nada;
//   5. detalhes — fechados: ids, textos crus, o motivo técnico.
// As regras de botão: no máximo UM principal; o efeito externo tem nome («Publicar em produção»); ler e delegar
// («Abrir card», «Pedir ao Jido») ficam em «Mais»; a ação que o celular não executa vira «No computador: como fazer».
//
// O TEXTO não mora aqui: vem pronto do modelo (lib/storymap/inbox/decision.ts), que os testes guardam contra o
// glossário. Aqui só se formata o tempo no fuso de quem lê e se desenha.

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { primaryOption, type DecisionOption, type ItemDecision, type ReceiptUndo } from "@/lib/storymap/inbox/decision";
import { formatDecisionText, localTimeFormatter, quoted, relativeWithClock, staleLabel } from "@/lib/storymap/inbox/copy";
import { inboxItemHref } from "@/lib/storymap/deep-links";
import type { ActionOutcome } from "@/lib/storymap/action-outcome";
import { recordInboxReceiptAction } from "@/app/actions";
import { receiptUndoLabel } from "@/lib/storymap/inbox/receipts";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { auditHumanClick, escalateHref, isScreenInvoke, runServerInvoke, type InvokePayload } from "@/components/quick-action-run";
import { InboxBody } from "./InboxBodies";
import { UndoControl } from "./UndoControl";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";
import { useOverlayReserve } from "./useOverlayReserve";
import { PublishStatusModal } from "./PublishStatusModal";

export type InboxDensity = "row" | "sheet" | "page" | "popover";

/** O board de um item — o corpo de alguns kinds (a árvore da proposta) precisa dele. */
export interface InboxBoardCtx {
  config: BoardConfig;
  cardsById: Map<string, Card>;
}

/** O recibo do clique: o que foi feito, para a tela mostrar no lugar do item. */
export interface InboxReceipt {
  key: string;
  boardId: string;
  itemId: string;
  ask: string;
  text: string;
  at: number;
}

/** O ponto da linha — a urgência, em cor (e anunciada ao leitor de tela pelo texto da pergunta). */
const DOT_CLS: Record<ItemDecision["dot"], string> = {
  red: "bg-rose-600 dark:bg-rose-400",
  amber: "bg-amber-500",
  green: "bg-primary",
  grey: "bg-fg-subtle/60",
};

/** «O card fica parado» → «o card fica parado» (depois de «Se ignorar:»). */
const lowerFirst = (t: string) => (t ? t[0].toLowerCase() + t.slice(1) : t);

/** O selo do board — no Inbox de todos os boards, cada item diz de onde vem. */
export function BoardChip({ name }: { name: string }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center truncate rounded-[5px] bg-sky-600/10 px-1.5 py-px text-[11px] font-semibold text-sky-800 dark:bg-sky-400/15 dark:text-sky-200">
      {name}
    </span>
  );
}

/** Quantos OUTROS cards a causa desta entrada segura (as facetas de outros cards, sem repetir). */
function otherCards(entry: InboxEntry): number {
  return new Set(entry.facets.filter((f) => f.cardId && f.cardId !== entry.cardId).map((f) => f.cardId)).size;
}

/** A linha de metadados: o board, a idade com o relógio, parado, e quem age. */
function MetaLine({ entry, now, showBoard, withNext }: { entry: InboxEntry; now: number; showBoard: boolean; withNext: boolean }) {
  const tz = useOwnerTimeZone();
  const when = now ? relativeWithClock(entry.decision.since, now, tz) : null;
  const bits: React.ReactNode[] = [];
  if (entry.stale) {
    // parado: a idade vira o aviso — «parado há 12 dias · 21/07», sem repetir «há 12 dias» ao lado
    const day = when?.split(" · ")[1];
    bits.push(
      <span key="stale" className="font-semibold text-amber-800 dark:text-amber-300">
        {staleLabel(entry.stale.days)}
        {day ? ` · ${day}` : ""}
      </span>,
    );
  } else if (when) bits.push(<span key="when">{when}</span>);
  // uma causa que segura vários cards (a publicação parada) diz quantos ela afeta; as outras coisas do mesmo card, quantas
  const others = otherCards(entry);
  const same = entry.facets.length - entry.facets.filter((f) => f.cardId && f.cardId !== entry.cardId).length;
  if (same > 0) bits.push(<span key="facets">+{same} neste card</span>);
  if (others > 0) bits.push(<span key="cards">afeta mais {others === 1 ? "1 card" : `${others} cards`}</span>);
  if (withNext && entry.decision.bucket === "acompanhar") bits.push(<span key="next">{entry.decision.next.label}</span>);
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

// ── As densidades estreitas: a linha da lista e a do popover ────────────────────────────────────────────

function RowCard({
  entry,
  now,
  showBoard,
  onOpen,
  href,
  compact,
  live,
}: {
  entry: InboxEntry;
  now: number;
  showBoard: boolean;
  onOpen?: () => void;
  href?: string;
  compact: boolean;
  /** a linha de estado do card (Acompanhar) — quem age agora nele; NÃO interativa (mora dentro do botão da linha). */
  live?: React.ReactNode;
}) {
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  const d = entry.decision;
  const inner = (
    <>
      <span className={cn("mt-[7px] h-2 w-2 shrink-0 rounded-full", DOT_CLS[entry.stale ? "grey" : d.dot])} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cn("block font-semibold leading-snug text-fg", compact ? "truncate text-[13px]" : "line-clamp-2 text-[15px]")}>{formatDecisionText(d.ask, fmt)}</span>
        <span className="mt-1 block">
          <MetaLine entry={entry} now={now} showBoard={showBoard} withNext={!compact} />
        </span>
        {live && !compact && <span className="mt-1 block">{live}</span>}
        {!compact && (
          <span className="mt-0.5 block line-clamp-1 text-[12.5px] leading-snug text-fg-muted">
            {d.bucket === "decidir" ? `Se ignorar: ${lowerFirst(formatDecisionText(d.ifIgnored, fmt))}` : formatDecisionText(d.ifIgnored, fmt)}
          </span>
        )}
      </span>
      {!compact && <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />}
    </>
  );
  const cls = cn(
    "group flex w-full items-start gap-3 text-left transition hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
    compact ? "min-h-11 rounded-md px-2 py-2" : "min-h-14 px-4 py-3",
  );
  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} className={cls} data-inbox-item={entry.itemId}>
        {inner}
      </button>
    );
  }
  return (
    <Link href={href ?? inboxItemHref(entry.boardId, entry.itemId)} prefetch={false} className={cls} data-inbox-item={entry.itemId}>
      {inner}
    </Link>
  );
}

// ── A densidade larga: a folha e a página ───────────────────────────────────────────────────────────────

/** Um bloco da anatomia, com o seu rótulo. */
function Part({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="space-y-1.5" aria-labelledby={id}>
      <h3 id={id} className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Os botões CHEIOS têm cor por efeito: verde para decidir/publicar, terracota para o que não tem volta. */
const FILLED_GREEN = "bg-primary text-primary-fg hover:bg-primary-hover";
const FILLED_RED = "bg-danger text-white hover:bg-danger/90";
const OUTLINE = "border border-line bg-surface text-fg hover:bg-surface-hover";
const OUTLINE_RED = "border border-danger/60 bg-surface text-danger hover:bg-danger/10";

function optionCls(option: DecisionOption, isPrimary: boolean): string {
  if (isPrimary) return option.auditCls === "destructive" ? FILLED_RED : FILLED_GREEN;
  return option.tone === "danger" ? OUTLINE_RED : OUTLINE;
}

/** O formulário do corpo: o que o dono escreveu/escolheu, e se ele já basta para a opção que pede. */
function formReady(option: DecisionOption, payload: InvokePayload): boolean {
  switch (option.requires) {
    case "answer":
      return Boolean(payload.answer?.trim()) || (payload.selectedOptionIds?.length ?? 0) > 0;
    case "selection":
      return (payload.items?.length ?? 0) > 0;
    case "note":
      return Boolean(payload.note?.trim());
    default:
      return true;
  }
}

const REQUIRES_HINT: Record<NonNullable<DecisionOption["requires"]>, string> = {
  answer: "Escolha uma opção ou escreva a resposta acima.",
  selection: "Marque ao menos um item acima.",
  note: "Escreva o motivo abaixo.",
};

function FullCard({
  entry,
  density,
  board,
  now,
  showBoard,
  onDone,
  onNext,
  nextLabel,
}: {
  entry: InboxEntry;
  density: "sheet" | "page";
  board?: InboxBoardCtx;
  now: number;
  showBoard: boolean;
  onDone?: (r: InboxReceipt) => void;
  onNext?: () => void;
  nextLabel?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const d = entry.decision;
  const tz = useOwnerTimeZone();
  const fmt = useMemo(() => localTimeFormatter(now, tz), [now, tz]);
  const text = useCallback((t: string) => formatDecisionText(t, fmt), [fmt]);
  const primary = primaryOption(d);

  const [payload, setPayload] = useState<InvokePayload>({});
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DecisionOption | null>(null);
  const [armed, setArmed] = useState<DecisionOption | null>(null); // a opção que pede um motivo, esperando o texto
  const [howto, setHowto] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  // o recibo no lugar do item: o que foi feito e, quando a ação volta atrás, o «Desfazer» dela (o id do recibo gravado)
  const [receipt, setReceipt] = useState<{ text: string; tone: "done" | "started"; id?: string; undo?: ReceiptUndo } | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  const run = useCallback(
    async (option: DecisionOption) => {
      const invoke = option.invoke;
      if (isScreenInvoke(invoke)) {
        if (invoke.kind === "link") router.push(invoke.href);
        else if (invoke.kind === "escalate") {
          const href = escalateHref(invoke.ref, pathname, typeof window === "undefined" ? "" : window.location.search);
          if (pathname && pathname.startsWith(`/board/${invoke.ref.boardId}/`)) router.replace(href);
          else router.push(href);
        } else if (invoke.kind === "howto") setHowto((cur) => (cur === option.id ? null : option.id));
        else setStatusOpen(true);
        return;
      }
      setPending(option.id);
      setError(null);
      const res = await runServerInvoke(invoke, payload);
      setPending(null);
      if (!res.ok) {
        setError({ id: option.id, text: res.error });
        toast(res.error);
        return;
      }
      const outcome = (res.data as { outcome?: ActionOutcome } | undefined)?.outcome;
      if (outcome?.status === "refused") {
        // o servidor aceitou o pedido, mas nada aconteceu — dito como recusa, com o motivo (B2)
        setError({ id: option.id, text: outcome.message });
        toast(outcome.message);
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
        ask: text(d.ask),
        text: done,
        undo: option.undo ?? null,
      }).catch(() => null);
      const receiptId = saved?.ok ? saved.data?.id : undefined;
      setReceipt({ text: done, tone: outcome?.status === "started" ? "started" : "done", ...(receiptId && option.undo ? { id: receiptId, undo: option.undo } : {}) });
      setArmed(null);
      onDone?.({ key: entry.key, boardId: entry.boardId, itemId: entry.itemId, ask: text(d.ask), text: done, at: Date.now() });
      router.refresh();
    },
    [router, pathname, payload, toast, entry, d.ask, onDone, text],
  );

  const click = (option: DecisionOption) => {
    if (option.disabled || pending) return;
    if (option.requires === "note" && armed?.id !== option.id) {
      setArmed(option);
      return;
    }
    if (!formReady(option, payload)) return;
    if (option.confirm) {
      setConfirming(option);
      return;
    }
    void run(option);
  };

  const sticky = density === "sheet" ? "sticky bottom-0" : "sticky bottom-14 md:bottom-0";
  // a pílula do feedback visual pousa ACIMA da barra de decisão, nunca em cima do botão principal
  const barRef = useRef<HTMLDivElement>(null);
  useOverlayReserve(barRef);

  return (
    <article className="space-y-5" aria-label={text(d.ask)}>
      <header className="space-y-2">
        <MetaLine entry={entry} now={now} showBoard={showBoard} withNext />
        <h2 className="text-[19px] font-semibold leading-[1.3] tracking-[-0.011em] text-fg sm:text-[21px]">{text(d.ask)}</h2>
        {entry.item?.copilotBackoff && (
          <p className="text-[12.5px] font-medium text-amber-800 dark:text-amber-300">
            O Jido tentou {entry.item.copilotBackoff.streak} vezes sem conseguir e parou — este é seu agora.
          </p>
        )}
      </header>

      <Part title="O que aconteceu">
        <p className="text-[14px] leading-relaxed text-fg-muted">{text(d.happened)}</p>
      </Part>

      {entry.item && (
        <InboxBody entry={entry} board={board} payload={payload} setPayload={setPayload} />
      )}

      {/* 3 · as opções — presas embaixo na folha, com a consequência impressa sob cada uma. */}
      <div ref={barRef} className={cn(sticky, "z-10 -mx-4 border-t border-line bg-surface/95 px-4 pb-4 pt-3 backdrop-blur supports-[backdrop-filter]:bg-surface/85 sm:-mx-5 sm:px-5")}>
        <Part title={d.bucket === "decidir" ? "Suas opções" : d.options.length ? "Se quiser agir" : "Opções"}>
          {receipt ? (
            <div role="status" className="space-y-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5">
              <p className="flex items-start gap-2 text-[14px] leading-snug text-fg">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span>
                  <b className="font-semibold">Feito</b> — {text(receipt.text)}
                </span>
              </p>
              {receipt.id && receipt.undo && (
                <UndoControl boardId={entry.boardId} undo={{ source: "receipt", id: receipt.id, label: receiptUndoLabel(receipt.undo) }} />
              )}
              {onNext && (
                <button type="button" onClick={onNext} className="inline-flex min-h-11 items-center gap-1 text-[13.5px] font-semibold text-accent-ink hover:underline">
                  {nextLabel ? `Próximo: ${nextLabel}` : "Próximo"} <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              )}
            </div>
          ) : d.options.length === 0 ? (
            <p className="text-[13.5px] text-fg-muted">Nada para você fazer aqui agora.</p>
          ) : (
            <ul className="space-y-3">
              {d.options.map((o) => {
                const isPrimary = primary?.id === o.id;
                const waitingInput = !o.disabled && !formReady(o, payload) && !(o.requires === "note" && armed?.id !== o.id);
                return (
                  <li key={o.id} className="space-y-1">
                    <button
                      type="button"
                      onClick={() => click(o)}
                      disabled={Boolean(o.disabled) || pending !== null || waitingInput}
                      aria-describedby={`opt-${entry.key}-${o.id}`}
                      className={cn(
                        "inline-flex min-h-12 w-full items-center justify-center rounded-[10px] px-4 text-[15px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto sm:min-w-[14rem]",
                        optionCls(o, isPrimary),
                      )}
                    >
                      {pending === o.id ? "Um instante…" : o.requires === "note" && armed?.id === o.id ? `Enviar: ${o.label.toLowerCase()}` : o.label}
                    </button>
                    <p id={`opt-${entry.key}-${o.id}`} className="px-0.5 text-[12.5px] leading-snug text-fg-muted">
                      {o.disabled ? (
                        <>
                          <span className="font-semibold text-fg">Bloqueado:</span> {text(o.disabled.reason)}
                          {o.disabled.unblock && (
                            <>
                              {" "}
                              <Link href={o.disabled.unblock.href} prefetch={false} className="font-semibold text-accent-ink underline underline-offset-2">
                                → {o.disabled.unblock.label}
                              </Link>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          {text(o.consequence)}
                          {waitingInput && o.requires && <span className="block text-fg-subtle">{REQUIRES_HINT[o.requires]}</span>}
                        </>
                      )}
                    </p>
                    {o.requires === "note" && armed?.id === o.id && (
                      <textarea
                        autoFocus
                        rows={3}
                        value={payload.note ?? ""}
                        onChange={(e) => setPayload((p) => ({ ...p, note: e.target.value }))}
                        placeholder="Escreva aqui — é o que o agente vai ler."
                        className="w-full resize-y rounded-lg border border-line bg-inset px-3 py-2 text-[14px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
                      />
                    )}
                    {howto === o.id && o.invoke.kind === "howto" && (
                      <div className="rounded-lg border border-line bg-inset px-3 py-2.5">
                        <p className="text-[13px] font-semibold text-fg">{o.invoke.title}</p>
                        <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] leading-snug text-fg-muted">
                          {o.invoke.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {error?.id === o.id && (
                      <p role="alert" className="text-[12.5px] font-medium text-danger">
                        Não deu certo: {error.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Part>
      </div>

      <Part title="Se você não fizer nada">
        <p className="text-[14px] leading-relaxed text-fg-muted">{text(d.ifIgnored)}</p>
      </Part>

      {entry.facets.length > 0 && (
        <Part title={otherCards(entry) > 0 ? "A mesma causa, em outros cards" : "Também neste card"}>
          <ul className="space-y-1">
            {entry.facets.map((f) => (
              <li key={f.itemId}>
                <Link href={inboxItemHref(entry.boardId, f.itemId)} prefetch={false} className="inline-flex min-h-11 items-center gap-1 text-[13.5px] text-accent-ink underline-offset-2 hover:underline">
                  {/* a faceta de OUTRO card da mesma causa diz o card (a pergunta é a mesma da entrada) */}
                  {f.cardId && f.cardId !== entry.cardId && f.cardTitle ? quoted(f.cardTitle) : text(f.ask)} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {d.more.length > 0 && (
        <nav aria-label="Mais" className="flex flex-wrap items-center gap-x-4 gap-y-0 text-[13.5px]">
          <span className="font-semibold text-fg-subtle">Mais</span>
          {d.more.map((o) => (
            <button key={o.id} type="button" onClick={() => void run(o)} className="inline-flex min-h-11 items-center font-medium text-accent-ink hover:underline">
              {o.label}
            </button>
          ))}
        </nav>
      )}

      {d.details.length > 0 && (
        <details className="group rounded-lg border border-line bg-inset/60 px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-[12.5px] font-semibold text-fg-subtle">
            <ChevronDown className="h-3.5 w-3.5 -rotate-90 transition group-open:rotate-0" aria-hidden /> Detalhes
          </summary>
          <dl className="mt-1.5 space-y-1.5 pb-1">
            {d.details.map((x, i) => (
              <div key={i} className="grid gap-0.5 sm:grid-cols-[10rem_1fr]">
                <dt className="text-[11.5px] font-semibold text-fg-subtle">{x.label}</dt>
                <dd className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-fg-muted">{x.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {confirming && confirming.confirm && (
        <ConfirmDialog
          title={confirming.confirm.title}
          description={confirming.confirm.body}
          confirmLabel={confirming.label}
          tone={confirming.tone === "danger" ? "danger" : "default"}
          confirmDisabled={pending !== null}
          onConfirm={() => {
            const o = confirming;
            setConfirming(null);
            void run(o);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {statusOpen && entry.cardId && <PublishStatusModal boardId={entry.boardId} cardId={entry.cardId} onClose={() => setStatusOpen(false)} />}
    </article>
  );
}

/**
 * UM item do Inbox, em qualquer superfície. `row`/`popover` são a linha que se toca para abrir (`onOpen`, ou o link
 * da página do item); `sheet`/`page` são o item aberto, com as cinco partes e as opções presas embaixo.
 */
export function InboxItemCard({
  entry,
  density,
  now,
  board,
  showBoard = false,
  onOpen,
  href,
  onDone,
  onNext,
  nextLabel,
  live,
}: {
  entry: InboxEntry;
  density: InboxDensity;
  /** o relógio de quem lê (0 antes do mount: sem idade, para o servidor e o cliente não discordarem). */
  now: number;
  board?: InboxBoardCtx;
  /** no Inbox de todos os boards, cada item leva o selo do board. */
  showBoard?: boolean;
  onOpen?: () => void;
  href?: string;
  onDone?: (r: InboxReceipt) => void;
  onNext?: () => void;
  nextLabel?: string | null;
  /** a linha de estado do card, na linha (density `row`) — ver RowCard. */
  live?: React.ReactNode;
}) {
  if (density === "row" || density === "popover") {
    return <RowCard entry={entry} now={now} showBoard={showBoard} onOpen={onOpen} href={href} compact={density === "popover"} live={live} />;
  }
  return <FullCard entry={entry} density={density} board={board} now={now} showBoard={showBoard} onDone={onDone} onNext={onNext} nextLabel={nextLabel} />;
}
