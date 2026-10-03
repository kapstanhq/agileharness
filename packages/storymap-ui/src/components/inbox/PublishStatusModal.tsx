"use client";

// B13 / F4 — o STATUS DA PUBLICAÇÃO de um card, num modal só-leitura. O VEREDITO vem primeiro — o código deste card
// está no ar? sim / não / não medido —, depois o motivo (o aviso aberto) e o registro da publicação DESTE board (o
// job do registry do alvo). Antes era «Log da falha de deploy» com o log do build da própria ferramenta, para qualquer
// card, e o texto estourava a largura do celular. Nunca decide nada, nunca gera trilha D7.

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { getPublishStatusAction } from "@/app/actions";
import type { PublishStatus } from "@/lib/storymap/runner/publish-status";
import { dejargonText } from "@/lib/storymap/copilot/dejargon";
import { useOwnerTimeZone } from "@/components/OwnerTimeZone";

const VERDICT_CLS: Record<PublishStatus["verdict"]["state"], string> = {
  live: "border-emerald-600/40 bg-emerald-600/8 text-emerald-900 dark:text-emerald-200",
  "not-live": "border-rose-600/40 bg-rose-600/8 text-rose-800 dark:text-rose-200",
  "not-measured": "border-amber-500/40 bg-amber-500/8 text-amber-900 dark:text-amber-200",
};

const JOB_STATUS_LABEL: Record<"running" | "done" | "failed", string> = {
  running: "rodando agora",
  done: "terminou sem erro",
  failed: "terminou com falha",
};

/** «em 03/11 às 09:15» no fuso do DONO (o do Inbox) — nunca o ISO cru, nunca o fuso do navegador. */
function localWhen(iso: string | null | undefined, timeZone: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "em data desconhecida";
  const d = new Date(t);
  return `em ${d.toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "2-digit" })} às ${d.toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" })}`;
}

export function PublishStatusModal({ boardId, cardId, onClose }: { boardId: string; cardId: string; onClose: () => void }) {
  type LogState = { status: "loading" } | { status: "error"; error: string } | { status: "ok"; data: PublishStatus };
  const [state, setState] = useState<LogState>({ status: "loading" });
  const tz = useOwnerTimeZone();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getPublishStatusAction({ boardId, cardId });
      if (cancelled) return;
      if (res.ok && res.data) setState({ status: "ok", data: res.data });
      else setState({ status: "error", error: !res.ok ? res.error : "Não consegui carregar o status da publicação." });
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

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Status da publicação"
        className="max-h-[90vh] w-full min-w-0 max-w-2xl overflow-y-auto rounded-t-2xl border border-line bg-surface p-4 shadow-2xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-[15px] font-semibold text-fg">Status da publicação</p>
          <button type="button" onClick={onClose} className="min-h-11 rounded px-3 text-[13px] font-medium text-fg-muted transition hover:bg-surface-hover">
            Fechar
          </button>
        </div>
        {state.status === "loading" && <p className="text-[13px] text-fg-muted">Carregando…</p>}
        {state.status === "error" && <p className="break-words text-[13px] text-danger">{state.error}</p>}
        {state.status === "ok" && (
          <div className="min-w-0 space-y-3">
            <div className={cn("rounded-lg border px-3 py-2", VERDICT_CLS[state.data.verdict.state])}>
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] opacity-80">O código deste card está no ar?</p>
              <p className="mt-0.5 break-words text-[14px] font-medium">{state.data.verdict.text}</p>
            </div>
            {state.data.deployFiredAt && <p className="text-[13px] text-fg-muted">Publicação disparada {localWhen(state.data.deployFiredAt, tz)}.</p>}
            {state.data.finding && (
              <div>
                <p className="break-words text-[14px] font-medium text-fg">{dejargonText(state.data.finding.title)}</p>
                {state.data.finding.detail && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-fg-muted">{dejargonText(state.data.finding.detail)}</p>}
              </div>
            )}
            {state.data.logs.length === 0 ? (
              <p className="text-[13px] text-fg-subtle">Este board não tem uma publicação acompanhada pelo serviço — não há registro para mostrar aqui.</p>
            ) : (
              state.data.logs.map((log) => (
                <div key={log.target} className="min-w-0">
                  <p className="mb-1 text-[12px] font-medium text-fg-subtle">
                    Registro da publicação de {log.target}
                    {log.job ? ` — ${JOB_STATUS_LABEL[log.job.status]}` : ""}
                  </p>
                  {log.tail ? (
                    <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-inset px-2.5 py-2 font-mono text-[11px] leading-snug text-fg-muted">{log.tail}</pre>
                  ) : (
                    <p className="text-[12.5px] text-fg-subtle">Registro indisponível.</p>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
