// O DESPACHANTE das ações de servidor que um botão de ação dispara — UM mapeamento de `invoke` para a ação de servidor
// que o executa, compartilhado pelo botão do Kanban (QuickActionButton) e pelo cartão do Inbox (InboxItemCard). Antes
// ele vivia dentro do botão, e o Inbox precisaria de uma segunda cópia do switch: duas cópias de "o que este clique
// faz" divergem no primeiro kind novo.
//
// Só o que roda no SERVIDOR mora aqui. Navegar (`link`), abrir o Jido (`escalate`), mostrar um passo a passo (`howto`)
// e abrir o status da publicação são gestos de tela — quem desenha o botão os trata.

import {
  acceptProposalAction,
  acceptTriageCardAction,
  answerQuestionAction,
  approveActionRequestAction,
  approveDataDeletionAction,
  approveGovernanceDraftAction,
  deleteCardAction,
  discardPreservedBranchAction,
  forceReleaseRunAction,
  moveCardAction,
  refineProposalAction,
  rejectActionRequestAction,
  rejectGovernanceDraftAction,
  renewCapacityMeterAction,
  republishCardAction,
  authorizePublishAction,
  fixFindingAction,
  requestDesignChangeAction,
  requeueMergeEntryAction,
  resolveDeliveryAuditAction,
  resolveGateFailedAction,
  resolveMergeConflictAction,
  resolveProxyAuditAction,
  runCardSkillAction,
  undoSystemDecisionAction,
  updateFindingStatusAction,
} from "@/app/actions";
import { logHumanActionAction } from "@/app/audit-actions";
import { encodeEscalationRef, type EscalationRef } from "@/lib/storymap/copilot/escalation";
import { SENSITIVE_AUDIT_CLASSES, type QuickActionInvoke } from "@/lib/storymap/quick-actions";
import type { OptionInvoke } from "@/lib/storymap/inbox/decision";
import type { ActionOutcome } from "@/lib/storymap/action-outcome";
import { meterRenewMessage } from "@/components/inicio/cockpit-labels";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";
import type { RiskClass } from "@/lib/storymap/types";

export type ActionResult = { ok: true; data?: unknown } | { ok: false; error: string };

/** O que o clique precisa além do invoke: o que o dono escreveu ou escolheu no corpo do item. */
export interface InvokePayload {
  answer?: string;
  selectedOptionIds?: string[];
  note?: string;
  items?: ProposedItem[];
}

/** Os invokes que são GESTO DE TELA (navegar, abrir o Jido, mostrar instruções) — nunca vão ao servidor. */
export type ScreenInvoke = Extract<OptionInvoke, { kind: "link" | "escalate" | "howto" | "show-publish-status" }>;
export type ServerInvoke = Exclude<OptionInvoke, ScreenInvoke>;

/** invoke.kind → o nome da ação de servidor que entra na trilha D7 do clique humano. */
export const TOOL_OF: Record<OptionInvoke["kind"], string> = {
  "move-card": "moveCardAction",
  "run-skill": "runCardSkillAction",
  "force-release": "forceReleaseRunAction",
  "resolve-merge": "resolveMergeConflictAction",
  "resolve-gate": "resolveGateFailedAction",
  "update-finding": "updateFindingStatusAction",
  "discard-branch": "discardPreservedBranchAction",
  link: "link",
  escalate: "escalate",
  "requeue-merge": "requeueMergeEntryAction",
  "accept-triage": "acceptTriageCardAction",
  "delete-card": "deleteCardAction",
  republish: "republishCardAction",
  "approve-data-deletion": "approveDataDeletionAction",
  "answer-question": "answerQuestionAction",
  "approve-governance": "approveGovernanceDraftAction",
  "reject-governance": "rejectGovernanceDraftAction",
  "grant-request": "approveActionRequestAction",
  "deny-request": "rejectActionRequestAction",
  "resolve-proxy-audit": "resolveProxyAuditAction",
  "resolve-delivery-audit": "resolveDeliveryAuditAction",
  "accept-proposal": "acceptProposalAction",
  "refine-proposal": "refineProposalAction",
  "request-redesign": "requestDesignChangeAction",
  "renew-meter": "renewCapacityMeterAction",
  "undo-system-decision": "undoSystemDecisionAction",
  "show-publish-status": "getPublishStatusAction",
  "authorize-publish": "authorizePublishAction",
  "fix-finding": "fixFindingAction",
  howto: "howto",
};

/** É um gesto de tela (não vai ao servidor)? */
export function isScreenInvoke(invoke: OptionInvoke): invoke is ScreenInvoke {
  return invoke.kind === "link" || invoke.kind === "escalate" || invoke.kind === "howto" || invoke.kind === "show-publish-status";
}

