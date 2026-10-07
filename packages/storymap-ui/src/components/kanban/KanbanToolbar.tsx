"use client";

// A 2ª BARRA do Kanban (52px, só no Kanban), da esquerda para a direita:
//   Ritmo (KanbanPaceControl) · Atividade (ActivityChip) · espaço · Busca (KanbanSearchBox) · Mostrar (KanbanFilterMenu).
// Controlada: o Kanban guarda a busca, o recorte, as contagens e o RITMO do board (uma leitura só, `useKanbanBoardPace`,
// que serve à pílula, ao «Mostrar» — onde «Rodando» vira «Pausado» — e ao quadro: pausar aqui para a esteira e pinta as
// caixinhas na mesma hora, sem esperar a próxima batida de uma segunda leitura).
//
// No celular a barra quebra em duas linhas: [ritmo] [atividade como ícone] / [busca na largura toda] [Mostrar] — alvos
// de toque de 40px, e nada aqui cria rolagem horizontal da página.

import { resolveConductorPolicy } from "@/lib/storymap/driver";
import type { BoardConfig } from "@/lib/storymap/types";
import { ActivityChip } from "./ActivityChip";
import { KanbanFilterMenu } from "./KanbanFilterMenu";
import { KanbanPaceControl, type KanbanBoardPace } from "./KanbanPaceControl";
import { KanbanSearchBox } from "./KanbanSearchBox";

/** O que o filtro "Mostrar" do Kanban escolhe. `exc` = Exceções (o padrão). */
export { KANBAN_DEFAULT_MODE, isKanbanShowMode, type KanbanShowMode } from "./show-mode";
import type { KanbanShowMode } from "./show-mode";

export interface KanbanToolbarProps {
  boardId: string;
  config: BoardConfig;
  query: string;
  onQuery: (q: string) => void;
  mode: KanbanShowMode;
  onMode: (m: KanbanShowMode) => void;
  /** Contagem por modo para a lista do filtro (ausente = sem número); `waiting`/`forgotten` = o que «Na fila» inclui. */
  counts: Partial<Record<KanbanShowMode | "waiting" | "forgotten", number>>;
  /** Condutores trabalhando de fato agora / vagas de condutor do board. */
  agentsUsed: number;
  slots: number;
  /** O ritmo do board, lido pelo Kanban (`useKanbanBoardPace`) — o mesmo que o quadro usa. */
  pace: KanbanBoardPace;
  /** A pessoa clicou num card na atividade: o Kanban busca/realça esse card. */
  onFocusCard?: (cardId: string, title: string) => void;
}

export function KanbanToolbar({ boardId, config, query, onQuery, mode, onMode, counts, agentsUsed, slots, pace, onFocusCard }: KanbanToolbarProps) {
  const hasConductor = resolveConductorPolicy(config) !== null;
  const paused = pace.view?.level === "paused" && pace.view.source !== "disarmed" && pace.view.source !== "organize-only";
  // Sem quem realce, clicar no card de uma linha da atividade busca pelo título (o protótipo faz exatamente isso).
  const focusCard = onFocusCard ?? ((_id: string, title: string) => onQuery(title));

  return (
    <div
      role="toolbar"
      aria-label="Controles do Kanban"
      className="flex flex-none flex-wrap items-center gap-2 border-b border-line-muted bg-surface px-4 py-2 md:h-[52px] md:flex-nowrap md:py-0"
    >
      <KanbanPaceControl
        boardId={boardId}
        view={pace.view}
        failed={pace.failed}
        onChanged={pace.setView}
        onOpen={() => void pace.reload()}
        agentsUsed={agentsUsed}
        slots={slots}
        hasConductor={hasConductor}
      />
      <ActivityChip boardId={boardId} onFocusCard={focusCard} className="ml-auto flex-none md:ml-1 md:flex-[0_1_420px]" />
      <span aria-hidden className="hidden flex-1 md:block" />
      <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
        <KanbanSearchBox value={query} onChange={onQuery} className="flex-1 md:w-[260px] md:flex-none" />
        <KanbanFilterMenu mode={mode} onMode={onMode} counts={counts} paused={paused} />
      </div>
    </div>
  );
}
