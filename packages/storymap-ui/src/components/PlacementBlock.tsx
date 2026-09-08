"use client";

// "Posição no mapa": o bloco do drawer que mostra ONDE o card vive na hierarquia — e, quando ele está
// fora dela, o que falta decidir.
//
// A antiga saída de emergência "Aceitar sem lugar" (ackUnplacedAction → unplacedAck) foi APOSENTADA.
// Ela era o que deixava um card atravessar o pipeline inteiro sem lugar: 83 dos 304 cards do repo
// acabaram assim. Hoje a invariante é imposta na ESCRITA (write.ts → placementViolation), então não
// existe mais "aceitar" — existe decidir o pai. Este bloco aponta para a decisão; quem grava é o
// picker de Pai/Serve do formulário de edição.
//
// `unplacedAck` sobrevive apenas como marca HISTÓRICA nos cards antigos (é exibida quando presente) —
// nada a escreve mais.

import { MapPin } from "lucide-react";
import { cn } from "@/lib/cn";
import { isDeliveryStory } from "@/lib/storymap/unplaced";
import { placementViolation } from "@/lib/storymap/gate-core";
import {
  buildCardNeighborhood,
  existingCardLabel,
  type ArchitectureNode,
} from "@/lib/storymap/smart-capture/architecture-tree";
import type { BoardConfig, Card, CardProvenance } from "@/lib/storymap/types";

const VIA_LABEL: Record<CardProvenance, string> = {
  mcp: "criado por agente (MCP)",
  capture: "captura inteligente",
  triage: "triagem",
  ui: "manual (UI)",
  skill: "skill",
};

export function PlacementBlock({
  card,
  cards,
  config,
  onOpenCard,
}: {
  card: Card;
  /** board pool — resolve parent/serves ids to readable titles AND validate the anchor. */
  cards: Card[];
  /** o board resolvido: sem ele a invariante só consegue checar a FORMA da âncora. */
  config: BoardConfig;
  /** abrir outro card da vizinhança (o drawer troca de card). Sem isto, a árvore é só leitura. */
  onOpenCard?: (id: string) => void;
}) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  // A MESMA regra do gate e da escrita — aqui ela serve para explicar, não para bloquear.
  const violation = placementViolation(card, (id) => byId.get(id) ?? null, config);
  const neighborhood = buildCardNeighborhood(card.id, cards, config);

  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <MapPin className="h-3 w-3" />
          Posição no mapa
        </span>
        {card.via && <span className="text-[10px] text-fg-subtle">{VIA_LABEL[card.via]}</span>}
      </div>

      {/* A ÁRVORE, não duas linhas de texto. "Pai (step): — / Serve: X" obrigava o operador a montar
          a hierarquia de cabeça e não dizia nada sobre a vizinhança. O desenho responde de um olhar
          onde este card vive, quem mais vive aqui e o que pende dele — é a MESMA árvore da revisão de
          captura (architecture-tree), agora centrada num card existente. */}
      {neighborhood.length > 0 ? (
        <ul className="space-y-0.5">
          {neighborhood.map((n) => (
            <NeighborRow key={n.key} node={n} depth={0} focusId={card.id} onOpenCard={onOpenCard} />
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-fg-subtle">Ainda sem lugar no mapa.</p>
      )}

      {card.unplacedAck && (
        <p className="text-[11px] text-fg-muted">
          <span className="text-fg-subtle">Legado — aceito sem lugar: </span>
          {card.unplacedAck.by} · {card.unplacedAck.at}
        </p>
      )}

      {violation && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="text-[12px] leading-snug text-amber-800 dark:text-amber-300">
            {violation.message} Edite o card acima para corrigir —{" "}
            {isDeliveryStory(card)
              ? "uma entrega vive sob a user story que ela serve."
              : "uma user story vive sob o passo que ela detalha."}
          </p>
        </div>
      )}
    </div>
  );
}

/** Uma linha da vizinhança. O card em FOCO é o único destacado — o resto é contexto. */
function NeighborRow({
  node,
  depth,
  focusId,
  onOpenCard,
}: {
  node: ArchitectureNode;
  depth: number;
  focusId: string;
  onOpenCard?: (id: string) => void;
}) {
  const c = node.card!;
  const isFocus = c.id === focusId;
  return (
    <li>
      <div
        className={cn(
          "flex items-baseline gap-1.5 rounded px-1 py-0.5 text-[12px] leading-snug",
          isFocus ? "bg-accent/10 font-medium text-fg" : "text-fg-muted",
        )}
        style={{ marginLeft: depth * 14 }}
      >
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-subtle">
          {existingCardLabel(c)}
        </span>
        {isFocus ? (
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
        ) : onOpenCard ? (
          <button
            type="button"
            onClick={() => onOpenCard(c.id)}
            className="min-w-0 flex-1 truncate text-left transition hover:text-fg hover:underline"
            title={`Abrir «${c.title}»`}
          >
            {c.title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
        )}
        {isFocus && <span className="shrink-0 text-[10px] text-accent">este card</span>}
      </div>
      {node.children.map((child) => (
        <ul key={child.key} className="space-y-0.5">
          <NeighborRow node={child} depth={depth + 1} focusId={focusId} onOpenCard={onOpenCard} />
        </ul>
      ))}
    </li>
  );
}
