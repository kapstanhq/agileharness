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

/** Uma casa decimal, com vírgula (pt-BR): «26,3», nunca «26.3». */
const r1 = (n: number): string => (Math.round(n * 10) / 10).toString().replace(".", ",");

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

/**
 * O número da cota que TODA superfície mostra. Há duas leituras da MESMA janela da conta: a do proxy de uso (a barra de
 * topo) e a que o governador guardou no último tick dele. Lidas em momentos diferentes, elas divergiam na tela — o chip
 * dizia uma porcentagem e o painel, logo abaixo, outra. A regra, POR CAMPO (semana e sessão separadas): vale a leitura
 * MAIS RECENTE que tem aquele campo (por `polledAt`; `0` e ausente são «desconhecido», iguais entre si; empate, a do
 * proxy), e a defasagem, o instante da leitura e o reset vêm junto com ela. Sem nenhuma, null. PURA.
 */
export interface QuotaField {
  pct: number;
  /** quando ESTA leitura foi feita (epoch ms), ou null se desconhecido */
  polledAt: number | null;
  stale: boolean;
  /** o instante absoluto do reset desta janela, quando a fonte o diz */
  resetsAt: number | null;
  source: "proxy" | "governor";
}

export interface QuotaReading {
  week: QuotaField | null;
  session: QuotaField | null;
  /** atalhos do campo da SEMANA (o número do chip) — e da sessão */
  weekPct: number | null;
  sessionPct: number | null;
  polledAt: number | null;
  stale: boolean;
  source: "proxy" | "governor";
}

type ProxyBucket = { usedPct?: number | null; resetsAt?: number | null } | null | undefined;
type ProxyUsage = { week?: ProxyBucket; session?: ProxyBucket; polledAt?: number | null; stale?: boolean } | null | undefined;

const known = (t: number | null | undefined): number | null => (typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null);

/** O mais recente dos dois (empate ou ambos desconhecidos ⇒ o do proxy). PURA. */
function newest(p: QuotaField | null, g: QuotaField | null): QuotaField | null {
  if (!p || !g) return p ?? g;
  return (g.polledAt ?? -Infinity) > (p.polledAt ?? -Infinity) ? g : p;
}

export function unifiedQuota(proxy: ProxyUsage, governor: GovernorSnapshot | null | undefined): QuotaReading | null {
  const pAt = known(proxy?.polledAt);
  const pField = (b: ProxyBucket): QuotaField | null =>
    b && typeof b.usedPct === "number" ? { pct: b.usedPct, polledAt: pAt, stale: !!proxy?.stale, resetsAt: known(b.resetsAt), source: "proxy" } : null;
  const r = governor?.reading;
  const gAt = known(r?.polledAt);
  const gField = (pct: number | null | undefined, resetsAt: number | null | undefined): QuotaField | null =>
    r && typeof pct === "number" ? { pct, polledAt: gAt, stale: !!r.stale, resetsAt: known(resetsAt), source: "governor" } : null;
  const week = newest(pField(proxy?.week), gField(r?.usage7dPct, r?.resetsAt7d));
  const session = newest(pField(proxy?.session), gField(r?.usage5hPct, r?.resetsAt5h));
  if (!week && !session) return null;
  const head = (week ?? session)!;
  return { week, session, weekPct: week?.pct ?? null, sessionPct: session?.pct ?? null, polledAt: head.polledAt, stale: head.stale, source: head.source };
}

/**
 * A barra de uma janela com o número UNIFICADO: o percentual e o reset da fonte que venceu; o reset do proxy só quando é
 * ele que venceu (ou quando o vencedor não diz o reset). Sem número nenhum, null. PURA.
 */
export function quotaBucket(
  proxyBucket: { usedPct: number; resetsInMinutes: number } | null | undefined,
  field: QuotaField | null | undefined,
  now: number,
): { usedPct: number; resetsInMinutes: number } | null {
  if (!field) return proxyBucket ?? null;
  const resetsInMinutes = field.resetsAt != null ? Math.max(0, (field.resetsAt - now) / 60_000) : (proxyBucket?.resetsInMinutes ?? 0);
  return { usedPct: field.pct, resetsInMinutes };
}

/**
 * O modelo do painel, ou null quando não há retrato (governador ilegível). `quota` é o número unificado
 * ({@link unifiedQuota}) quando quem desenha também tem a leitura do proxy — sem ele, vale a do governador. PURO.
 */
