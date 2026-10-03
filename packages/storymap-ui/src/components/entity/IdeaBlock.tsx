"use client";

// <IdeaBlock> — o bloco REUTILIZÁVEL de uma ideia (dor do usuário, Card type:"idea").
// Compõe a primitiva <EntityRow> com os slots DERIVADOS PUROS do domínio OST: a contagem "N stories"
// (cardsAddressing — derivada do edge `addresses`, SEM campo novo no schema), o status-dot do ciclo de
// vida da dor e a recência. As AÇÕES vêm do registry declarativo (entity-actions) e são EXECUTADAS por
// handlers injetados pelo container — a modal liga "Gerar stories" ao caminho SÍNCRONO inline; a bancada
// ao ASSÍNCRONO → Inbox. Mesmo bloco nas 3 superfícies (modal HUB / bancada / futuro).

import { CheckCircle2 } from "lucide-react";
import { EntityRow, type EntityRowAction } from "@/components/entity/EntityRow";
import { cardsAddressing } from "@/lib/storymap/idea";
import { actionsFor, type EntityActionId } from "@/lib/storymap/entity-actions";
import { IDEA_STATUS_BY_ID, type IdeaStatus } from "@/lib/storymap/frameworks";
import type { Card } from "@/lib/storymap/types";

export interface EntityActionHandler {
  run: () => void;
  busy?: boolean;
  disabled?: boolean;
}

export function IdeaBlock({
  idea,
  pool,
  variant = "row",
  selectable = false,
  selected = false,
  selectionActive = false,
  onToggleSelect,
  ts,
  sent = false,
  handlers = {},
  onOpen,
}: {
  idea: Card;
  /** pool para contar as stories que endereçam a dor (board cards + criados na sessão). */
  pool: Card[];
  variant?: "row" | "card";
  selectable?: boolean;
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: () => void;
  /** recência pré-formatada (row variant) — null até o cliente montar (evita mismatch de TZ). */
  ts?: string | null;
  /** já despachada para o Inbox nesta sessão (lote assíncrono) → esconde "gerar" + mostra selo. */
  sent?: boolean;
  /** executores por id de ação; só os providos viram botão (HUB omite delete; bancada inclui). */
  handlers?: Partial<Record<EntityActionId, EntityActionHandler>>;
  onOpen?: () => void;
}) {
  const o = idea.idea ?? { statement: idea.title, evidence: null, status: "open" as IdeaStatus };
  const st = IDEA_STATUS_BY_ID[o.status] ?? IDEA_STATUS_BY_ID.open;
  const statement = o.statement || idea.title;
  const count = cardsAddressing(idea, pool).length;
  const solutions = o.candidateSolutions ?? [];

  // Ações: do registry, filtradas às que têm handler. Quando já enviada ao Inbox, esconde "gerar
  // stories" (evita re-disparo que criaria container/proposta duplicados). Spinner na que estiver `busy`.
  const descriptors = actionsFor(idea)
    .filter((a) => handlers[a.id])
    .filter((a) => !(sent && a.id === "generate-stories"));
  const actions: EntityRowAction[] = descriptors.map((a) => {
    const h = handlers[a.id]!;
    const label = a.id === "generate-stories" && count > 0 ? "Gerar mais tarefas" : a.label;
    return { id: a.id, label, icon: a.icon, tone: a.tone, onRun: h.run, disabled: h.disabled };
  });
  const busyActionId = descriptors.find((a) => handlers[a.id]?.busy)?.id ?? null;
  // No card (HUB) a navegação é uma AÇÃO explícita "Abrir ↗" (a casca-card não é clicável por inteiro,
  // para não aninhar o checkbox/botões num único alvo); na linha o onOpen já é o clique da própria linha.
  const cardActions: EntityRowAction[] =
    variant === "card" && onOpen ? [...actions, { id: "open", label: "Abrir ↗", tone: "ghost", onRun: onOpen }] : actions;

  if (variant === "card") {
    return (
      <EntityRow
        variant="card"
        tone="idea"
        typeLabel="Ideia"
        title={statement}
        selectable={selectable}
        checkState={selected ? "on" : "off"}
        selectionActive={selectionActive}
        onToggleSelect={onToggleSelect}
        chips={
          solutions.length > 0 ? (
            <span className="block text-[11px] leading-snug text-fg-muted">soluções: {solutions.slice(0, 3).join(" · ")}</span>
          ) : undefined
        }
        meta={
          sent ? (
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-accent">
              <CheckCircle2 className="h-3.5 w-3.5" /> Enviada ao Inbox
            </span>
          ) : count > 0 ? (
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {count} {count === 1 ? "story criada" : "stories criadas"}
            </span>
          ) : undefined
        }
        hint={sent || count > 0 ? undefined : "Próximo passo: gere as tarefas que executam esta ideia."}
        actions={cardActions}
        busyActionId={busyActionId}
      />
    );
  }

  return (
    <EntityRow
      variant="row"
      title={statement}
      selectable={selectable}
      checkState={selected ? "on" : "off"}
      selectionActive={selectionActive}
      onToggleSelect={onToggleSelect}
      leadingMeta={
        ts ? (
          <span className="hidden w-[88px] shrink-0 text-[11px] tabular-nums text-fg-subtle sm:inline" title="Quando chegou">
            {ts}
          </span>
        ) : undefined
      }
      meta={
        <span className="flex shrink-0 items-center gap-3 text-[11px] text-fg-muted">
          <span className="flex items-center gap-1.5" title={st.short}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: st.color }} />
            {st.name}
          </span>
          <span className="tabular-nums text-fg-subtle">
            {count} {count === 1 ? "story" : "stories"}
          </span>
        </span>
      }
      actions={actions}
      busyActionId={busyActionId}
      onOpen={onOpen}
    />
  );
}
