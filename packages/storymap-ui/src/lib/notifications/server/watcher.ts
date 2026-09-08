// Filesystem watcher — the event SOURCE. Watches storymap/boards/ recursively
// and turns every persisted change into a AgileHarnessEvent. Because it sits at the
// file layer, it catches BOTH the UI's server-action writes AND an agent editing
// a card .md directly — one mechanism, both sources.
//
// Classification is diff-based, not eventType-based (fs.watch eventType is
// unreliable across OSes): on any change under a board we re-read that board,
// diff the fresh cards against an in-memory snapshot, and emit created / moved /
// updated / deleted accordingly. board.yaml changes emit board.updated.
//
// Idempotent singleton (survives HMR via a process-global flag).

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { boardsDir } from "@/lib/storymap/paths";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { riceScore } from "@/lib/storymap/rice";
import { cardDemands, dominantDemand } from "@/lib/storymap/demands";
import type { Card } from "@/lib/storymap/types";
import type { AgileHarnessEvent } from "../event";
import { getDispatcher } from "./dispatcher";

interface CardSnap {
  sig: string; // full-card signature → detects any content edit
  status: string | null;
  title: string;
  type: Card["type"];
  parent: string | null;
  release: string | null;
}
type BoardSnap = Map<string, CardSnap>;

interface WatcherState {
  started: boolean;
  watcher?: FSWatcher;
  snapshots: Map<string, BoardSnap>; // boardId → (cardId → snap)
  debounce: Map<string, ReturnType<typeof setTimeout>>; // boardId → timer
  seq: number;
}

const KEY = Symbol.for("storymap.notifications.watcher");
const store = globalThis as unknown as { [KEY]?: WatcherState };

function state(): WatcherState {
  return (store[KEY] ??= {
    started: false,
    snapshots: new Map(),
    debounce: new Map(),
    seq: 0,
  });
}

// Dev HMR: when this module re-evaluates, the live fs.watch callback still closes
// over the OLD code. Drop the stale watcher so the next SSE connection re-attaches
// with fresh code. No-op in production (module evaluates exactly once).
(() => {
  const s = store[KEY];
  if (s?.watcher) {
    s.watcher.close();
    s.watcher = undefined;
    s.started = false;
  }
})();

const DEBOUNCE_MS = 150;

function cardSignature(card: Card): string {
  // Exclude updatedMs (the file mtime): it changes on EVERY write, so leaving it in
  // would make any touch — even a byte-identical rewrite — look like a content change
  // and emit a spurious card.updated (→ SSE → router.refresh → re-fetch). The diff we
  // want is "did the card's CONTENT change", which the remaining fields capture; a
  // genuine same-day edit still differs (some field moved), and a status change is
  // detected separately (before.status !== card.status → card.moved).
  // (JSON.stringify drops keys whose value is undefined, so this omits updatedMs.)
  return JSON.stringify({ ...card, updatedMs: undefined });
}

function roundRice(score: number | null): number | null {
  return score == null ? null : Math.round(score * 10) / 10;
}

function snapOf(card: Card): CardSnap {
  return {
    sig: cardSignature(card),
    status: card.status,
    title: card.title,
    type: card.type,
    parent: card.parent,
    release: card.release,
  };
}

async function buildBoardSnapshot(boardId: string): Promise<BoardSnap> {
  const snap: BoardSnap = new Map();
  for (const card of await readCards(boardId).catch(() => [] as Card[])) {
    snap.set(card.id, snapOf(card));
  }
  return snap;
}

function nextEvent(s: WatcherState, e: Omit<AgileHarnessEvent, "id" | "at">): AgileHarnessEvent {
  return { ...e, id: `${Date.now()}-${s.seq++}`, at: Date.now() };
}

