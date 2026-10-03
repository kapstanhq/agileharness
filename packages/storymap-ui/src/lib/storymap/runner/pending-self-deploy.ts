// pending-self-deploy — a DURABLE single-slot re-dispatch queue for the storymap SELF-deploy. 1.5: a second
// self-deploy that fires while the FIRST is still building can't start — systemd-run refuses a duplicate of
// the fixed `storymap-deploy` unit, so deployBoard returns `{fired:false, inFlight:true}`. Without this the
// 2nd card then sits in "No ar" with NO deployFiredAt, NO settle webhook and NO watchdog: a SILENT TERMINAL.
// This store parks that card; the in-flight deploy's settle (deploy-webhook) takes it and re-dispatches.
//
// Durability is LOAD-BEARING: the first self-deploy RESTARTS the process, so an in-memory slot would be lost.
// The detached systemd unit SURVIVES the restart and POSTs its settle to the NEW process, which must find the
// parked card ON DISK. One slot suffices (last-writer-wins): only ONE self-deploy can be in flight at a time,
// so at most one card is waiting behind it.
//
// Mirrors pending-effects.ts: atomic tmp+rename persist, versioned + safeParse load, a serialized write chain.
// SERVER-ONLY (node:fs). Process-global singleton.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runnerStateDir } from "@/lib/storymap/paths";

/** The one card waiting to self-deploy behind an in-flight self-deploy. */
export interface PendingSelfDeployEntry {
  board: string;
  cardId: string;
  recordedAt: number;
}

/** Persistence port — disk by default, in-memory in tests (keeps the queue logic fs-free + unit-testable). */
export interface PendingSelfDeployStore {
  load(): Promise<PendingSelfDeployEntry | null>;
  persist(entry: PendingSelfDeployEntry | null): Promise<void>;
}

export class PendingSelfDeploy {
  private slot: PendingSelfDeployEntry | null = null;
  private loadOnce?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private store: PendingSelfDeployStore) {}

  private ensureLoaded(): Promise<void> {
    return (this.loadOnce ??= this.store
      .load()
      .catch(() => null)
      .then((row) => {
        // Only adopt disk state if nothing was enqueued in-memory during the load (record-wins, like journal.ts).
        if (row && this.slot === null) this.slot = row;
      }));
  }

  private schedulePersist(): void {
    const snapshot = this.slot;
    this.writeChain = this.writeChain.then(async () => {
      await this.store.persist(snapshot).catch((err) => {
        console.error("[harness-pending-self-deploy] persist failed:", err instanceof Error ? err.message : err);
      });
    });
  }

  /**
   * Park a card to re-dispatch once the in-flight self-deploy settles. Last-writer-wins (one slot). AWAITS the
   * persist: durability is load-bearing (the in-flight deploy restarts the process before the settle arrives),
   * so the slot MUST be on disk before this resolves.
   */
  async enqueue(board: string, cardId: string): Promise<void> {
    await this.ensureLoaded();
    this.slot = { board, cardId, recordedAt: Date.now() };
    this.schedulePersist();
    await this.flush();
  }

  /** Atomically read AND clear the slot — the settle handler re-dispatches whatever this returns. */
  async take(): Promise<PendingSelfDeployEntry | null> {
    await this.ensureLoaded();
    const entry = this.slot;
    if (entry !== null) {
      this.slot = null;
      this.schedulePersist();
      await this.flush();
    }
    return entry;
  }

  /** Peek without clearing (diagnostics / a cockpit surface). */
  async peek(): Promise<PendingSelfDeployEntry | null> {
    await this.ensureLoaded();
    return this.slot;
  }

  /** Await all pending writes. */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

// Bump when the persisted shape changes incompatibly; load() drops a file whose version it doesn't recognize.
const PENDING_SELF_DEPLOY_VERSION = 1;

const PendingSelfDeployEntrySchema = z.object({
  board: z.string(),
  cardId: z.string(),
  recordedAt: z.number(),
});

/** Atomic on-disk store: write a temp file then rename over the target. A null slot persists an empty entry. */
export function diskPendingSelfDeployStore(dir: string): PendingSelfDeployStore {
  const file = path.join(dir, "pending-self-deploy.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        if (data?.version !== PENDING_SELF_DEPLOY_VERSION || data.entry == null) return null;
        const parsed = PendingSelfDeployEntrySchema.safeParse(data.entry);
        return parsed.success ? (parsed.data as PendingSelfDeployEntry) : null;
      } catch {
        return null; // absent / unreadable / malformed JSON → empty slot
      }
    },
    async persist(entry) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: PENDING_SELF_DEPLOY_VERSION, entry: entry ?? null }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file); // atomic; overwrites on win32 via MoveFileEx
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

const KEY = Symbol.for("storymap.runner.pendingSelfDeploy");
const store = globalThis as unknown as { [KEY]?: PendingSelfDeploy };

export function getPendingSelfDeploy(): PendingSelfDeploy {
  return (store[KEY] ??= new PendingSelfDeploy(diskPendingSelfDeployStore(runnerStateDir())));
}
