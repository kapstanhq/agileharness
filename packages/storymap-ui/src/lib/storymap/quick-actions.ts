// WS-0 (copilot-actionability) — the PURE kernel of "the next obvious action, in one click". Two things
// live here, both column-agnostic and testable in node (no React, no IO, no import of app/**):
//
//  1. QUICK_ACTIONS_OF — an EXHAUSTIVE Record<CockpitItemKind, …> (D2): for each cockpit item kind, the
//     happy `primary`, the sad `secondary`, and the HITL `escalate` (D4). Every `invoke` is a SERIALIZABLE
//     discriminated union mapping 1:1 to a server action that ALREADY exists; the client dispatcher
//     (QuickActionButton) is the only thing that runs it. Remove a kind ⇒ the typecheck breaks (the pattern
//     of RENDERERS / RUN_SUBSTATE_VIEW / COCKPIT_GROUP_OF).
//  2. cardNextAction / blockedTargets / mergeEntryDemand / runRetryLabel — the pure decisions the kanban
//     slot (WS-2), the MoveToPopover tooltip (D11) and the merge-demand gap (verified: no runId Demand
//     exists today) consume.
//
// The canonical "next step" is `moveTargets(card, config).find(t => t.recommended)` (D3) — decideAdvance
// stays INTOCADO; a parity test (advance-parity.test.ts) pins the two together.

import type { BoardConfig, Card, FailureClass, FindingStatus, GateId, RiskClass, StatusDef } from "./types";
import type { CockpitItem, CockpitItemKind, Demand, MergeFailedCockpitItem } from "./demands";
import type { RunSubstate } from "./run-substate";
import type { MergeQueueEntry } from "./runner/types";
import type { EscalationRef, EscalationTemplateId } from "./copilot/escalation";
import { processesServiceHref, runServiceId } from "./deep-links";
import { moveTargets } from "./move-targets";
import { evaluateGate } from "./gates";
import { acceptRoute } from "./triage/parse";

export type QuickActionTone = "primary" | "neutral" | "danger";

/**
 * The SERIALIZABLE action a quick-action fires — never a closure — mapping 1:1 to an EXISTING server
 * action (D2/D6). Frozen in WS-0; WS-3/WS-5 extend the union (getDeployFailureLogAction /
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
  | { kind: "delete-card"; boardId: string; cardId: string }; // deleteCardAction (lixeira reversível)

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

/** The stable id of the durable run-death finding (mirrors runner/run-death.ts RUN_DEATH_FINDING_ID —
 *  NOT imported: that module pulls in write.ts/fs and this kernel must stay client-safe/pure). */
const RUN_DEATH_FINDING_ID = "run-death";

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
export function buildEscalateAction(ref: EscalationRef, label = "Copiloto"): QuickAction {
  return {
    id: `escalate:${ref.kind}`,
    label,
    tone: "neutral",
    description: "Abre o Jido já com este item carregado — para você conversar, pedir uma recomendação ou mandar ele cuidar disso. Não muda nada sozinho.",
    auditCls: "read",
    invoke: { kind: "escalate", ref },
  };
}

/**
 * D15 — the run-death `failureClass` becomes UX (it was dead text in the finding detail): an `infra`
 * death retries clean; an `app`/`test` death warns that retry likely re-fails and to escalate.
 */
export function runRetryLabel(failureClass: FailureClass | undefined): { label: string; hint?: string } {
  if (failureClass === "infra") return { label: "Tentar novamente", hint: "infra: retry deve resolver" };
  if (failureClass === "test" || failureClass === "app") {
    return { label: "Tentar novamente", hint: "retry tende a falhar — considere escalar" };
  }
  return { label: "Tentar novamente" };
}

/**
 * Close the verified gap (no Demand carries a runId today — cardDemands never emits merge-conflict/
 * merge-gate-failed): synthesize the Demand of a PARKED merge-train entry so the kanban caller can fold
 * it into `dominantDemand([...cardDemands, mergeEntryDemand])`. null when the entry isn't parked.
 */
