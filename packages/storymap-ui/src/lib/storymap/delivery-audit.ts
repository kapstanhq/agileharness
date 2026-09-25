// A AUDITORIA POR AMOSTRA das ENTREGAS AUTÔNOMAS — a linha "prova da entrega" da chave de autonomia. PURA (zero IO).
//
//   ponto de decisão     human                                   ultra
//   prova da entrega     aviso depois (classes autônomas),        aviso depois, AUDITORIA POR AMOSTRA
//                        senão aprovação antes
//
// Em ultra, o condutor não para em "Aprovar entrega": escreve a `## Prova da entrega` e segue para Integrar sozinho.
// O dono não aprovou ANTES — então uma amostra das entregas volta para ele DEPOIS, já no ar, como um item do Inbox
// ("Confirmar / Reabrir"). Até a v0.8.0 só as RESPOSTAS do proxy eram amostradas; a entrega em si passava sem que
// ninguém olhasse. Este módulo responde, de um lugar só:
//   1. esta chegada a "No ar" é uma ENTREGA AUTÔNOMA que cai na amostra? (`deliveryAuditDecision`);
//   2. o que o Inbox mostra (`isPendingDeliveryAudit`, `deliveryProofOf`);
//   3. o que Confirmar e Reabrir fazem com o card (`applyDeliveryAuditOutcome`).
//
// As regras, e por que cada uma:
//   • só status declarados `delivered: true` (delivered.ts): terminal não é entrega (arquivado, descontinuado), e
//     sem a faceta declarada não há o que auditar — FAIL-CLOSED, como o índice do que está no ar;
//   • só modo EFETIVO ultra (autonomy.ts): em human o dono aprovou antes — nada muda;
//   • só o caminho AUTÔNOMO: se a última travessia do passo de aprovação de entrega (o gate `hasQaPassed`, o
//     "Aprovar entrega") foi feita por um HUMANO, o dono já viu — auditar de novo seria ruído. Sem registro dessa
//     travessia (ledger compactado, board sem o passo), conta como autônoma: na dúvida, o dono vê;
//   • a amostra é DETERMINÍSTICA pelo id do card (`auditDraw`, o mesmo FNV-1a das respostas do proxy, com outra
//     chave): o mesmo card cai ou não cai sempre — uma reentrega de um card amostrado volta a ser auditada;
//   • nunca é acionável pelo copiloto (demands.ts KIND_AUTONOMY `never`): é a revisão do DONO sobre o que foi feito
//     em nome dele.

import { auditDraw, effectiveAutonomy, proxySettings } from "./autonomy";
import { deliveredStatusIds } from "./delivered";
import { applyReopen, isReopenDestination, type ReopenDestination } from "./reopen";
import { upsertFinding } from "./runner/findings";
import type { BoardConfig, Card, DeliveryAuditRecord, Finding, StatusDef } from "./types";
import type { TransitionActor } from "./runner/transitions";

/** A chave da amostra de uma entrega — o card, com um sufixo que a separa das perguntas do mesmo card. */
export function deliveryAuditKey(board: string, cardId: string): string {
  return `${board}/${cardId}/delivery`;
}

/** Esta entrega cai na amostra? Determinístico pelo card (o mesmo sorteio a cada chamada). PURA. */
export function isDeliverySampled(board: string, cardId: string, sampleRate: number): boolean {
  return auditDraw(deliveryAuditKey(board, cardId)) < sampleRate;
}

/** O passo em que o DONO aprova uma entrega: a parada manual gatada por `hasQaPassed` ("Aprovar entrega"). */
export function isDeliveryApprovalStep(def: Pick<StatusDef, "gate" | "autorun"> | null | undefined): boolean {
  return def?.gate === "hasQaPassed" && def.autorun !== true;
}

/**
 * A entrega foi AUTÔNOMA — ninguém humano atravessou o passo de aprovação dela? Lê a travessia MAIS RECENTE que
 * saiu de um passo de aprovação de entrega (o ledger de transições tem o ATOR de cada salto). Nenhuma no registro
 * ⇒ autônoma (na dúvida, o dono vê). PURA.
 */
export function isAutonomousDelivery(
  transitions: ReadonlyArray<{ at: string; from: string | null; actor: TransitionActor | string }>,
  config: Pick<BoardConfig, "statuses">,
): boolean {
  const approval = new Set(config.statuses.filter((s) => isDeliveryApprovalStep(s)).map((s) => s.id));
  let last: { at: string; actor: string } | null = null;
  for (const t of transitions) {
    if (!t.from || !approval.has(t.from)) continue;
    if (!last || t.at > last.at) last = t;
  }
  return !last || last.actor !== "human";
}

/** Uma auditoria de entrega esperando o dono. */
export function isPendingDeliveryAudit(card: Pick<Card, "deliveryAudit">): boolean {
  return !!card.deliveryAudit && !card.deliveryAudit.auditedAt;
}

export type DeliveryAuditVerdict = { sample: true } | { sample: false; reason: string };

/**
 * O card ACABOU de entrar em `card.status`: esta chegada vira uma auditoria do dono? PURA — o canal que observa as
 * chegadas (notifications/server/channels/delivery-audit-channel) a chama com o card FRESCO e o ledger do card, e
 * de novo sob o lock antes de escrever.
 */
