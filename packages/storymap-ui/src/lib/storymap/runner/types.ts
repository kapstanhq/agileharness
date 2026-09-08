// Runner status — the EPHEMERAL state of the autorun pipeline (which cards have a
// harness-* skill running right now, and which just failed). Isomorphic (no node/
// browser deps): the server registry produces it, the client badge consumes it.
//
// This is DISTINCT from AgileHarnessEvent (lib/notifications/event.ts): that describes
// a *persisted* change to a board (a card was moved/edited). This describes the
// transient lifecycle of the headless `claude -p` process the trigger-runner spawns
// — it never touches disk and is gone when the dev server restarts.

import type { StatusDef, TriggerId } from "@/lib/storymap/types";
import type { RunLane } from "./scheduler";

/** Cost/token totals for a run, parsed from its stream-json `result` event. Known only
 * once the run is winding down (the result event is its last), so always optional. */
export interface RunUsage {
  costUSD: number | null;
  /** total tokens (input+output+cache) — soma mantida para não quebrar callers existentes. */
  tokens: number | null;
  numTurns: number | null;
  /** input + cache-creation + cache-read tokens (telemetria de custo, story-observabilidade-runs). */
  inputTokens: number | null;
  /** output tokens só (telemetria de custo, story-observabilidade-runs). */
  outputTokens: number | null;
}

/** A harness-* skill currently executing headless against a card. */
export interface RunnerRun {
  /** board id (matches BoardConfig.id) */
  board: string;
  /** card id (matches Card.id) */
  cardId: string;
  /** which skill is running */
  trigger: TriggerId;
  /** epoch ms when the child process spawned (drives the elapsed-time counter) */
  startedAt: number;
  /** fresh `claude --session-id` this run was spawned with (random per run, so a
   * re-run never collides) — lets a human `claude --resume <sessionId>` to take over. */
  sessionId: string;
  /** cost/token totals once the run reports them (result event); undefined until then. */
  usage?: RunUsage;
}

export type RunnerFailureReason =
  | "timeout" // watchdog killed a stuck process
  | "exit" // process exited non-zero
  | "error" // spawn/process error
  | "oom-killed" // the run's systemd-run scope exceeded MemoryMax → kernel OOM kill (SM-4)
  | "no-op"; // clean exit (code 0) but a must-advance skill left the card in place — sucesso-fantasma

/** A recently failed run, kept briefly so the UI can flag a stuck/broken card. */
export interface RunnerFailure {
  board: string;
  cardId: string;
  trigger: TriggerId;
  reason: RunnerFailureReason;
  /** epoch ms of the failure (used for TTL expiry) */
  at: number;
  /** short human detail, e.g. "exit 1" or "sem resposta em 360s" */
  detail?: string;
}

// --- Merge queue (R1, SM-2: merge train) ------------------------------------
// After worktree isolation (SM-1), each finished run lives on a throwaway branch
// (`run/<sessionId>`). The merge queue integrates those branches into `main` ONE
// at a time (serial FIFO): a clean branch auto-merges; a conflicting one PAUSES
// the queue for the operator. Like RunnerSnapshot this is the EPHEMERAL live
// picture (the registry produces it, the ops panel consumes it), but unlike it the
// entries are also DURABLE — persisted to merge-queue.json so a restart recovers.

/** Lifecycle of one queued branch:
 *  `waiting`      — enqueued, not yet processed
 *  `gate-running` — the integration gate is merging the branch into a TEMPORARY staging
 *                   worktree and running the suite there (main is NOT touched yet)
 *  `gate-failed`  — the gate reproved (staging merge or suite failed); main intocada;
 *                   queue paused awaiting the operator (retry / abort)
 *  `merging`      — actively being merged into main right now (gate passed, or gate disabled)
 *  `conflict`     — the merge hit a conflict; queue paused awaiting the operator
 *  `re-driving`   — TERMINAL for THIS branch: the merge conflicted but the entry had a generating
 *                   skill (`trigger`) under the re-drive cap, so instead of pausing, the train deleted
 *                   the superseded branch, signalled the engine to RE-RUN the skill against the (now
 *                   updated) main, and kept processing. A fresh branch arrives later with driveCount+1.
 *  `done`         — merged into main (or already an ancestor); branch deleted
 *  `failed`       — could not integrate (branch vanished, aborted by operator)
 *  `returned-to-session` — TERMINAL (WS-1.4): a live agent session's submit conflicted/failed the gate and
 *                   was handed back to the session to resolve; its branch is intact and a re-submit
 *                   arrives as a NEW entry. Never parks, never blocks the head of the train. */
