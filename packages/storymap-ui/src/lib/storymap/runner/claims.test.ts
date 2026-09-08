import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CardClaims,
  CLAIM_TTL_SESSION_MS,
  capReleased,
  claimConflicts,
  diskClaimStore,
  findLiveConflict,
  isClaimLive,
  sweepClaims,
  type CardClaim,
  type ClaimRequest,
  type ClaimStore,
} from "./claims";

// A claim at `now` with `ttlMs` left, plus whatever the test overrides.
function claim(over: Partial<CardClaim> = {}): CardClaim {
  const now = Date.now();
  return {
    board: "acme",
    cardId: "story-1",
    actor: "session:a",
    kind: "implement",
    scope: "code",
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    ...over,
  };
}

function req(over: Partial<ClaimRequest> = {}): ClaimRequest {
  return { board: "acme", cardId: "story-1", actor: "run:r1", kind: "implement", scope: "code", ttlMs: 60_000, ...over };
}

/** In-memory store (the DI seam) — the class's logic is exercised without touching fs. */
function memStore(seed: CardClaim[] = []): ClaimStore & { rows: CardClaim[] } {
  const s = {
    rows: [...seed],
    async load() {
      return [...s.rows];
    },
    async persist(claims: CardClaim[]) {
      s.rows = [...claims];
    },
  };
  return s;
}

describe("isClaimLive", () => {
  it("a live claim reserves; an expired one does not", () => {
    const now = Date.now();
    expect(isClaimLive(claim({ expiresAt: new Date(now + 1000).toISOString() }), now)).toBe(true);
    expect(isClaimLive(claim({ expiresAt: new Date(now - 1).toISOString() }), now)).toBe(false);
  });

  it("a TOMBSTONE never reserves, even with a future expiry", () => {
    const now = Date.now();
    const tomb = claim({ expiresAt: new Date(now + 60_000).toISOString(), released: "session-died" });
    expect(isClaimLive(tomb, now)).toBe(false);
  });

  it("an unparseable expiry does not reserve (a garbage claim must never wedge a card)", () => {
    expect(isClaimLive(claim({ expiresAt: "não-uma-data" }), Date.now())).toBe(false);
  });
});

describe("claimConflicts (D8)", () => {
  it("the SAME actor never conflicts with itself — that is a renew, not a lockout", () => {
    expect(claimConflicts(claim({ actor: "run:r1" }), { actor: "run:r1", kind: "review", scope: "code" })).toBe(false);
  });

  it("code is CARD-EXCLUSIVE: two code-scope actors conflict even with different kinds", () => {
    expect(claimConflicts(claim({ actor: "session:a", kind: "implement", scope: "code" }), { actor: "run:r1", kind: "review", scope: "code" })).toBe(true);
  });

  it("`both` counts as code for exclusivity", () => {
    expect(claimConflicts(claim({ actor: "session:a", scope: "both", kind: "implement" }), { actor: "run:r1", kind: "qa", scope: "code" })).toBe(true);
    expect(claimConflicts(claim({ actor: "session:a", scope: "code", kind: "implement" }), { actor: "run:r1", kind: "qa", scope: "both" })).toBe(true);
  });

  it("board-scope: 1 per (card, kind) — the same kind conflicts", () => {
    expect(claimConflicts(claim({ actor: "a", kind: "triage", scope: "board" }), { actor: "b", kind: "triage", scope: "board" })).toBe(true);
  });

  it("board-scope: DIFFERENT kinds coexist (a review reading + the tick observing)", () => {
    expect(claimConflicts(claim({ actor: "a", kind: "review", scope: "board" }), { actor: "copilot:tick", kind: "steward", scope: "board" })).toBe(false);
  });

  it("a light run (board) does NOT block a steward, but DOES block another implement", () => {
    const light = claim({ actor: "run:light", kind: "implement", scope: "board" });
    expect(claimConflicts(light, { actor: "copilot:tick", kind: "steward", scope: "board" })).toBe(false);
    expect(claimConflicts(light, { actor: "session:b", kind: "implement", scope: "board" })).toBe(true);
  });
});

