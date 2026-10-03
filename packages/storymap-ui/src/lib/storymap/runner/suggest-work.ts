// suggest-work — WS-6.5: "what should I pick up next?", answered DETERMINISTICALLY.
//
// An idle session (or the copilot dispatching one) asks this when it finishes a card. It is CODE, not an
// LLM: the ranking is a pure function of the board's own pipeline + priority, so two agents asking at the
// same instant get the SAME answer, and the answer is auditable ("why was this first?" has an arithmetic
// reply, not a vibe).
//
// THE CONTENTION MODEL, which is the subtle part: this is READ-ONLY and NEVER reserves anything. Two idle
// agents asking simultaneously SHOULD get the identical list — the mutual exclusion happens later, when they
// try to ACQUIRE the claim (first-writer-wins, atomic in claims.ts); the loser simply takes the next
// suggestion. Putting a "reservation" in the suggestion instead would be a phantom lock: an agent that asks
// and then dies (or never acts) would freeze a card nobody is working on, and we would have re-invented the
// stuck-lock class that claims' TTL exists to kill. Suggestion advises; the claim decides.

import { CODE_SKILLS } from "./skill-registry";
import { wsjfRatio, type WsjfCall } from "../wsjf";
import type { TriggerId } from "../types";
import type { AgentRole } from "./session-worktree";

/** The resolved facts about ONE card the ranking reads. PURE input — the caller does the IO. */
export interface WorkCandidate {
  board: string;
  cardId: string;
  title: string;
  /** the card's current status id. */
  status: string;
  /** position of that status in the board pipeline (0 = leftmost). Rightmost = closest to shipped. */
  columnIndex: number;
  /** the automation the status declares; a column with none is a HUMAN column — never suggested. */
  trigger?: TriggerId;
  /** the status is a terminal/done column. */
  terminal?: boolean;
  /** priorityCall tier: 0 Baixa · 1 Média · 2 Alta · 3 Crítica (higher = more urgent). Ausente =
   *  NÃO AVALIADO, que não é o mesmo que "Baixa" — ordena depois de todo mundo. */
  rank?: number;
  /** a razão WSJF, que desempata dentro do tier. Ausente em call legado (só rank). */
  wsjf?: number;
  /** WHO holds a live claim on this card, if anyone (the card is taken). */
  claimedBy?: string;
  /** the card has an open blocker finding — it cannot progress until a human clears it. */
  blocked?: boolean;
}

export interface WorkSuggestion {
  board: string;
  cardId: string;
  title: string;
  status: string;
  trigger?: TriggerId;
  rank: number;
  /** the one-line arithmetic of WHY this sits where it sits — the ranking must be explainable. */
  why: string;
}

/** Does this trigger write code (⇒ an `implement`-shaped job)? The registry is the one source (WS-7's axis). */
function isCodeTrigger(t: TriggerId | undefined): boolean {
  return !!t && CODE_SKILLS.has(t);
}

/**
 * WS-6.5 — is this card pickable by `role` at all? Deliberately COARSE: the only distinction that changes
 * whether a session needs a WORKTREE (and therefore an admission slot) is code vs not. A finer role→trigger
 * table would be a second routing axis competing with WS-7's model×role map (D10 forbids a new axis), so the
 * role here filters the shape of the work, and WS-7 keeps owning who/what model does it.
 */
function roleAccepts(role: AgentRole | undefined, c: WorkCandidate): boolean {
  if (!role || role === "free") return true;
  if (role === "implement") return isCodeTrigger(c.trigger);
  if (role === "review") return c.trigger === "harness-review" || c.trigger === "harness-qa";
  if (role === "triage") return c.trigger === "harness-capture" || c.trigger === "harness-grill";
  return true; // steward: no filter — it goes wherever it is needed
}

/**
 * Rank the actionable, unclaimed work. PURE and TOTAL: every comparison ends in a tiebreak on cardId, so the
 * order is fully determined by the inputs — the acceptance criterion "two concurrent calls get the SAME
 * ranking" is a property of the function, not a hope about timing.
 *
 * Order, and the reasoning behind it:
 *  1. RIGHTMOST COLUMN FIRST. Work already in flight beats starting new work — a card sitting in QA is one
 *     step from shipping, while a fresh card in Spec is a whole pipeline away. This is the WIP-before-new-work
 *     rule that keeps N agents from starting everything and finishing nothing.
 *  2. Then PRIORITY (rank 3 Crítica → 0 Baixa). Card NÃO AVALIADO vem por ÚLTIMO, não no meio: com o
 *     `?? 0` anterior ele empatava com um card legitimamente avaliado como Baixa, e num board onde
 *     ninguém tinha nota TODO candidato empatava em 0 — a prioridade não decidia nada e a ordem caía
 *     inteira no cardId (ordem alfabética de id, disfarçada de ranking). É a mesma regra de honestidade
 *     da tela: sem avaliação não se finge posição.
 *  3. Então o WSJF, que desempata DENTRO do tier (dois cards "Alta" não são igualmente urgentes).
 *  4. Então cardId, purely to make the order total (never a coin flip between two equal cards).
 *
 * Excluded outright: terminal columns (nothing to do), columns with no trigger (a HUMAN column — suggesting
 * it would send an agent to do a human's job), cards with an open blocker (a human must clear it first), and
 * cards someone already holds a live claim on (that is the whole point of claims).
 */