export function deliveryAuditDecision(input: {
  board: string;
  card: Card;
  config: BoardConfig;
  transitions: ReadonlyArray<{ at: string; from: string | null; actor: TransitionActor | string }>;
}): DeliveryAuditVerdict {
  const { board, card, config } = input;
  if (card.type !== "story") return { sample: false, reason: "não é story" };
  if (!card.status || !deliveredStatusIds(config).has(card.status)) return { sample: false, reason: "status não é de entrega (delivered)" };
  if (effectiveAutonomy(card, config).mode !== "ultra") return { sample: false, reason: "story em modo human — o dono aprovou antes" };
  if (isPendingDeliveryAudit(card)) return { sample: false, reason: "já há uma auditoria pendente" };
  if (!isAutonomousDelivery(input.transitions, config)) return { sample: false, reason: "o dono aprovou esta entrega" };
  if (!isDeliverySampled(board, card.id, proxySettings(config).auditSampleRate)) return { sample: false, reason: "fora da amostra" };
  return { sample: true };
}

/** Carimba a auditoria PENDENTE (substitui a de uma entrega anterior já fechada). PURA. */
export function stampDeliveryAudit(card: Card, today: string): Card {
  return { ...card, deliveryAudit: { sampledAt: today, ...(card.status ? { deliveredIn: card.status } : {}) } };
}

/** O id estável do finding que um Reabrir deixa no card (upsert — reabrir de novo atualiza, não empilha). */
export const DELIVERY_AUDIT_FINDING_ID = "delivery-audit";

/** Para onde um Reabrir manda a story: a mesma lista de destinos do Refinar (reopen.ts), padrão desenvolver. */
export const DELIVERY_AUDIT_REOPEN_DEFAULT: ReopenDestination = "desenvolver";

/**
 * O dono fecha a auditoria. `confirmed` — a entrega fica. `reopened` — a story VOLTA: reabertura de refino (a mesma
 * do botão Refinar: `mode: refine`, o motivo do dono como brief, `reopenPending` para o harness-refine rodar no
 * destino e rotear) + um finding aberto com o motivo, que acompanha o retrabalho até alguém resolvê-lo. Só uma
 * auditoria PENDENTE muda; o Reabrir exige o motivo (o refino precisa saber o que mudar) e o card ainda em um status
 * de entrega. Devolve o card novo ou o erro. PURA.
 */
export function applyDeliveryAuditOutcome(
  card: Card,
  config: BoardConfig,
  input: { outcome: "confirmed" | "reopened"; today: string; note?: string | null; destination?: string },
): { card: Card } | { error: string } {
  const audit = card.deliveryAudit;
  if (!audit || audit.auditedAt) return { error: `nenhuma auditoria de entrega pendente em ${card.id}` };
  const closed: DeliveryAuditRecord = { ...audit, auditedAt: input.today, outcome: input.outcome };
  if (input.outcome === "confirmed") return { card: { ...card, deliveryAudit: closed } };

  const note = input.note?.trim() ?? "";
  if (!note) return { error: "Reabrir pede o motivo: o que está errado nesta entrega (o refino parte dele)." };
  if (card.type !== "story") return { error: "só stories são reabertas" };
  if (!card.status || !deliveredStatusIds(config).has(card.status)) {
    return { error: `o card já saiu de uma coluna de entrega (${card.status ?? "sem status"}) — confirme a auditoria ou trate a reabertura que já está em curso` };
  }
  const destination = input.destination ?? DELIVERY_AUDIT_REOPEN_DEFAULT;
  if (!isReopenDestination(destination)) return { error: `destino de reabertura inválido: ${destination} (enriquecer | design-ux | desenvolver)` };
  if (!config.statuses.some((s) => s.id === destination)) return { error: `coluna de destino inexistente neste board: ${destination}` };
  const finding: Finding = {
    id: DELIVERY_AUDIT_FINDING_ID,
    lens: "general",
    severity: "high",
    status: "open",
    title: "Entrega reaberta na auditoria por amostra do dono",
    detail: note,
  };
  const reopened = applyReopen(card, {
    mode: "refine",
    refinement: {
      brief: `Entrega autônoma reaberta pelo dono na auditoria por amostra: ${note}`,
      kinds: ["functionality"],
      target: null,
      screenshot: null,
      openedAt: input.today,
    },
  });
  return {
    card: {
      ...reopened,
      status: destination,
      reopenPending: true,
      findings: upsertFinding(card.findings ?? [], finding),
      deliveryAudit: { ...closed, note },
    },
  };
}

/** Quanto da `## Prova da entrega` o Inbox mostra (o resto está no card). */
const PROOF_MAX = 2000;

/**
 * A seção `## Prova da entrega` do corpo do card (o que o condutor escreveu ao entregar), para o dono auditar no
 * próprio Inbox. Vazia/ausente ⇒ null. PURA.
 */
export function deliveryProofOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^##\s+Prova da entrega\s*$/i.test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  const text = out.join("\n").trim();
  if (!text) return null;
  return text.length > PROOF_MAX ? `${text.slice(0, PROOF_MAX).trimEnd()}…` : text;
}
