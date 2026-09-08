// Run telemetry — the DURABLE cost/turns history of every headless run, the forensic
// twin of the EPHEMERAL registry usage (registry.ts keeps only the LAST run's usage, in
// memory, gone on restart). The engine writes ONE record here as each run settles (any
// outcome), so the operator can audit past executions, spot expensive cards and decide
// optimizations WITHOUT grepping raw tmux/claude logs (story-observabilidade-runs-telemetria).
//
// Distinct from the journal (journal.ts): the journal persists the small subset needed to
// RECOVER an interrupted run (which were in-flight at a crash + each card's resume id) and
// is keyed by board/cardId (one live entry per card). This is an append-only LEDGER keyed by
// run — many records per card — kept for aggregation, never for recovery.
//
// Persisted atomically (write tmp + rename) to storymap/.runner/telemetry.json (gitignored).
// SERVER-ONLY (node:fs). Process-global singleton, mirroring registry.ts / journal.ts.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { telemetryPath } from "@/lib/storymap/paths";
import type { RunOutcome } from "./journal";
import type { TriggerId } from "@/lib/storymap/types";

/**
 * WS-7 §7.4 — the ROLE a spawn played, the cost dimension that answers "quanto custa cada papel" for
 * /processes + ccusage. It is what CALIBRATES the role×model table (model-routing.ts §7.1) with evidence
 * instead of achismo: without it every spawn aggregates into one undifferentiated $ figure and the table's
 * rows can only ever be argued, never measured.
 *
 *   run        — a headless autorun run of a card's column trigger (harness-*). The DEFAULT (see {@link roleOf}).
 *   session    — an agent session's own work (WS-1/WS-6 spawn), card-ful or card-less.
 *   steward    — the copilot tick / integration steward (WS-8) acting on the board.
 *   resolution — a conflict-resolution / semantic-judge run (WS-10, `mechanical` profile).
 */
export type TelemetryRole = "run" | "session" | "steward" | "resolution";
export const TELEMETRY_ROLES = ["run", "session", "steward", "resolution"] as const;

/**
 * The role of a record, defaulting to `run` — the SPARSE contract. Every record written before WS-7 (and
 * every autorun record today, since the engine doesn't stamp the field) lacks `role`, and they are all
 * exactly one thing: card runs. So an ABSENT role means `run`, not "unknown" — the field only has to be
 * written by the spawns that are NOT card runs (session/steward/resolution), which is what keeps this
 * additive: zero engine change, zero backfill, no TELEMETRY_VERSION bump. Read the role through this,
 * never off the raw field, or the entire history reads as roleless.
 */
export function roleOf(record: Pick<TelemetryRecord, "role">): TelemetryRole {
  return record.role ?? "run";
}

