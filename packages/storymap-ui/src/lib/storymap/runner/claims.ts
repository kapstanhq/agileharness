// claims.ts — WS-4 (storymap-parallel-work): a LIGHT, VISIBLE registry of "who holds which card, for what,
// until when". N agents (headless runs + interactive sessions + the copiloto tick) pick work at the same time;
// without a reservation two of them implement the SAME card — cost 2×, guaranteed conflict in the train, and
// the human orchestrator becomes the lock. This is that reservation: ENFORCED for agents (acquiring a claim
// someone else holds is REFUSED, with the holder returned), ADVISORY for humans (a warning, never a block).
//
// ⚠️ A CLAIM IS **NOT** AN INTEGRITY LOCK — and must never be hardened into one.
// Integrity comes from the merge train + the gates + the per-run worktrees (nothing reaches stage/main except
// through them). A claim is ANTI-WASTE + VISIBILITY: it stops two actors burning tokens on the same card and
// makes "who is on what" legible. Expiry therefore NEVER kills work — it only frees the reservation; the work
// keeps running and still integrates through the train, which is what actually protects the repo. If someone
// later "hardens" claims into a hard lock, the failure mode becomes DEADLOCK BY ORPHANED RESERVATION (a dead
// session's claim wedges a card until a human intervenes) — strictly WORSE than the duplicated work claims
// exist to prevent. Every design choice below (fail-open reads, TTLs, sweep, advisory-for-humans) follows from
// that: when in doubt, a claim yields.
//
// NOT persisted on the CARD (.md), deliberately: a claim is EPHEMERAL OPERATIONAL STATE, not spec. Cards are
// specs (prime directive) and a live operator field on a card FREEZES GOLDENS — that has bitten this project
// twice (see memory `storymap-golden-must-not-photograph-operator-state`, where an operator field in the
// golden froze the merge train). So claims live in their own runner-state file, gitignored, like the journal.
//
// AXIS: this COMPLEMENTS (never replaces) `pairedLease`/`tickLease` in orchestrator-state.ts, which arbitrate
// human↔tick per BOARD (autonomy-reliability WS-4/D8). Those are a different axis: this one arbitrates
// actor↔CARD. Both coexist; neither is expressible in the other.
//
// Store: storymap/.runner/claims.json ({v:1, claims:[]}), loaded with a per-entry safeParse (journal/telemetry
// pattern — one malformed entry never poisons the rest) and FAIL-OPEN on read (a corrupt/absent file degrades
// to "no claims" with a warning, exactly like the ledgers: a broken reservation file must never wedge the
// board). Mutations are serialized by `withKeyedLock("claims")`: EVERY acquisition goes through the service
// process (MCP / server actions / engine — WS-3/D4), so the in-process lock IS the serialization.
//
// IO POSTURE (deliberate — the ENGINE's run admission calls acquire() on every single spawn):
//   • the IN-MEMORY set is authoritative; the file only carries reservations across a restart;
//   • hydrate is SYNC when the store offers `loadSync` (no await ⇒ a run reserves + spawns in one tick);
//   • persists are CHAINED and NOT awaited (journal's writeChain) — a reservation is never worth blocking a
//     spawn on the disk, and a crash before the flush loses at most a reservation (fail-open: someone may
//     redo work) — never integrity, and boot frees every run claim anyway.
// Removing either property silently puts fs IO back on the spawn path.
//
// SERVER-ONLY (node:fs). Process-global singleton, mirroring journal.ts / registry.ts.

import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";

/**
 * What the holder is doing to the card. The set is CLOSED (WS-4.1 spec): it is the arbitration axis
 * ("1 per (card, kind)"), not a free-text label. The pipeline's spec-authoring skills (enrich/grill/plan/
 * ux/ui/capture/style…) map onto `implement` — they are the pipeline's work ON that card, and treating them
 * as such is what makes a live session's claim block a light run on the same card (the WS-3.4 residual risk).
 */
export type ClaimKind = "implement" | "review" | "qa" | "triage" | "steward";

