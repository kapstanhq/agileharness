// O TICK DE SAÚDE ligado à produção — o laço «detectar → registrar → virar trabalho». SEM LLM e sem custo de cota: um
// timer lê o disco (health-collect.ts), mede (ah-health.ts), anexa UMA linha ao storymap/.runner/health.jsonl e, quando um
// sinal fica VERMELHO em duas leituras seguidas, abre UM card `[saude:<id>]` na Triagem do board da própria ferramenta.
//
// POR QUE NÃO NO INBOX. O dono só decide o que é de negócio; um sinal de saúde vermelho é trabalho do SISTEMA. Um item no
// Inbox transferiria ao dono algo que ele não sabe julgar (o mesmo erro que o relatório mede em S1). O destino é o board
// da ferramenta — o único lugar onde quem conserta a ferramenta (uma sessão com o ciclo de conserto) o encontra.
//
// UM CARD POR EPISÓDIO VERMELHO, NUNCA UM POR TICK: enquanto houver um card `saude:S6` aberto o tick não cria outro (o
// 3º, o 30º tick no vermelho dão `exists`); fechado o card com o sinal AINDA vermelho, também não (`covered`, ver
// `episodeCover`) — o card novo só nasce depois de uma leitura fora do vermelho. O card só fecha pelo recibo de release
// (record_tool_release), não por o sinal ter piscado verde.
//
// SEM BOARD DA FERRAMENTA, NADA É CRIADO — e o porquê fica escrito na própria linha do health.jsonl (e num log, uma vez):
// uma instalação que não declarou `AGILEHARNESS_SELF_BOARD` não ganha um card num board inventado (self-board.ts).
//
// A escrita do card passa pela MESMA porta do vigia de parados (`withCreateLock` + `makeDraftCard` + `writeCard`): o
// serviço é o único escritor do board de runtime, e a trava de criação serializa contra a action da UI.

import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { makeDraftCard } from "@/lib/storymap/draft";
import { parseYamlMap } from "@/lib/storymap/frontmatter";
import { runnerStateDir, settingsPath } from "@/lib/storymap/paths";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { selfBoardId } from "@/lib/storymap/self-board";
import type { Card } from "@/lib/storymap/types";
import { withCreateLock, writeCard } from "@/lib/storymap/write";
import { scopeHealthInputs } from "./health-scope";
import {
  coerceHealthSettings,
  computeHealth,
  DEFAULT_HEALTH_SETTINGS,
  episodeCover,
  redStreaks,
  toHealthRecord,
  type HealthCardOutcome,
  type HealthRecord,
  type HealthReport,
  type HealthSettings,
  type HealthSignal,
  type HealthSignalId,
} from "./ah-health";

// ── os knobs (settings.yaml → health:) ────────────────────────────────────────────────────────────────

/**
 * O bloco `health:` do settings.yaml por cima dos defaults do código. Passa pelo chokepoint de parse de YAML
 * (frontmatter.ts): este módulo não importa js-yaml. Arquivo ausente, ilegível ou sem o bloco ⇒ defaults — o relatório
 * funciona numa instalação que nunca ouviu falar de `health:`.
 */
export function readHealthSettings(file: string = settingsPath()): HealthSettings {
  try {
    return coerceHealthSettings(parseYamlMap(readFileSync(file, "utf8"), "settings.yaml").health);
  } catch {
    return DEFAULT_HEALTH_SETTINGS;
  }
}

// ── o ledger (health.jsonl, anexar-apenas, retenção por dias) ─────────────────────────────────────────

export function healthLedgerPath(): string {
  return path.join(runnerStateDir(), "health.jsonl");
}

export interface HealthLedger {
  /** as leituras gravadas, da mais antiga para a mais nova. Linha quebrada é pulada. */
  read(): Promise<HealthRecord[]>;
  append(record: HealthRecord): Promise<void>;
  /** descarta o que passou da retenção. Só reescreve o arquivo quando há muito a descartar (≥ 1 dia além da retenção). */
  prune(now: number, retentionDays: number): Promise<void>;
}

