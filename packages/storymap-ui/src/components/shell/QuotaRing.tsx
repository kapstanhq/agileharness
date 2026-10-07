"use client";

// O ANEL DA COTA — o medidor de uso da assinatura na barra do topo (era o `HealthPill`).
//
// O anel + o % (no celular só o anel); no hover (ou toque) o painel «Cota da assinatura · 7 dias»: o VEREDITO
// pelo ritmo (usado × esperado hoje — `quota-pace.ts`), a barra com a marca do esperado, e a frase do que isso
// quer dizer para o board. O número é o UNIFICADO (`unifiedQuota`: a leitura mais recente entre o proxy de uso
// e o governador, por campo) — o único lugar do número, nunca dois.
//
// Desde a fase 2 o painel também diz o CUSTO dos agentes neste board (o que a página de Métricas mostrava): a soma
// dos runs, nocional numa assinatura — o limite real é a janela de uso acima —, e o card que mais gastou.
//
// Dois sinais separados, como antes: o TOM do anel sai só do USO (`meterTone` — terracota só quando freia,
// ≥85%) e a TRAVA do governador tem selo PRÓPRIO ao lado (`latchSealWords`), com a frase. Antes o chip dizia
// «4%» em vermelho com cadeado, e o 4% parecia cota crítica quando era a trava.

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { latchSealWords, quotaUsageWords } from "@/lib/storymap/board-pace-words";
import { quotaBucket, unifiedQuota, type QuotaReading } from "@/lib/vps/capacity-view";
import { useVpsMetrics } from "@/components/RunnerStatusProvider";
import { meterTone, useHoverPopover } from "@/components/nav/NavShell";
import { appBarIconButton, appBarPopover } from "@/components/shell/app-bar-shell";
import { quotaPace, ringDash } from "@/components/shell/quota-pace";
import type { VpsMetrics } from "@/lib/vps/types";
import { getBoardPaceAction } from "@/app/board-pace-actions";
import { getBoardMetricsAction } from "@/app/actions";

