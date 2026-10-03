// WS-0 — the PURE kernel of "the next obvious action, in one click", for the COMPACT
// surfaces (the kanban card footer, /processes). Column-agnostic and testable in node (no React, no IO):
//
//  1. QuickAction / QuickActionInvoke — the SERIALIZABLE action a compact button fires, mapping 1:1 to a server
//     action that ALREADY exists; the client dispatcher (QuickActionButton → quick-action-run) is the only thing
//     that runs it.
//  2. blockedTargets — the pure decision the MoveToPopover tooltip (D11) consumes.
//
// O registry por kind do Inbox (QUICK_ACTIONS_OF) saiu na onda 2: o que cada item oferece — o rótulo, a
// consequência, a pré-condição — mora no modelo do item (inbox/decision.ts), e onde o Kanban ou o /processes mostram
// a MESMA ação, leem de lá ({@link optionAsQuickAction}).

import type { BoardConfig, Card, FindingStatus, GateId, RiskClass, StatusDef } from "./types";
import type { CockpitItem, MergeFailedCockpitItem } from "./demands";
import { decideItem, primaryOption, type DecisionOption } from "./inbox/decision";
import type { EscalationRef } from "./copilot/escalation";
import { evaluateGate } from "./gates";
import type { ActionOutcome } from "./action-outcome";

export type QuickActionTone = "primary" | "neutral" | "danger";

/**
 * The SERIALIZABLE action a quick-action fires — never a closure — mapping 1:1 to an EXISTING server
 * action (D2/D6). Frozen in WS-0; WS-3/WS-5 extend the union (getPublishStatusAction /
 * requeueMergeEntryAction) in the same card that re-touches the exhaustive Record.
 */
export type QuickActionInvoke =
  | { kind: "move-card"; boardId: string; cardId: string; status: string } // moveCardAction
  | { kind: "run-skill"; boardId: string; cardId: string } // runCardSkillAction
  | { kind: "force-release"; boardId: string; cardId: string } // forceReleaseRunAction
  | { kind: "resolve-merge"; runId: string; action: "merged" | "aborted" } // resolveMergeConflictAction
  | { kind: "resolve-gate"; runId: string; action: "retry" | "abort" } // resolveGateFailedAction
  // `acknowledged` entra aqui com o kind `finding` (o AVISO). O par "fixed | wontfix" datava de quando o único
  // finding com superfície era o BLOCKER, para quem os dois desfechos bastam (o gate só quer saber se ele saiu
  // de `open`). Um aviso tem um terceiro desfecho legítimo e mais comum — "eu vi, é conhecido, fica registrado"
  // —, e sem ele o operador (e o Autônomo) só podiam dizê-lo mentindo (`fixed`) ou apagando (`wontfix`). Nunca
  // `open`: esta invoke é o ato de TRIAR, e "triar de volta para aberto" não é desfecho — é o estado inicial.
  | { kind: "update-finding"; boardId: string; cardId: string; findingId: string; status: Exclude<FindingStatus, "open"> } // updateFindingStatusAction
  | { kind: "discard-branch"; branch: string } // discardPreservedBranchAction
  | { kind: "link"; href: string } // router.push
  | { kind: "escalate"; ref: EscalationRef } // D4 — ?copilot=<ref>
  | { kind: "requeue-merge"; runId: string } // requeueMergeEntryAction (WS-5)
  // O ACEITE da triagem: promove o card da quarentena para a raia que o tipo dele pede (acceptRoute).
  // A ação de servidor existia desde a Opção B, mas SÓ o MCP a chamava — nenhuma superfície humana tinha
  // o botão. O operador via "revise e aceite ou rejeite no card", abria o card e não achava nem aceitar
  // nem rejeitar; a quick-action do kind mandava de volta ao Inbox. Um laço fechado, sem saída.
  | { kind: "accept-triage"; boardId: string; cardId: string } // acceptTriageCardAction
  // deleteCardAction (lixeira reversível). `withDependents` = leva junto o que depende do card (o «Descartar» do Inbox).
  | { kind: "delete-card"; boardId: string; cardId: string; withDependents?: boolean }
  // Re-publicar um card PARADO no passo de publicação (o settle chegou e não provou). Mover para o MESMO passo
  // não re-dispara o efeito de entrada (não é mudança de status) — daí uma invoke própria.
  | { kind: "republish"; boardId: string; cardId: string } // republishCardAction
  // B1 — a aprovação IRREVERSÍVEL da exclusão de dados de uma descontinuação. Era um move-card (o item reusava o
  // gate), que arquivava o card sem nunca apagar nada — a aprovação real só existia na página do card.
  | { kind: "approve-data-deletion"; boardId: string; cardId: string }; // approveDataDeletionAction

