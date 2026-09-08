// inbox-seen.ts — a MARCA DE VISTO do Inbox: "eu já olhei este, passa para o próximo".
//
// O que "pular" É e o que NÃO é. O Inbox da home é um CARROSSEL: o operador folheia a pilha para ver
// o que está atrás do cartão de cima. Pular avança UMA posição e deixa uma marca de que aquele item
// já passou pelos olhos dele — nada mais. O item **continua na pilha, na contagem e na tela do
// Inbox**: no fim, tudo aqui precisa de resposta, e uma UI que esconde trabalho por um gesto de
// navegação transforma "vou ver o resto" em "some da minha frente".
//
// A marca existe por um motivo só: quando a volta do carrossel trouxer o item de novo, o operador
// reconhece que já leu aquilo e não relê. É informação, nunca filtro.
//
// REGRAS
//   • Nada é escondido, em lugar nenhum. A tela do Inbox (/board/<b>/inbox) ignora este módulo por
//     completo — ela é a lista INTEIRA, sempre.
//   • A marca é presa à ASSINATURA do item: se o pedido MUDA materialmente (mudou de lane/severidade/
//     status, ou o relógio de espera foi recarimbado), você não viu ESTA versão — a marca cai. É o
//     mesmo raciocínio de antes, aplicado a "visto" em vez de "escondido".
//   • A marca não expira por tempo: ela some quando o item é resolvido (o GC contra os vivos) ou
//     quando ele muda. Um "visto" antigo num item parado continua verdadeiro.
//   • IO best-effort (mesma doutrina de orchestrator-state): arquivo ausente/corrompido ⇒ estado
//     vazio ⇒ nada marcado. A falha custa um chip, nunca trabalho invisível.
//
// O núcleo é PURO (sem fs, sem Date.now implícito) — testado em inbox-seen.test.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";

/** O mínimo de um CockpitItem que a assinatura precisa — estrutural de propósito (mantém o módulo
 *  puro e desacoplado da união de kinds em demands.ts). */
export interface SeenableItem {
  id: string;
  kind: string;
  lane: string;
  severity: string;
  status?: string | null;
  since?: string | null;
}

export interface InboxSeenMark {
  /** ISO de quando o operador passou por ele. */
  at: string;
  /** {@link itemSeenSignature} no momento da marca — o que a faz caducar sozinha. */
  sig: string;
}

export interface InboxSeenState {
  v: 1;
  /** itemId → marca. */
  seen: Record<string, InboxSeenMark>;
}

export function emptyInboxSeenState(): InboxSeenState {
  return { v: 1, seen: {} };
}

/**
 * A ASSINATURA material do item: os campos cuja mudança significa "isto virou outro pedido, você
 * ainda não viu ESTE".
 *
 * Deliberadamente NÃO inclui o corpo (prompt/título/snippet): um agente reescrever a redação de um
 * finding não desfaz o fato de o operador já ter lido a demanda. Inclui `since` porque o relógio de
 * espera é recarimbado justamente quando o pedido é renovado. PURA.
 */
export function itemSeenSignature(item: SeenableItem): string {
  return [item.kind, item.lane, item.severity, item.status ?? "", item.since ?? ""].join("|");
}

/** O item já foi visto NESTE estado (id presente E assinatura ainda casando)? PURA. */
export function isSeen(state: InboxSeenState, item: SeenableItem): boolean {
  const mark = state.seen[item.id];
  return !!mark && mark.sig === itemSeenSignature(item);
}

/** Marca UM item como visto (idempotente: re-marcar re-carimba `at`/`sig`). PURA. */
export function markSeen(state: InboxSeenState, item: SeenableItem, nowIso: string): InboxSeenState {
  return {
    ...state,
    seen: { ...state.seen, [item.id]: { at: nowIso, sig: itemSeenSignature(item) } },
  };
}