/**
 * What the holder writes. `code` is CARD-EXCLUSIVE (D8: one implementer per card at a time); `board` is the
 * card/sidecar data only (a light run, the tick observing); `both` is a session doing code AND board-data.
 */
export type ClaimScope = "code" | "board" | "both";

/** One live (or recently released) reservation of ONE card by ONE actor. */
export interface CardClaim {
  board: string;
  cardId: string;
  /** "run:<sessionId>" | "session:<sessionId>" | "copilot:tick" | "human:<surface>" */
  actor: string;
  kind: ClaimKind;
  scope: ClaimScope;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  /** e.g. the session's task, for the fleet view (WS-6). */
  note?: string;
  /**
   * WS-4.4 — why this reservation ended. Present ⇒ the claim is a TOMBSTONE: never live, never conflicts,
   * retained only as forensics for the steward (WS-8) — "the card freed up because the session DIED" is a
   * different signal from "the TTL lapsed", and the steward acts on the difference. Extends the spec's field
   * list because 4.4 mandates annotating the reason ON the released claim.
   */
  released?: ClaimReleaseReason;
  /** ISO ts of the release (only alongside `released`). */
  releasedAt?: string;
}

/**
 * WS-4.4 — how a reservation ended.
 *  - `released`     — the holder gave it back explicitly (run settled/cancelled, session closed it).
 *  - `expired`      — the TTL lapsed with no heartbeat (the holder may still be alive; the RESERVATION is
 *                     what expired, never the work — see the module header).
 *  - `session-died` — the fleet probe found the actor's process gone (tmux/pid vanished). The steward's
 *                     highest-signal input: the card is free AND its holder will never come back.
 *  - `superseded`   — a boot re-acquisition replaced a previous life's run claim.
 */
export type ClaimReleaseReason = "released" | "expired" | "session-died" | "superseded";

/** What a caller asks for. `ttlMs` is the reservation's lease — see the TTL constants below. */
export interface ClaimRequest {
  board: string;
  cardId: string;
  actor: string;
  kind: ClaimKind;
  scope: ClaimScope;
  ttlMs: number;
  note?: string;
}

/**
 * The refusal carries the HOLDER (structured, not a string): the caller decides to take another card
 * WITHOUT a second round-trip (WS-4.3). That is the whole point of refusing — an opaque "denied" would
 * just make the agent retry.
 */
export type AcquireResult = { ok: true; claim: CardClaim } | { ok: false; holder: CardClaim };

// ── TTLs ──────────────────────────────────────────────────────────────────────
// A TTL is a BACKSTOP for a holder that vanished, never a deadline on the work. Runs pass their OWN ttl (the
// watchdog timeout) — the run cannot outlive its watchdog, so the reservation cannot outlive the run.

/**
 * WS-6 — the claim actor of an agent SESSION, keyed by its LOGICAL identity (`agentId`), never by the
 * process/sessionId. RECYCLING replaces the tmux process but not the actor: the same agent keeps its cards,
 * so a reservation keyed by the process would be orphaned by every recycle (and re-acquired as a stranger).
 *
 * ONE source for the string because THREE places must agree on it byte-for-byte: `claude_new` acquires with
 * it, the fleet's death sweep frees by it (`reconcileFleet` → `sweepExpired(deadActors)`), and the fleet view
 * matches a row to its claim by it. A drift between any two of them is silent: the sweep would match nothing
 * and a dead agent's cards would stay reserved until the TTL — the "orphaned reservation" this module's header
 * warns about. The `session:` prefix also keeps {@link CardClaims.releaseRunClaimsOnBoot} correct (it frees
 * `run:*` only — a session legitimately outlives a service restart).
 */
export function sessionClaimActor(agentId: string): string {
  return `session:${agentId}`;
}

