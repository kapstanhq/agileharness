"use client";

import { MetaBadge } from "./FrameworkBadges";
import type { BoardConfig, Card } from "@/lib/storymap/types";

/**
 * Persona / system chip. A thin wrapper over the shared MetaBadge primitive so
 * persona/system tags share the exact same geometry and treatment as every other
 * label on the platform (a coloured chip = soft tinted fill + same-hue border +
 * coloured text; a colourless one falls back to the neutral pill).
 */
export function Chip({
  label,
  color,
  title,
  onRemove,
}: {
  label: string;
  color?: string;
  title?: string;
  onRemove?: () => void;
}) {
  return (
    <MetaBadge
      color={color}
      size="md"
      label={label}
      title={title ?? label}
      onRemove={onRemove}
      className="max-w-[160px]"
    />
  );
}

/**
 * O VOCABULÁRIO de um card na face dele — as personas e os sistemas, resolvidos contra o vocab do
 * board. Este bloco existia DUAS vezes, byte a byte igual, em `StoryCard` (o card do Mapa) e em
 * `KanbanCard`: o mesmo `find` por id, o mesmo fallback para o id cru quando a persona foi removida do
 * board, a mesma faixa de chips. Duas cópias significam que uma melhoria (mostrar a cor, ordenar,
 * truncar em N) chega em um card e não no outro — e o operador vê o mesmo dado com duas caras.
 *
 * Devolve `null` quando não há nada a mostrar, então o chamador não precisa repetir o teste de vazio.
 * O gate de "mostrar detalhes" (`showMeta`) fica no CHAMADOR de propósito: é preferência da view, não
 * do vocabulário.
 *
 * NOTA deliberada: a cor da persona/sistema NÃO é passada, embora `Chip` a aceite — as duas cópias já
 * a descartavam, e passá-la mudaria a cara de todo card de dois boards. É uma decisão de estética,
 * separada desta unificação.
 */
export function VocabChips({ card, config }: { card: Card; config: BoardConfig }) {
  if (card.personas.length === 0 && card.systems.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {card.personas.map((pid) => (
        <Chip key={`p-${pid}`} label={config.personas.find((x) => x.id === pid)?.name ?? pid} />
      ))}
      {card.systems.map((sid) => (
        <Chip key={`s-${sid}`} label={config.systems.find((x) => x.id === sid)?.name ?? sid} />
      ))}
    </div>
  );
}
