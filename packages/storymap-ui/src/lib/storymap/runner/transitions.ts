// WS2 — WRITERS-ONLY durable ledger of card status transitions (append-only JSONL) at
// storymap/.runner/transitions.jsonl. Honest history: every from→to hop with WHO caused it — a human move,
// the cascade, the merge-back, a run's advance, or a system auto-enter-terminal. The card panel's
// retroactive-✓ pipeline (WS5) reads this instead of guessing from array position.
//
// FAIL-OPEN: an append failure WARNS, never throws into the caller — moveCardAction, forward()'s
// lock-scoped try, and the engine's child `close` handler must never break because the ledger couldn't
// write (mirrors telemetry.recordRun's discipline). SERIALIZED: appends chain onto a single writeChain so
// concurrent writers never interleave a partial line. Reading (readTransitions) is a separate, tolerant
// concern (per-line safeParse) — a corrupt line is skipped, never fatal.

import { promises as fsp } from "node:fs";
import { transitionsPath } from "@/lib/storymap/paths";

export const TRANSITIONS_VERSION = 1;

/**
 * Who caused a transition. `run:<trigger>` names the skill that advanced the card on settle. Fase 6 — um agente pelo MCP
 * grava o seu PAPEL (mcp/actor.ts `actorRole`): `conductor:<card>`, `sentinel`, `chat`, `proxy`, `critic`,
 * `external:<nome>`, `session:<nome>`. `run:orch` só existe nas linhas antigas (todo agente era ele).
 */
export type TransitionActor =
  | "human"
  | "cascade"
  | "system"
  | "merge"
  | "sentinel"
  | "chat"
  | "proxy"
  | "critic"
  | `run:${string}`
  | `conductor:${string}`
  | `external:${string}`
  | `session:${string}`;

/** O salto foi de um AGENTE (não do dono, nem do motor)? Inclui o legado `run:orch`. PURA. */
export function isAgentTransitionActor(actor: string): boolean {
  return (
    actor === "sentinel" ||
    actor === "chat" ||
    actor === "proxy" ||
    actor === "critic" ||
    actor === "run:orch" ||
    actor.startsWith("conductor:") ||
    actor.startsWith("external:") ||
    actor.startsWith("session:")
  );
}

export interface Transition {
  v: number;
  /** ISO timestamp of the transition. */
  at: string;
  board: string;
  cardId: string;
  /** the status left (null when unknown / first observation). */
  from: string | null;
  /** the status entered. */
  to: string;
  actor: TransitionActor;
  /** the run/session id (== branch run/<id>) when a run/merge caused it. */
  runId?: string;
  /** free-form context (e.g. "reopen:fix"). */
  note?: string;
}

export interface AppendTransitionInput {
  board: string;
  cardId: string;
  from: string | null;
  to: string;
  actor: TransitionActor;
  runId?: string;
  note?: string;
}

/** Injectable persist port — tests swap it for an in-memory collector; prod appends to the JSONL file. */
export interface TransitionSink {
  append(line: string): Promise<void>;
}

/** Keep the ledger bounded. MAX_LINES is now a GATE (not the post-compaction size): when the file grows past
 *  it, compactTransitions() runs CARD-SCOPED retention (last N per card + last 30 days) — so after a compaction
 *  the file may still sit near MAX_LINES if many cards are live inside the window. That is intended (the 30-day
 *  history is kept regardless); do NOT "fix" it back to a blind slice. TRIM_EVERY gates HOW OFTEN we attempt a
 *  compaction (every N appends) to keep the amortized append O(1). */