/** An interactive agent/human session — renewable by heartbeat while the session lives (WS-4.4). */
export const CLAIM_TTL_SESSION_MS = 60 * 60_000;
/** A steward/triage pass — short, mechanical work (D11). */
export const CLAIM_TTL_STEWARD_MS = 10 * 60_000;
/** Retained tombstones (released claims) — bounded like the journal's done-entries so the file can't grow forever. */
const MAX_RELEASED_RETAINED = 100;

// ── PURE core (no IO — unit-testable in isolation, like orchestrator-state's helpers) ─────────────────────

/** Does this claim still reserve the card at `now`? A tombstone never does. PURE. */
export function isClaimLive(claim: CardClaim, now: number): boolean {
  if (claim.released) return false;
  const exp = Date.parse(claim.expiresAt);
  return Number.isFinite(exp) && exp > now;
}

/** Does the claim's scope touch CODE (the card-exclusive axis, D8)? PURE. */
function touchesCode(scope: ClaimScope): boolean {
  return scope === "code" || scope === "both";
}

/**
 * D8 conflict rule between an EXISTING live claim and a REQUEST for the same card. PURE.
 *
 *  - same actor ⇒ NEVER a conflict (that is a RENEW — the holder re-asking must never lock itself out;
 *    it is exactly what a run's resume and a session's heartbeat do);
 *  - both touch CODE ⇒ conflict (implementation is card-exclusive: 1 `code`/`both` claim per card);
 *  - same KIND ⇒ conflict (1 per (card, kind) — two triagers on one card is nonsense);
 *  - otherwise ⇒ COEXIST (different kinds are fine: a review reading + the tick observing).
 */
export function claimConflicts(existing: CardClaim, req: Pick<ClaimRequest, "actor" | "kind" | "scope">): boolean {
  if (existing.actor === req.actor) return false;
  if (touchesCode(existing.scope) && touchesCode(req.scope)) return true;
  return existing.kind === req.kind;
}

/** The live claim on `req`'s card that would block it, or null when the card is free for this request. PURE. */
export function findLiveConflict(claims: CardClaim[], req: ClaimRequest, now: number): CardClaim | null {
  for (const c of claims) {
    if (c.board !== req.board || c.cardId !== req.cardId) continue;
    if (!isClaimLive(c, now)) continue;
    if (claimConflicts(c, req)) return c;
  }
  return null;
}

/**
 * WS-4.4 — the sweep decision over the WHOLE set. PURE (the liveness verdict per actor is INJECTED, so no
 * process probing happens here). Returns the next set with the freed claims turned into annotated tombstones.
 *
 * Two independent reasons to free a reservation:
 *  1. the TTL lapsed ⇒ `expired`;
 *  2. the actor is provably GONE (`deadActors`) ⇒ `session-died` — released on the NEXT sweep instead of
 *     waiting out a 60min TTL, and annotated so the steward knows the holder is never coming back (AC4).
 *
 * Freeing NEVER touches the work — only the reservation (module header).
 */
export function sweepClaims(
  claims: CardClaim[],
  now: number,
  deadActors: ReadonlySet<string> = new Set(),
): { claims: CardClaim[]; released: CardClaim[] } {
  const released: CardClaim[] = [];
  const next = claims.map((c) => {
    if (c.released) return c;
    const dead = deadActors.has(c.actor);
    if (!dead && isClaimLive(c, now)) return c;
    const tomb: CardClaim = {
      ...c,
      released: dead ? "session-died" : "expired",
      releasedAt: new Date(now).toISOString(),
    };
    released.push(tomb);
    return tomb;
  });
  return { claims: next, released };
}

/** Drop the oldest tombstones past the retention cap; live claims are NEVER dropped. PURE. */
export function capReleased(claims: CardClaim[], max = MAX_RELEASED_RETAINED): CardClaim[] {
  const live = claims.filter((c) => !c.released);
  const tombs = claims
    .filter((c) => !!c.released)
    .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""))
    .slice(0, max);
  return [...live, ...tombs];
}

// ── Store (disk by default, in-memory in tests — same DI shape as JournalStore) ───────────────────────────

