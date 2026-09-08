#!/usr/bin/env bun
// advance-card — board-aware "advance to the next pipeline step" for headless skill runs.
//
// A shared harness-* skill no longer hardcodes its next status (`status: priorizar`); after
// writing its output fields it runs THIS to advance to the next step of the CURRENT
// board's pipeline — so the same skill flows correctly on boards with different pipelines
// (storymap has interview/ui steps; orbit/acme don't). Reuses the exact primitives the
// autorun cascade uses (decideAdvance → nextBuildStatus + checkGate), so manual advance
// and the engine forward agree.
//
// Usage:  bun packages/storymap-ui/scripts/advance-card.ts <board> <cardId> [--dry-run] [--json]
// Exit:   0 advanced | 0 done(end/terminal) | 1 blocked(gate unmet) | 2 not found / bad args
//         3 decided-to-advance but the write did NOT persist (story-m3x2uq silent-failure guard)
//
// The write is atomic (updateCardOnDisk: keyed lock + id pin). Run from the repo root.
//
// story-m3x2uq: the outcome (exit code / message / ok) follows the ACTUAL write result (`written`), NOT
// the decision alone — so a decided-but-unpersisted advance is a LOUD failure (exit 3), never the
// "sucesso aparente sem efeito" a headless run once hit. The message goes to STDOUT for every outcome
// (incl. blocked) and we use process.exitCode (not process.exit) so stdout ALWAYS drains before exit.

import { readBoardConfig, readCard } from "../src/lib/storymap/repo";
import { updateCardOnDisk } from "../src/lib/storymap/write";
import { decideAdvance, reportAdvance } from "../src/lib/storymap/advance";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  const [board, cardId] = args.filter((a) => !a.startsWith("--"));

  if (!board || !cardId) {
    console.log("uso: bun packages/storymap-ui/scripts/advance-card.ts <board> <cardId> [--dry-run] [--json]");
    process.exitCode = 2;
    return;
  }

  const config = await readBoardConfig(board);
  const card = await readCard(board, cardId);
  if (!card) {
    const msg = `card não encontrado: ${board}/${cardId}`;
    console.log(json ? JSON.stringify({ ok: false, reason: "not-found", board, cardId }) : msg);
    process.exitCode = 2;
    return;
  }

  const d = decideAdvance(card, config);
  let written = false;
  if (d.action === "advance" && !dryRun) {
    const to = d.to;
    const today = new Date().toISOString().slice(0, 10);
    // Re-decide under the keyed lock so a concurrent status change can't be clobbered.
    const res = await updateCardOnDisk(board, cardId, (current) =>
      decideAdvance(current, config).action === "advance" ? { ...current, status: to, updated: today } : null,
    );
    written = res != null;
  }

  // story-m3x2uq: derive ok/exitCode/message from the ACTUAL write (`written`), never the decision alone.
  const report = reportAdvance(cardId, d, written, dryRun);
  console.log(json ? JSON.stringify({ ok: report.ok, dryRun, board, cardId, ...d, written }) : report.message);
  process.exitCode = report.exitCode;
}

main().catch((err) => {
  console.log(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
});
