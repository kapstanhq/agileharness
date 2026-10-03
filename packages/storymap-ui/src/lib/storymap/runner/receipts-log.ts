// O LEDGER dos RECIBOS do Inbox (onda 2, passo 5) — só-de-acréscimo, JSONL, em storymap/.runner/inbox-receipts.jsonl.
// O modelo e a projeção são puros (inbox/receipts.ts); aqui é só o disco. A mesma disciplina do ledger das decisões do
// sistema (decision-log.ts): append que falha AVISA e nunca lança (a ação do dono já aconteceu no card), appends
// serializados, leitura tolerante, e limitado — um recibo só serve ao «Resolvido hoje» e à página de um item que sumiu,
// então a compactação guarda 90 dias. Sob o vitest o sink padrão é no-op; o teste do ledger injeta o seu.

import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { inboxReceiptsPath } from "@/lib/storymap/paths";
import type { InboxReceiptRecord } from "@/lib/storymap/inbox/receipts";
import { signalInboxChanged } from "@/lib/notifications/server/inbox-bus";

const MAX_LINES = 5_000;
const TRIM_EVERY = 200;
const KEEP_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface InboxReceiptSink {
  append(line: string): Promise<void>;
}

function fileSink(): InboxReceiptSink {
  let sinceTrim = 0;
  return {
    async append(line: string): Promise<void> {
      if (process.env.VITEST) return;
      const file = inboxReceiptsPath();
      await fsp.appendFile(file, line, "utf8");
      if (++sinceTrim >= TRIM_EVERY) {
        sinceTrim = 0;
        const raw = await fsp.readFile(file, "utf8").catch(() => "");
        if (raw.split("\n").filter((l) => l.trim()).length > MAX_LINES) {
          const cutoff = new Date(Date.now() - KEEP_WINDOW_MS).toISOString();
          const kept = parseInboxReceiptLines(raw).filter((r) => r.at >= cutoff).slice(-MAX_LINES);
          await fsp.writeFile(file, kept.map(serializeInboxReceipt).join(""), "utf8");
        }
      }
    },
  };
}

let sink: InboxReceiptSink = fileSink();
let writeChain: Promise<void> = Promise.resolve();

/** TEST SEAM — troca o destino dos appends; devolva com {@link resetInboxReceiptSink}. */
export function setInboxReceiptSink(s: InboxReceiptSink): void {
  sink = s;
}
export function resetInboxReceiptSink(): void {
  sink = fileSink();
}

/** Um id novo de recibo (`rc-<uuid>`). */
export function newInboxReceiptId(): string {
  return `rc-${randomUUID()}`;
}

/** Uma linha do ledger. PURA. */
export function serializeInboxReceipt(r: InboxReceiptRecord): string {
  return `${JSON.stringify(r)}\n`;
}

/** Acrescenta UM recibo. Nunca rejeita (a falha é avisada e engolida); encadeia no append anterior. */
export function appendInboxReceipt(r: InboxReceiptRecord): Promise<void> {
  const line = serializeInboxReceipt(r);
  writeChain = writeChain
    .then(() => sink.append(line))
    // o recibo entra em «Resolvido hoje» — nas outras abas do dono também
    .then(() => signalInboxChanged(r.board, "receipt"))
    .catch((err) => {
      console.warn("[inbox-receipts] append falhou (não-fatal):", err instanceof Error ? err.message : err);
    });
  return writeChain;
}

/** PURA — o JSONL em recibos, tolerante (linha torta pulada), com filtro opcional por board. */
export function parseInboxReceiptLines(raw: string, filter?: { board?: string }): InboxReceiptRecord[] {
  const out: InboxReceiptRecord[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as InboxReceiptRecord;
      if (!r || typeof r.id !== "string" || typeof r.board !== "string" || typeof r.at !== "string" || typeof r.itemId !== "string") continue;
      if (filter?.board && r.board !== filter.board) continue;
      out.push(r);
    } catch {
      /* linha parcial/torta — o ledger é só-de-acréscimo e a leitura nunca quebra por ela */
    }
  }
  return out;
}

/** Lê o ledger (ausente ⇒ []). */
export async function readInboxReceipts(filter?: { board?: string }): Promise<InboxReceiptRecord[]> {
  const raw = await fsp.readFile(inboxReceiptsPath(), "utf8").catch(() => "");
  return parseInboxReceiptLines(raw, filter);
}