export interface ClaimStore {
  load(): Promise<CardClaim[]>;
  persist(claims: CardClaim[]): Promise<void>;
  /**
   * OPTIONAL fast hydrate: read the store WITHOUT yielding to the event loop. When a store provides it, the
   * registry's very first read costs no await, which is what keeps the ENGINE'S ADMISSION PATH FREE OF
   * BLOCKING IO — a run must reserve its card and spawn without waiting on the disk. The file is tiny (one
   * entry per card being worked) and read once per process, so the sync read is cheaper than the tick it
   * would otherwise cost. A store without it simply falls back to the async `load()`.
   */
  loadSync?(): CardClaim[];
}

/**
 * The narrow surface the ENGINE depends on (DI — like RunnerJournalPort). The engine only reserves and frees;
 * it never lists or sweeps. Keeping the port this thin is what lets a test inject an in-memory double and keep
 * the spawn path free of disk IO (the engine's admission runs on every run — see memoryClaimStore).
 */
export interface CardClaimsPort {
  acquire(req: ClaimRequest): Promise<AcquireResult>;
  release(board: string, cardId: string, actor: string, reason?: ClaimReleaseReason): Promise<void>;
}

/** An in-memory store — tests (and any caller that must not touch disk). Same semantics, zero IO. */
export function memoryClaimStore(seed: CardClaim[] = []): ClaimStore {
  let rows = [...seed];
  return {
    async load() {
      return [...rows];
    },
    loadSync() {
      return [...rows];
    },
    async persist(claims) {
      rows = [...claims];
    },
  };
}

const CLAIMS_VERSION = 1;

// Tolerant per-entry contract. The file is written by THIS process only, but it survives restarts and schema
// drift, so every entry is validated and a malformed one is DROPPED rather than cast in (journal pattern).
// `actor`/`note` stay free-form strings by design (the actor namespace grows with the fleet — WS-6).
const CardClaimSchema = z.object({
  board: z.string(),
  cardId: z.string(),
  actor: z.string(),
  kind: z.enum(["implement", "review", "qa", "triage", "steward"]),
  scope: z.enum(["code", "board", "both"]),
  acquiredAt: z.string(),
  expiresAt: z.string(),
  heartbeatAt: z.string(),
  note: z.string().optional(),
  released: z.enum(["released", "expired", "session-died", "superseded"]).optional(),
  releasedAt: z.string().optional(),
});

/**
 * Parse one raw file body into claims. FAIL-OPEN (AC5): an unrecognized/corrupt file degrades to "no
 * reservations" + a warning — a claim file is anti-waste state, NOT integrity state, so refusing to work
 * because we can't read it would be fail-CLOSED on the wrong axis (the train still gates everything). Loud,
 * though: silently losing the reservations is how two agents end up on the same card. Shared by load/loadSync
 * so both paths apply the SAME contract (a divergence here would be invisible and awful).
 */
function parseClaimsFile(text: string): CardClaim[] {
  const data = JSON.parse(text);
  if (data?.v !== CLAIMS_VERSION || !Array.isArray(data.claims)) {
    console.warn(`[harness-claims] claims.json irreconhecível (v=${data?.v}) — degradando p/ vazio (nenhuma reserva).`);
    return [];
  }
  const valid: CardClaim[] = [];
  for (const raw of data.claims) {
    const parsed = CardClaimSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data as CardClaim);
  }
  if (valid.length !== data.claims.length) {
    console.warn(`[harness-claims] ${data.claims.length - valid.length} claim(s) malformado(s) descartado(s).`);
  }
  return valid;
}

/** An absent file is the normal cold start (silent); anything else (corrupt JSON, unreadable) warns. */
function claimLoadFallback(err: unknown): CardClaim[] {
  if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
    console.warn(`[harness-claims] load falhou — degradando p/ vazio:`, err instanceof Error ? err.message : err);
  }
  return [];
}

