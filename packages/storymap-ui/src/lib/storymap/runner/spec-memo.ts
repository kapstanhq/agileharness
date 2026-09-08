// Spec memoization — author each acceptance spec ONCE, reuse it while its criterion is unchanged
// (ADR-063 Fase 5b). The complement to 5a: where 5a decides which criteria to RUN (only the diff since
// the last green), 5b decides which to AUTHOR — a criterion whose text + layer are unchanged since it was
// last synthesized reuses the cached runnable spec instead of paying the LLM to re-author it per run.
//
// Where the other 5b surfaces already live:
//   - "stack quente cacheado" → Fase 1b (the persistent seeded QA systemd units — QA connects, never
//     cold-boots) + 1c (the health contract). Nothing to add here.
//   - "discovery cacheado" → Fase 3c (the route→component + testid registry build artifact).
// The gap 5b closes HERE is the PRE-AUTHORED-SPEC cache: memoize the authored spec keyed by a content
// hash of (layer + criterion), so re-authoring is skipped whenever the criterion didn't change.
//
// PURE over an injected store (mirrors diskMergeQueueStore / diskTestQueueStore): the memo logic is
// unit-testable with an in-memory store, no disk. Versioned + per-entry safeParse on load (a foreign /
// malformed entry is dropped, never trusted into a run).

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AcceptanceSpec } from "./qa-runner";
import type { VerificationLayer } from "../verification-ladder";

/** One memoized authored spec: a criterion (at a layer) → the runnable spec that proves it. */
export interface SpecMemoEntry {
  /** Content hash of (layer + normalized criterion) — the memo key; a criterion edit changes it → miss. */
  hash: string;
  criterion: string;
  layer: VerificationLayer;
  /** Path to the authored runnable spec (relative), reused verbatim while the hash matches. */
  specPath: string;
  /** epoch-ms the spec was authored (observability / staleness). */
  authoredAt: number;
}

const SPEC_MEMO_VERSION = 1;

const SpecMemoEntrySchema = z.object({
  hash: z.string(),
  criterion: z.string(),
  layer: z.enum(["component", "integration", "browser"]),
  specPath: z.string(),
  authoredAt: z.number(),
});

/** Persistence port — disk by default, in-memory in tests. Mirrors the other runner stores. */
export interface SpecMemoStore {
  load(): Promise<SpecMemoEntry[]>;
  persist(entries: SpecMemoEntry[]): Promise<void>;
}

/**
 * The memo key for a criterion at a layer: sha1 of `${layer}\n${normalized criterion}`. Normalization
 * (trim + collapse internal whitespace) makes a reflow-only edit (re-wrapping, trailing spaces) a HIT,
 * while a real wording/layer change is a MISS. Stable + deterministic → the same criterion always keys
 * the same slot. Exported so a caller can pre-compute keys.
 */
export function criterionHash(criterion: string, layer: string): string {
  const normalized = criterion.trim().replace(/\s+/g, " ");
  return createHash("sha1").update(`${layer}\n${normalized}`).digest("hex");
}

/** The split of a planned suite by memo state: reuse the cached authored specs, author only the rest. */
export interface SpecRecall {
  /** Specs whose authored spec is cached (specPath populated from the memo) — NO re-author. */
  cached: AcceptanceSpec[];
  /** Specs with no valid cache entry — author now (then `remember` them). */
  toAuthor: AcceptanceSpec[];
}

/** The memo surface the QA planner depends on (DI — an in-memory store in tests). */
export interface SpecMemo {
  /** Split planned specs into cached (reuse) vs. toAuthor (miss). Cached specs carry their memo specPath. */
  recall(specs: AcceptanceSpec[]): SpecRecall;
  /** One criterion's cached entry, or null on a miss (absent / criterion changed). */
  lookup(criterion: string, layer: string): SpecMemoEntry | null;
  /** Record a freshly-authored spec so the next run reuses it (upsert by hash). */
  remember(spec: AcceptanceSpec, specPath: string): void;
  /** Persist the memo to disk (best-effort; a caller flushes after authoring a batch). */
  flush(): Promise<void>;
  /** Every live entry — for observability. */
  entries(): SpecMemoEntry[];
}

/**
 * Build a {@link SpecMemo} over a store + a preloaded seed. `recall` is a pure lookup (no IO); `remember`
 * mutates the in-memory map; `flush` persists. Construct with the loaded entries (see {@link loadSpecMemo})
 * so `recall` is synchronous on the hot path. PURE over the injected store + clock.
 */
export function makeSpecMemo(deps: { store: SpecMemoStore; seed?: SpecMemoEntry[]; now?: () => number }): SpecMemo {
  const now = deps.now ?? (() => Date.now());
  const byHash = new Map<string, SpecMemoEntry>();
  for (const e of deps.seed ?? []) byHash.set(e.hash, e);

  const lookup = (criterion: string, layer: string): SpecMemoEntry | null => {
    const hit = byHash.get(criterionHash(criterion, layer));
    // Guard against a hash collision / layer drift: the stored entry must match the queried layer.
    return hit && hit.layer === layer ? hit : null;
  };

  return {
    lookup,
    recall(specs) {
      const cached: AcceptanceSpec[] = [];
      const toAuthor: AcceptanceSpec[] = [];
      for (const spec of specs) {
        const hit = lookup(spec.criterion, spec.layer);
        if (hit) cached.push({ ...spec, specPath: hit.specPath });
        else toAuthor.push(spec);
      }
      return { cached, toAuthor };
    },
    remember(spec, specPath) {
      const hash = criterionHash(spec.criterion, spec.layer);
      byHash.set(hash, { hash, criterion: spec.criterion, layer: spec.layer, specPath, authoredAt: now() });
    },
    async flush() {
      await deps.store.persist([...byHash.values()]);
    },
    entries() {
      return [...byHash.values()];
    },
  };
}

/** Load the memo from its store and construct it (the async convenience over {@link makeSpecMemo}). */
export async function loadSpecMemo(store: SpecMemoStore, now?: () => number): Promise<SpecMemo> {
  const seed = await store.load().catch(() => [] as SpecMemoEntry[]);
  return makeSpecMemo({ store, seed, now });
}

/**
 * Disk-backed {@link SpecMemoStore} (JSON, versioned + per-entry safeParse — mirrors diskMergeQueueStore /
 * diskTestQueueStore). One file per board so two boards' memos never contend. Atomic write via tmp+rename.
 */
export function diskSpecMemoStore(dir: string, board: string): SpecMemoStore {
  const safeBoard = board.replace(/[^a-z0-9-]/gi, "_");
  const file = path.join(dir, `spec-memo-${safeBoard}.json`);
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        if (data?.version !== SPEC_MEMO_VERSION || !Array.isArray(data.entries)) return [];
        const valid: SpecMemoEntry[] = [];
        for (const e of data.entries) {
          const parsed = SpecMemoEntrySchema.safeParse(e);
          if (parsed.success) valid.push(parsed.data);
        }
        return valid;
      } catch {
        return []; // absent / unreadable / malformed → start clean
      }
    },
    async persist(entries) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: SPEC_MEMO_VERSION, entries }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file);
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}
