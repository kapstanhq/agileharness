// publish-retry — o RELÓGIO do disjuntor da publicação (publish-breaker.ts).
//
// O disjuntor segura a cascata enquanto o recuo não vence; mas a cascata é movida a EVENTO (um card entra num passo, um
// run termina, o watcher ecoa um write). Sem ninguém avisá-la de que o recuo VENCEU, o card ficaria em «Liberar» para
// sempre — o oposto do laço, igualmente ruim. Esta varredura roda na passada da frota (1 min) e, para cada card cujo
// recuo venceu e que ainda espera em «Liberar», pede UMA reavaliação da cascata; se ela encaminhar, o deploy roda, e o
// resultado (sucesso → zera; falha → mais um recuo) fecha o ciclo.
//
// A linha é da CAUSA (publish-breaker.ts): vencida, ela re-encaminha TODOS os cards que segura e que esperam em «Liberar» —
// é UMA tentativa (o primeiro dispara o deploy do pacote; os outros pegam carona no mesmo job, deploy-attached.ts).
//
// Três cuidados:
//   · quem já saiu do caminho (card apagado, concluído, movido para outra coluna) é ESQUECIDO — só ele sai da linha, a
//     causa segue segurando os outros, e o registro não cresce;
//   · quem está no passo de publicar NÃO é esquecido nem re-avaliado: há uma tentativa em voo, e o settle/revert dela decide;
//   · cada re-avaliação dá um fôlego (`retryLeaseMs`) ao registro — a avaliação pode não encaminhar (um gate, uma decisão do
//     dono aberta) e o card não pode "vencer" de novo a cada minuto.
//
// Esgotado (desistiu) não é tocado: espera o botão «Publicar». SERVER-ONLY.

import { isDeployStep } from "@/lib/storymap/demands";
import { DEPLOY_REVERT_DESTINATION } from "./deploy-revert";
import { PUBLISH_BACKOFF, attemptCardIds, getPublishBreaker, type PublishBreaker } from "./publish-breaker";
import type { BoardConfig, Card } from "@/lib/storymap/types";

export interface PublishRetryDeps {
  breaker: Pick<PublishBreaker, "snapshot" | "due" | "lease" | "forget">;
  readConfig(board: string): Promise<Pick<BoardConfig, "statuses"> | null>;
  readCard(board: string, cardId: string): Promise<Pick<Card, "status"> | null>;
  /** re-avalia a cascata do card (a mesma entrada de qualquer evento) */
  reevaluate(board: string, cardId: string): Promise<void>;
  now(): number;
}

export interface PublishRetryReport {
  /** cards reavaliados porque o recuo da linha deles venceu */
  redriven: string[];
  /** entradas esquecidas porque o card saiu do caminho */
  dropped: string[];
}

export async function retryDuePublishes(deps: PublishRetryDeps): Promise<PublishRetryReport> {
  const report: PublishRetryReport = { redriven: [], dropped: [] };
  const at = deps.now();
  const configs = new Map<string, Awaited<ReturnType<PublishRetryDeps["readConfig"]>>>();
  const configOf = async (board: string) => {
    if (!configs.has(board)) configs.set(board, await deps.readConfig(board).catch(() => null));
    return configs.get(board) ?? null;
  };

  // 1) esquece quem saiu do caminho: o card não existe, ou já não está em «Liberar» nem no passo de publicar (a visão é
  //    POR CARD: só ele sai da linha da causa)
  for (const a of await deps.breaker.snapshot()) {
    const config = await configOf(a.board);
    // Sem a config não dá para saber quais passos publicam — e esquecer o registro por um erro de leitura é perder o
    // freio. Fail-safe: fica como está até a próxima passada.
    if (!config) continue;
    const card = await deps.readCard(a.board, a.cardId).catch(() => null);
    const inFlow =
      !!card && (card.status === DEPLOY_REVERT_DESTINATION || isDeployStep(config.statuses.find((s) => s.id === card.status)));
    if (!inFlow) {
      await deps.breaker.forget(a.board, a.cardId);
      report.dropped.push(`${a.board}/${a.cardId}`);
    }
  }

  // 2) re-aciona a cascata dos cards em «Liberar» de cada linha com o recuo vencido (o representante primeiro)
  for (const a of await deps.breaker.due(at)) {
    const config = await configOf(a.board);
    const waiting: string[] = [];
    let inFlight = false;
    for (const cardId of attemptCardIds(a)) {
      const card = await deps.readCard(a.board, cardId).catch(() => null);
      if (card?.status === DEPLOY_REVERT_DESTINATION) waiting.push(cardId);
      // no passo de publicar: há tentativa em voo, e o settle/revert dela decide (config ilegível ⇒ trata como em voo)
      else if (card && (!config || isDeployStep(config.statuses.find((s) => s.id === card.status)))) inFlight = true;
    }
    if (inFlight || waiting.length === 0) continue;
    await deps.breaker.lease(a.board, a.cardId, at + PUBLISH_BACKOFF.retryLeaseMs);
    for (const cardId of waiting) {
      try {
        await deps.reevaluate(a.board, cardId);
        report.redriven.push(`${a.board}/${cardId}`);
      } catch (err) {
        console.error(`[publish-retry ${a.board}/${cardId}] reavaliação falhou:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return report;
}

/** A passada de produção (chamada pela reconciliação da frota). Imports dinâmicos: autorun-eval importa fleet-deps. */
export async function retryDuePublishesNow(): Promise<PublishRetryReport> {
  const [{ readBoardConfig, readCard }, { evaluateAutorunOnEntry }] = await Promise.all([
    import("@/lib/storymap/repo"),
    import("@/lib/notifications/server/channels/autorun-eval"),
  ]);
  const report = await retryDuePublishes({
    breaker: getPublishBreaker(),
    readConfig: (board) => readBoardConfig(board),
    readCard: (board, cardId) => readCard(board, cardId),
    reevaluate: (board, cardId) => evaluateAutorunOnEntry(board, cardId),
    now: Date.now,
  });
  if (report.redriven.length) console.log(`[publish-retry] recuo vencido — cascata reavaliada: ${report.redriven.join(", ")}`);
  return report;
}
