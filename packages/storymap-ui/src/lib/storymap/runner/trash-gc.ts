// trash-gc.ts — autonomo-liberdade-humana M2 — the 7-day GC for the soft-delete quarantine (`.trash/`).
//
// Deletion is reversible for a WINDOW, not forever: this GC prunes trash entries whose restore manifest `at` is
// older than {@link TRASH_GC_AFTER_DAYS}, so the quarantine doesn't grow without bound. It piggybacks the SAME
// idle sweep window as branch-gc (recovery-sweep.ts), but unlike that one it runs NO git — just board-data fs
// ops — so it never fights the merge train. Best-effort: a per-board or per-entry failure is skipped, never
// thrown; a GC error never demotes a successful recovery tick. Journals each harvest to trash-gc.jsonl.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { listBoards } from "@/lib/storymap/repo";
import { listTrashManifests, removeTrashEntry, trashAgeDays } from "@/lib/storymap/trash";
import type { TrashManifest } from "@/lib/storymap/types";

/** The quarantine window. Mirrors branch-gc's 7-day harvest — long enough for an operator to notice a mistaken
 *  delete, short enough that the trash doesn't accrete. */
export const TRASH_GC_AFTER_DAYS = 7;

export interface TrashGcJournalEntry {
  at: string; // ISO — when it was harvested
  board: string;
  kind: string;
  id: string;
  ageDays: number;
}

export async function appendTrashGcJournal(entry: TrashGcJournalEntry): Promise<void> {
  try {
    await fsp.appendFile(path.join(runnerStateDir(), "trash-gc.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("[trash-gc] journal append falhou:", err instanceof Error ? err.message : err);
  }
}

export interface TrashGcDeps {
  /** clock (tests). */
  now?: number;
  /** override the window (tests). */
  afterDays?: number;
  /** board source (tests); defaults to the real listBoards. */
  boards?: () => Promise<{ id: string }[]>;
  /** manifest source per board (tests); defaults to the real listTrashManifests. */
  list?: (boardId: string) => Promise<TrashManifest[]>;
  /** prune one entry (tests); defaults to the real removeTrashEntry. */
  remove?: (boardId: string, m: Pick<TrashManifest, "kind" | "id">) => Promise<void>;
  /** journal sink (tests); defaults to the real jsonl append. */
  journal?: (entry: TrashGcJournalEntry) => Promise<void>;
}

/**
 * Prune every trash entry older than the window across all boards. Returns the number harvested. Never throws —
 * a board that fails to read is skipped, a per-entry failure is swallowed (best-effort by contract). The ageing
 * decision ({@link trashAgeDays}) is pure; all IO is injectable, so the prune-only-past-the-window logic is
 * unit-tested with no filesystem.
 */
export async function runTrashGc(deps: TrashGcDeps = {}): Promise<number> {
  const now = deps.now ?? Date.now();
  const afterDays = deps.afterDays ?? TRASH_GC_AFTER_DAYS;
  const list = deps.list ?? listTrashManifests;
  const remove = deps.remove ?? removeTrashEntry;
  const journal = deps.journal ?? appendTrashGcJournal;
  let boards: { id: string }[];
  try {
    boards = deps.boards ? await deps.boards() : await listBoards();
  } catch {
    return 0;
  }
  let harvested = 0;
  for (const b of boards) {
    let manifests: TrashManifest[];
    try {
      manifests = await list(b.id);
    } catch {
      continue;
    }
    for (const m of manifests) {
      const ageDays = trashAgeDays(m, now);
      if (ageDays < afterDays) continue;
      try {
        await remove(b.id, m);
        harvested += 1;
        await journal({ at: new Date(now).toISOString(), board: b.id, kind: m.kind, id: m.id, ageDays });
      } catch {
        /* best-effort per entry — a failed prune is retried next sweep */
      }
    }
  }
  return harvested;
}