export type MergeQueueStatus =
  | "waiting"
  | "gate-running"
  | "gate-failed"
  | "merging"
  | "conflict"
  | "re-driving"
  | "done"
  | "failed"
  /**
   * WS-1.4/D3 — a `kind: session` entry that conflicted or failed the gate, handed BACK to its live
   * session to fix. TERMINAL, exactly like `failed` (autocrítica G6): a live session takes minutes-to-hours
   * to resolve, and a non-terminal entry at the head of the train would hold every other integration
   * hostage — the anti-goal. The branch is left intact; the session does `worktree_refresh` +
   * `worktree_submit`, which enqueues a BRAND NEW entry. Never parks for the operator, never re-driven.
   */
  | "returned-to-session";

/** One branch awaiting (or past) integration into main. Keyed by `runId` (the run's sessionId). */
export interface MergeQueueEntry {
  /** sessionId of the run/session that produced the branch — the unique key of the entry. */
  runId: string;
  /**
   * WS-1.3/D2 — WHO produced the branch. `run` (default, absent on every legacy entry) = a headless autorun
   * run: has a card, parks for the operator, can be re-driven. `session` = an agent session's
   * `worktree_submit`: may be CARD-LESS, and its failures go BACK to the live session
   * (`returned-to-session`) instead of parking. The gate and the code→stage/data→main split are IDENTICAL
   * for both — only the OUTCOME routing and the branch cleanup differ.
   */
  kind?: "run" | "session";
  board: string;
  /** the card this integration advances. OPTIONAL only for `kind: "session"` (self-dev / a quick fix with
   *  no card): no card ⇒ no card advance, no findings, no auto-created card (D13) — a generic cockpit item. */
  cardId?: string;
  /** the throwaway branch to merge, `run/<sessionId>` or (WS-1) `agent/<sessionId>`. */
  branch: string;
  /**
   * WS-1.2/G5 — the EXACT sha to integrate, pinned by `worktree_submit` at submit time. A session KEEPS
   * COMMITTING while its entry waits in the queue, so integrating the branch's live tip would land commits
   * the gate never validated (the gate would have tested a different tree). Every read of the work — the
   * gate, the diff ranges, the split — resolves through {@link MergeQueueEntry.pinnedSha} when present;
   * only the branch NAME is used for ref operations (rename/delete). Absent ⇒ the branch tip (runs: their
   * branch is frozen at settle, so tip == pinned by construction).
   */
  pinnedSha?: string;
  /**
   * The SHA the run's worktree was born from — the INTEGRATION BASE (stale-base rootcause fix). With
   * staging on, runs are cut from the `stage` branch (= main + unreleased code), so the run's true diff
   * is `baseCommit..branch` — NOT `HEAD..branch` (which would re-include the unreleased code already on
   * stage and risk leaking it to main on a whole-branch merge). Captured at spawn (ensureRunBase) as a
   * FIXED sha so it is immune to `stage`/main advancing between spawn and merge-back. Absent on legacy
   * entries / staging-off boards ⇒ callers fall back to `HEAD` (the pre-fix behavior). */
  baseCommit?: string;
  status: MergeQueueStatus;
  /** epoch ms the branch entered the queue (drives FIFO order + the elapsed display). */
  enqueuedAt: number;
  mergeStartedAt?: number;
  mergeEndedAt?: number;
  /** truncated `git merge` stderr (≤500 chars) when status is `conflict`. */
  conflictDetail?: string;
  /** why the entry ended up `failed` (branch missing, operator aborted, unexpected git error). */
  failureReason?: string;
  /** truncated check/staging-merge output (≤500 chars) when status is `gate-failed` — what
   * the integration gate saw fail in the temporary staging worktree. */
  gateLog?: string;
  /** The generating skill (harness-*) that produced this branch. Present ⇒ a conflict can be RE-DRIVEN
   * (re-run the skill against the updated main); ABSENT ⇒ ad-hoc branch (no spec) → never re-drive. */
  trigger?: TriggerId;
  /** How many re-drives this lineage has already taken (a conflict bumps it). 0/undefined = the first,
   * never-re-driven attempt; the train stops re-driving once it reaches `mergeTrain.maxRedrives`. */
  driveCount?: number;
  /** Quantas vezes um gate INCONCLUSIVO (infra — crash/OOM/flake do processo do gate, NÃO defeito do
   *  submitter) já RE-ENFILEIROU esta entrada. 0/undefined = primeira. O train para de re-tentar em
   *  `MAX_GATE_INCONCLUSIVE_RETRIES` e então devolve a sessão (ou parqueia como gate-failed), para um gate
   *  quebrado de verdade não rodar a suíte para sempre. */
  gateInconclusiveRetries?: number;
  /** non-fatal push error after a successful merge-back (origin left behind; next push catches up). */
  pushError?: string;
  /** SM-06 (AC2): non-fatal error if stamping the gate-failure blocker on the card failed — the entry is
   * still `gate-failed`, but the card may lack its testing:blocker finding (diagnostic only). */
  gateBlockerError?: string;
  /** SM-08: non-fatal error if stamping the secret-scan blocker on the card failed — the entry is still
   * `failed` (push blocked), but the card may lack its security:blocker finding (diagnostic only). */
  secretScanBlockerError?: string;
  /**
   * Fase 4a split-integration progress (persisted), so a split interrupted by a restart RESUMES from the
   * exact half that already landed instead of redoing or losing work. `dataLanded` = the run's board data
   * was committed to main; `codeStaged` = its code was committed on the `stage` branch. PRESENT marks this
   * `merging` entry as a SPLIT (code→stage / data→main), so recover() resumes it via the split path — NOT
   * the whole-branch merge's is-ancestor/dirty analysis (a split never merges into main, so is-ancestor is
   * always false for it). Absent ⇒ a normal merge entry. Set step-by-step + persisted inside integrateSplit.
   */
  split?: { dataLanded?: boolean; codeStaged?: boolean };
  /**
   * WS-10/D14 — the SEMANTIC LADDER's analysis of this entry's CODE conflict, attached when the ladder ran
   * and did NOT resolve it. This is the whole point of the WS: a parked item stops being a raw `git merge`
   * stderr and becomes a per-hunk verdict + rationale the operator reads on Inbox/cockpit. Absent ⇒ the
   * ladder never ran (flag off, a live session's conflict, board data, or a non-text failure like a snapshot
   * regen) — NOT "it ran and found nothing".
   */
  resolutionAnalysis?: {
    /** which rung answered, and why — the operator-facing one-liner (capped like conflictDetail) */
    detail: string;
    /** `escalated-substantive` / `judge-failed` / `skipped` — a resolved entry never parks, so a persisted
     *  analysis is always one of the escalations. Kept as a plain string (not the union) so a future outcome
     *  never breaks the persisted-state schema — this field is a RECORD, not a decision. */
    outcome: string;
    /** the per-hunk verdicts (capped: MAX_ANALYSIS_HUNKS × HUNK_TEXT_CAP — semantic-resolution.ts) */
    hunks: Array<{ file: string; hunk: string; verdict: string; rationale: string }>;
  };
  /**
   * WS-10 invariant 3 — how many SEMANTIC resolution attempts this entry has spent (the ladder's own
   * counter, the exact sibling of `driveCount`). `>= SEMANTIC_ATTEMPT_CAP` ⇒ the ladder is skipped and the
   * entry parks straight away: an LLM re-judging the same unchanged text is a loop, not a retry. A genuine
   * retry arrives as a NEW entry (a new base = a change of FACT), which starts at 0.
   */
  semanticAttempts?: number;
  /**
   * WS-8.1 (D11) invariant 5 — how many times the STEWARD has handed this parked entry back to the train. A
   * THIRD counter next to `driveCount` and `semanticAttempts` on purpose: they answer different questions
   * ("how many times was the skill re-run?" / "how many times did an LLM judge this text?" / "how many times
   * did the steward ask the train to try again?"), and collapsing them would let one loop-guard silently
   * spend another's budget. `>= STEWARD_RETRY_CAP` ⇒ the steward escalates instead of re-trying: the train
   * already met this exact text over this exact base and parked, so a second hand-back buys nothing. A
   * genuine retry arrives as a NEW entry (a new base = a change of FACT), which starts at 0.
   */
  stewardAttempts?: number;
  /**
   * P-1 — O CONFLITO, capturado ANTES de a árvore ser descartada (`conflict-artifact.ts`).
   *
   * Existe porque o desfecho de falha MAIS COMUM em produção entregava nove palavras inúteis: `split:
   * código conflita com stage (run <uuid>)`. Sem arquivo, sem região, sem lado — a sessão só podia
   * chutar (`worktree_refresh` às cegas + re-submeter), e o operador via um stderr cru. O irmão desta
   * camada (`release.ts`) já publicava `divergentFiles`/`divergentBase` justamente para não cometer esse
   * erro: o defeito estava diagnosticado e corrigido só de um lado.
   *
   * TRÊS consumidores, uma captura: o texto devolvido à sessão (`returned-to-session`), o conjunto que a
   * ESCADA SEMÂNTICA julga (só os arquivos que de fato divergiram — antes ela recebia TODOS os arquivos
   * de código da entrada, o que fazia o degrau 1 e o degrau 2 escalarem por construção) e o item parqueado
   * que o operador lê no Inbox.
   */
  conflict?: {
    files: string[];
    hunks: Array<{ file: string; hunk: string }>;
    truncatedFiles?: number;
    truncatedHunks?: number;
  };
}

