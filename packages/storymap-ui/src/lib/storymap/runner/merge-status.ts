// As RÉGUAS de estado do merge train, em UM lugar.
//
// POR QUE ESTE MÓDULO EXISTE. "Quais status contam como entrada VIVA no train?" tinha CINCO respostas no
// repositório: os predicados privados de `merge-queue.ts` (a canônica), e mais quatro `new Set([...])`
// hardcoded — dois em `mcp/tools.ts`, um em `entry-effects.ts` e um em `api/runner/pulse`. Todas
// escreviam a mesma lista à mão porque a canônica não era exportada.
//
// Isso não é feiura: é a MESMA classe de defeito que já mordeu esta feature. `laneOf` e `trainInFlight`
// respondiam à mesma pergunta com duas listas, e a diferença entre elas (`failed`/`returned-to-session`)
// virou um vão por onde o trabalho SUMIA da página — ninguém percebeu porque nenhuma das duas estava
// "errada" isoladamente. Cinco cópias é o mesmo risco, cinco vezes, e o dia em que um status novo entrar
// no enum só uma delas vai ser atualizada.
//
// PURO e sem imports de runtime (só o tipo), de propósito: assim o cliente também pode consumi-lo — é o
// que deixa `delivery-view` (client-safe) derivar as raias daqui em vez de manter a sexta cópia.

import type { MergeQueueStatus } from "./types";

/**
 * ATIVA — a entrada está EM VOO: o train ou o gate está com ela nas mãos AGORA.
 *
 * Responde "tem alguma coisa acontecendo neste instante?", que é a pergunta de quem vai REINICIAR o
 * serviço ou varrer worktrees — e por isso ela NÃO inclui as parqueadas: uma entrada parqueada não tem
 * ninguém trabalhando nela, ela espera um humano, e esperar por ela seria esperar para sempre.
 */
export function isActiveMergeStatus(status: MergeQueueStatus): boolean {
  return status === "waiting" || status === "gate-running" || status === "merging";
}

/**
 * PARQUEADA — a integração falhou e a entrada espera o OPERADOR. Fica assim por dias; quem a supersede é
 * `reconcileCardMergeEntries`, quando o humano mexe no card.
 */
export function isParkedMergeStatus(status: MergeQueueStatus): boolean {
  return status === "gate-failed" || status === "conflict";
}

/**
 * VIVA — a entrada ainda OCUPA a fila: sobrevive a um restart, nunca é podada por cap, e (se parqueada)
 * segura a cabeça do train. É `ativa ∪ parqueada`.
 *
 * ⚠️ `re-driving` está DELIBERADAMENTE de fora (story-92ldyt): ele é TERMINAL para aquele branch — o
 * branch foi deletado e um run NOVO foi despachado —, então ele caduca como `done`/`failed` e não pode
 * bloquear a cabeça. Quem quiser "o train ainda vai mexer nisto?" (a pergunta da UI, que mostra
 * "re-executando" como algo em movimento) usa `delivery-view trainInFlight`, que é esta régua MAIS
 * `re-driving`. As duas perguntas são diferentes e devem continuar sendo — o que não pode voltar a
 * existir é uma terceira lista escrita à mão.
 */
export function isLiveMergeStatus(status: MergeQueueStatus): boolean {
  return isActiveMergeStatus(status) || isParkedMergeStatus(status);
}
