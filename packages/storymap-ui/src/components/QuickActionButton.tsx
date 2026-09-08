"use client";

// WS-0 (copilot-actionability, §0.3) — THE single dispatcher for every quick-action. WS-2/3/4 render
// `<QuickActionButton action={qa} boardId={…} cardId={…} surface="kanban|inbox|processes|perguntas" />`
// and NEVER call a quick-action server action directly. It is a thin client shell over the pure decision
// (quick-actions.ts): an exhaustive switch over `invoke.kind` → the mapped server action, a ConfirmDialog
// when the action asks for it, Result→toast (no optimism), stopPropagation (invariant 8) and the D7 audit.
//
// WS-0 is INERT: nothing mounts this yet — the escalate `?copilot=` param is written but nothing reads it
// until WS-1 (BoardHeader). This file ships compiling and unused.

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  acceptTriageCardAction,
  deleteCardAction,
  discardPreservedBranchAction,
  forceReleaseRunAction,
  moveCardAction,
  requeueMergeEntryAction,
  resolveGateFailedAction,
  resolveMergeConflictAction,
  runCardSkillAction,
  updateFindingStatusAction,
} from "@/app/actions";
import { logHumanActionAction } from "@/app/audit-actions";
import { encodeEscalationRef } from "@/lib/storymap/copilot/escalation";
import { SENSITIVE_AUDIT_CLASSES, type QuickAction, type QuickActionInvoke } from "@/lib/storymap/quick-actions";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";

type ActionResult = { ok: true; data?: unknown } | { ok: false; error: string };

/** invoke.kind → the human-readable server-action name recorded in the D7 trail. */
const TOOL_OF: Record<QuickActionInvoke["kind"], string> = {
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
};

const TONE_CLS: Record<QuickAction["tone"], string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  neutral: "border border-line text-fg-muted hover:bg-surface-hover",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

/**
 * A MESMA ação, em peso de alternativa. Preenchimento = importância; cor = risco. Um `danger` cheio ao
 * lado do primário empatava a fileira em dois botões sólidos ("Aceitar" verde × "Descartar" vermelho) e
 * o olho perdia qual é a ação do item; contornado, ele continua gritando RISCO sem disputar a atenção.
 * Só quem sabe a posição escolhe — o botão não adivinha (a fileira passa `subdued` nas alternativas).
 */
const SUBDUED_TONE_CLS: Record<QuickAction["tone"], string> = {
  primary: "border border-primary/45 text-primary hover:bg-primary/10",
  neutral: "border border-line text-fg-muted hover:bg-surface-hover",
  danger: "border border-red-500/45 text-red-600 hover:bg-red-500/10 dark:text-red-400",
};