/** The live merge-queue picture: the ordered entries + whether the serial processor is busy. */
export interface MergeQueueSnapshot {
  entries: MergeQueueEntry[];
  processing: boolean;
}

/** Full picture sent to the browser on every change (small: maxConcurrent ~2). */
export interface RunnerSnapshot {
  running: RunnerRun[];
  failures: RunnerFailure[];
  /** The merge train's state — present once worktree isolation has enqueued any branch. */
  mergeQueue?: MergeQueueSnapshot;
}

// --- Live run output (Fase B) ----------------------------------------------
// A read-only console of what a card's headless run is doing, parsed from the
// `--output-format stream-json` event stream. Separate from RunnerSnapshot so a
// burst of frames never bloats the (tiny) snapshot payload.

/** Coarse kind of a log line — drives its icon/color in the console. */
export type LogLevel = "info" | "tool" | "system" | "result" | "error";

/** One line in a card's run console. `seq` is monotonic per process for dedup. */
export interface LogFrame {
  board: string;
  cardId: string;
  /** monotonic sequence within the registry (client dedups/ordering) */
  seq: number;
  level: LogLevel;
  text: string;
  /** epoch ms */
  at: number;
}

/** Coalesced batch of frames for one card, pushed over the SSE `runner-log` event. */
export interface RunnerLogBatch {
  board: string;
  cardId: string;
  frames: LogFrame[];
}

