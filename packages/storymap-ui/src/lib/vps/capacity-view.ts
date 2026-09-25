// capacity-view — o que o PAINEL de capacidade mostra, a partir do retrato do governador (GovernorSnapshot).
// PURO e isomórfico (o HealthPill e a página de Métricas o usam no cliente): toda decisão de texto, tom e
// "tem botão de soltar?" mora aqui, testada, e o componente só desenha.
//
// Honestidade herdada do HealthPill: uma leitura DEFASADA aparece esmaecida e dita como defasada; uma grandeza
// que o medidor não reporta vira "—", nunca 0%.

import type { GovernorSnapshot, HoldReason } from "@/lib/storymap/runner/capacity-governor";

export type CapacityTone = "idle" | "attention" | "danger";

export interface CapacityRow {
  key: "week" | "session" | "today" | "projection" | "held";
  label: string;
  value: string;
  /** a barra (0..100), quando a linha é uma grandeza medida; null = sem barra */
  pct: number | null;
  /** número defasado: a barra fica, sem cor de autoridade */
  muted?: boolean;
}

export interface CapacityView {
  tone: CapacityTone;
  headline: string;
  detail: string;
  /** "volta a tentar às 00:00" quando o governador sabe quando */
  retry: string | null;
  rows: CapacityRow[];
  latch: { level: "soft" | "hard"; reason: string; by: string; since: string; halt: boolean } | null;
  /** o painel oferece "Soltar trava"? Só para a trava do arquivo — o HALT sai apagando o arquivo no host. */
  canClear: boolean;
}

const HOLD_LABEL: Record<HoldReason, string> = {
  measuring: "medindo a janela",
  stale: "leitura defasada",
  "five-hour": "janela de 5h no teto",
  "week-cap": "teto da semana",
  "daily-allowance": "cota de hoje esgotada",
};

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function when(ms: number, now: number): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  if (sameDay) return `às ${clock(ms)}`;
  return new Date(ms).toLocaleString("pt-BR", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

/** O modelo do painel, ou null quando não há retrato (governador ilegível). PURO. */
export function capacityView(s: GovernorSnapshot | null | undefined, now: number): CapacityView | null {
  if (!s) return null;
  const rows: CapacityRow[] = [];
  const reading = s.reading;
  const muted = !!reading?.stale;

  if (reading) {
    const ceiling = s.pacing?.ceilingPct ?? s.caps.weekCapPct;
    rows.push({ key: "week", label: "Semana (7d)", value: `${r1(reading.usage7dPct)}% · teto ${r1(ceiling)}%`, pct: reading.usage7dPct, muted });
    rows.push({
      key: "session",
      label: "Sessão (5h)",
      value: reading.usage5hPct == null ? "—" : `${r1(reading.usage5hPct)}% · teto ${r1(s.caps.fiveHourCapPct)}%`,
      pct: reading.usage5hPct,
      muted,
    });
  }
  if (s.pacing) {
    const { usedTodayPct, allowancePct } = s.pacing;
    rows.push({
      key: "today",
      label: "Hoje (cota)",
      value: `${r1(usedTodayPct)} de ${r1(allowancePct)} pp`,
      pct: allowancePct > 0 ? Math.min(100, (usedTodayPct / allowancePct) * 100) : 100,
      muted,
    });
  }
  if (s.projectionAtResetPct != null) {
    rows.push({ key: "projection", label: "No reset (≈)", value: `${r1(s.projectionAtResetPct)}%`, pct: Math.min(100, s.projectionAtResetPct), muted });
  }
  rows.push({
    key: "held",
    label: "Retidos",
    value: s.held.count === 0 ? "nenhum" : `${s.held.count}${s.held.oldestSince != null ? ` · o mais antigo ${ago(s.held.oldestSince, now)}` : ""}`,
    pct: null,
  });

  const latch = s.latch
    ? {
        level: s.latch.level,
        reason: s.latch.reason,
        by: s.latch.trippedBy,
        since: ago(s.latch.at, now),
        halt: s.latch.source === "halt",
      }
    : null;

  let tone: CapacityTone = "idle";
  let headline: string;
  if (latch) {
    tone = "danger";
    headline = latch.halt ? "Travado — HALT do host" : `Travado (${latch.level === "hard" ? "dura" : "mole"})`;
  } else if (s.inert) {
    headline = s.inert === "disabled" ? "Governador desligado" : "Inerte — sem medidor de uso";
  } else if (s.verdict.kind === "latch") {
    tone = "danger";
    headline = "Automação retida — condição de trava";
  } else if (s.verdict.kind === "hold") {
    tone = "attention";
    headline = `Automação retida — ${HOLD_LABEL[s.verdict.reason as HoldReason] ?? s.verdict.reason}`;
  } else {
    headline = "Automação liberada";
  }

  return {
    tone,
    headline,
    detail: latch ? latch.reason : s.verdict.detail,
    retry: !latch && s.verdict.retryAt != null ? `volta a tentar ${when(s.verdict.retryAt, now)}` : null,
    rows,
    latch,
    canClear: !!latch && !latch.halt,
  };
}