export function QuickActionButton({
  action,
  boardId,
  cardId,
  surface,
  size = "sm",
  className,
  withDestination = false,
  subdued = false,
}: {
  action: QuickAction;
  boardId: string;
  cardId?: string;
  surface: string;
  size?: "sm" | "md";
  className?: string;
  /**
   * Imprime o DESTINO no rótulo ("Aprovar → Plano & Tarefas"), quando a ação tem um. Opt-in por SUPERFÍCIE
   * porque o botão nunca quebra linha (`whitespace-nowrap`): onde sobra largura (o Inbox) o destino no
   * botão é o que torna a decisão auto-explicativa; no rodapé estreito do card do kanban ele estouraria a
   * coluna — e lá a coluna já diz onde o card está.
   */
  withDestination?: boolean;
  /** peso de ALTERNATIVA: contorno em vez de preenchimento (ver SUBDUED_TONE_CLS). */
  subdued?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // invariant 8 — never start a dnd drag nor open the card.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  async function perform() {
    const invoke = action.invoke;
    let res: ActionResult = { ok: true };
    switch (invoke.kind) {
      case "link":
        router.push(invoke.href);
        return; // navigation: no toast, no audit
      case "escalate": {
        // D4 — seed the composer via ?copilot=<ref>. Same board (already on /board/<id>/…) ⇒ replace in
        // place; cross-page ⇒ push the kanban (the BoardHeader — which reads the param in WS-1 — mounts on
        // every board view). The param is INERT until WS-1 lands; this ships without effect.
        const ref = encodeEscalationRef(invoke.ref);
        const prefix = `/board/${invoke.ref.boardId}/`;
        if (pathname && pathname.startsWith(prefix)) router.replace(`${pathname}?copilot=${ref}`);
        else router.push(`/board/${invoke.ref.boardId}/kanban?copilot=${ref}`);
        return; // navigation: no toast, no audit (auditCls: read)
      }
      case "move-card":
        setPending(true);
        res = await moveCardAction({ boardId: invoke.boardId, cardId: invoke.cardId, status: invoke.status });
        break;
      case "run-skill":
        setPending(true);
        res = await runCardSkillAction({ boardId: invoke.boardId, cardId: invoke.cardId });
        break;
      case "force-release":
        setPending(true);
        res = await forceReleaseRunAction({ boardId: invoke.boardId, cardId: invoke.cardId });
        break;
      case "resolve-merge":
        setPending(true);
        res = await resolveMergeConflictAction({ runId: invoke.runId, action: invoke.action });
        break;
      case "resolve-gate":
        setPending(true);
        res = await resolveGateFailedAction({ runId: invoke.runId, action: invoke.action });
        break;
      case "update-finding":
        setPending(true);
        res = await updateFindingStatusAction({ boardId: invoke.boardId, cardId: invoke.cardId, findingId: invoke.findingId, status: invoke.status });
        break;
      case "discard-branch":
        setPending(true);
        res = await discardPreservedBranchAction({ branch: invoke.branch });
        break;
      case "requeue-merge":
        setPending(true);
        res = await requeueMergeEntryAction({ runId: invoke.runId });
        break;
      case "accept-triage":
        setPending(true);
        res = await acceptTriageCardAction({ boardId: invoke.boardId, cardId: invoke.cardId });
        break;
      case "delete-card":
        setPending(true);
        res = await deleteCardAction({ boardId: invoke.boardId, cardId: invoke.cardId, reason: "descartado na revisão do Inbox" });
        break;
      default: {
        const _never: never = invoke;
        void _never;
        return;
      }
    }
    setPending(false);
    // Result → toast, sem otimismo (invariant 9).
    if (!res.ok) {
      toast(res.error);
      return;
    }
    toast(`${action.label}: ok`, "success");
    // D7 — audit the human click on a sensitive class (fire-and-forget; never awaited, never conditions the toast).
    if (SENSITIVE_AUDIT_CLASSES.has(action.auditCls)) {
      void logHumanActionAction({ surface, tool: TOOL_OF[invoke.kind], cls: action.auditCls, boardId, cardId, note: action.id });
    }
    router.refresh();
  }

  function onClick(e: React.MouseEvent) {
    stop(e);
    if (action.disabled || pending) return;
    if (action.confirm) {
      setConfirming(true);
      return;
    }
    void perform();
  }

  // Alturas FIXAS casadas com os icon-buttons do card (h-7 no kanban): o CTA de texto e os ícones saem
  // da MESMA régua vertical, então a linha de ações alinha por construção. `shrink-0 whitespace-nowrap`:
  // num flex apertado o flexbox espremia o botão e o rótulo quebrava em duas linhas ("Abrir na
  // Inbox" virava sanduíche) — botão de ação nunca quebra texto; quando falta espaço, a LINHA
  // envolve o botão inteiro (flex-wrap no cluster pai), jamais o texto no meio.
  const sizeCls = size === "md" ? "h-8 px-3 text-[13px]" : "h-7 px-2 text-[12px]";
  const inert = pending || Boolean(action.disabled);

  return (
    <>
      <button
        type="button"
        onPointerDown={stop}
        onClick={onClick}
        disabled={inert}
        // Consequência do clique ANTES de decidir: o motivo do disabled tem prioridade, senão a descrição de
        // produto (o que muda no board), senão o hint técnico curto.
        title={action.disabled ?? action.description ?? action.hint}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed",
          sizeCls,
          (subdued ? SUBDUED_TONE_CLS : TONE_CLS)[action.tone],
          inert && "opacity-50",
          className,
        )}
      >
        {action.label}
        {withDestination && action.destination && (
          <>
            <span aria-hidden className="opacity-50">→</span>
            <span className="font-semibold">{action.destination}</span>
          </>
        )}
      </button>
      {action.hint && !action.disabled && <span className="ml-1.5 text-[11px] text-fg-subtle">{action.hint}</span>}
      {confirming && action.confirm && (
        <ConfirmDialog
          title={action.confirm.title}
          description={action.confirm.body}
          tone={action.tone === "danger" ? "danger" : "default"}
          confirmDisabled={pending}
          onConfirm={() => {
            void (async () => {
              await perform();
              setConfirming(false);
            })();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