const MAX_LINES = 20_000;
const TRIM_EVERY = 1_000;
/** 6.2 — card-scoped retention knobs: keep the last N hops of EVERY card PLUS everything from the last 30 days. */
const KEEP_PER_CARD = 50;
const KEEP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function fileSink(): TransitionSink {
  let sinceTrim = 0;
  return {
    async append(line: string): Promise<void> {
      // Under vitest the DEFAULT sink is a no-op so an engine/autorun test firing appendTransition doesn't
      // churn the gitignored ledger file. The writer's OWN tests inject a collector sink (setTransitionSink),
      // so they bypass this guard and still assert the payload.
      if (process.env.VITEST) return;
      const file = transitionsPath();
      await fsp.appendFile(file, line, "utf8");
      if (++sinceTrim >= TRIM_EVERY) {
        sinceTrim = 0;
        // 6.2 — best-effort CARD-SCOPED compaction: read, keep last-N-per-card + last-30-days, rewrite. Only
        // when the file exceeds the cap (so append stays O(1) amortized). Replaces the old blind slice, which
        // could evict a quiet board's live-card history when a noisy board flooded the shared file. A failure
        // here is swallowed by the caller's fail-open catch — an over-long ledger is never worse than a throw.
        const raw = await fsp.readFile(file, "utf8").catch(() => "");
        const lines = raw.split("\n").filter((l) => l.trim());
        if (lines.length > MAX_LINES) {
          await fsp.writeFile(file, compactTransitions(raw, { now: Date.now() }), "utf8");
        }
      }
    },
  };
}

let sink: TransitionSink = fileSink();
let writeChain: Promise<void> = Promise.resolve();

/** TEST SEAM — swap the persist port. Returns nothing; pair with resetTransitionSink() in afterEach. */
export function setTransitionSink(s: TransitionSink): void {
  sink = s;
}
/** TEST SEAM — restore the production file sink. */
export function resetTransitionSink(): void {
  sink = fileSink();
}

/**
 * Append ONE transition. Fire-and-forget from the caller's perspective (they may `void` it): the returned
 * promise resolves after the serialized write, and NEVER rejects (a failure is warned + swallowed). Chains
 * onto the previous append so lines can't interleave.
 */
export function appendTransition(input: AppendTransitionInput): Promise<void> {
  const rec: Transition = { v: TRANSITIONS_VERSION, at: new Date().toISOString(), ...input };
  const line = JSON.stringify(rec) + "\n";
  writeChain = writeChain.then(() => sink.append(line)).catch((err) => {
    console.warn("[transitions] append falhou (não-fatal):", err instanceof Error ? err.message : err);
  });
  return writeChain;
}

/**
 * Read the ledger (tolerant, per-line safeParse — a corrupt line is skipped). Optional filter by card/board.
 * Returns [] when the file is absent. Reading is advisory display data (WS5), never a gate.
 */
export async function readTransitions(filter?: { cardId?: string; board?: string }): Promise<Transition[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(transitionsPath(), "utf8");
  } catch {
    return [];
  }
  return parseTransitionsLines(raw, filter);
}

// ── o ledger NUNCA fica atrás do arquivo do card — e NUNCA legitima uma regressão ─────────────────────────────
//
// Toda mudança de status que passa pelo moveCard grava o seu salto. Mas o arquivo do card também muda de status por
// caminhos que NÃO são o moveCard — o merge-back do train é o principal (o card do run aterrissa em main com o status
// que o run deixou, ou com o de main quando main o moveu depois do corte) — e aí o ledger ficava atrás.
//
// A régua tem DOIS lados, e o segundo é o que importa. Quem aterrissa só grava o salto quando a divergência NASCEU
// desta aterrissagem: (1) ela MUDOU o status (antes ≠ depois), ou (2) o último salto é o settle otimista DESTE run
// (`run:*` com o mesmo runId) — o run disse X, main tinha movido o card e venceu. Fora disso a divergência é ANTERIOR, e
// não dá para saber daqui qual lado está errado. Num caso real: o arquivo diz `corrigir` porque
// um restore o REGREDIU, e o ledger termina em `release` (deploy:reverted). Gravar `release → corrigir` com
// actor merge legitimaria a regressão, apagaria a evidência e faria a varredura «0 divergências» passar com o card no
// status errado — e qualquer run que aterrissasse narrativa ou tasks nesse card o gravaria. Então ela vira ALERTA
// (journal) e quem decide o lado certo é o integrador (move_card com nota).

