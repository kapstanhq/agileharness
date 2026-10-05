// delivery-audit channel — onde uma ENTREGA AUTÔNOMA (modo ultra) vira, por amostra, a auditoria do dono.
//
// Mora no dispatcher (o observador de ESCRITAS) de propósito: um card chega a "No ar" por muitos escritores — o
// settle do deploy, o move do condutor/copiloto pelo MCP, a cascata, uma skill editando o arquivo — e o watcher é o
// único lugar que vê TODOS eles. Cada chegada (`card.moved` para um status `delivered`) é julgada pela regra PURA
// (delivery-audit.ts `deliveryAuditDecision`: modo efetivo ultra, caminho autônomo pelo ledger de transições,
// amostra determinística pelo id do card) e, quando cai na amostra, o card ganha `deliveryAudit` pendente — que o
// Inbox projeta como "Confirmar / Reabrir". A regra é aplicada DE NOVO sob o lock, sobre o card fresco: um dono que
// reabriu ou um outro escritor no meio do caminho vence.
//
// A amostra do DONO é só do que o usuário vê (telas e textos). A entrega TÉCNICA sorteada
// vai ao AUDITOR independente (runner/technical-audit.ts): entra na fila dele e nada é carimbado no card.
//
// Não notifica: uma auditoria é trabalho do Inbox, não do bolso (notifications/push-policy).

import { isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import type { AgileHarnessEvent, NotificationChannel } from "../../event";
import { deliveredStatusIds } from "@/lib/storymap/delivered";
import { deliveryAuditDecision, isAutonomousUltraDelivery, stampDeliveryAudit } from "@/lib/storymap/delivery-audit";
import { deliverySkipEntry, type SystemDecision } from "@/lib/storymap/system-decisions";
import { newSystemDecisionId } from "@/lib/storymap/runner/decision-log";
import type { Transition } from "@/lib/storymap/runner/transitions";
import type { TechnicalAuditPending } from "@/lib/storymap/runner/technical-audit";
import type { BoardConfig, Card } from "@/lib/storymap/types";

export interface DeliveryAuditDeps {
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  readCard(board: string, cardId: string): Promise<Card | null>;
  readTransitions(filter: { board: string; cardId: string }): Promise<Transition[]>;
  updateCardOnDisk(board: string, cardId: string, mutate: (card: Card) => Card | null): Promise<Card | null>;
  /** política só-negócio — registra a entrega autônoma no registro de decisões do sistema (best-effort). */
  recordDecision?(e: SystemDecision): Promise<void>;
  /** grill 2 (D) — a entrega técnica sorteada vai ao auditor independente (a fila durável dele; fire-and-forget). */
  startTechnicalAudit?(pending: TechnicalAuditPending): Promise<unknown>;
  today?(): string;
  log?(line: string): void;
}

/** Julga UMA chegada e, se amostrada, carimba a auditoria. Devolve se carimbou. Nunca lança. */
export async function auditDeliveryArrival(deps: DeliveryAuditDeps, event: AgileHarnessEvent): Promise<boolean> {
  if (event.type !== "card.moved" || !event.cardId || !event.toStatus) return false;
  try {
    const config = await deps.readBoardConfig(event.boardId);
    // o caso comum sai daqui sem ler card nem ledger: a chegada não é a um status de entrega
    if (!config || !deliveredStatusIds(config).has(event.toStatus)) return false;
    // Board SÓ DE ORGANIZAÇÃO (organize-only.ts): nenhuma auditoria automática carimba card dele.
    if (isOrganizeOnly(config)) return false;
    const card = await deps.readCard(event.boardId, event.cardId);
    if (!card) return false;
    const transitions = await deps.readTransitions({ board: event.boardId, cardId: event.cardId }).catch(() => [] as Transition[]);
    // Toda entrega autônoma em só-negócio entra no registro do que o sistema decidiu em nome do dono — amostrada ou
    // não (a amostra é só o que volta para ele auditar). O «Desfazer» dela é reabrir.
    if (deps.recordDecision && isAutonomousUltraDelivery({ card, config, transitions })) {
      await deps.recordDecision(deliverySkipEntry(event.boardId, card, { at: new Date().toISOString(), id: newSystemDecisionId() })).catch(() => {});
    }
    const first = deliveryAuditDecision({ board: event.boardId, card, config, transitions });
    if (!first.sample) return false;
    if (first.audience === "auditor") {
      if (deps.startTechnicalAudit) {
        void deps
          .startTechnicalAudit({ board: event.boardId, cardId: event.cardId, range: card.commitRange ?? null, at: new Date().toISOString() })
          .catch(() => {});
        (deps.log ?? console.log)(`[delivery-audit] ${event.boardId}/${event.cardId}: entrega técnica na amostra — vai ao auditor independente`);
      }
      return false;
    }
    const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
    let stamped = false;
    await deps.updateCardOnDisk(event.boardId, event.cardId, (fresh) => {
      const again = deliveryAuditDecision({ board: event.boardId, card: fresh, config, transitions });
      if (!again.sample || again.audience !== "owner") return null;
      stamped = true;
      return stampDeliveryAudit(fresh, today);
    });
    if (stamped) (deps.log ?? console.log)(`[delivery-audit] ${event.boardId}/${event.cardId}: entrega autônoma na amostra — auditoria no Inbox`);
    return stamped;
  } catch (err) {
    console.error(`[delivery-audit] ${event.boardId}/${event.cardId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** O canal do dispatcher. Sempre registrado — um board sem modo ultra (ou sem status `delivered`) nunca carimba. */
export function createDeliveryAuditChannel(deps: DeliveryAuditDeps): NotificationChannel {
  return {
    id: "delivery-audit",
    async notify(event: AgileHarnessEvent) {
      await auditDeliveryArrival(deps, event);
    },
  };
}
