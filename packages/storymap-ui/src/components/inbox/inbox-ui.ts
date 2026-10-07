// As regras PURAS da tela do Inbox (fase 3) — fora dos componentes para os testes (node, sem React) as lerem direto:
// o que o item mostra como «o que eu preciso de você», o tipo na linha de contexto, quais opções a linha curta mostra,
// quanto tempo o recibo fica e a lista que segura o recibo no lugar.

import type { CockpitItemKind } from "@/lib/storymap/demands";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import type { DecisionOption, ItemDecision } from "@/lib/storymap/inbox/decision";
import { INBOX_KIND_NOUN, quoted } from "@/lib/storymap/inbox/copy";

/** O vazio do Inbox — a frase do dono. */
export const INBOX_EMPTY_TEXT = "Nada precisa de você agora. Os agentes seguem sozinhos.";

/** Quanto tempo o recibo fica no lugar do item antes de a lista o tirar (pausa enquanto o ponteiro ou o foco estão nele). */
export const RECEIPT_MS = 6000;

/** «O que eu preciso de você» — o `ask` do modelo (a pergunta que o item faz à pessoa; o modelo o escreve inteiro, sem campo à parte). */
export function needOf(d: Pick<ItemDecision, "ask">): string {
  return d.ask;
}

/** O substantivo do tipo na linha de contexto («Pergunta», «Aprovação»). PURA. */
export function kindNoun(kind: InboxEntry["kind"]): string {
  if (kind === "system-decision") return "Decisão de um agente";
  return (INBOX_KIND_NOUN as Readonly<Record<string, string>>)[kind as CockpitItemKind] ?? "";
}

/** A opção que volta atrás («Desfazer», «Reabrir») — a única que a linha curta de «Os agentes estão cuidando» mostra. */
export function isUndoLike(o: Pick<DecisionOption, "invoke" | "label">): boolean {
  const k = o.invoke.kind;
  return k === "undo-system-decision" || k === "undo-locked-exec" || /^(Desfazer|Reabrir)\b/.test(o.label);
}

/** Os itens de decidir, com os que acabaram de ser resolvidos SEGUROS no lugar enquanto o recibo está na tela. PURA. */
export function withHeld<T extends { key: string }>(entries: readonly T[], held: ReadonlyArray<{ entry: T; index: number }>): T[] {
  const live = new Set(entries.map((e) => e.key));
  const out = [...entries];
  for (const h of [...held].sort((a, z) => a.index - z.index)) if (!live.has(h.entry.key)) out.splice(Math.min(h.index, out.length), 0, h.entry);
  return out;
}

/**
 * As facetas como links que se distinguem: a de outro card leva o nome do card; a do mesmo card, o tipo e o título dela
 * (o problema, a pergunta) — várias facetas de uma causa dividem o mesmo `ask`, e a lista mostrava links idênticos.
 * A própria entrada não é faceta dela. PURA.
 */
export function facetLinks(entry: Pick<InboxEntry, "itemId" | "cardId" | "facets">): { itemId: string; label: string }[] {
  const seen = new Map<string, number>();
  return entry.facets
    .filter((f) => f.itemId !== entry.itemId)
    .map((f) => {
      const base =
        f.cardId && f.cardId !== entry.cardId && f.cardTitle
          ? quoted(f.cardTitle)
          : f.title
            ? `${kindNoun(f.kind) || "Item"}: ${f.title.length > 90 ? `${f.title.slice(0, 89).trimEnd()}…` : f.title}`
            : f.ask;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { itemId: f.itemId, label: n > 1 ? `${base} (${n})` : base };
    });
}