/**
 * WP5-F2 — main mexeu no status deste card DEPOIS da base do run? PURA. É a prova que a comparação com a base não dá:
 * um move A→C→A depois do corte termina igual à base, e o merge por campo deixaria a foto velha do run vencer
 * (card-merge.ts `mainMovedStatus`).
 *
 * Só conta um salto que SAI do status da base (`from === base.status`, `from !== to`), posterior ao commit-base e que
 * não é deste run. Num A→C→A há sempre um A→C depois da base; e ficam de fora os saltos que NÃO são move de main e que
 * o ledger tem de sobra logo depois de toda aterrissagem — contá-los descartava o avanço do run no caso COMUM (o settle
 * carimba o card de main, então o card do run é fundido por campo, e o card aterrissava parado e travava no loop guard):
 *   • os CONSULTIVOS (`from === to`: `merge:approved/reproved/parked`, `resolve:*`), que o train grava com o runId de
 *     OUTRO run segundos depois do commit em que este run se baseia (dezenas de `merge:approved` assim num ledger vivo);
 *   • o salto que LEVOU o card para o status da base: `base.atMs` vem do `%ct` (segundos) e o salto tem ms — o que
 *     aconteceu no mesmo segundo do commit-base parece posterior a ele.
 * `base.atMs` sem número (o `%ct` não veio — {@link commitInstantMs}) ⇒ não: sem instante, o ledger não prova nada.
 */
export function statusMovedSince(
  hops: readonly Pick<Transition, "board" | "cardId" | "at" | "from" | "to" | "runId">[],
  card: { board: string; cardId: string },
  base: { atMs: number; status: string | null | undefined },
  runId?: string,
): boolean {
  if (!Number.isFinite(base.atMs) || !base.status) return false;
  return hops.some(
    (t) =>
      t.board === card.board &&
      t.cardId === card.cardId &&
      t.from === base.status &&
      t.from !== t.to &&
      Date.parse(t.at) > base.atMs &&
      !(runId && t.runId === runId),
  );
}

/**
 * O `%ct` de um commit (segundos, como o `git show -s --format=%ct` imprime) em ms. PURA. Vazio ou não numérico ⇒ NaN —
 * nunca 0: `Number("")` é 0, e um commit-base «em 1970» faria {@link statusMovedSince} contar o ledger inteiro.
 */
export function commitInstantMs(ct: string): number {
  const text = ct.trim();
  const seconds = Number(text);
  return text && Number.isFinite(seconds) ? seconds * 1000 : Number.NaN;
}

/** O status que um card tem no disco agora, e o que ele tinha antes de quem escreveu (quando se sabe). */
export interface CardStatusOnDisk {
  board: string;
  cardId: string;
  /** o status ANTES da escrita (o lado vivo de main antes do merge-back); `null` quando o card não existia/sem status. */
  before: string | null;
  /** o status no arquivo DEPOIS da escrita. */
  after: string;
}

/** Ledger e arquivo discordam, e não foi esta aterrissagem que os separou: nada é gravado, só relatado. */
export interface LedgerDivergence {
  kind: "divergent";
  board: string;
  cardId: string;
  /** onde o último salto do ledger termina. */
  ledger: string | null;
  /** o status no arquivo. */
  file: string;
}

/** O que fazer com o ledger de um card depois de uma aterrissagem: gravar UM salto, ou relatar a divergência. */
export type LedgerCatchUp = { kind: "hop"; hop: AppendTransitionInput } | LedgerDivergence;

/**
 * PURA — põe o ledger de UM card em dia com o arquivo depois de uma aterrissagem (ver a régua acima). `last` é o último
 * salto registrado do card (qualquer ator); `runId` é o run que está aterrissando. `null` ⇒ já está em dia. O `from` do
 * salto é onde o LEDGER parou (a verdade que ele contava), não onde o arquivo estava — é isso que mantém a cadeia
 * from→to contínua e torna o salto uma reconciliação, não um segundo registro do mesmo passo.
 */