/** One settled run, the persisted unit of telemetry. Keyed by `id` (the run's sessionId). */
export interface TelemetryRecord {
  /** sessionId of the run — unique per run (a re-run mints a fresh one). */
  id: string;
  board: string;
  cardId: string;
  trigger: TriggerId;
  /** epoch ms the child spawned (the run's start). */
  startedAt: number;
  /** wall-clock duration in ms, or null if unknown (e.g. never spawned). */
  durationMs: number | null;
  /** agent turns, or null when the run produced no `result` event (killed/crashed before it). */
  turns: number | null;
  /** input + cache tokens, or null when no usage was reported. */
  inputTokens: number | null;
  /** output tokens, or null when no usage was reported. */
  outputTokens: number | null;
  /** estimated cost in USD, or null when not reported. */
  costUSD: number | null;
  /** model tier this run spawned with ("opus"|"sonnet"|…) — captured from the EFFECTIVE resolved
   * spawn policy (story-run-panel-richer-info), so a past run's agent stays accurate even after the
   * column policy changes. Optional: runs recorded before this field existed have it undefined. */
  model?: string | null;
  /** effort level this run spawned with ("high"|"medium"|…), same provenance as `model`. */
  effort?: string | null;
  /** the run's DECISION — the agent's own final assistant message, collapsed to a single capped line
   * (F4 / card-as-living-doc provenance, story 2026-06-19). This is the `RunResult.finalText` that the
   * engine used to capture for the console preview and then DISCARD (engine.ts settle); persisting it
   * makes the card document's `## Histórico` show WHAT each run decided, not only its metrics. Optional
   * (no TELEMETRY_VERSION bump): pre-F4 records lack it → they render without a decision line. */
  summary?: string | null;
  /** the distinct tool NAMES the run invoked (mcp__graphify__*, mcp__chrome-devtools__*, Bash, Task,
   * Workflow…), sorted — plus the synthetic `local-dev-server` token when the engine provisioned a QA
   * dev server (a Bash subprocess, invisible as a tool name). The durable signal behind the step-history
   * "capacidades" markers (did the skill exercise graphify / the browser / a local server / subagents).
   * Optional + additive (no TELEMETRY_VERSION bump): pre-existing records lack it → they render with no
   * capability markers. Null when the run called no tools (or crashed before streaming any). */
  toolsUsed?: string[] | null;
  /** WS4 — the specialist AGENT SLUGS this run delegated to via the Task tool (`subagent_type`), sorted +
   *  deduped. Closes the expected×used loop for specialists (the step declares `toolkit.specialists`; this
   *  records which were engaged). Optional + additive (no version bump). Null when the run delegated to
   *  none. NB: an unused specialist is NOT an anomaly (specialists are conditional) — no finding derives. */
  specialistsUsed?: string[] | null;
  /** WS3 (F2) — the capability toolGap: ids of `expected`-level toolConfigs whose `match` regex found NO
   *  evidence in `toolsUsed` (the step provisioned a capability but the run never exercised it). The
   *  DURABLE, aggregate-able signal behind the SOFT `tooling-unused` finding — persisted on the run's own
   *  record (zero race). Optional + additive (no TELEMETRY_VERSION bump): old records lack it → undefined.
   *  Null/absent when the step has no toolkit expectation or all were met. */
  toolGap?: string[] | null;
  /** WS-7 §7.4 — the PAPEL this spawn played ({@link TelemetryRole}), the cost dimension of /processes.
   * Optional + SPARSE by design: absent ⇒ `run` (a card run — what every pre-WS-7 record is), so read it
   * via {@link roleOf}. Additive, no TELEMETRY_VERSION bump: old records parse and aggregate unchanged. */
  role?: TelemetryRole | null;
  /** the run's final outcome (mirrors the journal's RunOutcome). */
  status: RunOutcome;
  /** story-mzpzb0 — SUCESSO-COM-AVISO: o run saiu não-limpo (status de morte) MAS o card AVANÇOU de
   * coluna durante o run, então o engine SUPRIMIU o RunnerFailure (falha-fantasma) — o trabalho
   * entregou, só a saída ficou suja. Sem este bit durável, o Inbox não distingue isto de uma falha
   * real (mesmo `status: "exit"`) e pinta os dois como TRAVADO. Additive (+ no TELEMETRY_VERSION bump):
   * registros antigos não têm o campo → `undefined`, tratado como NÃO-avançado (travado, como antes). */
  advanced?: boolean;
}

/**
 * Fase 5.3 — the MOST-RECENT run of `trigger` that observed a capability toolGap (a step provisioned a tool
 * the run never exercised), for the "Toolkit por coluna" panel ("declarou X, o run Y não o viu — <data>").
 * `records` must be most-recent-first (diskTelemetryStore().load() already returns them that way). Returns
 * undefined when no such record exists. PURE (node-unit-testable).
 */
export function lastToolGapByTrigger(
  records: readonly TelemetryRecord[],
  trigger: string,
): TelemetryRecord | undefined {
  return records.find((r) => r.trigger === trigger && (r.toolGap?.length ?? 0) > 0);
}

/** WS-7 §7.4 — what ONE role cost across a set of records ({@link costByRole}). */
export interface RoleCost {
  role: TelemetryRole;
  /** how many records carried this role. */
  runs: number;
  /** summed cost in USD (a null costUSD counts as 0, like the per-card aggregation). */
  totalCostUSD: number;
}

