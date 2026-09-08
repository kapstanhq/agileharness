"use client";

// Bloco de PRIORIDADE — reusado na ideia (bancada) e na story (drawer). Mostra o TIER + o porquê +
// o risco a testar, e oferece: avaliar/reavaliar com o agente e um override humano do tier
// (source:"human" vence o agente e é imune ao lote).
//
// STORY e IDEIA usam réguas diferentes, de propósito:
//  • story → WSJF (`scoreStoriesAction`): valor + urgência + destravamento ÷ tamanho, pontuado contra
//    as âncoras já calibradas do board. É o MESMO caminho do botão da tela de Priorização — se este
//    bloco escrevesse por outra via, o card sairia daqui sem ordinais e sumiria do ranking de lá.
//  • ideia → tier argumentado: uma ideia é uma DOR, não um job. WSJF sem job size não significa nada.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListOrdered, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { tierFromRank } from "@/lib/storymap/priority";
import { wsjfRatio } from "@/lib/storymap/wsjf";
import {
  assessPriorityAction,
  reorderPrioritiesAction,
  scoreStoriesAction,
  setPriorityAction,
} from "@/app/priority-actions";
import type { Card } from "@/lib/storymap/types";

const TIER_OPTIONS: { rank: 0 | 1 | 2 | 3; label: string }[] = [
  { rank: 0, label: "Baixa" },
  { rank: 1, label: "Média" },
  { rank: 2, label: "Alta" },
  { rank: 3, label: "Crítica" },
];

const WEIGHT: Record<0 | 1 | 2 | 3, string> = {
  3: "font-semibold text-fg",
  2: "font-medium text-fg",
  1: "text-fg-muted",
  0: "text-fg-subtle",
};

export function PriorityBlock({
  boardId,
  card,
  kind,
}: {
  boardId: string;
  card: Card;
  kind: "idea" | "story";
}) {
  const router = useRouter();
  const pc = (kind === "idea" ? card.idea?.priorityCall : card.priorityCall) ?? null;
  const tier = pc ? tierFromRank(pc.rank) : null;
  const [busy, setBusy] = useState<null | "assess" | "reorder" | "tier">(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "assess" | "reorder" | "tier", fn: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (res.ok) router.refresh();
    else setError(res.error ?? "Falhou.");
  };

  // Story vai pelo MESMO caminho do botão da tela de Priorização (WSJF ancorado); ideia mantém o
  // tier argumentado.
  const assess = () =>
    run("assess", () =>
      kind === "story"
        ? scoreStoriesAction({ boardId, cardIds: [card.id] })
        : assessPriorityAction({ boardId, cardId: card.id }),
    );
  // Em STORY o lote não re-ranqueia o que já foi decidido: ele SEMEIA quem ainda não tem nota. Como
  // a régua é absoluta e ancorada, um card novo acha seu lugar sem mexer no score de ninguém.
  const reorder = () =>
    run("reorder", () =>
      kind === "story" ? scoreStoriesAction({ boardId }) : reorderPrioritiesAction({ boardId, kind }),
    );
  const overrideTier = (rank: 0 | 1 | 2 | 3) => run("tier", () => setPriorityAction({ boardId, cardId: card.id, rank }));

  const batchLabel = kind === "idea" ? "Reordenar todas" : "Priorizar pendentes";
  const batchTitle =
    kind === "idea"
      ? "O agente ranqueia todas as ideias de uma vez"
      : "O agente pontua as stories que ainda não têm nota — as já decididas ficam como estão";
  const score = kind === "story" ? wsjfRatio(pc?.wsjf) : null;

  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Prioridade</span>
        {pc && (
          <span className="text-[10px] text-fg-subtle">
            {pc.source === "human" ? "definida por você" : "avaliada pelo agente"} · {pc.assessedAt.slice(0, 10)}
          </span>
        )}
      </div>

      {tier ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={cn("text-[13px]", WEIGHT[tier.rank])}>{tier.label}</span>
            {score != null && (
              <span className="text-[11px] tabular-nums text-fg-subtle">WSJF {score.toFixed(1)}</span>
            )}
          </div>
          {/* Os ordinais que produziram a nota — a conta fica auditável no lugar onde alguém a
              contestaria, em vez de só o resultado. */}
          {pc?.wsjf && (
            <p className="text-[11px] tabular-nums text-fg-subtle">
              valor {pc.wsjf.value} · urgência {pc.wsjf.urgency} · destrava {pc.wsjf.unlock} ÷ tamanho{" "}
              {pc.wsjf.size}
            </p>
          )}
          {pc?.rationale && (
            <p className="text-[12px] leading-relaxed text-fg">
              <span className="text-fg-subtle">Por quê: </span>
              {pc.rationale}
            </p>
          )}
          {pc?.riskiestAssumption && (
            <p className="text-[12px] leading-relaxed text-fg-muted">
              <span className="text-fg-subtle">Risco a testar 1º: </span>
              {pc.riskiestAssumption}
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12px] leading-snug text-fg-subtle">
          Sem prioridade ainda. O agente raciocina sobre a estratégia + os outros itens e propõe um tier
          defendido — sem inventar número de alcance.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={assess}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
        >
          {busy === "assess" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {tier ? "Reavaliar" : "Avaliar com o agente"}
        </button>
        <button
          type="button"
          onClick={reorder}
          disabled={busy !== null}
          title={batchTitle}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-50"
        >
          {busy === "reorder" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListOrdered className="h-3 w-3" />}
          {batchLabel}
        </button>
        {tier && (
          <label className="ml-auto flex items-center gap-1.5 text-[10px] text-fg-subtle">
            Ajustar
            <select
              value={tier.rank}
              disabled={busy !== null}
              onChange={(e) => overrideTier(Number(e.target.value) as 0 | 1 | 2 | 3)}
              className="h-7 rounded-md border border-line bg-inset px-2 text-[12px] text-fg outline-none transition focus:border-accent disabled:opacity-50"
            >
              {TIER_OPTIONS.map((o) => (
                <option key={o.rank} value={o.rank}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="flex-1 leading-snug">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>
        </div>
      )}
    </div>
  );
}
