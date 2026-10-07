// signals-deps.ts — o IO do contrato de sinais (signals.ts): roda o comando de cada fonte (SEM shell, com teto), lê os
// agregados, decide a entrada pela regra pura e cria os cards pela MESMA porta do vigia de saúde (`withCreateLock` +
// `makeDraftCard` + `writeCard`: o serviço é o único escritor do board de runtime). Guarda o estado do disjuntor em
// storymap/.runner/signals-state.json e uma linha por leitura em storymap/.runner/signals.jsonl (só agregados).
//
// QUEM CHAMA: a varredura periódica do serviço (o tique do orquestrador, junto da Sentinela), no máximo a cada
// {@link SIGNALS_MIN_INTERVAL_MS}. O veredito depois do deploy é {@link recheckSignalCards}: a MESMA passada o chama para os
// cards de sinal publicados há {@link SIGNAL_RECHECK_AFTER_MS} ou mais e ainda sem veredito (signals.ts
// `dueSignalRechecks`) — sem IA: relê a fonte e escreve «moveu / não moveu / inconclusivo» no card.

import { execFile } from "node:child_process";
import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { makeDraftCard } from "@/lib/storymap/draft";
import { parseYamlMap } from "@/lib/storymap/frontmatter";
import { findRepoRoot, runnerStateDir, settingsPath } from "@/lib/storymap/paths";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import type { Card } from "@/lib/storymap/types";
import { updateCardOnDisk, withCreateLock, writeCard } from "@/lib/storymap/write";
import { sentinelSpawnEnv } from "./sentinel";
import { sanitizeSpawnEnv } from "./spawn-env";
import { evaluateShellGuard } from "./claude-settings";
import {
  afterRead,
  coerceSignalsSettings,
  dueSignalRechecks,
  emptySourceState,
  parseSignalOutput,
  planSignalIntake,
  readSignalMark,
  signalCardBody,
  signalCardLabel,
  signalVerdict,
  verdictSection,
  type SignalReading,
  type SignalSource,
  type SignalsSettings,
  type SignalVerdict,
  type SourceState,
} from "./signals";

/** O bloco `signals:` do settings.yaml do alvo (ausente ⇒ nenhuma fonte). */
export function readSignalsSettings(file: string = settingsPath()): SignalsSettings {
  try {
    return coerceSignalsSettings(parseYamlMap(readFileSync(file, "utf8"), "settings.yaml").signals);
  } catch {
    return coerceSignalsSettings(null);
  }
}

const statePath = () => path.join(runnerStateDir(), "signals-state.json");
const ledgerPath = () => path.join(runnerStateDir(), "signals.jsonl");

