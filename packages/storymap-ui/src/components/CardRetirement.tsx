"use client";

// CardRetirement — the in-card tombstone for a card in the RETIRE flow (the one piece of the
// old CardPipelineArtifacts that survives the card-as-document overhaul: plan/wireframes/findings
// moved INTO the document, but the retirement brief carries two GATED actions — Reviver and
// Aprovar exclusão de dados — so it stays a small interactive section). Shows WHY it left
// (disposition), HOW HARD it was cut (level + scope), the agent's removal plan, and the actions.
// Loads its own removal plan (retire/<id>/plan.md) so it's self-contained in the document.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ChevronDown, ChevronRight, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { approveDataDeletionAction, getRetirePlanAction, reviveCardAction } from "@/app/actions";
import { DISPOSITION_BY_ID, REMOVAL_LEVEL_BY_ID, REMOVAL_SCOPE_BY_ID } from "@/lib/storymap/frameworks";
import type { Card } from "@/lib/storymap/types";

export function CardRetirement({ boardId, card }: { boardId: string; card: Card }) {
  const router = useRouter();
  const r = card.retirement;
  const [plan, setPlan] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getRetirePlanAction({ boardId, cardId: card.id }).then((res) => {
      if (alive && res.ok && res.data) setPlan(res.data.markdown);
    });
    return () => {
      alive = false;
    };
  }, [boardId, card.id]);

  if (!r) return null;

  const disp = DISPOSITION_BY_ID[r.disposition];
  const lvl = r.level ? REMOVAL_LEVEL_BY_ID[r.level] : null;
  const pendingDataApproval = r.level === "excluir-tudo" && !r.dataDeletionApproved;

  const revive = async () => {
    setBusy(true);
    setMsg(null);
    const res = await reviveCardAction({ boardId, cardId: card.id });
    setBusy(false);
    if (res.ok) {
      setMsg({ kind: "ok", text: "Card revivido — voltou para o pipeline." });
      router.refresh();
    } else setMsg({ kind: "err", text: res.error });
  };

  const approveData = async () => {
    setBusy(true);
    setMsg(null);
    const res = await approveDataDeletionAction({ boardId, cardId: card.id });
    setBusy(false);
    if (res.ok) {
      setMsg({ kind: "ok", text: "Exclusão de dados aprovada — o agente está executando o corte." });
      router.refresh();
    } else setMsg({ kind: "err", text: res.error });
  };

  return (
    <section className="my-3 rounded-lg border border-line bg-surface">
      <div className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold text-fg-muted">
        <Archive className="h-4 w-4 text-fg-subtle" />
        Descontinuação
        <span
          className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
          style={{ backgroundColor: disp?.color ?? "#71717a" }}
        >
          {disp?.name ?? "Arquivado"}
        </span>
      </div>
      <div className="border-t border-line-muted p-3">
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-muted">{r.brief}</p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
          {lvl && (
            <span className="rounded px-1.5 py-0.5 font-semibold text-white" style={{ backgroundColor: lvl.color }} title={lvl.short}>
              {lvl.name}
            </span>
          )}
          {r.scope.map((s) => (
            <span key={s} className="rounded bg-surface-hover px-1.5 py-0.5 font-medium text-fg-muted" title={REMOVAL_SCOPE_BY_ID[s]?.short}>
              {REMOVAL_SCOPE_BY_ID[s]?.name ?? s}
            </span>
          ))}
          {r.target && <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-fg-muted">{r.target}</span>}
          {r.openedAt && <span className="text-fg-subtle">· {r.openedAt}</span>}
        </div>

        {plan && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-fg-muted"
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Plano de remoção
            </button>
            {open && (
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-inset p-2 text-[11px] leading-relaxed text-fg-muted">
                {plan}
              </pre>
            )}
          </div>
        )}

        {r.level === "excluir-tudo" && (
          <div
            className={cn(
              "mt-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-snug",
              r.dataDeletionApproved
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
            )}
          >
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {r.dataDeletionApproved
                ? "Exclusão de dados de produção APROVADA — o corte irreversível está liberado."
                : "“Excluir tudo” apaga dados de produção (irreversível). O agente removeu o código e pausou; aprove para liberar o corte de dados."}
            </span>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {disp?.revivable && (
            <button
              type="button"
              onClick={revive}
              disabled={busy}
              title="Reviver — devolve este card postergado ao pipeline, de onde saiu"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reviver
            </button>
          )}
          {pendingDataApproval && (
            <button
              type="button"
              onClick={approveData}
              disabled={busy}
              title="Aprovar o corte irreversível de dados de produção — re-dispara o harness-retire"
              className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300"
            >
              <Trash2 className="h-3.5 w-3.5" /> Aprovar exclusão de dados
            </button>
          )}
        </div>

        {msg && (
          <p className={cn("mt-2 text-[11px] leading-snug", msg.kind === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-300")}>
            {msg.text}
          </p>
        )}
      </div>
    </section>
  );
}
