// pending-effects — the DURABLE ledger of onEnter effects a forward() has COMMITTED to but whose
// side-effect may not have completed. story-harness-adk A5 (the ADK "state_delta atomic before the next
// inference" under our topology): autorun-eval `forward` writes the new status to disk (durable) and then
// fires the onEnter effect (promote-stage / deploy-board / promote-and-deploy) FIRE-AND-FORGET. A crash in
// that window leaves the card advanced ("liberado"/"no ar") while the promote/deploy NEVER ran — and crash
// recovery (recovery.ts decideRecovery) NEVER re-fires an onEnter: it only respawns the skill or drops the
// run. So the forward↔effect step is the one non-transactional seam in the otherwise-durable machine.
//
// This ledger closes it: record the pending effect DURABLY (before the fire), resolve it on success, and
// re-fire any unresolved one ONCE on boot (recoverPendingEffects). The effects are idempotent + best-effort
// (entry-effects.ts), so a re-fire of an already-promoted stage is a no-op and a re-fire is always safe.
//
// Mirrors journal.ts: atomic tmp+rename persist, versioned + per-entry safeParse on load, an in-memory map
// fronting the disk, a serialized write chain. SERVER-ONLY (node:fs). Process-global singleton.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { EntryEffect } from "@/lib/storymap/types";

/** One onEnter effect a forward committed to but that may not have completed. Keyed by board/cardId/effect. */
export interface PendingEffectEntry {
  board: string;
  cardId: string;
  /** the effect the destination status declared (promote-stage / deploy-board / promote-and-deploy). */
  effect: EntryEffect;
  /** the destination status whose onEnter fired this effect — forensic; boot recovery validates the card still exists. */
  status: string;
  recordedAt: number;
}

/** Persistence port — disk by default, in-memory in tests (keeps the record/resolve logic fs-free + unit-testable). */
export interface PendingEffectStore {
  load(): Promise<PendingEffectEntry[]>;
  persist(entries: PendingEffectEntry[]): Promise<void>;
}

function keyOf(board: string, cardId: string, effect: EntryEffect): string {
  return `${board}/${cardId}/${effect}`;
}

export class PendingEffects {
  private entries = new Map<string, PendingEffectEntry>();
  // Memoized load PROMISE (every concurrent caller awaits the SAME resolution; MERGE never clobber, so a
  // record that landed during the load survives the stale disk copy) — exactly journal.ts's pattern.
  private loadOnce?: Promise<void>;
  // Serialize persists so a concurrent record/resolve can never interleave a half-written file.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private store: PendingEffectStore) {}

  private ensureLoaded(): Promise<void> {
    return (this.loadOnce ??= this.store
      .load()
      .catch(() => [] as PendingEffectEntry[])
      .then((rows) => {
        for (const e of rows) {
          const k = keyOf(e.board, e.cardId, e.effect);
          if (!this.entries.has(k)) this.entries.set(k, e);
        }
      }));
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(async () => {
      await this.store.persist([...this.entries.values()]).catch((err) => {
        console.error("[harness-pending-effects] persist failed:", err instanceof Error ? err.message : err);
      });
    });
  }

  /** Record (durably) that `effect` is pending for a card whose status just advanced. Call BEFORE firing. */
  async record(entry: PendingEffectEntry): Promise<void> {
    await this.ensureLoaded();
    this.entries.set(keyOf(entry.board, entry.cardId, entry.effect), entry);
    this.schedulePersist();
  }

  /** The effect completed → drop it. No-op if already gone (idempotent). */
  async resolve(board: string, cardId: string, effect: EntryEffect): Promise<void> {
    await this.ensureLoaded();
    if (this.entries.delete(keyOf(board, cardId, effect))) this.schedulePersist();
  }

  /** Every effect still un-resolved — boot recovery re-fires these once. */
  async loadPending(): Promise<PendingEffectEntry[]> {
    await this.ensureLoaded();
    return [...this.entries.values()];
  }

