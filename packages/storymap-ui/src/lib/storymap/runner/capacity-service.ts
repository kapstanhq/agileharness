// capacity-service — o governador de capacidade VIVO. A régua é pura e mora em capacity-governor.ts; aqui mora
// o que ela precisa do mundo: a leitura do medidor (com cache), a base do dia e o registro do que está retido
// (persistidos no estado do runner), a TRAVA durável (`autonomy/latch.json`), o arquivo HALT do host, e os
// avisos críticos. Os pontos de admissão (o pump do engine, o tick do copiloto, o revisor par, o juiz, o spawn
// de sessão) perguntam por {@link CapacityGatePort.admission} — síncrono, porque o pump é síncrono: a leitura é
// renovada em segundo plano e a decisão usa a última conhecida (que o próprio veredito declara defasada quando
// envelhece).
//
// ── ONDE CADA COISA MORA (sob `runnerStateDir()/autonomy/`, que o sandbox dos agentes NÃO pode escrever) ──
//   latch.json     a trava {level, reason, at, trippedBy}. Existir = travado. Só o operador a apaga.
//   governor.json  a base do dia, a última leitura, se o medidor já existiu, o que está retido desde quando,
//                  os avisos já dados e os runs parados por uma trava dura (para re-armá-los na saída).
//   latch-audit.jsonl  quem engatou/soltou, quando e por quê.
// O HALT do host (`/etc/agileharness/HALT`, ou `AGILEHARNESS_HALT_FILE`) é uma trava DURA que ninguém escreve
// daqui: existir o arquivo basta; sai quando alguém o apaga no host.
//
// ── O KILL SWITCH ─────────────────────────────────────────────────────────────────────────────────────────
// `AGILEHARNESS_GOVERNOR=off` (ou `governor.enabled: false`) desliga a GOVERNANÇA — o veredito e a trava
// durável deixam de valer. O HALT continua valendo: ele é uma parada de emergência do host, e desligar o
// governador não pode ser a forma de ignorá-la.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import type { GovernorSettings } from "@/lib/storymap/types";
import type { UsageWindow } from "@/lib/vps/types";
import { headroomStatsUrl, readHeadroomStats } from "@/lib/vps/subscription-reader";
import { loadRunnerConfig } from "./config";
import {
  DAY_MS,
  DEFAULT_GOVERNOR_SETTINGS,
  LATCH_LEVELS,
  admissionFor,
  coerceLatchFile,
  decideCapacity,
  effectiveLatch,
  mayClearLatch,
  meterStallSince,
  pacingFor,
  projectWeekAtReset,
  rollBaseline,
  type AutoLatchReason,
  type CapacityReading,
  type CapacityVerdict,
  type DayBaseline,
  type EffectiveLatch,
  type GateVerdict,
  type GovernorSnapshot,
  type Initiator,
  type LatchLevel,
  type LatchState,
  type Pacing,
} from "./capacity-governor";
import { notifyCapacityCritical, type CapacityCriticalNotice } from "./capacity-notify";

/**
 * Os avisos que o governador emite: os do notificador de capacidade + `meter-stale` (o medidor PARADO — ver
 * {@link meterStallSince}; nome na política de push: `capacity-meter-stale`). Declarado aqui como união para o
 * serviço não depender da forma exata do tipo do notificador, que é quem decide o destino de cada kind.
 */
export type GovernorNotice = CapacityCriticalNotice | { kind: "meter-stale"; title: string; body: string };

/** O HALT do host quando `AGILEHARNESS_HALT_FILE` não diz outro. */
export const DEFAULT_HALT_FILE = "/etc/agileharness/HALT";
/** Quanto uma leitura do medidor é reaproveitada antes de uma nova ida ao proxy. */
export const CAPACITY_READ_TTL_MS = 60_000;
/** A cadência do laço do governador (leitura, trava automática, avisos) com a frota ociosa. */
export const CAPACITY_TICK_MS = 5 * 60_000;
/** Retido há mais que isto ⇒ aviso crítico (uma vez por item). */
export const HELD_ALERT_MS = DAY_MS;
/** A 1ª re-tentativa de uma leitura que falhou ANTES de qualquer leitura existir neste host. */
export const METER_BOOT_RETRY_BASE_MS = 15_000;

/**
 * As esperas entre as re-tentativas da PRIMEIRA leitura: `base`, dobrando, enquanto for MENOR que o tick
 * normal (15 s, 30 s, 60 s, 120 s, 240 s com os defaults). Chegar ao tick é esgotar: dali em diante o laço
 * normal já lê nessa cadência, e uma re-tentativa "rápida" do tamanho do tick não seria rápida. PURA.
 */
export function meterBootRetryDelays(baseMs: number = METER_BOOT_RETRY_BASE_MS, tickMs: number = CAPACITY_TICK_MS): number[] {
  const out: number[] = [];
  for (let d = baseMs; d > 0 && d < tickMs; d *= 2) out.push(d);
  return out;
}

/** O comando do keepalive do medidor: SÓ do ambiente do host (argv em JSON). Ver {@link meterKeepaliveArgv}. */
export const METER_KEEPALIVE_ENV = "AGILEHARNESS_METER_KEEPALIVE";
/** Teto de uma execução do keepalive — ele gera tráfego, não trabalho. */
export const METER_KEEPALIVE_TIMEOUT_MS = 120_000;

/**
 * O desfecho do "Renovar agora" do operador ({@link CapacityGovernor.runKeepaliveNow}):
 *   renewed         o keepalive rodou e a leitura relida depois dele está FRESCA — o impasse acabou;
 *   still-stalled   rodou sem erro, mas a leitura relida segue defasada (o tráfego não renovou o token);
 *   failed          o keepalive terminou com erro (saída ≠ 0, teto de tempo, binário ausente);
 *   not-configured  não há comando declarado no ambiente do host ({@link METER_KEEPALIVE_ENV});
 *   no-meter        o proxy de uso está desligado por ambiente — não há leitura a renovar.
 */
