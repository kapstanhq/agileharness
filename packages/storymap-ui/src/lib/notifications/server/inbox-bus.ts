// inbox-bus — o evento `inbox.changed` (onda 2, passo 8): «o Inbox deste board pode ter mudado; releia».
//
// A lista e o número do Inbox só se atualizavam por DOIS caminhos: a escrita de um card .md (o watcher do fs) e um
// poll de 60 s. Mas metade dos itens nasce FORA dos cards: a proposta de PRD e o pedido de um agente são sidecars, a
// decisão do sistema e o recibo do dono são ledgers do runner, a integração que falhou mora na fila do train, a
// execução parada vem da telemetria. Uma decisão nova podia ficar um minuto invisível — ou para sempre, sem o poll.
//
// Agora cada produtor desses sinaliza o board, e o barramento:
//   • COALESCE por board (uma rajada de escritas vira UM evento, com as causas juntas);
//   • não arma timer nenhum sem ouvinte (um teste que grava um ledger não deixa nada pendurado);
//   • é process-global (sobrevive ao HMR) e best-effort: sinalizar nunca derruba quem escreveu.
// A rota SSE (/api/notifications/stream) entrega `event: inbox.changed` a cada navegador; a tela recarrega só quando o
// board do evento é um que ela mostra. `board: null` = o host inteiro (o medidor de cota, que vale para todo board).

export type InboxChangeCause = "card" | "board" | "sidecar" | "decision" | "receipt" | "merge-queue" | "runner" | "telemetry";

export interface InboxChanged {
  /** o board cujo Inbox pode ter mudado; null = todos (um fato do host). */
  board: string | null;
  causes: InboxChangeCause[];
  at: number;
}

type Sink = (e: InboxChanged) => void;

interface Bus {
  sinks: Set<Sink>;
  pending: Map<string, { causes: Set<InboxChangeCause>; timer: ReturnType<typeof setTimeout> }>;
  /** a última assinatura por board do que o runner e o train dizem (só o que muda o Inbox). */
  runnerSig: Map<string, string>;
  mergeSig: Map<string, string>;
  started: boolean;
}

const KEY = Symbol.for("storymap.notifications.inboxBus");
const store = globalThis as unknown as { [KEY]?: Bus };

function bus(): Bus {
  return (store[KEY] ??= { sinks: new Set(), pending: new Map(), runnerSig: new Map(), mergeSig: new Map(), started: false });
}

/** TEST SEAM — esvazia o barramento (ouvintes, pendências e o «já ligado» dos produtores de memória). */
export function resetInboxBus(): void {
  const b = bus();
  for (const p of b.pending.values()) clearTimeout(p.timer);
  b.sinks.clear();
  b.pending.clear();
  b.runnerSig = new Map();
  b.mergeSig = new Map();
  b.started = false;
}

/** A janela de coalescência: uma rajada de escritas do mesmo board vira UM evento. */
export const INBOX_COALESCE_MS = 250;

/** Assina o barramento (a rota SSE faz isto por conexão). Devolve o cancelador. */
export function subscribeInboxChanged(fn: Sink): () => void {
  const b = bus();
  b.sinks.add(fn);
  return () => b.sinks.delete(fn);
}

function flush(key: string): void {
  const b = bus();
  const p = b.pending.get(key);
  if (!p) return;
  b.pending.delete(key);
  const event: InboxChanged = { board: key === "*" ? null : key, causes: [...p.causes].sort(), at: Date.now() };
  for (const fn of [...b.sinks]) {
    try {
      fn(event);
    } catch {
      b.sinks.delete(fn); // stream fechado — sai do laço
    }
  }
}

/** «O Inbox deste board pode ter mudado.» Síncrono, nunca lança; sem ouvinte, não faz nada. */
export function signalInboxChanged(board: string | null, cause: InboxChangeCause): void {
  try {
    const b = bus();
    if (b.sinks.size === 0) return;
    const key = board ?? "*";
    const p = b.pending.get(key);
    if (p) {
      p.causes.add(cause);
      return;
    }
    b.pending.set(key, { causes: new Set([cause]), timer: setTimeout(() => flush(key), INBOX_COALESCE_MS) });
  } catch {
    /* best-effort: quem escreveu nunca paga pelo aviso */
  }
}

/**
 * As assinaturas por board do que o Inbox lê de um retrato: cada board com a lista (ordenada) das chaves que importam.
 * O retrato do runner e o da fila chegam INTEIROS a cada mudança; comparar por board é o que evita recarregar os cinco
 * Inboxes quando só um card de um board mudou de passo na fila. PURA.
 */
export function signaturesByBoard<T extends { board: string }>(rows: readonly T[], key: (r: T) => string): Map<string, string> {
  const byBoard = new Map<string, string[]>();
  for (const r of rows) {
    const list = byBoard.get(r.board) ?? [];
    list.push(key(r));
    byBoard.set(r.board, list);
  }
  return new Map([...byBoard].map(([board, keys]) => [board, keys.sort().join("|")]));
}

/** Os boards cuja assinatura mudou (inclusive os que apareceram ou sumiram). PURA. */
export function changedBoards(prev: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const [b, sig] of next) if (prev.get(b) !== sig) out.add(b);
  for (const b of prev.keys()) if (!next.has(b)) out.add(b);
  return [...out].sort();
}

/** O que o runner publica e o Inbox lê: as falhas (a execução parada) por board. */
export interface RunnerLike {
  subscribe(fn: (s: { failures: Array<{ board: string; cardId: string; trigger?: string; reason?: string }> }) => void): () => void;
  subscribeMergeQueue(fn: (s: { entries: Array<{ board: string; cardId?: string; runId: string; status: string }> }) => void): () => void;
}

/**
 * Liga os produtores que moram na MEMÓRIA do processo (as falhas do runner e a fila do train) ao barramento —
 * idempotente, uma vez por processo. Os outros produtores (o watcher dos boards, os ledgers, a telemetria) sinalizam
 * direto de onde escrevem.
 */
export function startInboxSignals(registry: RunnerLike): void {
  const b = bus();
  if (b.started) return;
  b.started = true;
  registry.subscribe((snap) => {
    const next = signaturesByBoard(snap.failures ?? [], (f) => `${f.cardId}:${f.trigger ?? ""}:${f.reason ?? ""}`);
    for (const board of changedBoards(b.runnerSig, next)) signalInboxChanged(board, "runner");
    b.runnerSig = next;
  });
  registry.subscribeMergeQueue((snap) => {
    const next = signaturesByBoard(snap.entries ?? [], (e) => `${e.runId}:${e.cardId ?? ""}:${e.status}`);
    for (const board of changedBoards(b.mergeSig, next)) signalInboxChanged(board, "merge-queue");
    b.mergeSig = next;
  });
}
