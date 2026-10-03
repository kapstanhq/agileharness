// O CICLO EXTRA (extra-cycle.ts) ligado à produção: o card do disco, o gasto e o teto do card-budget, o pedido de
// teto encadeado, a escrita sob a trava do card e o registro em Acompanhar. Tudo como o próprio serviço — nenhuma
// server action no caminho (o mesmo desenho de card-budget-deps.ts).

import { nextQuestionId } from "@/lib/storymap/questions";
import { readCard } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { cardSpendNow, requestBudgetNow } from "./card-budget-deps";
import { appendSystemDecision } from "./decision-log";
import { requestExtraCycle, type ExtraCycleInput, type ExtraCycleResult } from "./extra-cycle";

/** A tool `request_extra_cycle`: a régua do dono, com o IO de produção. Nunca lança. */
export async function requestExtraCycleNow(input: ExtraCycleInput): Promise<ExtraCycleResult> {
  const result = await requestExtraCycle(input, {
    readCard: (board, cardId) => readCard(board, cardId).catch(() => null),
    spend: cardSpendNow,
    requestBudget: requestBudgetNow,
    update: async (board, cardId, fn) => {
      let wrote = false;
      await updateCardOnDisk(board, cardId, (fresh) => {
        const next = fn(fresh);
        wrote = next !== null;
        return next;
      });
      return wrote;
    },
    nextQuestionId: (qs) => nextQuestionId([...qs]),
    record: appendSystemDecision,
    today: () => new Date().toISOString().slice(0, 10),
    now: Date.now,
  });
  if (result.ok) console.log(`[extra-cycle] ${input.board}/${input.cardId}: ${result.verdict} — ${result.detail}`);
  return result;
}
