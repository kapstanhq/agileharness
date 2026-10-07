"use client";

// OS CORPOS de um item — o que o item carrega para LER antes de decidir (fase 3). Duas portas:
//   • InboxPreview — À VISTA, entre a pergunta e as opções, só onde aprovar sem ver seria às cegas (D12): os argumentos
//     exatos do pedido de um agente e o comando exato de uma execução aprovada, com o desfazer dele;
//   • InboxDetailsBody — dentro de «Mais detalhes»: a árvore de uma proposta (o que vai ser criado — tudo marcado,
//     desmarque o que não serve), o canvas de um design, o antes/depois de uma proposta de PRD ou de uma entrega, a
//     análise de um conflito, as conferências de um comando. (As alternativas de uma pergunta são opções do modelo, com
//     os prós e contras na consequência — InboxOptions.)
// Nenhum corpo tem botão de decisão próprio: o que ele coleta vai no `payload` da opção (InboxItem).

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { batchStopCards, type CockpitItem } from "@/lib/storymap/demands";
import { cardHref } from "@/lib/storymap/deep-links";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import type { CanvasBlock, CanvasTag, GovernanceChange } from "@/lib/storymap/types";
import { blockToReviewText } from "@/lib/storymap/canvas";
import { applyReanchor, cascadeSelect, effectiveSelectedCount, selectAll, type ReanchorPatch } from "@/lib/storymap/smart-capture/proposal-tree";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";
import { ALL_OR_NOTHING_NOTE, summarizeAnalysis, type EntryResolutionAnalysis, type VerdictKind } from "@/lib/storymap/resolution-analysis";
import { prettyCanonicalArgs } from "@/lib/storymap/quick-actions";
import { governanceDecision, previewList } from "@/components/inbox/cockpit-labels";
import { chooseWireframeAction, submitDesignFeedbackAction } from "@/app/actions";
import { ProposalTree } from "@/components/ProposalTree";
import { DesignCanvas } from "@/components/wireframe/DesignCanvas";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/Toast";
import type { InvokePayload } from "@/components/quick-action-run";
import type { InboxBoardCtx } from "./InboxItem";

type Setter = (fn: (p: InvokePayload) => InvokePayload) => void;

/** O que precisa ser VISTO antes do clique — o pedido exato de um agente, o comando exato de uma execução aprovada. */
export function InboxPreview({ entry }: { entry: InboxEntry }) {
  const item = entry.item;
  if (item?.kind === "approval" && item.args) return <ApprovalArgs item={item} />;
  if (item?.kind === "locked-exec") return <LockedExecPreview item={item} />;
  if (item && batchStopCards(item).length > 0) return <BatchItemsPreview item={item} />;
  return null;
}

// ── o lote do condutor: cada item, com a prova (fase 7) ───────────────────────────────────────────────

/**
 * Uma parada de um LOTE (a entrega, a publicação, a sessão que morreu) é UM item do Inbox que fala por todos os itens:
 * à vista, antes das opções, cada um com o link do card e — na entrega — a `## Prova da entrega` dele, fechada.
 */
