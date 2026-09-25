// capacity-governor — o GOVERNADOR DE CAPACIDADE: a DECISÃO pura de admitir, segurar ou travar o trabalho
// AUTOMÁTICO pela janela REAL de uso da assinatura. Irmão de `governor.ts` (que CONTÉM um run já admitido num
// scope do systemd) e do `scheduler.ts` (que admite pela RAM/load da máquina): este admite pela CONTA.
//
// ── POR QUE ISTO EXISTE ─────────────────────────────────────────────────────────────────────────────────
// O host roda o Claude Code numa assinatura de preço fixo. O limite que existe de verdade não é dinheiro — o
// custo em dólar do ledger é NOCIONAL —, são as JANELAS de uso (5 horas e 7 dias, em %), e o dono usa as
// MESMAS janelas no trabalho interativo dele. Medido: a semana fechou em 78–80% com a ferramenta PARADA. A
// leitura real das janelas já existia (lib/vps/quota.ts + subscription.ts, pelo /stats do proxy de uso), mas
// era só MOSTRADOR: a admissão (o pump do engine, o scheduler) olhava RAM e load, nunca a conta.
//
// ── A POLÍTICA (decisões do dono, e cada número é um knob de `settings.yaml governor:`) ──────────────────
//   · a frota trabalha até 80% da janela de 7 dias — uso TOTAL (dono + frota), porque é o que o limite mede;
//   · nas últimas 24h antes do reset semanal ela pode ir a 90%, e só com a janela de 5h abaixo de 85%;
//   · a janela de 5h tem teto de 85% para trabalho que não é do operador;
//   · TRAVA automática (latch) em 7d ≥ 92%, 5h ≥ 90%, ou uso extra (pago) ligado na conta;
//   · RITMO DIÁRIO: a cota de hoje = (teto − uso na 1ª leitura do dia) ÷ dias até o reset; atingida, o
//     automático espera o dia seguinte. É o que impede a frota de queimar a semana na segunda-feira;
//   · leitura DEFASADA (> staleMinutes) ⇒ o automático espera (fail-closed): sem número não se gasta;
//   · SEM medidor (quem adota sem o proxy, ou em modo de chave de API) ⇒ INERTE: admite tudo e diz isso uma
//     vez no log. Um governador que trava para sempre por falta de medidor seria um bug de instalação;
//   · o trabalho do OPERADOR (humano) e as sessões interativas NUNCA são retidos. Se o orçamento aperta, o
//     cronograma estica — nunca se compra mais.
//
// PURO e isomórfico: nada de fs, rede ou process — só `Intl` (o fuso do "dia"). O estado (a base do dia, o
// latch em disco, o arquivo HALT, a leitura) é do serviço (capacity-service.ts); aqui mora só a régua, e ela é
// testada por tabela (capacity-governor.test.ts).

import type { GovernorSettings } from "@/lib/storymap/types";

/** Quem iniciou o trabalho. `operator` nunca é retido; `automation` passa pelo governador. */
export type Initiator = "operator" | "automation";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Duas leituras são da MESMA janela semanal quando o reset delas difere menos que isto (o `resets_at` do
 *  proxy oscila em segundos entre polls; uma janela nova desloca o reset em ~7 dias). */
const SAME_WINDOW_TOLERANCE_MS = HOUR_MS;
/** Leitura defasada/ausente: quando re-tentar. O laço do serviço relê o medidor antes disso. */
export const STALE_RETRY_MS = 5 * 60_000;
/** A primeira leitura ainda está em voo (boot): re-tentar logo. */
export const MEASURING_RETRY_MS = 30_000;
/** 5h no teto sem `resets_at` da janela curta: re-tentar em meia hora. */
const FIVE_HOUR_FALLBACK_RETRY_MS = 30 * 60_000;

/** Os defaults — as decisões do dono. `timezone` ausente = o fuso do host. */
export const DEFAULT_GOVERNOR_SETTINGS: Readonly<GovernorSettings> = {
  enabled: true,
  weekCapPct: 80,
  weekCapLast24hPct: 90,
  fiveHourCapPct: 85,
  latchWeekPct: 92,
  latchFiveHourPct: 90,
  staleMinutes: 20,
};

// ── COERÇÃO (fail-closed por campo, sem spread do objeto cru) ──────────────────────────────────────────────

