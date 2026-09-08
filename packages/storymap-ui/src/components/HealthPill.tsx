"use client";

// HealthPill — the navbar's single box-health + Claude-usage gauge. Folds what used to be
// FOUR separate top-bar widgets (headroom chip · ccusage "cota" · RAM · HD) into ONE compact
// pill + a popover with the full picture. Renders on desktop AND mobile (tap to open) — the
// old strip was `hidden md:`, so phones had no visibility into quota at all.
//
// Headline = the REAL weekly subscription usage (the 7d window the headroom proxy polls from
// Anthropic — the same number as Claude's `/usage`), falling back to the ccusage estimate (with
// a "≈" marker) only when the proxy is unavailable. The popover shows session/week/Sonnet
// windows, extra-usage credits, headroom compression effectiveness (honest — it says "0 reqs"
// when the proxy has compressed nothing, instead of a reassuring green), and RAM/HD.

import { AlertTriangle, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { useVpsMetrics } from "@/components/RunnerStatusProvider";
import {
  NavChip,
  NavPopover,
  NavPopoverBlock,
  NavPopoverDivider,
  NavPopoverEmpty,
  NavPopoverMeter,
  NavPopoverTitle,
  meterTone,
  useHoverPopover,
} from "@/components/nav/NavShell";
import type { UsageBucket, VpsMetrics } from "@/lib/vps/types";

function formatReset(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h${String(mm).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}
/** % with 1 decimal below 10 so a small-but-real savings (0.7%) reads as "0.7%", not rounded to 0/1. */
function formatPct(p: number): string {
  return p > 0 && p < 10 ? p.toFixed(1) : p.toFixed(0);
}
/** "há 2h" / "há 35min" — how long ago the proxy last polled (for the stale marker). */
function formatAge(polledAt: number | null): string {
  if (polledAt == null) return "nunca";
  const m = Math.max(0, Math.round((Date.now() - polledAt) / 60_000));
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}
// A régua de "quanto disso já foi" (limiares 60/85, tinta e preenchimento) mora agora em
// nav/NavShell — `meterInk`/`meterFill`/`NavPopoverMeter` —, para a cota do Claude e a RAM da máquina
// serem lidas com a MESMA escala em painéis vizinhos. Ver a nota lá.

/**
 * The headline % the pill shows: prefer the real weekly subscription window, else ccusage.
 * `stale` is true when the subscription number is the last-known value from a frozen proxy poll —
 * we still surface it (a slightly-old real figure beats the undercounting ccusage estimate) but
 * the UI marks it as defasado instead of color-coding it as authoritative.
 */
function headline(metrics: VpsMetrics): { pct: number | null; estimate: boolean; stale: boolean } {
  const week = metrics.usage?.week?.usedPct;
  if (week != null) return { pct: week, estimate: false, stale: !!metrics.usage?.stale };
  const cc = metrics.tokens?.usedPct;
  if (cc != null) return { pct: cc, estimate: true, stale: false };
  return { pct: null, estimate: false, stale: false };
}

/**
 * One labelled usage bar (session / week / sonnet). Renders nothing when the bucket is absent.
 * `muted` drops the authoritative color coding when the figure is stale (frozen proxy poll).
 *
 * O desenho da barra é o `NavPopoverMeter` da barra de topo — o mesmo que o painel dos Processos usa
 * para RAM/HD. O que sobra aqui é o que é PRÓPRIO da cota: o "quando zera" ao lado do percentual.
 */
function UsageRow({ label, bucket, muted }: { label: string; bucket: UsageBucket | null; muted?: boolean }) {
  if (!bucket) return null;
  return (
    <NavPopoverMeter
      label={label}
      pct={bucket.usedPct}
      muted={muted}
      value={`${Math.round(bucket.usedPct)}% · ${formatReset(bucket.resetsInMinutes)}`}
    />
  );
}

/** The small amber usage RING (design-faithful) — a 16px dial that fills clockwise with the % used. */
function UsageRing({ pct }: { pct: number }) {
  const c = 2 * Math.PI * 8; // r=8 → circumference ≈ 50.27
  const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" className="block shrink-0" aria-hidden>
      <circle cx="10" cy="10" r="8" fill="none" stroke="rgb(var(--line))" strokeWidth="2.6" />
      <circle
        cx="10"
        cy="10"
        r="8"
        fill="none"
        stroke="rgb(var(--accent))"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={off}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

export function HealthPill() {
  const metrics = useVpsMetrics();
  // Mesmo popover-por-hover dos outros medidores da barra (Inbox · runs) — ver nav/NavShell.
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();

  // A tiny placeholder keeps the bar from jumping before the first SSE frame lands.
  if (!metrics) {
    return <span className="h-8 w-12 shrink-0 animate-pulse rounded-md bg-surface-hover/60" aria-hidden />;
  }

  const { pct, estimate, stale } = headline(metrics);
  const { usage } = metrics;

  return (
    <div ref={ref} className="relative shrink-0" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      {/* O chip é ícone + número, como o Inbox e os runs — aqui o "ícone" é o anel de cota.
          O TOM sai de `meterTone` (nav/NavShell): a cota e a RAM são a mesma pergunta e agora se
          leem pela mesma régua também na barra — havia uma cópia local dos limiares aqui, e duas
          cópias é exatamente o que a seção "UMA régua" daquele arquivo existe para evitar. */}
      <NavChip
        onClick={() => setOpen((o) => !o)}
        open={open}
        tone={meterTone(pct)}
        leading={
          <span className="relative inline-flex">
            <UsageRing pct={pct ?? 0} />
            {stale && (
              <AlertTriangle className="absolute -right-1 -top-1 h-2.5 w-2.5 text-amber-500" aria-label="defasado" />
            )}
          </span>
        }
        value={pct != null ? `${Math.round(pct)}%${estimate ? "≈" : ""}` : "—"}
        title={
          stale
            ? `Uso Claude — número defasado (proxy atualizou ${formatAge(usage?.polledAt ?? null)})`
            : "Uso Claude — sessão · semana · Sonnet"
        }
        ariaLabel={`Uso Claude${pct != null ? ` — ${Math.round(pct)}% da semana` : ""}`}
      />

      {open && (
        // `pinned`: no celular o painel ancora no canto da tela, não no gatilho. Era por precisar
        // disso que este era o ÚNICO item da barra com um `<div>` próprio em vez do NavPopover —
        // outro padding, sem setinha e sem rodapé. A exceção virou opção da primitiva.
        <NavPopover label="Uso Claude" pinned>
          {/* As 3 janelas de sessão Claude (sessão 5h · semana 7d · Sonnet 7d) + o que o headroom
              poupou. RAM/HD vivem em Processos — a MÁQUINA é a outra pergunta. */}
          <NavPopoverTitle>Uso Claude</NavPopoverTitle>
          {usage ? (
            <NavPopoverBlock className="gap-2.5">
              {usage.stale && (
                <div className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                  <span>
                    Número defasado — o proxy de uso atualizou {formatAge(usage.polledAt)}. O poller travou; os
                    valores abaixo podem não bater com o <code>/usage</code> atual.
                  </span>
                </div>
              )}
              <UsageRow label="Sessão (5h)" bucket={usage.session} muted={usage.stale} />
              <UsageRow label="Semana (7d)" bucket={usage.week} muted={usage.stale} />
              <UsageRow label="Sonnet (7d)" bucket={usage.weekSonnet} muted={usage.stale} />
            </NavPopoverBlock>
          ) : metrics.tokens ? (
            <NavPopoverBlock>
              <NavPopoverMeter
                label="Semana (estimativa ccusage)"
                pct={metrics.tokens.usedPct}
                value={`${metrics.tokens.usedPct != null ? `${Math.round(metrics.tokens.usedPct)}%` : "sem limite"} · ${formatReset(metrics.tokens.resetsInMinutes)}`}
              />
              <p className="mt-1 text-[10px] leading-snug text-fg-subtle">
                Proxy de uso real indisponível — estimativa local.
              </p>
            </NavPopoverBlock>
          ) : (
            <NavPopoverEmpty>{metrics.tokenError ?? "cota indisponível"}</NavPopoverEmpty>
          )}
          {/* Sem rodapé de propósito: este painel RESPONDE (quanto da cota já foi), não encaminha. A
              porta para Processos vive no medidor ao lado — repeti-la aqui só punha uma saída para
              OUTRO assunto no fim de uma leitura que já estava completa. */}
          <HeadroomLine />
        </NavPopover>
      )}
    </div>
  );
}

/**
 * Quanto o proxy de compressão POUPOU — a linha que fecha a conta da cota ("gastei 67% da semana, e
 * teria gastado mais sem isto").
 *
 * Ela existia em dois lugares errados ao mesmo tempo: um `HeadroomChip` exportado, escrito por
 * inteiro e montado em LUGAR NENHUM (código morto), e um raio com um percentual espremido no painel
 * dos PROCESSOS, entre RAM e HD — onde ele lia como se fosse uma medida da máquina. Economia de token
 * é assunto da cota; aqui ela é uma frase, não um enigma de ícone.
 *
 * Some inteira quando o proxy está desligado/inalcançável. HONESTA por desenho: com o proxy no ar e
 * nada comprimido, ela DIZ isso — um verde tranquilizador seria mentira.
 */
function HeadroomLine() {
  const metrics = useVpsMetrics();
  const h = metrics?.headroom ?? null;
  if (!h) return null;
  const working = h.requestsCompressed > 0;
  return (
    <>
      <NavPopoverDivider />
      <p
        className="flex items-start gap-1.5 px-1.5 text-[10px] leading-snug text-fg-muted"
        title={
          working
            ? `${formatTokens(h.tokensSaved)} tokens · ${h.requestsCompressed} reqs comprimidos (média ${formatPct(h.avgCompressionPct)}%/req)`
            : "O tráfego dos runs ainda não passou pelo proxy"
        }
      >
        <Zap
          className={cn(
            "mt-px h-3 w-3 shrink-0",
            working ? "fill-current text-emerald-700 dark:text-emerald-400" : "text-fg-subtle",
          )}
        />
        {working ? (
          <span>
            Headroom poupou{" "}
            <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
              {formatPct(h.savingsPct)}%
            </span>{" "}
            desta conta — {formatTokens(h.tokensSaved)} tokens, US$ {h.savedUsd.toFixed(2)}.
          </span>
        ) : (
          <span>Headroom ligado, mas ainda não comprimiu nenhuma requisição.</span>
        )}
      </p>
    </>
  );
}

// `HeadroomChip` foi REMOVIDO (não re-introduzir sem montá-lo): era um 5º medidor da barra, escrito
// por inteiro, exportado e importado por NINGUÉM — o conteúdo dele tinha ido parar no painel dos
// processos e o componente ficou para trás. Hoje a economia é a `HeadroomLine`, acima, no painel a que
// ela pertence (a cota).