/** Diff one board's fresh cards against the snapshot and emit the deltas. */
async function reconcileBoard(boardId: string): Promise<void> {
  const s = state();
  const firstSight = !s.snapshots.has(boardId);
  const prev = s.snapshots.get(boardId) ?? new Map<string, CardSnap>();
  const cards = await readCards(boardId).catch(() => null);
  if (cards === null) return; // transient read error mid-write; next event retries

  // First time this board is EVER reconciled (a folder created after startup, or one
  // absent at seed time) → populate the snapshot silently, WITHOUT emitting events.
  // Otherwise every pre-existing card would diff as card.created and the trigger-runner
  // would fire autorun for all of them at once (a spawn storm of opus/max runs).
  // ensureWatching seeds boards present at startup, so this only guards the truly-new.
  if (firstSight) {
    const seed: BoardSnap = new Map();
    for (const card of cards) seed.set(card.id, snapOf(card));
    s.snapshots.set(boardId, seed);
    return;
  }

  // Resolve human-friendly names from board.yaml + the current card set, so the
  // emitted events carry ready-to-render context (status/release/parent names).
  const config = await readBoardConfig(boardId).catch(() => null);
  const boardName = config?.name ?? boardId;
  const statusName = (id: string | null | undefined) =>
    (id && config?.statuses.find((x) => x.id === id)?.name) || id || null;
  const releaseName = (id: string | null | undefined) =>
    (id && config?.releases.find((x) => x.id === id)?.name) || id || null;
  // "Chegou ao FIM do pipeline?" — lido do board.yaml, nunca de um id conhecido no código (o
  // AgileHarness é genérico: cada board define seus passos e quais terminam). Ausência de config é
  // `false`, não um palpite: comemorar uma entrega que não aconteceu é pior que não comemorar.
  const isTerminal = (id: string | null | undefined) =>
    Boolean(id && config?.statuses.find((x) => x.id === id)?.terminal);
  const titleById = new Map(cards.map((c) => [c.id, c.title]));
  const parentTitle = (parent: string | null) => (parent ? titleById.get(parent) ?? null : null);

  const next: BoardSnap = new Map();
  const events: AgileHarnessEvent[] = [];

  for (const card of cards) {
    next.set(card.id, snapOf(card));
    // The card's dominant pending human demand (if any) rides EVERY event for the card, so the
    // notification layer can alert on a demand that appears with NO move (harness-grill writing questions
    // in place — story-rl5v03). web-push dedupes per card by type + skips card.created (capture storms).
    const dom = config ? dominantDemand(cardDemands(card, config, boardId)) : null;
    const meta = {
      boardName,
      statusName: statusName(card.status),
      releaseName: releaseName(card.release),
      parentTitle: parentTitle(card.parent),
      riceScore: card.type === "story" ? roundRice(riceScore(card.rice)) : null,
      demand: dom ? { type: dom.type, label: dom.label, severity: dom.severity, count: dom.count } : undefined,
    };
    const before = prev.get(card.id);
    if (!before) {
      events.push(
        nextEvent(s, { type: "card.created", boardId, cardId: card.id, cardType: card.type, title: card.title, ...meta }),
      );
    } else if (before.status !== card.status) {
      events.push(
        nextEvent(s, {
          type: "card.moved",
          boardId,
          cardId: card.id,
          cardType: card.type,
          title: card.title,
          fromStatus: before.status,
          toStatus: card.status,
          fromStatusName: statusName(before.status),
          toStatusName: statusName(card.status),
          toTerminal: isTerminal(card.status),
          ...meta,
        }),
      );
    } else if (before.sig !== cardSignature(card)) {
      events.push(
        nextEvent(s, { type: "card.updated", boardId, cardId: card.id, cardType: card.type, title: card.title, ...meta }),
      );
    }
  }

  for (const [cardId, before] of prev) {
    if (!next.has(cardId)) {
      events.push(
        nextEvent(s, {
          type: "card.deleted",
          boardId,
          cardId,
          cardType: before.type,
          title: before.title,
          boardName,
          statusName: statusName(before.status),
          parentTitle: parentTitle(before.parent),
        }),
      );
    }
  }

  s.snapshots.set(boardId, next);

  const dispatcher = getDispatcher();
  for (const event of events) void dispatcher.dispatch(event);
}

async function emitBoardConfigChanged(boardId: string): Promise<void> {
  const s = state();
  const boardName = (await readBoardConfig(boardId).catch(() => null))?.name ?? boardId;
  void getDispatcher().dispatch(nextEvent(s, { type: "board.updated", boardId, boardName }));
}

function scheduleBoard(boardId: string, fn: () => void): void {
  const s = state();
  const existing = s.debounce.get(boardId);
  if (existing) clearTimeout(existing);
  s.debounce.set(
    boardId,
    setTimeout(() => {
      s.debounce.delete(boardId);
      fn();
    }, DEBOUNCE_MS),
  );
}

/** Start watching (idempotent). Safe to call on every SSE connection. */
export async function ensureWatching(): Promise<void> {
  const s = state();
  if (s.started) return;
  s.started = true;

  const dir = boardsDir();
  if (!existsSync(dir)) {
    s.started = false; // allow a later retry once the dir exists
    return;
  }

  // Seed snapshots so the first real change diffs against current state.
  const { promises: fs } = await import("node:fs");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory()) s.snapshots.set(e.name, await buildBoardSnapshot(e.name));
  }

  s.watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const parts = filename.split(/[\\/]/);
    const boardId = parts[0];
    if (!boardId) return;
    const base = parts[parts.length - 1];

    if (base === "board.yaml") {
      scheduleBoard(`${boardId}::config`, () => void emitBoardConfigChanged(boardId));
      return;
    }
    if (parts.includes("cards") && base.endsWith(".md")) {
      scheduleBoard(boardId, () => void reconcileBoard(boardId));
    }
  });
}
