// O card de escopo de uma sessão: só a sessão PROVADA que DETÉM o claim do card que registrou. Fixtures inventadas.

import { describe, expect, it } from "vitest";
import { sessionClaimActor, type CardClaim } from "./claims";
import { sessionCardScopeOf, sessionHoldsItsCard } from "./session-card-scope";
import { sessionProofFor } from "@/lib/storymap/mcp/session-proof";
import type { AgentSession } from "./session-worktree";

const SECRET = "segredo-de-teste-da-bancada-0123456789";
const NOW = Date.parse("2026-03-01T12:00:00Z");
const sess = (over: Partial<AgentSession> = {}): AgentSession =>
  ({ sessionId: "s-a", agentId: "ag-a", role: "implement", task: "trocar a corrente", openedAt: "2026-03-01T10:00:00Z", heartbeatAt: "2026-03-01T11:59:00Z", board: "oficina", cardId: "story-ex7301", ...over }) as AgentSession;
const claim = (over: Partial<CardClaim> = {}): CardClaim =>
  ({ board: "oficina", cardId: "story-ex7301", actor: sessionClaimActor("ag-a"), kind: "implement", scope: "both", acquiredAt: "2026-03-01T10:00:00Z", expiresAt: "2026-03-01T13:00:00Z", ...over }) as CardClaim;
const actor = (proof: string | null) => ({ level: "orch", caller: { kind: "session", id: "s-a", ...(proof ? { proof } : {}) } }) as never;

describe("sessionHoldsItsCard", () => {
  it("vale só com claim VIVO do próprio ator no card que a sessão registrou", () => {
    expect(sessionHoldsItsCard(sess(), [claim()], NOW)).toBe(true);
    expect(sessionHoldsItsCard(sess(), [claim({ actor: sessionClaimActor("ag-outro") })], NOW)).toBe(false);
    expect(sessionHoldsItsCard(sess(), [claim({ expiresAt: "2026-03-01T11:00:00Z" })], NOW)).toBe(false);
    expect(sessionHoldsItsCard(sess(), [claim({ cardId: "story-ex7302" })], NOW)).toBe(false);
    expect(sessionHoldsItsCard(sess({ cardId: undefined }), [claim()], NOW)).toBe(false);
  });
});

describe("sessionCardScopeOf", () => {
  const deps = (sessions: AgentSession[], claims: CardClaim[]) => ({
    binding: { sessions: async () => sessions, secret: () => SECRET, log: () => {}, now: () => NOW },
    claims: async () => claims,
    now: () => NOW,
  });

  it("sessão provada + claim ⇒ escopo no card", async () => {
    const r = await sessionCardScopeOf(actor(sessionProofFor("s-a", SECRET)), deps([sess()], [claim()]));
    expect(r.scopeCardId).toBe("story-ex7301");
    expect(r.session?.sessionId).toBe("s-a");
  });

  it("sem prova ⇒ nem sessão nem escopo (o rótulo é só atribuição)", async () => {
    const r = await sessionCardScopeOf(actor(null), deps([sess()], [claim()]));
    expect(r.binding.state).toBe("unproven");
    expect(r.session).toBeNull();
    expect(r.scopeCardId).toBeNull();
  });

  it("sessão provada SEM o claim do card ⇒ sessão sim, escopo não", async () => {
    const r = await sessionCardScopeOf(actor(sessionProofFor("s-a", SECRET)), deps([sess()], []));
    expect(r.session?.sessionId).toBe("s-a");
    expect(r.scopeCardId).toBeNull();
  });

  it("leitura de claims que falha ⇒ sem escopo (nunca lança)", async () => {
    const r = await sessionCardScopeOf(actor(sessionProofFor("s-a", SECRET)), {
      ...deps([sess()], []),
      claims: async () => {
        throw new Error("disco");
      },
    });
    expect(r.scopeCardId).toBeNull();
  });
});