function BatchItemsPreview({ item }: { item: CockpitItem }) {
  const cards = batchStopCards(item);
  const delivery = item.kind === "gate";
  return (
    <div className="rounded-lg border border-line bg-inset px-3 py-2" data-batch-items={cards.length}>
      <p className="text-[12.5px] font-semibold text-fg-subtle">
        {delivery ? `Este lote tem ${cards.length} itens — a decisão vale para todos` : `A sessão cuidava de ${cards.length} itens deste lote`}
      </p>
      <ul className="mt-1 divide-y divide-line">
        {cards.map((c) => (
          <li key={c.cardId} className="py-1">
            <Link href={cardHref(item.boardId, c.cardId)} prefetch={false} className="inline-flex min-h-11 items-center text-[13.5px] font-medium text-accent-ink underline-offset-2 hover:underline">
              {c.cardTitle}
            </Link>
            {delivery &&
              (c.proof ? (
                <details>
                  <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold text-fg-subtle">A prova da entrega</summary>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap font-sans text-[12.5px] leading-snug text-fg-muted">{c.proof}</pre>
                </details>
              ) : (
                <p className="text-[12.5px] text-fg-subtle">Sem a prova da entrega no card.</p>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** O corpo de «Mais detalhes». */
export function InboxDetailsBody({ entry, board, setPayload }: { entry: InboxEntry; board?: InboxBoardCtx; setPayload: Setter }) {
  const item = entry.item;
  if (!item) return null;
  switch (item.kind) {
    case "proposal":
      return item.items.length > 0 ? <ProposalBody item={item} board={board} setPayload={setPayload} /> : null;
    case "design":
      return <DesignBody item={item} />;
    case "governance":
      return <GovernanceBody item={item} />;
    case "delivery-audit":
      return <DeliveryBody item={item} />;
    case "conflict":
      return item.resolutionAnalysis ? <ResolutionAnalysisPanel analysis={item.resolutionAnalysis} /> : null;
    case "locked-exec":
      return <LockedExecDetails item={item} />;
    default:
      return null;
  }
}

// ── proposta de captura ───────────────────────────────────────────────────────────────────────────────

function ProposalBody({ item, board, setPayload }: { item: Extract<CockpitItem, { kind: "proposal" }>; board?: InboxBoardCtx; setPayload: Setter }) {
  const signature = `${item.rounds}|${item.items.map((i) => i.tempId).join(",")}`;
  const [patched, setPatched] = useState<{ sig: string; items: ProposedItem[] }>({ sig: signature, items: item.items });
  const items = patched.sig === signature ? patched.items : item.items;
  const [selected, setSelected] = useState<Set<string>>(() => selectAll(item.items));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const chosen = useMemo(() => items.filter((i) => selected.has(i.tempId)), [items, selected]);
  useEffect(() => {
    setPayload((p) => ({ ...p, items: chosen }));
  }, [chosen, setPayload]);
  const n = effectiveSelectedCount(selected);
  return (
    <div className="space-y-2">
      {item.summary && <p className={cn("text-[13.5px] leading-relaxed text-fg-muted", !open && "line-clamp-4")}>{item.summary}</p>}
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="min-h-11 text-[13.5px] font-medium text-accent-ink hover:underline">
        {open ? "Recolher a lista" : `Ver ${items.length === 1 ? "o item proposto" : `os ${items.length} itens propostos`}${n < items.length ? ` · ${n} marcados` : ""}`}
      </button>
      {open && board && (
        <ProposalTree
          items={items}
          selected={selected}
          onSelect={(tempId, on) => setSelected((s) => cascadeSelect(items, s, tempId, on))}
          collapsed={collapsed}
          onToggleCollapse={(tempId) =>
            setCollapsed((s) => {
              const next = new Set(s);
              if (next.has(tempId)) next.delete(tempId);
              else next.add(tempId);
              return next;
            })
          }
          cards={board.cardsById}
          config={board.config}
          onSelectAll={() => setSelected(selectAll(items))}
          onSelectNone={() => setSelected(new Set())}
          onReanchor={(tempId: string, patch: ReanchorPatch) => setPatched({ sig: signature, items: applyReanchor(items, tempId, patch) })}
        />
      )}
    </div>
  );
}

// ── design ────────────────────────────────────────────────────────────────────────────────────────────

function DesignBody({ item }: { item: Extract<CockpitItem, { kind: "design" }> }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const doc = { artifacts: item.artifacts, options: item.options, chosenOptionId: item.chosenId, feedback: item.feedback };
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) toast(res.error ?? "Não deu certo.");
      router.refresh();
    });
  return (
    <div id={`design-${item.cardId}`} className="space-y-2">
      <p className="text-[13.5px] leading-relaxed text-fg-muted">Comente cada tela e marque a principal (a estrela). Sem comentários pendentes, aprove.</p>
      <DesignCanvas
        doc={doc}
        journey={item.journey}
        busy={pending}
        compact
        onSetPrimary={(artifactId) => act(() => chooseWireframeAction({ boardId: item.boardId, cardId: item.cardId, optionId: artifactId }) as Promise<{ ok: boolean; error?: string }>)}
        onFeedback={(artifactId, note, kind) => act(() => submitDesignFeedbackAction({ boardId: item.boardId, cardId: item.cardId, artifactId, note, kind }) as Promise<{ ok: boolean; error?: string }>)}
      />
    </div>
  );
}

// ── proposta de PRD e metas ───────────────────────────────────────────────────────────────────────────

function governanceValueToText(change: GovernanceChange, value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (change.artifact === "canvas") return blockToReviewText(value as CanvasBlock, null);
  if (change.artifact === "canvasTags" && Array.isArray(value)) return (value as CanvasTag[]).map((t) => `- ${t.name}`).join("\n");
  return JSON.stringify(value, null, 2);
}

function GovernanceBody({ item }: { item: Extract<CockpitItem, { kind: "governance" }> }) {
  const [open, setOpen] = useState(false);
  const decision = governanceDecision(item);
  return (
    <div className="space-y-2">
      {decision && decision.sections.length > 0 && <p className="text-[13px] leading-snug text-fg-muted">Seções: {previewList(decision.sections)}</p>}
      {item.supersedes && item.supersedes.length > 0 && (
        <p className="text-[12.5px] leading-snug text-fg-subtle">
          Substitui {item.supersedes.length === 1 ? "uma proposta anterior" : `${item.supersedes.length} propostas anteriores`} sobre as mesmas seções.
        </p>
      )}
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="min-h-11 text-[13.5px] font-medium text-accent-ink hover:underline">
        {open ? "Recolher o rascunho" : (decision?.readLabel ?? "Ler a proposta completa")}
      </button>
      {open && (
        <div className="space-y-3">
          {item.changes.map((change, i) => {
            const before = governanceValueToText(change, change.before);
            const after = governanceValueToText(change, change.after);
            return (
              <div key={i} className="space-y-1.5 rounded-lg border border-line bg-inset px-3 py-2.5">
                <p className="text-[12px] font-semibold text-fg-subtle">{change.label ?? change.field ?? change.artifact}</p>
                {before ? (
                  <div className="rounded-md bg-surface px-2.5 py-1.5">
                    <p className="text-[11px] font-semibold text-fg-subtle">Como está</p>
                    <Markdown variant="compact" className="text-[13px] text-fg-muted">
                      {before}
                    </Markdown>
                  </div>
                ) : (
                  <p className="text-[11.5px] font-semibold text-fg-subtle">(seção nova)</p>
                )}
                <div className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5">
                  <p className="text-[11px] font-semibold text-primary">Como fica</p>
                  <Markdown variant="compact" className="text-[13px]">
                    {after || "(vazio)"}
                  </Markdown>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── amostra de entrega ────────────────────────────────────────────────────────────────────────────────

function DeliveryBody({ item }: { item: Extract<CockpitItem, { kind: "delivery-audit" }> }) {
  return (
    <div className="space-y-2">
      {(item.before || item.after) && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-inset px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg-subtle">Antes</p>
            <p className="whitespace-pre-wrap text-[13.5px] leading-snug text-fg-muted">{item.before ?? "—"}</p>
          </div>
          <div className="rounded-lg border border-line bg-inset px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-fg-subtle">Agora</p>
            <p className="whitespace-pre-wrap text-[13.5px] leading-snug text-fg">{item.after ?? "—"}</p>
          </div>
        </div>
      )}
      {item.link && (
        <a href={item.link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[13.5px] font-semibold text-accent-ink underline underline-offset-2">
          Ver no ar
        </a>
      )}
      {item.proof && (
        <details className="rounded-lg border border-line bg-inset px-3 py-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold text-fg-subtle">A prova da entrega</summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap font-sans text-[12.5px] leading-snug text-fg-muted">{item.proof}</pre>
        </details>
      )}
    </div>
  );
}

// ── pedido de um agente ───────────────────────────────────────────────────────────────────────────────

/** D12 — fim da aprovação às cegas: os argumentos exatos do pedido, à vista antes da decisão. */
function ApprovalArgs({ item }: { item: Extract<CockpitItem, { kind: "approval" }> }) {
  return (
    <details className="rounded-lg border border-line bg-inset px-3 py-2" open>
      <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold text-fg-subtle">O que exatamente foi pedido</summary>
      <pre className="mt-1 max-h-48 overflow-auto font-mono text-[11.5px] leading-snug text-fg-muted">{prettyCanonicalArgs(item.args ?? "")}</pre>
    </details>
  );
}

// ── execução aprovada: o comando exato, o desfazer e as conferências ─────────────────────────────────

const MONO = "mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px] leading-snug text-fg";

/**
 * O que o dono precisa VER antes de aprovar um comando travado: o comando EXATO (a linha que a trava julgou e que o
 * servidor roda) e o desfazer dele — sem nada para copiar: ninguém cola nada no terminal.
 */
function LockedExecPreview({ item }: { item: Extract<CockpitItem, { kind: "locked-exec" }> }) {
  return (
    <div className="rounded-lg border border-line bg-inset px-3 py-2">
      <p className="text-[12.5px] font-semibold text-fg-subtle">O que o servidor roda</p>
      <p className="mt-1 break-all font-mono text-[11px] text-fg-muted">Programa: {item.program}</p>
      <pre className={MONO}>{item.command}</pre>
      {item.undoCommand ? (
        <>
          <p className="mt-2 text-[12.5px] font-semibold text-fg-subtle">Como desfazer</p>
          <p className="mt-1 break-all font-mono text-[11px] text-fg-muted">Programa: {item.undoProgram ?? "?"}</p>
          <pre className={MONO}>{item.undoCommand}</pre>
        </>
      ) : (
        <p className="mt-2 rounded bg-danger/10 px-2 py-1.5 text-[12.5px] font-semibold text-danger">Sem desfazer. Plano B: {item.noUndoPlan ?? "—"}</p>
      )}
    </div>
  );
}

/** As conferências do comando, as palavras do agente e, depois de rodar, o passo a passo. */
function LockedExecDetails({ item }: { item: Extract<CockpitItem, { kind: "locked-exec" }> }) {
  const check = (c: (typeof item.verify)[number], key: string) => (
    <li key={key} className="text-[12.5px] text-fg">
      {c.label} <span className="break-all font-mono text-[11px] text-fg-muted">({c.command})</span>
      <span className="block text-[11.5px] text-fg-subtle">{c.criterion}</span>
    </li>
  );
  return (
    <div className="space-y-2">
      {item.preflight.length > 0 && (
        <div>
          <p className="text-[12.5px] font-semibold text-fg-subtle">Antes de rodar, o servidor confere</p>
          <ul className="mt-1 space-y-1">{item.preflight.map((c, i) => check(c, `p${i}`))}</ul>
        </div>
      )}
      <div>
        <p className="text-[12.5px] font-semibold text-fg-subtle">Depois de rodar, o servidor confere</p>
        <ul className="mt-1 space-y-1">{item.verify.map((c, i) => check(c, `v${i}`))}</ul>
        <p className="mt-1 text-[11.5px] text-fg-subtle">Conferências: só comandos que o servidor liberou para conferir.</p>
      </div>
      {/* as palavras do agente por último, rotuladas: elas explicam, não descrevem o que roda */}
      <div className="rounded-lg border border-dashed border-line px-3 py-2">
        <p className="text-[12.5px] font-semibold text-fg-subtle">Explicação do agente</p>
        <p className="mt-1 whitespace-pre-line break-words text-[12.5px] text-fg">{item.summary}</p>
        {item.why && <p className="mt-1 whitespace-pre-line break-words text-[12px] text-fg-muted">Por que agora: {item.why}</p>}
      </div>
      {item.steps.length > 0 && (
        <div>
          <p className="text-[12.5px] font-semibold text-fg-subtle">O que aconteceu, passo a passo</p>
          <ul className="mt-1 space-y-1.5">
            {item.steps.map((st, i) => (
              <li key={`${st.step}:${i}`} className="rounded border border-line bg-surface p-1.5">
                <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide", st.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300")}>
                  {st.ok ? "ok" : "falhou"}
                </span>{" "}
                <span className="font-mono text-[11px] text-fg-muted">{st.step}</span>
                {st.error && <p className="mt-1 text-[12px] text-fg">{st.error}</p>}
                {st.output && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] text-fg-muted">{st.output}</pre>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── conflito de integração: a análise do juiz ─────────────────────────────────────────────────────────

const VERDICT_STYLE: Record<VerdictKind, string> = {
  substantive: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  cosmetic: "bg-surface-hover text-fg-muted",
  unknown: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
};

/** A escada semântica da integração, por trecho — só quando ela subiu (ausente = ninguém analisou, nunca «liberou»). */
function ResolutionAnalysisPanel({ analysis }: { analysis: EntryResolutionAnalysis }) {
  const s = useMemo(() => summarizeAnalysis(analysis), [analysis]);
  return (
    <details className="rounded-lg border border-line bg-inset px-3 py-2">
      <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold text-fg-subtle">O que a análise automática viu ({s.total} trechos)</summary>
      <p className="mt-1 text-[13px] text-fg">{s.detail}</p>
      <ul className="mt-2 space-y-1.5">
        {s.hunks.map((h, i) => (
          <li key={`${h.file}:${i}`} className="rounded border border-line bg-surface p-1.5">
            <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide", VERDICT_STYLE[h.kind])}>{h.label}</span>{" "}
            <span className="break-all font-mono text-[10.5px] text-fg-muted">{h.file}</span>
            <p className="mt-1 text-[12.5px] leading-snug text-fg">{h.rationale}</p>
          </li>
        ))}
      </ul>
      {s.allOrNothing && <p className="mt-2 text-[11.5px] italic text-fg-subtle">({ALL_OR_NOTHING_NOTE})</p>}
    </details>
  );
}
