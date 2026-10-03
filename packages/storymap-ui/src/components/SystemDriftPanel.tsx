"use client";

// SystemDriftPanel — the Inbox surface for "🔄 sistemas mudaram desde o último sync" (story
// system-resync, "detectar + 1 clique"). Detection is automatic and cheap (a server-side `git log` per
// anchored system, via detectSystemDriftAction); the agent only runs when the operator clicks
// "Sincronizar" (controls token spend). One click → the sincronizar agent reads the real code → diff →
// Aprovar (stampSystemPromptAction writes the new prompt AND re-anchors syncedCommit=HEAD, clearing the
// drift). Lazy + self-contained: lives inside the Inbox's «Acompanhar» section, fetches on mount + on SSE (debounced),
// and renders NOTHING when nothing drifted — so it never adds noise to a quiet board.

import { useCallback, useEffect, useRef, useState } from "react";
import { sharedEventSource } from "@/lib/sse-bus";
import { Check, Loader2, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  detectSystemDriftAction,
  requestAssistedEditAction,
  stampSystemPromptAction,
} from "@/app/assisted-edit-actions";
import type { SystemDrift } from "@/lib/storymap/system-drift";

export function SystemDriftPanel({ boardId, boardName }: { boardId: string; /** no Inbox de todos os boards, de qual board é a linha. */ boardName?: string }) {
  const [drift, setDrift] = useState<SystemDrift[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await detectSystemDriftAction({ boardId });
    if (res.ok && res.data) setDrift(res.data.drift);
    setLoaded(true);
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A merge (code landing on main) is what moves HEAD and creates drift — refetch on SSE, debounced
  // generously so a burst of board mutations triggers at most one git sweep.
  useEffect(() => {
    const es = sharedEventSource("/api/notifications/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(t);
      t = setTimeout(() => void load(), 2500);
    };
    es.addEventListener("agileharness", refresh as EventListener);
    return () => {
      clearTimeout(t);
      es.close();
    };
  }, [load]);

  if (!loaded || drift.length === 0) return null;

  // Onda 2 do Inbox (F16): o drift é ACOMPANHAR — uma linha recolhida, nunca nove botões verdes acima do «nada para
  // você decidir». Sincronizar roda um agente (gasta uso da conta), por isso o botão é discreto e a linha diz o custo.
  const n = drift.length;
  return (
    <details className="group rounded-xl border border-line bg-surface" data-inbox-drift>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-2.5">
        <RefreshCw className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 text-[14px] text-fg">
          {boardName ? `${boardName}: ` : ""}
          {n === 1 ? "1 descrição de sistema pode estar desatualizada" : `${n} descrições de sistema podem estar desatualizadas`}
        </span>
        <span className="text-[12px] text-fg-subtle group-open:hidden">ver</span>
      </summary>
      <div className="border-t border-line-muted px-4 py-3">
        <p className="mb-2 text-[12.5px] leading-snug text-fg-muted">
          O código {n === 1 ? "deste sistema mudou" : "destes sistemas mudou"} desde a última descrição que os agentes leem. Se ignorar, os
          agentes seguem lendo a descrição antiga. «Sincronizar» roda um agente que lê o código atual (gasta uso da conta) e mostra a
          descrição nova para você aprovar.
        </p>
        <ul className="space-y-2">
          {drift.map((d) => (
            <SystemDriftRow key={d.systemId} boardId={boardId} drift={d} onSynced={load} />
          ))}
        </ul>
      </div>
    </details>
  );
}

function SystemDriftRow({
  boardId,
  drift,
  onSynced,
}: {
  boardId: string;
  drift: SystemDrift;
  onSynced: () => void;
}) {
  const [proposal, setProposal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const sync = async () => {
    setBusy(true);
    setError(null);
    const context = `Foque nos arquivos deste sistema: ${drift.paths.join(", ")}.`;
    const res = await requestAssistedEditAction({
      kind: "system",
      mode: "sincronizar",
      label: drift.name,
      current: drift.prompt,
      instruction: "",
      context,
    });
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok && res.data?.proposal) setProposal(res.data.proposal);
    else setError(res.ok ? "O agente não retornou uma resposta." : res.error);
  };

  const approve = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    const res = await stampSystemPromptAction({ boardId, systemId: drift.systemId, prompt: proposal });
    if (!mounted.current) return;
    setBusy(false);
    if (res.ok) {
      setProposal(null);
      onSynced();
    } else {
      setError(res.error);
    }
  };

  return (
    <li className="rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-fg">{drift.name}</span>
        <span className="font-mono text-[10px] text-fg-subtle">{drift.systemId}</span>
        <span className="ml-auto text-[11px] text-fg-subtle">
          {drift.baseInvalid
            ? "base inválido — re-sincronize"
            : `${drift.commits.length} commit${drift.commits.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Por quê — os commits que mexeram no código do sistema desde o último sync */}
      {drift.commits.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {drift.commits.slice(0, 5).map((c) => (
            <li key={c.sha} className="flex gap-1.5 text-[11px] text-fg-muted">
              <span className="font-mono text-fg-subtle">{c.sha}</span>
              <span className="min-w-0 flex-1 truncate">{c.subject}</span>
            </li>
          ))}
          {drift.commits.length > 5 && (
            <li className="text-[10px] text-fg-subtle">… +{drift.commits.length - 5} outro(s)</li>
          )}
        </ul>
      )}

      {proposal === null ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={sync}
            disabled={busy}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line px-3 text-[13px] font-medium text-fg transition hover:bg-surface-hover disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {busy ? "Lendo o código…" : "Sincronizar"}
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <DiffBlocks before={drift.prompt} after={proposal} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={approve}
              disabled={busy}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-fg transition enabled:hover:bg-primary-hover disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Aprovar
            </button>
            <button
              type="button"
              onClick={() => setProposal(null)}
              disabled={busy}
              className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-[13px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
            >
              Descartar
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-300">
          <X className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="flex-1 leading-snug">{error}</span>
        </p>
      )}
    </li>
  );
}

function DiffBlocks({ before, after }: { before: string; after: string }) {
  const cell = "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md px-2 py-1.5 text-[11px] leading-snug";
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      <div>
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">Antes</p>
        <div className={cn(cell, "border border-rose-200 bg-rose-50/50 text-fg-muted dark:border-rose-500/30 dark:bg-rose-500/5")}>
          {before.trim() || <span className="italic text-fg-subtle">(vazio)</span>}
        </div>
      </div>
      <div>
        <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Depois</p>
        <div className={cn(cell, "border border-emerald-200 bg-emerald-50/50 text-fg dark:border-emerald-500/30 dark:bg-emerald-500/5")}>
          {after.trim() || <span className="italic text-fg-subtle">(vazio)</span>}
        </div>
      </div>
    </div>
  );
}