export function capacityView(s: GovernorSnapshot | null | undefined, now: number, quota?: QuotaReading | null): CapacityView | null {
  if (!s) return null;
  const rows: CapacityRow[] = [];
  const q = quota ?? unifiedQuota(null, s);
  const reading = q && q.weekPct != null ? { usage7dPct: q.weekPct, usage5hPct: q.sessionPct, stale: q.stale } : null;
  const muted = !!reading?.stale;
  // «Hoje» e «No reset» são contas do GOVERNADOR sobre a leitura DELE; quando o número da semana mostrado é outro (o do
  // proxy, mais recente), essas linhas dizem de onde vêm em vez de parecer contas sobre o número de cima.
  const fromGovernor = q?.week && q.week.source !== "governor" && s.reading ? " · pela leitura anterior da cota" : "";

  if (reading) {
    const ceiling = s.pacing?.ceilingPct ?? s.caps.weekCapPct;
    rows.push({ key: "week", label: "Semana (7d)", value: `${r1(reading.usage7dPct)}% · teto ${r1(ceiling)}%`, pct: reading.usage7dPct, muted });
    rows.push({
      key: "session",
      label: "Sessão (5h)",
      value: reading.usage5hPct == null ? "—" : `${r1(reading.usage5hPct)}% · teto ${r1(s.caps.fiveHourCapPct)}%`,
      pct: reading.usage5hPct,
      muted: q?.session ? q.session.stale : muted,
    });
  }
  if (s.pacing) {
    const { usedTodayPct, allowancePct } = s.pacing;
    rows.push({
      key: "today",
      label: `Hoje${fromGovernor}`,
      value: `${r1(usedTodayPct)} de ${r1(allowancePct)} pontos da semana`,
      pct: allowancePct > 0 ? Math.min(100, (usedTodayPct / allowancePct) * 100) : 100,
      muted,
    });
  }
  if (s.projectionAtResetPct != null) {
    rows.push({ key: "projection", label: `Na virada da semana (estimativa)${fromGovernor}`, value: `${r1(s.projectionAtResetPct)}%`, pct: Math.min(100, s.projectionAtResetPct), muted });
  }
  rows.push({
    key: "held",
    label: "Trabalhos segurados",
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
  } else if (s.meterStall) {
    // O IMPASSE: leitura defasada há muito com o medidor já visto — sem número a automação não roda, e sem ela
    // nada renova o token do proxy. Não é "retida por defasagem" (uma espera que se resolve sozinha): é parado.
    tone = "danger";
    headline = "Medidor de cota PARADO — automação retida";
  } else if (s.inert) {
    headline = s.inert === "disabled" ? "Controle de cota desligado" : "Inerte — sem medidor de uso";
  } else if (s.verdict.kind === "latch") {
    tone = "danger";
    headline = "Automação retida — condição de trava";
  } else if (s.verdict.kind === "hold") {
    tone = "attention";
    headline = `Automação retida — ${HOLD_LABEL[s.verdict.reason as HoldReason] ?? s.verdict.reason}`;
  } else {
    // A COTA libera; se um board anda ou não é o RITMO dele (pausado/devagar). «Automação liberada» com o board
    // pausado ao lado parecia contradição — o painel fala só do que ele mede.
    headline = "Cota livre para o trabalho automático";
  }

  // A trava guarda o número do ENGATE («janela de 7 dias em 95%»); sem o «quando» e o «agora» ao lado, quem lê
  // toma o 95% pelo uso de hoje (aconteceu: cota zerada, painel dizendo 95%).
  const latchDetail = (l: NonNullable<typeof latch>): string => {
    if (l.halt) return l.reason;
    const now7d = reading ? `semana em ${r1(reading.usage7dPct)}%` : null;
    const now5h = reading?.usage5hPct != null ? `sessão em ${r1(reading.usage5hPct)}%` : null;
    const agora = [now7d, now5h].filter(Boolean).join(", ");
    return `acionada ${l.since}: ${l.reason}${agora ? ` · agora: ${agora}${reading?.stale ? " (leitura defasada)" : ""}` : ""}`;
  };

  return {
    tone,
    headline,
    detail: latch ? latchDetail(latch) : s.meterStall ? s.meterStall.detail : s.verdict.detail,
    retry: !latch && s.verdict.retryAt != null ? `volta a tentar ${when(s.verdict.retryAt, now)}` : null,
    rows,
    latch,
    canClear: !!latch && !latch.halt,
  };
}
