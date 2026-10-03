// O LEDGER das decisões que o SISTEMA tomou em nome do dono (política só-negócio) — só-de-acréscimo, JSONL, em
// storymap/.runner/system-decisions.jsonl. O modelo e a projeção são puros (system-decisions.ts); aqui é só o disco.
//
// A mesma disciplina do ledger de transições (transitions.ts), pelos mesmos motivos:
//   • FAIL-OPEN: um append que falha AVISA e nunca lança — a decisão do sistema já aconteceu no card; perder a linha do
//     registro é pior que nada, mas derrubar quem decidiu seria pior ainda;
//   • SERIALIZADO: os appends encadeiam numa corrente só, então duas linhas nunca se misturam;
//   • leitura TOLERANTE (linha torta é pulada) e LIMITADO: acima do teto, a compactação guarda os últimos 180 dias —
//     um «Desfazer» de meses atrás já não teria o que desfazer;
//   • sob o vitest o sink padrão é no-op (um teste de ação não suja o ledger); o teste do ledger injeta o seu.

import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { systemDecisionsPath } from "@/lib/storymap/paths";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { signalInboxChanged } from "@/lib/notifications/server/inbox-bus";

const MAX_LINES = 20_000;
const TRIM_EVERY = 500;
const KEEP_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

export interface SystemDecisionSink {
  append(line: string): Promise<void>;
}

function fileSink(): SystemDecisionSink {
  let sinceTrim = 0;
  return {
    async append(line: string): Promise<void> {
      if (process.env.VITEST) return;
      const file = systemDecisionsPath();
      await fsp.appendFile(file, line, "utf8");
      if (++sinceTrim >= TRIM_EVERY) {
        sinceTrim = 0;
        const raw = await fsp.readFile(file, "utf8").catch(() => "");
        const lines = raw.split("\n").filter((l) => l.trim());
        if (lines.length > MAX_LINES) {
          const cutoff = new Date(Date.now() - KEEP_WINDOW_MS).toISOString();
          const kept = parseSystemDecisionLines(raw).filter((e) => e.at >= cutoff).slice(-MAX_LINES);
          await fsp.writeFile(file, kept.map(serializeSystemDecision).join(""), "utf8");
        }
      }
    },
  };
}

let sink: SystemDecisionSink = fileSink();
let writeChain: Promise<void> = Promise.resolve();

/** TEST SEAM — troca o destino dos appends; devolva com {@link resetSystemDecisionSink}. */
export function setSystemDecisionSink(s: SystemDecisionSink): void {
  sink = s;
}
export function resetSystemDecisionSink(): void {
  sink = fileSink();
}

/** Um id novo de decisão (`sd-<uuid>`). */
export function newSystemDecisionId(): string {
  return `sd-${randomUUID()}`;
}

/** Uma linha do ledger. PURA. */
export function serializeSystemDecision(e: SystemDecision): string {
  return `${JSON.stringify(e)}\n`;
}

/** Acrescenta UMA decisão. Nunca rejeita (a falha é avisada e engolida); encadeia no append anterior. */
export function appendSystemDecision(e: SystemDecision): Promise<void> {
  const line = serializeSystemDecision(e);
  writeChain = writeChain
    .then(() => sink.append(line))
    // a decisão do sistema entra em Acompanhar/«Resolvido hoje» — o Inbox do board relê
    .then(() => signalInboxChanged(e.board, "decision"))
    .catch((err) => {
      console.warn("[system-decisions] append falhou (não-fatal):", err instanceof Error ? err.message : err);
    });
  return writeChain;
}

/** PURA — o JSONL em entradas, tolerante (linha torta pulada), com filtro opcional por board. */
export function parseSystemDecisionLines(raw: string, filter?: { board?: string }): SystemDecision[] {
  const out: SystemDecision[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as SystemDecision;
      if (!e || typeof e.id !== "string" || typeof e.board !== "string" || typeof e.kind !== "string") continue;
      if (filter?.board && e.board !== filter.board) continue;
      out.push(e);
    } catch {
      /* linha parcial/torta — o ledger é só-de-acréscimo e a leitura nunca quebra por ela */
    }
  }
  return out;
}

/** Lê o ledger (ausente ⇒ []). */
export async function readSystemDecisions(filter?: { board?: string }): Promise<SystemDecision[]> {
  const raw = await fsp.readFile(systemDecisionsPath(), "utf8").catch(() => "");
  return parseSystemDecisionLines(raw, filter);
}