export function mergeEntryDemand(
  entry: Pick<MergeQueueEntry, "runId" | "status" | "board" | "cardId">,
  card: Pick<Card, "id" | "title" | "status">,
): Demand | null {
  const type =
    entry.status === "conflict" ? "merge-conflict" : entry.status === "gate-failed" ? "merge-gate-failed" : null;
  if (!type) return null;
  return {
    type,
    boardId: entry.board,
    cardId: card.id,
    cardTitle: card.title,
    status: card.status ?? null,
    label: type === "merge-conflict" ? "Resolver conflito de merge" : "Gate de integração reprovou",
    severity: "high",
    runId: entry.runId,
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

// ── The exhaustive registry ──────────────────────────────────────────────────────────────────────

const emptySet = (escalate: QuickAction | null): QuickActionSet => ({ primary: null, secondary: [], escalate });

/** blocker template by finding-id prefix (+ QA-red when a `testing` lens sits in the QA column). */
function blockerTemplateId(findingId: string, lens: string | undefined, cardStatus: string | null | undefined): EscalationTemplateId {
  if (findingId.startsWith("merge-back-")) return "blocker-merge-back";
  if (findingId.startsWith("secret-scan-")) return "blocker-secret-scan";
  if (lens === "testing" && cardStatus === "qa-automatizado") return "qa-red";
  return "blocker-generic";
}

/** The step whose entry effect promotes+deploys — the "Re-publish"/"Publish" target (null on boards without it). */
function promoteAndDeployStep(config: BoardConfig): StatusDef | undefined {
  return config.statuses.find((s) => s.onEnter === "promote-and-deploy");
}

/** Re-publish quick-action for a failed deploy (danger; disabled while a deploy is in flight — risk 5). */
function rePublishAction(config: BoardConfig, boardId: string, cardId: string, deployFiredAt: string | undefined): QuickAction | null {
  const step = promoteAndDeployStep(config);
  if (!step) return null;
  return {
    id: "move-card:re-publish",
    label: "Re-publicar",
    tone: "danger",
    description: `Tenta publicar em produção de novo — move o card para "${step.name}" e dispara o deploy. Use depois de corrigir o que fez a publicação falhar.`,
    confirm: { title: "Re-publicar?", body: `Move o card para "${step.name}" e dispara o deploy de produção novamente.` },
    ...(deployFiredAt ? { disabled: "deploy em voo (deployFiredAt) — aguarde o settle" } : {}),
    auditCls: "deploy",
    invoke: { kind: "move-card", boardId, cardId, status: step.id },
  };
}

type EntryMap = { [K in CockpitItemKind]: (item: Extract<CockpitItem, { kind: K }>, ctx: QuickActionCtx) => QuickActionSet };

/**
 * EXHAUSTIVE per-kind registry — TS breaks if a kind is missing (the RENDERERS / RUN_SUBSTATE_VIEW
 * pattern). WS-5 adds its new kinds HERE together with their renderer. Each entry receives the NARROWED
 * item member (the mapped type preserves the discriminant — no `as`).
 */
export const QUICK_ACTIONS_OF: EntryMap = {
  question: (item) =>
    // Answering is the renderer's inline form (WS-3); the cheapest pair in the catalogue — escalate only.
    emptySet(
      buildEscalateAction({
        templateId: "question-pending",
        kind: "question",
        boardId: item.boardId,
        cardId: item.cardId,
        questionId: item.questionId,
      }),
    ),

  // Um AVISO (non-blocker). Os MESMOS três desfechos do blocker, em outra ORDEM e sem confirmação — e a
  // diferença é toda semântica, não cosmética: nada aqui destrava gate nenhum (é o que "non-blocker" quer
  // dizer), então nenhum destes botões deixa um card passar sem conserto, e a confirmação do blocker
  // ("o card avança sem o conserto") seria simplesmente FALSA. O primário é `acknowledged` porque esse é o
  // desfecho honesto do caso comum — dívida conhecida, registrada e visível — e porque era um estado MORTO:
  // FindingStatus sempre teve 4 membros e nenhuma superfície escrevia este, então "eu vi, é conhecido, segue"
  // só podia ser dito mentindo (`fixed`) ou apagando (`wontfix`).
  finding: (item, ctx) => {
    const mk = (status: "acknowledged" | "fixed" | "wontfix", label: string, description: string) => ({
      id: `update-finding:${status}`,
      label,
      tone: "neutral" as const,
      description,
      auditCls: "write-board" as const,
      invoke: { kind: "update-finding" as const, boardId: item.boardId, cardId: item.cardId, findingId: item.findingId, status },
    });
    return {
      primary: mk(
        "acknowledged",
        "Registrar como conhecido",
        "Marca o aviso como visto e aceito — fica registrado, mas não trava o card. Use quando é uma dívida conhecida que você decidiu não consertar agora.",
      ),
      secondary: [
        mk("fixed", "Marcar resolvido", "Diz que o problema já foi resolvido. O aviso some da lista."),
        mk("wontfix", "Não corrigir", "Descarta o aviso de vez, sem consertar. Use quando ele não se aplica ou não vale a pena."),
      ],
      escalate: buildEscalateAction({
        templateId: blockerTemplateId(item.findingId, item.lens, ctx.card?.status),
        kind: "finding",
        boardId: item.boardId,
        cardId: item.cardId,
        findingId: item.findingId,
      }),
    };
  },

  blocker: (item, ctx) => {
    const template = blockerTemplateId(item.findingId, item.lens, ctx.card?.status);
    return {
      primary: {
        id: "update-finding:fixed",
        label: "Marcar resolvido",
        tone: "neutral",
        description: "Diz que você já resolveu o que travava. Quando o último bloqueio fecha, o card volta a andar sozinho.",
        confirm: {
          title: "Marcar resolvido?",
          body: `Finding ${item.findingId}${item.title ? ` — ${item.title}` : ""}. O gate libera o card quando o último blocker fecha.`,
        },
        auditCls: "write-board",
        invoke: { kind: "update-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId, status: "fixed" },
      },
      secondary: [
        {
          id: "update-finding:wontfix",
          label: "Não corrigir",
          tone: "neutral",
          description: "Libera o card SEM consertar o bloqueio. Use quando ele não se aplica — o card avança assim mesmo.",
          confirm: { title: "Não corrigir?", body: `Marca ${item.findingId} como wontfix — o card avança sem o conserto.` },
          auditCls: "write-board",
          invoke: { kind: "update-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId, status: "wontfix" },
        },
      ],
      escalate: buildEscalateAction({
        templateId: template,
        kind: "finding",
        boardId: item.boardId,
        cardId: item.cardId,
        findingId: item.findingId,
      }),
    };
  },

  "deploy-failed": (item, ctx) => ({
    // NEVER offer update-finding here — marking resolved without publishing erases the signal (risk 7).
    // "Ver log da falha" is a renderer-local affordance (WS-3, getDeployFailureLogAction).
    primary: rePublishAction(ctx.config, item.boardId, item.cardId, ctx.card?.deployFiredAt),
    secondary: [],
    escalate: buildEscalateAction({ templateId: "deploy-failed", kind: "deploy", boardId: item.boardId, cardId: item.cardId }),
  }),

  gate: (item, ctx) => {
    // Happy = the canonical next step (D3): moveTargets(...).find(recommended). Needs the card.
    let primary: QuickAction | null = null;
    const secondary: QuickAction[] = [];
    if (ctx.card) {
      const card = ctx.card;
      const rec = moveTargets(card, ctx.config).find((t) => t.recommended);
      if (rec) {
        const hasEffect = Boolean(rec.status.onEnter);
        primary = {
          id: "move-card:advance",
          label: "Aprovar & avançar",
          tone: hasEffect ? "danger" : "neutral",
          description: hasEffect
            ? `Aprova o trabalho e move o card para "${rec.status.name}" — isso dispara ${rec.status.onEnter} (ação real, ex.: publicar).`
            : `Aprova o trabalho e move o card para "${rec.status.name}", liberando o próximo passo.`,
          confirm: {
            title: "Aprovar e avançar?",
            body: hasEffect
              ? `Move para "${rec.status.name}" e dispara ${rec.status.onEnter}.`
              : `Move o card para "${rec.status.name}".`,
          },
          destination: rec.status.name,
          auditCls: hasEffect ? "deploy" : "write-board",
          invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: rec.status.id },
        };
      }
      // §3.3 — "Devolver": the nearest ELIGIBLE previous step. moveTargets already filtered by the
      // isomorphic checkGate, so the UI never offers what the server would reject; the recommended
      // destination sits first in `moveTargets`'s order, and the remaining eligible targets follow in
      // PIPELINE order — so filtering out recommended + keeping only indices before the current one and
      // taking the LAST survivor gives the step closest to where the card sits now.
      const idx = ctx.config.statuses.findIndex((s) => s.id === card.status);
      const previous =
        moveTargets(card, ctx.config)
          .filter((t) => !t.recommended)
          .filter((t) => ctx.config.statuses.findIndex((s) => s.id === t.status.id) < idx)
          .at(-1) ?? null;
      if (previous) {
        const currentName = ctx.config.statuses.find((s) => s.id === card.status)?.name ?? card.status ?? "atual";
        secondary.push({
          id: "move-card:devolver",
          label: "Devolver",
          tone: "neutral",
          description: `Manda o card de volta para "${previous.status.name}" — use quando o trabalho ainda precisa de ajuste antes de aprovar.`,
          confirm: {
            title: "Devolver?",
            body: `Volta o card de "${currentName}" para "${previous.status.name}".`,
          },
          destination: previous.status.name,
          auditCls: "write-board",
          invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: previous.status.id },
        });
      }
    }
    return {
      primary,
      secondary,
      escalate: buildEscalateAction({ templateId: "gate-manual-approve", kind: "card", boardId: item.boardId, cardId: item.cardId }),
    };
  },

  approval: (item) => {
    // approve/reject is EXCLUSIVELY human and lives in the renderer — the copiloto explains, never decides.
    const ref: EscalationRef = item.id.startsWith("apr:")
      ? { templateId: "approval-pending", kind: "approval", boardId: item.boardId, approvalId: item.id.slice(4) }
      : { templateId: "approval-pending", kind: "card", boardId: item.boardId, cardId: item.cardId };
    return emptySet(buildEscalateAction(ref));
  },

  // A triagem de baixa confiança tem DUAS saídas e as duas são de 1 clique: entra no fluxo (na raia que o
  // tipo pede — `acceptRoute`, a MESMA regra do servidor e do MCP `accept_triage`) ou vai para a lixeira.
  // O destino vai NO botão porque ele varia com o card: bug → Corrigir, melhoria → Refinar, resto →
  // Entrevista/Enriquecer. Sem card em contexto (superfície sem o pool) sobra só o link para o Inbox, que
  // é onde o card está — degradar para nada seria voltar ao beco.
  review: (item, ctx) => {
    const card = ctx.card;
    const target = card ? ctx.config?.statuses.find((s) => s.id === acceptRoute(card)) : undefined;
    const inQuarantine =
      card && ctx.config?.statuses.find((s) => s.id === card.status)?.staging === true;
    const primary: QuickAction | null =
      card && target && inQuarantine
        ? {
            id: "accept-triage",
            label: "Aceitar",
            tone: "primary",
            description: `Aceita este item da triagem e o coloca no fluxo, em "${target.name}" — daí em diante a automação assume.`,
            destination: target.name,
            auditCls: "write-board",
            invoke: { kind: "accept-triage", boardId: item.boardId, cardId: item.cardId },
          }
        : null;
    const secondary: QuickAction[] = primary
      ? [
          {
            id: "delete-card",
            label: "Descartar",
            tone: "danger",
            description: "Recusa o item: o card vai para a lixeira do board (recuperável por 7 dias). Use quando o reporte não vira trabalho.",
            confirm: {
              title: "Descartar este item?",
              body: `"${item.cardTitle}" vai para a lixeira do board — dá para restaurar de lá por 7 dias.`,
            },
            auditCls: "destructive",
            invoke: { kind: "delete-card", boardId: item.boardId, cardId: item.cardId },
          },
        ]
      : [
          {
            id: "link:inbox",
            label: "Abrir no Inbox",
            tone: "neutral",
            description: "Leva você até este item no Inbox para revisar e decidir.",
            auditCls: "read",
            invoke: { kind: "link", href: `/board/${item.boardId}/inbox?focus=${item.cardId}` },
          },
        ];
    return {
      primary,
      secondary,
      escalate: buildEscalateAction({ templateId: "review-triage", kind: "card", boardId: item.boardId, cardId: item.cardId }),
    };
  },

  stuck: (item, ctx) => {
    const fc = (ctx.card?.findings ?? []).find((f) => f.id === RUN_DEATH_FINDING_ID && f.status === "open")?.failureClass;
    const rl = runRetryLabel(fc);
    return {
      primary: {
        id: "run-skill:retry",
        label: rl.label,
        tone: "primary",
        description: "Roda o agente deste card de novo, do ponto em que parou. Use quando a execução anterior falhou.",
        ...(rl.hint ? { hint: rl.hint } : {}),
        auditCls: "run",
        invoke: { kind: "run-skill", boardId: item.boardId, cardId: item.cardId },
      },
      secondary: [
        {
          id: "link:processes",
          label: "Ver processos",
          tone: "neutral",
          description: "Abre a página de Processos para ver o que está rodando (e o console) deste card.",
          auditCls: "read",
          // WS-4 §4.6 — anchor the "Ver processos" link: StuckCockpitItem has no runId/sessionId
          // (demands.ts), so it ancoras pelo serviço derivado do card (matches ProcessesClient's own
          // `run:<board>/<cardId>` id). Post-restart the service may already be gone — silent, accepted.
          invoke: { kind: "link", href: processesServiceHref(runServiceId(item.boardId, item.cardId)) },
        },
      ],
      escalate: buildEscalateAction({ templateId: "run-death", kind: "run", boardId: item.boardId, cardId: item.cardId }),
    };
  },

  conflict: (item) => {
    // No runId ⇒ nothing to resolve mechanically; only escalate (degraded to a card ref).
    if (!item.runId) {
      return emptySet(
        buildEscalateAction({ templateId: item.conflictKind, kind: "card", boardId: item.boardId, cardId: item.cardId }),
      );
    }
    const runId = item.runId;
    const escalate = buildEscalateAction({
      templateId: item.conflictKind,
      kind: "merge",
      boardId: item.boardId,
      cardId: item.cardId,
      runId,
      entryStatus: item.conflictKind === "merge-conflict" ? "conflict" : "gate-failed",
    });
    if (item.conflictKind === "merge-conflict") {
      return {
        primary: {
          id: "resolve-merge:merged",
          label: "Marcar integrado",
          tone: "neutral",
          description: "Diz que você já resolveu o conflito e integrou à mão. A fila de integração destrava e segue — nada é verificado automaticamente.",
          confirm: { title: "Marcar integrado?", body: "Pressupõe que você já fez o merge manual — nada é verificado." },
          auditCls: "merge-resolve",
          invoke: { kind: "resolve-merge", runId, action: "merged" },
        },
        secondary: [
          {
            id: "resolve-merge:aborted",
            label: "Abortar branch",
            tone: "danger",
            description: "Descarta este trabalho de vez — o que não foi integrado é perdido. A fila destrava sem ele.",
            confirm: { title: "Abortar branch?", body: "Descarta a branch do run — o trabalho não integrado é perdido." },
            auditCls: "merge-resolve",
            invoke: { kind: "resolve-merge", runId, action: "aborted" },
          },
        ],
        escalate,
      };
    }
    // merge-gate-failed
    return {
      primary: {
        id: "resolve-gate:retry",
        label: "Tentar gate novamente",
        tone: "neutral",
        description: "Roda os testes de integração de novo. Use quando a falha foi passageira ou você já corrigiu a causa.",
        auditCls: "merge-resolve",
        invoke: { kind: "resolve-gate", runId, action: "retry" },
      },
      secondary: [
        {
          id: "resolve-gate:abort",
          label: "Abortar",
          tone: "danger",
          description: "Descarta este trabalho de vez — o que não foi integrado é perdido. A fila destrava sem ele.",
          confirm: { title: "Abortar branch?", body: "Descarta a branch do run — o trabalho não integrado é perdido." },
          auditCls: "merge-resolve",
          invoke: { kind: "resolve-gate", runId, action: "abort" },
        },
      ],
      escalate,
    };
  },

  proposal: (item) =>
    emptySet(buildEscalateAction({ templateId: "proposal-capture", kind: "card", boardId: item.boardId, cardId: item.cardId })),

  design: (item) =>
    emptySet(buildEscalateAction({ templateId: "design-wireframe", kind: "card", boardId: item.boardId, cardId: item.cardId })),

  governance: (item) =>
    emptySet(buildEscalateAction({ templateId: "governance-draft", kind: "governance", boardId: item.boardId, draftId: item.draftId })),

  // WS-5 (D9) — read-only + escalate only (D6 rejected a checkDeploySettleAction); "Ver status" is a renderer-local affordance.
  "deploy-unsettled": (item) =>
    emptySet(buildEscalateAction({ templateId: "deploy-unsettled", kind: "deploy", boardId: item.boardId, cardId: item.cardId })),

  // WS-5 (D9) — "Publicar" = the SAME target/mechanism as the deploy-failed re-publish (the promote-and-deploy
  // step) with the SAME deployFiredAt disable (risk 5). No such step on the board ⇒ primary null.
  "release-aging": (item, ctx) => {
    const step = promoteAndDeployStep(ctx.config);
    const primary: QuickAction | null = step
      ? {
          id: "move-card:publish",
          label: "Publicar",
          tone: "danger",
          description: "Coloca o código aprovado no ar (produção). Este trabalho está pronto e parado há dias esperando esta publicação.",
          confirm: { title: "Publicar?", body: `Promove o código para produção via "${step.name}" (promote-and-deploy).` },
          ...(ctx.card?.deployFiredAt ? { disabled: "deploy em voo (deployFiredAt) — aguarde o settle" } : {}),
          auditCls: "deploy",
          invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: step.id },
        }
      : null;
    return {
      primary,
      secondary: [],
      escalate: buildEscalateAction({ templateId: "release-aging", kind: "card", boardId: item.boardId, cardId: item.cardId }),
    };
  },

  // WS-5 (D9) — "Reenfileirar" re-integrates the SAME branch (enqueueMerge terminal-retry); "Descartar branch"
  // only when the branch matches the discard guard's regex; escalate carries entryStatus "failed".
  "merge-failed": (item) => {
    const branchDiscardable = /^(failed\/)?run\/[A-Za-z0-9-]+$/.test(item.branch);
    return {
      primary: {
        id: "requeue-merge",
        label: "Reenfileirar",
        tone: "neutral",
        description: "Tenta integrar este trabalho de novo — a branch volta para a fila e os testes de integração rodam outra vez.",
        confirm: { title: "Reenfileirar?", body: `Re-integra a branch \`${item.branch}\` do run ${item.runId} no train — o gate roda de novo.` },
        hint: "a branch existente volta à fila; se ela sumiu, use ▶ Rodar",
        auditCls: "merge-resolve",
        invoke: { kind: "requeue-merge", runId: item.runId },
      },
      secondary: branchDiscardable
        ? [
            {
              id: "discard-branch",
              label: "Descartar branch",
              tone: "danger",
              description: "Apaga este trabalho de vez — o que não foi integrado é perdido para sempre.",
              confirm: { title: "Descartar branch?", body: `Apaga a branch \`${item.branch}\` do run ${item.runId} — o trabalho não integrado é perdido.` },
              auditCls: "destructive",
              invoke: { kind: "discard-branch", branch: item.branch },
            },
          ]
        : [],
      escalate: buildEscalateAction({
        templateId: "merge-failed-terminal",
        kind: "merge",
        boardId: item.boardId,
        cardId: item.cardId,
        runId: item.runId,
        entryStatus: "failed",
      }),
    };
  },
};

/** Facade for the surfaces: narrow the item to its entry + apply defaults. The cast is the known TS
 *  limitation (indexing a keyed union of functions erases the correlation) — the registry itself stays
 *  exhaustively/narrowly typed above, so no per-entry type is weakened. */
export function quickActionsFor(item: CockpitItem, config: BoardConfig, card?: Card): QuickActionSet {
  const entry = QUICK_ACTIONS_OF[item.kind] as (i: CockpitItem, ctx: QuickActionCtx) => QuickActionSet;
  return entry(item, { config, card });
}

/** WS-5 — the /processes MergeQueueRow (a cross-board page with NO BoardConfig at hand) needs the merge-failed
 *  actions WITHOUT a config. The merge-failed registry entry ignores `ctx`, so this config-free call is safe. */
export function mergeFailedActionsFor(item: MergeFailedCockpitItem): QuickActionSet {
  return QUICK_ACTIONS_OF["merge-failed"](item, { config: undefined as unknown as BoardConfig });
}

// ── cardNextAction — the kanban footer slot (WS-2) ─────────────────────────────────────────────────

const kanbanSet = (primary: QuickAction | null, escalate: QuickAction | null): QuickActionSet => ({
  primary,
  secondary: [], // auxiliaries belong to Inbox (WS-3); the closed card renders none
  escalate,
});

/**
 * The PRÓXIMA-AÇÃO of a closed kanban card (WS-2): `primary` (0..1, compact) + `escalate` (ONLY in the SAD
 * states; null on the happy/neutral ones). PURE. `secondary` is always empty here.
 *
 * The caller (WS-2) composes the demand as:
 *   dominantDemand([...cardDemands(card, config, boardId), ...(entry ? [mergeEntryDemand(entry, card)].filter(Boolean) : [])])
 * with `entry` = the parked merge-queue entry of the card (useMergeQueue()). The boardId is `config.id`.
 */
export function cardNextAction(
  card: Card,
  config: BoardConfig,
  substate: RunSubstate | null,
  demand: Demand | null,
): QuickActionSet | null {
  const boardId = config.id;
  const dtype = demand?.type;

  // 1 — merge conflict (needs the runId the mergeEntryDemand carries).
  if (dtype === "merge-conflict" && demand?.runId) {
    const runId = demand.runId;
    return kanbanSet(
      {
        id: "resolve-merge:merged",
        label: "Marcar integrado",
        tone: "neutral",
        confirm: { title: "Marcar integrado?", body: "Pressupõe que você já fez o merge manual — nada é verificado." },
        auditCls: "merge-resolve",
        invoke: { kind: "resolve-merge", runId, action: "merged" },
      },
      buildEscalateAction({ templateId: "merge-conflict", kind: "merge", boardId, cardId: card.id, runId, entryStatus: "conflict" }),
    );
  }
  // 2 — merge gate-failed.
  if (dtype === "merge-gate-failed" && demand?.runId) {
    const runId = demand.runId;
    return kanbanSet(
      { id: "resolve-gate:retry", label: "Tentar gate novamente", tone: "neutral", auditCls: "merge-resolve", invoke: { kind: "resolve-gate", runId, action: "retry" } },
      buildEscalateAction({ templateId: "merge-gate-failed", kind: "merge", boardId, cardId: card.id, runId, entryStatus: "gate-failed" }),
    );
  }
  // 3 — deploy failed (the same Re-publish as the registry, incl. the deployFiredAt disable).
  if (dtype === "deploy-failed") {
    return kanbanSet(
      rePublishAction(config, boardId, card.id, card.deployFiredAt),
      buildEscalateAction({ templateId: "deploy-failed", kind: "deploy", boardId, cardId: card.id }),
    );
  }
  // 4 — blocker: resolve the oldest open blocker; escalate with the prefix-derived template.
  if (dtype === "blocker") {
    const blocker = (card.findings ?? []).filter((f) => f.status === "open" && f.severity === "blocker")[0];
    const primary: QuickAction | null = blocker
      ? {
          id: "update-finding:fixed",
          label: "Marcar resolvido",
          tone: "neutral",
          confirm: { title: "Marcar resolvido?", body: `Finding ${blocker.id}${blocker.title ? ` — ${blocker.title}` : ""}. O gate libera o card quando o último blocker fecha.` },
          auditCls: "write-board",
          invoke: { kind: "update-finding", boardId, cardId: card.id, findingId: blocker.id, status: "fixed" },
        }
      : null;
    const escalate = blocker
      ? buildEscalateAction({ templateId: blockerTemplateId(blocker.id, blocker.lens, card.status), kind: "finding", boardId, cardId: card.id, findingId: blocker.id })
      : buildEscalateAction({ templateId: "blocker-generic", kind: "card", boardId, cardId: card.id });
    return kanbanSet(primary, escalate);
  }
  // 5 — question | review → open Inbox (answering is a form; escalate: null on this neutral path).
  if (dtype === "question" || dtype === "review") {
    return kanbanSet(
      { id: "link:inbox", label: "Abrir no Inbox", tone: "neutral", auditCls: "read", invoke: { kind: "link", href: `/board/${boardId}/inbox?focus=${card.id}` } },
      null,
    );
  }
  // 6 — release-aging → Publish (danger); escalate: null (a hygiene/happy path, not a sad state).
  if (dtype === "release-aging") {
    const step = config.statuses.find((s) => s.onEnter === "promote-and-deploy" || s.onEnter === "promote-stage");
    if (!step) return null;
    return kanbanSet(
      {
        id: "move-card:publish",
        label: "Publicar",
        tone: "danger",
        confirm: { title: "Publicar?", body: `Promove o código para produção via "${step.name}".` },
        auditCls: step.onEnter === "promote-and-deploy" ? "deploy" : "merge-resolve",
        invoke: { kind: "move-card", boardId, cardId: card.id, status: step.id },
      },
      null,
    );
  }
  // 7 — deploy-unsettled → escalate only (D6 rejected a checkDeploySettleAction; no happy 1-click until WS-5).
  if (dtype === "deploy-unsettled") {
    return kanbanSet(null, buildEscalateAction({ templateId: "deploy-unsettled", kind: "deploy", boardId, cardId: card.id }));
  }
  // 8 — gate, OR (no demand) a manual step with a recommended move → "Avançar → <step>"; escalate: null.
  if (dtype === "gate" || !demand) {
    const def = config.statuses.find((s) => s.id === card.status);
    if (def && def.autorun !== true && !def.terminal) {
      const rec = moveTargets(card, config).find((t) => t.recommended);
      if (rec) {
        const hasEffect = Boolean(rec.status.onEnter);
        return kanbanSet(
          {
            id: "move-card:advance",
            label: `Avançar → ${rec.status.name}`,
            tone: hasEffect ? "danger" : "neutral",
            confirm: {
              title: "Avançar?",
              body: hasEffect ? `Move para "${rec.status.name}" e dispara ${rec.status.onEnter}.` : `Move o card para "${rec.status.name}".`,
            },
            auditCls: hasEffect ? "deploy" : "write-board",
            invoke: { kind: "move-card", boardId, cardId: card.id, status: rec.status.id },
          },
          null,
        );
      }
    }
  }
  // 9 — a dead run substate with no demand → retry (D15 label); escalate the run-death.
  if (!demand && (substate?.kind === "error" || substate?.kind === "failed")) {
    const fc = (card.findings ?? []).find((f) => f.id === RUN_DEATH_FINDING_ID && f.status === "open")?.failureClass;
    const rl = runRetryLabel(fc);
    return kanbanSet(
      { id: "run-skill:retry", label: rl.label, tone: "primary", ...(rl.hint ? { hint: rl.hint } : {}), auditCls: "run", invoke: { kind: "run-skill", boardId, cardId: card.id } },
      buildEscalateAction({ templateId: "run-death", kind: "run", boardId, cardId: card.id }),
    );
  }
  // 10 — nothing to surface (no footer noise).
  return null;
}