export interface QuickAction {
  /** stable within the set (key for pending/telemetry), e.g. "resolve-merge:merged". */
  id: string;
  /** short PT-BR label (invariant 10: generic per scenario, specific per DATA). */
  label: string;
  tone: QuickActionTone;
  /**
   * A CONSEQUÊNCIA do clique, em uma frase de produto — o que muda no board se o operador apertar ESTE botão.
   * Vira o `title` (tooltip) do botão para que a decisão seja informada ANTES do clique, sem depender de abrir o
   * ConfirmDialog (que só existe nos destrutivos). Escreva em termos de produto/decisão, não de mecânica interna.
   */
  description?: string;
  /** present ⇒ the dispatcher interposes a ConfirmDialog; tone 'danger' paints it red. */
  confirm?: { title: string; body: string };
  /** micro-copy near the button (e.g. D15 — "infra: retry deve resolver"). */
  hint?: string;
  /** present ⇒ the button renders DISABLED with this reason (e.g. Re-publish with deployFiredAt). */
  disabled?: string;
  /**
   * PARA ONDE este botão manda o card — o NOME humano do passo de destino (só em ação que move).
   * É dado, não enfeite: uma superfície com espaço (o Inbox) imprime "Aprovar → Plano & Tarefas" e o
   * operador lê o destino NO botão, do jeito que o "Merge into main" do GitHub faz; uma superfície apertada
   * (o rodapé do card no kanban) omite. Antes o destino só existia solto — numa seta sem legenda ao lado de
   * uma fileira de botões —, e a leitura natural virava "o card vai para lá", invertendo o sentido do fluxo.
   */
  destination?: string;
  /** risk class for the D7 human-click trail (SENSITIVE_AUDIT_CLASSES ⇒ logHumanActionAction). */
  auditCls: RiskClass;
  invoke: QuickActionInvoke;
}

export interface QuickActionSet {
  /** HAPPY path (0..1). */
  primary: QuickAction | null;
  /** SAD path + auxiliaries (0..n, display order). */
  secondary: QuickAction[];
  /** the HITL escalate button (D4) — null only where escalating makes no sense. */
  escalate: QuickAction | null;
}

/** Context some kinds need beyond the item (the card supplies gates/deployFiredAt/findings). */
export interface QuickActionCtx {
  config: BoardConfig;
  card?: Card;
}

/** D7 — the classes whose human click writes an audit trail (the F5 guard doesn't intercept a full actor). */
export const SENSITIVE_AUDIT_CLASSES: ReadonlySet<RiskClass> = new Set<RiskClass>([
  "run",
  "merge-resolve",
  "deploy",
  "destructive",
]);

/**
 * WS-3 §3.5 (D12) — pretty-print a canonical-args JSON string for display (the item/confirm evidence
 * block). Falls back to the RAW string on parse failure (a 2KB-truncated arg can be invalid JSON) —
 * NEVER throws, so a malformed/truncated payload still renders something instead of crashing the row.
 */