const DAY_MS = 86_400_000;

function parseRecords(raw: string): HealthRecord[] {
  const out: HealthRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as HealthRecord;
      if (rec && rec.v === 1 && typeof rec.at === "string" && rec.signals && typeof rec.signals === "object") out.push(rec);
    } catch {
      /* linha parcial de uma escrita interrompida — o ledger é append-only */
    }
  }
  return out;
}

/** Quantos bytes do FIM do arquivo bastam para achar a última leitura (uma leitura tem ~3 KB). */
const TAIL_BYTES = 64 * 1024;

/**
 * A ÚLTIMA leitura gravada, lida só do fim do arquivo — a tela de /processes a pede a cada visita, e o ledger de 7 dias
 * passa de uma dezena de MB: parsear tudo para olhar uma linha seria o custo errado. Linha cortada no começo do trecho
 * (o corte cai no meio de uma linha) é pulada pelo mesmo leitor tolerante. Arquivo ausente ou ilegível ⇒ `null`.
 */
export async function readLastHealthRecord(file: string = healthLedgerPath()): Promise<HealthRecord | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const records = parseRecords(buffer.toString("utf8"));
    return records[records.length - 1] ?? null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function diskHealthLedger(file: string = healthLedgerPath()): HealthLedger {
  return {
    async read() {
      return parseRecords(await fsp.readFile(file, "utf8").catch(() => ""));
    },
    async append(record) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    },
    async prune(now, retentionDays) {
      const records = parseRecords(await fsp.readFile(file, "utf8").catch(() => ""));
      const oldest = records[0] ? Date.parse(records[0].at) : NaN;
      // Reescrever a cada tick custaria o arquivo inteiro 288 vezes por dia; com a folga de 1 dia é uma por dia.
      if (!Number.isFinite(oldest) || now - oldest <= (retentionDays + 1) * DAY_MS) return;
      const keep = records.filter((r) => now - Date.parse(r.at) <= retentionDays * DAY_MS);
      await atomicWriteFile(file, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
    },
  };
}

// ── o card [saude:<id>] ──────────────────────────────────────────────────────────────────────────────

/** O rótulo estável do card de um sinal — a CHAVE de dedup (o título é de quem cuida do card). */
export const healthCardLabel = (id: HealthSignalId): string => `saude:${id}`;

/** O prefixo do título com que o card nasce; só serve de chave para card antigo, criado sem o rótulo. */
export const healthCardPrefix = (id: HealthSignalId): string => `[${healthCardLabel(id)}]`;

/**
 * Este card é o do sinal? Pelo rótulo `saude:<id>`: o enriquecer reescreve título «de mecanismo» para o desfecho, o
 * condutor edita o título e o dono pode renomear — justo enquanto o card é consertado, quando o sinal segue vermelho, o
 * dedup pelo título deixava nascer um segundo. O prefixo do título fica só para o card sem rótulo. PURA.
 */
export function isHealthCardOf(card: Pick<Card, "title" | "labels">, id: HealthSignalId): boolean {
  return card.labels?.includes(healthCardLabel(id)) || card.title.startsWith(healthCardPrefix(id));
}

/** O corpo do card: o sinal, o número, o limiar, a evidência e o primeiro passo. PURA. */
export function healthCardBody(signal: HealthSignal, report: Pick<HealthReport, "at">): string {
  return [
    `## Sinal de saúde vermelho: ${signal.label}`,
    "",
    `- Sinal: ${signal.id} (${signal.label})`,
    `- Medido: ${signal.value ?? "não medível"} ${signal.unit} — ${signal.detail}`,
    `- Regra: ${signal.rule}`,
    `- Visto vermelho em leituras seguidas; última leitura em ${report.at}`,
    `- Evidência: ${signal.evidence.length ? signal.evidence.join(", ") : "—"}`,
    "",
    "## O que tentar primeiro",
    "",
    signal.fixHint,
    "",
    "## Prova esperada",
    "",
    `Preencher ao pegar o card: o valor-alvo de ${signal.id} e os cards do produto que devem andar. O card só fecha com o recibo do release (tag e sha reais) e o delta medido.`,
    "",
    "O dono não foi chamado: é trabalho técnico da ferramenta.",
  ].join("\n");
}

