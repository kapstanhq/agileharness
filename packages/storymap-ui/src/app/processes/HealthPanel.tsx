// «Saúde da ferramenta» — os 12 sinais do relatório de saúde, um por linha: bolinha de nível, o nome, o nível em
// palavras, o valor e UMA linha do que o número diz hoje. SERVER component: desenha o modelo que a página montou da
// ÚLTIMA leitura gravada (health/health-view.ts) — não mede, não busca, não tem estado.
//
// Cor só nos tokens de estado (globals.css `--state-*`/`--danger`), sempre com forma e palavra junto: verde é o ✓, atenção
// e vermelho são ponto cheio, não medível é círculo vazio. O âmbar do «precisa de você» não aparece aqui de propósito: um
// sinal de saúde é trabalho do sistema, e a tela diz isso (HEALTH_TONE explica a escolha).

import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { HEALTH_TONE, type HealthPanelModel } from "@/lib/storymap/health/health-view";

export function HealthPanel({ model }: { model: HealthPanelModel }) {
  // Leitura velha ou tick desligado é o PRÓPRIO medidor falhando — aviso na tinta de falha. «Sem leitura ainda» é só espera.
  const noteTone = model.state === "stale" || model.state === "off" ? "text-danger" : "text-fg-muted";
  return (
    <section aria-labelledby="saude-da-ferramenta" className="mb-8 rounded-lg border bg-surface">
      <header className="border-b px-4 py-3">
        <h2 id="saude-da-ferramenta" className="text-sm font-semibold text-fg">
          Saúde da ferramenta
        </h2>
        <p className="mt-0.5 text-[13px] text-fg">{model.headline}</p>
        {model.note ? <p className={cn("mt-1 text-[12.5px]", noteTone)}>{model.note}</p> : null}
        <p className="mt-1 text-[12px] text-fg-subtle">Trabalho do sistema: nada aqui pede você.</p>
      </header>
      <ul className="divide-y divide-line-muted">
        {model.rows.map((row) => {
          const tone = HEALTH_TONE[row.level];
          return (
            <li key={row.id} title={row.rule} className="flex items-start gap-3 px-4 py-2">
              <span aria-hidden className="mt-[5px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {tone.mark === "check" ? <Check className={cn("h-3.5 w-3.5", tone.text)} /> : <span className={cn("block h-2.5 w-2.5 rounded-full", tone.dot)} />}
              </span>
              <span className="mt-px w-8 shrink-0 font-mono text-[12px] text-fg-subtle">{row.id}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] text-fg">
                  <span>{row.label}</span>
                  <span className={cn("text-[12.5px] font-medium", tone.text)}>{row.levelText}</span>
                  <span className="text-[12.5px] text-fg-muted">· {row.valueText}</span>
                </p>
                {row.detail ? <p className="text-[12.5px] text-fg-muted">{row.detail}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