  /** Await all pending writes (the forward awaits this so the entry hits disk BEFORE the effect runs). */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

// PENDING_EFFECTS_VERSION — bump when the persisted shape changes incompatibly; load() drops a file whose
// version it doesn't recognize (the entries feed a re-fire of promote/deploy, so reading a foreign schema
// as-is is the footgun this guards).
const PENDING_EFFECTS_VERSION = 1;

// Tolerant shape contract for ONE persisted entry. `effect` stays loose (z.string) on purpose — an entry
// whose effect was renamed between boots is dropped at the re-fire (ENTRY_EFFECTS lookup-miss = no-op),
// not at load, so the file never silently loses a still-valid sibling over an unknown enum value.
const PendingEffectEntrySchema = z.object({
  board: z.string(),
  cardId: z.string(),
  effect: z.string(),
  status: z.string(),
  recordedAt: z.number(),
});

/** Atomic on-disk store: write a temp file then rename over the target (same fs). */
export function diskPendingEffectStore(dir: string): PendingEffectStore {
  const file = path.join(dir, "pending-effects.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        if (data?.version !== PENDING_EFFECTS_VERSION || !Array.isArray(data.entries)) return [];
        const valid: PendingEffectEntry[] = [];
        for (const r of data.entries) {
          const parsed = PendingEffectEntrySchema.safeParse(r);
          if (parsed.success) valid.push(parsed.data as PendingEffectEntry);
        }
        return valid;
      } catch {
        return []; // absent / unreadable / malformed JSON → start clean
      }
    },
    async persist(entries) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: PENDING_EFFECTS_VERSION, entries }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file); // atomic; overwrites on win32 via MoveFileEx
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

export interface PendingEffectRecoverySummary {
  pending: number;
  /** card still exists → effect re-fired (idempotent). */
  refired: number;
  /** card gone (deleted) → entry dropped without re-firing. */
  dropped: number;
  /** autorun/resumeOnBoot off → left in place for a later boot (NOT cleared). */
  skipped: number;
  /** card exists but the effect is NOT boot-safe (a product production deploy) → logged for the operator
   *  and cleared one-shot, never auto-fired on boot. */
  deferred: number;
  /** WS1.4: the re-fire threw → a finding was recorded on the card (still resolved one-shot). */
  failed: number;
}

/** DI surface for {@link recoverPendingEffects} — disk + the real effect dispatch in prod, fakes in tests. */
export interface PendingEffectRecoveryDeps {
  /** True only when autorun.enabled AND autorun.resumeOnBoot are both on (same gate as run recovery). */
  enabled: boolean;
  loadPending(): Promise<PendingEffectEntry[]>;
  resolve(board: string, cardId: string, effect: EntryEffect): Promise<void>;
  /** Does the card still exist on disk? A re-fire targets a real card only (a deleted one is just dropped). */
  cardExists(board: string, cardId: string): Promise<boolean>;
  /** Re-fire the effect (runEntryEffect) — idempotent + best-effort (never throws to here). The cardId
   *  is threaded so a deploy re-fired on boot can still revert THAT card if it fails (G3); the
   *  PendingEffectEntry already carries it, so a boot-recovered effect targets the right card. */
  runEffect(effect: EntryEffect, board: string, cardId?: string): Promise<void>;
  /**
   * Is this effect safe to AUTO-fire on boot for this board? Optional — absent ⇒ everything is boot-safe
   * (legacy/test behavior). A `promote-stage` is always safe (idempotent code promote, no deploy) and a
   * storymap self-deploy is safe (idempotent rebuild+restart); a PRODUCT deploy (orch-deploy) is NOT — a
   * production deploy must be human-initiated, never auto-fired after a restart. Un-safe effects are
   * deferred (logged + cleared one-shot), never re-fired.
   */
  isBootSafe?(effect: EntryEffect, board: string): Promise<boolean>;
  /**
   * WS1.4 — invoked when {@link PendingEffectRecoveryDeps.runEffect} THREW on a boot re-fire. Records a
   * `high` finding on the card (via {@link withPendingEffectFailureFinding}) so a re-deployed effect that
   * dies on boot is no longer swallowed by the old `.catch(() => {})` — the card advanced optimistically
   * and the operator must know the promote/deploy never landed. Optional (absent ⇒ legacy silent-catch,
   * for tests). Best-effort: this itself never throws (caller wraps it), and the effect is still
   * resolved one-shot regardless (a wedged effect must never re-deploy every boot).
   */
  onRefireFailure?(effect: EntryEffect, board: string, cardId: string, error: unknown): Promise<void>;
}