export function ledgerCatchUp(
  last: Pick<Transition, "to" | "actor" | "runId"> | undefined,
  card: CardStatusOnDisk,
  origin: string,
  runId?: string,
): LedgerCatchUp | null {
  const ledgerSays = last ? last.to : card.before;
  if (ledgerSays === card.after) return null;
  const thisLandingMoved = card.before !== card.after;
  const optimisticSettleOfThisRun = !!last && !!runId && last.runId === runId && last.actor.startsWith("run:");
  if (!thisLandingMoved && !optimisticSettleOfThisRun) {
    return { kind: "divergent", board: card.board, cardId: card.cardId, ledger: ledgerSays, file: card.after };
  }
  return {
    kind: "hop",
    hop: {
      board: card.board,
      cardId: card.cardId,
      from: ledgerSays,
      to: card.after,
      actor: "merge",
      ...(runId ? { runId } : {}),
      note: `reconcile:${origin}`,
    },
  };
}

/**
 * Lê o ledger UMA vez, grava os saltos de reconciliação que esta aterrissagem deve e ALERTA (journal) cada divergência
 * anterior a ela. Fail-open (a escrita do card já aconteceu; um ledger ilegível só deixa de ser corrigido nesta
 * passada). `read` é injetável para teste.
 */
export async function reconcileLedgerWithCards(
  cards: readonly CardStatusOnDisk[],
  opts: { origin: string; runId?: string; read?: () => Promise<Transition[]> },
): Promise<{ hops: AppendTransitionInput[]; divergent: LedgerDivergence[] }> {
  const hops: AppendTransitionInput[] = [];
  const divergent: LedgerDivergence[] = [];
  if (cards.length === 0) return { hops, divergent };
  try {
    const all = await (opts.read ?? (() => readTransitions()))();
    const lastByCard = new Map<string, Transition>();
    for (const t of all) lastByCard.set(`${t.board}/${t.cardId}`, t); // o ledger é cronológico: o último vence
    for (const c of cards) {
      const res = ledgerCatchUp(lastByCard.get(`${c.board}/${c.cardId}`), c, opts.origin, opts.runId);
      if (res?.kind === "hop") hops.push(res.hop);
      else if (res) divergent.push(res);
    }
    for (const hop of hops) await appendTransition(hop);
    for (const d of divergent) {
      console.warn(
        `[transitions] ALERTA: ledger×arquivo divergente em ${d.board}/${d.cardId} — o ledger termina em «${d.ledger ?? "—"}», ` +
          `o arquivo diz «${d.file}», e esta aterrissagem (${opts.origin}${opts.runId ? `, run ${opts.runId}` : ""}) não mudou o ` +
          `status: nenhum salto gravado (gravar legitimaria uma regressão). Decida o lado certo com move_card e nota.`,
      );
    }
    return { hops, divergent };
  } catch (err) {
    console.warn("[transitions] reconciliação do ledger falhou (não-fatal):", err instanceof Error ? err.message : err);
    return { hops: [], divergent: [] };
  }
}

/**
 * PURA — o card mudou de board (card-transfer.ts): os saltos dele no board antigo passam a ser do board novo, para o
 * histórico do card acompanhá-lo. Byte a byte nas outras linhas (as de outros cards e as ilegíveis ficam como estão).
 */
export function rehomeTransitionsRaw(raw: string, fromBoard: string, cardId: string, toBoard: string): { raw: string; moved: number } {
  let moved = 0;
  const out = raw.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    try {
      const rec = JSON.parse(t) as Transition;
      if (rec && rec.board === fromBoard && rec.cardId === cardId) {
        moved++;
        return JSON.stringify({ ...rec, board: toBoard });
      }
    } catch {
      /* linha ilegível: fica como está */
    }
    return line;
  });
  return { raw: out.join("\n"), moved };
}

/**
 * O IO de {@link rehomeTransitionsRaw}: reescreve o ledger na MESMA fila das escritas (nenhum append intercala). Nunca
 * lança (o card já mudou de board; um histórico não re-atribuído só fica no board antigo). No-op sob vitest, como o sink.
 */