/** Atomic on-disk store: write a temp file then rename over the target (same fs) — the journal's pattern. */
export function diskClaimStore(dir: string): ClaimStore {
  const file = path.join(dir, "claims.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        return parseClaimsFile(await fsp.readFile(file, "utf8"));
      } catch (err) {
        return claimLoadFallback(err);
      }
    },
    loadSync() {
      try {
        return parseClaimsFile(readFileSync(file, "utf8"));
      } catch (err) {
        return claimLoadFallback(err);
      }
    },
    async persist(claims) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ v: CLAIMS_VERSION, claims }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file); // atomic
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

// ── The registry ──────────────────────────────────────────────────────────────

/**
 * The card-claim registry. EVERY mutation runs inside `withKeyedLock("claims")`, so the
 * read-modify-write of the whole file can never interleave with a concurrent acquire (the engine spawning
 * while an MCP session asks for the same card is exactly the race). All acquisition flows through the service
 * process (WS-3/D4), so this in-process lock IS the serialization — there is no cross-process contention to
 * cover here (and if that ever changes, the answer is a file lock in the STORE, not a harder claim).
 */
export class CardClaims implements CardClaimsPort {
  private loaded?: Promise<CardClaim[]>;
  private claims: CardClaim[] = [];
  private listeners = new Set<(claims: CardClaim[]) => void>();
  // Serialize persists so two mutations can never interleave a half-written file NOR land out of order (each
  // persist writes the WHOLE snapshot, so an out-of-order write would resurrect a stale set). Same chain the
  // journal uses. Callers never await it: the in-memory set is what arbitrates.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private store: ClaimStore) {}

  /**
   * Hydrate once. The in-memory set is AUTHORITATIVE for arbitration; the file only carries it across a
   * restart. When the store can hydrate synchronously we do (no await ⇒ the engine's admission never yields
   * on IO); otherwise we fall back to the async load, memoized so concurrent callers await the SAME promise
   * and none proceeds on a half-loaded set.
   */
  private ensureLoaded(): Promise<CardClaim[]> {
    if (this.loaded) return this.loaded;
    if (this.store.loadSync) {
      try {
        this.claims = this.store.loadSync();
        return (this.loaded = Promise.resolve(this.claims));
      } catch (err) {
        // A throwing loadSync must never wedge the registry (fail-open, like every read here).
        console.warn("[harness-claims] loadSync falhou — degradando p/ vazio:", err instanceof Error ? err.message : err);
        this.claims = [];
        return (this.loaded = Promise.resolve(this.claims));
      }
    }
    return (this.loaded = this.store
      .load()
      .catch(() => [] as CardClaim[])
      .then((rows) => {
        this.claims = rows;
        return rows;
      }));
  }