/**
 * Re-fire every onEnter effect a crash left un-resolved — ONCE, at boot. A re-fire is idempotent
 * (re-promoting already-promoted stage→main is a no-op; a storymap self-deploy rebuilds+restarts safely),
 * and each entry is resolved AFTER the single attempt so a wedged effect can never loop a re-deploy every
 * boot. A PRODUCT production deploy is NOT boot-safe (`isBootSafe` → false): it is DEFERRED (logged for the
 * operator + cleared one-shot), never auto-shipped after a restart. When autorun/resumeOnBoot is off the
 * entries are LEFT in place (skipped) — never auto-fire a deploy an operator disabled. Best-effort
 * throughout; mirrors recoverInterruptedRuns' shape (summary the caller logs). WS1.4: a re-fire that
 * THROWS is counted (`failed`) and reported via {@link PendingEffectRecoveryDeps.onRefireFailure} (a
 * finding on the card) instead of being swallowed — the effect is still resolved one-shot either way.
 */
export async function recoverPendingEffects(deps: PendingEffectRecoveryDeps): Promise<PendingEffectRecoverySummary> {
  const pending = await deps.loadPending();
  const summary: PendingEffectRecoverySummary = { pending: pending.length, refired: 0, dropped: 0, skipped: 0, deferred: 0, failed: 0 };
  if (!pending.length) return summary;
  if (!deps.enabled) {
    summary.skipped = pending.length; // leave them for a boot where resume is on (don't clear, don't fire)
    return summary;
  }
  for (const e of pending) {
    const exists = await deps.cardExists(e.board, e.cardId).catch(() => false);
    if (!exists) {
      summary.dropped += 1;
    } else if (deps.isBootSafe && !(await deps.isBootSafe(e.effect, e.board).catch(() => true))) {
      // NOT boot-safe (a product production deploy). Never auto-ship prod after a restart — surface it for
      // the operator and clear it one-shot (so it doesn't re-log every boot). The card already advanced;
      // the operator re-deploys via harness-ship / `just orch-deploy <pkg>` or by re-dragging the card.
      console.warn(
        `[harness-pending-effects] DEFERIDO no boot: efeito "${e.effect}" do board "${e.board}" (card ${e.cardId}) NÃO foi re-disparado — um deploy de produção não auto-dispara no boot. Rode o deploy manualmente (harness-ship / just orch-deploy) ou rearraste o card.`,
      );
      summary.deferred += 1;
    } else {
      // WS1.4: a re-fire that THROWS is no longer swallowed — record a finding on the card so the operator
      // sees that the promote/deploy the card optimistically advanced on never actually landed. Still
      // resolved one-shot below (the effect is idempotent + best-effort; never loop a re-deploy each boot).
      let refireError: unknown;
      await deps.runEffect(e.effect, e.board, e.cardId).catch((err) => {
        refireError = err ?? new Error("re-fire falhou sem erro");
      });
      if (refireError !== undefined) {
        summary.failed += 1;
        if (deps.onRefireFailure) {
          await deps.onRefireFailure(e.effect, e.board, e.cardId, refireError).catch((err) => {
            console.error("[harness-pending-effects] onRefireFailure falhou:", err instanceof Error ? err.message : err);
          });
        }
      } else {
        summary.refired += 1;
      }
    }
    // One-shot: resolve after the single boot attempt either way, so a stuck effect never re-deploys each boot.
    await deps.resolve(e.board, e.cardId, e.effect).catch(() => {});
  }
  return summary;
}

const KEY = Symbol.for("storymap.runner.pendingEffects");
const store = globalThis as unknown as { [KEY]?: PendingEffects };

export function getPendingEffects(): PendingEffects {
  return (store[KEY] ??= new PendingEffects(diskPendingEffectStore(runnerStateDir())));
}