// ── Dependency-aware enqueueing (story-mcp-enfileiramento-lote-dependencias) ─────────────
// The MCP `enqueue`/`enqueue_batch` tools (the single enqueue surface for chat/autorun/scripts)
// delegate to the engine, which returns these shapes. No Firestore/YAML schema change — the
// dependency graph is process-ephemeral RAM (a restart drops a partial batch; re-send it).

/** The immediate answer for enqueueing ONE card via `engine.enqueueWithDeps`. */
export interface EnqueueResult {
  /** the card id (mirrors the input — handy when an array of results is returned). */
  id: string;
  board: string;
  /** the admission lane the run competes in, or null when refused/blocked before lane assignment. */
  lane: RunLane | null;
  /** 0-indexed position in the lane queue (null = running, refused, or blocked on deps). */
  position: number | null;
  /** conservative epoch-ms estimate of when the run starts (null = blocked/refused). */
  estimatedStart: number | null;
  /** true ⇒ the card is held in the dependency graph until its predecessors settle. */
  blocked: boolean;
  /** when blocked, the "board/cardId" of each predecessor still keeping it waiting. */
  blockedBy?: string[];
  /** when the underlying runSkill was REFUSED (not blocked, not enqueued), why. */
  reason?: "in-flight" | "cooldown" | "rate-limited" | "bad-id";
}

/** The aggregate answer for `engine`-backed `enqueue_batch` (one EnqueueResult per card). */
export interface BatchEnqueueResult {
  /** cards that actually called runSkill (ran or queued) this batch. */
  enqueued: number;
  /** cards registered in the dependency graph (held until predecessors settle). */
  blocked: number;
  items: EnqueueResult[];
}

/**
 * One card held in the {@link DependencyGraph} until its predecessors settle. A card whose
 * `failedDeps` is non-empty is "blocked-by-failure": it will NEVER auto-release — it waits
 * for the operator (per the story's dependency criterion: a failed predecessor blocks, not
 * cancels). Both Sets carry "board/cardId" keys.
 */
export interface BlockedEntry {
  board: string;
  cardId: string;
  trigger: TriggerId;
  def: StatusDef;
  /** predecessors not yet settled; shrinks as each settles ok. Empty + no failures ⇒ release. */
  depsRemaining: Set<string>;
  /** predecessors that settled with a TERMINAL FAILURE; non-empty ⇒ blocked-by-failure. */
  failedDeps: Set<string>;
  /** epoch ms the entry was registered (observability). */
  blockedSince: number;
}