  /** WS-4.3 — the SSE wire: every claim change notifies subscribers (the stream re-broadcasts the snapshot). */
  subscribe(fn: (claims: CardClaim[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    const live = this.claims.filter((c) => !c.released);
    for (const fn of this.listeners) {
      try {
        fn(live);
      } catch {
        /* a listener throwing must never break the others (nor the acquisition) */
      }
    }
  }

  /**
   * Publish a new set: swap it in memory (authoritative + instant), notify subscribers, and SCHEDULE the
   * disk write on the serialized chain WITHOUT awaiting it. Not awaiting is deliberate: every acquire sits on
   * the run-admission path, and a reservation is not worth a blocking write — a crash between the swap and the
   * flush loses at most a reservation (fail-open: someone might redo work), never integrity, and boot
   * releases every run claim anyway. A persist failure is logged, never thrown at the caller.
   */
  private commit(next: CardClaim[]): void {
    this.claims = capReleased(next);
    const snapshot = this.claims;
    this.writeChain = this.writeChain.then(() =>
      this.store.persist(snapshot).catch((err) => {
        console.error("[harness-claims] persist falhou:", err instanceof Error ? err.message : err);
      }),
    );
    this.notify();
  }

  /** Await every scheduled write (tests / graceful shutdown) — mirrors RunnerJournal.flush(). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Reserve a card. Refuses (with the structured holder) when a LIVE conflicting claim exists (D8); the SAME
   * actor re-asking RENEWS instead of duplicating — a run's `--resume` and a session's heartbeat both land here.
   */
  async acquire(req: ClaimRequest): Promise<AcquireResult> {
    return withKeyedLock("claims", async () => {
      await this.ensureLoaded();
      const now = Date.now();
      const holder = findLiveConflict(this.claims, req, now);
      if (holder) return { ok: false, holder };
      const iso = new Date(now).toISOString();
      const prior = this.claims.find(
        (c) => c.board === req.board && c.cardId === req.cardId && c.actor === req.actor && !c.released,
      );
      const claim: CardClaim = {
        board: req.board,
        cardId: req.cardId,
        actor: req.actor,
        kind: req.kind,
        scope: req.scope,
        // A renew keeps the ORIGINAL acquiredAt (the age the fleet view shows is how long the actor has held
        // the card, not how long since the last heartbeat).
        acquiredAt: prior?.acquiredAt ?? iso,
        expiresAt: new Date(now + Math.max(0, req.ttlMs)).toISOString(),
        heartbeatAt: iso,
        ...(req.note !== undefined ? { note: req.note } : prior?.note !== undefined ? { note: prior.note } : {}),
      };
      const next = this.claims.filter(
        (c) => !(c.board === req.board && c.cardId === req.cardId && c.actor === req.actor && !c.released),
      );
      next.push(claim);
      this.commit(next);
      return { ok: true, claim };
    });
  }

  /**
   * Heartbeat: push a live claim's expiry out by `ttlMs`. Returns null when the actor holds no live claim on
   * the card (expired/never held) — the caller RE-ACQUIRES rather than resurrecting a lapsed reservation
   * (which could silently steal a card someone else legitimately took in the meantime).
   */
  async renew(board: string, cardId: string, actor: string, ttlMs: number): Promise<CardClaim | null> {
    return withKeyedLock("claims", async () => {
      await this.ensureLoaded();
      const now = Date.now();
      const cur = this.claims.find((c) => c.board === board && c.cardId === cardId && c.actor === actor);
      if (!cur || !isClaimLive(cur, now)) return null;
      const renewed: CardClaim = {
        ...cur,
        expiresAt: new Date(now + Math.max(0, ttlMs)).toISOString(),
        heartbeatAt: new Date(now).toISOString(),
      };
      this.commit(this.claims.map((c) => (c === cur ? renewed : c)));
      return renewed;
    });
  }

  /**
   * Give the reservation back. Idempotent + tolerant: releasing a claim that never existed (a run torn down
   * before it acquired) is a NO-OP, never a throw — every teardown path calls this blind.
   */
  async release(board: string, cardId: string, actor: string, reason: ClaimReleaseReason = "released"): Promise<void> {
    return withKeyedLock("claims", async () => {
      await this.ensureLoaded();
      const now = new Date().toISOString();
      let hit = false;
      const next = this.claims.map((c) => {
        if (c.board !== board || c.cardId !== cardId || c.actor !== actor || c.released) return c;
        hit = true;
        return { ...c, released: reason, releasedAt: now };
      });
      if (!hit) return;
      this.commit(next);
    });
  }

  /**
   * WS-4.4 — free every lapsed reservation (and, when the fleet probe names DEAD actors, theirs too), each
   * annotated with WHY (the steward's input). Returns the freed claims. Idempotent: a second sweep with
   * nothing to free performs no write.
   */
  async sweepExpired(deadActors: ReadonlySet<string> = new Set()): Promise<CardClaim[]> {
    return withKeyedLock("claims", async () => {
      await this.ensureLoaded();
      const { claims, released } = sweepClaims(this.claims, Date.now(), deadActors);
      if (!released.length) return [];
      this.commit(claims);
      for (const c of released) {
        console.log(`[harness-claims] liberado ${c.board}/${c.cardId} de ${c.actor} (${c.released})`);
      }
      return released;
    });
  }

  /** Live claims (optionally for one board). Tombstones are excluded — this answers "who holds what NOW". */
  async list(board?: string): Promise<CardClaim[]> {
    await this.ensureLoaded();
    const now = Date.now();
    return this.claims.filter((c) => isClaimLive(c, now) && (board === undefined || c.board === board));
  }

  /** Recently-freed reservations + why (steward/forensics — WS-8). Newest first. */
  async listReleased(board?: string): Promise<CardClaim[]> {
    await this.ensureLoaded();
    return this.claims
      .filter((c) => !!c.released && (board === undefined || c.board === board))
      .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
  }

  /**
   * The live claim blocking `req`, or null. A pure READ (no lock, no write) for the callers that must DECIDE
   * without reserving — the copiloto tick choosing a target (WS-4.2), the advisory warning a human sees.
   */
  async conflictFor(req: ClaimRequest): Promise<CardClaim | null> {
    await this.ensureLoaded();
    return findLiveConflict(this.claims, req, Date.now());
  }

  /**
   * WS-4.2 — the cards of `board` that some OTHER actor holds right now. The tick's target filter: it skips
   * these instead of spawning a copiloto onto a card an agent is already on. Cheap (in-memory) — the tick
   * calls it per board, per tick.
   */
  async claimedCardIds(board: string, exceptActor?: string): Promise<Set<string>> {
    const live = await this.list(board);
    return new Set(live.filter((c) => c.actor !== exceptActor).map((c) => c.cardId));
  }

  /**
   * WS-4.4 — boot reconciliation. EVERY `run:*` claim on disk belongs to a PREVIOUS life of the service (the
   * process that held it is gone), so none of them may keep reserving a card: recovery.ts re-spawns the runs
   * it can, and each respawn RE-ACQUIRES through the engine's chokepoint (same actor id → a clean re-take).
   * Without this, a crash mid-run would wedge that card behind an orphaned reservation until its TTL — the
   * exact deadlock-by-orphan the module header warns about. Session claims are NOT swept: they legitimately
   * survive a service restart (the session outlives us) and expire by their own TTL. Returns the freed count.
   */
  async releaseRunClaimsOnBoot(): Promise<number> {
    return withKeyedLock("claims", async () => {
      await this.ensureLoaded();
      const at = new Date().toISOString();
      let n = 0;
      const next = this.claims.map((c) => {
        if (c.released || !c.actor.startsWith("run:")) return c;
        n += 1;
        return { ...c, released: "superseded" as const, releasedAt: at };
      });
      if (!n) return 0;
      this.commit(next);
      console.log(`[harness-claims] boot: ${n} claim(s) de run de uma vida anterior liberado(s) (recovery re-adquire).`);
      return n;
    });
  }

  /** Tests / graceful shutdown: force the next read to hit the store again. */
  reset(): void {
    this.loaded = undefined;
    this.claims = [];
  }
}

const KEY = Symbol.for("storymap.runner.claims");
const store = globalThis as unknown as { [KEY]?: CardClaims };

/** The process-global registry (survives Next dev HMR via the Symbol store) — mirrors getRunnerJournal(). */
export function getCardClaims(): CardClaims {
  return (store[KEY] ??= new CardClaims(diskClaimStore(runnerStateDir())));
}

/**
 * TEST-ONLY: replace the process-global registry (e.g. with an in-memory one).
 *
 * Why this exists: module mocking (`vi.mock`) is unavailable on Bun, so this codebase isolates singletons by
 * DI. That works when a test constructs its subject through a harness, but the engine suite also builds
 * engines INLINE with positional args and can't reach the claims parameter without a wall of `undefined`s —
 * and then every such engine would share the REAL disk registry: a fake child that never settles would hold
 * `acme/story-1` forever, leaking a reservation into the next test AND into the next suite RUN (the file
 * persists). Swapping the singleton per test is the smallest honest fix. NEVER call this from product code.
 */
export function setCardClaimsSingletonForTests(claims: CardClaims): void {
  store[KEY] = claims;
}