export type KeepaliveNowOutcome = "renewed" | "still-stalled" | "failed" | "not-configured" | "no-meter";
export interface KeepaliveNowResult {
  outcome: KeepaliveNowOutcome;
  /** o que o keepalive disse (saída/erro, curto) — ou o motivo de não ter rodado */
  detail: string;
}

/**
 * O argv do keepalive declarado no ambiente (`AGILEHARNESS_METER_KEEPALIVE='["claude","-p","ok"]'`), ou null.
 * SÓ o ambiente: `settings.yaml` chega a main pelo train (um delta de agente que passa no gate), e um comando
 * lido AO VIVO de lá seria execução arbitrária como o uid do serviço. JSON de strings não-vazias; qualquer outra
 * forma ⇒ null (e o serviço avisa). Roda SEM shell (execFile). PURA.
 */
export function meterKeepaliveArgv(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env[METER_KEEPALIVE_ENV]?.trim();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim() !== "")) return v as string[];
  } catch {
    /* forma inválida ⇒ null */
  }
  return null;
}

/** Um horário legível no fuso do governador (o do "dia"): `HH:MM`, com a data quando não é hoje. PURA. */
function clockIn(ms: number, now: number, tz: string | undefined): string {
  const opts = tz ? { timeZone: tz } : {};
  const day = (t: number) => new Intl.DateTimeFormat("pt-BR", { ...opts, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const hm = new Intl.DateTimeFormat("pt-BR", { ...opts, hour: "2-digit", minute: "2-digit" }).format(ms);
  return day(ms) === day(now) ? hm : `${new Intl.DateTimeFormat("pt-BR", { ...opts, day: "2-digit", month: "2-digit" }).format(ms)} ${hm}`;
}

/** O texto da demanda do medidor parado — o que o operador lê no painel, no aviso e no log. PURA. */
export function meterStallDetail(since: number, now: number, s: Pick<GovernorSettings, "timezone" | "meterKeepalive">, keepaliveArmed: boolean): string {
  const exit = keepaliveArmed
    ? `o keepalive declarado roda a cada ${s.meterKeepalive?.everyMinutes ?? "?"} min enquanto isso durar`
    : "saída: gere tráfego pelo proxy (uma sessão interativa basta) ou arme o keepalive (governor.meterKeepalive + AGILEHARNESS_METER_KEEPALIVE)";
  return (
    `medidor de cota parado desde ${clockIn(since, now, s.timezone)} — automação retida; causa provável: sem tráfego pelo ` +
    `proxy de uso (o token que ele colhe do tráfego expirou) ou o proxy fora do ar; ${exit}`
  );
}

/** O caminho do HALT do host. */
export function haltFilePath(env: Record<string, string | undefined> = process.env): string {
  const v = env.AGILEHARNESS_HALT_FILE?.trim();
  return v ? path.resolve(v) : DEFAULT_HALT_FILE;
}

/** O diretório de estado do governador (dentro do estado do runner — fora do alcance de escrita dos agentes). */
export function capacityStateDir(): string {
  return path.join(runnerStateDir(), "autonomy");
}

/**
 * A janela do medidor → a leitura do governador (null sem janela semanal — sem 7d não há o que governar).
 * `polledAt` ausente vira 0, isto é, DEFASADA: frescor desconhecido é tratado como velho, a mesma régua de
 * `isUsageStale`. O reset absoluto (`resets_at`) é preferido; sem ele, deriva do relativo no instante da busca.
 * PURA — exportada para o teste.
 */
export function readingFromUsage(u: UsageWindow | null, fetchedAt: number): CapacityReading | null {
  const week = u?.week;
  if (!u || !week) return null;
  const session = u.session;
  return {
    usage7dPct: week.usedPct,
    usage5hPct: session ? session.usedPct : null,
    resetsAt7d: week.resetsAt ?? fetchedAt + week.resetsInMinutes * 60_000,
    resetsAt5h: session ? (session.resetsAt ?? fetchedAt + session.resetsInMinutes * 60_000) : null,
    polledAt: u.polledAt ?? 0,
    extraUsageEnabled: !!u.extra?.enabled,
  };
}

/** Um run parado por uma trava DURA — o que re-armar quando ela sair. */
export interface StoppedRun {
  board: string;
  cardId: string;
  trigger: string;
}

interface HeldItem {
  since: number;
  surface: string;
  notifiedAt?: number;
}

interface GovernorState {
  version: 1;
  baseline: DayBaseline | null;
  meterSeenAt: number | null;
  lastReading: CapacityReading | null;
  held: Record<string, HeldItem>;
  extraUsageNotified: boolean;
  /** a condição de trava automática que o operador reconheceu ao soltar — não re-engata na MESMA borda */
  ackedLatchReason: AutoLatchReason | null;
  stopped: Array<StoppedRun & { at: number }>;
  /**
   * O episódio de medidor PARADO em curso (desde a última medição fresca; quando foi declarado). Persistido: um
   * restart no meio do impasse não pode re-avisar o celular pelo mesmo episódio — nem esquecê-lo.
   */
  meterStall: { since: number; detectedAt: number } | null;
}

function emptyState(): GovernorState {
  return { version: 1, baseline: null, meterSeenAt: null, lastReading: null, held: {}, extraUsageNotified: false, ackedLatchReason: null, stopped: [], meterStall: null };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Coerção tolerante do `governor.json`: o que não tem a forma certa é descartado, nunca promovido. */
function coerceState(raw: unknown): GovernorState {
  const out = emptyState();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  const b = o.baseline as Record<string, unknown> | null | undefined;
  if (b && typeof b.day === "string" && isNum(b.usage7dPct) && isNum(b.at) && isNum(b.resetsAt7d)) {
    out.baseline = { day: b.day, usage7dPct: b.usage7dPct, at: b.at, resetsAt7d: b.resetsAt7d };
  }
  if (isNum(o.meterSeenAt)) out.meterSeenAt = o.meterSeenAt;
  const r = o.lastReading as Record<string, unknown> | null | undefined;
  if (r && isNum(r.usage7dPct) && isNum(r.resetsAt7d) && isNum(r.polledAt)) {
    out.lastReading = {
      usage7dPct: r.usage7dPct,
      usage5hPct: isNum(r.usage5hPct) ? r.usage5hPct : null,
      resetsAt7d: r.resetsAt7d,
      resetsAt5h: isNum(r.resetsAt5h) ? r.resetsAt5h : null,
      polledAt: r.polledAt,
      extraUsageEnabled: r.extraUsageEnabled === true,
    };
  }
  if (o.held && typeof o.held === "object") {
    for (const [k, v] of Object.entries(o.held as Record<string, unknown>)) {
      const h = v as Record<string, unknown>;
      if (h && isNum(h.since) && typeof h.surface === "string") {
        out.held[k] = { since: h.since, surface: h.surface, ...(isNum(h.notifiedAt) ? { notifiedAt: h.notifiedAt } : {}) };
      }
    }
  }
  out.extraUsageNotified = o.extraUsageNotified === true;
  if (o.ackedLatchReason === "week" || o.ackedLatchReason === "five-hour" || o.ackedLatchReason === "extra-usage") {
    out.ackedLatchReason = o.ackedLatchReason;
  }
  const ms = o.meterStall as Record<string, unknown> | null | undefined;
  if (ms && isNum(ms.since) && isNum(ms.detectedAt)) out.meterStall = { since: ms.since, detectedAt: ms.detectedAt };
  if (Array.isArray(o.stopped)) {
    for (const s of o.stopped as Array<Record<string, unknown>>) {
      if (s && typeof s.board === "string" && typeof s.cardId === "string" && typeof s.trigger === "string") {
        out.stopped.push({ board: s.board, cardId: s.cardId, trigger: s.trigger, at: isNum(s.at) ? s.at : 0 });
      }
    }
  }
  return out;
}

/** O que um ponto de admissão enxerga do governador. DI: o engine recebe um dublê nos testes. */
export interface CapacityGatePort {
  /** entra ou espera — síncrono, pela última leitura conhecida */
  admission(initiator: Initiator): GateVerdict;
  /** o conjunto COMPLETO do que esta superfície está retendo agora (substitui o anterior) */
  reportHeld(surface: string, keys: readonly string[]): void;
  /** avisa quando o trabalho automático volta a poder entrar (a trava saiu, um dia novo, uma leitura nova) */
  onChange?(fn: () => void): () => void;
}

/** Para a trava DURA: parar os runs automáticos em voo e dizer quais foram. */
export type HardStopHook = (reason: string) => Promise<StoppedRun[]>;
/** Quando a trava dura sai: devolver os runs parados ao pipeline. */
export type RearmHook = (items: StoppedRun[]) => Promise<void>;

export interface CapacityServiceDeps {
  now?: () => number;
  settings?: () => GovernorSettings;
  /** a URL do medidor; null = sem medidor (proxy desligado por env) */
  statsUrl?: () => string | null;
  readUsage?: (url: string) => Promise<UsageWindow | null>;
  stateDir?: () => string;
  haltPath?: () => string;
  notify?: (n: GovernorNotice) => void;
  log?: (msg: string) => void;
  readTtlMs?: number;
  /** a 1ª espera das re-tentativas de boot ({@link meterBootRetryDelays}); default 15 s */
  bootRetryBaseMs?: number;
  /** o tick normal do laço — o teto das re-tentativas de boot; default {@link CAPACITY_TICK_MS} */
  tickMs?: number;
  /** agenda `fn` em `ms` e devolve o cancelador (DI: o teste dispara à mão); default `setTimeout` com `unref` */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** o argv do keepalive do medidor; default {@link meterKeepaliveArgv} sobre o ambiente do processo */
  keepaliveArgv?: () => string[] | null;
  /** roda o keepalive (sem shell, com teto); default `execFile`. Nunca lança — devolve o desfecho. */
  runKeepalive?: (argv: string[]) => Promise<{ ok: boolean; detail: string }>;
}

const defaultRunKeepalive = (argv: string[]): Promise<{ ok: boolean; detail: string }> =>
  new Promise((resolve) => {
    try {
      execFile(argv[0], argv.slice(1), { timeout: METER_KEEPALIVE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = `${stderr || stdout || ""}`.replace(/\s+/g, " ").trim().slice(0, 200);
        resolve(err ? { ok: false, detail: `${err.message.split("\n")[0]}${out ? ` — ${out}` : ""}`.slice(0, 240) } : { ok: true, detail: out });
      });
    } catch (err) {
      resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  });

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const h = setTimeout(fn, ms);
  h.unref?.();
  return () => clearTimeout(h);
};

export class CapacityGovernor implements CapacityGatePort {
  private readonly now: () => number;
  private readonly settingsOf: () => GovernorSettings;
  private readonly statsUrl: () => string | null;
  private readonly readUsage: (url: string) => Promise<UsageWindow | null>;
  private readonly dirOf: () => string;
  private readonly haltPathOf: () => string;
  private readonly notify: (n: GovernorNotice) => void;
  private readonly log: (msg: string) => void;
  private readonly readTtlMs: number;
  private readonly bootRetryDelays: number[];
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly keepaliveArgvOf: () => string[] | null;
  private readonly runKeepalive: (argv: string[]) => Promise<{ ok: boolean; detail: string }>;

  private loadedDir: string | null = null;
  private state: GovernorState = emptyState();
  private reading: CapacityReading | null = null;
  private latchFile: LatchState | null = null;
  private firstReadDone = false;
  /** quantas re-tentativas de boot já foram AGENDADAS (índice em `bootRetryDelays`) */
  private bootRetryAttempt = 0;
  /** o cancelador da re-tentativa de boot pendente; null = nenhuma agendada */
  private bootRetryCancel: (() => void) | null = null;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private lastAutomationAdmit: boolean | null = null;
  private wasHard = false;
  private inertLogged = false;
  private hardStop: HardStopHook | null = null;
  private rearm: RearmHook | null = null;
  private keepaliveInflight: Promise<void> | null = null;
  /** o desfecho da execução em voo — quem chega enquanto ela roda espera ESTA, nunca dispara outra */
  private keepaliveRun: Promise<{ ok: boolean; detail: string }> | null = null;
  private lastKeepaliveAt = Number.NEGATIVE_INFINITY;
  /** meia-configuração do keepalive já avisada (uma chave sem a outra) — não repetir a cada tick */
  private keepaliveHalfWarned: string | null = null;

  constructor(deps: CapacityServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.settingsOf = deps.settings ?? (() => loadRunnerConfig().governor ?? { ...DEFAULT_GOVERNOR_SETTINGS });
    this.statsUrl = deps.statsUrl ?? (() => headroomStatsUrl());
    this.readUsage = deps.readUsage ?? (async (url) => (await readHeadroomStats(url)).usage);
    this.dirOf = deps.stateDir ?? capacityStateDir;
    this.haltPathOf = deps.haltPath ?? (() => haltFilePath());
    this.notify = deps.notify ?? ((n) => notifyCapacityCritical(n as CapacityCriticalNotice));
    this.log = deps.log ?? ((m) => console.log(m));
    this.readTtlMs = deps.readTtlMs ?? CAPACITY_READ_TTL_MS;
    this.bootRetryDelays = meterBootRetryDelays(deps.bootRetryBaseMs ?? METER_BOOT_RETRY_BASE_MS, deps.tickMs ?? CAPACITY_TICK_MS);
    this.schedule = deps.schedule ?? defaultSchedule;
    this.keepaliveArgvOf = deps.keepaliveArgv ?? (() => meterKeepaliveArgv());
    this.runKeepalive = deps.runKeepalive ?? defaultRunKeepalive;
  }

  /** A trava dura para os runs em voo por AQUI (a composição — instrumentation — liga o engine). */
  setHardStop(fn: HardStopHook | null): void {
    this.hardStop = fn;
  }

  /** E os devolve ao pipeline quando ela sai. */
  setRearm(fn: RearmHook | null): void {
    this.rearm = fn;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── estado em disco ────────────────────────────────────────────────────────────────────────────────

  private settings(): GovernorSettings {
    try {
      return this.settingsOf();
    } catch {
      return { ...DEFAULT_GOVERNOR_SETTINGS }; // settings ilegível ⇒ os defaults (governa), nunca "desligado"
    }
  }

  /** Carrega o estado do diretório VIGENTE (a suíte reaponta o estado do runner por arquivo de prova). */
  private ensureLoaded(): void {
    const dir = this.dirOf();
    if (this.loadedDir === dir) return;
    this.loadedDir = dir;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, "governor.json"), "utf8"));
    } catch {
      raw = null;
    }
    this.state = coerceState(raw);
    this.reading = this.state.lastReading;
    this.latchFile = this.readLatchSync(this.now());
    this.firstReadDone = false;
    this.cancelMeterRetry();
    this.bootRetryAttempt = 0;
    this.lastReadAt = Number.NEGATIVE_INFINITY;
    this.lastAutomationAdmit = null;
    this.wasHard = false;
  }

  private readLatchSync(now: number): LatchState | null {
    const file = path.join(this.dirOf(), "latch.json");
    if (!existsSync(file)) return null;
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      raw = null; // ilegível ⇒ coerceLatchFile devolve trava DURA (fail-closed)
    }
    return coerceLatchFile(raw, true, now);
  }

  private haltProbe(): { path: string; at: number } | null {
    const p = this.haltPathOf();
    try {
      return { path: p, at: statSync(p).mtimeMs };
    } catch {
      return null;
    }
  }

  private persist(): void {
    const dir = this.dirOf();
    const body = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await fsp.mkdir(dir, { recursive: true });
        await atomicWriteFile(path.join(dir, "governor.json"), body);
      })
      .catch((err) => console.error("[capacity] estado não gravado:", err instanceof Error ? err.message : err));
  }

  private async audit(entry: Record<string, unknown>): Promise<void> {
    const dir = this.dirOf();
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    await fsp.appendFile(path.join(dir, "latch-audit.jsonl"), JSON.stringify(entry) + "\n", "utf8").catch(() => {});
  }

  private async writeLatch(next: LatchState): Promise<void> {
    this.latchFile = next; // vale em memória JÁ — a admissão seguinte não pode esperar o disco
    const dir = this.dirOf();
    await fsp.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "latch.json"), JSON.stringify(next, null, 2));
  }

  /** Espera as gravações pendentes (testes e desligamento). */
  async flush(): Promise<void> {
    await this.inflight;
    await this.keepaliveInflight;
    await this.inflight;
    await this.writeChain;
  }

  // ── a decisão ──────────────────────────────────────────────────────────────────────────────────────

  private verdictAt(now: number): CapacityVerdict {
    const s = this.settings();
    if (!this.statsUrl()) {
      // Proxy desligado por env: não HÁ medidor — inerte, mesmo que este host já o tenha visto um dia.
      return decideCapacity({ now, settings: s, reading: null, meterEverSeen: false, baseline: null });
    }
    return decideCapacity({
      now,
      settings: s,
      reading: this.reading,
      meterPending: !this.firstReadDone && !this.reading,
      meterEverSeen: this.state.meterSeenAt != null,
      baseline: this.state.baseline,
    });
  }

  private latchAt(): EffectiveLatch | null {
    const halt = this.haltProbe();
    // Governador desligado ⇒ a trava DELE não vale; o HALT do host vale sempre (ver o cabeçalho).
    const file = this.settings().enabled ? this.latchFile : null;
    return effectiveLatch(file, halt);
  }

  private isFresh(r: CapacityReading | null, now: number): r is CapacityReading {
    return !!r && now - r.polledAt <= this.settings().staleMinutes * 60_000 && r.resetsAt7d > now;
  }

  private kickRefresh(now: number): void {
    if (!this.inflight && now - this.lastReadAt >= this.readTtlMs) void this.refresh();
  }

  /** A admissão de um pedido — ver {@link admissionFor}. O operador nunca toca em disco nem na rede. */
  admission(initiator: Initiator): GateVerdict {
    if (initiator === "operator") return admissionFor("operator", { kind: "admit", detail: "" }, null);
    this.ensureLoaded();
    const now = this.now();
    this.kickRefresh(now);
    return admissionFor(initiator, this.verdictAt(now), this.latchAt());
  }

  reportHeld(surface: string, keys: readonly string[]): void {
    this.ensureLoaded();
    const now = this.now();
    const prefix = `${surface}|`;
    const want = new Set(keys.map((k) => prefix + k));
    let changed = false;
    for (const id of Object.keys(this.state.held)) {
      if (id.startsWith(prefix) && !want.has(id)) {
        delete this.state.held[id];
        changed = true;
      }
    }
    for (const id of want) {
      if (!this.state.held[id]) {
        this.state.held[id] = { since: now, surface };
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Relê o medidor (uma ida em voo por vez) e reavalia trava, avisos e re-armes. Nunca lança. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        this.ensureLoaded();
        const url = this.statsUrl();
        if (url) {
          const usage = await this.readUsage(url).catch(() => null);
          const now = this.now();
          this.lastReadAt = now;
          const r = readingFromUsage(usage, now);
          if (r) {
            this.reading = r;
            this.state.lastReading = r;
            this.state.meterSeenAt = now;
            // A base do dia só nasce de uma leitura FRESCA — uma defasada daria uma "primeira leitura" mentirosa.
            if (this.isFresh(r, now)) this.state.baseline = rollBaseline(this.state.baseline, r, now, this.settings().timezone);
            this.cancelMeterRetry();
            this.firstReadDone = true;
          } else if (this.state.meterSeenAt == null && !this.reading) {
            // NUNCA houve leitura neste host e esta falhou. UMA falha não prova "sem medidor": medido no host
            // vivo, o proxy estava de pé e respondia em 12 ms — só a leitura do BOOT falhou, e o governador
            // declarou-se inerte e admitiu TUDO até o tick seguinte, 5 min depois. Enquanto houver
            // re-tentativa, a primeira leitura segue PENDENTE (a automação espera a medição, como no boot);
            // só esgotadas elas é que a ausência vira fato — e aí, sim, inerte.
            if (!this.scheduleMeterRetry()) this.firstReadDone = true;
          } else {
            this.firstReadDone = true;
          }
        } else {
          // Proxy desligado por env: a ausência do medidor é DECLARADA, não medida — inerte já, sem re-tentar.
          this.lastReadAt = this.now();
          this.firstReadDone = true;
        }
        this.latchFile = this.readLatchSync(this.now());
        await this.evaluate(this.now());
        this.persist();
      } catch (err) {
        console.error("[capacity] refresh falhou:", err instanceof Error ? err.message : err);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /**
   * Agenda a próxima re-tentativa da PRIMEIRA leitura ({@link meterBootRetryDelays}). Devolve `true` enquanto
   * a medição segue pendente (agendou agora, ou já havia uma agendada) e `false` quando as re-tentativas
   * ESGOTARAM — só então a falta de medidor é um fato.
   */
  private scheduleMeterRetry(): boolean {
    if (this.bootRetryCancel) return true;
    const delay = this.bootRetryDelays[this.bootRetryAttempt];
    if (delay === undefined) return false;
    this.bootRetryAttempt += 1;
    this.log(
      `[capacity] a leitura do medidor falhou e ele nunca foi lido neste host — nova tentativa em ${Math.round(delay / 1000)}s ` +
        `(${this.bootRetryAttempt}/${this.bootRetryDelays.length}); o trabalho automático espera a medição`,
    );
    this.bootRetryCancel = this.schedule(() => {
      this.bootRetryCancel = null;
      void this.refresh();
    }, delay);
    return true;
  }

  /** Cancela a re-tentativa de boot pendente (uma leitura chegou, o estado mudou de diretório, ou o laço parou). */
  cancelMeterRetry(): void {
    this.bootRetryCancel?.();
    this.bootRetryCancel = null;
  }

  /** O laço periódico chama isto. */
  tick(): Promise<void> {
    return this.refresh();
  }

  /**
   * As BORDAS: engatar a trava automática, avisar o que é crítico, parar/re-armar na trava dura, dizer uma vez
   * que está inerte, e acordar quem espera quando a automação volta a poder entrar.
   */
  private async evaluate(now: number): Promise<void> {
    const verdict = this.verdictAt(now);
    const fresh = this.isFresh(this.reading, now) && !!this.statsUrl();

    // 1) A trava automática — por BORDA: engata quando a condição aparece e o operador não a reconheceu.
    if (verdict.kind === "latch") {
      if (!this.latchFile && this.state.ackedLatchReason !== verdict.reason) {
        const latch: LatchState = { level: "soft", reason: verdict.detail, at: now, trippedBy: `auto:${verdict.reason}` };
        await this.writeLatch(latch).catch((err) => console.error("[capacity] latch não gravado:", err instanceof Error ? err.message : err));
        await this.audit({ action: "engage", ...latch });
        if (verdict.reason === "extra-usage") {
          this.state.extraUsageNotified = true;
          this.notify({
            kind: "extra-usage",
            title: "Uso extra PAGO ligado — frota travada",
            body: `${verdict.detail}. A trava de capacidade engatou: nenhum trabalho automático começa até você soltá-la.`,
          });
        } else {
          this.notify({
            kind: "latch",
            title: "Trava de capacidade ENGATADA",
            body: `${verdict.detail}. Nenhum trabalho automático começa até você soltar a trava no painel de capacidade.`,
          });
        }
      }
    } else if (fresh && this.state.ackedLatchReason !== null) {
      this.state.ackedLatchReason = null; // a condição reconhecida passou: a próxima borda volta a travar
    }

    // 2) Uso extra ligado sem trava nova (ex.: o operador já tinha soltado) — ainda é crítico, uma vez.
    if (fresh && this.reading!.extraUsageEnabled && !this.state.extraUsageNotified) {
      this.state.extraUsageNotified = true;
      this.notify({ kind: "extra-usage", title: "Uso extra PAGO ligado na conta", body: "A conta passou a poder gastar dinheiro além da assinatura." });
    } else if (fresh && !this.reading!.extraUsageEnabled) {
      this.state.extraUsageNotified = false;
    }

    // 3) Retido há mais de 24h — um aviso por item.
    const overdue = Object.entries(this.state.held).filter(([, h]) => h.notifiedAt === undefined && now - h.since >= HELD_ALERT_MS);
    if (overdue.length) {
      for (const [, h] of overdue) h.notifiedAt = now;
      const names = overdue.map(([id]) => id.slice(id.indexOf("|") + 1));
      this.notify({
        kind: "held-24h",
        title: `${overdue.length} trabalho(s) automático(s) retido(s) há mais de 24h`,
        body:
          `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` (+${names.length - 5})` : ""} — ` +
          `o governador de capacidade: ${verdict.detail}`,
      });
    }

    // 4) Trava DURA: para os runs automáticos em voo na borda de entrada; re-arma os parados na saída.
    const latch = this.latchAt();
    const hard = latch?.level === "hard";
    if (hard && !this.wasHard && this.hardStop) {
      const stopped = await this.hardStop(latch!.reason).catch(() => [] as StoppedRun[]);
      for (const r of stopped) this.state.stopped.push({ ...r, at: now });
    }
    if (!hard && this.state.stopped.length && this.rearm) {
      const items = this.state.stopped.map(({ board, cardId, trigger }) => ({ board, cardId, trigger }));
      this.state.stopped = [];
      await this.rearm(items).catch((err) => console.error("[capacity] re-arme falhou:", err instanceof Error ? err.message : err));
    }
    this.wasHard = hard;

    // 5) Inerte sem medidor: dizer UMA vez (e de novo se o medidor aparecer e sumir).
    if (verdict.kind === "admit" && verdict.inert === "no-meter") {
      if (!this.inertLogged) {
        this.inertLogged = true;
        // Com o proxy configurado, "inerte" só chega aqui DEPOIS das re-tentativas — e o operador que não roda
        // proxy nenhum precisa saber como dizer isso de uma vez (declarado ⇒ inerte já no boot, sem espera).
        const how = this.statsUrl()
          ? ` (após ${this.bootRetryDelays.length} re-tentativa(s) da primeira leitura; sem proxy neste host? declare AGILEHARNESS_HEADROOM_URL=off)`
          : "";
        this.log(`[capacity] ${verdict.detail}${how} — o trabalho automático não é limitado pela janela da conta.`);
      }
    } else {
      this.inertLogged = false;
    }

    // 6) O medidor PARADO — o impasse que a espera por defasagem sozinha não enxerga (ver meterStallSince): UMA
    //    borda por episódio (persistida), aviso crítico `meter-stale`; e a volta de uma medição fresca o encerra.
    const s = this.settings();
    const stallSince = this.statsUrl() ? meterStallSince({ reading: this.reading, meterSeenAt: this.state.meterSeenAt, now }, s) : null;
    if (stallSince != null && !this.state.meterStall) {
      this.state.meterStall = { since: stallSince, detectedAt: now };
      const detail = meterStallDetail(stallSince, now, s, this.keepaliveArmed(s));
      this.log(`[capacity] ${detail}`);
      this.notify({ kind: "meter-stale", title: "Medidor de cota PARADO — automação retida", body: detail });
    } else if (stallSince == null && this.state.meterStall) {
      this.log(
        `[capacity] o medidor voltou (estava parado desde ${clockIn(this.state.meterStall.since, now, s.timezone)}) — a automação volta a ser governada pela janela da conta.`,
      );
      this.state.meterStall = null;
    }

    // 7) A saída OPCIONAL do impasse: com a leitura defasada e o medidor já visto, o keepalive declarado gera
    //    tráfego pelo proxy — no máximo um por `everyMinutes`, um em voo por vez, e só com as DUAS chaves.
    if (verdict.kind === "hold" && verdict.reason === "stale" && this.state.meterSeenAt != null && this.statsUrl()) {
      this.maybeKeepalive(s, now);
    }

    // 8) A automação voltou a poder entrar ⇒ acorda quem espera (o engine re-pumpa na hora).
    const admits = admissionFor("automation", this.verdictAt(now), this.latchAt()).admit;
    const flippedOpen = admits && this.lastAutomationAdmit === false;
    this.lastAutomationAdmit = admits;
    if (flippedOpen) {
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch (err) {
          console.error("[capacity] listener falhou:", err instanceof Error ? err.message : err);
        }
      }
    }
  }

  /** As DUAS chaves do keepalive estão dadas? (cadência no settings + comando no ambiente do host) */
  private keepaliveArmed(s: GovernorSettings): boolean {
    return !!s.meterKeepalive && !!this.keepaliveArgvOf();
  }

  /**
   * Dispara o keepalive se ele está armado e a cadência permite. Nunca bloqueia o laço (roda em segundo plano),
   * nunca lança, e ao terminar relê o medidor — é a leitura nova que diz se o impasse acabou. Uma chave sem a
   * outra é dita UMA vez: nada roda sem as duas.
   */
  private maybeKeepalive(s: GovernorSettings, now: number): void {
    const argv = this.keepaliveArgvOf();
    if (!s.meterKeepalive || !argv) {
      const half = s.meterKeepalive ? "settings-sem-comando" : argv ? "comando-sem-settings" : null;
      if (half && this.keepaliveHalfWarned !== half) {
        this.keepaliveHalfWarned = half;
        this.log(
          half === "settings-sem-comando"
            ? `[capacity] governor.meterKeepalive declarado, mas sem comando no ambiente (${METER_KEEPALIVE_ENV}, argv em JSON) — o keepalive NÃO roda.`
            : `[capacity] ${METER_KEEPALIVE_ENV} definido, mas governor.meterKeepalive ausente no settings — o keepalive NÃO roda.`,
        );
      }
      return;
    }
    this.keepaliveHalfWarned = null;
    if (this.keepaliveRun || now - this.lastKeepaliveAt < s.meterKeepalive.everyMinutes * 60_000) return;
    void this.startKeepalive(argv, now, "leitura defasada com o medidor já visto");
  }

  /**
   * Roda o keepalive em segundo plano — ou devolve a execução que JÁ está em voo (uma por vez, venha o pedido do
   * laço ou do operador). Nunca lança; ao terminar relê o medidor. Marca a cadência: o laço automático conta o
   * seu `everyMinutes` a partir desta execução, seja ela dele ou do operador.
   */
  private startKeepalive(argv: string[], now: number, why: string): Promise<{ ok: boolean; detail: string }> {
    if (this.keepaliveRun) return this.keepaliveRun;
    this.lastKeepaliveAt = now;
    this.log(`[capacity] ${why} — rodando o keepalive (${argv[0]}) para gerar tráfego pelo proxy`);
    const run = this.runKeepalive(argv)
      .catch((err): { ok: boolean; detail: string } => ({ ok: false, detail: err instanceof Error ? err.message : String(err) }))
      .then((r) => {
        this.log(`[capacity] keepalive ${r.ok ? "concluído" : "FALHOU"}${r.detail ? `: ${r.detail}` : ""}`);
        return r;
      });
    this.keepaliveRun = run;
    this.keepaliveInflight = run
      .then(() => undefined)
      .finally(() => {
        this.keepaliveRun = null;
        this.keepaliveInflight = null;
        void this.refresh();
      });
    return run;
  }

  /**
   * O "Renovar agora" do operador (o item do medidor parado no Inbox): roda o keepalive declarado JÁ e relê o
   * medidor. Difere do laço automático em DUAS coisas, e só nelas:
   *   · fura a cadência `everyMinutes` — ela existe para o laço não gastar sozinho, não para negar um clique
   *     deliberado de quem está olhando o impasse; a execução do operador também passa a contar como a última;
   *   · basta o comando no ambiente do host: `governor.meterKeepalive` é a cadência do laço, não uma permissão.
   * O resto é o mesmo: o comando vem SÓ do ambiente ({@link meterKeepaliveArgv} — nunca do pedido nem do
   * settings), roda sem shell e com teto, e uma execução já em voo é ESPERADA em vez de duplicada. Quem pode
   * chamar é decidido na server action (só o operador com sessão). Nunca lança.
   */
  async runKeepaliveNow(): Promise<KeepaliveNowResult> {
    this.ensureLoaded();
    if (!this.statsUrl()) {
      return { outcome: "no-meter", detail: "o proxy de uso está desligado por ambiente neste host — não há leitura a renovar" };
    }
    const argv = this.keepaliveArgvOf();
    if (!argv) return { outcome: "not-configured", detail: `${METER_KEEPALIVE_ENV} não está definido no ambiente do serviço` };
    const run = await this.startKeepalive(argv, this.now(), "o operador pediu «Renovar agora»");
    // A leitura que conta é a que COMEÇA depois do tráfego: uma já em voo pode ter partido antes dele terminar.
    await this.inflight;
    await this.refresh();
    if (!run.ok) return { outcome: "failed", detail: run.detail || "o keepalive terminou com erro" };
    if (this.isFresh(this.reading, this.now())) return { outcome: "renewed", detail: run.detail };
    return {
      outcome: "still-stalled",
      detail: "o keepalive rodou, mas a leitura relida segue defasada — o tráfego não renovou o token do proxy de uso",
    };
  }

  // ── a trava pelo operador/agente ──────────────────────────────────────────────────────────────────────

  /**
   * ENGATA a trava. Qualquer um com acesso pode puxar o freio (a UI do operador, uma tool MCP): o sentido é
   * seguro. Engatar nunca REBAIXA uma trava dura para mole.
   */
  async engageLatch(input: { level: LatchLevel; reason: string; by: string }): Promise<LatchState> {
    if (!(LATCH_LEVELS as readonly string[]).includes(input.level)) throw new Error(`nível de trava inválido: ${input.level}`);
    const reason = input.reason.trim();
    if (reason.length < 3) throw new Error("diga o motivo da trava (mín. 3 caracteres)");
    this.ensureLoaded();
    const now = this.now();
    const level: LatchLevel = this.latchFile?.level === "hard" ? "hard" : input.level;
    const next: LatchState = { level, reason, at: now, trippedBy: input.by };
    await this.writeLatch(next);
    await this.audit({ action: "engage", ...next });
    this.notify({ kind: "latch", title: `Trava de capacidade engatada (${level})`, body: `${reason} — por ${input.by}.` });
    await this.evaluate(now);
    this.persist();
    return next;
  }

  /**
   * SOLTA a trava — só o operador com sessão, e com motivo ({@link mayClearLatch}). O HALT não sai por aqui (é
   * um arquivo do host). Se a condição que engatou a trava automática ainda está viva, ela fica RECONHECIDA
   * (não re-engata na mesma borda) — mas o veredito continua segurando a automação até a condição passar.
   */
  async clearLatch(input: { caller: string; reason: string }): Promise<{ ok: true; cleared: LatchState | null } | { ok: false; why: string }> {
    const gate = mayClearLatch(input.caller, input.reason);
    if (!gate.ok) return gate;
    this.ensureLoaded();
    const now = this.now();
    const halt = this.haltProbe();
    if (halt) return { ok: false, why: `o arquivo ${halt.path} está presente no host — a parada de emergência sai apagando-o lá` };
    const cleared = this.readLatchSync(now) ?? this.latchFile;
    const verdict = this.verdictAt(now);
    if (verdict.kind === "latch") this.state.ackedLatchReason = verdict.reason;
    await fsp.rm(path.join(this.dirOf(), "latch.json"), { force: true });
    this.latchFile = null;
    await this.audit({ at: now, action: "clear", reason: input.reason.trim(), previous: cleared });
    this.log(`[capacity] trava SOLTA pelo operador: ${input.reason.trim()} (era: ${cleared?.reason ?? "nenhuma"})`);
    await this.evaluate(now);
    this.persist();
    return { ok: true, cleared };
  }

  // ── o retrato ──────────────────────────────────────────────────────────────────────────────────────

  snapshot(): GovernorSnapshot {
    this.ensureLoaded();
    const now = this.now();
    this.kickRefresh(now);
    const s = this.settings();
    const verdict = this.verdictAt(now);
    const reading = this.statsUrl() ? this.reading : null;
    const fresh = this.isFresh(reading, now);
    let pacing: Pacing | null = verdict.kind !== "latch" && verdict.pacing ? verdict.pacing : null;
    if (!pacing && fresh) pacing = pacingFor(reading, rollBaseline(this.state.baseline, reading, now, s.timezone), now, s);
    const held = Object.values(this.state.held);
    return {
      at: now,
      enabled: s.enabled,
      inert: verdict.kind === "admit" && verdict.inert ? verdict.inert : null,
      verdict: {
        kind: verdict.kind,
        reason: verdict.kind === "admit" ? (verdict.inert ?? "admit") : verdict.reason,
        detail: verdict.detail,
        retryAt: verdict.kind === "hold" ? verdict.retryAt : null,
      },
      reading: reading ? { ...reading, stale: !fresh } : null,
      pacing,
      projectionAtResetPct: reading && fresh ? projectWeekAtReset(reading, now) : null,
      held: { count: held.length, oldestSince: held.length ? Math.min(...held.map((h) => h.since)) : null },
      latch: this.latchAt(),
      meterStall:
        this.state.meterStall && this.statsUrl()
          ? { ...this.state.meterStall, detail: meterStallDetail(this.state.meterStall.since, now, s, this.keepaliveArmed(s)) }
          : null,
      caps: {
        weekCapPct: s.weekCapPct,
        weekCapLast24hPct: s.weekCapLast24hPct,
        fiveHourCapPct: s.fiveHourCapPct,
        latchWeekPct: s.latchWeekPct,
        latchFiveHourPct: s.latchFiveHourPct,
      },
    };
  }
}

// ── o singleton do processo + o laço ─────────────────────────────────────────────────────────────────────

const KEY = Symbol.for("storymap.runner.capacityGovernor");
const store = globalThis as unknown as { [KEY]?: CapacityGovernor };

export function getCapacityGovernor(): CapacityGovernor {
  return (store[KEY] ??= new CapacityGovernor());
}

/** Teste: troca (ou zera, com null) o singleton. */
export function setCapacityGovernorForTests(g: CapacityGovernor | null): void {
  if (g) store[KEY] = g;
  else delete store[KEY];
}

/**
 * Liga o laço do governador (a composição — instrumentation — chama no boot): lê o medidor já, e depois a cada
 * {@link CAPACITY_TICK_MS}, mesmo com a frota ociosa — é esse laço que toma a primeira leitura do dia perto da
 * meia-noite, engata a trava automática e avisa o que é crítico sem esperar um pedido de admissão. Re-armante
 * (nunca se sobrepõe) e `unref` (nunca segura o processo).
 */
export function startCapacityGovernor(
  opts: { hardStop?: HardStopHook; rearm?: RearmHook; intervalMs?: number; governor?: CapacityGovernor } = {},
): () => void {
  const g = opts.governor ?? getCapacityGovernor();
  if (opts.hardStop) g.setHardStop(opts.hardStop);
  if (opts.rearm) g.setRearm(opts.rearm);
  const ms = opts.intervalMs ?? CAPACITY_TICK_MS;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (stopped) return;
    handle = setTimeout(() => void g.tick().finally(arm), ms);
    handle.unref?.();
  };
  void g.tick().finally(arm);
  return () => {
    stopped = true;
    if (handle) clearTimeout(handle);
    g.cancelMeterRetry();
  };
}