export function prettyCanonicalArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** The escalate action of EVERY kind — navigation only (auditCls read; the power lives in the chat, D8). */
export function buildEscalateAction(ref: EscalationRef, label = "Pedir ao Jido"): QuickAction {
  return {
    id: `escalate:${ref.kind}`,
    label,
    tone: "neutral",
    description: "Abre o Jido já com este item carregado — para você conversar, pedir uma recomendação ou mandar ele cuidar disso. Não muda nada sozinho.",
    auditCls: "read",
    invoke: { kind: "escalate", ref },
  };
}

/** D11 — the destinations the MoveToPopover OMITS today, with the WHY (a pre-explanatory tooltip). Exact
 *  complement of moveTargets over the SAME isomorphic checkGate: every status ≠ current whose gate FAILS. */
export interface BlockedTarget {
  status: StatusDef;
  gate: GateId;
  gateLabel: string; // evaluateGate().label — derived from GATES, never re-declared
  message: string; // evaluateGate().message — the same PT-BR the server would return on the move
  fix?: string; // evaluateGate().fix
}

export function blockedTargets(card: Card, config: BoardConfig): BlockedTarget[] {
  const out: BlockedTarget[] = [];
  for (const s of config.statuses) {
    if (s.id === card.status) continue;
    const verdict = evaluateGate(card, s.id, config);
    if (!verdict) continue; // no gate, or gate passes → not blocked (it's a moveTargets destination instead)
    out.push({ status: s, gate: verdict.gate, gateLabel: verdict.label, message: verdict.message, fix: verdict.fix });
  }
  return out;
}

// ── A ponte do modelo do Inbox para o botão compacto ─────────────────────────────────────────────────
// O registry por kind (QUICK_ACTIONS_OF) saiu na onda 2 do Inbox: o que cada item oferece, com a consequência e a
// pré-condição, mora no modelo do item (inbox/decision.ts). O rodapé do card do Kanban mostra a opção do item de
// Decidir do card (inbox/decidir-set.ts) por {@link optionAsQuickAction} — o slot próprio dele (cardNextAction, que
// montava a sua demanda com o modelo legado e pintava «Publicar de novo» de vermelho em card que o sistema republicava)
// saiu: card fora de Decidir não tem botão de resolver.

/** Os invokes que o botão do Kanban executa (QuickActionButton). */
const QUICK_INVOKE_KINDS: ReadonlySet<string> = new Set<QuickActionInvoke["kind"]>([
  "move-card",
  "run-skill",
  "force-release",
  "resolve-merge",
  "resolve-gate",
  "update-finding",
  "discard-branch",
  "link",
  "escalate",
  "requeue-merge",
  "accept-triage",
  "delete-card",
  "republish",
  "approve-data-deletion",
]);

/**
 * Uma opção do modelo do Inbox como botão compacto (Kanban, /processes) — a MESMA ação, o mesmo rótulo, a mesma
 * consequência e a mesma recusa. null quando a opção não é algo que o botão executa (um formulário, um passo a passo).
 */
export function optionAsQuickAction(o: DecisionOption | null | undefined): QuickAction | null {
  if (!o || !QUICK_INVOKE_KINDS.has(o.invoke.kind)) return null;
  return {
    id: o.id,
    label: o.label,
    tone: o.tone,
    description: o.consequence,
    ...(o.confirm ? { confirm: o.confirm } : {}),
    ...(o.disabled ? { disabled: o.disabled.reason } : {}),
    auditCls: o.auditCls,
    invoke: o.invoke as QuickActionInvoke,
  };
}

/** A decisão de um item, sem card nem board (o /processes lista entradas do train sem a config do board). */
const BARE_CONFIG = { statuses: [] } as unknown as BoardConfig;

/** O conjunto de botões de um item, lido do modelo: a principal, as alternativas e o «Pedir ao Jido». */
function decisionSet(item: CockpitItem, config: BoardConfig, card?: Card): QuickActionSet {
  const d = decideItem(item, { config, card, now: Date.now(), tier: "chat" });
  const all = d.options.map(optionAsQuickAction).filter((a): a is QuickAction => a !== null);
  const escalate = all.find((a) => a.invoke.kind === "escalate") ?? optionAsQuickAction(d.more.find((o) => o.invoke.kind === "escalate"));
  const actions = all.filter((a) => a.invoke.kind !== "escalate");
  const primaryId = primaryOption(d)?.id;
  const primary = actions.find((a) => a.id === primaryId) ?? actions[0] ?? null;
  return { primary, secondary: actions.filter((a) => a !== primary), escalate: escalate ?? null };
}

