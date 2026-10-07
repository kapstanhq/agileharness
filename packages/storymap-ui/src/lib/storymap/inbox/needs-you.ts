// «Você tem N itens para decidir» — a fala do Jido conta o MESMO que o Inbox.
//
// A saudação do chat contava os itens CRUS do cockpit (tudo o que o coletor achou: Acompanhar, avisos repetidos de
// host, itens que o sistema já está resolvendo) enquanto o ícone do Inbox e a tela contavam só Decidir — o Jido dizia
// «19 itens para revisar» com o Inbox em 0. O Inbox é a verdade do que precisa da pessoa; aqui a saudação lê o número
// dele (o resumo da barra, `getInboxSummaryAction` → `byBoard`), e a frase nasce de uma função só. PURAS.

/** O pedaço do resumo da barra que a saudação lê — `byBoard` é o Decidir de cada board. */
export interface InboxCountSource {
  byBoard: Record<string, number>;
}

/**
 * Quantos itens deste board pedem a pessoa, pelo Inbox. `null` = ainda não medido (resumo ausente): a saudação então
 * NÃO afirma número nenhum — «0» é uma medida, e dizê-lo sem medir afirmaria que não há nada.
 */
export function needsYouForBoard(summary: InboxCountSource | null | undefined, boardId: string): number | null {
  if (!summary) return null;
  return summary.byBoard[boardId] ?? 0;
}

/**
 * «Você tem 2 itens para decidir, 1 pergunta em aberto.» — ou «Nada urgente no momento.» quando o Inbox MEDIU zero.
 * Sem medida do Inbox e sem mais nada a contar, vazio: a saudação não afirma o que não sabe.
 */
export function greetingSummary(c: { needsYou: number | null; questions: number; approvals: number }): string {
  const bits: string[] = [];
  if (c.needsYou) bits.push(`${c.needsYou} ${c.needsYou === 1 ? "item" : "itens"} para decidir`);
  if (c.questions) bits.push(`${c.questions} pergunta${c.questions === 1 ? "" : "s"} em aberto`);
  if (c.approvals) bits.push(`${c.approvals} ${c.approvals === 1 ? "ação" : "ações"} do Jido aguardando aprovação`);
  if (bits.length) return `Você tem ${bits.join(", ")}.`;
  return c.needsYou === null ? "" : "Nada urgente no momento.";
}

/** Quanto a saudação espera pelo resumo do Inbox antes de seguir SEM número (ms). */
export const GREETING_INBOX_WAIT_MS = 1500;

/**
 * Lê o resumo do Inbox para a saudação SEM deixar a leitura segurar o chat: o resumo varre o Inbox de TODOS os boards,
 * e o «Lendo o board…» não pode esperar por ele. Lenta (passou de `ms`), rejeitada ou com erro síncrono ⇒ `null` — a
 * saudação então sai sem número (ver `needsYouForBoard`). Nunca rejeita.
 */
export function inboxForGreeting<T>(read: () => Promise<T | null>, ms: number = GREETING_INBOX_WAIT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  let pending: Promise<T | null>;
  try {
    pending = read().catch(() => null);
  } catch {
    pending = Promise.resolve(null);
  }
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}