/**
 * WS-7 §7.4 — cost per PAPEL across `records`, sorted by cost desc: the aggregation behind "quanto custa
 * cada papel" (/processes, ccusage) and the evidence that later re-calibrates the role×model table
 * (model-routing.ts §7.1) — decisions by measurement, not by achismo.
 *
 * SPARSE: reads the role through {@link roleOf}, so the whole pre-WS-7 history aggregates under `run`
 * rather than vanishing. Roles with no records are OMITTED (a board that never spawned a resolution shows
 * no resolution row — an empty row would read as "$0 spent on it", which is a different claim). Scope is
 * the CALLER's (filter by board/window first); pure — node-unit-testable, no I/O.
 */
export function costByRole(records: readonly TelemetryRecord[]): RoleCost[] {
  const by = new Map<TelemetryRole, RoleCost>();
  for (const r of records) {
    const role = roleOf(r);
    let row = by.get(role);
    if (!row) by.set(role, (row = { role, runs: 0, totalCostUSD: 0 }));
    row.runs += 1;
    row.totalCostUSD += r.costUSD ?? 0;
  }
  return [...by.values()].sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

/** Aggregated metrics for ONE card across all its runs. */
export interface CardMetrics {
  cardId: string;
  totalRuns: number;
  totalCostUSD: number;
  /** mean turns across runs that reported turns, or null when none did. */
  avgTurns: number | null;
  /** epoch ms of the most-recent run, or null when none. */
  lastRunAt: number | null;
  /** outcome of the most-recent run, or null when none. */
  lastStatus: RunOutcome | null;
  /** story-mzpzb0 — whether the most-recent run was a SUCESSO-COM-AVISO (`TelemetryRecord.advanced`):
   * a non-clean outcome whose card advanced anyway. Lets the cockpit exclude it from the TRAVADO lane
   * (isStuckCardMetric) while a genuine no-progress failure stays stuck. Undefined ⇒ treated as false. */
  lastAdvanced?: boolean;
}

/** A board's metrics: per-card rows (sorted by cost desc) + the board-wide cost total. */
export interface BoardMetricsSummary {
  boardId: string;
  cards: CardMetrics[];
  totalCostUSD: number;
}

/** Os outcomes de MORTE de processo que o engine pode SUPRIMIR como sucesso-com-aviso quando o card
 * avançou. `no-op` fica de fora DE PROPÓSITO: um no-op sempre chega ao settle COM um RunnerFailure
 * (`{reason:"no-op"}`), então cai no ramo `hasFailure` e nunca é sucesso-com-aviso. */
const SUPPRESSIBLE_DEATH_OUTCOMES: ReadonlySet<RunOutcome> = new Set<RunOutcome>([
  "exit",
  "timeout",
  "oom-killed",
  "error",
]);

/**
 * story-mzpzb0 — deriva SUCESSO-COM-AVISO a partir dos dois sinais que o settle já tem, SEM novo parâmetro.
 * O engine suprime o RunnerFailure (`failure === undefined`) quando o card avançou durante o run, mas
 * grava o outcome de MORTE cru (exit/timeout/oom-killed/error) no journal/telemetry (forense). Logo:
 * sem falha + outcome de morte = o card avançou apesar da saída suja = sucesso-com-aviso. Uma falha real
 * (RunnerFailure presente, inclusive no-op) ou um outcome não-de-morte (ok/cancelled/max-turns) ⇒ false.
 * Pura — o engine a chama no recordRun; os testes fixam a fronteira.
 */
export function isSuccessWithWarning(hasFailure: boolean, outcome: RunOutcome): boolean {
  return !hasFailure && SUPPRESSIBLE_DEATH_OUTCOMES.has(outcome);
}

/** Narrow surface the engine depends on (DI — like RunnerJournalPort). */
export interface TelemetryPort {
  recordRun(record: TelemetryRecord): Promise<void>;
  listByCard(board: string, cardId: string, limit?: number): Promise<TelemetryRecord[]>;
  boardSummary(board: string): Promise<BoardMetricsSummary>;
}

/**
 * Persistence port — disk by default, in-memory in tests. Keeps TelemetryStore's logic
 * (the cap + the aggregation) pure and unit-testable without touching fs (mirrors JournalStore).
 */
export interface TelemetryPersistStore {
  load(): Promise<TelemetryRecord[]>;
  persist(records: TelemetryRecord[]): Promise<void>;
}

// Hard cap so the ledger can't grow unbounded across a long-lived server (same strategy as the
// journal's MAX_DONE_RETAINED). Most-recent first → the slice drops the OLDEST records.
const MAX_RECORDS = 1000;

/** The telemetry ledger: records the runs, caps the file, serves per-card + per-board views. */
export class TelemetryStore implements TelemetryPort {
  private records: TelemetryRecord[] = []; // most-recent first
  // Memoized load PROMISE (not a boolean): concurrent callers await the SAME resolution, so none
  // proceeds on a partial array. Records that landed during the load are PREPENDED, never lost.
  private loadOnce?: Promise<void>;
  // Serialize persists so two runs settling at once can never interleave a half-written file.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private store: TelemetryPersistStore) {}

  private ensureLoaded(): Promise<void> {
    return (this.loadOnce ??= this.store
      .load()
      .catch(() => [] as TelemetryRecord[])
      .then((rows) => {
        // A record recorded BEFORE the load resolved sits at the front; append the disk rows after it,
        // then re-cap. Dedup by id so a double-load (shouldn't happen) can't duplicate a record.
        const seen = new Set(this.records.map((r) => r.id));
        for (const r of rows) if (!seen.has(r.id)) this.records.push(r);
        this.sortAndCap();
      }));
  }

  private sortAndCap(): void {
    this.records.sort((a, b) => b.startedAt - a.startedAt);
    if (this.records.length > MAX_RECORDS) this.records.length = MAX_RECORDS;
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(async () => {
      await this.store.persist([...this.records]).catch((err) => {
        console.error("[harness-telemetry] persist failed:", err instanceof Error ? err.message : err);
      });
    });
  }

  /** A run settled → append its record (any outcome). Most-recent first; capped at MAX_RECORDS. */
  async recordRun(record: TelemetryRecord): Promise<void> {
    await this.ensureLoaded();
    this.records.unshift(record);
    this.sortAndCap();
    this.schedulePersist();
  }

  /** The most-recent runs of a card (most-recent first), capped by `limit` when given. */
  async listByCard(board: string, cardId: string, limit?: number): Promise<TelemetryRecord[]> {
    await this.ensureLoaded();
    const rows = this.records.filter((r) => r.board === board && r.cardId === cardId);
    return limit != null ? rows.slice(0, limit) : rows;
  }

  /** Per-card aggregation for a board (single O(n) pass), rows sorted by total cost desc. */
  async boardSummary(board: string): Promise<BoardMetricsSummary> {
    await this.ensureLoaded();
    const byCard = new Map<string, { runs: TelemetryRecord[] }>();
    for (const r of this.records) {
      if (r.board !== board) continue;
      let g = byCard.get(r.cardId);
      if (!g) byCard.set(r.cardId, (g = { runs: [] }));
      g.runs.push(r);
    }
    const cards: CardMetrics[] = [];
    let totalCostUSD = 0;
    for (const [cardId, { runs }] of byCard) {
      const cardCost = runs.reduce((acc, r) => acc + (r.costUSD ?? 0), 0);
      const turns = runs.map((r) => r.turns).filter((t): t is number => t != null);
      // records are most-recent first within the board scan, so runs[0] is the latest for this card.
      const latest = runs.reduce((a, b) => (b.startedAt > a.startedAt ? b : a), runs[0]);
      cards.push({
        cardId,
        totalRuns: runs.length,
        totalCostUSD: cardCost,
        avgTurns: turns.length ? turns.reduce((a, b) => a + b, 0) / turns.length : null,
        lastRunAt: latest?.startedAt ?? null,
        lastStatus: latest?.status ?? null,
        lastAdvanced: latest?.advanced ?? false,
      });
      totalCostUSD += cardCost;
    }
    cards.sort((a, b) => b.totalCostUSD - a.totalCostUSD);
    return { boardId: board, cards, totalCostUSD };
  }

  /** Await all pending writes (tests / graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

// TELEMETRY_VERSION — bump when the persisted shape changes incompatibly; load() drops a file whose
// version it doesn't recognize (forward-compat: an old server reading a new schema starts clean
// rather than feeding malformed records to the aggregation).
const TELEMETRY_VERSION = 1;

const TelemetryRecordSchema = z.object({
  id: z.string(),
  board: z.string(),
  cardId: z.string(),
  trigger: z.string(),
  startedAt: z.number(),
  durationMs: z.number().nullable(),
  turns: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  costUSD: z.number().nullable(),
  // Optional (+ no TELEMETRY_VERSION bump): old records lack model/effort → they parse fine and
  // simply render as "—", instead of being dropped by a version mismatch (keeps the history).
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  // F4 provenance: the run's decision summary — additive (old records lack it → they still parse).
  summary: z.string().nullable().optional(),
  // Tool usage (step-history capacidades) — additive, no TELEMETRY_VERSION bump (old records lack it).
  toolsUsed: z.array(z.string()).nullable().optional(),
  // WS4 — specialist delegations (Task subagent_type) — additive, no version bump (old records lack it).
  specialistsUsed: z.array(z.string()).nullable().optional(),
  // WS3 (F2) — capability toolGap — additive, no TELEMETRY_VERSION bump (old records lack it → parse fine).
  toolGap: z.array(z.string()).nullable().optional(),
  // "cancelled" (story-vbkazs): a deliberate operator cancel — additive value, no TELEMETRY_VERSION
  // bump (old records never carried it, so they still parse). It renders neutral in the UI, never red.
  // "max-turns" (story-9s52tu HALF B): a resumable turn-budget stop — likewise additive (old records
  // never carried it), renders neutral (resumable, not a failure).
  // WS-7 §7.4 — the spawn's role. Additive + optional (old records lack it → roleOf() reads them as `run`).
  // `.catch(undefined)` (unlike `status`, a bare z.enum) so a role minted by a NEWER server degrades this
  // ONE field to undefined instead of failing safeParse and DROPPING the whole record from the history —
  // a forensic ledger must not lose a run's cost over a dimension it doesn't recognize yet.
  role: z.enum(TELEMETRY_ROLES).nullable().optional().catch(undefined),
  status: z.enum(["ok", "error", "timeout", "exit", "oom-killed", "no-op", "cancelled", "max-turns"]),
  // sucesso-com-aviso (story-mzpzb0) — additive, no TELEMETRY_VERSION bump (old records lack it → parse fine).
  advanced: z.boolean().optional(),
});

/** Atomic on-disk store: write a temp file then rename over the target (same fs). */
export function diskTelemetryStore(file: string = telemetryPath()): TelemetryPersistStore {
  const dir = path.dirname(file);
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        if (data?.version !== TELEMETRY_VERSION || !Array.isArray(data.records)) return [];
        const valid: TelemetryRecord[] = [];
        for (const r of data.records) {
          const parsed = TelemetryRecordSchema.safeParse(r);
          if (parsed.success) valid.push(parsed.data as TelemetryRecord);
        }
        return valid;
      } catch {
        return []; // absent / unreadable / malformed JSON → start clean
      }
    },
    async persist(records) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: TELEMETRY_VERSION, records }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file); // atomic; overwrites on win32 via MoveFileEx
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

const KEY = Symbol.for("storymap.runner.telemetry");
const store = globalThis as unknown as { [KEY]?: TelemetryStore };

export function getTelemetryStore(): TelemetryStore {
  return (store[KEY] ??= new TelemetryStore(diskTelemetryStore()));
}