/** WS-5 — the /processes MergeQueueRow (a cross-board page with NO BoardConfig at hand) needs the merge-failed
 *  actions WITHOUT a config: o modelo do item decide sem card (a decisão de integração falha não lê a config). */
export function mergeFailedActionsFor(item: MergeFailedCockpitItem): QuickActionSet {
  return decisionSet(item, BARE_CONFIG);
}

// ── O retorno do clique (B2) ──────────────────────────────────────────────────────────────────────────

/** O que um clique BEM-SUCEDIDO fez, por invoke — quando a ação de servidor não devolve um desfecho próprio.
 *  EXAUSTIVO (o Record obriga): um invoke novo não compila sem dizer o que ele faz. Nunca «<rótulo>: ok». */
const DONE_TEXT: { [K in QuickActionInvoke["kind"]]: (invoke: Extract<QuickActionInvoke, { kind: K }>, action: QuickAction) => string } = {
  "move-card": (_i, a) => (a.destination ? `O card foi para «${a.destination}».` : "O card mudou de etapa."),
  "run-skill": () => "O agente começou a rodar de novo. Acompanhe em Processos; se falhar, o Inbox mostra.",
  "force-release": () => "A execução foi liberada — o card pode rodar de novo.",
  "resolve-merge": (i) =>
    i.action === "merged" ? "Marcado como integrado — a fila de integração segue." : "Trabalho descartado — a fila de integração segue sem ele.",
  "resolve-gate": (i) =>
    i.action === "retry" ? "Os testes de integração começaram de novo." : "Trabalho descartado — a fila de integração segue sem ele.",
  "update-finding": (i) =>
    i.status === "fixed"
      ? "Marcado como resolvido."
      : i.status === "wontfix"
        ? "Marcado como «não corrigir»."
        : "Registrado como conhecido — fica no card, sem travar nada.",
  "discard-branch": () => "Branch apagada — esse trabalho não volta.",
  link: () => "Aberto.",
  escalate: () => "O Jido abriu com este item.",
  "requeue-merge": () => "A integração começou de novo: a branch voltou para a fila.",
  "accept-triage": (_i, a) => (a.destination ? `Aceito — o card foi para «${a.destination}».` : "Aceito — o card entrou no fluxo."),
  "delete-card": () => "Descartado — o card foi para a lixeira do board (recuperável por 7 dias).",
  republish: () => "A publicação começou de novo. Se não der certo, o card e o Inbox dizem por quê.",
  "approve-data-deletion": () => "Exclusão aprovada — o agente de descontinuação começou a apagar os dados.",
};

/**
 * B2 — a frase do toast depois de um clique: o desfecho que o SERVIDOR devolveu (`data.outcome` — iniciado × feito),
 * senão a frase própria do invoke; na recusa, o motivo do servidor. Antes era `${label}: ok` para tudo — inclusive
 * para uma publicação que só tinha sido DISPARADA e falhava depois, em silêncio. PURE.
 */
export function quickActionFeedback(
  action: QuickAction,
  res: { ok: true; data?: unknown } | { ok: false; error: string },
): { tone: "success" | "error"; text: string } {
  if (!res.ok) return { tone: "error", text: res.error };
  const outcome = (res.data as { outcome?: ActionOutcome } | undefined)?.outcome;
  if (outcome?.message) return { tone: outcome.status === "refused" ? "error" : "success", text: outcome.message };
  const done = DONE_TEXT[action.invoke.kind] as (i: QuickActionInvoke, a: QuickAction) => string;
  return { tone: "success", text: done(action.invoke, action) };
}
