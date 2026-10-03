// As PRÉ-CONDIÇÕES das ações de servidor que o Inbox oferece como botão — PURAS, exportadas, e chamadas dos DOIS
// lados: a ação de servidor recusa por elas, e o registry de quick-actions desabilita o botão com a MESMA frase
// antes do clique. Uma régua só: um botão que o servidor recusaria depois do clique é pior que nenhum botão
// (dois incidentes da auditoria do Inbox). Client-safe: nada de IO aqui — a parte da pré-condição
// que precisa de disco (o runner ligado, a proposta em conflito com o documento) fica com a ação.

import { isConducted } from "./driver";
import { checkGate } from "./gates";
import { moveTargets } from "./move-targets";
import { acceptRoute, triagePlacementGap } from "./triage/parse";
import type { BoardConfig, Card } from "./types";

/**
 * A recusa de um status que não existe no board (storymap-critical-audit #3): o `checkGate` é no-op para status
 * desconhecido e o coerce aceita qualquer string — sem isto um move/aceite com um id errado prenderia o card num
 * status fantasma, fora do pipeline.
 */
export function unknownStatusRefusal(statusId: string, config: Pick<BoardConfig, "statuses">): string | null {
  return config.statuses.some((s) => s.id === statusId)
    ? null
    : `status inexistente no board: "${statusId}" (use list_statuses para os ids válidos)`;
}

/**
 * Por que mover `card` para `statusId` seria recusado — ou null. A régua de moveCardAction/updateCardAction: o status
 * existe e o gate dele aceita o card. Ficar no mesmo status nunca é recusado (é reordenar). F6: o Inbox desabilita
 * «Re-publicar»/«Publicar» por ela, com a mesma frase.
 */
export function moveRefusal(card: Card, statusId: string, config: BoardConfig): string | null {
  if (statusId === card.status) return null;
  return unknownStatusRefusal(statusId, config) ?? checkGate(card, statusId, config);
}

/**
 * Por que «Aceitar» (acceptTriageCardAction) seria recusado — ou null, na ORDEM em que o servidor recusa: fora da
 * quarentena; o destino (acceptRoute) não existe no board; o GATE do destino (ex.: «Refinar» exige o brief — o
 * incidente em que o dono só leu isso depois do clique); a falta de LUGAR no mapa que a invariante de hierarquia
 * cobraria na escrita.
 */
export function acceptTriageRefusal(card: Card, config: BoardConfig): string | null {
  const def = config.statuses.find((s) => s.id === card.status);
  if (def?.staging !== true) return "Só cards na Triagem podem ser aceitos no fluxo (Opção B).";
  const to = acceptRoute(card);
  return unknownStatusRefusal(to, config) ?? checkGate(card, to, config) ?? triagePlacementGap(card, config);
}

/** Por que aprovar a exclusão de dados (approveDataDeletionAction) seria recusado — ou null. */
export function dataDeletionRefusal(card: Pick<Card, "mode" | "retirement"> | null | undefined): string | null {
  if (!card || card.mode !== "retire" || !card.retirement) return "Card não está em descontinuação.";
  if (card.retirement.level !== "excluir-tudo") return "Só o nível “Excluir tudo” precisa de aprovação de exclusão de dados.";
  return null;
}

/**
 * Por que «Aprovar design» não passaria — ou null. Aprovar = escolher a tela principal E mover o card para o passo
 * recomendado (o mesmo `moveTargets` do Kanban); sem tela principal o botão ficava desabilitado MUDO, e sem passo
 * recomendado a recusa só chegava num toast depois do clique.
 */
export function designApproveRefusal(card: Card | null | undefined, config: BoardConfig, chosenId: string | null | undefined): string | null {
  if (!chosenId) return "Escolha a tela principal do design (a estrela no canvas) antes de aprovar.";
  if (!card) return "O card deste design não está carregado — abra o card.";
  if (moveTargets(card, config).some((t) => t.recommended)) return null;
  const idx = config.statuses.findIndex((s) => s.id === card.status);
  const next = idx >= 0 ? config.statuses[idx + 1] : undefined;
  const gate = next ? checkGate(card, next.id, config) : null;
  return next && gate
    ? `O próximo passo («${next.name}») ainda não aceita este card: ${gate}`
    : "Não há um próximo passo que este card possa alcançar agora — avance pelo board.";
}

/**
 * Por que «Tentar novamente» (runCardSkillAction) NÃO rodaria neste card agora — ou null. Recusa: card sem coluna,
 * coluna sem skill, e o card CONDUZIDO: o engine cancelava o run desse card em silêncio (a ação devolvia `ok`), e
 * o dono via «Tentar novamente: ok» sobre algo que nunca rodou.
 */
export function runSkillRefusal(card: Pick<Card, "status" | "routing"> | null | undefined, config: Pick<BoardConfig, "statuses">): string | null {
  if (!card?.status) return "Card sem status — mova-o para uma coluna primeiro.";
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def?.trigger) return "Esta coluna não tem skill associada (sem trigger), então não há o que rodar.";
  if (isConducted(card)) {
    return (
      "Este card é conduzido por uma sessão condutora: a automação da coluna não roda nele, e «Tentar novamente» " +
      "seria cancelado. Fale com o condutor (ou peça ao Jido), ou devolva o card ao pipeline de colunas tirando o condutor."
    );
  }
  return null;
}

/**
 * Por que «Re-publicar»/«Tentar de novo» (republishCardAction — re-roda o efeito de entrada do passo ONDE o card
 * está) não valeria agora — ou null. Só vale para um card parado num passo que declara efeito de entrada.
 */
export function republishRefusal(card: Pick<Card, "status"> | null | undefined, config: Pick<BoardConfig, "statuses">): string | null {
  const def = card ? config.statuses.find((s) => s.id === card.status) : undefined;
  if (def?.onEnter) return null;
  const example = config.statuses.find((s) => s.onEnter);
  return (
    `Isto vale para um card parado num passo que dispara uma ação automática${example ? ` (ex.: «${example.name}»)` : ""}; ` +
    `este está em «${def?.name ?? card?.status ?? "?"}».`
  );
}