/** Desfaz a marca de UM item ("ainda não vi isto"). Id ausente ⇒ no-op. PURA. */
export function clearSeen(state: InboxSeenState, itemId: string): InboxSeenState {
  if (state.seen[itemId] === undefined) return state;
  const { [itemId]: _dropped, ...rest } = state.seen;
  return { ...state, seen: rest };
}

/**
 * GC contra os itens VIVOS: cai fora toda marca (a) de item que não existe mais — foi resolvido, a
 * marca não tem mais objeto — ou (b) cuja assinatura mudou — virou outro pedido. Reconstruir a partir
 * dos vivos é o que impede o arquivo de crescer para sempre. PURA.
 */
export function pruneSeen(state: InboxSeenState, live: readonly SeenableItem[]): InboxSeenState {
  const next: Record<string, InboxSeenMark> = {};
  for (const item of live) {
    const mark = state.seen[item.id];
    if (mark && mark.sig === itemSeenSignature(item)) next[item.id] = mark;
  }
  return { v: 1, seen: next };
}

/** Os ids VISTOS entre os itens dados — o que a UI precisa para carimbar o chip. Nada é filtrado
 *  aqui, e é de propósito: este módulo não esconde. PURA. */
export function seenIdsAmong(items: readonly SeenableItem[], state: InboxSeenState): string[] {
  return items.filter((it) => isSeen(state, it)).map((it) => it.id);
}

/** Dois estados carregam a MESMA informação? Evita reescrever o arquivo a cada render (o prune roda
 *  em todo carregamento da home). PURA. */
export function sameSeenState(a: InboxSeenState, b: InboxSeenState): boolean {
  const ka = Object.keys(a.seen);
  const kb = Object.keys(b.seen);
  if (ka.length !== kb.length) return false;
  return ka.every((id) => b.seen[id]?.sig === a.seen[id]?.sig && b.seen[id]?.at === a.seen[id]?.at);
}

/**
 * Coage o JSON persistido. Entradas inválidas são DESCARTADAS, nunca adivinhadas.
 *
 * MIGRAÇÃO: a primeira versão deste arquivo chamava a marca de `skips` (quando pular ESCONDIA o
 * item). O formato é idêntico — o que mudou foi o significado —, então uma chave `skips` legada é
 * lida como `seen`. Sem isso, o operador que já pulou coisas veria todas de novo como não-vistas: um
 * dano pequeno, mas gratuito. PURA.
 */
export function coerceInboxSeenState(raw: unknown): InboxSeenState {
  const out = emptyInboxSeenState();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as { seen?: unknown; skips?: unknown };
  const marks = o.seen && typeof o.seen === "object" ? o.seen : o.skips;
  if (!marks || typeof marks !== "object") return out;
  for (const [id, value] of Object.entries(marks as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { at, sig } = value as { at?: unknown; sig?: unknown };
    if (typeof at === "string" && at && typeof sig === "string") out.seen[id] = { at, sig };
  }
  return out;
}

// ── IO (best-effort, fail-open) ──────────────────────────────────────────────────────────────────

function seenPath(board: string): string {
  return path.join(runnerStateDir(), "inbox", `${board.replace(/[^a-z0-9_-]/gi, "")}.json`);
}

/** Lê as marcas do board. Ausente/corrompido ⇒ estado vazio. Nunca lança. */
export async function readInboxSeen(board: string): Promise<InboxSeenState> {
  try {
    return coerceInboxSeenState(JSON.parse(await fs.readFile(seenPath(board), "utf8")));
  } catch {
    return emptyInboxSeenState();
  }
}

/** Persiste as marcas do board. Falha de escrita é engolida (logada) — nunca lança. */
export async function writeInboxSeen(board: string, state: InboxSeenState): Promise<void> {
  try {
    const p = seenPath(board);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error(`[inbox-seen ${board}] write falhou:`, err instanceof Error ? err.message : err);
  }
}
