// Plano PURO da resolução de uma desambiguação ③: dado o item proposto e o `done` do HITL (um
// RecastResult opaco e NÃO-confiável), decide se basta CARIMBAR (mesmo tipo/subtipo) ou se exige
// REESCRITA profunda (tipo/subtipo mudou → o corpo precisa renascer no formato do novo tipo) ou se o
// `done` é inválido. Mantém a regra "re-cast reescreve, não relabela" TAMBÉM no caminho da desambiguação
// (o caminho do select ② já reescreve via recastProposedItemAction). PURO/testável.

import type { CardType } from "../types";
import type { StoryType } from "../frameworks";
import type { ProposedItem } from "../smart-capture/types";

/** O payload `done` que a desambiguação espera (RecastResult) — campos opcionais, vindos do LLM. */
export interface DisambiguationResult {
  type?: unknown;
  storyType?: unknown;
  title?: unknown;
  rationale?: unknown;
}

export type DisambiguationPlan =
  | { kind: "invalid" }
  | { kind: "stamp"; item: ProposedItem }
  | { kind: "recast"; toType: CardType; toStoryType: StoryType | null; title?: string; rationale?: string };

const STORY_TYPES = new Set<StoryType>(["user", "technical", "bug", "chore", "spike"]);

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Decide como aplicar a desambiguação. Guards (#3): `done` precisa ser um objeto com `type` ∈
 * {idea, story} (o contrato da capture-disambiguation) — qualquer outra coisa é `invalid` e o
 * chamador NÃO deve limpar o ⚠ (evita o falso "resolvido").
 *
 * WS-9 (D15): a captura NUNCA cunha ideia (◆). Um veredito `type:"idea"` (= dor crua) vira uma story de
 * USUÁRIO — a bancada de Ideias saiu (fase 2, decisão do dono: «a ideia vira item da Triagem»), então a dor
 * entra pela Triagem, que é onde a captura grava, e lá é triada como qualquer item. Para `type:"story"`: mudança de tipo
 * OU de subtipo (#1) exige `recast` (reescrita profunda); só refino de título/racional no mesmo tipo → `stamp`.
 */
export function planDisambiguation(item: ProposedItem, done: unknown): DisambiguationPlan {
  if (!done || typeof done !== "object") return { kind: "invalid" };
  const d = done as DisambiguationResult;
  const toType = d.type;
  if (toType !== "idea" && toType !== "story") return { kind: "invalid" };

  const title = asStr(d.title);
  const rationale = asStr(d.rationale);

  // Dor crua → um item da Triagem (story de usuário), nunca um ◆ nascido da captura.
  const rawPain = toType === "idea";
  const toStoryType: StoryType | null = rawPain
    ? "user"
    : typeof d.storyType === "string" && STORY_TYPES.has(d.storyType as StoryType)
      ? (d.storyType as StoryType)
      : item.storyType ?? "user";

  const changed = "story" !== item.type || toStoryType !== (item.storyType ?? null);
  if (changed) {
    return { kind: "recast", toType: "story", toStoryType, title, rationale };
  }
  return {
    kind: "stamp",
    item: {
      ...item,
      type: "story",
      storyType: toStoryType,
      title: title || item.title,
      rationale: rationale || item.rationale,
      ambiguous: false,
      confidence: 0.9,
    },
  };
}
