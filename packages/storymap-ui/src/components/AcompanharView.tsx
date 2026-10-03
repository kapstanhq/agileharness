"use client";

// «Acompanhar» — o que o sistema decidiu em nome do dono (política só-negócio), numa lista simples: quando, quem, o quê,
// por quê, as alternativas que existiam e o «Desfazer» quando a decisão é reversível. Superfície provisória: o
// redesenho do Inbox (onda 2) a absorve. O botão só oferece o desfazer; a pré-condição é do servidor
// (undoSystemDecisionAction), que recusa com o motivo em português — a mesma régua de `undoRefusal`.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ListChecks } from "lucide-react";
import { PageHeader } from "@/components/nav/PageTabs";
import { BoardHeader } from "./BoardHeader";
import { ToastProvider, useToast } from "./Toast";
import { undoSystemDecisionAction } from "@/app/actions";
import { cardHref } from "@/lib/storymap/deep-links";
import { agentLabel, undoLabel, type FollowUpItem } from "@/lib/storymap/system-decisions";
import type { Board, BoardSummary } from "@/lib/storymap/types";

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function AcompanharView({ board, boards, items }: { board: Board; boards: BoardSummary[]; items: FollowUpItem[] }) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-canvas">
        <BoardHeader boards={boards} config={board.config} view="inbox" subnav={false} />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
          <PageHeader
            title="Acompanhar"
            icon={ListChecks}
            description="O que o sistema decidiu por você neste board, com o porquê. Se algo não serve, desfaça."
            actions={
              <a href="/semana" className="text-[13px] text-accent hover:underline">
                Resumo da semana
              </a>
            }
          />
          {items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line bg-surface px-4 py-10 text-center text-sm text-fg-subtle">
              Nenhuma decisão do sistema registrada ainda neste board.
            </p>
          ) : (
            <ul className="space-y-3">
              {items.map((item) => (
                <DecisionRow key={item.id} boardId={board.config.id} item={item} />
              ))}
            </ul>
          )}
        </main>
      </div>
    </ToastProvider>
  );
}

function DecisionRow({ boardId, item }: { boardId: string; item: FollowUpItem }) {
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    const r = await undoSystemDecisionAction({ boardId, decisionId: item.id, note: note.trim() || null });
    setBusy(false);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    toast("Desfeito.");
    router.refresh();
  };
  return (
    <li className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-fg-subtle">
        <span>
          {agentLabel(item.agent)} · {fmtWhen(item.at)}
        </span>
        {item.cardId && (
          <a href={cardHref(boardId, item.cardId)} className="text-accent hover:underline">
            Abrir card
          </a>
        )}
      </div>
      <p className="mt-1 text-[15px] text-fg">{item.what}</p>
      {item.why && <p className="mt-1 text-[13px] text-fg-muted">Por quê: {item.why}</p>}
      {item.alternatives?.length ? <p className="mt-1 text-[13px] text-fg-muted">Opções que havia: {item.alternatives.join(" · ")}</p> : null}
      {item.undoneAt ? (
        <p className="mt-2 text-[13px] text-fg-subtle">Você desfez em {fmtWhen(item.undoneAt)}.</p>
      ) : item.undoable && item.undo ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Motivo (opcional; obrigatório para reabrir uma entrega)"
            className="min-w-0 flex-1 rounded-lg border border-line bg-inset px-3 py-1.5 text-[13px] text-fg outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={undo}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-fg transition hover:bg-surface-hover disabled:opacity-50"
          >
            {undoLabel(item.undo)}
          </button>
        </div>
      ) : null}
    </li>
  );
}
