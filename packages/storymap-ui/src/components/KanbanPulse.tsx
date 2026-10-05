"use client";

// O PULSO do board — UMA linha no topo do Kanban que responde ao pedido do operador: «deve ficar claro quantos
// agentes estão rodando de fato, e quais cards». «● 2 agentes agindo · 6 na fila · vagas 2/2 · 8 precisam de você», e
// embaixo a legenda das cores com quantos CARDS estão em cada uma — clicável, para ver só aqueles cards.
//
// Nada aqui decide, e cada número tem UMA fonte:
//   • agentes e fila — agentPulse sobre a presença da página (useAgentPresence), a MESMA conta do «Agentes N» do nav,
//     recortada neste board. Antes o pulso contava os CARDS pintados de «Agindo»: um condutor trabalhando num card em
//     Decidir, ou esperando o train no PUBLICAR, dava «Agentes 1» no nav e «0 agindo» aqui;
//   • a legenda — countPresence sobre as linhas de estado do board (useBoardLiveStatuses, a MESMA que cada card
//     desenha): conta CARDS por cor, e diz isso («Cards»). Todo card azul tem um agente trabalhando nele;
//   • o número do dono — o do Inbox.
//
// É a ÚNICA região viva (`role=status`) do board: o card não anuncia nada sozinho (60 regiões vivas faziam o leitor de
// tela recitar o board a cada quadro do SSE).

import { cn } from "@/lib/cn";
import { agentPulse } from "@/lib/storymap/agent-presence";
import { countPresence, type CardLiveStatus, type CardPresence } from "@/lib/storymap/card-live-status";
import { LEGEND_ORDER, PRESENCE_TONE, STATE_PULSE } from "@/lib/storymap/presence-tone";
import { useAgentPresence } from "./RunnerStatusProvider";

/** O ponto da legenda: a mesma forma e cor do ponto do card (a fila, tracejada, entra no «parado ou na fila»). */
function LegendMark({ presence }: { presence: CardPresence }) {
  const t = PRESENCE_TONE[presence];
  if (t.mark === "none") return <span aria-hidden className={cn("text-[10px] font-bold", t.text)}>✓</span>;
  return <span aria-hidden className={cn("h-[7px] w-[7px] shrink-0 rounded-full", t.dot)} />;
}

export function KanbanPulse({
  boardId,
  statuses,
  ownerTotal,
  filter,
  onFilter,
}: {
  boardId: string;
  /** as linhas de estado dos cards do board (useBoardLiveStatuses). */
  statuses: ReadonlyMap<string, CardLiveStatus | null>;
  /** quantas decisões o Inbox tem em Decidir neste board; null enquanto não se sabe. */
  ownerTotal: number | null;
  /** a presença filtrada (null = todas). */
  filter: CardPresence | null;
  onFilter: (next: CardPresence | null) => void;
}) {
  const { presence } = useAgentPresence();
  const pulse = agentPulse(presence, boardId);
  const cards = countPresence(statuses.values());
  const slots = pulse.slots[0] ?? null;
  const working = pulse.working;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line-muted px-4 py-2 text-[12px]">
      <p role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium text-fg">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", working > 0 ? cn("bg-state-working", STATE_PULSE) : "border-[1.5px] border-state-idle")} aria-hidden />
        <span className="tabular-nums">
          {working} {working === 1 ? "agente agindo" : "agentes agindo"}
        </span>
        <span className="text-fg-subtle">·</span>
        <span className="tabular-nums" title="Cards esperando uma vaga de agente">
          {pulse.queued} {pulse.queued === 1 ? "card" : "cards"} na fila
        </span>
        {slots && (
          <>
            <span className="text-fg-subtle">·</span>
            <span className="tabular-nums" title={slots.extra && !slots.extra.open && slots.extra.why ? `Vaga extra fechada: ${slots.extra.why}` : undefined}>
              vagas {slots.used}/{slots.max}
            </span>
          </>
        )}
        <span className="text-fg-subtle">·</span>
        <span className="tabular-nums">{ownerTotal == null ? "…" : ownerTotal} {ownerTotal === 1 ? "precisa" : "precisam"} de você</span>
      </p>
      {/* A LEGENDA: cada cor com o que quer dizer e quantos CARDS estão nela agora. Um toque mostra só aqueles cards. O
          rótulo «Cards» separa esta conta da de agentes ao lado: um card em Decidir com o condutor trabalhando é âmbar. */}
      <div className="flex flex-wrap items-center gap-1">
        <span aria-hidden className="text-[10.5px] font-medium uppercase tracking-wide text-fg-subtle">
          Cards
        </span>
        <ul className="flex flex-wrap items-center gap-1" aria-label="Legenda das cores: quantos cards em cada uma — toque para filtrar">
          {LEGEND_ORDER.map((p) => {
            const n = cards[p];
            const on = filter === p;
            return (
              <li key={p}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={n === 0 && !on}
                  onClick={() => onFilter(on ? null : p)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] transition disabled:opacity-40",
                    on ? "bg-surface-hover font-semibold text-fg ring-1 ring-inset ring-line-emphasis" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                  )}
                >
                  <LegendMark presence={p} />
                  {PRESENCE_TONE[p].legend}
                  <span className="tabular-nums text-fg-subtle">{n}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