/**
 * Cria o card do sinal na Triagem do board da ferramenta — a menos que já haja um ABERTO (status não terminal) do sinal
 * (`exists`), ou que o episódio vermelho atual já tenha o seu card, mesmo fechado (`coveredBy` ⇒ `covered`). Tudo dentro
 * da trava de criação do board. Sem coluna de entrada o card não tem onde pousar: não cria.
 */
export async function upsertHealthCard(
  board: string,
  signal: HealthSignal,
  report: HealthReport,
  opts: { coveredBy?: string | null } = {},
): Promise<HealthCardOutcome> {
  return withCreateLock(board, async () => {
    const [config, cards] = await Promise.all([readBoardConfig(board), readCards(board)]);
    const staging = config.statuses.find((s) => s.staging)?.id ?? null;
    if (!staging) return { outcome: "skipped", reason: `o board «${board}» não tem coluna de entrada (Triagem) para receber o card` };
    const terminal = new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id));
    const open = cards.find((c) => isHealthCardOf(c, signal.id) && !(c.status && terminal.has(c.status)));
    if (open) return { outcome: "exists", cardId: open.id };
    if (opts.coveredBy) return { outcome: "covered", cardId: opts.coveredBy };
    const draft = makeDraftCard({ type: "story", title: `${healthCardPrefix(signal.id)} ${signal.label}`, status: staging, cards });
    const card: Card = { ...draft, storyType: "technical", via: "triage", labels: ["saude", healthCardLabel(signal.id)], body: healthCardBody(signal, report) };
    await writeCard(board, card);
    return { outcome: "created", cardId: card.id };
  });
}

// ── o tick ───────────────────────────────────────────────────────────────────────────────────────────

export interface HealthTickDeps {
  settings(): HealthSettings;
  /** lê o disco e mede. */
  measure(now: number, settings: HealthSettings): Promise<HealthReport>;
  ledger: HealthLedger;
  selfBoard(): string | null;
  upsertCard(board: string, signal: HealthSignal, report: HealthReport, opts: { coveredBy: string | null }): Promise<HealthCardOutcome>;
  log(line: string): void;
}

export interface HealthTickResult {
  report: HealthReport;
  record: HealthRecord;
  /** os sinais vermelhos em sequência — os que pediram card neste tick. */
  due: HealthSignalId[];
  cards: Partial<Record<HealthSignalId, HealthCardOutcome>>;
}

const OUTCOME_VERB = { created: "criado", exists: "existente", covered: "já coberto (fechado; um novo só depois de o sinal sair do vermelho)" } as const;

const outcomeText = (o: HealthCardOutcome | undefined): string =>
  !o ? "" : o.outcome === "skipped" ? `não criado: ${o.reason}` : `${OUTCOME_VERB[o.outcome]}: ${o.cardId}`;

/**
 * UM tick: mede, anexa a leitura e abre o card dos sinais vermelhos em sequência. Nunca lança por causa de um card (o
 * porquê vai para a linha do ledger): o timer não pode morrer por uma escrita que falhou.
 *
 * A regra «vermelho em N leituras» e o card do episódio (`episodeCover`) olham as leituras ANTERIORES (lidas antes de
 * anexar esta) mais a de agora.
 */