describe("findLiveConflict", () => {
  it("ignores claims on OTHER cards/boards", () => {
    const claims = [claim({ cardId: "story-2" }), claim({ board: "spot" })];
    expect(findLiveConflict(claims, req(), Date.now())).toBeNull();
  });

  it("ignores EXPIRED holders (an orphaned reservation must not block — no deadlock)", () => {
    const stale = claim({ actor: "session:dead", expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(findLiveConflict([stale], req(), Date.now())).toBeNull();
  });

  it("returns the live holder that blocks", () => {
    const holder = claim({ actor: "session:a" });
    expect(findLiveConflict([holder], req(), Date.now())?.actor).toBe("session:a");
  });
});

describe("sweepClaims (WS-4.4)", () => {
  it("frees a lapsed reservation and annotates `expired`", () => {
    const now = Date.now();
    const stale = claim({ expiresAt: new Date(now - 1).toISOString() });
    const { claims, released } = sweepClaims([stale], now);
    expect(released).toHaveLength(1);
    expect(claims[0].released).toBe("expired");
    expect(claims[0].releasedAt).toBeTruthy();
  });

  it("frees a DEAD actor's still-in-TTL claim and annotates `session-died` (the steward's input)", () => {
    const now = Date.now();
    const live = claim({ actor: "session:ghost", expiresAt: new Date(now + CLAIM_TTL_SESSION_MS).toISOString() });
    const { claims, released } = sweepClaims([live], now, new Set(["session:ghost"]));
    expect(released).toHaveLength(1);
    expect(claims[0].released).toBe("session-died");
  });

  it("leaves live claims of live actors untouched, and never re-releases a tombstone", () => {
    const now = Date.now();
    const live = claim({ actor: "session:alive" });
    const tomb = claim({ actor: "session:old", released: "expired", releasedAt: new Date(now - 5).toISOString() });
    const { claims, released } = sweepClaims([live, tomb], now);
    expect(released).toHaveLength(0);
    expect(claims[0]).toBe(live);
    expect(claims[1]).toBe(tomb);
  });
});

describe("capReleased", () => {
  it("keeps every live claim and caps tombstones to the newest N", () => {
    const now = Date.now();
    const live = [claim({ cardId: "a" }), claim({ cardId: "b" })];
    const tombs = [1, 2, 3].map((i) =>
      claim({ cardId: `t${i}`, released: "expired", releasedAt: new Date(now - i * 1000).toISOString() }),
    );
    const out = capReleased([...live, ...tombs], 2);
    expect(out.filter((c) => !c.released)).toHaveLength(2);
    const kept = out.filter((c) => c.released).map((c) => c.cardId);
    expect(kept).toEqual(["t1", "t2"]); // newest two
  });
});

describe("diskClaimStore", () => {
  const dir = path.join(os.tmpdir(), `claims-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("round-trips through the disk, and loadSync agrees with load (a divergence would be invisible)", async () => {
    const store = diskClaimStore(dir);
    const claims = new CardClaims(store);
    await claims.acquire(req({ actor: "session:a", note: "trabalhando" }));
    await claims.flush();
    // A FRESH registry over the same dir = what a service restart sees. Session claims must survive it.
    const reloaded = await new CardClaims(diskClaimStore(dir)).list("acme");
    expect(reloaded.map((c) => c.actor)).toEqual(["session:a"]);
    expect(reloaded[0].note).toBe("trabalhando");
    expect(store.loadSync?.().map((c) => c.actor)).toEqual(["session:a"]);
    expect((await store.load()).map((c) => c.actor)).toEqual(["session:a"]);
  });

  it("an absent file is a clean cold start on BOTH paths (no throw, no reservations)", async () => {
    const store = diskClaimStore(path.join(dir, "nunca-existiu"));
    expect(await store.load()).toEqual([]);
    expect(store.loadSync?.()).toEqual([]);
  });

  it("a CORRUPT file degrades to empty on both paths instead of wedging the board (AC5)", async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "claims.json"), "{isto não é json", "utf8");
    const store = diskClaimStore(dir);
    expect(await store.load()).toEqual([]);
    expect(store.loadSync?.()).toEqual([]);
    expect(await new CardClaims(store).list()).toEqual([]);
  });

  it("drops only the MALFORMED entries, keeping the valid ones (per-entry safeParse)", async () => {
    await fsp.mkdir(dir, { recursive: true });
    const good = claim({ actor: "session:boa" });
    await fsp.writeFile(
      path.join(dir, "claims.json"),
      JSON.stringify({ v: 1, claims: [good, { board: "acme", actor: 42 }, { lixo: true }] }),
      "utf8",
    );
    expect((await diskClaimStore(dir).load()).map((c) => c.actor)).toEqual(["session:boa"]);
  });

  it("a file from an unknown schema version is ignored (never fed in as-is)", async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "claims.json"), JSON.stringify({ v: 99, claims: [claim()] }), "utf8");
    expect(await diskClaimStore(dir).load()).toEqual([]);
  });
});

describe("CardClaims", () => {
  it("acquires a free card and persists it", async () => {
    const store = memStore();
    const claims = new CardClaims(store);
    const res = await claims.acquire(req());
    expect(res.ok).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(await claims.list("acme")).toHaveLength(1);
  });

  it("REFUSES a conflicting acquire and returns the structured holder (no extra round-trip)", async () => {
    const claims = new CardClaims(memStore([claim({ actor: "session:a", note: "mexendo no login" })]));
    const res = await claims.acquire(req({ actor: "run:r1" }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("esperava recusa");
    expect(res.holder.actor).toBe("session:a");
    expect(res.holder.note).toBe("mexendo no login");
  });

  it("the SAME actor re-acquiring RENEWS in place (never duplicates) and keeps the original acquiredAt", async () => {
    const store = memStore();
    const claims = new CardClaims(store);
    const first = await claims.acquire(req({ actor: "run:r1" }));
    if (!first.ok) throw new Error("esperava sucesso");
    const acquiredAt = first.claim.acquiredAt;
    const second = await claims.acquire(req({ actor: "run:r1", ttlMs: 120_000 }));
    if (!second.ok) throw new Error("esperava renovação");
    expect(store.rows.filter((c) => !c.released)).toHaveLength(1);
    expect(second.claim.acquiredAt).toBe(acquiredAt);
    expect(Date.parse(second.claim.expiresAt)).toBeGreaterThan(Date.parse(first.claim.expiresAt));
  });

  it("a card whose holder EXPIRED is acquirable again (AC2 — no deadlock by orphan)", async () => {
    const dead = claim({ actor: "session:dead", expiresAt: new Date(Date.now() - 1).toISOString() });
    const claims = new CardClaims(memStore([dead]));
    const res = await claims.acquire(req({ actor: "run:r1" }));
    expect(res.ok).toBe(true);
  });

  it("release is idempotent and tolerant of a claim that was never acquired", async () => {
    const store = memStore();
    const claims = new CardClaims(store);
    await expect(claims.release("acme", "story-1", "run:nunca")).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(0);
    await claims.acquire(req({ actor: "run:r1" }));
    await claims.release("acme", "story-1", "run:r1");
    await claims.release("acme", "story-1", "run:r1"); // second call = no-op
    expect(await claims.list()).toHaveLength(0);
    expect(store.rows.filter((c) => c.released === "released")).toHaveLength(1);
  });

  it("a released card is immediately re-acquirable by someone else", async () => {
    const claims = new CardClaims(memStore());
    await claims.acquire(req({ actor: "session:a" }));
    expect((await claims.acquire(req({ actor: "run:r1" }))).ok).toBe(false);
    await claims.release("acme", "story-1", "session:a");
    expect((await claims.acquire(req({ actor: "run:r1" }))).ok).toBe(true);
  });

  it("renew extends a live claim and returns null for a lapsed one (caller re-acquires instead)", async () => {
    const claims = new CardClaims(memStore());
    const first = await claims.acquire(req({ actor: "run:r1", ttlMs: 60_000 }));
    if (!first.ok) throw new Error("esperava sucesso");
    const renewed = await claims.renew("acme", "story-1", "run:r1", 120_000);
    expect(renewed).not.toBeNull();
    expect(Date.parse(renewed!.expiresAt)).toBeGreaterThan(Date.parse(first.claim.expiresAt));
    expect(await claims.renew("acme", "story-1", "run:desconhecido", 60_000)).toBeNull();
  });

  it("sweepExpired frees lapsed reservations, annotates why, and is idempotent", async () => {
    const stale = claim({ actor: "session:a", expiresAt: new Date(Date.now() - 1).toISOString() });
    const claims = new CardClaims(memStore([stale]));
    const released = await claims.sweepExpired();
    expect(released).toHaveLength(1);
    expect(released[0].released).toBe("expired");
    expect(await claims.sweepExpired()).toHaveLength(0); // nothing left to free
    expect(await claims.list()).toHaveLength(0);
    expect((await claims.listReleased())[0].released).toBe("expired");
  });

  it("sweepExpired with a dead-actor probe frees a session that died mid-TTL (AC4, ≤1 sweep)", async () => {
    const live = claim({ actor: "session:ghost" });
    const claims = new CardClaims(memStore([live]));
    const released = await claims.sweepExpired(new Set(["session:ghost"]));
    expect(released.map((c) => c.released)).toEqual(["session-died"]);
    expect((await claims.acquire(req({ actor: "run:r1" }))).ok).toBe(true);
  });

  it("list filters by board and excludes tombstones; listReleased is newest-first", async () => {
    const claims = new CardClaims(memStore());
    await claims.acquire(req({ board: "acme", cardId: "a", actor: "session:1" }));
    await claims.acquire(req({ board: "spot", cardId: "b", actor: "session:2" }));
    expect((await claims.list("acme")).map((c) => c.cardId)).toEqual(["a"]);
    expect(await claims.list()).toHaveLength(2);
    await claims.release("acme", "a", "session:1");
    expect(await claims.list("acme")).toHaveLength(0);
    expect(await claims.listReleased("acme")).toHaveLength(1);
  });

  it("claimedCardIds gives the tick the cards held by OTHER actors (its own are not obstacles)", async () => {
    const claims = new CardClaims(memStore());
    await claims.acquire(req({ cardId: "held", actor: "session:a" }));
    await claims.acquire(req({ cardId: "mine", actor: "copilot:tick", kind: "steward", scope: "board" }));
    const blocked = await claims.claimedCardIds("acme", "copilot:tick");
    expect([...blocked]).toEqual(["held"]);
  });

  it("conflictFor reports the blocker WITHOUT reserving anything (a pure read for the tick/advisory)", async () => {
    const store = memStore([claim({ actor: "session:a" })]);
    const claims = new CardClaims(store);
    expect((await claims.conflictFor(req({ actor: "run:r1" })))?.actor).toBe("session:a");
    expect(store.rows).toHaveLength(1); // nothing written
  });

  it("releaseRunClaimsOnBoot frees run claims of a previous life but SPARES session claims", async () => {
    const claims = new CardClaims(
      memStore([
        claim({ cardId: "a", actor: "run:old", kind: "implement", scope: "code" }),
        claim({ cardId: "b", actor: "session:human", kind: "implement", scope: "code" }),
      ]),
    );
    expect(await claims.releaseRunClaimsOnBoot()).toBe(1);
    const live = await claims.list();
    expect(live.map((c) => c.actor)).toEqual(["session:human"]);
    expect((await claims.listReleased())[0].released).toBe("superseded");
  });

  it("concurrent acquires of the SAME card resolve to exactly ONE winner (the keyed lock serializes)", async () => {
    const claims = new CardClaims(memStore());
    const results = await Promise.all([
      claims.acquire(req({ actor: "run:a" })),
      claims.acquire(req({ actor: "run:b" })),
      claims.acquire(req({ actor: "run:c" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await claims.list()).toHaveLength(1);
  });

  it("a broken store degrades to NO reservations instead of throwing (fail-open read, AC5)", async () => {
    const broken: ClaimStore = {
      async load() {
        throw new Error("claims.json corrompido");
      },
      async persist() {},
    };
    const claims = new CardClaims(broken);
    expect(await claims.list()).toEqual([]);
    expect((await claims.acquire(req())).ok).toBe(true); // the board keeps working
  });

  it("a persist failure never fails the acquisition (the reservation still arbitrates in-process)", async () => {
    const flaky: ClaimStore = {
      async load() {
        return [];
      },
      async persist() {
        throw new Error("disco cheio");
      },
    };
    const claims = new CardClaims(flaky);
    expect((await claims.acquire(req({ actor: "run:a" }))).ok).toBe(true);
    expect((await claims.acquire(req({ actor: "run:b" }))).ok).toBe(false);
  });

  it("subscribe fires the LIVE set on every change, and a throwing listener never breaks the acquire", async () => {
    const claims = new CardClaims(memStore());
    const seen: number[] = [];
    const off = claims.subscribe((live) => seen.push(live.length));
    claims.subscribe(() => {
      throw new Error("listener quebrado");
    });
    await claims.acquire(req({ actor: "run:a" }));
    await claims.release("acme", "story-1", "run:a");
    expect(seen).toEqual([1, 0]);
    off();
    await claims.acquire(req({ actor: "run:b" }));
    expect(seen).toEqual([1, 0]); // unsubscribed
  });
});
