// «Mandar corrigir» um aviso da revisão — o card de conserto que nasce do aviso. PURO.
//
// POR QUE EXISTE: um aviso da revisão que não trava a entrega, num card que toca uma classe de negócio do
// dono (dados de pessoas, dinheiro), subia ao Inbox pedindo «Registrar como conhecido / Já foi resolvido / Não corrigir».
// As três só trocavam a etiqueta do aviso: a decisão de verdade — corrigir ou aceitar o risco — não aparecia, e a única
// que resolve o problema (mandar alguém consertar) não existia. O dono perguntou, com razão, se aquilo era trabalho dele.
//
// O conserto vira um card próprio, no começo do fluxo do board, apontando para o card de origem: o sistema o leva pelo
// caminho normal (especificar, construir, revisar), e o aviso fica registrado na origem como aceito. Nada é corrigido
// «por dentro» do card já entregue.

import { makeDraftCard } from "./draft";
import type { Card, Finding, ReviewChainMark } from "./types";

/** O rótulo que marca o card nascido de um aviso da revisão. */
export const FINDING_FIX_LABEL = "aviso-da-revisao";

const SEVERITY_WORDS: Record<string, string> = { blocker: "bloqueante", high: "alta", medium: "média", low: "baixa" };

/** A importância do aviso em palavras (o valor cru quando não é um dos conhecidos). PURA. */
export function severityWords(severity: string | null | undefined): string {
  return SEVERITY_WORDS[String(severity ?? "")] ?? String(severity ?? "");
}

/** Por que o aviso não pode virar conserto agora — ou null. A MESMA frase que a ação de servidor devolve. PURA. */
export function findingFixRefusal(card: Pick<Card, "findings"> | null | undefined, findingId: string): string | null {
  const finding = card?.findings?.find((f) => f.id === findingId);
  if (!finding) return "Este aviso não existe mais no card.";
  if (finding.status !== "open") return "Este aviso já foi tratado.";
  return null;
}

/**
 * O card de conserto de um aviso: uma entrega técnica no passo de ENTRADA do board, que serve a mesma história de
 * usuário do card de origem (a origem, quando ela é a própria história) e aponta para ela. O texto leva o aviso, o
 * detalhe e a sugestão da revisão — é o que o agente que especificar o conserto vai ler. PURA.
 */
export function buildFindingFixCard(input: {
  origin: Card;
  finding: Finding;
  entryStatus: string | null;
  cards: Card[];
  today: string;
  /** o conserto nasce em OUTRO board (o do arquivo do aviso — fix-card-board.ts): a origem vai por texto, sem vínculo. */
  routedFrom?: { board: string; reason: string };
  /** a marca de cadeia de conserto (runner/review-rounds.ts) — o conserto conta na árvore da origem em qualquer board. */
  reviewChain?: ReviewChainMark | null;
}): Card {
  const { origin, finding, routedFrom } = input;
  const serves = routedFrom ? undefined : origin.storyType == null || origin.storyType === "user" ? origin.id : (origin.serves ?? origin.parent ?? undefined);
  const body = [
    "## O aviso da revisão que este card conserta",
    "",
    `- Card de origem: ${origin.id} — ${origin.title}${routedFrom ? ` (board «${routedFrom.board}»)` : ""}`,
    ...(routedFrom ? [`- Por que este board: ${routedFrom.reason}.`] : []),
    `- Aviso (${[finding.lens, severityWords(finding.severity)].filter(Boolean).join(", ")}): ${finding.title}`,
    ...(finding.detail?.trim() ? ["", finding.detail.trim()] : []),
    ...(finding.suggestion?.trim() ? ["", "## O que a revisão sugere", "", finding.suggestion.trim()] : []),
    "",
    "## O pedido",
    "",
    `O dono mandou corrigir pelo Inbox em ${input.today}. O aviso ficou registrado no card de origem; este card é o conserto.`,
  ].join("\n");
  return {
    ...makeDraftCard({ type: "story", title: `Conserto: ${finding.title}`, status: input.entryStatus, parent: null, cards: input.cards }),
    storyType: "technical",
    ...(serves ? { serves } : {}),
    links: routedFrom ? [] : [{ rel: "relates-to", to: origin.id }],
    labels: [FINDING_FIX_LABEL],
    ...(input.reviewChain ? { reviewChain: input.reviewChain } : {}),
    body,
  };
}
