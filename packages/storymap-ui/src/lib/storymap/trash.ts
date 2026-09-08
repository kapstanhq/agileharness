// trash.ts — autonomo-liberdade-humana M2 — the SOFT-DELETE quarantine for board data.
//
// A deleted card/persona/system is not destroyed: it moves to `boards/<b>/.trash/` with a restore MANIFEST
// (this module), `restore_deleted` puts it back, and a 7-day GC (runner/trash-gc.ts) prunes the pair. That undo
// is the whole reason `delete_*` may be `reversible-delete` (mountable at the autonomous orch token) instead of
// `destructive` (human-only). PRODUCTION data deletion (`approve_data_deletion`, a Firestore wipe) is NOT this —
// it stays irreversible and human. The trash covers git-tracked board data, never a database.
//
// The manifest is a SIDECAR JSON, not a card field — a trashed card's `.md` LEAVES `cards/`, so the card
// serializer/schema never touch it. The card FILE move itself lives in write.ts (it needs the per-card lock);
// this module owns the manifest I/O, the listing, and the pair-removal that both restore and GC use.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { TrashManifest } from "./types";
import { trashDir, trashManifestPath, trashedCardPath } from "./paths";
import { scheduleBoardDataFlush } from "./runner/board-data-flush";

const VALID_KINDS = new Set<TrashManifest["kind"]>(["card", "persona", "system"]);

/** Validate a raw manifest read from disk. Returns null on anything malformed (fail-safe: a broken manifest is
 *  simply not listed/restorable, never a crash). PURE — exported for tests. */
export function coerceTrashManifest(raw: unknown): TrashManifest | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const kind = r.kind as TrashManifest["kind"];
  if (!VALID_KINDS.has(kind)) return null;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return null;
  return {
    kind,
    id,
    by: typeof r.by === "string" ? r.by : "unknown",
    at: typeof r.at === "string" ? r.at : new Date().toISOString(),
    reason: typeof r.reason === "string" ? r.reason : undefined,
    restorePath: typeof r.restorePath === "string" ? r.restorePath : undefined,
    object: "object" in r ? r.object : undefined,
    strippedRefs: Array.isArray(r.strippedRefs) ? r.strippedRefs.filter((x): x is string => typeof x === "string") : undefined,
  };
}

/** Write (or overwrite) a restore manifest into the board's `.trash/`. Versions it via the debounced board-data
 *  flush, exactly like the governance sidecars. */
export async function writeTrashManifest(boardId: string, manifest: TrashManifest): Promise<void> {
  await fs.mkdir(trashDir(boardId), { recursive: true });
  await fs.writeFile(trashManifestPath(boardId, manifest.kind, manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  scheduleBoardDataFlush();
}

/** Read ONE restore manifest, or null if absent/malformed. */
export async function readTrashManifest(boardId: string, kind: TrashManifest["kind"], id: string): Promise<TrashManifest | null> {
  try {
    const raw = await fs.readFile(trashManifestPath(boardId, kind, id), "utf8");
    return coerceTrashManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** List every valid restore manifest in a board's `.trash/` (all kinds). Absent dir ⇒ []. */
export async function listTrashManifests(boardId: string): Promise<TrashManifest[]> {
  let files: string[];
  try {
    files = await fs.readdir(trashDir(boardId));
  } catch {
    return [];
  }
  const out: TrashManifest[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(trashDir(boardId), f), "utf8");
      const m = coerceTrashManifest(JSON.parse(raw));
      if (m) out.push(m);
    } catch {
      /* skip a broken sidecar rather than fail the whole listing */
    }
  }
  return out;
}

/** Remove a trash ENTRY entirely — the manifest and, for a card, the trashed `.md`. Used by BOTH restore (after
 *  it re-materializes the entry) and the GC (after the 7-day window). Best-effort per file. */
export async function removeTrashEntry(boardId: string, manifest: Pick<TrashManifest, "kind" | "id">): Promise<void> {
  await fs.rm(trashManifestPath(boardId, manifest.kind, manifest.id), { force: true }).catch(() => {});
  if (manifest.kind === "card") await fs.rm(trashedCardPath(boardId, manifest.id), { force: true }).catch(() => {});
  scheduleBoardDataFlush();
}

/** How many whole days old a manifest is, from its `at` stamp against `now`. PURE — exported for the GC + tests.
 *  A malformed/future `at` yields 0 (never GC'd early — fail-safe toward KEEPING the entry). */
export function trashAgeDays(manifest: Pick<TrashManifest, "at">, now: number): number {
  const at = Date.parse(manifest.at);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / (24 * 60 * 60 * 1000)));
}
