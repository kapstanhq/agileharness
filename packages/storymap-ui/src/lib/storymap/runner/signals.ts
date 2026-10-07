// signals.ts — o CONTRATO DE SINAIS (fase 6, o último bloco): dados de erro e de produto puxando trabalho, sem a
// ferramenta saber o que é PostHog ou Error Reporting. PURO (zero IO; o IO é signals-deps.ts).
//
// O CONTRATO (settings.yaml do ALVO):
//   signals:
//     reserveOwnerPct: 40           # ≥ 40% da capacidade do condutor fica para os pedidos do dono e o PRD
//     sources:
//       - id: erros                 # [a-z0-9-]
//         command: ["just", "errors", "--json"]   # argv, SEM shell; devolve JSON (abaixo)
//         board: livraria           # onde o card nasce
//         kind: errors              # errors = puxa trabalho; product = só contexto e o «moveu / não moveu»
//         maxCardsPerDay: 3         # teto por fonte
//         minEvents: 20             # abaixo disto o veredito é «inconclusivo»
// A saída do comando: { "causes": [{ "key": "...", "title": "...", "count": 12 }], "events": 340 }. Só AGREGADOS: a
// entrada guarda chave, título e contagem — qualquer outro campo é descartado, e o texto passa por um filtro que tira
// e-mail, telefone e sequências longas de dígitos (dado de pessoa nunca vira card).
//
// A ENTRADA É DETERMINÍSTICA (nenhum LLM decide o que vira card): um card por CAUSA (a chave normalizada), teto por
// fonte por dia, um DISJUNTOR (a fonte falha 3 vezes seguidas, ou despeja causas novas demais numa leitura — o desenho
// que impede repetir os milhares de movimentos de um único dia ruim) e a RESERVA do dono (os cards de sinal abertos
// nunca passam da fatia que não é do dono). Depois do deploy, o serviço relê a MESMA fonte e marca no card «moveu»,
// «não moveu» ou «inconclusivo» (pouco tráfego).

import { createHash } from "node:crypto";
import { causeSignature } from "./sentinel";

// ── a configuração ──────────────────────────────────────────────────────────────────────────────────────────────

export type SignalSourceKind = "errors" | "product";

export interface SignalSource {
  id: string;
  command: string[];
  board: string;
  kind: SignalSourceKind;
  maxCardsPerDay: number;
  minEvents: number;
  timeoutSeconds: number;
}

export interface SignalsSettings {
  sources: SignalSource[];
  /** a fatia da capacidade do condutor que fica com o dono e o PRD (0–100). */
  reserveOwnerPct: number;
}

export const DEFAULT_SIGNALS: SignalsSettings = { sources: [], reserveOwnerPct: 40 };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** O bloco `signals:` coagido. Fonte torta (sem id, sem comando, sem board) é descartada — nunca adivinhada. PURA. */
export function coerceSignalsSettings(raw: unknown): SignalsSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SIGNALS, sources: [] };
  const r = raw as Record<string, unknown>;
  const pct = typeof r.reserveOwnerPct === "number" && Number.isFinite(r.reserveOwnerPct) ? Math.min(100, Math.max(40, r.reserveOwnerPct)) : 40;
  const sources: SignalSource[] = [];
  for (const s of Array.isArray(r.sources) ? r.sources : []) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const board = typeof o.board === "string" ? o.board.trim() : "";
    const command = Array.isArray(o.command)
      ? o.command.filter((a): a is string => typeof a === "string" && a.length > 0)
      : typeof o.command === "string"
        ? o.command.trim().split(/\s+/).filter(Boolean)
        : [];
    if (!ID.test(id) || !board || command.length === 0 || sources.some((x) => x.id === id)) continue;
    const num = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : d);
    sources.push({
      id,
      board,
      command,
      kind: o.kind === "product" ? "product" : "errors",
      maxCardsPerDay: num(o.maxCardsPerDay, 3, 0, 20),
      minEvents: num(o.minEvents, 20, 0, 1_000_000),
      timeoutSeconds: num(o.timeoutSeconds, 60, 5, 600),
    });
  }
  return { sources, reserveOwnerPct: pct };
}

// ── a leitura: só agregados ─────────────────────────────────────────────────────────────────────────────────────