export async function runHealthTick(deps: HealthTickDeps, now: number = Date.now()): Promise<HealthTickResult> {
  const settings = deps.settings();
  const report = await deps.measure(now, settings);
  const history = await deps.ledger.read().catch(() => []);
  const due = redStreaks(history, report, settings);

  const cards: HealthTickResult["cards"] = {};
  if (due.length) {
    const board = deps.selfBoard();
    for (const s of due) {
      if (!board) {
        cards[s.id] = { outcome: "skipped", reason: "sem board da ferramenta: declare AGILEHARNESS_SELF_BOARD para os cards [saude:*] nascerem" };
        continue;
      }
      cards[s.id] = await deps
        .upsertCard(board, s, report, { coveredBy: episodeCover(history, s.id) })
        .catch((err): HealthCardOutcome => ({ outcome: "skipped", reason: `falha ao gravar o card: ${err instanceof Error ? err.message : String(err)}` }));
    }
  }

  const record = toHealthRecord(report, cards);
  await deps.ledger.append(record).catch((err) => deps.log(`não consegui anexar a leitura ao health.jsonl: ${err instanceof Error ? err.message : err}`));
  await deps.ledger.prune(now, settings.retentionDays).catch(() => {});

  // Só fala quando algo MUDOU: criar um card, ou um desfecho novo (a mesma recusa a cada 5 min seria ruído).
  const before = history[history.length - 1]?.cards ?? {};
  for (const [id, outcome] of Object.entries(cards) as Array<[HealthSignalId, HealthCardOutcome]>) {
    const text = outcomeText(outcome);
    if (outcome.outcome === "created" || outcomeText(before[id]) !== text) deps.log(`${id}: ${text}`);
  }
  return { report, record, due: due.map((s) => s.id), cards };
}

export function defaultHealthTickDeps(): HealthTickDeps {
  return {
    settings: readHealthSettings,
    // Import dinâmico: o coletor puxa o Inbox, o engine e o tmux — o tick só paga por isso quando mede.
    measure: async (now, settings) => {
      const { collectHealthInputs } = await import("./health-collect");
      return computeHealth(await collectHealthInputs(now, { attributionWindowHours: settings.thresholds.s11.windowHours }), settings.thresholds);
    },
    ledger: diskHealthLedger(),
    selfBoard: () => selfBoardId(),
    upsertCard: upsertHealthCard,
    log: (line) => console.log(`[health] ${line}`),
  };
}

// ── o disparo (instrumentation.ts) ───────────────────────────────────────────────────────────────────

/** O intervalo do timer, em ms; 0 = desligado (`health.tickMinutes: 0` no settings). */
export function healthTickIntervalMs(settings: HealthSettings = readHealthSettings()): number {
  return settings.tickMinutes * 60_000;
}

const RUNNING_KEY = Symbol.for("agileharness.health.running");

/**
 * Um tick com os deps de produção, sem sobrepor outro em andamento (a leitura leva segundos e o timer não espera).
 * Devolve `null` quando já há um rodando. Quem chama (o timer) trata o erro; aqui ele sobe.
 */
export async function maybeRecordHealth(now: number = Date.now()): Promise<HealthTickResult | null> {
  const store = globalThis as unknown as { [RUNNING_KEY]?: boolean };
  if (store[RUNNING_KEY]) return null;
  store[RUNNING_KEY] = true;
  try {
    return await runHealthTick(defaultHealthTickDeps(), now);
  } finally {
    store[RUNNING_KEY] = false;
  }
}

/**
 * A medida de AGORA com os deps de produção, sem gravar nada — o que uma tool de leitura (`ah_health`) devolve. Com
 * `board`, mede só a fatia daquele board (health-scope.ts); sem ele, a instalação inteira — a mesma medida do tick.
 */
export async function measureHealthNow(now: number = Date.now(), opts: { board?: string } = {}): Promise<HealthReport> {
  if (!opts.board) {
    const deps = defaultHealthTickDeps();
    return deps.measure(now, deps.settings());
  }
  const settings = readHealthSettings();
  const { collectHealthInputs } = await import("./health-collect");
  const inputs = await collectHealthInputs(now, { attributionWindowHours: settings.thresholds.s11.windowHours });
  return computeHealth(scopeHealthInputs(inputs, opts.board), settings.thresholds);
}

