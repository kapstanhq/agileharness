// landings — THE RECEIPT. Who applied the work already KNEW it applied; stop making the next mechanism
// guess it back out of git.
//
// THE DEFECT THIS CLOSES. The merge train splits every run in two and applies each half itself: code →
// `stage`, board-data → `main`. It knows, at the instant it happens, that each half landed and in which
// commit. It wrote that down as a bool (`entry.split.codeStaged` / `.dataLanded`) and then threw the fact
// away — while, downstream, the convergence ruler tried to RE-DERIVE the same fact from git and got it
// wrong, expensively (the redrive re-implementing published code: ~$13 a card, the qb8z2c pattern).
//
// WHY GIT CANNOT DERIVE IT (the half that WS-1 honestly cannot fix). The CODE half is measurable — nothing
// mutates `packages/**` between the branch commit and the measurement. The DATA half is STRUCTURALLY
// unprovable: the board is LIVE, so the service mutates the card (status, findings, tasks) AFTER the train
// applied the patch. The post-image diverges BY DESIGN, and no git measurement separates "did not land" from
// "landed and the board moved on". convergence.test.ts pins that residual as an executable test. The receipt
// is the only way out, because it is the only witness that was there.
//
// WHY NOT JUST READ `entry.split` (the tempting shortcut, twice wrong):
//   1. THE QUEUE IS A WINDOW, NOT AN ARCHIVE — `merge-queue.json` holds exactly 100 entries, and the
//      branch-gc harvests branches AFTER the grace period, i.e. AFTER the entry has already been evicted. A
//      consumer that depended on the entry would read `null` precisely when it needed the fact most.
//   2. `split` IS PROGRESS OF THE ATTEMPT, NOT OF THE LINEAGE — and `requeue.ts` DISCARDS it on purpose
//      ("a split progress belongs to the ATTEMPT, not the lineage"), which is correct: the next attempt must
//      not inherit progress. But "the code of run X landed on `stage` at sha Y" is LINEAGE — permanent,
//      independent of how many attempts there were. Two different facts sharing one field.
//
// THE ONE RULE THAT MAKES THIS SAFE (do not weaken it): A RECEIPT PROVES; ITS ABSENCE REFUTES NOTHING.
//   receipt present ⇒ `landed` — positive proof, no git measured, no git needed.
//   receipt absent  ⇒ fall through to the git ruler (WS-1). NEVER `absent` by absence.
// Every run that predates this ledger has no line, and they all landed. A consumer reading absence as
// `absent` would make the branch-gc delete the history on the first boot. This adds a source of `landed`; it
// adds NO source of `absent` — the same asymmetry convergence.ts fixes: whoever ACCUSES needs proof.
//
// SHA, NOT BOOL. A bool is an assertion; a sha is a receipt you can go and check. `sha: null` + `empty: true`
// is the EMPTY half (the `n/a` of WS-1) — the train already decides this ("pure-code run: nothing to land on
// main"), and without the line a data-only run would be indistinguishable from one that never tried.
//
// Append-only JSONL, like its siblings (branch-gc.jsonl, transitions.jsonl, events.jsonl) — so it needs no
// schema in `merge-queue.json`, no MERGE_QUEUE_VERSION bump, and no migration. It is also going to have a
// truncated last line one day (a restart mid-`write`), so every read tolerates garbage per line and NEVER
// throws: a broken ledger degrades to "no receipt" ⇒ the git fallback ⇒ today's behaviour.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";

/** Which half of the split a receipt is about. `code` → `stage`; `data` → `main`. */
export type LandingHalf = "code" | "data";

export interface LandingReceipt {
  /** schema tag — a future shape change must not make old lines unreadable (they are the history) */
  v: 1;
  runId: string;
  board: string;
  cardId?: string;
  half: LandingHalf;
  /** the ref this half landed in ("stage" | "main") */
  ref: string;
  /** the commit the train created for this half. `null` iff `empty` — nothing was there to land. */
  sha: string | null;
  /** the half was EMPTY in this run (WS-1's `n/a`) — a claim about the RUN, never about the target */
  empty?: boolean;
  at: string;
}

function ledgerPath(): string {
  return path.join(runnerStateDir(), "landings.jsonl");
}

/**
 * Record that `half` landed. Best-effort and NEVER throws: the receipt is an OPTIMIZATION over the git
 * ruler, so failing to write one must never fail the integration that actually succeeded. Idempotent by
 * `(runId, half)` — the crash-recovery re-runs the step, and a fact recorded twice is still one fact.
 */
export async function recordLanding(receipt: Omit<LandingReceipt, "v" | "at"> & { at?: string }): Promise<void> {
  try {
    const existing = await readLanding(receipt.runId, receipt.half);
    if (existing) return; // already witnessed — recovery re-running the step is not a new fact
    const line: LandingReceipt = { v: 1, at: receipt.at ?? new Date().toISOString(), ...receipt };
    await fsp.mkdir(runnerStateDir(), { recursive: true });
    await fsp.appendFile(ledgerPath(), JSON.stringify(line) + "\n", "utf8");
  } catch (err) {
    console.warn("[harness-landings] append falhou (não-fatal):", err instanceof Error ? err.message : err);
  }
}

/** Every receipt on file. Tolerates a truncated/garbage line (an append-only file WILL have one) by skipping
 *  it — a ledger that throws on read is a ledger that takes the train down with it. Missing file ⇒ []. */
export async function readLandings(): Promise<LandingReceipt[]> {
  try {
    const raw = await fsp.readFile(ledgerPath(), "utf8");
    const out: LandingReceipt[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as LandingReceipt;
        // Structural check: a line we cannot trust is a line we do not have. Never let a malformed receipt
        // masquerade as proof — this is the one place a bad line could manufacture a false `landed`.
        if (parsed?.v === 1 && typeof parsed.runId === "string" && (parsed.half === "code" || parsed.half === "data")) {
          out.push(parsed);
        }
      } catch {
        // truncated tail (restart mid-write) or hand-edited garbage → skip the line, keep the ledger
      }
    }
    return out;
  } catch {
    return []; // no file yet (every run before this ledger) ⇒ no receipts ⇒ the caller falls back to git
  }
}

/** The receipt for `(runId, half)`, or null. Null means WE HAVE NO WITNESS — never "it did not land". */
export async function readLanding(runId: string, half: LandingHalf): Promise<LandingReceipt | null> {
  const all = await readLandings();
  return all.find((r) => r.runId === runId && r.half === half) ?? null;
}