export interface SignalCause {
  /** a chave como a fonte a deu (já sem dado de pessoa). */
  key: string;
  title: string;
  count: number;
  /** a identidade estável da causa (hash curto da assinatura) — a chave de dedup do card. */
  hash: string;
}

export interface SignalReading {
  causes: SignalCause[];
  /** o total de eventos da janela (para o «inconclusivo»); null quando a fonte não diz. */
  events: number | null;
}

/** Tira o que pode ser de uma PESSOA: e-mail, telefone, sequência longa de dígitos, token longo. PURA. */
export function scrubPersonal(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[e-mail]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[id]")
    .replace(/\+?\(?\d[\d\s().-]{7,}\d/g, "[número]")
    .replace(/\s+/g, " ")
    .trim();
}

/** O hash curto da assinatura de uma causa (8 hex). PURA. */
export function signalCauseHash(sourceId: string, key: string): string {
  return createHash("sha256").update(`${sourceId}\n${causeSignature(key)}`).digest("hex").slice(0, 8);
}

/** A saída JSON de uma fonte em agregados; ilegível ⇒ null (conta como falha no disjuntor). PURA. */
export function parseSignalOutput(sourceId: string, raw: string): SignalReading | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const byHash = new Map<string, SignalCause>();
  for (const c of Array.isArray(o.causes) ? o.causes : []) {
    if (!c || typeof c !== "object") continue;
    const cc = c as Record<string, unknown>;
    const key = typeof cc.key === "string" ? scrubPersonal(cc.key).slice(0, 200) : "";
    if (!key) continue;
    const title = typeof cc.title === "string" && cc.title.trim() ? scrubPersonal(cc.title).slice(0, 120) : key.slice(0, 120);
    const count = typeof cc.count === "number" && Number.isFinite(cc.count) ? Math.max(0, Math.floor(cc.count)) : 0;
    const hash = signalCauseHash(sourceId, key);
    const prev = byHash.get(hash);
    if (prev) prev.count += count;
    else byHash.set(hash, { key, title, count, hash });
  }
  const events = typeof o.events === "number" && Number.isFinite(o.events) ? Math.max(0, Math.floor(o.events)) : null;
  return { causes: [...byHash.values()].sort((a, b) => b.count - a.count), events };
}

// ── o disjuntor ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SourceState {
  /** falhas seguidas (comando que não rodou, saída ilegível). */
  failures: number;
  /** ISO até quando o disjuntor fica aberto; ausente ⇒ fechado. */
  openUntil?: string;
  /** por que abriu. */
  openReason?: string;
  /** o dia (UTC) do contador abaixo. */
  day: string;
  /** cards criados hoje por esta fonte. */
  createdToday: number;
}

export const BREAKER_FAILURES = 3;
/** Causas NOVAS numa leitura acima disto ⇒ o disjuntor abre (uma enxurrada é defeito, não trabalho). */
export const BREAKER_BURST = 10;
export const BREAKER_OPEN_MS = 6 * 60 * 60_000;

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

export function emptySourceState(now: number): SourceState {
  return { failures: 0, day: today(now), createdToday: 0 };
}

/** O disjuntor está aberto agora? PURA. */
export function breakerOpen(s: SourceState | undefined, now: number): boolean {
  return !!s?.openUntil && Date.parse(s.openUntil) > now;
}

/** O estado depois de uma leitura: falha soma (e abre no 3º); enxurrada abre; leitura boa zera as falhas. PURA. */
export function afterRead(s: SourceState | undefined, now: number, read: { ok: boolean; newCauses: number }): SourceState {
  const base = s && s.day === today(now) ? { ...s } : { ...(s ?? emptySourceState(now)), day: today(now), createdToday: 0 };
  const open = (reason: string): SourceState => ({ ...base, openUntil: new Date(now + BREAKER_OPEN_MS).toISOString(), openReason: reason });
  if (!read.ok) {
    const failures = base.failures + 1;
    return failures >= BREAKER_FAILURES ? { ...open(`a fonte falhou ${failures} vezes seguidas`), failures } : { ...base, failures };
  }
  if (read.newCauses > BREAKER_BURST) return { ...open(`${read.newCauses} causas novas numa leitura (acima de ${BREAKER_BURST})`), failures: 0 };
  const { openUntil: _u, openReason: _r, ...rest } = base;
  return { ...rest, failures: 0 };
}

