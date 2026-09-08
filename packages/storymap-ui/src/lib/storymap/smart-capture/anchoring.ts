// A validação de ANCORAGEM de um lote de captura — pura, testável, e derivada da MESMA regra que o
// chokepoint de escrita usa (`placementSpec`, gate-core). Não há segunda definição de "onde um card
// vive": este módulo só decide QUANDO cobrar, nunca O QUE é válido.
//
// Por que "quando" é um problema separado: o card capturado nasce na QUARENTENA (a lane `staging` —
// a Triagem, ver views.ts entryStatus), e a invariante isenta a quarentena de propósito — quem chega
// por texto livre ainda não sabe onde encaixa. Uma guarda que cobrasse âncora aqui seria mais estrita
// que a própria invariante, e foi exatamente isso que quebrou a captura de bug: o prompt manda a
// entrega sair com `parent` = step, a guarda exigia a user story, e o lote inteiro era recusado.
//
// A régua que sobrou distingue AUSÊNCIA de ERRO:
//   • âncora AUSENTE  → tolerada quando o card cai na quarentena (é o que a quarentena É). A UI avisa
//                       e oferece o conserto, mas não bloqueia.
//   • âncora QUEBRADA (id que não existe) → SEMPRE recusada: referência pendente não é uma decisão
//                       adiada, é dado corrompido — e o lint de integridade do board a reprovaria.
//   • âncora do TIPO ERRADO → SEMPRE recusada: um relacionamento errado é pior que um ausente, porque
//                       parece certo. É o caso da entrega pendurada num step (as 32 do censo).

import { placementSpec } from "../gate-core";
import type { BoardConfig, Card } from "../types";
import type { ProposedItem } from "./types";

/** O alvo de uma âncora, resolvido no board existente OU num item do próprio lote. */
export interface AnchorTarget {
  type: string;
  storyType: string | null;
}

export interface AnchorProblem {
  tempId: string;
  /** frase PT-BR pronta para a mensagem de erro, nomeando o item e o que falta. */
  message: string;
}

/**
 * Valida a ancoragem de cada item do lote. `resolve` devolve o alvo de um id — que pode ser um card
 * EXISTENTE do board ou um item PROPOSTO no mesmo lote (é o que permite propor o backbone junto e
 * pendurar as stories nele por tempId). `landsInQuarantine` diz se os cards nascerão num status
 * `staging`; quando true, a âncora AUSENTE é tolerada (ver o cabeçalho).
 *
 * Itens que ESTENDEM um card existente (`targetCardId`) não criam card e por isso não têm âncora a
 * validar — a existência do alvo deles é checada à parte, em {@link validateExtendTargets}.
 */
export function validateBatchAnchoring(
  items: ProposedItem[],
  resolve: (ref: string) => AnchorTarget | null,
  opts: { config: BoardConfig; landsInQuarantine: boolean },
): AnchorProblem[] {
  const problems: AnchorProblem[] = [];
  for (const it of items) {
    if (it.targetCardId) continue; // estende um card existente — não cria, não ancora
    // A regra vem de placementSpec. O status é OMITIDO de propósito: queremos a regra CRUA (qual
    // âncora este tipo exige), e a tolerância da quarentena é aplicada aqui embaixo, só à AUSÊNCIA.
    const spec = placementSpec(
      { type: it.type, storyType: it.storyType ?? null, parent: it.parent ?? null, serves: it.serves ?? null } as Card,
      opts.config,
    );
    if (!spec) continue; // activity (raiz), idea — fora do backbone por desenho

    if (spec.rootOnly) {
      if (spec.anchorId) {
        problems.push({ tempId: it.tempId, message: `"${it.title}" é uma ação (raiz do mapa) e não pode ter pai` });
      }
      continue;
    }
    if (!spec.anchorId) {
      if (!opts.landsInQuarantine) {
        problems.push({ tempId: it.tempId, message: `"${it.title}" não tem ${spec.field} — precisa apontar para ${spec.wanted}` });
      }
      continue; // na quarentena, decidir o lugar depois é legítimo
    }
    const target = resolve(spec.anchorId);
    if (!target) {
      problems.push({
        tempId: it.tempId,
        message: `"${it.title}": ${spec.field} "${spec.anchorId}" não existe (nem no board, nem no lote)`,
      });
      continue;
    }
    if (spec.accepts && !spec.accepts({ type: target.type, storyType: target.storyType } as Card)) {
      problems.push({
        tempId: it.tempId,
        message: `"${it.title}": ${spec.field} "${spec.anchorId}" não é ${spec.wanted}`,
      });
    }
  }
  return problems;
}

/**
 * Valida os itens em modo ESTENDER: `targetCardId` tem de apontar para um card que EXISTE no board
 * (nunca um tempId do lote — estender só faz sentido sobre algo já real) e o item precisa trazer o
 * que acrescentar (ao menos uma task). Um alvo que não resolve é recusado em vez de degradar para
 * "cria um card novo": a diferença entre acrescentar 3 tasks a uma story e criar uma 4ª story é
 * grande demais para o sistema decidir sozinho.
 */
export function validateExtendTargets(
  items: ProposedItem[],
  existsOnBoard: (id: string) => boolean,
): AnchorProblem[] {
  const problems: AnchorProblem[] = [];
  for (const it of items) {
    if (!it.targetCardId) continue;
    if (!existsOnBoard(it.targetCardId)) {
      problems.push({
        tempId: it.tempId,
        message: `"${it.title}" quer estender o card "${it.targetCardId}", que não existe neste board`,
      });
      continue;
    }
    if (!it.tasks?.length) {
      problems.push({
        tempId: it.tempId,
        message: `"${it.title}" estende "${it.targetCardId}" mas não traz nenhuma task para acrescentar`,
      });
    }
  }
  return problems;
}