/** Percentual em (0, 100]. Número, ou string numérica NÃO-vazia (`Number("")` seria 0 e um campo em branco
 *  viraria um teto zero em silêncio). Qualquer outra coisa ⇒ undefined ⇒ o default. */
function asPct(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim());
  else return undefined;
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : undefined;
}

function asPositive(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim());
  else return undefined;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** O fuso é um nome IANA que o runtime conhece? (`Intl` lança RangeError para um nome inválido.) */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Coerção de `governor:`. Campo a campo sobre os defaults, SEM spread do objeto cru: um campo que a coerção não
 * conhece não pode entrar, e um valor inválido cai no default COM aviso — nunca desliga um teto em silêncio.
 * Um único ajuste de coerência: o teto das últimas 24h nunca fica ABAIXO do teto normal (seria um aperto no fim
 * da semana que ninguém pediu); um valor assim é elevado ao teto normal e avisado.
 */
export function coerceGovernorSettings(raw: unknown, d: Readonly<GovernorSettings> = DEFAULT_GOVERNOR_SETTINGS): GovernorSettings {
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    console.warn(`[storymap] settings governor: esperado um mapa, recebido ${JSON.stringify(raw)} — defaults mantidos.`);
  }
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const recusados: string[] = [];
  const pct = (key: keyof GovernorSettings, def: number): number => {
    if (o[key] === undefined || o[key] === null) return def;
    const n = asPct(o[key]);
    if (n === undefined) {
      recusados.push(key);
      return def;
    }
    return n;
  };
  let enabled = d.enabled;
  if (typeof o.enabled === "boolean") enabled = o.enabled;
  else if (o.enabled !== undefined && o.enabled !== null) recusados.push("enabled");

  const weekCapPct = pct("weekCapPct", d.weekCapPct);
  let weekCapLast24hPct = pct("weekCapLast24hPct", d.weekCapLast24hPct);
  if (weekCapLast24hPct < weekCapPct) {
    console.warn(
      `[storymap] settings governor.weekCapLast24hPct (${weekCapLast24hPct}) abaixo de weekCapPct (${weekCapPct}) — ` +
        `elevado a ${weekCapPct}: as últimas 24h nunca apertam o teto.`,
    );
    weekCapLast24hPct = weekCapPct;
  }

  let staleMinutes = d.staleMinutes;
  if (o.staleMinutes !== undefined && o.staleMinutes !== null) {
    const n = asPositive(o.staleMinutes);
    if (n === undefined) recusados.push("staleMinutes");
    else staleMinutes = n;
  }

  let timezone = d.timezone;
  if (o.timezone !== undefined && o.timezone !== null) {
    const tz = typeof o.timezone === "string" ? o.timezone.trim() : "";
    if (tz && isValidTimeZone(tz)) timezone = tz;
    else recusados.push("timezone");
  }

  if (recusados.length) {
    console.warn(
      `[storymap] settings governor: ${recusados.length} campo(s) inválido(s) DESCARTADO(s) (${recusados.join(", ")}) — ` +
        `esses seguem no default.`,
    );
  }
  return {
    enabled,
    weekCapPct,
    weekCapLast24hPct,
    fiveHourCapPct: pct("fiveHourCapPct", d.fiveHourCapPct),
    latchWeekPct: pct("latchWeekPct", d.latchWeekPct),
    latchFiveHourPct: pct("latchFiveHourPct", d.latchFiveHourPct),
    staleMinutes,
    ...(timezone ? { timezone } : {}),
  };
}

/**
 * O kill switch de ENV (`AGILEHARNESS_GOVERNOR`): `off`/`0`/`false`/`no`/`disabled` desliga; `on`/`1`/`true`/
 * `yes` liga. Qualquer outro valor é IGNORADO (undefined ⇒ vale o arquivo) — uma env malformada não pode ligar
 * nem desligar o governador por acidente. O chamador (config.ts) avisa.
 */
export function governorEnvSwitch(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (/^(0|off|false|no|disabled)$/.test(v)) return false;
  if (/^(1|on|true|yes|enabled)$/.test(v)) return true;
  return undefined;
}

