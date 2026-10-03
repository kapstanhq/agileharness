"use client";

// StyleDriftPanel — the "Guia ↔ código" section of the Publicado state (WS-4, D15). Lazy +
// self-contained: fetches styleGuideDriftAction on mount, renders NOTHING when the board has no
// package:/no guide ("não aplicável"), a green line when the guide and the code agree, or the list of
// exact mismatches + a "Sincronizar" CTA that opens the styleguide assistant in `sincronizar` mode
// (requestStyleGuideAssistAction) — a diff preview the operator must explicitly Aplicar
// (applyStyleGuideAssistAction, the SAME promotion core the approve chokepoint uses) before anything
// is written. REPORT-ONLY: this panel never auto-corrects the guide or the code (D15) — the mismatch
// list is always visible even while a sync proposal is pending review. Mirrors SystemDriftPanel.tsx's
// established detect → sincronizar → diff → Aprovar shape.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { applyStyleGuideAssistAction, requestStyleGuideAssistAction, styleGuideDriftAction } from "@/app/design-actions";
import { styleSectionLabel } from "@/lib/storymap/style-guide-blocks";
import type { StyleGuideDriftResult } from "@/app/design-actions";
import type { StyleGuideDiff, StyleGuideDoc } from "@/lib/storymap/style-guide";

export function StyleDriftPanel({ boardId }: { boardId: string }) {
  const [result, setResult] = useState<StyleGuideDriftResult | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await styleGuideDriftAction({ boardId });
    if (res.ok && res.data) setResult(res.data);
    setLoaded(true);
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  // "não aplicável" — nothing to audit (no package: or no guide yet). Quiet, like SystemDriftPanel.
  if (!loaded || !result || !result.applicable) return null;

  const clean = result.report.findings.length === 0;

  return (
    <div
      className={cn(
        "mb-3 rounded-xl border p-3",
        clean ? "border-emerald-400/30 bg-emerald-400/5" : "border-amber-400/40 bg-amber-400/5",
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        {clean ? (
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden />
        ) : (
          <RefreshCw className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" aria-hidden />
        )}
        <span
          className={cn(
            "text-[11px] font-semibold uppercase tracking-wide",
            clean ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400",
          )}
        >
          {clean
            ? "Guia ↔ código: sem drift"
            : `Guia ↔ código: ${result.report.findings.length} divergência${result.report.findings.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {!clean && (
        <ul className="mb-2 space-y-1">
          {result.report.findings.map((f, i) => (
            <li key={`${f.role}-${i}`} className="font-mono text-[11px] leading-snug text-fg-muted">
              <span className="font-semibold text-fg">{f.role}</span>{" "}
              {f.kind === "mismatch" && (
                <>
                  declarado <span className="text-fg">{f.declared}</span> · encontrado{" "}
                  <span className="text-fg">{f.found}</span> em {f.file}
                </>
              )}
              {f.kind === "missing-var" && <>declarado {f.declared} · variável ausente em {f.file}</>}
              {f.kind === "unreadable" && <>declarado {f.declared} · arquivo ilegível: {f.file}</>}
              {f.confidence === "low" && <span className="ml-1 italic text-fg-subtle">(heurístico)</span>}
            </li>
          ))}
        </ul>
      )}

      <SyncFlow boardId={boardId} clean={clean} onApplied={load} />

      <p className="mt-2 text-[10px] leading-snug text-fg-subtle">{result.note}</p>
    </div>
  );
}

function SyncFlow({ boardId, clean, onApplied }: { boardId: string; clean: boolean; onApplied: () => void }) {
  const [proposal, setProposal] = useState<{ doc: StyleGuideDoc; diff: StyleGuideDiff; baseVersion: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const sync = async () => {
    setBusy(true);
    setError(null);
    const res = await requestStyleGuideAssistAction({ boardId, mode: "sincronizar", instruction: "" });
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok && res.data?.kind === "proposal") {
      setProposal({ doc: res.data.doc, diff: res.data.diff, baseVersion: res.data.baseVersion });
    } else {
      setError(res.ok ? "O agente não retornou uma proposta." : res.error);
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    const res = await applyStyleGuideAssistAction({ boardId, doc: proposal.doc, baseVersion: proposal.baseVersion });
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok) {
      setProposal(null);
      onApplied();
    } else {
      setError(res.error);
    }
  };

  const noChanges =
    proposal != null && proposal.diff.changedSections.length === 0 && proposal.diff.colorTokenChanges.length === 0;

  return (
    <div className="space-y-2">
      {proposal === null ? (
        <button
          type="button"
          onClick={sync}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-40",
            clean
              ? "border border-line text-fg-muted enabled:hover:bg-surface-hover"
              : "bg-primary text-primary-fg enabled:hover:bg-primary-hover",
          )}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {busy ? "Investigando o código…" : "Sincronizar"}
        </button>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {proposal.diff.changedSections.map((key) => (
              <span key={key} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {styleSectionLabel(key)}
              </span>
            ))}
            {proposal.diff.colorTokenChanges.map((c) => (
              <span key={c.role} className="rounded-full bg-fg/10 px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                {c.role} ({c.kind === "added" ? "novo" : c.kind === "removed" ? "removido" : "alterado"})
              </span>
            ))}
            {noChanges && <span className="text-[11px] italic text-fg-subtle">nenhuma mudança proposta</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={busy || noChanges}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white transition enabled:hover:bg-emerald-700 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Aplicar
            </button>
            <button
              type="button"
              onClick={() => setProposal(null)}
              disabled={busy}
              className="rounded-md border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
            >
              Descartar
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-300">
          <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="flex-1 leading-snug">{error}</span>
        </p>
      )}
    </div>
  );
}
