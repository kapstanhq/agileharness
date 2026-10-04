"use client";

// O CORPO de um item — a única parte do cartão que muda por kind, e só onde o item carrega algo para LER ou ESCOLHER
// antes de decidir: as opções de uma pergunta, a árvore de uma proposta, o canvas de um design, o rascunho de uma
// proposta de PRD, o antes/depois de uma entrega, a análise de um conflito, os argumentos de um pedido de agente. O
// resto (a decisão, as opções e as consequências) vem do modelo e é desenhado pelo InboxItemCard — nenhum corpo tem
// botão de decisão próprio: o que ele coleta vai no `payload` da opção.

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import type { CockpitItem } from "@/lib/storymap/demands";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import type { CanvasBlock, CanvasTag, GovernanceChange } from "@/lib/storymap/types";
import { blockToReviewText } from "@/lib/storymap/canvas";
import { applyReanchor, cascadeSelect, effectiveSelectedCount, selectAll, type ReanchorPatch } from "@/lib/storymap/smart-capture/proposal-tree";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";
import { ALL_OR_NOTHING_NOTE, summarizeAnalysis, type EntryResolutionAnalysis, type VerdictKind } from "@/lib/storymap/resolution-analysis";
import { prettyCanonicalArgs } from "@/lib/storymap/quick-actions";
import { dejargonText } from "@/lib/storymap/copilot/dejargon";
import { governanceDecision, previewList } from "@/components/inicio/cockpit-labels";
import { chooseWireframeAction, submitDesignFeedbackAction } from "@/app/actions";
import { ProposalTree } from "@/components/ProposalTree";
import { DesignCanvas } from "@/components/wireframe/DesignCanvas";
import { Markdown } from "@/components/Markdown";
import { useToast } from "@/components/Toast";
import type { InvokePayload } from "@/components/quick-action-run";
import type { InboxBoardCtx } from "./InboxItemCard";

type Setter = (fn: (p: InvokePayload) => InvokePayload) => void;

export function InboxBody({
  entry,
  board,
  payload,
  setPayload,
}: {
  entry: InboxEntry;
  board?: InboxBoardCtx;
  payload: InvokePayload;
  setPayload: Setter;
}) {
  const item = entry.item;
  if (!item) return null;
  switch (item.kind) {
    case "question":
      return <QuestionBody item={item} payload={payload} setPayload={setPayload} />;
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
    case "approval":
      return item.args ? <ApprovalArgs item={item} /> : null;
    case "locked-exec":
      return <LockedExecBody item={item} />;
    default:
      return null;
  }
}

// ── pergunta ──────────────────────────────────────────────────────────────────────────────────────────

