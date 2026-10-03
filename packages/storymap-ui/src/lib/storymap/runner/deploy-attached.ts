// A CARONA — o settle do card que entrou em Publicar enquanto um deploy do MESMO alvo já rodava.
//
// O PROBLEMA (num board de produto). Dois cards publicados em segundos: o primeiro disparou o deploy
// do board; o segundo bateu no `isRunning` do registry e voltou «já em andamento» — sem se prender a nada. O
// deploy terminou, o settle foi só do card que o disparou (o evento de done carrega UM card), e o segundo ficou
// em Publicar até o watchdog dizer «deploy disparado sem confirmação (settle não chegou)».
//
// AGORA o segundo card PEGA CARONA no job em curso (ProductDeployRegistry.attach, via deployBoard) e recebe o
// desfecho dele como um evento de done próprio (`attached: true`). Este módulo o assenta:
//   · FALHA do job ⇒ o card volta como o dono do job voltou — a mesma falha, pela mesma régua
//     (settleFailureDetail: inclusive o «precisa de você» da saída 3 do comando declarado);
//   · SUCESSO ⇒ o settle de sempre mede a prova do card (ancestralidade do releasedSha dele no que subiu);
//   · SUCESSO que NÃO prova ⇒ o deploy começou ANTES da promoção dele e não carregou o código dele: ele ganha
//     um deploy PRÓPRIO (fireDeployBoard) — uma vez só (`followUp`), para que um alvo que nunca prova não vire
//     laço de deploys; a partir daí ele espera em Publicar com o watchdog, como qualquer card sem prova.
//
// Um gate de board que segura o card depois da prova NÃO pede deploy (proven ⇒ o deploy não é o problema).
// Best-effort e nunca lança (é chamado de um subscriber do registry). SERVER-ONLY.

import type { DeployDoneEvent } from "./product-deploy";
import type { DeploySettleSuccessDecision } from "./deploy-reconcile";
import type { DeployFailureDetail } from "./deploy-revert";
import { isDeployNeedsHuman, readDeployExit3Report, readNeedsHumanReport, settleFailureDetail, type NeedsHumanReport } from "./deploy-needs-human";
import type { DeployExit3Report } from "./deploy-proof";

export interface AttachedSettleDeps {
  revert(board: string, cardId: string, detail: DeployFailureDetail): Promise<void>;
  settle(
    board: string,
    cardId: string,
    opts: { source: "registry-ondone"; deps?: { deployedShaFor: (target: string) => Promise<string | null> } },
  ): Promise<DeploySettleSuccessDecision | null>;
  readNeedsHumanReport(pkg: string): Promise<NeedsHumanReport>;
  /** política só-negócio — o relatório da saída 3 (needs-proof × needs-human). Ausente ⇒ tudo segue do dono. */
  readExit3Report?(pkg: string): Promise<DeployExit3Report>;
  /** o deploy PRÓPRIO do card (já marcado followUp — um card nunca ganha dois). */
  redispatch(board: string, cardId: string): Promise<unknown>;
}

const defaultDeps: AttachedSettleDeps = {
  revert: async (board, cardId, detail) => {
    const { revertCardOnDeployFailure } = await import("./deploy-revert");
    await revertCardOnDeployFailure(board, cardId, detail);
  },
  settle: async (board, cardId, opts) => {
    const { settleDeploySuccess } = await import("./deploy-reconcile");
    return settleDeploySuccess(board, cardId, opts);
  },
  readNeedsHumanReport,
  readExit3Report: readDeployExit3Report,
  redispatch: async (board, cardId) => {
    const { fireDeployBoard } = await import("./entry-effects");
    return fireDeployBoard(board, cardId, { followUp: true });
  },
};

/** PURE: o settle de sucesso segurou o card por FALTA DE PROVA (o deploy não carregou o código dele)? Só isso
 *  um deploy próprio resolve — gate segurando, card já avançado ou fora de Publicar, não. */
export function needsOwnRun(d: DeploySettleSuccessDecision | null): boolean {
  return !!d && d.advancedTo === null && d.heldReason !== null && !d.proven;
}

/** Assenta UM card de carona com o desfecho do job em que ele pegou carona. Nunca lança. */
export async function settleAttachedDeploy(ev: DeployDoneEvent, deps: AttachedSettleDeps = defaultDeps): Promise<void> {
  const { board, cardId } = ev;
  if (!board || !cardId) return;
  try {
    if (!ev.ok) {
      const needsHuman = isDeployNeedsHuman(ev) ? await deps.readNeedsHumanReport(ev.pkg) : undefined;
      const exit3 = isDeployNeedsHuman(ev) && deps.readExit3Report ? await deps.readExit3Report(ev.pkg) : undefined;
      await deps.revert(board, cardId, settleFailureDetail(ev, { needsHuman, exit3 }));
      return;
    }
    // O agente de deploy ALEGA o sha publicado; para o dono do job o settle mede contra essa alegação (deploy.ts,
    // D-AG4) — o card de carona é medido contra a MESMA, senão ele leria o state file que o agente não escreve.
    const liveSha = ev.liveSha;
    const decision = await deps.settle(board, cardId, {
      source: "registry-ondone",
      ...(liveSha ? { deps: { deployedShaFor: async () => liveSha } } : {}),
    });
    if (needsOwnRun(decision) && !ev.followUp) {
      console.warn(
        `[deploy-attached ${board}/${cardId}] o deploy de ${ev.pkg} em que o card pegou carona não carregou o código dele — deploy próprio`,
      );
      await deps.redispatch(board, cardId);
    }
  } catch (err) {
    console.error(`[deploy-attached ${board}/${cardId}] settle da carona falhou:`, err instanceof Error ? err.message : err);
  }
}
