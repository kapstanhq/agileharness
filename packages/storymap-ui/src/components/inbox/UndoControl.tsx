"use client";

// O «DESFAZER» de um desfecho do Inbox (onda 2, passo 5) — o do recibo do dono (no lugar do item, logo depois do
// clique, e em «Resolvido hoje») ou o de uma decisão do sistema. Um componente só para os dois lugares.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { undoInboxReceiptAction, undoSystemDecisionAction } from "@/app/actions";
import type { ResolvedEntry } from "@/lib/storymap/inbox/receipts";

/**
 * O «Desfazer» de um desfecho — o do recibo do dono ou o de uma decisão do sistema. O que pede motivo (reabrir uma
 * entrega) abre a caixa de texto antes. O servidor confere a pré-condição no card fresco e recusa com o porquê.
 */
export function UndoControl({
  boardId,
  undo,
  onUndone,
}: {
  boardId: string;
  undo: NonNullable<ResolvedEntry["undo"]>;
  onUndone?: (text: string) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const go = async () => {
    if (undo.requiresNote && !armed) {
      setArmed(true);
      return;
    }
    setPending(true);
    setError(null);
    const res =
      undo.source === "receipt"
        ? await undoInboxReceiptAction({ boardId, receiptId: undo.id })
        : await undoSystemDecisionAction({ boardId, decisionId: undo.id, note: note.trim() || null });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const text = undo.source === "receipt" ? ((res.data as { text?: string } | undefined)?.text ?? "Desfeito.") : "A decisão do sistema foi desfeita.";
    setDone(text);
    onUndone?.(text);
    router.refresh();
  };

  if (done) {
    return (
      <p role="status" className="text-[13px] font-medium text-fg">
        <b className="font-semibold">Desfeito</b> — {done}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {armed && (
        <textarea
          autoFocus
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Diga o motivo — é o que o agente vai ler."
          className="w-full resize-y rounded-lg border border-line bg-inset px-3 py-2 text-[14px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
      )}
      <button
        type="button"
        onClick={() => void go()}
        disabled={pending || (armed && !note.trim())}
        className="inline-flex min-h-11 items-center rounded-[10px] border border-line bg-surface px-3.5 text-[13.5px] font-semibold text-fg transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45"
      >
        {pending ? "Um instante…" : armed ? "Enviar e desfazer" : undo.label}
      </button>
      {error && (
        <p role="alert" className="text-[12.5px] font-medium text-danger">
          Não deu para desfazer: {error}
        </p>
      )}
    </div>
  );
}