/** Roda a ação de servidor de um invoke. Nunca lança: a recusa volta como `{ ok: false, error }`. */
export async function runServerInvoke(invoke: ServerInvoke, payload: InvokePayload = {}): Promise<ActionResult> {
  try {
    switch (invoke.kind) {
      case "move-card":
        return await moveCardAction({ boardId: invoke.boardId, cardId: invoke.cardId, status: invoke.status });
      case "run-skill":
        return await runCardSkillAction({ boardId: invoke.boardId, cardId: invoke.cardId });
      case "force-release":
        return await forceReleaseRunAction({ boardId: invoke.boardId, cardId: invoke.cardId });
      case "resolve-merge":
        return await resolveMergeConflictAction({ runId: invoke.runId, action: invoke.action });
      case "resolve-gate":
        return await resolveGateFailedAction({ runId: invoke.runId, action: invoke.action });
      case "update-finding":
        return await updateFindingStatusAction({ boardId: invoke.boardId, cardId: invoke.cardId, findingId: invoke.findingId, status: invoke.status });
      case "discard-branch":
        return await discardPreservedBranchAction({ branch: invoke.branch });
      case "requeue-merge":
        return await requeueMergeEntryAction({ runId: invoke.runId });
      case "accept-triage":
        return await acceptTriageCardAction({ boardId: invoke.boardId, cardId: invoke.cardId });
      case "delete-card":
        return await deleteCardAction({ boardId: invoke.boardId, cardId: invoke.cardId, reason: "descartado pelo Inbox", ...(invoke.withDependents ? { withDependents: true } : {}) });
      case "republish":
        return await republishCardAction({ boardId: invoke.boardId, cardId: invoke.cardId });
      case "approve-data-deletion":
        return await approveDataDeletionAction({ boardId: invoke.boardId, cardId: invoke.cardId });
      case "answer-question":
        return await answerQuestionAction({
          boardId: invoke.boardId,
          cardId: invoke.cardId,
          questionId: invoke.questionId,
          answer: (payload.answer ?? "").trim(),
          ...(payload.selectedOptionIds?.length ? { selectedOptionIds: payload.selectedOptionIds } : {}),
        });
      case "approve-governance":
        return await approveGovernanceDraftAction({ boardId: invoke.boardId, draftId: invoke.draftId });
      case "reject-governance":
        return await rejectGovernanceDraftAction({ boardId: invoke.boardId, draftId: invoke.draftId });
      case "grant-request":
        return await approveActionRequestAction({ boardId: invoke.boardId, approvalId: invoke.approvalId });
      case "deny-request":
        return await rejectActionRequestAction({ boardId: invoke.boardId, approvalId: invoke.approvalId });
      case "resolve-proxy-audit":
        return await resolveProxyAuditAction({ boardId: invoke.boardId, cardId: invoke.cardId, questionId: invoke.questionId, outcome: invoke.outcome });
      case "resolve-delivery-audit":
        return await resolveDeliveryAuditAction({
          boardId: invoke.boardId,
          cardId: invoke.cardId,
          outcome: invoke.outcome,
          ...(invoke.outcome === "reopened" ? { note: payload.note ?? "" } : {}),
        });
      case "accept-proposal":
        return await acceptProposalAction({ boardId: invoke.boardId, containerId: invoke.containerId, items: payload.items ?? [] });
      case "refine-proposal":
        return await refineProposalAction({ boardId: invoke.boardId, containerId: invoke.containerId, feedback: (payload.note ?? "").trim() });
      case "request-redesign":
        return await requestDesignChangeAction({ boardId: invoke.boardId, cardId: invoke.cardId, feedback: "" });
      case "renew-meter": {
        // O governador devolve um desfecho (renovado, segue parado, falhou, sem keepalive): ele vira a frase do recibo, e
        // o que não renovou é dito como recusa — nunca «feito» sobre um medidor que continua parado.
        const res = await renewCapacityMeterAction();
        if (!res.ok || !res.data) return res.ok ? { ok: false, error: "O servidor não respondeu ao pedido de leitura." } : res;
        const msg = meterRenewMessage(res.data);
        const outcome: ActionOutcome = msg.tone === "success" ? { status: "done", message: msg.text } : { status: "refused", message: msg.text };
        return { ok: true, data: { outcome } };
      }
      case "fix-finding":
        return await fixFindingAction({ boardId: invoke.boardId, cardId: invoke.cardId, findingId: invoke.findingId });
      case "authorize-publish":
        return await authorizePublishAction({ boardId: invoke.boardId, causeKey: invoke.causeKey });
      case "undo-system-decision":
        return await undoSystemDecisionAction({ boardId: invoke.boardId, decisionId: invoke.decisionId, note: payload.note?.trim() || null });
      default: {
        const never: never = invoke;
        return { ok: false, error: `ação desconhecida: ${(never as { kind: string }).kind}` };
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** D7 — a trilha do clique humano numa classe sensível (fire-and-forget: nunca condiciona o retorno). */
export function auditHumanClick(input: { surface: string; invoke: OptionInvoke; cls: RiskClass; boardId: string; cardId?: string; note: string }): void {
  if (!SENSITIVE_AUDIT_CLASSES.has(input.cls)) return;
  void logHumanActionAction({ surface: input.surface, tool: TOOL_OF[input.invoke.kind], cls: input.cls, boardId: input.boardId, cardId: input.cardId, note: input.note });
}

/**
 * O endereço que abre o Jido já com o item carregado (D4 — `?copilot=<ref>`). No mesmo board, sobre a query ATUAL
 * (chamar o Jido não apaga a busca da tela); noutro lugar, o Kanban do board do item (o cabeçalho lê o parâmetro).
 */
export function escalateHref(ref: EscalationRef, pathname: string | null, search: string): string {
  const enc = encodeEscalationRef(ref);
  const prefix = `/board/${ref.boardId}/`;
  if (pathname && pathname.startsWith(prefix)) {
    const next = new URLSearchParams(search);
    next.set("copilot", enc);
    return `${pathname}?${next}`;
  }
  return `/board/${ref.boardId}/kanban?copilot=${enc}`;
}

/** Re-exportado: o botão do Kanban segue tipando pelo invoke antigo. */
export type { QuickActionInvoke };
