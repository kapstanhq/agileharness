"use client";

// Os selects de model/effort do chat do Jido — COMPARTILHADOS entre a engrenagem da conversa (CopilotChatControls) e
// a aba Jido da configuração (JidoRuntimePanel), p/ as duas superfícies NUNCA divergirem. (O editor da matriz de
// risco que morava aqui saiu na fase 4: a autonomia é o controle único da barra do topo — shell/AutonomyControl.)

import { cn } from "@/lib/cn";
import { composeModel, splitModelVariant } from "@/lib/storymap/copilot/copilot-status";

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
