// A fleet session's OWN card reservation — the two verbs `claude_new` never exposed.
//
//   • claim_card    — a session opened by `worktree_open` or `adopt_session` has NO claim (only `claude_new`
//                     takes one), so while it works a card the column skills are NOT held off it. This lets it
//                     reserve the card through the SAME rule `claude_new` applies (claimForRole × TTL), as the
//                     SAME actor (`session:<agentId>`), so the fleet reconcile renews it and frees it on death.
//   • release_claim — the session gives ITS reservation back when its job on the card is done (a conductor
//                     after the human approved its delivery). Before this, a claim only ended when the tmux died
//                     or 60 min after the last renewal — and a session that deregistered (worktree_discard) was
//                     never renewed nor swept, so its card stayed reserved for up to an hour for nothing.
//
// The caller names ITSELF by `sessionId` (the MCP transport carries no per-session identity — the fleet shares
// the scoped `orch` token), exactly as worktree_submit/worktree_discard do. The actor is DERIVED from the
// registry row, never taken from the caller: release frees only `session:<that row's agentId>`, so a session
// can never release a claim held by a run, the copiloto, a human, or another session — the refusal names the
// holder instead. PURE logic over injected IO (the tools in mcp/dev-tools.ts are the surface).

import { CLAIM_TTL_SESSION_MS, isClaimLive, sessionClaimActor, type CardClaim, type ClaimKind, type ClaimScope } from "./claims";
import { claimForRole } from "./session-spawn";
import type { AgentSession } from "./session-worktree";

export interface SessionClaimDeps {
  sessions(): Promise<AgentSession[]>;
  claims: {
    acquire(req: { board: string; cardId: string; actor: string; kind: ClaimKind; scope: ClaimScope; ttlMs: number; note?: string }): Promise<{ ok: true; claim: CardClaim } | { ok: false; holder: CardClaim }>;
    release(board: string, cardId: string, actor: string): Promise<void>;
    list(board?: string): Promise<CardClaim[]>;
  };
  /** attach the card to the session row (so the fleet reconcile renews the claim while its tmux lives). */
  bindCard(sessionId: string, board: string, cardId: string): Promise<void>;
  now?(): number;
}

export type ClaimCardResult =
  | { ok: true; claim: CardClaim; renewedByFleet: boolean }
  | { ok: false; reason: string; holder?: CardClaim };

/** Reserve `board/cardId` for the calling session. Re-claiming its own card RENEWS (same actor). */
export async function claimCardForSession(
  deps: SessionClaimDeps,
  input: { sessionId: string; board: string; cardId: string },
): Promise<ClaimCardResult> {
  const s = (await deps.sessions()).find((x) => x.sessionId === input.sessionId);
  if (!s) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?) — o claim é da sessão que o pede` };
  if (s.board && s.cardId && (s.board !== input.board || s.cardId !== input.cardId)) {
    return {
      ok: false,
      reason:
        `a sessão ${s.sessionId.slice(0, 8)} já trabalha em ${s.board}/${s.cardId} — um card por sessão (a frota renova o ` +
        `claim do card da SESSÃO). Solte aquele (release_claim) e abra outra sessão para este.`,
    };
  }
  const spec = claimForRole(s.role);
  const res = await deps.claims.acquire({
    board: input.board,
    cardId: input.cardId,
    actor: sessionClaimActor(s.agentId),
    ...spec,
    ttlMs: CLAIM_TTL_SESSION_MS,
    note: s.task.slice(0, 120),
  });
  if (!res.ok) {
    return {
      ok: false,
      holder: res.holder,
      reason: `${input.board}/${input.cardId} já está reservado por ${res.holder.actor} (${res.holder.kind}/${res.holder.scope}, até ${res.holder.expiresAt}).`,
    };
  }
  if (!s.board || !s.cardId) await deps.bindCard(s.sessionId, input.board, input.cardId);
  return { ok: true, claim: res.claim, renewedByFleet: !!s.tmuxSession };
}

export type ReleaseClaimResult =
  | { ok: true; released: boolean; detail: string }
  | { ok: false; reason: string; holder?: CardClaim };

/** Give back the calling session's OWN claim on `board/cardId` — never anyone else's. */
export async function releaseSessionClaim(
  deps: SessionClaimDeps,
  input: { sessionId: string; board: string; cardId: string },
): Promise<ReleaseClaimResult> {
  const s = (await deps.sessions()).find((x) => x.sessionId === input.sessionId);
  if (!s) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?) — só a sessão dona solta o próprio claim` };
  const actor = sessionClaimActor(s.agentId);
  const now = (deps.now ?? Date.now)();
  const live = (await deps.claims.list(input.board)).filter((c) => c.cardId === input.cardId && isClaimLive(c, now));
  const mine = live.find((c) => c.actor === actor);
  if (!mine) {
    const other = live[0];
    if (other) {
      return {
        ok: false,
        holder: other,
        reason: `o claim de ${input.board}/${input.cardId} é de ${other.actor}, não desta sessão (${actor}) — nada foi solto.`,
      };
    }
    return { ok: true, released: false, detail: "esta sessão não tinha claim vivo neste card — nada a soltar" };
  }
  await deps.claims.release(input.board, input.cardId, actor);
  return { ok: true, released: true, detail: `claim de ${actor} em ${input.board}/${input.cardId} solto` };
}

/**
 * Does the session `sessionId` hold a LIVE claim on `board/cardId`? The containment of `set_tasks` (the task
 * list is build evidence — only the owner of the work writes it). Answers WHO holds it otherwise, so the refusal
 * can name the holder. PURE over the registry snapshot + the live claims.
 */
export function sessionOwnsCard(
  sessions: readonly AgentSession[],
  claims: readonly CardClaim[],
  input: { sessionId: string; board: string; cardId: string },
  now: number,
): { ok: true } | { ok: false; reason: "unknown-session" | "not-owner"; holder?: CardClaim } {
  const s = sessions.find((x) => x.sessionId === input.sessionId);
  if (!s) return { ok: false, reason: "unknown-session" };
  const live = claims.filter((c) => c.board === input.board && c.cardId === input.cardId && isClaimLive(c, now));
  if (live.some((c) => c.actor === sessionClaimActor(s.agentId))) return { ok: true };
  return { ok: false, reason: "not-owner", holder: live[0] };
}