async function readState(): Promise<Record<string, SourceState>> {
  try {
    const raw = JSON.parse(await fsp.readFile(statePath(), "utf8")) as Record<string, SourceState>;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Um comando git de leitura no alvo: o código de saída (null = não rodou) e a saída. */
type GitRun = (args: string[]) => Promise<{ code: number | null; stdout: string }>;

const gitRun: GitRun = (args) =>
  new Promise((resolve) => {
    execFile("git", ["-C", findRepoRoot(), ...args], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

/**
 * O `settings.yaml` que declara os COMANDOS das fontes é o que o dono aprovou? O serviço roda esses comandos como ele
 * mesmo, sem nenhum hook no caminho — então um agente que reescrevesse o arquivo plantaria um comando para o serviço rodar
 * sozinho. A régua: rastreado no git ⇒ a cópia de trabalho tem de ser IGUAL ao commit (o que chegou ao commit passou pela
 * pergunta do dono que o trem abre para quem mexe neste arquivo — decision-class.ts `AGENT_CONFIG_PATH`); editado e não
 * commitado ⇒ NADA roda. Fora do git (config local do operador, num alvo que não o versiona) ⇒ confiável. Devolve o motivo
 * da recusa, ou null. Falha ao consultar o git ⇒ recusa (fail-closed).
 */
export async function signalsSettingsRefusal(file: string = settingsPath(), git: GitRun = gitRun): Promise<string | null> {
  const rel = path.relative(findRepoRoot(), file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // fora da árvore do alvo: config do operador
  const tracked = await git(["ls-tree", "--name-only", "HEAD", "--", rel]);
  if (tracked.code !== 0) return "não consegui conferir no git se o settings.yaml é o aprovado — nenhum comando de sinal roda";
  if (!tracked.stdout.trim()) return null; // não versionado: config local do operador
  const diff = await git(["diff", "--quiet", "HEAD", "--", rel]);
  if (diff.code === 0) return null;
  if (diff.code === 1) return "o settings.yaml tem mudança não commitada — os comandos de sinal só rodam como estão no commit (o que o dono aprovou)";
  return "não consegui comparar o settings.yaml com o commit — nenhum comando de sinal roda";
}

/** O argv como uma linha de shell legível (para a trava dura do host avaliar). PURA. */
export function argvAsShellLine(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/**
 * Roda o comando de uma fonte: argv sem shell, cwd na raiz do alvo, ambiente sem credencial MCP, com teto — e só depois de
 * duas conferências: o settings.yaml é o aprovado ({@link signalsSettingsRefusal}) e a trava dura do host não recusa o
 * comando (o serviço roda o argv por fora da tool Bash, então pergunta ao hook ele mesmo). Recusado ⇒ null (uma leitura
 * que falhou: o disjuntor da fonte conta).
 */
export async function runSignalCommand(source: Pick<SignalSource, "command" | "timeoutSeconds"> & { id?: string }): Promise<string | null> {
  const refusal = (await signalsSettingsRefusal().catch(() => "falha ao conferir o settings.yaml")) ?? (await evaluateShellGuard(argvAsShellLine(source.command), { cwd: findRepoRoot() }).then((v) => (v.blocked ? `recusado pela trava dura do host: ${v.reason}` : null)));
  if (refusal) {
    console.warn(`[signals ${source.id ?? "?"}] comando NÃO rodou: ${refusal}`);
    return null;
  }
  return new Promise((resolve) => {
    const [bin, ...args] = source.command;
    execFile(
      bin,
      args,
      { cwd: findRepoRoot(), timeout: source.timeoutSeconds * 1000, maxBuffer: 1024 * 1024, env: sentinelSpawnEnv(sanitizeSpawnEnv(process.env)) },
      (err: Error | null, stdout: string | Buffer) => resolve(err ? null : String(stdout)),
    );
  });
}

export interface SignalSourceReport {
  source: string;
  ok: boolean;
  created: string[];
  skipped: number;
  breaker?: string;
}

/** A capacidade de condutor do board (`conductor.maxSessions`; sem ela, 1). */
function slotsOf(config: { conductor?: { maxSessions?: number } } | null): number {
  const n = config?.conductor?.maxSessions;
  return typeof n === "number" && n > 0 ? n : 1;
}

/** Os cards de sinal ABERTOS de um board (rótulo `sinal`, status não terminal) e os hashes das causas deles. */
function openSignalCardsOf(cards: readonly Card[], terminal: ReadonlySet<string>): { count: number; hashes: Set<string> } {
  const hashes = new Set<string>();
  let count = 0;
  for (const c of cards) {
    if (!c.labels?.includes("sinal") || (c.status && terminal.has(c.status))) continue;
    count++;
    const mark = readSignalMark(c.body);
    if (mark) hashes.add(mark.hash);
  }
  return { count, hashes };
}

/** Lê UMA fonte e cria os cards que a regra manda. Nunca lança. */
export async function intakeSource(
  source: SignalSource,
  settings: SignalsSettings,
  state: SourceState | undefined,
  now: number,
  run: (s: SignalSource) => Promise<string | null> = runSignalCommand,
): Promise<{ report: SignalSourceReport; state: SourceState; reading: SignalReading | null }> {
  const raw = await run(source).catch(() => null);
  const reading = raw == null ? null : parseSignalOutput(source.id, raw);
  if (!reading) {
    const next = afterRead(state, now, { ok: false, newCauses: 0 });
    return { report: { source: source.id, ok: false, created: [], skipped: 0, ...(next.openReason ? { breaker: next.openReason } : {}) }, state: next, reading: null };
  }
  try {
    return await withCreateLock(source.board, async () => {
      const [config, cards] = await Promise.all([readBoardConfig(source.board), readCards(source.board)]);
      const staging = config.statuses.find((s) => s.staging)?.id ?? null;
      const terminal = new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id));
      const open = openSignalCardsOf(cards, terminal);
      const newCauses = reading.causes.filter((c) => !open.hashes.has(c.hash)).length;
      const st = afterRead(state, now, { ok: true, newCauses });
      const plan = planSignalIntake({
        source,
        reading,
        state: st,
        now,
        openCauseHashes: open.hashes,
        openSignalCards: open.count,
        slots: slotsOf(config as { conductor?: { maxSessions?: number } }),
        reserveOwnerPct: settings.reserveOwnerPct,
      });
      const created: string[] = [];
      if (staging) {
        const at = new Date(now).toISOString();
        let all = cards;
        for (const cause of plan.create) {
          const draft = makeDraftCard({ type: "story", title: `[sinal:${source.id}] ${cause.title}`, status: staging, cards: all });
          const card: Card = { ...draft, storyType: "technical", via: "triage", labels: ["sinal", signalCardLabel(source.id, cause.hash)], body: signalCardBody(source, cause, reading, at) };
          await writeCard(source.board, card);
          all = [...all, card];
          created.push(card.id);
        }
      }
      const next = { ...st, createdToday: st.createdToday + created.length };
      return { report: { source: source.id, ok: true, created, skipped: plan.skipped.length, ...(next.openReason ? { breaker: next.openReason } : {}) }, state: next, reading };
    });
  } catch (err) {
    console.warn(`[signals ${source.id}] entrada falhou:`, err instanceof Error ? err.message : err);
    return { report: { source: source.id, ok: false, created: [], skipped: 0 }, state: afterRead(state, now, { ok: false, newCauses: 0 }), reading };
  }
}

/** Uma passada por todas as fontes: lê, cria, grava estado e a linha do registro. Nunca lança. */
export async function runSignalsIntake(now: number = Date.now(), settings: SignalsSettings = readSignalsSettings()): Promise<SignalSourceReport[]> {
  if (settings.sources.length === 0) return [];
  const states = await readState();
  const reports: SignalSourceReport[] = [];
  for (const source of settings.sources) {
    const { report, state, reading } = await intakeSource(source, settings, states[source.id] ?? emptySourceState(now), now);
    states[source.id] = state;
    reports.push(report);
    // só agregados: a chave/contagem de cada causa, nada por pessoa
    const line = { at: new Date(now).toISOString(), source: source.id, ok: report.ok, events: reading?.events ?? null, causes: (reading?.causes ?? []).map((c) => ({ hash: c.hash, count: c.count })), created: report.created };
    await fsp.appendFile(ledgerPath(), JSON.stringify(line) + "\n", "utf8").catch(() => {});
  }
  await atomicWriteFile(statePath(), JSON.stringify(states, null, 2)).catch(() => {});
  // o veredito depois do deploy: os cards de sinal publicados há tempo bastante e ainda sem veredito, board a board
  for (const board of [...new Set(settings.sources.map((s) => s.board))]) {
    try {
      const [config, cards] = await Promise.all([readBoardConfig(board), readCards(board)]);
      const due = dueSignalRechecks(cards, new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id)), now);
      if (due.length) await recheckSignalCards(board, due, runSignalCommand, settings, now);
    } catch (err) {
      console.warn(`[signals ${board}] releitura pós-deploy falhou:`, err instanceof Error ? err.message : err);
    }
  }
  return reports;
}

/** O rótulo do veredito (sem espaço nem acento). */
const VERDICT_SLUG: Record<SignalVerdict, string> = { moveu: "moveu", "não moveu": "nao-moveu", inconclusivo: "inconclusivo" };

/** O intervalo mínimo entre duas passadas (o tique roda mais vezes; uma fonte externa não precisa). */
export const SIGNALS_MIN_INTERVAL_MS = 30 * 60_000;
let lastIntakeAt = 0;

/** A passada, no máximo a cada {@link SIGNALS_MIN_INTERVAL_MS}. Nunca lança. */
export async function maybeRunSignalsIntake(now: number = Date.now()): Promise<SignalSourceReport[] | null> {
  if (now - lastIntakeAt < SIGNALS_MIN_INTERVAL_MS) return null;
  lastIntakeAt = now;
  return runSignalsIntake(now).catch(() => []);
}

/**
 * O VEREDITO depois do deploy, sem IA: para cada card publicado que nasceu de um sinal, relê a MESMA fonte e escreve no
 * card «moveu», «não moveu» ou «inconclusivo». Devolve o veredito por card. Nunca lança.
 */
export async function recheckSignalCards(
  board: string,
  cardIds: readonly string[],
  run: (s: SignalSource) => Promise<string | null> = runSignalCommand,
  settings: SignalsSettings = readSignalsSettings(),
  now: number = Date.now(),
): Promise<Record<string, SignalVerdict>> {
  const out: Record<string, SignalVerdict> = {};
  try {
    const cards = (await readCards(board)).filter((c) => cardIds.includes(c.id));
    const readings = new Map<string, SignalReading | null>();
    for (const card of cards) {
      const mark = readSignalMark(card.body);
      const source = mark ? settings.sources.find((s) => s.id === mark.source) : undefined;
      if (!mark || !source) continue;
      if (!readings.has(source.id)) {
        const raw = await run(source).catch(() => null);
        readings.set(source.id, raw == null ? null : parseSignalOutput(source.id, raw));
      }
      const reading = readings.get(source.id);
      if (!reading) continue;
      const current = reading.causes.find((c) => c.hash === mark.hash)?.count ?? 0;
      const v = signalVerdict({ baseline: mark.baseline, current, minEvents: source.minEvents, eventsBefore: mark.events, eventsAfter: reading.events });
      out[card.id] = v;
      const at = new Date(now).toISOString();
      await updateCardOnDisk(board, card.id, (cur) => ({
        ...cur,
        labels: [...(cur.labels ?? []).filter((l) => !l.startsWith("sinal-veredito:")), `sinal-veredito:${VERDICT_SLUG[v]}`],
        body: `${cur.body ?? ""}\n${verdictSection(v, { baseline: mark.baseline, current, at })}`,
      }));
    }
  } catch (err) {
    console.warn(`[signals ${board}] veredito falhou:`, err instanceof Error ? err.message : err);
  }
  return out;
}