export function rehomeCardTransitions(fromBoard: string, cardId: string, toBoard: string): Promise<void> {
  if (process.env.VITEST) return Promise.resolve();
  writeChain = writeChain
    .then(async () => {
      const file = transitionsPath();
      const raw = await fsp.readFile(file, "utf8").catch(() => null);
      if (raw == null) return;
      const next = rehomeTransitionsRaw(raw, fromBoard, cardId, toBoard);
      if (next.moved) await fsp.writeFile(file, next.raw, "utf8");
    })
    .catch((err) => {
      console.warn("[transitions] re-atribuição de board falhou (não-fatal):", err instanceof Error ? err.message : err);
    });
  return writeChain;
}

/** PURE — parse a JSONL blob into transitions, tolerant (a corrupt line is skipped) + optionally filtered. */
export function parseTransitionsLines(raw: string, filter?: { cardId?: string; board?: string }): Transition[] {
  const out: Transition[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Transition;
      if (!rec || typeof rec.to !== "string" || typeof rec.cardId !== "string") continue;
      if (filter?.cardId && rec.cardId !== filter.cardId) continue;
      if (filter?.board && rec.board !== filter.board) continue;
      out.push(rec);
    } catch {
      /* skip a malformed line — the ledger is append-only and a partial write must not break reads */
    }
  }
  return out;
}

/**
 * PURE — CARD-SCOPED compaction of a JSONL ledger blob (6.2). Replaces the old card-BLIND global trim, which
 * let a noisy board evict a quiet board's live-card history from the single shared file. For EVERY card it
 * keeps the last `keepPerCard` hops PLUS every hop inside the last `windowMs`; the union is the survivor set.
 * Because the most-recent hop of any card is always within the last-N, the last hop of a card is NEVER removed.
 *
 * Order-preserving (chronological) and byte-preserving — survivors are re-emitted as their EXACT original line
 * text, so any forward-compatible fields the parser doesn't model are retained. Unparseable / attribution-less
 * lines (no string `cardId`/`to`) are DROPPED — they carry no card to retain by; this is a documented
 * divergence from the old slice (which kept junk) and matches the reader's own tolerance. `now` is injected
 * (defaulted to Date.now()) so the 30-day window is deterministically testable. Never throws.
 */
export function compactTransitions(
  raw: string,
  opts?: { now?: number; keepPerCard?: number; windowMs?: number },
): string {
  const now = opts?.now ?? Date.now();
  const keepPerCard = opts?.keepPerCard ?? KEEP_PER_CARD;
  const windowMs = opts?.windowMs ?? KEEP_WINDOW_MS;
  // Parse once, remembering each survivor candidate's ORIGINAL text + its cardId + parsed timestamp.
  const parsed: { line: string; cardId: string; atMs: number }[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as Transition;
      if (!rec || typeof rec.to !== "string" || typeof rec.cardId !== "string") continue; // same guard as the reader
      parsed.push({ line: t, cardId: rec.cardId, atMs: Date.parse(rec.at) });
    } catch {
      /* drop a malformed line — no attributable card, so per-card retention can't keep it */
    }
  }
  // Walk newest→oldest, marking survivors: keep while under the per-card count OR inside the time window.
  const perCard = new Map<string, number>();
  const keep = new Array<boolean>(parsed.length).fill(false);
  for (let i = parsed.length - 1; i >= 0; i--) {
    const p = parsed[i];
    const seen = perCard.get(p.cardId) ?? 0;
    const withinWindow = Number.isFinite(p.atMs) && now - p.atMs <= windowMs;
    if (seen < keepPerCard || withinWindow) {
      keep[i] = true;
      perCard.set(p.cardId, seen + 1);
    }
  }
  // Re-emit survivors in ORIGINAL (chronological) order.
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) if (keep[i]) out.push(parsed[i].line);
  return out.length ? out.join("\n") + "\n" : "";
}
