// sentinel-log.ts — o REGISTRO DURÁVEL de cada despertar da Sentinela (append-only JSONL) em
// storymap/.runner/sentinel.jsonl. Uma linha por causa tratada: motivo, o que fez, custo pela diferença, desfecho e, no
// modo conserto, cada comando pedido. É o que o diário de 24 linhas do Jido nunca foi: a trilha que responde «a Sentinela
// acordou por quê, quanto custou e o que mudou» — e a fonte do «um disparo por causa» e do teto diário.
//
// Mesma disciplina do transitions.ts/agent-actions.ts: FAIL-OPEN (uma escrita que falha avisa, nunca lança), SERIALIZADO
// (uma fila só, linhas nunca se intercalam), sink no-op sob vitest (os testes do registro injetam um coletor). A
// leitura é tolerante (linha corrompida é pulada) e LIMITADA ao fim do arquivo (o laço lê o registro a cada varredura).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { SentinelLogEntry } from "./sentinel";

export type AppendSentinelInput = Omit<SentinelLogEntry, "v" | "at"> & { at?: string };

/** Onde mora o registro. */
export function sentinelLogPath(): string {
  return path.join(runnerStateDir(), "sentinel.jsonl");
}

export interface SentinelLogSink {
  append(line: string): Promise<void>;
  read(): Promise<string>;
}

function fileSink(): SentinelLogSink {
  return {
    async append(line) {
      if (process.env.VITEST) return;
      await fsp.appendFile(sentinelLogPath(), line, { encoding: "utf8", mode: 0o600 });
    },
    async read() {
      if (process.env.VITEST) return "";
      return fsp.readFile(sentinelLogPath(), "utf8").catch(() => "");
    },
  };
}

let sink: SentinelLogSink = fileSink();
let writeChain: Promise<void> = Promise.resolve();

/** TEST SEAM — troca o sink. Pareie com {@link resetSentinelLogSink}. */
export function setSentinelLogSink(s: SentinelLogSink): void {
  sink = s;
}
export function resetSentinelLogSink(): void {
  sink = fileSink();
}

/** Grava UMA linha. Nunca rejeita (a falha é avisada e engolida); encadeada para as linhas não se misturarem. */
export function appendSentinelEntry(input: AppendSentinelInput): Promise<void> {
  const rec: SentinelLogEntry = { v: 1, ...input, at: input.at ?? new Date().toISOString() };
  const line = JSON.stringify(rec) + "\n";
  writeChain = writeChain
    .then(() => sink.append(line))
    .catch((err) => console.warn("[sentinel] registro falhou (não-fatal):", err instanceof Error ? err.message : err));
  return writeChain;
}

/** Quantas linhas do fim o laço lê (um dia de despertares cabe com folga; o teto e a janela são de 24h). */
const READ_TAIL_LINES = 2_000;

/** PURA — o JSONL em entradas, tolerante (linha ilegível ou sem forma é pulada). */
export function parseSentinelLog(raw: string): SentinelLogEntry[] {
  const out: SentinelLogEntry[] = [];
  const lines = raw.split("\n").filter((l) => l.trim());
  for (const line of lines.slice(-READ_TAIL_LINES)) {
    try {
      const e = JSON.parse(line) as SentinelLogEntry;
      if (!e || typeof e.causeKey !== "string" || typeof e.board !== "string" || typeof e.at !== "string") continue;
      out.push({ ...e, cardIds: Array.isArray(e.cardIds) ? e.cardIds : [], costUSD: Number.isFinite(e.costUSD) ? e.costUSD : 0 });
    } catch {
      /* linha parcial — pula */
    }
  }
  return out;
}

/** Lê o registro (depois de drenar a fila: o que acabou de ser gravado conta para o «um disparo por causa»). */
export async function readSentinelLog(): Promise<SentinelLogEntry[]> {
  await writeChain;
  return parseSentinelLog(await sink.read().catch(() => ""));
}
