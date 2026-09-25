// claim_card / release_claim / the set_tasks containment — a session's OWN reservation, never anyone else's.

import { describe, expect, it } from "vitest";
import { CardClaims, memoryClaimStore, sessionClaimActor, type CardClaim } from "./claims";
import { claimCardForSession, releaseSessionClaim, sessionOwnsCard, type SessionClaimDeps } from "./session-claims";
import type { AgentSession } from "./session-worktree";

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  sessionId: "s-1",
  agentId: "agent-1",
  role: "implement",
  task: "conduzir",
  openedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  ...over,
});

function deps(sessions: AgentSession[], claims = new CardClaims(memoryClaimStore())): SessionClaimDeps & { bound: string[]; claims: CardClaims } {
  const bound: string[] = [];
  return {
    sessions: async () => sessions,
    claims,
    bindCard: async (sessionId, board, cardId) => {
      bound.push(`${sessionId}:${board}/${cardId}`);
      const s = sessions.find((x) => x.sessionId === sessionId);
      if (s) Object.assign(s, { board, cardId });
    },
    bound,
  };
}

describe("claim_card — a sessão sem claim (worktree_open/adopt) reserva o card como ELA mesma", () => {
  it("reserva com o ator da sessão e a regra do papel (implement ⇒ implement/both) e liga o card à sessão", async () => {
    const d = deps([session({ tmuxSession: "agent-x" })]);
    const res = await claimCardForSession(d, { sessionId: "s-1", board: "b", cardId: "c" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claim).toMatchObject({ actor: sessionClaimActor("agent-1"), kind: "implement", scope: "both" });
    expect(res.renewedByFleet).toBe(true);
    expect(d.bound).toEqual(["s-1:b/c"]);
  });

  it("recusa com o HOLDER quando outro ator tem o card", async () => {
    const d = deps([session()]);
    await d.claims.acquire({ board: "b", cardId: "c", actor: "run:xyz", kind: "implement", scope: "code", ttlMs: 60_000 });
    const res = await claimCardForSession(d, { sessionId: "s-1", board: "b", cardId: "c" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.holder?.actor).toBe("run:xyz");
  });

  it("uma sessão = um card: recusa reservar OUTRO card", async () => {
    const d = deps([session({ board: "b", cardId: "c" })]);
    const res = await claimCardForSession(d, { sessionId: "s-1", board: "b", cardId: "outro" });
    expect(res.ok).toBe(false);
  });

  it("sessão desconhecida é recusada", async () => {
    expect((await claimCardForSession(deps([]), { sessionId: "nada", board: "b", cardId: "c" })).ok).toBe(false);
  });

  it("sem tmux, avisa que a frota NÃO renova", async () => {
    const res = await claimCardForSession(deps([session()]), { sessionId: "s-1", board: "b", cardId: "c" });
    expect(res.ok && res.renewedByFleet).toBe(false);
  });
});

describe("release_claim — solta SÓ o claim da própria sessão", () => {
  it("solta o próprio claim (o card fica livre para outro ator)", async () => {
    const d = deps([session()]);
    await claimCardForSession(d, { sessionId: "s-1", board: "b", cardId: "c" });
    const res = await releaseSessionClaim(d, { sessionId: "s-1", board: "b", cardId: "c" });
    expect(res).toMatchObject({ ok: true, released: true });
    expect(await d.claims.list("b")).toEqual([]);
  });

  it("NUNCA solta o claim de outro ator — recusa nomeando o dono, e o claim segue vivo", async () => {
    const d = deps([session()]);
    await d.claims.acquire({ board: "b", cardId: "c", actor: "session:outro-agente", kind: "implement", scope: "both", ttlMs: 60_000 });
    const res = await releaseSessionClaim(d, { sessionId: "s-1", board: "b", cardId: "c" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.holder?.actor).toBe("session:outro-agente");
    expect((await d.claims.list("b")).map((c) => c.actor)).toEqual(["session:outro-agente"]);
  });

  it("sem claim nenhum no card: ok, nada a soltar", async () => {
    expect(await releaseSessionClaim(deps([session()]), { sessionId: "s-1", board: "b", cardId: "c" })).toMatchObject({
      ok: true,
      released: false,
    });
  });

  it("o ator vem do REGISTRO, não do chamador: um sessionId desconhecido não solta nada", async () => {
    const d = deps([session()]);
    await claimCardForSession(d, { sessionId: "s-1", board: "b", cardId: "c" });
    expect((await releaseSessionClaim(d, { sessionId: "forjado", board: "b", cardId: "c" })).ok).toBe(false);
    expect(await d.claims.list("b")).toHaveLength(1);
  });
});

describe("sessionOwnsCard — o cadeado do set_tasks", () => {
  const now = Date.now();
  const claim = (actor: string, over: Partial<CardClaim> = {}): CardClaim => ({
    board: "b",
    cardId: "c",
    actor,
    kind: "implement",
    scope: "both",
    acquiredAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ...over,
  });

  it("dono ⇔ claim VIVO do ator da sessão", () => {
    expect(sessionOwnsCard([session()], [claim(sessionClaimActor("agent-1"))], { sessionId: "s-1", board: "b", cardId: "c" }, now)).toEqual({ ok: true });
  });

  it("claim de outro ator: não é dono (e diz quem é)", () => {
    const r = sessionOwnsCard([session()], [claim("run:x")], { sessionId: "s-1", board: "b", cardId: "c" }, now);
    expect(r).toMatchObject({ ok: false, reason: "not-owner" });
    expect(r.ok ? null : r.holder?.actor).toBe("run:x");
  });

  it("claim EXPIRADO ou solto não conta", () => {
    const expired = claim(sessionClaimActor("agent-1"), { expiresAt: new Date(now - 1).toISOString() });
    const released = claim(sessionClaimActor("agent-1"), { released: "released" });
    expect(sessionOwnsCard([session()], [expired, released], { sessionId: "s-1", board: "b", cardId: "c" }, now).ok).toBe(false);
  });

  it("sessão desconhecida", () => {
    expect(sessionOwnsCard([], [], { sessionId: "s-1", board: "b", cardId: "c" }, now)).toEqual({ ok: false, reason: "unknown-session" });
  });
});