/** "há 2h" / "há 35min" — quando a fonte do número leu pela última vez (o aviso de defasado). */
function formatAge(polledAt: number | null): string {
  if (polledAt == null) return "nunca";
  const m = Math.max(0, Math.round((Date.now() - polledAt) / 60_000));
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

/**
 * O número do anel: a janela REAL da semana (unificada), senão a estimativa local do ccusage (marcada com «≈»).
 * `resetsInMinutes` só vem da janela de 7 dias — a do ccusage é um bloco de 5h e não serve de régua da semana.
 */
function headline(
  metrics: VpsMetrics,
  quota: QuotaReading | null,
  now: number,
): { pct: number | null; estimate: boolean; stale: boolean; resetsInMinutes: number | null } {
  if (quota?.weekPct != null) {
    const bucket = quotaBucket(metrics.usage?.week, quota.week, now);
    return { pct: quota.weekPct, estimate: false, stale: quota.stale, resetsInMinutes: bucket?.resetsInMinutes ?? null };
  }
  const cc = metrics.tokens?.usedPct;
  if (cc != null) return { pct: cc, estimate: true, stale: false, resetsInMinutes: null };
  return { pct: null, estimate: false, stale: false, resetsInMinutes: null };
}

/**
 * O escopo do board da tela («Só consertos»?), lido quando o painel ABRE — a ajuda só sugere «voltar o escopo para
 * Tudo» a quem está nele. Sem board (telas de app) ou sem leitura: nada.
 */
function useScopeFixes(boardId: string | undefined, open: boolean): boolean {
  const [fixes, setFixes] = useState(false);
  useEffect(() => {
    if (!open || !boardId) return;
    let alive = true;
    void getBoardPaceAction(boardId)
      .then((r) => alive && r.ok && setFixes(r.data.scope?.preset === "fixes"))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [boardId, open]);
  return fixes;
}

/** O custo dos agentes neste board, lido quando o painel ABRE (a varredura do ledger não roda a cada quadro do SSE). */
function useBoardCost(boardId: string | undefined, open: boolean): { total: number; runs: number; top: { cardId: string; cost: number } | null } | null {
  const [cost, setCost] = useState<{ total: number; runs: number; top: { cardId: string; cost: number } | null } | null>(null);
  useEffect(() => {
    if (!open || !boardId) return;
    let alive = true;
    void getBoardMetricsAction({ boardId })
      .then((r) => {
        if (!alive || !r.ok || !r.data) return;
        const summary = r.data.summary;
        const cards = summary.cards;
        const top = cards.reduce<(typeof cards)[number] | null>((a, c) => (!a || c.totalCostUSD > a.totalCostUSD ? c : a), null);
        setCost({
          total: summary.totalCostUSD,
          runs: cards.reduce((n, c) => n + c.totalRuns, 0),
          top: top && top.totalCostUSD > 0 ? { cardId: top.cardId, cost: top.totalCostUSD } : null,
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [boardId, open]);
  return cost;
}

/** "$1.23" — o custo nocional, com duas casas (abaixo de um centavo, "< $0.01"). */
export function formatCostUSD(v: number): string {
  if (v > 0 && v < 0.01) return "< $0.01";
  return `$${v.toFixed(2)}`;
}

export function QuotaRing({
  board,
}: {
  /** o board da tela (as vagas de condutor dele — null = não usa condutor): a ajuda só sugere as alavancas que ele tem. */
  board?: { id: string; conductorSlots: number | null };
} = {}) {
  const metrics = useVpsMetrics();
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();
  const scopeFixes = useScopeFixes(board?.id, open);
  const cost = useBoardCost(board?.id, open);
  // Hover só para MOUSE: no toque o mouseenter emulado abriria e o clique logo em seguida fecharia o painel.
  const onEnter = (e: ReactPointerEvent) => e.pointerType === "mouse" && openNow();
  const onLeave = (e: ReactPointerEvent) => e.pointerType === "mouse" && closeSoon();

  // Antes do 1º quadro do SSE: um lugar guardado, para a barra não pular.
  if (!metrics) {
    return <span className="h-8 w-8 shrink-0 rounded-lg motion-safe:animate-pulse bg-inset md:w-12" aria-hidden />;
  }

  const now = Date.now();
  const quota = unifiedQuota(metrics.usage, metrics.governor);
  const { pct, estimate, stale, resetsInMinutes } = headline(metrics, quota, now);
  const seal = latchSealWords(metrics.governor, quota?.weekPct ?? null);
  const words = quotaUsageWords({ pct, estimate, stale, ageWords: formatAge(quota?.week?.polledAt ?? metrics.usage?.polledAt ?? null) });
  const pace = pct != null ? quotaPace(pct, estimate ? null : resetsInMinutes, { conductorSlots: board?.conductorSlots ?? null, scopeFixes }) : null;
  const tone = meterTone(pct);

  return (
    <div ref={ref} className="relative flex shrink-0 items-center gap-1" onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={words.title}
        aria-label={words.ariaLabel}
        className={cn(appBarIconButton, "gap-[5px] tabular-nums", open && "bg-surface-hover", tone === "danger" && "text-danger")}
      >
        <span className="relative inline-flex">
          <svg width="15" height="15" viewBox="0 0 36 36" aria-hidden className="block shrink-0">
            <circle cx="18" cy="18" r="14" fill="none" stroke="rgb(var(--line-muted))" strokeWidth="5" />
            <circle
              cx="18"
              cy="18"
              r="14"
              fill="none"
              stroke={tone === "danger" ? "rgb(var(--danger))" : stale ? "rgb(var(--fg-subtle))" : "rgb(var(--fg-muted))"}
              strokeWidth="5"
              strokeDasharray={ringDash(pct)}
              transform="rotate(-90 18 18)"
            />
          </svg>
          {stale && <AlertTriangle className="absolute -right-1 -top-1 h-2.5 w-2.5 text-fg-subtle" aria-label="defasado" />}
        </span>
        {/* No celular só o anel (o número ocupa o lugar dos seletores); a partir de md, o %. Sem medida, só o anel
            vazio — um «—» solto ao lado do número do Inbox parecia defeito; a dica diz «sem dado da cota ainda». */}
        {pct != null && <span className="hidden md:inline">{`${Math.round(pct)}%${estimate ? "≈" : ""}`}</span>}
      </button>
      {seal && (
        // O selo da TRAVA: rótulo curto na barra; a frase inteira (e, se o uso já baixou, o porquê de ela seguir)
        // na dica e no painel.
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={seal.title}
          aria-label={seal.title}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-danger transition hover:bg-danger/10 md:h-6 md:bg-danger/10"
        >
          <Lock className="h-3 w-3" aria-hidden />
          <span className="hidden md:inline">{seal.label}</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Cota da assinatura"
          className={cn(
            appBarPopover,
            "fixed right-2 top-[56px] w-[min(320px,calc(100vw-1rem))] md:absolute md:right-0 md:top-[calc(100%+6px)] md:w-[320px]",
            "flex flex-col gap-2.5 p-3.5",
          )}
        >
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-[14px] font-semibold text-fg">Cota da assinatura · 7 dias</span>
            {pace?.day != null && <span className="shrink-0 text-[12px] text-fg-subtle">dia {pace.day} de 7</span>}
          </span>
          {pace == null ? (
            <span className="text-[13px] text-fg-muted">{metrics.tokenError ?? "Cota indisponível agora."}</span>
          ) : (
            <>
              {pace.verdictLabel && <span className="text-[14px] font-semibold text-fg">{pace.verdictLabel}</span>}
              <div className="relative h-2 rounded-md bg-surface-hover">
                <span
                  className={cn("absolute inset-y-0 left-0 rounded-md", tone === "danger" ? "bg-danger" : "bg-fg-muted")}
                  style={{ width: `${pace.usedPct}%` }}
                />
                {pace.expectedPct != null && (
                  <span
                    aria-hidden
                    className="absolute -bottom-1 -top-1 w-0.5 bg-fg"
                    style={{ left: `calc(${pace.expectedPct}% - 1px)` }}
                  />
                )}
              </div>
              <span className="flex justify-between gap-2 text-[12px] text-fg-subtle tabular-nums">
                <span>
                  usado {pace.usedPct}%{estimate ? " (estimativa local)" : ""}
                </span>
                {pace.expectedPct != null && <span>esperado hoje: {pace.expectedPct}%</span>}
              </span>
              <span className="text-[13px] leading-[1.45] text-fg-muted">{pace.help}</span>
            </>
          )}
          {/* a defasagem é a da FONTE que deu o número (o proxy ou a leitura do governador), nunca a da outra */}
          {quota?.week?.stale && (
            <span className="flex items-start gap-1.5 rounded-md bg-inset px-2 py-1.5 text-[12px] leading-snug text-fg-muted">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              Número defasado — a última leitura da janela é de {formatAge(quota.week.polledAt)}.
            </span>
          )}
          {seal && (
            <span className="flex items-start gap-1.5 rounded-md bg-danger/10 px-2 py-1.5 text-[12px] font-medium leading-snug text-danger">
              <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {seal.title}
            </span>
          )}
          {cost && (
            <span className="border-t border-line pt-2.5 text-[12px] leading-snug text-fg-muted">
              <span className="font-semibold text-fg">Custo dos agentes neste board: {formatCostUSD(cost.total)}</span>
              {` em ${cost.runs} ${cost.runs === 1 ? "execução" : "execuções"}`}
              {cost.top ? ` · o card que mais gastou: ${cost.top.cardId} (${formatCostUSD(cost.top.cost)})` : ""}
              {". Numa assinatura o valor é de referência — o limite real é a cota acima."}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
