// As ESCOLHAS DO DONO no início de um card (política só-negócio) — PURA (zero IO).
//
// O dono não é técnico, mas duas coisas ele pode querer dizer quando aprova um card para ser feito:
//   • a TECNOLOGIA a usar (`techPreference`, texto livre) — vira uma restrição DURA do plano;
//   • «quero ver as opções de tela» (`ownerReviewsUi`) — a escolha de tela deste card passa a ser dele, também em
//     só-negócio. Sem marcar, o especialista de UX / o orquestrador escolhe e registra as alternativas.
// Ambas são opcionais e só mudam ANTES da construção começar: depois disso o plano e a tela já partiram delas, e
// trocá-las no meio seria trocar o contrato sem ninguém replanejar. A mesma régua desabilita os campos na tela e
// recusa a escrita no servidor.

import { hasProducedWork } from "./demands";
import type { BoardConfig, Card } from "./types";

/** As skills que ABREM a construção de um card — o primeiro passo com uma delas marca "começou a construir". */
const BUILD_TRIGGERS: ReadonlySet<string> = new Set(["harness-plan", "harness-tasks", "harness-do"]);

/** O índice, na ordem do pipeline, do primeiro passo de construção (-1 quando o board não declara nenhum). */
function constructionStartIndex(config: Pick<BoardConfig, "statuses">): number {
  return config.statuses.findIndex((s) => s.trigger != null && BUILD_TRIGGERS.has(s.trigger));
}

/**
 * O card JÁ começou a ser construído? Plano pronto, tasks, trabalho de construção produzido (código, revisão, QA,
 * integração — o design escolhido NÃO conta: ele vem antes da construção), ou um status no primeiro passo de
 * construção ou depois dele (terminal e reabertura incluídos). PURA.
 */
export function hasStartedConstruction(
  card: Pick<Card, "status" | "techPlanReady" | "tasks" | "wireframeChosen" | "reviewedAt" | "qaRanAt" | "qaPassed" | "stagedAt" | "releasedAt" | "commitRange" | "findings">,
  config: Pick<BoardConfig, "statuses">,
): boolean {
  if (card.techPlanReady || (card.tasks?.length ?? 0) > 0) return true;
  if (hasProducedWork({ ...card, wireframeChosen: undefined })) return true;
  if (!card.status) return false;
  const idx = config.statuses.findIndex((s) => s.id === card.status);
  const def = config.statuses[idx];
  if (def?.terminal) return true;
  const start = constructionStartIndex(config);
  return start >= 0 && idx >= start;
}

/** As escolhas podem mudar agora? Só numa story que ainda não começou a ser construída. PURA. */
export function optInsEditable(card: Card, config: Pick<BoardConfig, "statuses">): boolean {
  return card.type === "story" && !hasStartedConstruction(card, config);
}

const techOf = (c: Pick<Card, "techPreference"> | null | undefined) => c?.techPreference?.trim() ?? "";
const uiOf = (c: Pick<Card, "ownerReviewsUi"> | null | undefined) => c?.ownerReviewsUi === true;

/**
 * Por que o servidor recusa ESTA escrita — ou null. Só quando ela MUDA uma das escolhas num card que já começou a ser
 * construído (a mudança do resto do card segue livre). `prev` null = card novo (nasce com elas só se ainda não está
 * em construção). PURA — a ação de escrita e a tela usam a mesma régua.
 */
export function optInsRefusal(prev: Card | null, next: Card, config: Pick<BoardConfig, "statuses">): string | null {
  if (techOf(prev) === techOf(next) && uiOf(prev) === uiOf(next)) return null;
  const judged = prev ?? next;
  if (optInsEditable(judged, config)) return null;
  const where = config.statuses.find((s) => s.id === judged.status)?.name ?? judged.status ?? "—";
  return (
    `A tecnologia e o «quero ver as opções de tela» só mudam antes da construção começar — este card já está em ` +
    `«${where}». Para mudar agora, reabra o card (Refinar).`
  );
}