function QuestionBody({ item, payload, setPayload }: { item: Extract<CockpitItem, { kind: "question" }>; payload: InvokePayload; setPayload: Setter }) {
  const selected = payload.selectedOptionIds ?? [];
  const hasOptions = item.options.length > 0;
  const [writeOwn, setWriteOwn] = useState(!hasOptions);
  const toggle = (id: string) =>
    setPayload((p) => {
      const cur = p.selectedOptionIds ?? [];
      const next = item.mode === "multi" ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : cur.includes(id) ? [] : [id];
      return { ...p, selectedOptionIds: next };
    });
  return (
    <div className="space-y-3">
      {item.context && (
        <p className="text-[13.5px] leading-relaxed text-fg-muted">
          <span className="font-semibold text-fg-subtle">Por que o agente pergunta:</span> {dejargonText(item.context)}
        </p>
      )}
      {hasOptions && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-fg-subtle">
            {item.mode === "multi" ? "Escolha uma ou mais" : "Escolha uma"}
          </legend>
          {item.options.map((opt) => {
            const checked = selected.includes(opt.id);
            return (
              <label
                key={opt.id}
                className={cn(
                  "flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-[14px] transition",
                  checked ? "border-primary/60 bg-primary/10 text-fg" : "border-line bg-surface text-fg-muted hover:border-line-emphasis hover:text-fg",
                )}
              >
                <input
                  type={item.mode === "multi" ? "checkbox" : "radio"}
                  name={`q-${item.id}`}
                  checked={checked}
                  onChange={() => toggle(opt.id)}
                  className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--primary))]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    {opt.label}
                    {opt.recommended && <span className="rounded border border-primary/50 px-1.5 py-px text-[11px] font-semibold text-fg">recomendada</span>}
                  </span>
                  {(opt.pros?.length ?? 0) + (opt.cons?.length ?? 0) > 0 && (
                    <span className="mt-1 block space-y-0.5 text-[12.5px] leading-snug">
                      {opt.pros?.map((p, i) => (
                        <span key={`p${i}`} className="block text-fg-muted">
                          + {p}
                        </span>
                      ))}
                      {opt.cons?.map((c, i) => (
                        <span key={`c${i}`} className="block text-fg-muted">
                          − {c}
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
      {item.recommendation && !hasOptions && (
        <p className="text-[13px] leading-snug text-fg-muted">
          <span className="font-semibold text-fg-subtle">Sugestão do agente:</span> {dejargonText(item.recommendation)}
        </p>
      )}
      {writeOwn ? (
        <textarea
          rows={3}
          value={payload.answer ?? ""}
          onChange={(e) => setPayload((p) => ({ ...p, answer: e.target.value }))}
          placeholder={hasOptions ? "Quer acrescentar algo? (opcional)" : "Escreva a sua resposta"}
          className="w-full resize-y rounded-lg border border-line bg-inset px-3 py-2 text-[14px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
      ) : (
        <button type="button" onClick={() => setWriteOwn(true)} className="min-h-11 text-[13.5px] font-medium text-accent-ink hover:underline">
          Escrever outra resposta
        </button>
      )}
    </div>
  );
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

/**
 * O que o dono precisa VER antes de aprovar um comando travado — e depois, o que aconteceu. O comando aparece EXATO (a
 * linha que a trava julgou e que o servidor roda), sem quebrar e sem nada para copiar: ninguém cola nada no terminal.
 */
function LockedExecBody({ item }: { item: Extract<CockpitItem, { kind: "locked-exec" }> }) {
  const mono = "mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px] leading-snug text-fg";
  const check = (c: (typeof item.verify)[number], key: string) => (
    <li key={key} className="text-[12.5px] text-fg">
      {c.label} <span className="break-all font-mono text-[11px] text-fg-muted">({c.command})</span>
      <span className="block text-[11.5px] text-fg-subtle">{c.criterion}</span>
    </li>
  );
  return (
    <div className="space-y-2">
      {/* o BLOCO ESTRUTURADO primeiro: o que roda de fato, o desfazer, as conferências com o critério */}
      <div className="rounded-lg border border-line bg-inset px-3 py-2">
        <p className="text-[12.5px] font-semibold text-fg-subtle">O que o servidor roda</p>
        <p className="mt-1 break-all font-mono text-[11px] text-fg-muted">Programa: {item.program}</p>
        <pre className={mono}>{item.command}</pre>
        {item.undoCommand ? (
          <>
            <p className="mt-2 text-[12.5px] font-semibold text-fg-subtle">Como desfazer</p>
            <p className="mt-1 break-all font-mono text-[11px] text-fg-muted">Programa: {item.undoProgram ?? "?"}</p>
            <pre className={mono}>{item.undoCommand}</pre>
          </>
        ) : (
          <p className="mt-2 rounded bg-rose-500/10 px-2 py-1.5 text-[12.5px] font-semibold text-rose-700 dark:text-rose-300">
            Sem desfazer. Plano B: {item.noUndoPlan ?? "—"}
          </p>
        )}
        {item.preflight.length > 0 && (
          <>
            <p className="mt-2 text-[12.5px] font-semibold text-fg-subtle">Antes de rodar, o servidor confere</p>
            <ul className="mt-1 space-y-1">{item.preflight.map((c, i) => check(c, `p${i}`))}</ul>
          </>
        )}
        <p className="mt-2 text-[12.5px] font-semibold text-fg-subtle">Depois de rodar, o servidor confere</p>
        <ul className="mt-1 space-y-1">{item.verify.map((c, i) => check(c, `v${i}`))}</ul>
        <p className="mt-2 text-[11.5px] text-fg-subtle">Conferências: só comandos que o servidor liberou para conferir.</p>
      </div>
      {/* as palavras do agente por último, rotuladas: elas explicam, não descrevem o que roda */}
      <div className="rounded-lg border border-dashed border-line px-3 py-2">
        <p className="text-[12.5px] font-semibold text-fg-subtle">Explicação do agente</p>
        <p className="mt-1 whitespace-pre-line break-words text-[12.5px] text-fg">{item.summary}</p>
        {item.why && <p className="mt-1 whitespace-pre-line break-words text-[12px] text-fg-muted">Por que agora: {item.why}</p>}
      </div>
      {item.steps.length > 0 && (
        <details className="rounded-lg border border-line bg-inset px-3 py-2" open={item.execStatus !== "done"}>
          <summary className="flex min-h-11 cursor-pointer items-center text-[12.5px] font-semibold text-fg-subtle">O que aconteceu, passo a passo</summary>
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
        </details>
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