export function rankWorkCandidates(
  candidates: WorkCandidate[],
  opts: { role?: AgentRole; count?: number } = {},
): WorkSuggestion[] {
  const eligible = candidates.filter(
    (c) => !c.terminal && !!c.trigger && !c.blocked && !c.claimedBy && roleAccepts(opts.role, c),
  );
  const sorted = [...eligible].sort(
    (a, b) =>
      b.columnIndex - a.columnIndex || // 1. WIP first (rightmost column)
      (b.rank ?? -1) - (a.rank ?? -1) || // 2. priority tier; não-avaliado (-1) vai para o FIM
      (b.wsjf ?? 0) - (a.wsjf ?? 0) || // 3. desempate DENTRO do tier
      a.cardId.localeCompare(b.cardId), // 4. total order — determinism, not preference
  );
  const take = sorted.slice(0, Math.max(1, opts.count ?? 3));
  return take.map((c) => ({
    board: c.board,
    cardId: c.cardId,
    title: c.title,
    status: c.status,
    trigger: c.trigger,
    rank: c.rank ?? 0,
    why:
      `coluna ${c.status} (posição ${c.columnIndex} — mais à direita primeiro: WIP antes de trabalho novo)` +
      `, ${c.rank == null ? "sem prioridade avaliada (vai por último)" : `prioridade ${c.rank}/3`}` +
      `${c.wsjf != null ? ` · WSJF ${c.wsjf.toFixed(1)}` : ""}, sem claim vivo`,
  }));
}

/** Why a card that LOOKS actionable was left out — so `suggest_work` can be honest about an empty list. */
export function excludedReason(c: WorkCandidate): string | null {
  if (c.terminal) return "coluna terminal";
  if (!c.trigger) return "coluna sem automação (é trabalho de humano)";
  if (c.blocked) return "tem blocker aberto — um humano precisa destravar";
  if (c.claimedBy) return `já tem claim vivo de ${c.claimedBy}`;
  return null;
}

// --- IO wrapper -------------------------------------------------------------------------------------

/**
 * Resolve a board's cards into {@link WorkCandidate}s. SERVER-ONLY (reads the board + the claim registry).
 * Split from the ranking on purpose: the decision above is pure and unit-tested; only this half touches disk.
 */
export async function collectWorkCandidates(
  board: string,
  deps: {
    readCards: (
      board: string,
    ) => Promise<
      Array<{
        id: string;
        title: string;
        status?: string | null;
        priorityCall?: { rank: number; wsjf?: WsjfCall | null } | null;
        findings?: Array<{ severity?: string; status?: string }> | null;
      }>
    >;
    readBoardConfig: (board: string) => Promise<{ statuses: Array<{ id: string; trigger?: TriggerId; terminal?: boolean }> } | null>;
    liveClaims: () => Promise<Array<{ board: string; cardId: string; actor: string }>>;
  },
): Promise<WorkCandidate[]> {
  const [cards, config, claims] = await Promise.all([
    deps.readCards(board).catch(() => []),
    deps.readBoardConfig(board).catch(() => null),
    deps.liveClaims().catch(() => []),
  ]);
  if (!config) return [];
  const byStatus = new Map(config.statuses.map((s, i) => [s.id, { ...s, index: i }]));
  const claimed = new Map(claims.filter((c) => c.board === board).map((c) => [c.cardId, c.actor]));
  const out: WorkCandidate[] = [];
  for (const card of cards) {
    const st = card.status ? byStatus.get(card.status) : undefined;
    if (!st) continue; // a card in a status the board no longer declares — not suggestable
    out.push({
      board,
      cardId: card.id,
      title: card.title,
      status: st.id,
      columnIndex: st.index,
      trigger: st.trigger,
      terminal: st.terminal,
      rank: card.priorityCall?.rank,
      wsjf: wsjfRatio(card.priorityCall?.wsjf) ?? undefined,
      claimedBy: claimed.get(card.id),
      // An OPEN blocker is the board's own "a human must act" signal — the same one `hasNoBlockers` gates on.
      blocked: (card.findings ?? []).some((f) => f?.severity === "blocker" && f?.status === "open"),
    });
  }
  return out;
}