// ── a reserva do dono ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Quantos cards de SINAL podem estar abertos ao mesmo tempo, para que a fatia do dono fique livre: a capacidade do
 * condutor (`slots`) menos a reserva, nunca menos de 1 (senão um board de uma vaga nunca consertaria nada). PURA.
 */
export function maxOpenSignalCards(slots: number, reserveOwnerPct: number): number {
  const s = Math.max(1, Math.floor(slots));
  const pct = Math.min(100, Math.max(40, reserveOwnerPct));
  return Math.max(1, Math.floor(s * (1 - pct / 100)));
}

/**
 * A fatia das VAGAS do condutor que cards de sinal podem ocupar ao mesmo tempo: a capacidade menos a reserva do dono,
 * ARREDONDADA PARA BAIXO e sem piso — numa vaga só (40% de reserva ⇒ 0,6 de vaga), a fatia é zero; em duas, uma (50%). É
 * diferente de {@link maxOpenSignalCards}, que conta cards ABERTOS no board (criar um card não ocupa vaga). PURA.
 */
export function conductorSignalShare(slots: number, reserveOwnerPct: number): number {
  const s = Math.max(1, Math.floor(slots));
  const pct = Math.min(100, Math.max(40, reserveOwnerPct));
  return Math.floor(s * (1 - pct / 100));
}

/**
 * A fila do condutor pode dar a próxima vaga a um card de SINAL? Só se, com ele, os de sinal não passarem da fatia
 * ({@link conductorSignalShare}). A EXCEÇÃO de board pequeno (uma vaga, onde a fatia arredonda a zero): um card de sinal
 * entra quando NENHUM trabalho do dono/PRD espera na fila do board e nenhum outro sinal roda — a reserva protege o
 * trabalho do dono que existe, não uma vaga ociosa (confirmado pelo dono em 07/10: «seus pedidos primeiro»). A exceção
 * da exceção, também do dono: um sinal URGENTE (gravidade `high`/`blocker`, um erro grave em produção) passa na frente
 * do trabalho do dono quando nenhum outro sinal roda. PURA.
 */
export function conductorSlotAllowsSignal(input: { runningSignal: number; slots: number; reserveOwnerPct: number; ownerWorkQueued?: boolean; urgent?: boolean }): boolean {
  const share = conductorSignalShare(input.slots, input.reserveOwnerPct);
  if (input.runningSignal + 1 <= share) return true;
  if (input.urgent === true && input.runningSignal === 0) return true;
  return share === 0 && input.runningSignal === 0 && input.ownerWorkQueued === false;
}

/** Quanto esperar depois da publicação para reler a fonte (o sinal precisa de tráfego depois do deploy para mexer). */
export const SIGNAL_RECHECK_AFTER_MS = 24 * 60 * 60_000;

/**
 * Os cards de SINAL publicados que já podem receber o veredito: rótulo `sinal`, com a prova de publicação há pelo menos
 * {@link SIGNAL_RECHECK_AFTER_MS}, num status terminal, e ainda sem `sinal-veredito:` (um veredito por publicação). PURA.
 */
export function dueSignalRechecks(
  cards: ReadonlyArray<{ id: string; status?: string | null; labels?: string[]; deployProof?: { at: string } | null }>,
  terminal: ReadonlySet<string>,
  now: number,
  afterMs: number = SIGNAL_RECHECK_AFTER_MS,
): string[] {
  return cards
    .filter((c) => {
      if (!c.labels?.includes("sinal") || c.labels.some((l) => l.startsWith("sinal-veredito:"))) return false;
      if (!c.status || !terminal.has(c.status)) return false;
      const at = c.deployProof ? Date.parse(c.deployProof.at) : NaN;
      return Number.isFinite(at) && now - at >= afterMs;
    })
    .map((c) => c.id);
}

// ── a entrada ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface IntakePlan {
  create: SignalCause[];
  skipped: Array<{ hash: string; why: "open-card" | "daily-cap" | "owner-reserve" | "breaker" | "product-source" }>;
}

/**
 * Quais causas viram card AGORA. Um card por causa (o hash não pode ter card aberto), o teto do dia da fonte e a reserva
 * do dono; fonte `product` não cria card (só contexto e veredito); disjuntor aberto, nada. A ordem é a da contagem
 * (a causa maior primeiro). PURA.
 */
