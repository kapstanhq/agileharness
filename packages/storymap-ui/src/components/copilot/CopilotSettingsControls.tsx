"use client";

// F3 — controles COMPARTILHADOS entre o popover do header (CopilotQuickSettings) e a config page
// (CopilotConfigPanel), p/ as duas superfícies NUNCA divergirem: o editor da matriz de risco (grava via
// setBoardRiskMatrixAction) e os selects de model/effort do chat. RTL de render está quebrado (rolldown) →
// a lógica pura (dispositionsFor) é testável e a UI valida por dogfood.

import { useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { setBoardRiskMatrixAction } from "@/app/actions";
import { RISK_CLASSES, type RiskClass, type RiskDisposition } from "@/lib/storymap/types";
import { dispositionsFor } from "@/lib/storymap/copilot/risk-ui";
import { composeModel, splitModelVariant } from "@/lib/storymap/copilot/copilot-status";

const CLASS_LABEL: Record<RiskClass, string> = {
  read: "ler",
  "idea-write": "escrever numa ideia",
  "doc-write": "escrever num documento",
  "write-board": "escrever no board",
  "reversible-delete": "excluir (lixeira 7d)",
  run: "rodar a skill da coluna",
  session: "gerir o próprio worktree",
  "merge-resolve": "resolver merge",
  "peer-review": "revisão por par",
  deploy: "publicar em produção",
  "run-free": "abrir terminal / rodar comando",
  destructive: "apagar dados / aprovar",
};
const DISPOSITION_LABEL: Record<RiskDisposition, string> = { auto: "automático", ask: "pergunta", never: "nunca" };

export function ChatModelEffort({
  model,
  effort,
  onModel,
  onEffort,
  disabled,
}: {
  model: string;
  effort: string;
  onModel: (m: string) => void;
  onEffort: (e: string) => void;
  disabled?: boolean;
}) {
  const sel = "rounded-lg border border-line bg-inset px-2 py-1 text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50";
  // O CLI trata contexto longo como uma VARIANTE do id do modelo (`opus[1m]`) — um `--model opus` seco roda na
  // janela de 200k. Aqui isso vira DUAS escolhas independentes (modelo, janela) em vez de um select com o
  // produto cartesiano; o id composto é o que vai para o spawn — e é dele que a barra de contexto tira o teto.
  const { base, long } = splitModelVariant(model);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={sel}
        value={base}
        onChange={(e) => onModel(composeModel(e.target.value, long))}
        disabled={disabled}
        aria-label="modelo do chat"
      >
        <option value="sonnet">sonnet</option>
        <option value="opus">opus</option>
      </select>
      <select className={sel} value={effort} onChange={(e) => onEffort(e.target.value)} disabled={disabled} aria-label="effort do chat">
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh</option>
      </select>
      <label
        className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[12px] font-medium transition",
          long ? "border-accent/40 bg-accent/10 text-accent" : "text-fg-subtle hover:text-fg",
          disabled && "cursor-not-allowed opacity-50",
        )}
        title="Contexto longo: roda a variante de 1M do modelo (o CLI a pede pelo sufixo [1m]). Sem isto a janela é 200k."
      >
        <input
          type="checkbox"
          className="h-3 w-3 accent-current"
          checked={long}
          disabled={disabled}
          onChange={(e) => onModel(composeModel(base, e.target.checked))}
        />
        1M
      </label>
    </div>
  );
}

/**
 * Editor da matriz de risco de UM board. Recebe a matriz RESOLVIDA (toda classe preenchida) + os warnings do
 * lint; grava a matriz inteira via setBoardRiskMatrixAction (que re-linta server-side). deploy/destructive (e,
 * após F5.0, run/merge-resolve) só oferecem ask/never — o clamp do kernel fica VISÍVEL, não só silencioso.
 */
export function RiskMatrixEditor({
  boardId,
  resolved,
  warnings,
  onSaved,
}: {
  boardId: string;
  resolved: Record<RiskClass, RiskDisposition>;
  warnings: string[];
  onSaved?: () => void;
}) {
  const [matrix, setMatrix] = useState<Record<RiskClass, RiskDisposition>>(resolved);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = RISK_CLASSES.some((c) => matrix[c] !== resolved[c]);

  const set = (cls: RiskClass, disp: RiskDisposition) => {
    setMatrix((m) => ({ ...m, [cls]: disp }));
    setMsg(null);
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const res = await setBoardRiskMatrixAction({ boardId, riskMatrix: matrix });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Matriz salva. Vale no próximo tick." } : { ok: false, text: res.error });
    if (res.ok) onSaved?.();
  };

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-xs">
          <tbody>
            {RISK_CLASSES.map((cls) => {
              const opts = dispositionsFor(cls);
              const clamped = opts.length < 3; // deploy/destructive/run/merge-resolve — sem auto
              return (
                <tr key={cls} className="border-t border-line-muted first:border-t-0">
                  <td className="px-2.5 py-1.5 font-mono text-fg-muted">{CLASS_LABEL[cls]}</td>
                  <td className="px-2.5 py-1.5 text-right">
                    {cls === "read" ? (
                      <span className="text-fg-subtle">automático</span>
                    ) : (
                      <select
                        value={matrix[cls]}
                        onChange={(e) => set(cls, e.target.value as RiskDisposition)}
                        disabled={busy}
                        className="rounded-md border border-line bg-inset px-2 py-1 text-[12px] text-fg outline-none focus:border-accent disabled:opacity-50"
                        title={clamped ? "Ação irreversível/perigosa: sempre escala para o humano (sem automático)" : undefined}
                      >
                        {opts.map((d) => (
                          <option key={d} value={d}>
                            {DISPOSITION_LABEL[d]}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {warnings.length > 0 && (
        <ul className="space-y-1">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-semibold text-surface transition hover:bg-fg/85 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          Salvar matriz
        </button>
        {msg && (
          <span className={cn("text-[11px] font-medium", msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300")}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
