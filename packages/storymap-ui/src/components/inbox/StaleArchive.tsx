"use client";

// «ARQUIVAR OS ANTIGOS» (onda 2, passo 6) — a linha sob Decidir quando há itens parados há mais de 30 dias. Confirma
// antes, diz o que acontece (vão para o arquivo como adiados; nada é apagado) e, depois, o recibo com «Desfazer tudo».

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { archiveStaleItemsAction, undoInboxReceiptAction } from "@/app/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { staleArchiveCopy } from "@/lib/storymap/inbox/stale-archive";

type Done = { text: string; receipts: Array<{ boardId: string; receiptId: string }>; refused: number };

export function StaleArchive({ entries }: { entries: InboxEntry[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [undone, setUndone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const copy = staleArchiveCopy(entries.length);

  const archive = async () => {
    setConfirming(false);
    setPending(true);
    setError(null);
    const res = await archiveStaleItemsAction({ items: entries.map((e) => ({ boardId: e.boardId, cardId: e.cardId })) });
    setPending(false);
    if (!res.ok || !res.data) {
      setError(res.ok ? "sem resposta do servidor" : res.error);
      return;
    }
    const { archived, refused } = res.data;
    setDone({
      text: staleArchiveCopy(archived.length).done,
      receipts: archived.filter((a) => a.receiptId).map((a) => ({ boardId: a.boardId, receiptId: a.receiptId })),
      refused: refused.length,
    });
    router.refresh();
  };

  const undoAll = async () => {
    if (!done) return;
    setPending(true);
    setError(null);
    let back = 0;
    const errors: string[] = [];
    for (const r of done.receipts) {
      const res = await undoInboxReceiptAction({ boardId: r.boardId, receiptId: r.receiptId });
      if (res.ok) back++;
      else errors.push(res.error);
    }
    setPending(false);
    setUndone(`${back === 1 ? "1 item voltou" : `${back} itens voltaram`} para onde estava${back === 1 ? "" : "m"}.`);
    if (errors.length) setError(`${errors.length} não ${errors.length === 1 ? "voltou" : "voltaram"}: ${errors[0]}`);
    router.refresh();
  };

  if (done) {
    return (
      <div role="status" className="space-y-2 rounded-xl border border-line bg-inset/60 px-4 py-3">
        <p className="text-[14px] text-fg">
          <b className="font-semibold">{undone ? "Desfeito" : "Feito"}</b> — {undone ?? done.text}
          {!undone && done.refused > 0 && <span className="text-fg-muted"> {done.refused} já não estava{done.refused === 1 ? "" : "m"} parado{done.refused === 1 ? "" : "s"} e ficou de fora.</span>}
        </p>
        {!undone && done.receipts.length > 0 && (
          <button
            type="button"
            onClick={() => void undoAll()}
            disabled={pending}
            className="inline-flex min-h-11 items-center rounded-[10px] border border-line bg-surface px-3.5 text-[13.5px] font-semibold text-fg transition hover:bg-surface-hover disabled:opacity-45"
          >
            {pending ? "Um instante…" : "Desfazer tudo"}
          </button>
        )}
        {error && (
          <p role="alert" className="text-[12.5px] font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed border-line px-4 py-2" data-stale-archive>
      <span className="flex-1 text-[13.5px] text-fg-muted">{copy.line}</span>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-2 text-[13.5px] font-semibold text-accent-ink hover:underline disabled:opacity-45"
      >
        <Archive className="h-4 w-4" aria-hidden />
        {pending ? "Arquivando…" : copy.button}
      </button>
      {error && (
        <p role="alert" className="w-full text-[12.5px] font-medium text-danger">
          Não deu certo: {error}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={copy.title}
          description={copy.body}
          confirmLabel={copy.button}
          onConfirm={() => void archive()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