export function planSignalIntake(input: {
  source: Pick<SignalSource, "kind" | "maxCardsPerDay">;
  reading: SignalReading;
  state: SourceState;
  now: number;
  openCauseHashes: ReadonlySet<string>;
  openSignalCards: number;
  slots: number;
  reserveOwnerPct: number;
}): IntakePlan {
  const plan: IntakePlan = { create: [], skipped: [] };
  const all = input.reading.causes;
  if (breakerOpen(input.state, input.now)) {
    for (const c of all) plan.skipped.push({ hash: c.hash, why: "breaker" });
    return plan;
  }
  const createdToday = input.state.day === today(input.now) ? input.state.createdToday : 0;
  let budget = Math.max(0, input.source.maxCardsPerDay - createdToday);
  let open = input.openSignalCards;
  const maxOpen = maxOpenSignalCards(input.slots, input.reserveOwnerPct);
  for (const c of all) {
    if (input.openCauseHashes.has(c.hash)) plan.skipped.push({ hash: c.hash, why: "open-card" });
    else if (input.source.kind === "product") plan.skipped.push({ hash: c.hash, why: "product-source" });
    else if (budget <= 0) plan.skipped.push({ hash: c.hash, why: "daily-cap" });
    else if (open >= maxOpen) plan.skipped.push({ hash: c.hash, why: "owner-reserve" });
    else {
      plan.create.push(c);
      budget--;
      open++;
    }
  }
  return plan;
}

// ── o card e o veredito ─────────────────────────────────────────────────────────────────────────────────────────

/** O rótulo de dedup do card de uma causa. */
export const signalCardLabel = (sourceId: string, hash: string): string => `sinal:${sourceId}:${hash}`;

/** A marca que o card carrega para o veredito depois do deploy (uma linha, legível por máquina). */
export interface SignalMark {
  source: string;
  hash: string;
  baseline: number;
  events: number | null;
  at: string;
}

const MARK_RE = /<!--\s*sinal\s+(\{[^\n]*?\})\s*-->/;

/** O corpo do card de uma causa. PURA. */
export function signalCardBody(source: Pick<SignalSource, "id">, cause: SignalCause, reading: SignalReading, at: string): string {
  const mark: SignalMark = { source: source.id, hash: cause.hash, baseline: cause.count, events: reading.events, at };
  return [
    `## Sinal: ${cause.title}`,
    "",
    `- Fonte: ${source.id}`,
    `- Contagem na janela da fonte: ${cause.count}${reading.events != null ? ` (de ${reading.events} eventos)` : ""}`,
    `- Lido em ${at}`,
    "",
    "Só números agregados: nenhum dado de pessoa entra neste card.",
    "",
    "Depois do deploy o serviço relê a mesma fonte e escreve aqui se o número moveu.",
    "",
    `<!-- sinal ${JSON.stringify(mark)} -->`,
  ].join("\n");
}

/** A marca do card, ou null. PURA. */
export function readSignalMark(body: string | null | undefined): SignalMark | null {
  const m = body?.match(MARK_RE);
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]) as SignalMark;
    return o && typeof o.source === "string" && typeof o.hash === "string" && typeof o.baseline === "number" ? o : null;
  } catch {
    return null;
  }
}

export type SignalVerdict = "moveu" | "não moveu" | "inconclusivo";

/** A queda mínima (fração) para dizer «moveu». */
export const MOVED_DROP = 0.25;

/**
 * O veredito depois do deploy, sem IA: com poucos eventos (antes E depois abaixo de `minEvents`) é «inconclusivo»;
 * a contagem da causa caiu ao menos {@link MOVED_DROP} ⇒ «moveu»; senão «não moveu». PURA.
 */
export function signalVerdict(input: { baseline: number; current: number; minEvents: number; eventsBefore?: number | null; eventsAfter?: number | null }): SignalVerdict {
  const before = input.eventsBefore ?? input.baseline;
  const after = input.eventsAfter ?? input.current;
  if (before < input.minEvents && after < input.minEvents) return "inconclusivo";
  if (input.baseline <= 0) return "inconclusivo";
  return input.current <= input.baseline * (1 - MOVED_DROP) ? "moveu" : "não moveu";
}

/** A seção que o veredito acrescenta ao card. PURA. */
export function verdictSection(v: SignalVerdict, input: { baseline: number; current: number; at: string }): string {
  return ["", "## Sinal depois do deploy", "", `- ${v}: ${input.baseline} → ${input.current} (relido em ${input.at})`].join("\n");
}
