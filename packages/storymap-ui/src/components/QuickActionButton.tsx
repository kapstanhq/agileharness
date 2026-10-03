"use client";

// WS-0 (§0.3) — THE single dispatcher for every quick-action. WS-2/3/4 render
// `<QuickActionButton action={qa} boardId={…} cardId={…} surface="kanban|inbox|processes|perguntas" />`
// and NEVER call a quick-action server action directly. It is a thin client shell over the pure decision
// (quick-actions.ts): the exhaustive `invoke.kind` → server action switch lives in quick-action-run.ts (shared with
// the Inbox card), plus a ConfirmDialog when the action asks for it, Result→toast (no optimism),
// stopPropagation (invariant 8) and the D7 audit.
//
// WS-0 is INERT: nothing mounts this yet — the escalate `?copilot=` param is written but nothing reads it
// until WS-1 (BoardHeader). This file ships compiling and unused.

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { quickActionFeedback, type QuickAction } from "@/lib/storymap/quick-actions";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import { auditHumanClick, escalateHref, runServerInvoke, type ActionResult } from "./quick-action-run";

// O risco é o TERRACOTA do tema (`--danger`, AA nos dois temas com a sua letra), nunca o `red-600` cru: o vermelho
// frio do Tailwind era a única cor do card fora do vocabulário de estados.
const TONE_CLS: Record<QuickAction["tone"], string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-hover",
  neutral: "border border-line text-fg-muted hover:bg-surface-hover",
  danger: "bg-danger text-danger-fg hover:bg-danger/90",
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
  danger: "border border-danger/45 text-danger hover:bg-danger/10",
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
    if (invoke.kind === "link") {
      router.push(invoke.href);
      return; // navigation: no toast, no audit
    }
    if (invoke.kind === "escalate") {
      // D4 — seed the composer via ?copilot=<ref> (quick-action-run `escalateHref`: in place on the same board, over
      // the CURRENT query; elsewhere the board's kanban, whose BoardHeader reads the param).
      const href = escalateHref(invoke.ref, pathname, window.location.search);
      if (pathname && pathname.startsWith(`/board/${invoke.ref.boardId}/`)) router.replace(href);
      else router.push(href);
      return; // navigation: no toast, no audit (auditCls: read)
    }
    setPending(true);
    // UM despachante (quick-action-run): o botão do Kanban e o cartão do Inbox executam o mesmo mapeamento.
    const res: ActionResult = await runServerInvoke(invoke);
    setPending(false);
    // Result → toast, sem otimismo (invariant 9). B2: a frase diz o que a ação FEZ — «iniciado» (a publicação, o
    // agente: roda depois e o card diz se falhar), «feito», ou o motivo da recusa — nunca «<rótulo>: ok».
    const feedback = quickActionFeedback(action, res);
    if (!res.ok) {
      toast(feedback.text);
      return;
    }
    toast(feedback.text, "success");
    // D7 — audit the human click on a sensitive class (fire-and-forget; never awaited, never conditions the toast).
    auditHumanClick({ surface, invoke, cls: action.auditCls, boardId, cardId, note: action.id });
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
