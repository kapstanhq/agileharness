"use client";

// CapacityPanel — o painel do GOVERNADOR DE CAPACIDADE: a janela real da conta (7d, 5h), a cota de hoje contra
// o gasto, onde a semana termina no ritmo atual, quanto trabalho automático está retido, e a TRAVA — com o
// botão de soltar, que é do operador (a server action recusa qualquer outro chamador). Mora no popover do
// HealthPill (a barra de topo, em toda página) e no topo da página de Métricas.
//
// Toda decisão de texto/tom/"tem botão?" é de lib/vps/capacity-view.ts (puro, testado); aqui só se desenha,
// com as MESMAS primitivas do popover de uso (NavPopoverMeter) para a régua ser uma só.

import { useState } from "react";
import { Lock, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { NavPopoverMeter } from "@/components/nav/NavShell";
import { clearCapacityLatchAction } from "@/app/actions";
import { capacityView, type CapacityRow } from "@/lib/vps/capacity-view";
import type { GovernorSnapshot } from "@/lib/storymap/runner/capacity-governor";

const TONE_INK = {
  idle: "text-fg-muted",
  attention: "text-amber-700 dark:text-amber-300",
  danger: "text-rose-600 dark:text-rose-300",
} as const;

export function CapacityPanel({
  snapshot,
  omit = [],
  className,
}: {
  snapshot: GovernorSnapshot | null | undefined;
  /** linhas que o contêiner já mostra (o popover de uso já desenha 7d e 5h) */
  omit?: CapacityRow["key"][];
  className?: string;
}) {
  // O retrato devolvido por uma ação (soltar) vence o do SSE até o próximo quadro chegar.
  const [override, setOverride] = useState<GovernorSnapshot | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = override && snapshot && override.at >= snapshot.at ? override : snapshot;
  const view = capacityView(current, Date.now());
  if (!view) {
    return <p className={cn("text-[11px] text-fg-subtle", className)}>Governador de capacidade indisponível.</p>;
  }

  const clear = async () => {
    setBusy(true);
    setError(null);
    const r = await clearCapacityLatchAction({ reason });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.data) setOverride(r.data.snapshot);
    setAsking(false);
    setReason("");
  };

  const Icon = view.latch ? Lock : view.tone === "idle" ? ShieldCheck : ShieldAlert;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-start gap-1.5">
        <Icon className={cn("mt-px h-3.5 w-3.5 shrink-0", TONE_INK[view.tone])} aria-hidden />
        <div className="min-w-0">
          <p className={cn("text-[12px] font-medium", TONE_INK[view.tone])}>{view.headline}</p>
          <p className="text-[10px] leading-snug text-fg-subtle">
            {view.detail}
            {view.retry ? ` — ${view.retry}` : ""}
          </p>
        </div>
      </div>

      {view.rows
        .filter((r) => !omit.includes(r.key))
        .map((r) =>
          r.pct == null ? (
            <div key={r.key} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-fg-muted">{r.label}</span>
              <span className="font-medium tabular-nums text-fg-muted">{r.value}</span>
            </div>
          ) : (
            <NavPopoverMeter key={r.key} label={r.label} pct={r.pct} value={r.value} muted={r.muted} />
          ),
        )}

      {view.latch && (
        <div className="rounded-md bg-rose-500/10 px-2 py-1.5 text-[10px] leading-snug text-rose-700 dark:text-rose-300">
          <p>
            Trava {view.latch.level === "hard" ? "dura" : "mole"} por <code>{view.latch.by}</code> {view.latch.since}. Nenhum
            trabalho automático começa; o que você inicia segue normal.
          </p>
          {view.latch.halt ? (
            <p className="mt-1">É o arquivo HALT do host: ela sai apagando o arquivo lá, não por aqui.</p>
          ) : asking ? (
            <div className="mt-1.5 flex flex-col gap-1">
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Por que soltar? (fica registrado)"
                className="w-full rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-fg"
              />
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={busy || reason.trim().length < 3}
                  onClick={() => void clear()}
                  className="rounded bg-rose-600 px-2 py-0.5 text-[11px] font-medium text-white transition disabled:opacity-50"
                >
                  {busy ? "Soltando…" : "Soltar trava"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAsking(false);
                    setError(null);
                  }}
                  className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover"
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            view.canClear && (
              <button
                type="button"
                onClick={() => setAsking(true)}
                className="mt-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
              >
                Soltar trava…
              </button>
            )
          )}
          {error && <p className="mt-1 font-medium">{error}</p>}
        </div>
      )}
    </div>
  );
}
