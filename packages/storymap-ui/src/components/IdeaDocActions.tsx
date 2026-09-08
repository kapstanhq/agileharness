"use client";

// 🟩 IdeaDocActions — as DECISÕES sobre uma ideia, ao lado do documento dela.
//
// O documento é a única superfície de ESCRITA (ADR-066: a aba "Campos" foi removida — cinco textareas
// espelhando o que o texto já diz eram o que fazia a Ideia parecer uma story de formulário). Mas decidir não
// é escrever: mudar o estado da exploração e gerar as tarefas que executam a ideia são gestos de UMA vez, com
// consequência fora do texto — e por isso continuam sendo botões, não parágrafos.
//
// Vive fora do editor de propósito: em modo de edição você está redigindo, e uma barra de decisões ali
// convidaria a decidir no meio de uma frase.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Lightbulb, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { generateTasksForIdeaAction, updateIdeaAction } from "@/app/idea-actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { confirmFor } from "@/lib/storymap/entity-actions";
import { IDEA_STATUSES, type IdeaStatus } from "@/lib/storymap/frameworks";
import type { Card } from "@/lib/storymap/types";

export function IdeaDocActions({ boardId, card }: { boardId: string; card: Card }) {
  // Uma FAIXA de ações, não um painel: a caixa (borda + fundo + etiqueta em caixa-alta) abria a
  // página com um bloco pesado ANTES do título, e o documento começava depois de um formulário.
  // Aqui é uma linha discreta, fechada por um filete — a mesma gramática das propriedades logo
  // abaixo do título.
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-4">
      <IdeaStatusControl boardId={boardId} card={card} />
      <GenerateTasksButton boardId={boardId} cardId={card.id} />
    </div>
  );
}

/**
 * O ESTADO da exploração. "Descartada" exige MOTIVO (a server action recusa sem ele): sem o porquê
 * registrado, a mesma ideia volta a ser proposta pelo próximo que tiver a mesma intuição — que é exatamente
 * o buraco que o estado terminal fecha. Por isso o motivo é pedido AQUI, antes de mandar, e não depois.
 */
function IdeaStatusControl({ boardId, card }: { boardId: string; card: Card }) {
  const router = useRouter();
  const status = card.idea?.status ?? "open";
  const [busy, setBusy] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState(false);
  const [reason, setReason] = useState(card.idea?.discardReason ?? "");
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: IdeaStatus, discardReason?: string) => {
    setBusy(true);
    setError(null);
    const res = await updateIdeaAction({
      boardId,
      cardId: card.id,
      status: next,
      ...(discardReason ? { discardReason } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setPendingDiscard(false);
    router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-fg-subtle">Exploração</span>
        <div className="flex flex-wrap gap-1">
          {IDEA_STATUSES.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              title={s.short}
              onClick={() => (s.id === "discarded" ? setPendingDiscard(true) : apply(s.id))}
              className={cn(
                "rounded-md px-2 py-0.5 text-[13px] transition disabled:opacity-50",
                status === s.id
                  ? "bg-surface-hover font-medium text-fg"
                  : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
      {pendingDiscard && (
        <div className="w-full max-w-lg space-y-2 pt-1">
          <textarea
            autoFocus
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Por que não vamos seguir com esta ideia?"
            className="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none transition focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => apply("discarded", reason.trim())}
              className="rounded-md bg-fg px-2.5 py-1 text-[12px] font-medium text-surface transition hover:bg-fg/85 disabled:opacity-40"
            >
              Descartar
            </button>
            <button
              type="button"
              onClick={() => setPendingDiscard(false)}
              className="text-[12px] text-fg-muted transition hover:text-fg"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/** Gerar as tarefas que EXECUTAM a ideia — o fim da exploração, e sempre gesto do humano (o Explorador tem
 *  a persona e o token cortados justamente para não fazer isto sozinho). A proposta cai no Inbox. */
function GenerateTasksButton({ boardId, cardId }: { boardId: string; cardId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // O clique PERGUNTA; só o "Gerar" do diálogo dispara. A cópia vem do catálogo — a mesma da bancada, para
  // as duas superfícies não descreverem a mesma ação de dois jeitos.
  const [confirming, setConfirming] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    const res = await generateTasksForIdeaAction({ boardId, cardId });
    setBusy(false);
    if (res.ok) {
      setMsg("Captura disparada — a proposta vai aparecer no Inbox para você revisar e aceitar. O que você aceitar já nasce ligado a esta ideia.");
      router.refresh();
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        // Contornado, não preenchido: gerar tarefas é uma ação IMPORTANTE, mas não é o trabalho da
        // página (que é ler e escrever a ideia). Preenchido de verde, ele disputava atenção com o
        // título logo abaixo.
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[13px] font-medium text-fg-muted transition hover:border-line-emphasis hover:bg-surface-hover hover:text-fg disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lightbulb className="h-3.5 w-3.5" />}
        {busy ? "Gerando captura…" : "Gerar tarefas desta ideia"}
      </button>
      {msg && <p className="text-[11px] leading-snug text-emerald-700 dark:text-emerald-400">{msg}</p>}
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="flex-1 leading-snug">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {confirming &&
        (() => {
          const c = confirmFor("generate-stories", 1)!;
          return (
            <ConfirmDialog
              title={c.title}
              description={c.description}
              confirmLabel={c.confirmLabel}
              tone={c.tone}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false);
                void run();
              }}
            />
          );
        })()}
    </div>
  );
}
