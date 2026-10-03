import { describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  PendingSelfDeploy,
  diskPendingSelfDeployStore,
  type PendingSelfDeployStore,
  type PendingSelfDeployEntry,
} from "./pending-self-deploy";

/** In-memory store — the single-slot queue logic under test never needs the fs. */
function memStore(): PendingSelfDeployStore {
  let slot: PendingSelfDeployEntry | null = null;
  return {
    async load() {
      return slot;
    },
    async persist(entry) {
      slot = entry;
    },
  };
}

describe("PendingSelfDeploy — durable single-slot re-dispatch queue (1.5)", () => {
  it("enqueue → take returns the entry then CLEARS it (a 2nd take is null)", async () => {
    const q = new PendingSelfDeploy(memStore());
    await q.enqueue("storymap", "story-a");
    const first = await q.take();
    expect(first).toMatchObject({ board: "storymap", cardId: "story-a" });
    expect(typeof first!.recordedAt).toBe("number");
    expect(await q.take()).toBeNull(); // slot cleared
  });

  it("peek returns the slot WITHOUT clearing it", async () => {
    const q = new PendingSelfDeploy(memStore());
    await q.enqueue("storymap", "story-a");
    expect(await q.peek()).toMatchObject({ cardId: "story-a" });
    expect(await q.peek()).toMatchObject({ cardId: "story-a" }); // still there
    expect(await q.take()).toMatchObject({ cardId: "story-a" });
  });

  it("last-writer-wins: a 2nd enqueue overwrites the single slot", async () => {
    const q = new PendingSelfDeploy(memStore());
    await q.enqueue("storymap", "story-a");
    await q.enqueue("storymap", "story-b");
    expect(await q.take()).toMatchObject({ cardId: "story-b" });
    expect(await q.take()).toBeNull();
  });

  it("persists to disk so a FRESH instance (post-restart process) reads the parked slot", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "psd-"));
    try {
      const q1 = new PendingSelfDeploy(diskPendingSelfDeployStore(dir));
      await q1.enqueue("storymap", "story-x"); // enqueue AWAITS the persist — durability is load-bearing
      // a NEW instance (the self-deploy restarted storymap → new process) must find it on disk:
      const q2 = new PendingSelfDeploy(diskPendingSelfDeployStore(dir));
      expect(await q2.peek()).toMatchObject({ board: "storymap", cardId: "story-x" });
      expect(await q2.take()).toMatchObject({ cardId: "story-x" });
      // take cleared it on disk too:
      const q3 = new PendingSelfDeploy(diskPendingSelfDeployStore(dir));
      expect(await q3.peek()).toBeNull();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("disk load drops a foreign version / malformed entry (starts empty)", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "psd-"));
    try {
      const file = path.join(dir, "pending-self-deploy.json");
      await fsp.writeFile(file, JSON.stringify({ version: 999, entry: { board: "x", cardId: "y", recordedAt: 1 } }));
      expect(await new PendingSelfDeploy(diskPendingSelfDeployStore(dir)).peek()).toBeNull(); // unknown version → ignored
      await fsp.writeFile(file, JSON.stringify({ version: 1, entry: { board: "x" } })); // missing fields
      expect(await new PendingSelfDeploy(diskPendingSelfDeployStore(dir)).peek()).toBeNull(); // safeParse fails → empty
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
