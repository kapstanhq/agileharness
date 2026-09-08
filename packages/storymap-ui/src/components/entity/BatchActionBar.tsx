"use client";

// <BatchActionBar> — barra de AÇÕES EM LOTE, sticky no rodapé de uma lista de entidades selecionáveis.
// Aparece só quando há ≥1 selecionado; mostra a contagem, "selecionar todas/limpar" e os botões de ação
// (derivados de batchActionsFor no container). Burra/controlada: o container injeta os onRun (fan-out via
// runBatch) e o estado de busy. Reutilizável no HUB da captura e na bancada de Ideias.

import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export interface BatchAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  tone?: "primary" | "danger" | "ghost";
  onRun: () => void;
  disabled?: boolean;
}

export function BatchActionBar({
  count,
  total,
  onSelectAll,
  onClear,
  actions,
  busy = false,
}: {
  count: number;
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  actions: BatchAction[];
  /** lote em andamento → desabilita as ações e mostra spinner. */
  busy?: boolean;
}) {
  if (count === 0) return null;
  // Posicionamento (sticky/fixed) é responsabilidade do container: na modal é uma faixa acima do rodapé;
  // na bancada é uma barra fixa no fundo da viewport. Aqui só o visual da barra.
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="flex items-center gap-2 text-[12px] text-fg-muted">
        <span className="font-semibold text-fg">
          {count} {count === 1 ? "selecionada" : "selecionadas"}
        </span>
        {count < total && (
          <button
            type="button"
            onClick={onSelectAll}
            className="rounded px-1.5 py-0.5 font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            Selecionar todas ({total})
          </button>
        )}
        <button
          type="button"
          onClick={onClear}
          className="rounded px-1.5 py-0.5 font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
        >
          Limpar
        </button>
      </div>
      <div className="flex items-center gap-2">
        {actions.map((a) => {
          const Icon = a.icon;
          const tone = a.tone ?? "ghost";
          const toneCls =
            tone === "primary"
              ? "bg-fg text-surface hover:bg-fg/85"
              : tone === "danger"
                ? "border border-line text-red-600 hover:border-red-300 hover:bg-red-500/10 dark:text-red-400"
                : "border border-line text-fg-muted hover:bg-surface-hover hover:text-fg";
          return (
            <button
              key={a.id}
              type="button"
              onClick={a.onRun}
              disabled={busy || a.disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition disabled:opacity-50",
                toneCls,
              )}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