// ── QUEM INICIOU ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A régua ÚNICA de "quem iniciou este trabalho", a partir do que o código já carrega: a `origin` do run
 * (`manual` = alguém pediu; `autorun` = o cascade; `conflict-redrive` = o merge train) e se a chamada veio de
 * um ator MCP ESCOPADO (o token do copiloto/tick, nunca o `full` do operador — mcp/actor.ts).
 *
 * CONSERVADORA de propósito: só é `operator` o que é `manual` E não veio de um agente escopado. Uma origin
 * ausente é tratada como a do engine (`autorun`) ⇒ automação. O erro nesse sentido custa espera; o erro no
 * sentido oposto gastaria a janela do dono sem ele saber.
 */
export function initiatorFromOrigin(
  origin: "autorun" | "manual" | "conflict-redrive" | undefined,
  scopedActor: boolean,
): Initiator {
  return origin === "manual" && !scopedActor ? "operator" : "automation";
}

// ── O TEMPO LOCAL (o "dia" do ritmo diário) ──────────────────────────────────────────────────────────────

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? "";
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

function localParts(now: number, tz: string | undefined): { day: string; msSinceMidnight: number } {
  const p: Record<string, string> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(now))) p[part.type] = part.value;
  const hour = Number(p.hour) % 24; // um runtime antigo pode escrever "24" para a meia-noite
  const msSinceMidnight = ((hour * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 + (((now % 1000) + 1000) % 1000);
  return { day: `${p.year}-${p.month}-${p.day}`, msSinceMidnight };
}

/** `YYYY-MM-DD` do instante `now` no fuso `tz` (ausente = o fuso do host). */
export function localDayKey(now: number, tz?: string): string {
  return localParts(now, tz).day;
}

/**
 * O primeiro instante do PRÓXIMO dia local. A conta ingênua (meia-noite + 24h) erra por uma hora nos dias de
 * horário de verão (23h ou 25h); o ajuste fino caminha minuto a minuto até a fronteira exata, limitado a 3h.
 */
export function nextLocalDayStart(now: number, tz?: string): number {
  const { day, msSinceMidnight } = localParts(now, tz);
  let t = now - msSinceMidnight + DAY_MS;
  for (let i = 0; i < 180 && localDayKey(t, tz) === day; i++) t += 60_000;
  for (let i = 0; i < 180 && localDayKey(t - 60_000, tz) !== day; i++) t -= 60_000;
  return t;
}

// ── A LEITURA E A BASE DO DIA ────────────────────────────────────────────────────────────────────────────

/** Uma leitura do medidor (a janela da assinatura, como o `/usage` a mostra). */
export interface CapacityReading {
  /** % consumido da janela de 7 dias (uso TOTAL da conta) */
  usage7dPct: number;
  /** % consumido da janela de 5 horas; null quando o medidor não a reporta */
  usage5hPct: number | null;
  /** epoch ms do reset da janela de 7 dias */
  resetsAt7d: number;
  /** epoch ms do reset da janela de 5 horas; null quando desconhecido */
  resetsAt5h: number | null;
  /** epoch ms em que o medidor consultou a conta (a régua da defasagem) */
  polledAt: number;
  /** o uso extra PAGO está ligado na conta */
  extraUsageEnabled: boolean;
}

/** A PRIMEIRA leitura do dia local — a régua do "quanto já gastei hoje". Persistida pelo serviço. */
export interface DayBaseline {
  /** `YYYY-MM-DD` no fuso do governador */
  day: string;
  /** o % de 7 dias naquela primeira leitura */
  usage7dPct: number;
  /** quando ela foi tomada (epoch ms) */
  at: number;
  /** o reset da janela semanal a que ela pertence (uma janela nova é uma base nova) */
  resetsAt7d: number;
}

function sameWindow(a: number, b: number): boolean {
  return Math.abs(a - b) < SAME_WINDOW_TOLERANCE_MS;
}

/**
 * A base de hoje: a anterior, se ainda é do MESMO dia local e da MESMA janela semanal; senão esta leitura vira a
 * primeira do dia. A janela que vira no meio do dia (o reset semanal) também troca a base — comparar o consumo
 * da janela nova contra a primeira leitura da janela velha daria um "gasto de hoje" negativo e inútil.
 */
export function rollBaseline(prev: DayBaseline | null, reading: CapacityReading, now: number, tz?: string): DayBaseline {
  const day = localDayKey(now, tz);
  if (prev && prev.day === day && sameWindow(prev.resetsAt7d, reading.resetsAt7d)) {
    // Uma leitura ABAIXO da base (a conta corrigiu o número, ou a janela é deslizante) re-ancora para baixo:
    // medir o gasto de hoje a partir de um ponto que a própria conta já desmentiu zeraria a cota à toa.
    return reading.usage7dPct < prev.usage7dPct ? { ...prev, usage7dPct: reading.usage7dPct } : prev;
  }
  return { day, usage7dPct: reading.usage7dPct, at: now, resetsAt7d: reading.resetsAt7d };
}

/** O ritmo de hoje — o que o painel mostra e o que a decisão compara. Números crus (o painel arredonda). */
export interface Pacing {
  day: string;
  /** o teto que vale AGORA (o normal, ou o das últimas 24h) */
  ceilingPct: number;
  /** estamos nas últimas 24h antes do reset semanal */
  last24h: boolean;
  /** o % de 7 dias na primeira leitura do dia */
  baselinePct: number;
  /** quanto a frota pode subir a janela hoje: (teto − base) ÷ dias até o reset (mín. 1 dia) */
  allowancePct: number;
  /** quanto a janela já subiu hoje (uso total: dono + frota) */
  usedTodayPct: number;
  /** dias (fracionários) da primeira leitura do dia até o reset */
  daysUntilReset: number;
}

/**
 * O ritmo do dia. `daysUntilReset` é contado da primeira leitura do dia até o reset — fracionário, e dividido
 * por no MÍNIMO 1: no último dia a cota é todo o espaço que falta até o teto, nunca um múltiplo dele.
 */
export function pacingFor(reading: CapacityReading, baseline: DayBaseline, now: number, s: GovernorSettings): Pacing {
  const last24h = reading.resetsAt7d - now <= DAY_MS;
  const fiveOk = reading.usage5hPct == null || reading.usage5hPct < s.fiveHourCapPct;
  const ceilingPct = last24h && fiveOk ? s.weekCapLast24hPct : s.weekCapPct;
  const daysUntilReset = Math.max(0, (baseline.resetsAt7d - baseline.at) / DAY_MS);
  return {
    day: baseline.day,
    ceilingPct,
    last24h,
    baselinePct: baseline.usage7dPct,
    allowancePct: Math.max(0, ceilingPct - baseline.usage7dPct) / Math.max(1, daysUntilReset),
    usedTodayPct: Math.max(0, reading.usage7dPct - baseline.usage7dPct),
    daysUntilReset,
  };
}

// ── A DECISÃO ────────────────────────────────────────────────────────────────────────────────────────────

/** Por que o automático espera. */
export type HoldReason = "measuring" | "stale" | "five-hour" | "week-cap" | "daily-allowance";
/** Por que a trava automática disparou. */
export type AutoLatchReason = "week" | "five-hour" | "extra-usage";

export type CapacityVerdict =
  /** admite — `inert` quando o governador não governa (desligado, ou sem medidor) */
  | { kind: "admit"; inert?: "disabled" | "no-meter"; detail: string; pacing?: Pacing }
  /** o automático espera até `retryAt` (a hora em que a condição pode ter mudado) */
  | { kind: "hold"; reason: HoldReason; detail: string; retryAt: number; pacing?: Pacing }
  /** a trava deve ENGATAR (o serviço a torna durável; só o operador a solta) */
  | { kind: "latch"; reason: AutoLatchReason; detail: string };

export interface CapacityInput {
  now: number;
  settings: GovernorSettings;
  /** a leitura mais recente; null quando não há nenhuma */
  reading: CapacityReading | null;
  /** o medidor existe e a PRIMEIRA leitura ainda está em voo (boot) */
  meterPending?: boolean;
  /** este host já viu uma leitura do medidor alguma vez (persistido) — distingue "sem medidor" de "medidor sumiu" */
  meterEverSeen: boolean;
  /** a base do dia persistida (null ⇒ esta leitura é a primeira) */
  baseline: DayBaseline | null;
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * A DECISÃO, em ordem — e a ordem é o argumento:
 *   1. desligado ⇒ inerte;
 *   2. sem leitura: primeira em voo ⇒ espera curta; medidor já visto e sumido ⇒ espera (defasado); nunca visto ⇒
 *      inerte (quem adota sem medidor não pode ficar travado para sempre);
 *   3. leitura defasada, ou de uma janela que já virou ⇒ espera (fail-closed: sem número não se gasta);
 *   4. trava: uso extra ligado, 7d ≥ latchWeek, 5h ≥ latchFiveHour — ANTES dos tetos, porque é mais grave;
 *   5. 5h ≥ teto de 5h ⇒ espera o reset da janela curta;
 *   6. 7d ≥ teto (80, ou 90 nas últimas 24h com a janela de 5h folgada) ⇒ espera o reset (ou a abertura das
 *      últimas 24h, quando o teto sobe);
 *   7. o gasto de hoje atingiu a cota de hoje ⇒ espera o dia seguinte;
 *   8. admite.
 * Só o trabalho AUTOMÁTICO lê este veredito — o do operador nunca passa por aqui (ver {@link admissionFor}).
 */
export function decideCapacity(input: CapacityInput): CapacityVerdict {
  const { now, settings: s, reading } = input;
  if (!s.enabled) return { kind: "admit", inert: "disabled", detail: "governador de capacidade desligado" };

  if (!reading) {
    if (input.meterPending) {
      return { kind: "hold", reason: "measuring", detail: "primeira leitura do medidor de uso em andamento", retryAt: now + MEASURING_RETRY_MS };
    }
    if (input.meterEverSeen) {
      return {
        kind: "hold",
        reason: "stale",
        detail: "o medidor de uso não respondeu (ele já existiu neste host) — sem número, o trabalho automático espera",
        retryAt: now + STALE_RETRY_MS,
      };
    }
    return {
      kind: "admit",
      inert: "no-meter",
      detail: "sem medidor de capacidade (nenhuma janela de uso da assinatura disponível) — governador inerte",
    };
  }

  const ageMs = now - reading.polledAt;
  if (ageMs > s.staleMinutes * 60_000) {
    return {
      kind: "hold",
      reason: "stale",
      detail: `leitura de uso defasada (${Math.round(ageMs / 60_000)}min, limite ${fmt(s.staleMinutes)}min) — o trabalho automático espera um número novo`,
      retryAt: now + STALE_RETRY_MS,
    };
  }
  if (reading.resetsAt7d <= now) {
    return {
      kind: "hold",
      reason: "stale",
      detail: "a janela semanal da última leitura já virou — esperando a leitura da janela nova",
      retryAt: now + STALE_RETRY_MS,
    };
  }

  if (reading.extraUsageEnabled) {
    return { kind: "latch", reason: "extra-usage", detail: "uso extra (PAGO) está ligado na conta — a frota não gasta dinheiro de verdade" };
  }
  if (reading.usage7dPct >= s.latchWeekPct) {
    return { kind: "latch", reason: "week", detail: `janela de 7 dias em ${fmt(reading.usage7dPct)}% (trava em ${fmt(s.latchWeekPct)}%)` };
  }
  if (reading.usage5hPct != null && reading.usage5hPct >= s.latchFiveHourPct) {
    return {
      kind: "latch",
      reason: "five-hour",
      detail: `janela de 5 horas em ${fmt(reading.usage5hPct)}% (trava em ${fmt(s.latchFiveHourPct)}%)`,
    };
  }

  const baseline = rollBaseline(input.baseline, reading, now, s.timezone);
  const pacing = pacingFor(reading, baseline, now, s);

  if (reading.usage5hPct != null && reading.usage5hPct >= s.fiveHourCapPct) {
    const retryAt = reading.resetsAt5h != null && reading.resetsAt5h > now ? reading.resetsAt5h : now + FIVE_HOUR_FALLBACK_RETRY_MS;
    return {
      kind: "hold",
      reason: "five-hour",
      detail: `janela de 5 horas em ${fmt(reading.usage5hPct)}% (teto ${fmt(s.fiveHourCapPct)}% para trabalho automático)`,
      retryAt,
      pacing,
    };
  }

  if (reading.usage7dPct >= pacing.ceilingPct) {
    // Fora das últimas 24h o teto SOBE quando elas abrem; dentro delas, só o reset devolve espaço.
    const retryAt = pacing.last24h ? reading.resetsAt7d : reading.resetsAt7d - DAY_MS;
    return {
      kind: "hold",
      reason: "week-cap",
      detail:
        `janela de 7 dias em ${fmt(reading.usage7dPct)}% — no teto de ${fmt(pacing.ceilingPct)}% ` +
        (pacing.last24h ? "das últimas 24h" : "da semana"),
      retryAt,
      pacing,
    };
  }

  if (pacing.usedTodayPct >= pacing.allowancePct) {
    const candidates = [nextLocalDayStart(now, s.timezone), reading.resetsAt7d];
    if (!pacing.last24h) candidates.push(reading.resetsAt7d - DAY_MS);
    return {
      kind: "hold",
      reason: "daily-allowance",
      detail:
        `a cota de hoje acabou: a janela subiu ${fmt(pacing.usedTodayPct)} pp desde a primeira leitura do dia ` +
        `(cota ${fmt(pacing.allowancePct)} pp = (${fmt(pacing.ceilingPct)} − ${fmt(pacing.baselinePct)}) ÷ ` +
        `${fmt(Math.max(1, pacing.daysUntilReset))} dia(s))`,
      retryAt: Math.min(...candidates.filter((t) => t > now)),
      pacing,
    };
  }

  return {
    kind: "admit",
    detail:
      `dentro do ritmo: hoje ${fmt(pacing.usedTodayPct)}/${fmt(pacing.allowancePct)} pp, ` +
      `7d ${fmt(reading.usage7dPct)}% (teto ${fmt(pacing.ceilingPct)}%)`,
    pacing,
  };
}

// ── A TRAVA (LATCH) ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `soft` — nenhum spawn automático novo (o que está rodando termina).
 * `hard` — `soft` + os runs automáticos EM VOO são parados; eles voltam (re-armados) quando a trava sai.
 * Os dois só saem por AÇÃO DO OPERADOR (a server action com sessão + motivo), ou apagando o arquivo HALT.
 */
export type LatchLevel = "soft" | "hard";

/** O conteúdo de `autonomy/latch.json` no diretório de estado do runner. */
export interface LatchState {
  level: LatchLevel;
  reason: string;
  /** epoch ms em que engatou */
  at: number;
  /** quem engatou: `auto:<motivo>`, `operator`, `mcp:<nível>` */
  trippedBy: string;
}

/** A trava EFETIVA: a do arquivo de estado, ou o HALT do host (que é sempre `hard`). */
export interface EffectiveLatch extends LatchState {
  source: "file" | "halt";
}

/** Os níveis aceitos — a coerção do arquivo e da tool MCP usam esta lista. */
export const LATCH_LEVELS: readonly LatchLevel[] = ["soft", "hard"] as const;

/**
 * Coerção do `latch.json` lido do disco. Um arquivo que EXISTE mas está ilegível/malformado vira uma trava
 * `hard` (fail-closed): alguém escreveu ali uma intenção de parar, e interpretá-la como "sem trava" seria o
 * lado perigoso. `null` só quando o arquivo não existe (o chamador passa `undefined`).
 */
export function coerceLatchFile(raw: unknown, fileExists: boolean, now: number): LatchState | null {
  if (!fileExists) return null;
  const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  const level = o && (LATCH_LEVELS as readonly unknown[]).includes(o.level) ? (o.level as LatchLevel) : null;
  const reason = o && typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : null;
  if (!o || !level || !reason) {
    return { level: "hard", reason: "latch.json ilegível ou malformado — tratado como trava dura", at: now, trippedBy: "unknown" };
  }
  return {
    level,
    reason,
    at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : now,
    trippedBy: typeof o.trippedBy === "string" && o.trippedBy.trim() ? o.trippedBy.trim() : "unknown",
  };
}

/** A trava que vale: o HALT do host vence (é `hard` por definição), senão a do arquivo, senão nenhuma. */
export function effectiveLatch(file: LatchState | null, halt: { path: string; at: number } | null): EffectiveLatch | null {
  if (halt) {
    return { level: "hard", reason: `arquivo ${halt.path} presente no host`, at: halt.at, trippedBy: "host:HALT", source: "halt" };
  }
  return file ? { ...file, source: "file" } : null;
}

/**
 * Quem pode SOLTAR a trava: só o operador com SESSÃO no painel (`operator-session`, o chamador que
 * lib/auth/action-guard.ts prova por cookie), e com um motivo. Um agente pelo MCP — mesmo com o token `full` —
 * pode ENGATAR a trava, nunca soltá-la; o próprio serviço também não a solta sozinho (uma trava que se solta
 * sem humano não é trava). PURO: a server action consulta isto antes de tocar o arquivo.
 */
export function mayClearLatch(caller: string, reason: string): { ok: true } | { ok: false; why: string } {
  if (caller !== "operator-session") {
    return { ok: false, why: `só o operador com sessão no painel solta a trava (chamador: ${caller})` };
  }
  if (reason.trim().length < 3) return { ok: false, why: "diga o motivo para soltar a trava (mín. 3 caracteres)" };
  return { ok: true };
}

// ── A ADMISSÃO DE UM PEDIDO ──────────────────────────────────────────────────────────────────────────────

/** O prefixo de toda recusa por capacidade que vira TEXTO (revisor par, juiz, sessão) — um marcador estável para
 *  quem lê a recusa distinguir "o governador segurou" de "falhou". */
export const CAPACITY_HELD_MARKER = "retido pelo governador de capacidade";

/** O que um ponto de admissão recebe: entra ou espera, por quê, e até quando. */
export interface GateVerdict {
  admit: boolean;
  /** estável para log/teste */
  reason: "operator" | "inert" | "admit" | HoldReason | "latch" | "auto-latch";
  detail: string;
  /** quando re-tentar (null = só quando algo mudar: a trava sair, uma leitura nova) */
  retryAt: number | null;
}

/**
 * A admissão de UM pedido. O operador NUNCA espera — nem com trava, nem sem medidor, nem no teto: o
 * governador existe para proteger a janela DELE da frota, não o contrário. A automação respeita a trava
 * efetiva (arquivo/HALT) e o veredito da janela.
 */
export function admissionFor(initiator: Initiator, verdict: CapacityVerdict, latch: EffectiveLatch | null): GateVerdict {
  if (initiator === "operator") {
    return { admit: true, reason: "operator", detail: "trabalho iniciado pelo operador nunca é retido", retryAt: null };
  }
  if (latch) {
    return { admit: false, reason: "latch", detail: `trava ${latch.level} engatada: ${latch.reason}`, retryAt: null };
  }
  switch (verdict.kind) {
    case "latch":
      return { admit: false, reason: "auto-latch", detail: verdict.detail, retryAt: null };
    case "hold":
      return { admit: false, reason: verdict.reason, detail: verdict.detail, retryAt: verdict.retryAt };
    case "admit":
      return { admit: true, reason: verdict.inert ? "inert" : "admit", detail: verdict.detail, retryAt: null };
  }
}

// ── O RETRATO (o que o painel lê) ────────────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * DAY_MS;

/**
 * Onde a janela de 7 dias termina se o ritmo MÉDIO dela seguir — extrapolação linear, a MESMA régua de
 * `lib/vps/quota.ts projectBucket` (recusa responder antes de 5% da janela: extrapolar uma semana de alguns
 * minutos é ruído). Aqui e não importada de lá porque aquele módulo arrasta o MetricsHub, que lê este. PURA.
 */
export function projectWeekAtReset(r: Pick<CapacityReading, "usage7dPct" | "resetsAt7d">, now: number): number | null {
  const elapsed = WEEK_MS - (r.resetsAt7d - now);
  if (!Number.isFinite(elapsed) || elapsed < WEEK_MS * 0.05 || elapsed > WEEK_MS) return null;
  return Math.round(((r.usage7dPct * WEEK_MS) / elapsed) * 10) / 10;
}

/** O estado do governador para a UI (HealthPill e a página de métricas). Serializável. */
export interface GovernorSnapshot {
  at: number;
  enabled: boolean;
  /** por que ele não governa, quando não governa */
  inert: "disabled" | "no-meter" | null;
  verdict: { kind: CapacityVerdict["kind"]; reason: string; detail: string; retryAt: number | null };
  reading: (CapacityReading & { stale: boolean }) | null;
  pacing: Pacing | null;
  /** onde a janela de 7 dias termina se o ritmo médio dela seguir (≈, linear); null cedo demais para dizer */
  projectionAtResetPct: number | null;
  /** o trabalho automático que está esperando o governador */
  held: { count: number; oldestSince: number | null };
  latch: EffectiveLatch | null;
  /** os tetos em vigor (o painel desenha a régua contra eles) */
  caps: Pick<GovernorSettings, "weekCapPct" | "weekCapLast24hPct" | "fiveHourCapPct" | "latchWeekPct" | "latchFiveHourPct">;
}
