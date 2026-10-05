// O CARD de uma sessão para decidir por ele — a sessão PROVADA (session-binding.ts) e que DETÉM o claim do card.
//
// Escopar por card (ex.: «um agente escopado só propõe comando travado para o card que conduz») não pode confiar no
// rótulo `session:<id>` que o agente declara, nem no `cardId` que uma sessão registrou ao abrir: qualquer token abre uma
// sessão dizendo um card. Vale só a sessão com prova válida, viva no registro, que tem o claim VIVO daquele card como o
// próprio ator (`session:<agentId>`). Sem isso não há card de escopo, e a atribuição fica genérica (nada do que a sessão
// declarou vira texto que o dono lê como fato). Nunca lança.

import type { McpActor } from "@/lib/storymap/mcp/actor";
import { isClaimLive, sessionClaimActor, type CardClaim } from "./claims";
import { sessionBindingOf, type SessionBinding, type SessionBindingDeps } from "./session-binding";
import type { AgentSession } from "./session-worktree";

export interface SessionCardScope {
  binding: SessionBinding;
  /** a sessão provada (ou null) — fonte única dos fatos de atribuição. */
  session: AgentSession | null;
  /** o card que a sessão provada DETÉM pelo claim; null quando não há. */
  scopeCardId: string | null;
}

export interface SessionCardScopeDeps {
  binding?: Partial<SessionBindingDeps>;
  claims?: (board: string) => Promise<CardClaim[]>;
  now?: () => number;
}

/** A sessão provada detém o claim vivo do card que registrou? PURA. */
export function sessionHoldsItsCard(session: Pick<AgentSession, "agentId" | "board" | "cardId">, claims: readonly CardClaim[], now: number): boolean {
  if (!session.board || !session.cardId) return false;
  const actor = sessionClaimActor(session.agentId);
  return claims.some((c) => c.board === session.board && c.cardId === session.cardId && c.actor === actor && isClaimLive(c, now));
}

export async function sessionCardScopeOf(actor: McpActor | undefined, deps: SessionCardScopeDeps = {}): Promise<SessionCardScope> {
  const binding = await sessionBindingOf(actor, deps.binding);
  if (binding.state !== "bound") return { binding, session: null, scopeCardId: null };
  const session = binding.session;
  if (!session.board || !session.cardId) return { binding, session, scopeCardId: null };
  try {
    const list = deps.claims ?? (async (board: string) => (await import("./claims")).getCardClaims().list(board));
    const claims = await list(session.board);
    const now = (deps.now ?? Date.now)();
    return { binding, session, scopeCardId: sessionHoldsItsCard(session, claims, now) ? session.cardId : null };
  } catch {
    return { binding, session, scopeCardId: null };
  }
}
