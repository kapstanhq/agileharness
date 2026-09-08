#!/usr/bin/env node
// WS6 (F5) — ONE-SHOT backfill: grandfather every EXISTING orphan story with an explicit
// `unplacedAck { by: "backfill-ws6", at: <today> }` so the new `hasPlacement` gate only ever bites a
// card created AFTER this migration. An orphan = a `story` with no `parent`, no `serves`, and no ack yet.
// IDEMPOTENT + purely ADDITIVE (touches only cards that lack all three) → safe to re-run (e.g. against
// main's live data at deploy, after running it here). Read-then-write via the repo helpers (never sed).
//
//   Usage:  node packages/storymap-ui/scripts/backfill-unplaced-ack.mjs [--apply] [--board <id>]
//           (dry-run by default: lists what WOULD be stamped; --apply writes)
//
// MUST run (with --apply) against main's LIVE card data BEFORE the hasPlacement gate goes live on _base
// (the backfill-before-gate invariant, WS6). Delete after the migration is deployed everywhere.

import { readCards, listBoards } from "../src/lib/storymap/repo.ts";
import { updateCardOnDisk } from "../src/lib/storymap/write.ts";

const APPLY = process.argv.includes("--apply");
const boardArgIdx = process.argv.indexOf("--board");
const onlyBoard = boardArgIdx >= 0 ? process.argv[boardArgIdx + 1] : null;

const today = new Date().toISOString().slice(0, 10);

function isOrphanStory(c) {
  return c.type === "story" && c.parent == null && c.serves == null && c.unplacedAck == null;
}

const boards = onlyBoard ? [{ id: onlyBoard }] : await listBoards();
let totalStamped = 0;
for (const b of boards) {
  const cards = await readCards(b.id);
  const orphans = cards.filter(isOrphanStory);
  if (!orphans.length) continue;
  console.log(`\n[${b.id}] ${orphans.length} órfã(s) sem ack:`);
  for (const c of orphans) {
    console.log(`  - ${c.id}: ${c.title}`);
    if (APPLY) {
      await updateCardOnDisk(b.id, c.id, (fresh) => {
        if (!isOrphanStory(fresh)) return null; // re-check under lock (idempotent)
        return { ...fresh, unplacedAck: { by: "backfill-ws6", at: today } };
      });
      totalStamped++;
    }
  }
}

console.log(
  `\n${APPLY ? `✅ ${totalStamped} card(s) carimbado(s) com unplacedAck{by:backfill-ws6}` : "DRY-RUN — nada gravado. Rode com --apply para carimbar."}`,
);
