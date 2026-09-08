// Merge queue — the INTEGRATION layer of the autorun pipeline (R1, SM-2: merge train).
//
// Worktree isolation (SM-1) lets N runs finish concurrently, each on its own throwaway
// branch (`run/<sessionId>`). The next problem is integration: if every run merged into
// `main` on its own, concurrent merges would race and corrupt history. This module is the
// serial answer — a FIFO queue that integrates run branches into `main` ONE AT A TIME:
//   - a branch that merges cleanly is AUTO-MERGED (no human),
//   - a branch that CONFLICTS pauses the queue and waits for the operator to resolve.
//
// Like worktree.ts the git plumbing is behind an injectable `exec` (DI) and the persistence
// behind an injectable `store`, so the whole lifecycle is unit-testable without a real repo.
// SERVER-ONLY (node:child_process / node:fs). Process-global singleton (survives Next dev
// HMR), mirroring registry.ts / engine.ts / journal.ts.
//
// WS-1 (storymap-parallel-work): the train also integrates AGENT SESSIONS (`kind: "session"`,
// branch `agent/<id>`), which may be CARD-LESS and are ALIVE. The gate and the split are
// byte-identical for them; what differs is (a) the integration target is the PINNED sha, not the
// branch tip (G5), (b) a failure goes back to the session as `returned-to-session` instead of
// parking (G6), and (c) the train never deletes their branch (G2 —
// {@link deleteBranchAfterIntegration}).
//
// THROUGHPUT (autocrítica G10) — an ACCEPTED limitation of v1, recorded honestly rather than
// designed around: the gate is SERIAL and costs a suite run (~minutes) per code entry. With N
// sessions submitting alongside the autorun's runs, the queue is a real FIFO with real waiting.
// This is the deliberate trade — integrating SAFELY beats integrating FAST, and the serial train
// is what kills the corruption class it was built for. The known fix (bors-style optimistic
// batching: gate K compatible entries together, bisect on red) is a FOLLOW-UP, to be done only if
// the queue becomes a MEASURED pain — not a speculative one. See `11-autocritica-e-follow-ups.md`.

import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execErrorDetail, makeGit, quote, type GitResult, type GitRunner } from "./git";
import {
  withCodeNotLandedFinding,
  withConflictedBranchFinding,
  withDataNotLandedFinding,
  withFlakyTestFinding,
  withGateBlockerFinding,
  withRunBlockersResolved,
  withSecretScanBlockerFinding,
} from "./findings";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { loadRunnerConfig, STAGING_CODE_PREFIXES, BOARD_DATA_PATHSPEC } from "./config";
import { getRunnerRegistry } from "./registry";
// O gate do train é a superfície MAIS exposta: ele lê o card de um branch de fora ANTES de ele
// aterrissar. Frontmatter só pelo chokepoint — ver o cabeçalho de frontmatter.ts. `frontmatterLimits`
// entra porque o teto de bytes deste arquivo é imposto no SPAWN do `git show` (`maxBuffer`), e tem de
// ser o MESMO número/knob do chokepoint — ver o doc de `readCardAtRef`.
import { describeFrontmatterError, frontmatterLimits, parseFrontmatter } from "@/lib/storymap/frontmatter";
import { coerceCard, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { terminalStatusIds } from "@/lib/storymap/views";
import { mergeCardThreeWay } from "@/lib/storymap/card-merge";
import { updateCardOnDisk, writeCardToPath } from "@/lib/storymap/write";
import {
  commitBoardDataScoped,
  defaultExec,
  defaultWorktreeFs,
  deprovisionNodeModules,
  provisionNodeModules,
  secretScanCommand,
  type ExecFn,
  type WorktreeFs,
} from "./worktree";
import { serialCommit, type CommitSerializer } from "./commit-serializer";
import { sanitizeSpawnEnv } from "./spawn-env";
import { patchCreatedPaths, sweepPatchCreations } from "./patch-creations";
import { partitionPaths, pathsTouchCode, promoteImportedDataPaths } from "./staging";
// story-281gg4 / story-m3iouv — a fronteira de contribuição é UMA régua para os TRÊS lugares que fazem
// `fetch`+`merge FETCH_HEAD` na árvore que o deploy publica (o `stage` e o `main` do train, o `main` do
// release), e `classifyDeltaPath` é a UMA definição de "o que não pode passar" que ela e o gate deste
// arquivo (`verificationDemand`) consomem. As duas moram em release.ts, o módulo que já é dono da
// promoção para o branch observado pelo deploy; uma segunda cópia aqui seria a segunda verdade que
// apodrece primeiro — e foi exatamente disso que nasceu o defeito (o gate chamava de CONTROLE o que a
// fronteira chamava de DADO).
import { classifyDeltaPath, judgeIncoming } from "./release";
import { resolveAffectedGate, type AffectedGateSpec } from "./affected-gate";
import { captureConflictArtifact, describeConflictArtifact, type ConflictArtifact } from "./conflict-artifact";
import { resolveGateUnits, type GateScopeSpec, type GateUnit } from "./gate-scope";
import { corridaVerdeLimpaMainRed, describeMainRed, quarantinedTestIds, recordMainRedMeasurement } from "./gate-health";
import { prepareGateTree } from "./gate-tree";
import { appendTransition } from "./transitions";
import { deltaLanded } from "./convergence";
import { recordLanding } from "./landings";
import { climbLadder, isResolved, type JudgePort, type ResolutionOutcome, type ResolutionResult } from "./semantic-resolution";
import { makeJudgePort } from "./resolution-judge-spawn";
import { isActiveMergeStatus, isLiveMergeStatus, isParkedMergeStatus } from "./merge-status";
import type { MergeQueueEntry, MergeQueueSnapshot } from "./types";
import type { Card, DiffSnapshot, Finding, TriggerId } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "./claude-bin";

// The merge runs on the MAIN tree (a few refs + a working-tree merge), never minutes — but a
// hung git would otherwise freeze the whole train, so cap each invocation generously.
const MERGE_TIMEOUT_MS = 60_000;
// Retain a bounded history of terminal entries (done/failed) for the ops panel; non-terminal
// entries (waiting/merging/conflict) are NEVER dropped (they're live work).
const MAX_TERMINAL_RETAINED = 100;
// Quantas vezes um gate INCONCLUSIVO (infra — não é defeito do submitter: crash/OOM/flake do processo do
// gate) é RE-ENFILEIRADO automaticamente antes de devolver a sessão. Um retry absorve o flake transitório
// sem obrigar um re-submit manual; o teto evita que um gate quebrado de VERDADE rode a suíte para sempre.
const MAX_GATE_INCONCLUSIVE_RETRIES = 1;
/**
 * P-3 — prazo default de uma entrada EM VOO. Generoso de propósito: o gate tem teto de 5 min, o merge
 * de 1 min, e uma suíte lenta sob contenção pode encostar neles — cortar trabalho legítimo seria trocar
 * um travamento raro por uma perda frequente. 30 min é grande demais para acontecer por acaso e pequeno
 * o bastante para o sistema se destravar dentro de um turno de trabalho.
 */
const DEFAULT_ENTRY_DEADLINE_MS = 30 * 60_000;

/**
 * PURA: dado os nomes de arquivo em `.runner/` e o conjunto de runIds que AINDA têm entrada na fila,
 * devolve os `split-<runId>-{code,data}.patch` ÓRFÃOS — os cujo dono foi podado (>MAX_TERMINAL_RETAINED).
 * Só um patch SEM entrada nenhuma é órfão: o de uma entrada retida ainda é seu artefato de recuperação
 * (findings.ts recupera a metade de dados relendo o patch do disco). Exportada para teste.
 */
export function orphanSplitPatches(files: string[], knownRunIds: ReadonlySet<string>): string[] {
  return files.filter((f) => {
    const m = f.match(/^split-(.+)-(?:code|data)\.patch$/);
    return m ? !knownRunIds.has(m[1]) : false;
  });
}
// Truncate the conflict stderr we surface to the operator (a full merge dump can be huge).
const CONFLICT_DETAIL_CAP = 500;
// Same cap for the gate's check/staging-merge output recorded on a `gate-failed` entry.
const GATE_LOG_CAP = 500;
// 6.1 — the merge-back OUTCOME hop for the durable ledger. The engine settle records the run's OPTIMISTIC
// content advance (run:<trigger>) at worktree-settle time, BEFORE the merge is known to land; when the gate
// reproves or the train parks, that hop overstates reality. Mapping the terminal queue status to an operator-
// facing outcome lets the ledger reader (6.3) reconstruct whether the advance actually reached main. Only the
// three real outcomes map — `failed` (superseded by a newer run) is queue bookkeeping, not a merge verdict.
const MERGE_OUTCOME: Partial<Record<MergeQueueEntry["status"], "approved" | "reproved" | "parked">> = {
  done: "approved",
  "gate-failed": "reproved",
  conflict: "parked",
};
// The integration gate's git plumbing (worktree add/remove for the staging tree) is fast — but
// `git worktree add` checks out HEAD, so cap generously like worktree.ts (never minutes).
const GATE_GIT_TIMEOUT_MS = 60_000;
// Defaults when the wiring doesn't pass them (mirrors the settings.yaml mergeGate defaults).
const DEFAULT_GATE_CHECK_COMMAND = "vitest run";

/**
 * WS1.2 — path-scoped park cleanup that REPLACES a wide `git reset --hard HEAD` on the LIVE checkout. The
 * board-data split guarantees the merge-back apply/commit only ever touches `storymap/boards/**`, so we
 * restore EXACTLY that subtree to HEAD (unstage → restore tracked → drop untracked) while tracked
 * modifications OUTSIDE boards/ (uncommitted code in the runtime checkout) SURVIVE untouched — closing the
 * clobber that a whole-tree reset caused. DEFENSE IN DEPTH (mirrors commitBoardDataScoped): if anything
 * OUTSIDE boards/ is STAGED at park time, ABORT without touching the checkout — a scoped restore would
 * strand that staged code and a wide reset would clobber it. Returns a `detail` when the tree can't be made
 * pristine so the caller PARKS loudly. Pure over the injected GitRunner → unit-testable without a real repo.
 */
export async function restoreDataPaths(
  git: GitRunner,
  repoRoot: string,
  pathspecs: readonly string[] = [BOARD_DATA_PATHSPEC],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  // The DATA half is `storymap/boards/**` plus any artifacts DERIVED from it (`staging.dataDerived`),
  // which live under a code prefix but are regenerated on main with their source. The guard below must
  // span exactly that set: scoped to boards/ alone it would read a regenerated artifact as "staged code
  // outside boards/" and abort every park, and a wide reset would clobber real uncommitted code.
  const specs = pathspecs.length > 0 ? pathspecs : [BOARD_DATA_PATHSPEC];
  const label = specs.join(", ");
  const inScope = (p: string) => specs.some((s) => p.startsWith(s));
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  // --no-renames so a staged rename whose SOURCE is OUTSIDE the scope (dest inside) surfaces as a
  // delete(old) + add(new): otherwise git's rename detection prints ONLY the in-scope destination, the
  // guard sees nothing outside, and the out-of-scope source deletion would be silently dropped.
  const staged = await git(`diff --cached --name-only --no-renames`, repoRoot);
  const outside = lines(staged.stdout).filter((p) => !inScope(p));
  if (outside.length > 0) {
    return {
      ok: false,
      detail: `park abortado: alterações STAGED fora de ${label} (${outside.slice(0, 5).join(", ").slice(0, 200)}) — checkout intocado p/ não clobberar código não-commitado`,
    };
  }
  // Unstage → restore tracked → drop untracked, all SCOPED. `reset` unstages a failed apply's index
  // (incl. staged-NEW cards); `checkout HEAD --` restores tracked working-tree content; `clean -fd`
  // removes the now-untracked NEW files (checkout-paths never removes untracked). Out-of-scope untouched.
  const spec = specs.map((s) => quote(s)).join(" ");
  await git(`reset -- ${spec}`, repoRoot);
  await git(`checkout HEAD -- ${spec}`, repoRoot);
  await git(`clean -fd -- ${spec}`, repoRoot);

  const resid = await git(`status --porcelain -- ${spec}`, repoRoot);
  const dirty = lines(resid.stdout);
  if (dirty.length > 0) {
    return { ok: false, detail: `${label} não ficou pristine após o restore (${dirty.slice(0, 5).join(", ").slice(0, 200)})` };
  }
  return { ok: true };
}
const DEFAULT_GATE_TIMEOUT_MS = 300_000;
// Fallback re-drive cap (story-92ldyt) when the config somehow lacks the section — mirrors the
// config.ts default. The merge-back NEVER re-drives more than this per lineage before degrading.
const DEFAULT_MAX_REDRIVES = 2;
// story-zdeajs (LOW #4): bounded re-check of the shared main working tree's cleanliness before the
// merge-back. A transient dirty tree (a concurrent in-process board commit racing this merge) clears
// in a beat; re-poll a few times before parking so we don't false-park on a momentary race. 3×200ms
// is a sub-second ceiling — short enough not to stall the train, long enough to absorb the in-process
// commit chain settling. A persistently-dirty tree (external/SSH writer) still parks for manual resolve.
const DEFAULT_CLEAN_TREE_RECHECK = { attempts: 3, delayMs: 200 } as const;

/**
 * Called (story-92ldyt) when a conflicting branch is RE-DRIVEN instead of paused: the train deleted the
 * superseded branch and asks the engine to RE-RUN the generating skill against the now-updated main, which
 * regenerates the code over the new state. The new run enqueues a FRESH branch carrying `driveCount`.
 * The train awaits ONLY the ADMISSION result ({@link RedriveResult}) — not the run's completion — so it
 * can RECOVER a card whose re-spawn was rejected (audit #5: an in-flight/no-column rejection used to
 * leave the entry terminal `re-driving` forever, with no live work and no operator path). Wired by the
 * engine via {@link MergeQueuePort.setRedriveHandler}; absent ⇒ the queue degrades to the legacy pause.
 */
export interface RedriveResult {
  /** the re-spawn was ADMITTED (queued/started) — the run continues async. false = rejected. */
  ok: boolean;
  /** why it was rejected (in-flight / rate-limited / no-column), for the operator-facing conflict detail. */
  reason?: string;
  detail?: string;
}
export type RedriveHandler = (params: {
  board: string;
  cardId: string;
  /** the generating skill to re-run (the entry's `trigger`). */
  trigger: TriggerId;
  /** the value the regenerated run must carry — already incremented past the conflicted attempt. */
  driveCount: number;
  /** the conflict stderr that triggered the re-drive (for logs/telemetry). */
  conflictDetail: string;
  /** WS-2.2: the PRESERVED branch (conflicted/run/<id>) holding the prior attempt's code, when the
   *  rename succeeded. The engine surfaces it in the redrive run's context note so the fresh agent
   *  REUSES the work (cherry-pick/inspect) instead of re-implementing from zero (the qb8z2c ~$13 loop). */
  preservedBranch?: string;
}) => Promise<RedriveResult>;

/**
 * P-3 — as entradas EM VOO cujo prazo estourou. PURA (exportada para teste).
 *
 * Uma entrada só entra aqui se estiver ATIVA (`merging`/`gate-running`) e tiver começado há mais que o
 * prazo. `waiting` NUNCA entra: esperar a vez é o funcionamento normal da fila, e matar quem espera
 * transformaria uma fila longa numa fila que come trabalho. Sem `mergeStartedAt` também não entra —
 * "não sei desde quando" jamais autoriza uma ação destrutiva (a assimetria de prova de convergence.ts).
 */
export function stuckEntries(
  entries: readonly MergeQueueEntry[],
  now: number,
  deadlineMs: number,
): MergeQueueEntry[] {
  if (!(deadlineMs > 0)) return [];
  return entries.filter(
    (e) =>
      (e.status === "merging" || e.status === "gate-running") &&
      typeof e.mergeStartedAt === "number" &&
      now - e.mergeStartedAt > deadlineMs,
  );
}

// As RÉGUAS vivem em `merge-status.ts` — ver o cabeçalho de lá sobre por que elas saíram daqui (eram
// privadas, e por isso quatro chamadores reescreveram a lista à mão). Estes três wrappers existem só
// para o resto deste arquivo seguir falando em ENTRADA em vez de status.
//
// A distinção parked×active não é cosmética — é a diferença entre "espere, tem trabalho acontecendo" e
// "espere para sempre". {@link liveRunIds} responde "quem ainda ocupa a fila" (e aí parked CONTA: uma
// entrada parqueada segura a cabeça do train); {@link activeRunIds} responde "tem algo acontecendo
// AGORA", que é a pergunta de quem vai reiniciar o serviço ou varrer worktrees.
const isLive = (e: MergeQueueEntry): boolean => isLiveMergeStatus(e.status);
const isParked = (e: MergeQueueEntry): boolean => isParkedMergeStatus(e.status);
const isActive = (e: MergeQueueEntry): boolean => isActiveMergeStatus(e.status);

/** Outcome of one boot-time recovery pass over a persisted queue. */
export interface MergeQueueRecovery {
  /** entries found on disk */
  loaded: number;
  /** `merging` entries reset to `conflict` (crash mid-merge with a dirty working tree — operator validates) */
  resetToConflict: number;
  /** `merging` entries reset to `waiting` for automatic re-drive (crash mid-merge, tree was clean) */
  resumed: number;
  /** `gate-running` entries reset to `gate-failed` (a crash mid-gate → staging may be orphan;
   * best-effort cleanup runs, the operator retries/aborts). */
  resetGateFailed: number;
  /** `waiting`/`conflict` entries DROPPED as superseded (story: backlog cleanup) — branch gone,
   * already an ancestor of HEAD, card reached a terminal column, or the branch only carried board
   * data (cards/plans/wireframes), which lives on main and is never integrated from a run branch.
   * These are the stale entries the pre-fix broken train left behind; pruning them on boot unblocks
   * the FIFO (a stale head-of-line `conflict` froze it) and clears the bogus "aguardando merge" badge. */
  pruned: number;
  /** `waiting` entries the resumed processor will work through */
  waiting: number;
}

/**
 * Run the INTEGRATION GATE for one branch (DI — like the engine's `spawn`). Merges `branch` into a
 * TEMPORARY staging worktree built from the accumulated `main` HEAD, runs `checkCommand` there, and
 * reports pass/fail WITHOUT ever touching `main`. The default ({@link makeDefaultGateRunner}) wires
 * real git + node_modules provisioning; tests inject a fake to drive the queue deterministically.
 */
export type IntegrationGateRunner = (opts: {
  exec: ExecFn;
  /** the MAIN repo working tree — the staging worktree is added from here (= accumulated main HEAD). */
  repoRoot: string;
  /** the throwaway branch to validate, `run/<runId>`. */
  branch: string;
  /** the run's sessionId — names the staging worktree/branch (`gate-<runId>` / `gate/<runId>`). */
  runId: string;
  /** command executed in `<stagingPath>/packages/storymap-ui` (e.g. `"vitest run"`). */
  checkCommand: string;
  /** wall-clock ceiling for the check, ms. */
  timeoutMs: number;
  /** WS1.3 — re-run the WHOLE suite once when a NEW failure appears; integrate if it doesn't reproduce
   *  (flaky quarantine). Default true. */
  retryOnNewFailure?: boolean;
  /** Affected-only selection (perf, opt-in). When enabled, the MERGED run tests only the entry's diff
   *  (`--changed <baseSha>`) instead of the full suite, unless a blast-radius path forces full. The BASE
   *  attribution run stays full so pre-existing failures are still detected. Absent ⇒ full suite. */
  affected?: AffectedGateSpec;
  /**
   * P-2 — o ref de que a ÁRVORE DO GATE é cortada. Presente (`stage`) ⇒ o gate monta a árvore que a
   * ATERRISSAGEM vai produzir (baseline + o MESMO patch), em vez de mesclar a branch sobre `main`.
   * Ausente (staging desligado) ⇒ o caminho legado do merge sobre `main`, byte-idêntico.
   */
  baselineRef?: string;
  /** a base do delta desta entrada — o `base` do patch que o split vai aplicar (`entry.baseCommit`) */
  deltaBase?: string;
  /** P-7 — de qual(is) pacote(s) rodar a suíte; ausente ⇒ o pacote padrão (comportamento de hoje) */
  scope?: GateScopeSpec;
  /** Typecheck BINÁRIO por árvore, canal próprio, ANTES da suíte (só unidades com `tsconfig.json`).
   *  Ausente ⇒ desligado NO RUNNER — o default ligado mora na config (`mergeGate.typecheck`), que o
   *  chamador injeta; assim os testes só medem o que injetam. */
  typecheck?: { enabled: boolean; command: string };
  /**
   * P-8 — testes em QUARENTENA: falhas deles não são atribuídas ao submitter. Não os exclui da suíte
   * (eles rodam e são reportados) — é a definição do SOTA, e aqui sai de graça porque o gate já subtrai
   * um conjunto de chaves conhecidas antes de decidir.
   */
  quarantined?: ReadonlySet<string>;
  /** true when the gate could not produce a VERDICT (crash/kill/setup error — no parseable report),
   *  as opposed to the suite actually reporting failures. Still blocks (fail-closed), but the caller
   *  must not tell the submitter their code broke: nothing was attributable. */
}) => Promise<{
  passed: boolean;
  log: string;
  inconclusive?: boolean;
  flaky?: GateFailure[];
  /**
   * P-2 — o delta NÃO APLICA na baseline. Desfecho NOVO e o mais valioso do gate: o conflito aparece
   * aqui, em segundos, ANTES de a suíte rodar (o p90 do gate é ~2 min) e já com os arquivos/regiões. O
   * chamador o dispõe como conflito (devolve à sessão / sobe a escada), nunca como "seus testes
   * quebraram" — que é o que ele dizia antes, sobre um patch que nem chegou a ser testado.
   */
  conflict?: ConflictArtifact;
  /** as falhas que JÁ existiam na baseline (main vermelha) — o produtor que faltava (P-8) */
  preexisting?: GateFailure[];
}>;

/** The injectable surface the engine + ops actions depend on (DI — like the engine's `spawn`). */
export interface MergeQueuePort {
  /** Enqueue a finished run's branch for integration (status starts `waiting`). Kicks the processor. */
  enqueueMerge(entry: Omit<MergeQueueEntry, "status" | "enqueuedAt">): Promise<void>;
  /**
   * Resolve the INTEGRATION BASE a new run's worktree must be cut from, and ensure it is current
   * (stale-base rootcause fix). Staging ON: ensure the `stage` worktree exists and sync it with the
   * released branch (so the run sees fresh board data on main + the unreleased code in flight), then
   * return `stage`'s sha. Staging OFF: return `HEAD`'s sha (pre-fix behavior). The engine calls this at
   * boundary-1 (after the live board commit, before `worktreeOps.create`) and threads the sha through
   * `create` + `enqueueMerge` as the run's `baseCommit`. Degrades to `HEAD` (never throws) if the stage
   * sync hits a genuine overlap conflict — the run still proceeds, falling back to the old base. */
  ensureRunBase(): Promise<string>;
  /** Operator signal on a paused (`conflict`) entry: `merged` = they integrated it by hand;
   * `aborted` = give up. WS-2.1: an `aborted` entry with CODE PRESERVES its branch (conflicted/run/<id>) —
   * only data-only branches are `-D`'d. WS-2.4: `actor` (human:<surface> from the UI, the token principal
   * from MCP) names WHO aborted in the failureReason (default "operador"). Queue resumes either way. */
  resolveMergeConflict(runId: string, action: "merged" | "aborted", actor?: string): Promise<void>;
  /** Operator signal on a paused (`gate-failed`) entry: `retry` = reset to `waiting` so the gate
   * runs again (the run was re-driven / a flake); `abort` = give up (WS-2.1: PRESERVE a code branch, `-D`
   * only data-only; WS-2.4: `actor` names who). Orphan staging worktree cleaned up best-effort; queue resumes. */
  resolveGateFailed(runId: string, action: "retry" | "abort", actor?: string): Promise<void>;
  /**
   * WS-8.1 (D11) — the STEWARD's ONE verb: hand a PARKED entry (`conflict`/`gate-failed`) BACK to the train,
   * which then re-runs ITS OWN disposition over it — WS-2's element-level 3-way for board data, WS-10's
   * semantic ladder for code (rung 0 convergence ⇒ `already-landed` for $0, rung 1 whitespace, rung 2 judge).
   *
   * This is deliberately the WHOLE of the steward's power over integration. It exists so the steward is a
   * TRIGGER and never a second integrator: it does not merge, does not resolve, does not touch a branch and
   * does not decide what "resolved" means — it only says "the facts changed (or the old field-level merge bug
   * is why you parked); try again". The train remains the single path to stage/main.
   *
   * The branch is left EXACTLY as it is (untouched, never deleted — D5): only the entry's terminal residue
   * from the failed attempt is cleared, exactly like `resolveGateFailed("retry")` does. The lineage counters
   * (`driveCount`, `semanticAttempts`) are PRESERVED — clearing them here would refill the very budgets that
   * loop-guard the re-drive and the judge, turning a retry into a loop. `stewardAttempts` is bumped, which is
   * what stops the steward from asking twice about the same unchanged text.
   *
   * Refuses (`ok: false`) for an unknown/non-parked entry — never a throw, never a no-op that reads as success.
   */
  retryParkedEntry(runId: string, actor: string): Promise<{ ok: boolean; detail: string }>;
  /** Runtime card↔queue reconciliation (merge-train rootcause Front 3): when a card is MOVED/reopened,
   * SUPERSEDE its PARKED entries (gate-failed/conflict — a failed integration awaiting the operator) so a
   * stale entry can't linger as a head-of-line block or ghost cockpit demand. Active entries (waiting/
   * merging/gate-running) are left to finish. Card-agnostic; a no-op when nothing is parked. */
  reconcileCardMergeEntries(board: string, cardId: string): Promise<void>;
  /** Current live picture (memory) for the registry bridge + SSE initial frame. */
  getSnapshot(): MergeQueueSnapshot;
  /** Subscribe to every state change; returns an unsubscribe fn. */
  subscribe(fn: (snap: MergeQueueSnapshot) => void): () => void;
  /** Register the engine callback the train fires when a conflict is RE-DRIVEN (story-92ldyt) instead
   * of paused. Idempotent (last registration wins); unset ⇒ a conflict degrades to the legacy pause. */
  setRedriveHandler(fn: RedriveHandler): void;
  /** Boot recovery: load the persisted queue, reset crashed `merging` → `conflict`, resume `waiting`. */
  recover(): Promise<MergeQueueRecovery>;
  /** Await any in-flight processing + persistence (tests / graceful shutdown). */
  whenIdle(): Promise<void>;
  /**
   * Subscribe to entries that finish integration (status → `done`, merge-back landed on main).
   * The cascade (evaluateAutorunOnEntry) should subscribe here to re-evaluate the card AFTER the
   * merge-back, not at the engine's settle time — that way it reads the new column from main
   * rather than a stale pre-merge-back status (story-r0zr3s). Returns an unsubscribe fn.
   */
  onMergeDone(fn: (ev: { board: string; cardId: string; trigger?: TriggerId }) => void): () => void;
  /**
   * Subscribe to EVERY entry reaching a verdict — including a card-less `kind: session` entry, which
   * {@link onMergeDone} deliberately skips (no card ⇒ no column to re-evaluate ⇒ nothing to cascade).
   *
   * That skip is right for the cascade and wrong as a blanket silence: it also muted whoever was WAITING
   * on the verdict. Combined with `returned-to-session` being terminal (so `runner_status`, which projects
   * only live entries, drops it the instant it is decided) and `conflictDetail` having had no reader on
   * the MCP surface, a session's submission used to settle in complete silence — the session was told to
   * resolve a conflict it was never told the content of. A merge train that ejects work must hand back
   * enough context to act on; this is the channel that carries it. Returns an unsubscribe fn.
   */
  onEntrySettled(
    fn: (ev: { runId: string; status: MergeQueueEntry["status"]; detail?: string }) => void,
  ): () => void;
  /**
   * The run ids (== branch `run/<id>` sessionIds) of every entry currently on the train. Ensures the
   * store is loaded. The boot reconciler's orphan-branch sweep uses this to NEVER dispose a `run/<id>`
   * branch that is legitimately pending integration — only a true settle-gap orphan (no entry) is
   * preserved/cleaned. (settle-gap-resume)
   */
  /** runIds das entradas VIVAS (waiting/gate-running/gate-failed/merging/conflict) — NÃO as terminais. */
  liveRunIds(): Promise<string[]>;
  /**
   * runIds das entradas EM VOO (waiting/gate-running/merging) — as PARKEADAS (gate-failed/conflict)
   * ficam de fora. É a pergunta "tem algo acontecendo AGORA?", que é diferente de "a fila está vazia?".
   */
  activeRunIds(): Promise<string[]>;
  /** TODOS os runIds conhecidos pela fila (vivos + terminais) — para "este run tem ALGUMA entrada?". */
  allRunIds(): Promise<string[]>;
  /**
   * P-3 — DESTRAVA a cabeça do train sem esperar um restart.
   *
   * O modo de falha que isto fecha: se `runLoop` morrer por uma exceção não-guardada no meio de uma
   * entrada, a entrada FICA `merging` e o laço sai. A partir daí toda nova chamada de `process()` entra
   * no laço, vê `entries.some(status === "merging")` e sai imediatamente — o train fica **permanentemente
   * travado, sem motivo visível e sem saída que não seja reiniciar o serviço**. Pior: o portão de
   * ociosidade do recovery sweep é `activeRunIds().length === 0`, então a mesma entrada desliga em
   * silêncio o branch-GC, o session-GC, a reconciliação de deploy e a fila de publicação.
   *
   * A SEGURANÇA VEM DE NÃO MENTIR SOBRE OCIOSIDADE. A varredura só FINALIZA a entrada quando o
   * processador NÃO está mais vivo (`processing === false`) — isto é, no caso recuperável acima. Com o
   * processador vivo (uma promessa que simplesmente demora, ou pendurou) ela apenas AVISA, com a idade:
   * marcar `failed` ali faria `activeRunIds` responder "vazio" enquanto um merge pode estar correndo, e
   * quem espera ociosidade para publicar reiniciaria o serviço por cima dele. Um aviso alto é a resposta
   * certa para "pendurado"; uma mentira nunca é.
   */
  sweepStuck(): Promise<{ swept: number; warned: number; runIds: string[] }>;
  /**
   * RE-CUTUCA o laço de integração se houver `waiting` e nada em voo. Devolve quantas entradas estavam
   * esperando quando ele agiu (0 = nada a fazer, o caso comum).
   *
   * POR QUE ELE EXISTE. O laço é bombeado só por EVENTO: `enqueueMerge`, os resolves de conflito/gate,
   * o `recover()` de boot e o `sweepStuck()`. Nunca houve tick. Só que o laço tem UM caminho que sai
   * dele sem gerar evento nenhum — o clean-gate de árvore suja, que dá `break` na FIFO INTEIRA (correto:
   * uma árvore suja condena todo merge, então varrer o resto só produziria N falhas idênticas). Passado
   * o motivo — o escritor externo terminou, a árvore limpou —, nada acorda a fila: as entradas atrás
   * seguem `waiting` até alguém enfileirar outra coisa. A sessão que já submeteu fica esperando um
   * evento que não vem, e nenhuma tela sabe dizer isso.
   *
   * Chamado pela varredura periódica (`recovery-sweep` P-3b), ANTES do portão de ociosidade — a fila
   * parada é justamente o que pode fechar o portão. É in-memory (nenhum git), e a guarda de reentrância
   * do `process()` torna a chamada redundante um no-op: cutucar de mais nunca custa.
   */
  pump(): Promise<{ waiting: number; pumped: boolean }>;
}

/** Persistence port — disk by default, in-memory in tests (keeps the queue logic pure). */
export interface MergeQueueStore {
  load(): Promise<MergeQueueEntry[]>;
  persist(entries: MergeQueueEntry[]): Promise<void>;
}

export interface MergeQueueConfig {
  /** The MAIN repo working tree — every merge runs here (never a run's worktree, already detached). */
  repoRoot: string;
  /**
   * Staged release (Fase 4a). When `enabled`, a run branch that touches CODE (a path under one of
   * `codePrefixes`, e.g. `packages/`) is SPLIT on integration: the code lands on the `branch` (default
   * `stage`) — held for the human release gate — while the run's board DATA (cards/skills/docs) lands on
   * main immediately so the live board + cascade keep advancing. A run with NO code paths is unaffected
   * (merges to main as before). BOOT-FIXED: `getMergeQueue()` reads it once from `loadRunnerConfig()`,
   * NOT per entry — so a settings edit can never split one batch of runs across main/stage mid-flight.
   * Absent/`enabled:false` ⇒ pre-staging behavior (every run merges to main). Tests inject it directly.
   */
  staging?: {
    enabled: boolean;
    branch: string;
    codePrefixes: string[];
    /** artifacts under a code prefix that DERIVE from board data → data half + regenerated on main */
    dataDerived?: { artifact: string; sources: string[]; cwd: string; regen: string }[];
  };
  exec: ExecFn;
  store: MergeQueueStore;
  /** epoch-ms clock (DI for deterministic ordering in tests). */
  now?: () => number;
  /**
   * Per-cwd commit mutex shared with the engine (story-ms5rmt). The boundary-2 board commit runs on
   * the SAME main tree as the engine's boundary-1 start commit, so both must enqueue onto ONE chain
   * keyed by cwd to avoid racing on .git/index.lock. Defaults to the process-global `serialCommit`
   * (the SAME instance the engine uses); injected as a fake in tests for isolation.
   */
  commitSerializer?: CommitSerializer;
  /**
   * The integration gate (story-1k7els): before `git merge --no-ff` on main, validate the merge in a
   * TEMPORARY staging worktree (merge there, run the suite). `null`/`undefined` = gate DISABLED (the
   * default — behavior identical to the pre-gate train). `getMergeQueue()` wires the real runner when
   * `settings.yaml`'s `autorun.mergeGate.enabled` is on; tests inject a fake.
   */
  integrationGate?: IntegrationGateRunner | null;
  /** command the gate runs in the staging tree (default `"vitest run"`). */
  gateCheckCommand?: string;
  /** affected-only selection override (tests); unset ⇒ the live `settings.yaml` `mergeGate.affected`. */
  gateAffected?: AffectedGateSpec;
  /** P-7 — escopo do gate (tests); unset ⇒ o `mergeGate.scope` vivo do `settings.yaml`. */
  gateScope?: GateScopeSpec;
  /** typecheck do gate (tests); unset ⇒ o `mergeGate.typecheck` vivo do `settings.yaml`. */
  gateTypecheck?: { enabled: boolean; command: string };
  /**
   * P-3 — PRAZO de uma entrada EM VOO (ms). Toda chamada git tem timeout e o gate tem teto, mas a ENTRADA
   * não tinha prazo nenhum — e uma cabeça travada não é só uma entrada parada: o portão de ociosidade do
   * recovery sweep é `activeRunIds().length === 0`, então ela desliga em SILÊNCIO o branch-GC, o
   * session-GC, a reconciliação de deploy e a fila de publicação. É a mesma família do bug que o
   * doc-comment de {@link MergeQueuePort.liveRunIds} narra como resolvido, por uma porta nova.
   * Default: teto do gate + 2 × o teto do merge, com uma folga — grande o bastante para nunca cortar
   * trabalho legítimo, finito o bastante para o sistema se destravar sozinho.
   */
  entryDeadlineMs?: number;
  /** WS1.3 — override the flaky-retry knob (tests); unset ⇒ the live `settings.yaml` value, then true. */
  gateRetryOnNewFailure?: boolean;
  /** wall-clock ceiling for the gate check, ms (default 300_000). */
  gateTimeoutMs?: number;
  /**
   * story-zdeajs (AC4): the filesystem surface used by the GOLDEN-SNAPSHOT regeneration step (it links
   * the main checkout's node_modules into the worktree before running `bunx vitest run -u`, then drops
   * the links). Defaults to {@link defaultWorktreeFs} (real `node:fs`); tests inject a recording fake so
   * the snap-regen path is unit-testable without touching disk. Absorbs retired card 2iiehr's DI gap —
   * the regen previously reached for the module-level `defaultWorktreeFs` directly with no DI.
   */
  snapFs?: WorktreeFs;
  /**
   * story-zdeajs (AC4): wall-clock ceiling, ms, for the golden-snapshot regen (`bunx vitest run -u`).
   * Defaults to {@link DEFAULT_GATE_TIMEOUT_MS} (300_000 — the suite can take minutes on the main tree).
   */
  snapRegenTimeoutMs?: number;
  /**
   * WS-10/D14 — rung 2 of the SEMANTIC LADDER: the `harness-resolve` judge port. Present ⇒ a CODE text conflict
   * climbs the ladder (convergence → deterministic whitespace filter → judge) before it parks for a human.
   * Absent ⇒ the ladder still runs its two FREE rungs and then escalates — the exact same degradation as a
   * missing RedriveHandler, never a crash. `getMergeQueue()` wires the real spawn; tests inject a fake, which
   * is why this is DI and not an import (a real port here would spawn `claude` from a unit test).
   */
  judge?: JudgePort;
  /**
   * story-zdeajs (LOW #4): the dirty-tree clean-gate's BOUNDED re-check before parking. The shared `main`
   * working tree can be momentarily dirty because a CONCURRENT in-process writer (another autorun board
   * commit racing this merge-back) is mid-flight; that clears on its own in a beat. Rather than false-park
   * the FIFO head on a transient dirty tree (and only THEN tell the operator "aguarde o train ocioso"),
   * the gate re-polls `git status --porcelain` up to `attempts` times with `delayMs` between polls; it
   * parks ONLY if STILL dirty after the bound (a genuine external/SSH writer — manual resolve). Defaults:
   * {@link DEFAULT_CLEAN_TREE_RECHECK} (3 attempts × 200ms). Tests inject `{ attempts: 1 }` + a fake
   * `sleep` for determinism. A `clean` outcome lets the merge proceed; bounded so a never-clean tree can't
   * hang the train.
   */
  cleanTreeRecheck?: { attempts?: number; delayMs?: number };
  /** Injectable sleep (story-zdeajs LOW #4) for the dirty-tree re-check backoff. Defaults to a real
   * `setTimeout`-based sleep; tests inject a no-op (or a recording fake) to stay deterministic. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * SM-06 hot-reload (AC3): whether the integration gate is ACTIVE. When set, it is the authority
   * (DI override used by tests). When LEFT UNDEFINED (production), `runLoop()` re-reads the live
   * `loadRunnerConfig().autorun.mergeGate.enabled` per entry — so flipping `settings.yaml` takes effect
   * on the next processed branch WITHOUT a service restart. `getMergeQueue()` always wires
   * `integrationGate` (the runner) and leaves `gateEnabled` undefined so the live config is the switch.
   */
  gateEnabled?: boolean;
  /**
   * SM-06 (AC2): stamps a `testing:blocker` finding on the card when the integration gate REPROVES,
   * so the failed branch surfaces as a blocked card (the `hasNoBlockers` gate then keeps it out of QA)
   * and the operator sees WHY in the card. Defaults to an `updateCardOnDisk` composition; tests inject a
   * recording fake. Non-fatal at the call site — a write error never stalls the train.
   */
  addGateBlocker?: (board: string, cardId: string, runId: string, gateLog: string) => Promise<void>;
  /**
   * SM-08: stamps a `security:blocker` finding on the card when the MERGE-COMMIT secret scan blocks the
   * push (a secret was found, OR the scanner hit an internal error → fail-closed). The card then surfaces
   * as blocked (held out of QA by `hasNoBlockers`) and the operator sees WHY. Defaults to an
   * `updateCardOnDisk` composition; tests inject a recording fake. Non-fatal at the call site — a write
   * error never un-blocks the push or stalls the train.
   */
  addSecretScanBlocker?: (board: string, cardId: string, runId: string, detail: string) => Promise<void>;
  /**
   * audit #6: clears THIS run's OWN gate-failure + secret-scan blockers (run-scoped ids) on a
   * SUCCESSFUL integration, so a `retry`-then-pass (or any re-merge after a block) doesn't leave a
   * stale `open` blocker holding the card out of `qa-automatizado` forever. Defaults to an
   * `updateCardOnDisk` composition; tests inject a recording fake. Non-fatal at the call site.
   */
  clearRunBlockers?: (board: string, cardId: string, runId: string) => Promise<void>;
  /**
   * Reads whether a card already sits in a TERMINAL column (concluída/arquivados/cancelado/…).
   * recover() uses it to PRUNE merge-queue entries for finished cards: a terminal card has nothing
   * left to integrate, so a `run/<id>` branch the broken pre-fix train stranded for it must be dropped
   * on boot — not resurrected as `waiting` (which froze the FIFO and showed a bogus "aguardando merge"
   * badge on an already-done card). `getMergeQueue()` wires a repo-backed reader; tests inject a stub.
   * Undefined ⇒ the terminal-card prune rule is skipped (the other rules still apply).
   */
  isCardTerminal?: (board: string, cardId: string) => Promise<boolean>;
  /**
   * SM-04: persists the run-diff SHAs onto a card after a successful merge, right before the
   * branch is force-deleted (so the card modal can reconstruct the diff once the branch is gone).
   * Defaults to an `updateCardOnDisk` composition (locked read-modify-write, mirroring `addGateBlocker`);
   * tests inject a recording fake. Non-fatal at the call site — a failure here never stalls the train.
   */
  persistDiffSnapshot?: (board: string, cardId: string, snapshot: DiffSnapshot) => Promise<void>;
  /**
   * SM-07: on a RE-DRIVE, the conflicted branch is PRESERVED (renamed `conflicted/<orig>`) instead
   * of force-deleted, so the operator can still inspect/apply the original diff if the regenerated
   * run diverges. This stamps a `low`/`general` finding on the card naming the preserved branch.
   * Defaults to an `updateCardOnDisk` composition (locked read-modify-write, mirroring
   * `addGateBlocker`); tests inject a recording fake. Non-fatal at the call site — a failure never
   * stalls the train. A `low` finding does NOT block the `hasNoBlockers` gate (only `blocker` does).
   */
  persistConflictedBranchFinding?: (
    board: string,
    cardId: string,
    runId: string,
    conflictedBranch: string,
    driveAttempt: number,
  ) => Promise<void>;
  /**
   * Fase 4b: stamp `stagedAt` on the card once the split has integrated its code onto the `stage`
   * branch — the signal that the card has unreleased code waiting for the human release (gate hasStaged).
   * Defaults to an `updateCardOnDisk` composition stamping today's date; tests inject a recording fake.
   * Non-fatal at the call site — a write error never stalls the train (mirrors persistDiffSnapshot).
   */
  stampStaged?: (board: string, cardId: string) => Promise<void>;
  /**
   * autonomy-reliability WS-1.2: stamps a `general:blocker` finding on the card when the CODE half of the
   * split FAILED to land the run's code on `stage` (so the DATA half never ran and the card did NOT advance).
   * The blocker holds the card out of `qa-automatizado` (gate `hasNoBlockers`) so the telemetry-`ok` stops
   * contradicting the kanban ("done" without code — the lost-impl of story-qb8z2c). Defaults to an
   * `updateCardOnDisk` composition; tests inject a recording fake. Non-fatal at the call site — a write error
   * never stalls the train (mirrors addSecretScanBlocker).
   */
  addCodeNotLandedBlocker?: (
    board: string,
    cardId: string,
    runId: string,
    preservedBranch: string,
    detail?: string,
  ) => Promise<void>;
  /**
   * autonomy-endgame WS-3.4: the MIRROR of {@link addCodeNotLandedBlocker} — stamps a `general:blocker` when
   * the DATA half failed to apply on `main` while the code IS safe on `stage`. Nobody had modelled this half:
   * the card sits at its pre-integration status with its tasks unmarked while the feature is already staged,
   * and the only detector's guard excluded it explicitly (`codeStaged` true → "code is safe on stage") —
   * true about the CODE, blind about the CARD. Same shape/lifecycle as the sibling (idempotent by runId,
   * auto-cleared by a later successful integration, non-fatal at the call site).
   */
  addDataNotLandedBlocker?: (board: string, cardId: string, runId: string, detail?: string) => Promise<void>;
}

/** Default SM-04 snapshot persister. audit #13: route through updateCardOnDisk so the re-read happens
 * INSIDE the per-card lock — the old unlocked readCard→writeCard pair clobbered any concurrent writer
 * (drawer Save, MCP update_card, the autorun forward) with the stale whole-card it had read. A deleted
 * card → no-op (updateCardOnDisk returns null). Mirrors every sibling stamper in this file. */
async function defaultPersistDiffSnapshot(
  board: string,
  cardId: string,
  snapshot: DiffSnapshot,
): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({ ...card, diffSnapshot: snapshot }));
}

/** Default Fase 4b stagedAt stamper: mark the card with today's date (read-modify-write under the
 * per-card lock). A missing card is a no-op (updateCardOnDisk → null). The Date is read HERE (the impure
 * boundary), keeping the queue logic itself deterministic. */
async function defaultStampStaged(board: string, cardId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await updateCardOnDisk(board, cardId, (card) => ({ ...card, stagedAt: today }));
}

/** Staging worktree dir/branch for a run's gate — sibling of the run worktrees, gitignored. */
function gateStagingPath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, ".worktrees", `gate-${runId}`);
}
function gateStagingBranch(runId: string): string {
  return `gate/${runId}`;
}

/** Fase 4a: the PERSISTENT stage worktree dir — a SIBLING of the repo (`<repo>-stage`), deliberately
 * OUTSIDE `.worktrees/` (where the gate's throwaway trees + the orphan reaper live) so it is long-lived,
 * never reaped, and its checkout never collides with main's (the systemd service's live tree). */
export function stageWorktreePath(repoRoot: string, branch: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-${branch}`);
}

/** Best-effort teardown of a gate staging worktree (dir + branch). NEVER throws — used both at the
 * end of a gate run and during boot recovery on a possibly-orphan staging tree. Drops the provisioned
 * node_modules links FIRST (same teardown guard as worktree.ts) so git never follows a link into main. */
async function cleanupGateStaging(
  exec: ExecFn,
  fs: WorktreeFs,
  repoRoot: string,
  runId: string,
): Promise<void> {
  const stagingPath = gateStagingPath(repoRoot, runId);
  const branch = gateStagingBranch(runId);
  try {
    await deprovisionNodeModules(fs, repoRoot, stagingPath);
  } catch {
    /* best-effort */
  }
  try {
    await exec(`git worktree remove ${quote(stagingPath)} --force`, { cwd: repoRoot, timeout: GATE_GIT_TIMEOUT_MS });
  } catch {
    /* already gone / never created */
  }
  try {
    // WS-1/G2 audit: this is the ONE `branch -D` that does NOT route through the train's
    // deleteBranchAfterIntegration guard, and correctly so — `branch` here is the gate's OWN throwaway
    // `gate/<runId>` (minted and checked out by cleanupGateStaging's staging worktree, torn down above).
    // It is structurally incapable of naming a `run/*` or `agent/*` branch, so there is no session work to
    // protect; routing it through the entry-shaped guard would only fake a check it can't perform.
    await exec(`git branch -D ${quote(branch)}`, { cwd: repoRoot, timeout: GATE_GIT_TIMEOUT_MS });
  } catch {
    /* already gone */
  }
}

/** Default {@link MergeQueueConfig.addGateBlocker}: stamps the gate-failure blocker onto the card on
 * disk (read-modify-write under the per-card lock). A missing card is a no-op (updateCardOnDisk → null). */
async function defaultAddGateBlocker(board: string, cardId: string, runId: string, gateLog: string): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({
    ...card,
    findings: withGateBlockerFinding(card.findings ?? [], runId, gateLog),
  }));
}

/** Default {@link MergeQueueConfig.addSecretScanBlocker}: stamps the secret-scan blocker onto the card on
 * disk (read-modify-write under the per-card lock). A missing card is a no-op (updateCardOnDisk → null). */
async function defaultAddSecretScanBlocker(board: string, cardId: string, runId: string, detail: string): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({
    ...card,
    findings: withSecretScanBlockerFinding(card.findings ?? [], runId, detail),
  }));
}

/** Default {@link MergeQueueConfig.clearRunBlockers}: flips this run's own gate/secret-scan blockers
 * from `open` → `fixed` on disk (read-modify-write under the per-card lock). Run-scoped + idempotent
 * (touches only the two ids the train stamped for runId). A missing card is a no-op. */
async function defaultClearRunBlockers(board: string, cardId: string, runId: string): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({
    ...card,
    // WS-2 (2.3): stamp the train as the author of the closure — the colisão #2 post-mortem could not tell
    // an auto-resolve from an operator triage by reading the card.
    findings: withRunBlockersResolved(card.findings ?? [], runId, {
      by: `train:${runId}`,
      at: new Date().toISOString().slice(0, 10),
    }),
  }));
}

/** Default {@link MergeQueueConfig.persistConflictedBranchFinding}: stamps the preserved-branch
 * finding onto the card on disk (read-modify-write under the per-card lock — safe against the
 * redriven skill run touching the same card). A missing card is a no-op (updateCardOnDisk → null). */
async function defaultPersistConflictedBranchFinding(
  board: string,
  cardId: string,
  runId: string,
  conflictedBranch: string,
  driveAttempt: number,
): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({
    ...card,
    findings: withConflictedBranchFinding(card.findings ?? [], runId, conflictedBranch, driveAttempt),
  }));
}

/** Default {@link MergeQueueConfig.addCodeNotLandedBlocker} (autonomy-reliability WS-1.2): stamps the
 * "código não aterrissou" blocker onto the card on disk (read-modify-write under the per-card lock). A
 * missing card is a no-op (updateCardOnDisk → null). */
async function defaultAddCodeNotLandedBlocker(
  board: string,
  cardId: string,
  runId: string,
  preservedBranch: string,
  detail?: string,
): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({
    ...card,
    findings: withCodeNotLandedFinding(card.findings ?? [], runId, preservedBranch, detail),
  }));
}

/** Default {@link MergeQueueConfig.addDataNotLandedBlocker} (autonomy-endgame WS-3.4): the mirror of the
 * above — stamps the "board-data não aterrissou" blocker onto the card on disk. Missing card ⇒ no-op. */
async function defaultAddDataNotLandedBlocker(
  board: string,
  cardId: string,
  runId: string,
  detail?: string,
): Promise<void> {
  await updateCardOnDisk(board, cardId, (card) => ({
    ...card,
    findings: withDataNotLandedFinding(card.findings ?? [], runId, detail),
  }));
}

/**
 * story-zdeajs (CRITICAL prod fix): merge `branch` INTO the gate's staging worktree, made
 * GOLDEN-SNAPSHOT-AWARE. This is the PRODUCTION integration gate path (staging.enabled=TRUE +
 * mergeGate.enabled=TRUE both hold in prod), and it ran a BARE `git merge --no-ff --no-edit` that
 * ABORTS on a `*.snap` divergence — `.gitattributes:53` marks `*.snap binary`, so git can't textually
 * merge two independently-regenerated snapshots and leaves them as UNMERGED paths. The gate read that
 * abort as a flat "staging merge falhou" → the entry parked as `gate-failed` BEFORE `integrateSplit`'s
 * own snap-regen ever ran, false-parking a card whose ONLY divergence is a derived snapshot.
 *
 * Standalone (the gate runner is module-level, with no `makeMergeQueue` closure), but it mirrors the
 * closure's two-phase `mergeWithSnapResolution`:
 *   1. `git merge --no-ff --no-commit <branch>` in the staging tree. On success → commit, done.
 *   2. On conflict, list the UNMERGED paths (`diff --name-only --diff-filter=U`) and PARTITION them. The
 *      gate validates only CODE, so the sole conflict class that can invalidate its `vitest` verdict is
 *      deployable code (`packages/**`, excluding derived `*.snap`) → if ANY such path is unmerged it is a
 *      REAL content conflict → abort + report it (the prior behavior for code). A conflict ONLY in board
 *      DATA (`storymap/**`, `.claude/**`, docs) or in a `*.snap` cannot change the code suite's result, so
 *      it must NOT fail the code gate (Defect B1 / story-olr777): board data is resolved by taking the
 *      run's side (throwaway tree), snaps are REGENERATED from the now-merged source (`bunx vitest run -u`
 *      in the staging pkg dir, node_modules linked in), then re-staged + committed so the gate proceeds to
 *      the suite. A `vitest -u` failure during regen → abort + report (block, never paper over a red test).
 * Returns `{ ok }` (the merge is now committed on the staging HEAD with snaps regenerated, so the
 * caller's validation suite runs against fresh snaps) or `{ ok:false, log }` (a real conflict / regen
 * failure — the caller blocks the gate). NEVER leaves a half-merge: every failure path `merge --abort`s.
 * Pure over the injected `exec`/`fs`.
 */
async function mergeBranchIntoStaging(
  exec: ExecFn,
  fs: WorktreeFs,
  repoRoot: string,
  stagingPath: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; log: string }> {
  const detailOf = (err: unknown): string => execErrorDetail(err, GATE_LOG_CAP);
  const gitS = async (args: string): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
    try {
      const r = await exec(`git ${args}`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS });
      return { ok: true, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown };
      return { ok: false, stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? "") };
    }
  };

  // Phase 1 — merge WITHOUT committing so we can resolve the binary snaps by hand before completing.
  const merge = await gitS(`merge --no-ff --no-commit ${quote(branch)}`);
  if (merge.ok) {
    // No conflict at all (no snap divergence, or git fast-resolved) → finish the merge commit.
    const committed = await gitS(`commit --no-verify --no-edit`);
    if (committed.ok) return { ok: true };
    await gitS(`merge --abort`);
    return { ok: false, log: `staging merge falhou: ${committed.stderr || committed.stdout || "commit"}` };
  }

  // Phase 2 — a conflict. Partition the unmerged paths. The gate exists SOLELY to run `vitest` against
  // the merged CODE in a THROWAWAY staging tree; so the ONLY conflict class that can invalidate that
  // verdict is DEPLOYABLE CODE (`packages/**`, excluding derived `*.snap`). A conflict that is ONLY in
  // board DATA (cards/skills/docs under `storymap/**`, `.claude/**` …) or in a derived `*.snap` cannot
  // change the code suite's result — so it must NOT fail the CODE gate (Defect B1 / story-olr777). A
  // board-data-only run whose card `.md` overlapped main's copy used to hard-fail here and park as
  // `gate-failed`, and the failure then wrote a blocker into that SAME card on main, so every retry
  // conflicted harder — a self-perpetuating freeze. We now resolve the non-code conflicts IN THE
  // THROWAWAY TREE (never main): take the run's side of board data, regenerate snaps, and proceed to the
  // suite. The run's REAL board-data integration still happens later on the split's path (where a
  // genuine card overlap re-drives instead of freezing).
  const unmerged = await gitS(`diff --name-only --diff-filter=U`);
  const unmergedPaths = unmerged.ok ? unmerged.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const isSnap = (p: string): boolean => p.endsWith(".snap");
  const isCode = (p: string): boolean => STAGING_CODE_PREFIXES.some((prefix) => p.startsWith(prefix));
  const realCodeConflicts = unmergedPaths.filter((p) => isCode(p) && !isSnap(p));
  if (unmergedPaths.length === 0 || realCodeConflicts.length > 0) {
    // A real CODE conflict (or a conflict git left with no unmerged paths) → abort (no half-merge) +
    // report it (the EXACT prior behavior for code, with git's stderr surfaced like the old bare merge).
    await gitS(`merge --abort`);
    return { ok: false, log: `staging merge falhou: ${merge.stderr || merge.stdout || "CONFLICT"}` };
  }
  // Board-data conflicts (non-code): take the run's side. This is a THROWAWAY resolution — the staging
  // tree is discarded after the suite runs, so it never reaches main; the split integrates the real data.
  const boardConflicts = unmergedPaths.filter((p) => !isCode(p));
  for (const bf of boardConflicts) {
    await gitS(`checkout --theirs -- ${quote(bf)}`);
    await gitS(`add -- ${quote(bf)}`);
  }
  // Snap conflicts: take the run's version, then OVERWRITE it with the canonical regenerated output (so
  // the snap matches the merged source, not just blindly the run's side). A vitest failure here is a
  // GENUINE red test the regen can't paper over → abort + block.
  const snapConflicts = unmergedPaths.filter(isSnap);
  if (snapConflicts.length > 0) {
    for (const sf of snapConflicts) {
      await gitS(`checkout --theirs -- ${quote(sf)}`);
      await gitS(`add -- ${quote(sf)}`);
    }
    const pkgDir = path.join(stagingPath, "packages", "storymap-ui");
    let regenErr: string | null = null;
    try {
      await provisionNodeModules(fs, repoRoot, stagingPath);
      await exec(`bunx vitest run -u`, { cwd: pkgDir, timeout: DEFAULT_GATE_TIMEOUT_MS });
    } catch (err) {
      regenErr = detailOf(err);
    }
    await deprovisionNodeModules(fs, repoRoot, stagingPath).catch(() => {});
    if (regenErr) {
      await gitS(`merge --abort`); // restore the pre-merge staging tip; nothing half-applied
      return { ok: false, log: `staging snap regen falhou: ${regenErr}` };
    }
    // Re-stage the regenerated snaps before the merge commit.
    for (const sf of snapConflicts) {
      await gitS(`add -- ${quote(sf)}`);
    }
  }
  const committed = await gitS(`commit --no-verify --no-edit`);
  if (!committed.ok) {
    await gitS(`merge --abort`);
    return { ok: false, log: `staging merge falhou: ${committed.stderr || committed.stdout || "commit"}` };
  }
  return { ok: true };
}

/** O pacote a que um caminho repo-relativo pertence (`packages/<x>/…` → `packages/<x>`), ou null. PURA.
 *  Substitui o `packages/storymap-ui` literal que estava em três lugares: qual pacote regenerar/testar é
 *  uma propriedade do CAMINHO, não uma constante do harness (D13). */
export function packageDirOf(file: string): string | null {
  const m = file.match(/^(packages\/[^/]+)\//);
  return m ? m[1] : null;
}

// story-m3iouv — o que a classificação de caminho IMPEDE: que uma mudança atravesse o train sem o gate
// rodar nada só porque o caminho dela não começa por `packages/`. A régua era uma ALLOW-LIST DE PREFIXO
// ("é código se está sob `codePrefixes`"), então `.github/**`, `justfile`, `scripts/**` e as configs de
// raiz fundiam SEM verificação alguma — inclusive `scripts/git-hooks/scan-secrets.mjs`, o PRÓPRIO scanner
// de segredo do pipeline. Quem alcança o train (hoje o dono e a frota; num repo público, potencialmente
// uma contribuição de fora) podia DESARMAR o controle de segurança por um caminho que o controle não
// cobre. A prova aconteceu: `c5c2f0013` apagou os 5 workflows de CI e foi para `origin/main` sem passar
// por nada — ali era intencional, mas o mecanismo não sabia disso, e não saberia na próxima vez.
//
// A DEFINIÇÃO (`classifyDeltaPath`: a deny-list `board-data`/`control`/`code`/`unclassified`) mora em
// release.ts, ao lado da fronteira de proveniência que a consome — ver o bloco story-m3iouv lá. Este
// arquivo é o outro consumidor, e é dessa unificação que se trata: enquanto havia duas réguas de "o que é
// perigoso", a mais permissiva ganhava (bastava ao atacante escolher o caminho que ela cobria).

/** O veredito de {@link verificationDemand}: se a suíte roda, quais arquivos de CONTROLE o delta toca, e por quê. */
export interface VerificationDemand {
  /** o gate de integração deve rodar sobre este delta */
  needsVerification: boolean;
  /** os caminhos de classe `control` (subconjunto do delta) — vazio na maioria absoluta dos deltas */
  controlPaths: string[];
  /** motivo legível, para o log/rastro do operador (nunca para casar por substring) */
  reason: string;
}

/**
 * story-m3iouv — O QUE EXIGE VERIFICAÇÃO, pela deny-list de {@link classifyDeltaPath}.
 *
 * Um delta 100% `board-data` (ou vazio) segue pelo caminho de dados como sempre: nada a verificar.
 * QUALQUER outra classe liga o gate. Um diff ILEGÍVEL (o `git diff` falhou) verifica também — fail-closed:
 * antes, um erro de git virava lista vazia e a lista vazia virava "não é código", ou seja o único caso em
 * que NÃO se sabe o que está entrando era exatamente o caso que fundia sem olhar.
 * PURA.
 */
export function verificationDemand(
  changedFiles: readonly string[],
  codePrefixes: readonly string[],
  opts: { diffReadable?: boolean } = {},
): VerificationDemand {
  if (opts.diffReadable === false) {
    return {
      needsVerification: true,
      controlPaths: [],
      reason: "diff ILEGÍVEL — verifica (fail-closed): não se funde o que não se consegue classificar",
    };
  }
  const classes = changedFiles.map((p) => ({ p, c: classifyDeltaPath(p, codePrefixes) }));
  const demanding = classes.filter((x) => x.c !== "board-data");
  if (demanding.length === 0) {
    return {
      needsVerification: false,
      controlPaths: [],
      reason: changedFiles.length === 0 ? "delta vazio — nada a verificar" : "delta 100% board-data — segue pelo caminho de dados",
    };
  }
  const controlPaths = demanding.filter((x) => x.c === "control").map((x) => x.p);
  const byClass = [...new Set(demanding.map((x) => x.c))].join("+");
  return {
    needsVerification: true,
    controlPaths,
    reason:
      `${demanding.length} caminho(s) exigem verificação (${byClass}): ${demanding.slice(0, 5).map((x) => x.p).join(", ")}` +
      `${demanding.length > 5 ? ` (+${demanding.length - 5})` : ""}`,
  };
}

/**
 * Regenera os `*.snap` DENTRO da árvore do gate, no pacote a que cada um pertence. A árvore já vem com
 * `node_modules` ligado (quem a montou provisionou), então aqui só roda o `vitest -u`.
 * NUNCA lança — devolve `failed` com o motivo, que o chamador trata como defeito do delta.
 */
async function regenSnapshotsInTree(
  exec: ExecFn,
  treePath: string,
  snapFiles: string[],
  timeoutMs: number,
): Promise<{ status: "regenerated" | "noop" | "failed"; detail?: string }> {
  const pkgs = [...new Set(snapFiles.map(packageDirOf).filter((p): p is string => !!p))];
  if (pkgs.length === 0) return { status: "noop" };
  try {
    for (const p of pkgs) {
      await exec(`bunx vitest run -u`, { cwd: path.join(treePath, p), timeout: timeoutMs });
    }
  } catch (err) {
    return { status: "failed", detail: execErrorDetail(err, 160) };
  }
  return { status: "regenerated" };
}

/**
 * Production {@link IntegrationGateRunner}.
 *
 * P-2 — UMA RÉGUA. Quando a `baselineRef` está presente (produção: `stage`), a árvore descartável é
 * cortada DELA e recebe o MESMO patch que a aterrissagem vai aplicar ({@link prepareGateTree}). Antes,
 * a árvore vinha do HEAD de `main` e o delta entrava por `git merge` — duas composições diferentes sobre
 * bases diferentes, então "gate verde" nunca implicou "aplica limpo" (medido: `db87b761` gateou verde em
 * 134 s e morreu com `split: código conflita com stage`). Agora o patch que falha falha AQUI, em segundos,
 * com os arquivos nomeados, antes de a suíte custar os ~2 min do p90.
 *
 * P-7 — a suíte vem do ESCOPO do delta ({@link resolveGateUnits}), não de `packages/storymap-ui` literal.
 *
 * Sem `baselineRef` (staging desligado) o caminho legado do merge sobre `main` segue byte-idêntico —
 * degradar para o comportamento de ontem é sempre melhor que travar o train. `main` NUNCA é tocada aqui,
 * e a limpeza da árvore roda em TODOS os caminhos de saída.
 */
export function makeDefaultGateRunner(fs: WorktreeFs = defaultWorktreeFs): IntegrationGateRunner {
  return async ({
    exec,
    repoRoot,
    branch,
    runId,
    checkCommand,
    timeoutMs,
    retryOnNewFailure = true,
    affected,
    baselineRef,
    deltaBase,
    scope,
    typecheck,
    quarantined,
  }) => {
    const stagingPath = gateStagingPath(repoRoot, runId);
    const stagingBranch = gateStagingBranch(runId);
    const detailOf = (err: unknown): string => execErrorDetail(err, GATE_LOG_CAP);
    // P-2 só entra com os DOIS ingredientes: sem a base do delta não há patch a aplicar, e cortar da
    // baseline sem aplicar nada validaria a árvore errada — pior que o caminho legado.
    const useBaseline = !!baselineRef && !!deltaBase;

    // Defensive: a stale staging tree from a crashed prior run would make `git worktree add` fail.
    await cleanupGateStaging(exec, fs, repoRoot, runId);

    // The pre-merge main HEAD — the BASE the attribution re-run resets to, so a card is blocked ONLY by
    // failures ITS diff introduced (not a red/flaky main). Captured before the branch is merged in.
    let baseSha = "";
    if (useBaseline) {
      // P-2 — a árvore que a ATERRISSAGEM vai produzir: baseline + o mesmo patch, mesmo `--3way`.
      const prepared = await prepareGateTree(
        {
          exec,
          fs,
          provisionNodeModules,
          regenerateSnapshots: (treePath, snaps) => regenSnapshotsInTree(exec, treePath, snaps, timeoutMs),
          join: (...parts) => path.join(...parts),
          readFile: (abs) => fsp.readFile(abs, "utf8"),
        },
        {
          repoRoot,
          treePath: stagingPath,
          treeBranch: stagingBranch,
          baseline: baselineRef!,
          deltaBase: deltaBase!,
          deltaHead: branch,
          patchFile: path.join(runnerStateDir(), `gate-${runId}.patch`),
          timeoutMs: GATE_GIT_TIMEOUT_MS,
        },
      );
      if (!prepared.ok) {
        await cleanupGateStaging(exec, fs, repoRoot, runId);
        // CONFLITO ≠ REPROVAÇÃO. Um patch que não aplica não é "seus testes quebraram" — nada foi
        // testado. O chamador roteia isto como conflito (devolve à sessão / sobe a escada); infra
        // (`setup`) vai como INCONCLUSIVO, que já tem re-enfileiramento próprio.
        if (prepared.kind === "conflict") return { passed: false, conflict: prepared.conflict, log: prepared.log };
        return { passed: false, inconclusive: true, log: prepared.log };
      }
      baseSha = prepared.baseSha;
    } else {
      try {
        // Caminho LEGADO (staging desligado): árvore no HEAD de `main` + merge da branch.
        await exec(`git worktree add ${quote(stagingPath)} -b ${quote(stagingBranch)}`, {
          cwd: repoRoot,
          timeout: GATE_GIT_TIMEOUT_MS,
        });
        baseSha = (await exec(`git rev-parse HEAD`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS })).stdout.trim();
        // Deps don't hoist + node_modules is gitignored → link the main checkout's in (instant, no install).
        await provisionNodeModules(fs, repoRoot, stagingPath);
      } catch (err) {
        await cleanupGateStaging(exec, fs, repoRoot, runId);
        return { passed: false, log: `gate setup falhou: ${detailOf(err)}` };
      }
    }

    try {
      // Merge the run branch INTO the staging tree, SNAP-AWARE (story-zdeajs, CRITICAL prod fix). A
      // NON-snap conflict here IS a (textual) integration failure — report it without even running the
      // suite (the operator re-drives or aborts). A SNAP-ONLY divergence (binary `*.snap`) is RESOLVED by
      // regenerating the snapshots from the merged source so the gate proceeds to the validation suite
      // (which then passes with fresh snaps) instead of false-parking the card. Main stays intocada.
      if (!useBaseline) {
        const mergedIn = await mergeBranchIntoStaging(exec, fs, repoRoot, stagingPath, branch);
        if (!mergedIn.ok) {
          return { passed: false, log: mergedIn.log };
        }
      }
      // O DELTA que esta árvore carrega — decide TANTO o escopo (P-7) quanto a seleção affected.
      let changedInTree: string[] = [];
      try {
        const diff = await exec(`git diff --name-only ${quote(baseSha)}..HEAD`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS });
        changedInTree = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      } catch {
        /* sem delta legível → escopo e affected caem no conservador (suíte padrão, completa) */
      }
      // P-7 — QUAIS suítes. O fallback cobre o delta que o mapa não conhece.
      //
      // O DEFAULT É HISTÓRICO, E É UMA PREMISSA QUE EXPIROU. `packages/storymap-ui` só era caminho válido
      // no repositório do usuário enquanto a ferramenta morava DENTRO dele. Desde a inversão ela roda de um
      // checkout próprio, e esse caminho no alvo é cópia morta — ou não existe. Quando não existe, a recusa
      // logo abaixo dispara para TODA entrada com código: a fila inteira congela, e o alvo não tem como
      // consertar sozinho, porque o valor está aqui, no código da FERRAMENTA.
      //
      // Por isso ele passa a ser DECLARÁVEL pelo alvo (`mergeGate.scope.fallback`). Ausente ⇒ o default de
      // sempre, byte a byte: quem não declarar nada não muda de comportamento — e no artefato publicado o
      // default continua CERTO, porque lá `packages/storymap-ui` existe de verdade.
      const declaredFallback = scope?.fallback;
      const fallbackUnit: GateUnit = declaredFallback
        ? { cwd: declaredFallback.cwd, command: declaredFallback.command ?? checkCommand, label: declaredFallback.cwd }
        : { cwd: "packages/storymap-ui", command: checkCommand, label: "packages/storymap-ui" };
      const scoped = resolveGateUnits(changedInTree, fallbackUnit, scope);

      // ── RECUSA, e ela NÃO é uma reprovação de teste ────────────────────────────────────────────────
      // Toda unidade tem de EXISTIR na árvore medida. O fallback é o pacote da própria ferramenta, e ele
      // deixa de ser garantido quando a ferramenta passa a morar noutro checkout: `<stage>/packages/...`
      // vira cópia morta, ou some. Sem esta medição o gate rodaria a suíte de uma árvore sem o runner de
      // teste e reprovaria por MÓDULO NÃO RESOLVIDO — que o operador lê como flake, e flake é o disfarce
      // perfeito para um gate que parou de medir.
      //
      // Ela vive AQUI, e não dentro do laço, por uma razão medida: expressa como GateFailure, a recusa
      // aparecia nas duas rodadas (mergeada e base), a atribuição a creditava à base — "não é culpa do
      // branch" — e o gate APROVAVA. Uma recusa é sobre a árvore, não sobre o código; torná-la
      // atribuível é entregá-la à máquina que existe para perdoar falhas pré-existentes.
      const unidadesAusentes: string[] = [];
      for (const unit of scoped.units) {
        if (!(await fs.isDir(path.join(stagingPath, unit.cwd)))) unidadesAusentes.push(unit.cwd);
      }
      if (unidadesAusentes.length > 0) {
        const motivo =
          `gate RECUSADO (não reprovado): ${unidadesAusentes.join(", ")} não existe em ${stagingPath}. ` +
          `A suíte NÃO rodou. Declare as unidades em \`mergeGate.scope.packages\` do settings, ou aponte o ` +
          `gate para a árvore que de fato tem o pacote.`;
        await cleanupGateStaging(exec, fs, repoRoot, runId);
        return { passed: false, log: motivo };
      }
      // ── TYPECHECK — pergunta BINÁRIA por árvore, canal PRÓPRIO, ANTES da suíte ──────────────────────
      // A suíte transpila sem checar tipo (vitest/esbuild), então erro de tipo atravessava o gate em
      // silêncio — foi assim que 2× TS2353 entraram na main; quem os achou foi a extração OSS, que está
      // de saída. As quatro regras abaixo vêm de cicatriz medida, não de estética:
      //   1. CANAL PRÓPRIO — expressar tsc como GateFailure recriaria o defeito do array compartilhado:
      //      a falha aparece nas duas rodadas, a atribuição a credita à base, o gate aprova. Aqui o
      //      veredito é por UNIDADE (vermelha/verde), nunca por chave de falha.
      //   2. ANTES da suíte — segundos decidem o que os ~2min do p90 decidiriam depois.
      //   3. SÓ unidade com `tsconfig.json` — `bunx tsc` num pacote sem contrato de tipo baixaria o
      //      TypeScript do registry no meio do gate. Todo pulo é ANUNCIADO no log: silêncio leria como
      //      "medido", e verde-sem-olhar é a classe que este arquivo inteiro existe para matar.
      //   4. "NÃO RODOU" ≠ "reprovou" — saída sem diagnóstico `error TS…` é INCONCLUSIVO (infra), nunca
      //      atribuível ao submitter (a mesma régua da recusa de unidade ausente, logo acima).
      const typecheckNotes: string[] = [];
      const notasAteAqui = () => (typecheckNotes.length > 0 ? `\n${typecheckNotes.join("\n")}` : "");
      // O sentinela de "o verificador de tipo de fato FALOU": um código de diagnóstico `TSnnnn:`. Strip
      // de ANSI antes (um `command` com --pretty intercala cor no meio do diagnóstico) e âncora no
      // CÓDIGO com dois-pontos, não na palavra "error" (que o tsc traduz sob `--locale`).
      const temDiagnosticoTs = (out: string) => /\bTS\d{3,}:/.test(out.replace(/\u001b\[[0-9;]*m/g, ""));
      if (typecheck?.enabled) {
        const tsUnits: GateUnit[] = [];
        for (const unit of scoped.units) {
          if (await fs.isFile(path.join(stagingPath, unit.cwd, "tsconfig.json"))) tsUnits.push(unit);
          else typecheckNotes.push(`typecheck: ${unit.label} PULADO (sem tsconfig.json)`);
        }
        const runTypecheck = async (units: GateUnit[]): Promise<Map<string, { ok: boolean; out: string }>> => {
          const byUnit = new Map<string, { ok: boolean; out: string }>();
          for (const unit of units) {
            try {
              await exec(typecheck.command, gateExecOptions(path.join(stagingPath, unit.cwd), timeoutMs));
              byUnit.set(unit.cwd, { ok: true, out: "" });
            } catch (err) {
              const e = err as { stdout?: unknown; stderr?: unknown };
              byUnit.set(unit.cwd, { ok: false, out: `${String(e?.stdout ?? "")}\n${String(e?.stderr ?? "")}`.trim() });
            }
          }
          return byUnit;
        };
        if (tsUnits.length > 0) {
          const mergedTs = await runTypecheck(tsUnits);
          const vermelhas = tsUnits.filter((u) => !mergedTs.get(u.cwd)!.ok);
          if (vermelhas.length === 0) {
            typecheckNotes.push(`typecheck: verde em ${tsUnits.length} unidade(s)`);
          } else {
            // Regra 4: vermelho SEM diagnóstico de tipo = o verificador não rodou (binário ausente,
            // OOM, tsconfig quebrado). Inconclusivo e fail-closed — nunca "seus tipos quebraram".
            const semDiagnostico = vermelhas.filter((u) => !temDiagnosticoTs(mergedTs.get(u.cwd)!.out));
            if (semDiagnostico.length > 0) {
              return {
                passed: false,
                inconclusive: true,
                log:
                  `typecheck INCONCLUSIVO (o verificador não produziu diagnóstico de tipo) em ` +
                  `${semDiagnostico.map((u) => u.label).join(", ")}:\n` +
                  semDiagnostico.map((u) => mergedTs.get(u.cwd)!.out).join("\n").slice(0, GATE_LOG_CAP) +
                  notasAteAqui(),
              };
            }
            // Atribuição BINÁRIA por unidade: a MESMA unidade, na BASE. Pré-existente é perdoado e
            // nomeado; só unidade que ficou vermelha COM o delta reprova. Deliberadamente mais grosso
            // que diff por erro: uma unidade já-vermelha absorve erro novo até a main ser consertada —
            // o preço de nunca reconstruir o array compartilhado. PERDOAR exige DUAS provas na base
            // (a revisão adversarial achou os dois furos): (i) a unidade TINHA tsconfig.json na base —
            // um delta que o ESTREIA faria o tsc da base medir outro projeto (ou emitir TS18003, que
            // casa o sentinela) e virar perdão; (ii) a base ficou vermelha COM diagnóstico `TSnnnn:` —
            // "não rodou" na base jamais perdoa (é a régua 4, aplicada às DUAS rodadas; a suíte faz o
            // mesmo: base crash sem JSON ⇒ bloqueio conservador).
            const mergedShaTs = (await exec(`git rev-parse HEAD`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS })).stdout.trim();
            let baseTs: Map<string, { ok: boolean; out: string }> | null = null;
            let baseTemTsconfig: Map<string, boolean> | null = null;
            let restauroFalhou = false;
            try {
              await exec(`git reset --hard ${quote(baseSha)}`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS });
              baseTemTsconfig = new Map();
              for (const u of vermelhas) {
                baseTemTsconfig.set(u.cwd, await fs.isFile(path.join(stagingPath, u.cwd, "tsconfig.json")));
              }
              baseTs = await runTypecheck(vermelhas.filter((u) => baseTemTsconfig!.get(u.cwd)));
            } catch {
              /* a base não pôde ser medida → conservador: toda vermelha conta como nova */
            } finally {
              // FAIL-CLOSED: sem a árvore MESCLADA restaurada nada abaixo pode medir — a suíte rodaria
              // na base, que não contém o delta, e um verde ali seria mentira integral.
              try {
                await exec(`git reset --hard ${quote(mergedShaTs)}`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS });
              } catch {
                restauroFalhou = true;
              }
            }
            if (restauroFalhou) {
              return {
                passed: false,
                inconclusive: true,
                log:
                  "typecheck: a árvore mesclada não pôde ser RESTAURADA após a rodada de atribuição — nada abaixo mediria o delta" +
                  notasAteAqui(),
              };
            }
            const novas: Array<{ unit: GateUnit; porQue: string }> = [];
            for (const u of vermelhas) {
              if (!baseTs || !baseTemTsconfig) {
                novas.push({ unit: u, porQue: "a base não pôde ser medida — bloqueio conservador" });
              } else if (!baseTemTsconfig.get(u.cwd)) {
                novas.push({ unit: u, porQue: "o tsconfig.json ESTREIA neste delta — não existe base para perdoar" });
              } else if (baseTs.get(u.cwd)!.ok) {
                novas.push({ unit: u, porQue: "a base está verde — o delta os introduziu" });
              } else if (!temDiagnosticoTs(baseTs.get(u.cwd)!.out)) {
                novas.push({ unit: u, porQue: "a base ficou vermelha SEM diagnóstico de tipo (não foi medida) — bloqueio conservador" });
              }
              /* base vermelha COM diagnóstico ⇒ pré-existente, perdoada e anotada abaixo */
            }
            if (novas.length > 0) {
              return {
                passed: false,
                log:
                  `typecheck: erro(s) de tipo NOVO(s) em ${novas.map((n) => n.unit.label).join(", ")}:\n` +
                  novas
                    .map((n) => `[${n.unit.label}] ${n.porQue}\n${mergedTs.get(n.unit.cwd)!.out}`)
                    .join("\n")
                    .slice(0, GATE_LOG_CAP) +
                  notasAteAqui(),
              };
            }
            // DÉBITO DECLARADO (revisão adversarial): este perdão hoje vira SÓ nota de log em entradas
            // que passam — diferente da suíte, cujo perdão alimenta `preexisting`/main-red e gera
            // contrapressão. Promover "base de tipo vermelha" a artefato estruturado é a evolução
            // nomeada; até lá, a janela de acúmulo fica visível apenas para quem lê o log.
            typecheckNotes.push(
              `typecheck: ${vermelhas.length} unidade(s) já vermelha(s) na BASE (não atribuída(s) a este card — a main precisa de conserto à parte)`,
            );
          }
        }
      }
      const tcNote = notasAteAqui();
      /** Roda TODAS as unidades e agrega. `useAffected` só vale na rodada do delta — a de ATRIBUIÇÃO é
       *  sempre completa, senão a base seria medida com uma régua mais frouxa que a do veredito. */
      const runUnits = async (useAffected: boolean): Promise<{ ok: boolean; failures: GateFailure[]; raw: string }> => {
        const failures: GateFailure[] = [];
        let ok = true;
        let raw = "";
        for (const unit of scoped.units) {
          const command =
            useAffected && affected?.enabled
              ? resolveAffectedGate(unit.command, baseSha, changedInTree, affected).command
              : unit.command;
          const unitDir = path.join(stagingPath, unit.cwd);
          const r = await runGateCheck(exec, unitDir, command, timeoutMs);
          if (!r.ok) ok = false;
          failures.push(...r.failures);
          if (r.raw) raw = raw ? `${raw}\n[${unit.label}] ${r.raw}` : `[${unit.label}] ${r.raw}`;
        }
        return { ok, failures, raw };
      };
      const merged = await runUnits(true);
      if (merged.ok) {
        // P-8b — o caminho VERDE também é uma medição da main, e por anos ele não reportava nada. Como a
        // atribuição só roda quando a mesclada FALHA, um episódio vermelho entrava e nunca mais saía: o
        // estado só some com uma medição verde, e ela nunca chegava. `preexisting: []` É essa medição.
        // `undefined` sob seleção por afetados — ver `corridaVerdeLimpaMainRed`.
        const limpa = corridaVerdeLimpaMainRed({ ok: true, affectedOnly: affected?.enabled === true });
        return { passed: true, preexisting: limpa ? [] : undefined, log: `✓ suíte verde (${scoped.reason})${tcNote}` };
      }
      // Non-zero WITHOUT parseable failures = crash / OOM / setup error / the process being KILLED
      // mid-run (a `systemctl restart storymap` during the gate does exactly this) — the reporter never
      // wrote JSON, so nothing is attributable. Still block (never risk passing a broken suite), but say
      // WHAT happened: this is INCONCLUSIVE, not "your tests failed". Reporting it as a plain gate
      // failure hands the submitter a stderr tail of unrelated test-fixture noise and tells them to fix
      // code that is fine — the same infra-dressed-as-product confusion the capability contract exists to
      // end, one layer up.
      if (merged.failures.length === 0) return { passed: false, inconclusive: true, log: (merged.raw || "gate falhou (sem saída parseável)") + tcNote };
      // WS1.3 — remember the MERGED (main+branch) sha so the flaky retry can restore it after the base run
      // resets the staging tree to baseSha for attribution.
      const mergedSha = (await exec(`git rev-parse HEAD`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS })).stdout.trim();
      // ATTRIBUTION: re-run the suite on the BASE (pre-merge main HEAD) to learn which failures already
      // existed — the card is blocked ONLY by the failures its diff INTRODUCED (new = merged \ base).
      let baseKeys: Set<string> | null = null;
      let preexisting: GateFailure[] = [];
      try {
        await exec(`git reset --hard ${quote(baseSha)}`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS });
        const base = await runUnits(false); // atribuição SEMPRE completa — ver runUnits
        // base.ok → no pre-existing failures (empty set). A base crash (!ok, no JSON) → can't attribute.
        if (base.ok) baseKeys = new Set();
        else if (base.failures.length > 0) {
          preexisting = base.failures;
          baseKeys = new Set(base.failures.map(gateFailureKey));
        }
      } catch {
        /* couldn't run the base → fall through to blocking on all branch failures (conservative) */
      }
      if (!baseKeys) return { passed: false, log: formatGateFailures(merged.failures, 0) + tcNote };
      // P-8 — a QUARENTENA entra AQUI, no único lugar onde ela custa três linhas: o gate já subtrai um
      // conjunto de chaves conhecidas antes de decidir, então quarentenar é somar chaves a esse conjunto.
      // O teste em quarentena CONTINUA rodando e continua no relatório — só deixa de ser atribuído ao
      // submitter. É a definição do SOTA ("remove do conjunto obrigatório, não da suíte"), sem flag de
      // vitest, sem tocar na suíte e sem nunca esconder um resultado.
      const attributionKeys = quarantined?.size ? new Set([...baseKeys, ...quarantined]) : baseKeys;
      // WS1.3 — flaky quarantine: a NEW failure may be inter-worker pollution, not this card's fault. Decide
      // pass/park via attributeWithRetry, which re-runs the WHOLE merged suite ONCE when a new failure appears.
      const decision = await attributeWithRetry({
        mergedFailures: merged.failures,
        baseKeys: attributionKeys,
        retryEnabled: retryOnNewFailure,
        rerun: async () => {
          // Restore the merged state (the base run left the tree at baseSha). A FAILED reset must NOT let the
          // retry run against the BASE tree (where the new failure doesn't exist) and false-pass as flaky — so
          // signal the crashed sentinel {ok:false, failures:[]}, which attributeWithRetry PARKS on (fail-closed).
          try {
            await exec(`git reset --hard ${quote(mergedSha)}`, { cwd: stagingPath, timeout: GATE_GIT_TIMEOUT_MS });
          } catch {
            return { ok: false, failures: [] as GateFailure[] };
          }
          const r = await runUnits(true);
          return { ok: r.ok, failures: r.failures };
        },
      });
      const quarantineNote = quarantined?.size ? ` · ${quarantined.size} em quarentena (rodam, não atribuem)` : "";
      if (decision.verdict === "park") {
        return { passed: false, preexisting, log: formatGateFailures(decision.newFailures, baseKeys.size) + quarantineNote + tcNote };
      }
      if (decision.flaky?.length) {
        return {
          passed: true,
          flaky: decision.flaky,
          preexisting,
          log: `⚠ ${decision.flaky.length} falha(s) NOVA(s) não reproduziu(ram) no retry da suíte completa (flaky) — integrado; ver flaky.json${quarantineNote}${tcNote}`,
        };
      }
      // Every failure pre-exists on main → this card's diff introduced NONE → it is NOT to blame. It merges;
      // the red main is a SEPARATE, system-level problem the operator must fix on its own. P-8: `preexisting`
      // é o PRODUTOR que faltava — antes esta frase era o fim da linha e ninguém ficava dono do problema.
      return {
        passed: true,
        preexisting,
        log: `✓ nenhuma falha NOVA — ${baseKeys.size} falha(s) pré-existente(s) na main (NÃO atribuída(s) a este card; a main precisa de conserto à parte)${quarantineNote}${tcNote}`,
      };
    } finally {
      // Cleanup ALWAYS, BEFORE any operation on main — the staging tree never leaks into the merge-back.
      await cleanupGateStaging(exec, fs, repoRoot, runId);
    }
  };
}

// ── attribution-aware gate helpers (structured reporter + new-vs-base diff) ──────────────────────
/** One test vitest reported as failed: file, full name, and the first line of its assertion message. */
export interface GateFailure {
  file: string;
  name: string;
  message: string;
}

/** Identity of a failing test across the merged-run and the base-run (same staging tree → same paths). */
function gateFailureKey(f: GateFailure): string {
  return `${f.file}::${f.name}`;
}

/**
 * WS1.3 — attribution + flaky-quarantine DECISION (pure over the injected `rerun`). `newFailures` = merged \
 * base. Empty ⇒ pass (only pre-existing main reds — a red main NEVER reproves the card). Non-empty + retry
 * disabled ⇒ park. Non-empty + retry enabled ⇒ re-run the WHOLE merged suite ONCE (re-running only the failed
 * FILES would mask inter-worker pollution — the exact class already lived): if the new failures DON'T
 * reproduce (retry green, or its own new-set empty) ⇒ pass + they are FLAKY (recorded); else park with the
 * still-reproducing set. Attribution is never weakened — the base(main) keys are always excluded on BOTH runs.
 */
export async function attributeWithRetry(opts: {
  mergedFailures: GateFailure[];
  baseKeys: ReadonlySet<string>;
  retryEnabled: boolean;
  rerun: () => Promise<{ ok: boolean; failures: GateFailure[] }>;
}): Promise<{ verdict: "pass" | "park"; newFailures: GateFailure[]; flaky?: GateFailure[] }> {
  const newFailures = opts.mergedFailures.filter((f) => !opts.baseKeys.has(gateFailureKey(f)));
  if (newFailures.length === 0) return { verdict: "pass", newFailures };
  if (!opts.retryEnabled) return { verdict: "park", newFailures };
  const retry = await opts.rerun();
  // FAIL-CLOSED: a CRASHED/OOM/timed-out retry (non-zero exit with NO parseable failures) — OR a rerun that
  // couldn't restore the merged tree (signalled the same way) — can NEVER clear the new failure. Park with the
  // original set; only a GREEN retry (or one whose new-set is empty) is flaky. Treating an unparseable retry as
  // flaky-green would integrate genuinely-broken code.
  if (!retry.ok && retry.failures.length === 0) return { verdict: "park", newFailures };
  const retryNew = retry.ok ? [] : retry.failures.filter((f) => !opts.baseKeys.has(gateFailureKey(f)));
  if (retryNew.length === 0) return { verdict: "pass", newFailures, flaky: newFailures };
  return { verdict: "park", newFailures: retryNew };
}

/**
 * Parse vitest `--reporter=json` stdout into the FAILED tests. TOLERANT: returns `[]` when there is no
 * parseable JSON (a crash/OOM before the reporter wrote) so the caller blocks safely instead of passing.
 * Exported for unit tests. PURE.
 */
export function parseVitestFailures(stdout: string): GateFailure[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    const m = stdout.match(/\{[\s\S]*\}/); // vitest may print a stray line around the JSON object
    if (!m) return [];
    try {
      json = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const results = (json as { testResults?: unknown })?.testResults;
  if (!Array.isArray(results)) return [];
  const out: GateFailure[] = [];
  for (const tr of results) {
    const file = String((tr as { name?: unknown })?.name ?? "");
    const ars = (tr as { assertionResults?: unknown })?.assertionResults;
    if (!Array.isArray(ars)) continue;
    for (const a of ars) {
      const ar = a as { status?: unknown; fullName?: unknown; title?: unknown; failureMessages?: unknown };
      if (ar?.status !== "failed") continue;
      const msgs = Array.isArray(ar.failureMessages) ? ar.failureMessages : [];
      out.push({
        file,
        name: String(ar.fullName || ar.title || "?"),
        message: String(msgs[0] ?? "").split("\n")[0],
      });
    }
  }
  return out;
}

/**
 * Run the gate's check with the JSON reporter; capture failures EVEN on a non-zero exit (vitest writes
 * the JSON to stdout, which the rejected exec error still carries). `ok` is the exit-0 verdict — a crash
 * with no parseable failures stays `ok:false, failures:[]` so the caller blocks (never wrongly passes).
 *
 * The JSON report carries EVERY test (2.7k+ here), so it outgrows `child_process.exec`'s 1 MiB default
 * `maxBuffer` as the suite grows — and an overflow REJECTS the exec with a TRUNCATED stdout even when the
 * suite is green (exit 0). That lands in the catch with an unparseable report → zero attributable failures
 * → the caller blocks every code-touching card, permanently, with a gateLog showing only the tests' stderr.
 * The report is bounded by suite size (~1 MB per 2.7k tests), so the ceiling is sized for room to grow.
 */
const GATE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Opções de exec do GATE — cwd, timeout, maxBuffer E o env SANEADO. Sem `env` o filho herda o
 * `process.env` do SERVIÇO (promisify(child_process.exec) repassa o do pai): sob systemd isso é
 * `NODE_ENV=production`, e o vitest do alvo passa a rodar em modo produção — «act(...) is not supported
 * in production builds of React» em TODO teste de React, verde num shell manual. Medido em 2026-09-01
 * num alvo real: 55/55 verde com `env -u NODE_ENV`, 55/55 vermelho sem — e o painel dizia «main
 * VERMELHA: 12 pré-existentes, ninguém está consertando» de um vermelho que não existia. O saneador
 * dos AGENTES (`spawn-env.ts`) é o mesmo que serve aqui: tira NODE_ENV, `__NEXT_*` e toda credencial
 * MCP — a suíte do alvo não tem por que ver o token do serviço. Exportada para o teste de PRODUTOR
 * medir o env que CHEGA ao exec, não a intenção.
 */
export function gateExecOptions(cwd: string, timeoutMs: number, source: NodeJS.ProcessEnv = process.env) {
  return { cwd, timeout: timeoutMs, maxBuffer: GATE_MAX_BUFFER_BYTES, env: sanitizeSpawnEnv(source) };
}

async function runGateCheck(
  exec: ExecFn,
  cwd: string,
  checkCommand: string,
  timeoutMs: number,
): Promise<{ ok: boolean; failures: GateFailure[]; raw: string }> {
  const opts = gateExecOptions(cwd, timeoutMs);
  try {
    const { stdout } = await exec(`${checkCommand} --reporter=json`, opts);
    return { ok: true, failures: parseVitestFailures(stdout), raw: "" };
  } catch (err) {
    const out = String((err as { stdout?: unknown })?.stdout ?? "");
    return { ok: false, failures: parseVitestFailures(out), raw: execErrorDetail(err, GATE_LOG_CAP) };
  }
}

/** ACTIONABLE gate log: the tests THIS card's diff broke (with the pre-existing count noted as ignored). */
function formatGateFailures(newFailures: GateFailure[], preexistingCount: number): string {
  const head =
    `${newFailures.length} teste(s) quebrado(s) por este card` +
    (preexistingCount ? ` (+${preexistingCount} pré-existente(s) na main, NÃO atribuída(s))` : "") +
    ":";
  const lines = newFailures.slice(0, 8).map((f) => {
    const base = f.file.split(/[\\/]/).pop() || f.file;
    return `✗ ${base} › ${f.name}${f.message ? `\n   ${f.message}` : ""}`;
  });
  const more = newFailures.length > 8 ? `\n… +${newFailures.length - 8} outro(s)` : "";
  return `${head}\n${lines.join("\n")}${more}`;
}

/** True quando o erro é o Node MATANDO o filho porque o stdout passou de `maxBuffer`
 *  (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) — volume, não exit code. É o que distingue "card gigante" de
 *  "card ausente nesse lado", os dois desfechos que chegam aqui como uma exceção do exec. */
function isMaxBufferError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/**
 * Parse the card at `<ref>:<relPath>` (via `git show`) into a Card, or null if absent/unparseable
 * (a delete/rename on that side, or malformed frontmatter → caller falls back to the line patch).
 *
 * TETO DE BYTES AQUI É DIFERENTE DE TODOS OS OUTROS SÍTIOS (story-t9k1jf). Em `repo.ts` e
 * `runner/engine.ts` a fonte é um ARQUIVO: há `stat`, então `assertStatWithinByteCap` recusa ANTES do
 * read e o volume hostil nunca entra no processo. Aqui a fonte é o STDOUT de um `git show` — não existe
 * arquivo para statar, e no instante em que a variável `stdout` existe os bytes JÁ estão na memória.
 * Medir a string depois seria teatro: `parseFrontmatter` já faz exatamente isso, e o dano já ocorreu.
 *
 * O único ponto onde o volume ainda pode ser barrado é o SPAWN: com `maxBuffer`, o Node mata o `git` e
 * rejeita ao passar do teto, então o blob nunca é acumulado inteiro. É o que este `maxBuffer` faz, e ele
 * é amarrado ao MESMO teto (e ao mesmo knob de env) do chokepoint para não nascer um segundo limite que
 * envelhece sozinho. Sem ele o teto era o default de 1 MiB do `child_process.exec` — um número
 * ACIDENTAL, que qualquer `maxBuffer` maior a jusante apaga em silêncio (o gate deste mesmo arquivo já
 * passa 64 MiB).
 *
 * HONESTIDADE SOBRE O ALCANCE: o teto é DECLARADO aqui, mas quem o cumpre é o `exec` injetado. Um
 * wrapper que sobrescreva `maxBuffer` (é o que `git-test-env.ts` faz de propósito, para os testes de
 * git real não tropeçarem num `git diff` grande) desliga o controle para aquele chamador. O `exec` de
 * produção (`promisify(child_process.exec)`) honra o valor passado.
 *
 * EXPORTADO para o teste poder provar este teto SOZINHO: por dentro do `makeMergeQueue` ele só é
 * alcançável montando um split com card divergente em três refs, e um controle testado apenas através
 * de outra camada é um controle que ninguém sabe se ainda funciona.
 */
export async function readCardAtRef(
  exec: ExecFn,
  repoRoot: string,
  ref: string,
  relPath: string,
): Promise<Card | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec(`git show ${quote(`${ref}:${relPath}`)}`, {
      cwd: repoRoot,
      timeout: MERGE_TIMEOUT_MS,
      maxBuffer: frontmatterLimits().maxBytes,
    }));
  } catch (err) {
    // Ausente/renomeado nesse lado é ROTINA (era `res.ok === false` → null, silencioso) e continua muda.
    // Volume acima do teto NÃO é rotina: o `git` foi MORTO, e isso é conteúdo hostil tentando entrar pelo
    // train — aparece nomeado, como qualquer outra recusa do chokepoint.
    if (isMaxBufferError(err)) {
      // O log NOMEIA o ref e o teto, e NÃO ecoa `execErrorDetail(err)`: quando o Node mata o filho por
      // volume, o erro carrega o stdout TRUNCADO — ou seja, os primeiros bytes do card, que é justamente
      // onde vive o frontmatter (`findings[].detail` incluído, o campo que existe porque conteúdo de card
      // já carregou credencial). Um aviso de VOLUME não precisa de nenhum byte do conteúdo para ser
      // acionável, e este aviso vai para o journal do serviço. Mesma doutrina de `maskSecret`/`redact`.
      console.warn(
        `[harness-merge-queue] card acima do teto de bytes em ${ref}:${relPath} ` +
          `(teto ${frontmatterLimits().maxBytes} bytes; o git foi morto pelo volume)`,
      );
    }
    return null;
  }
  try {
    const parsed = parseFrontmatter(stdout, `${ref}:${relPath}`);
    return coerceCard(path.basename(relPath, ".md"), parsed.data as Record<string, unknown>, parsed.content.trim());
  } catch (err) {
    // Recusa ⇒ null ⇒ o merge cai no patch de linhas (comportamento antigo), MAS registrado: um card
    // hostil (`---js`, alias bomb) entrando pelo train é exatamente o vetor que o gate não protegia —
    // ele o LIA para decidir o 3-way. Nada é executado e o operador vê o motivo.
    console.warn(`[harness-merge-queue] card recusado em ${ref}:${relPath}:`, describeFrontmatterError(err));
    return null;
  }
}

/** Build a {@link MergeQueuePort} over injectable exec + store. `getMergeQueue` wires the real ones. */
export function makeMergeQueue(cfg: MergeQueueConfig): MergeQueuePort {
  const now = cfg.now ?? (() => Date.now());
  const commitSerializer = cfg.commitSerializer ?? serialCommit;
  const persistDiffSnapshot = cfg.persistDiffSnapshot ?? defaultPersistDiffSnapshot;
  const addGateBlocker = cfg.addGateBlocker ?? defaultAddGateBlocker;
  const addSecretScanBlocker = cfg.addSecretScanBlocker ?? defaultAddSecretScanBlocker;
  const clearRunBlockers = cfg.clearRunBlockers ?? defaultClearRunBlockers;
  const persistConflictedBranchFinding =
    cfg.persistConflictedBranchFinding ?? defaultPersistConflictedBranchFinding;
  const stampStaged = cfg.stampStaged ?? defaultStampStaged;
  const addCodeNotLandedBlocker = cfg.addCodeNotLandedBlocker ?? defaultAddCodeNotLandedBlocker;
  const addDataNotLandedBlocker = cfg.addDataNotLandedBlocker ?? defaultAddDataNotLandedBlocker;
  // fs surface for best-effort gate-staging cleanup (deprovision links). Real node:fs in production;
  // over a fake `exec` in tests the paths don't exist, so unlinkDir is a safe no-op.
  const gateFs = defaultWorktreeFs;
  // story-zdeajs (AC4): the fs surface + timeout the golden-snapshot regen uses. Injectable so the
  // snap-regen step (link node_modules → `vitest -u` → drop links) is unit-testable without disk.
  const snapFs = cfg.snapFs ?? defaultWorktreeFs;
  const snapRegenTimeoutMs = cfg.snapRegenTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  // story-zdeajs (LOW #4): the dirty-tree clean-gate's bounded re-check knobs + injectable sleep.
  const cleanTreeAttempts = Math.max(1, cfg.cleanTreeRecheck?.attempts ?? DEFAULT_CLEAN_TREE_RECHECK.attempts);
  const cleanTreeDelayMs = cfg.cleanTreeRecheck?.delayMs ?? DEFAULT_CLEAN_TREE_RECHECK.delayMs;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let entries: MergeQueueEntry[] = [];
  let processing = false;
  // story-92ldyt: the engine callback fired on a re-driven conflict (null = no engine wired → degrade
  // to the legacy pause). Registered via setRedriveHandler at engine construction.
  let redriveHandler: RedriveHandler | null = null;
  const listeners = new Set<(snap: MergeQueueSnapshot) => void>();
  const mergeListeners = new Set<(ev: { board: string; cardId: string; trigger?: TriggerId }) => void>();
  const settleListeners = new Set<
    (ev: { runId: string; status: MergeQueueEntry["status"]; detail?: string }) => void
  >();

  // Memoized load PROMISE so every caller awaits the SAME resolution (never a partial map).
  let loadOnce: Promise<void> | undefined;
  // Serialize persists so a concurrent enqueue/resolve never interleaves a half-written file.
  let writeChain: Promise<void> = Promise.resolve();
  // The current processing loop (if any), exposed via whenIdle() so tests can await settle.
  let current: Promise<void> = Promise.resolve();

  const snapshot = (): MergeQueueSnapshot => ({ entries: entries.map((e) => ({ ...e })), processing });

  // audit #12: carry the just-finished `trigger` so the cascade re-eval can suppress re-firing the
  // SAME column's skill (the loop guard). A non-advancing board-data run that merges back minutes
  // later (past AUTORUN_DEDUPE_MS) would otherwise re-run the same skill → re-fail → loop.
  // WS-1.3/D2: `cardId` is nullable here because a card-less session entry has NO card to cascade on —
  // the cascade's whole job is "re-evaluate the card's column after the merge-back". No card ⇒ nothing to
  // re-evaluate ⇒ the event is simply not emitted (and NEVER a card invented to hang it on — D13).
  const emitMergeDone = (board: string, cardId: string | undefined, trigger?: TriggerId): void => {
    if (!cardId) return;
    for (const fn of mergeListeners) {
      try {
        fn({ board, cardId, trigger });
      } catch (err) {
        // LOG-and-KEEP (mirrors engine.emitComplete). A throwing listener must NOT be permanently
        // dropped: the cascade-after-merge subscribes onMergeDone exactly ONCE per process
        // (trigger-runner-channel), so deleting it here would silently kill autorun-on-merge for the
        // rest of the process. The disposer returned by onMergeDone is the only unsubscribe path.
        console.error("[harness-merge-queue] onMergeDone listener threw", err instanceof Error ? err.message : err);
      }
    }
  };

  /** 6.1 — append a compensating `merge:<outcome>` hop to the durable ledger when a merge-back reaches a
   * terminal verdict (approved/reproved/parked). MergeQueueEntry carries no card-status snapshot, so the
   * from/to are read best-effort from the card on disk (from=to=current — the NOTE is the payload); a read
   * failure just skips the advisory hop. Fire-and-forget + fully fail-open: it must NEVER perturb the FIFO. */
  const recordMergeOutcome = async (
    entry: MergeQueueEntry,
    outcome: "approved" | "reproved" | "parked",
  ): Promise<void> => {
    const cardId = entry.cardId;
    if (!cardId) return; // WS-1.3/D2: card-less session entry — no card to record a hop against
    try {
      const status = (await readCards(entry.board)).find((c) => c.id === cardId)?.status ?? null;
      if (!status) return; // no attributable card status — skip (the hop is advisory display data)
      void appendTransition({
        board: entry.board,
        cardId,
        from: status,
        to: status,
        actor: "merge",
        runId: entry.runId,
        note: `merge:${outcome}`,
      });
    } catch (err) {
      console.error("[harness-merge-queue] recordMergeOutcome falhou (não-fatal):", err instanceof Error ? err.message : err);
    }
  };

  /**
   * WS-10.5 — TELEMETRY per verdict, on the SAME durable ledger the merge outcomes already use (a second
   * store for this would be a second truth). This is the number that validates the whole bet: how many
   * conflicts the human DIDN'T have to see (`resolved-*`) versus the ones that genuinely needed them
   * (`escalated-substantive`), plus the health signal (`judge-failed`) — and it is what calibrates the
   * SKILL.md's cosmetic×substantive examples with REAL data instead of the author's intuition.
   * Fire-and-forget + fail-open, exactly like recordMergeOutcome: telemetry must NEVER perturb the FIFO.
   */
  const recordResolutionOutcome = async (entry: MergeQueueEntry, outcome: ResolutionOutcome): Promise<void> => {
    // `disabled` is not an event — it is the absence of the feature. Recording it would drown the real
    // verdicts in noise on every board that turned the ladder off.
    if (outcome === "disabled") return;
    const cardId = entry.cardId;
    if (!cardId) return; // card-less session entry — no card to record a hop against (WS-1.3/D2)
    try {
      const status = (await readCards(entry.board)).find((c) => c.id === cardId)?.status ?? null;
      if (!status) return;
      void appendTransition({
        board: entry.board,
        cardId,
        from: status,
        to: status,
        actor: "merge",
        runId: entry.runId,
        note: `resolve:${outcome}`,
      });
    } catch (err) {
      console.error("[harness-merge-queue] recordResolutionOutcome falhou (não-fatal):", err instanceof Error ? err.message : err);
    }
  };

  /** audit #6: on a SUCCESSFUL integration, clear this run's own gate/secret-scan blockers so a
   * retry-then-pass doesn't strand the card before QA with a stale `open` blocker. Best-effort +
   * non-fatal (mirrors pushToOrigin); call BEFORE emitMergeDone so the cascade re-eval sees it cleared. */
  const resolveRunBlockers = async (entry: MergeQueueEntry): Promise<void> => {
    const cardId = entry.cardId;
    if (!cardId) return; // WS-1.3/D2: card-less session entry — it never wrote card blockers to clear
    try {
      await clearRunBlockers(entry.board, cardId, entry.runId);
    } catch (err) {
      console.error("[harness-merge-queue] clearRunBlockers falhou (não-fatal):", err instanceof Error ? err.message : err);
    }
  };

  /** autonomy-reliability WS-1.2: when a SPLIT entry PARKED (conflict/failed) with its code NOT staged —
   * the CODE half (now FIRST, WS-1.1) failed, so the DATA half never ran and the card did NOT advance —
   * stamp a `blocker` finding naming the preserved branch, so the failure is VISIBLE in Inbox (lane
   * travado) instead of a silent "done"-without-code. The predicate `split && !codeStaged && parked`
   * cleanly separates this from: data-only runs (codeStaged set immediately → excluded); code-staged-but-
   * data-failed (codeStaged true → excluded, code is safe on `stage`); and gate-failed (no `split` → its
   * own gate blocker). Covers BOTH fresh failures (called at the split chokepoint) AND legacy entries
   * (called from recover's sweep — the pre-WS-1 `dataLanded && !codeStaged` inverted-order signature).
   * Best-effort + non-fatal + idempotent (upsert by runId; a later successful integration auto-clears via
   * withRunBlockersResolved). */
  const stampCodeNotLandedIfNeeded = async (entry: MergeQueueEntry): Promise<void> => {
    const cardId = entry.cardId;
    // WS-1.3/D2: a card-less session entry has no card to blocker. Its equivalent signal is the
    // `returned-to-session` outcome handed straight back to the live session (WS-1.4) — which is a
    // STRONGER guarantee than a finding: the session that wrote the code learns immediately.
    if (!cardId) return;
    // Terminal guard (fix: stale "Bloqueio" on shipped cards): NEVER stamp a code-not-landed blocker onto a
    // card already in a TERMINAL status. The recovery sweep re-processes STALE parked run branches long after
    // the card shipped by another path — a blocker stamped there would strand `open` forever (a terminal card
    // never re-integrates, so withRunBlockersResolved can't auto-clear it — the very drift this fixes). Mirrors
    // the prune's own terminal check (cfg.isCardTerminal). The runLoop caller is already non-terminal by
    // construction, so this is a harmless no-op there. Fail-OPEN (default false) if the resolver is absent/throws.
    if (cfg.isCardTerminal && (await cfg.isCardTerminal(entry.board, cardId).catch(() => false))) return;
    if (!entry.split || entry.split.codeStaged) return; // code landed (or no split) → not this defect
    if (entry.status !== "conflict" && entry.status !== "failed") return; // only a PARKED entry
    try {
      await addCodeNotLandedBlocker(
        entry.board,
        cardId,
        entry.runId,
        entry.branch,
        entry.conflictDetail ?? entry.failureReason,
      );
    } catch (err) {
      console.error("[harness-merge-queue] addCodeNotLandedBlocker falhou (não-fatal):", err instanceof Error ? err.message : err);
    }
  };

  /**
   * WS-1.3/G2 — THE ONE DOOR through which the train deletes a branch. Every `git branch -D` in this file
   * goes through here; grep for `branch -D` and you should find exactly this line.
   *
   * WHY A CHOKEPOINT AND NOT N GUARDS: the train had TEN independent deletion sites (split success, merge
   * success, already-ancestor, redrive rename-fallback, aborted data-only, operator-resolved ×2, recover
   * ×2, gate staging). A session branch reaching ANY of them is a live worktree's checked-out branch, and:
   *   (a) git REFUSES to delete a branch checked out in another worktree — so the naive fix ("it'll just
   *       fail") is really an unhandled rejection that kills the serial processor mid-drain, freezing the
   *       whole train. This is the real hazard: not the delete, the THROW.
   *   (b) even if git allowed it, the session is still USING that branch — it keeps committing onto it and
   *       will `worktree_refresh` + re-submit. Deleting it would destroy live work.
   * So: a `kind: session` entry's branch is NEVER deleted here. It is disposed by exactly one thing —
   * `worktree_discard`, the fail-closed teardown (WS-1.1) — because the SESSION owns its branch's lifetime,
   * not the train. Returns whether the branch actually went, so callers can stay honest in the journal.
   */
  const deleteBranchAfterIntegration = async (
    entry: Pick<MergeQueueEntry, "kind" | "branch" | "runId">,
    branch: string = entry.branch,
  ): Promise<boolean> => {
    if (entry.kind === "session") {
      console.warn(
        `[harness-merge-queue] ${branch}: branch de SESSÃO VIVA — o train NÃO deleta (a sessão ${entry.runId.slice(0, 8)} ainda o usa; ` +
          `a deleção acontece só no worktree_discard). Integração seguiu normalmente.`,
      );
      return false;
    }
    return (await git(`branch -D ${quote(branch)}`)).ok;
  };

  /** PRESERVE (never -D) a superseded entry's branch as `failed/<branch>` so its diff stays inspectable
   * (merge-train rootcause Front 5). Best-effort: if the rename fails (a `failed/...` from a prior
   * teardown already holds the name, or git errors), the branch is LEFT as-is — still preserved, never
   * deleted. Mutates `entry.branch` to the new name on success so later ops point at the right ref.
   * WS-1: a RENAME is as dangerous as a delete for a live session (git moves the worktree's HEAD with it,
   * pulling the branch out from under the agent mid-edit), so a session entry is left strictly alone. */
  const preserveSupersededBranch = async (entry: MergeQueueEntry): Promise<void> => {
    if (entry.kind === "session") return; // live session owns its branch — never rename under it
    if (entry.branch.startsWith("failed/")) return; // already preserved
    const preserved = `failed/${entry.branch}`;
    const renamed = await git(`branch -m ${quote(entry.branch)} ${quote(preserved)}`);
    if (renamed.ok) entry.branch = preserved;
  };

  /** WS-2.1: PRESERVE (never `-D`) an ABORTED entry's branch when it carries CODE (`packages/**`) — rename
   * `run/<id>` → `conflicted/run/<id>` (the maybeRedrive idiom) so the ONLY copy of un-integrated code
   * survives the operator's abort. The incident's final abort DESTROYED `run/54de4fa8` — the 3rd
   * re-implementation of the qb8z2c fix — because abort did a blind `git branch -D`. FAIL-SAFE: a branch is
   * deleted ONLY when we CONFIDENTLY determined it is data-only (the diff succeeded, returned files, and NONE
   * touch code — data either landed or is re-generable). ANY uncertainty (diff failed, empty diff, base
   * unknown) → PRESERVE (never risk destroying code). On a name collision (a prior redrive already parked a
   * `conflicted/...`) suffix `-aborted`; a rename that fails twice LEAVES the branch as-is (still preserved,
   * never `-D`). Mutates `entry.branch` to the new name on rename. */
  const preserveAbortedBranch = async (entry: MergeQueueEntry): Promise<void> => {
    if (entry.kind === "session") return; // WS-1: live session owns its branch — never rename/delete under it
    if (entry.branch.startsWith("conflicted/") || entry.branch.startsWith("failed/")) return; // already preserved
    const base = entry.baseCommit || (await git(`merge-base HEAD ${quote(entry.branch)}`)).stdout.trim();
    const changed = base ? await git(`diff --name-only ${quote(base)}..${quote(entry.branch)}`) : null;
    const files = changed?.ok ? changed.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    const codePrefixes = cfg.staging?.codePrefixes ?? STAGING_CODE_PREFIXES;
    // DELETE only when confidently data-only; otherwise PRESERVE (fail-safe — never destroy code).
    const isDataOnly = !!changed?.ok && files.length > 0 && !pathsTouchCode(files, codePrefixes);
    if (isDataOnly) {
      await deleteBranchAfterIntegration(entry); // no un-integrated code to lose → keep the ledger clean
      return;
    }
    let target = `conflicted/${entry.branch}`;
    let renamed = await git(`branch -m ${quote(entry.branch)} ${quote(target)}`);
    if (!renamed.ok) {
      target = `${target}-aborted`;
      renamed = await git(`branch -m ${quote(entry.branch)} ${quote(target)}`);
    }
    if (renamed.ok) entry.branch = target;
  };

  /** #37 auto-push reconcile: when a push is REJECTED because origin/<branch> advanced (another
   * checkout — the notebook, or a manual push — landed commits this checkout lacks → non-fast-forward),
   * bring those commits in so the follow-up push fast-forwards. This keeps origin == this checkout,
   * eliminating the divergence class that opened the clobber (a rejected push used to just strand
   * origin behind, forcing manual reconciliation). fetch + MERGE FETCH_HEAD: board data (main) and
   * code (stage) touch DISJOINT paths across checkouts, so the merge auto-resolves clean in the common
   * case. MERGE (not rebase) is deliberate — it never rewrites local commit SHAs, so the diff snapshots
   * persisted just before the push stay valid. On any conflict or error, ABORT to leave the tree
   * pristine and return false; the caller then keeps the original non-fatal record-and-continue (a later
   * push is cumulative and recovers). Runs ONLY on the rejected path → zero overhead on the happy push.
   *
   * story-281gg4 — FRONTEIRA DE CONTRIBUIÇÃO. Este merge era um caminho pelo qual código que este
   * checkout não produziu chegava à produção sem passar pelo train, pelo gate nem por decisão alguma —
   * num repositório público, o caminho de um PR de terceiro. Vale para os DOIS branches que passam por
   * aqui, e o segundo é o pior: com `staging.branch` reconcilia o `stage`, de onde `promoteStageToMain`
   * promove; com `main` (o merge-back, {@link pushToOrigin}) reconcilia DIRETO o branch que o self-deploy
   * builda e reinicia como ROOT — sem promote nenhum no meio, e uma vez por merge em vez de uma por
   * publicação. O reconcile foi feito para o DADO de outro checkout do DONO (path-disjunto do código: é
   * por isso que o merge resolve limpo), então proveniência externa que NÃO seja board-data provado só é
   * absorvida sob a fronteira declarada `owner` — e nunca calada. Recusar devolve `false`, que é
   * exatamente o que o chamador já trata como não-fatal (push cumulativo).
   */
  const reconcileWithOrigin = async (cwd: string, branch: string): Promise<boolean> => {
    const fetched = await gitAt(cwd, `fetch origin ${quote(branch)}`);
    if (!fetched.ok) return false;
    // `A...B` no git diff é diff(merge-base(A,B), B) → SÓ o que vem de fora, sem o nosso lado. O `.ok`
    // VIAJA (mesma régua de `verificationDemand`): um diff ilegível não pode virar lista vazia e, com
    // ela, um "origin não trouxe nada" — era o único caminho em que a incerteza LIBERAVA.
    const incomingDiff = await gitAt(cwd, `diff --name-only --no-renames HEAD...FETCH_HEAD`);
    const incoming = incomingDiff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const verdict = judgeIncoming(incoming, cfg.staging?.codePrefixes ?? STAGING_CODE_PREFIXES, {
      readable: incomingDiff.ok,
    });
    if (verdict.detail) console.warn(`[harness-merge-queue] origin/${branch} ${verdict.detail}`);
    if (!verdict.absorb) return false;
    const merged = await gitAt(cwd, `merge --no-edit FETCH_HEAD`);
    if (merged.ok) return true;
    await gitAt(cwd, `merge --abort`); // conflict/error → restore the pre-merge tip; operator reconciles
    return false;
  };

  /** Push HEAD to origin after a merge-back (story-igl9tl). Non-fatal: a failure logs + records on
   * the entry but does NOT block the queue or change the `done` status — `git push` is cumulative,
   * so the next successful push recovers all accumulated commits. #37 auto-push: on a non-fast-forward
   * rejection, RECONCILE with the advanced origin (fetch + merge, disjoint paths) and retry ONCE, so
   * origin stays == this checkout instead of silently drifting behind.
   *
   * story-281gg4 — o reconcile daqui é o de `main`, e é o que a primeira passada da fronteira DEIXOU DE
   * FORA: os dois outros (`stage` no train, `main` no release) foram cobertos, e este — o que roda uma vez
   * por MERGE, e o único que absorve direto no branch que o self-deploy builda e reinicia como root, sem
   * promote no meio — seguia fundindo `FETCH_HEAD` sem perguntar de onde veio. Por isso ele NÃO delega mais
   * ao `pushHeadToOrigin` (git.ts, que reconcilia sem régua e continua servindo o settle de board-data do
   * engine em worktree.ts): a mecânica é a mesma — push cumulativo, fetch+merge só na recusa, um único
   * retry, `merge --abort` em conflito — passando por {@link reconcileWithOrigin}, que aplica a fronteira.
   * Sob o default (`owner`) o comportamento é byte-idêntico ao de antes. */
  const pushToOrigin = async (entry: MergeQueueEntry): Promise<void> => {
    let pushed = await git(`push origin HEAD`);
    if (!pushed.ok) {
      const branch = (await git(`rev-parse --abbrev-ref HEAD`)).stdout.trim() || "main";
      if (await reconcileWithOrigin(cfg.repoRoot, branch)) pushed = await git(`push origin HEAD`);
    }
    if (pushed.ok) {
      entry.pushError = undefined; // clear any prior recorded failure on this later success
      return;
    }
    const detail = (pushed.stderr || `exit ${pushed.code}`).slice(0, 200);
    console.error("[harness-merge-queue] push para origin falhou (não-fatal):", detail);
    entry.pushError = detail;
  };

  const notify = (): void => {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        // LOG-and-KEEP (mirrors engine.emitComplete): a throwing snapshot subscriber stays subscribed
        // so a single bad render doesn't permanently sever SSE updates for the process.
        console.error("[harness-merge-queue] snapshot listener threw", err instanceof Error ? err.message : err);
      }
    }
  };

  const ensureLoaded = (): Promise<void> =>
    (loadOnce ??= cfg.store
      .load()
      .catch(() => [] as MergeQueueEntry[])
      .then((rows) => {
        entries = rows;
      }));

  /** Re-derive the capped set (live entries always kept) and flush it; chained so writes never interleave. */
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      const live = entries.filter(isLive);
      const terminal = entries
        .filter((e) => !isLive(e))
        .sort((a, b) => (b.mergeEndedAt ?? b.enqueuedAt) - (a.mergeEndedAt ?? a.enqueuedAt))
        .slice(0, MAX_TERMINAL_RETAINED);
      const keep = new Set<MergeQueueEntry>([...live, ...terminal]);
      // Preserve insertion (FIFO) order; just drop the capped-out terminal entries.
      entries = entries.filter((e) => keep.has(e));
      await cfg.store.persist(entries.map((e) => ({ ...e }))).catch((err) => {
        console.error("[harness-merge-queue] persist failed:", err instanceof Error ? err.message : err);
      });
    });
    return writeChain;
  };

  // git in the main tree (cwd = repoRoot) or — pass a 2nd arg via `gitAt` — an ARBITRARY working tree
  // (the Fase 4a split operates on the stage worktree too). Shared factory (B6): the spawn +
  // error-capture body lives once in git.ts; `gitAt(cwd, args)` is the cwd-first shorthand.
  const git = makeGit(cfg.exec, { cwd: cfg.repoRoot, timeoutMs: MERGE_TIMEOUT_MS });
  const gitAt = (cwd: string, args: string): Promise<GitResult> => git(args, cwd);

  /**
   * Defect A (stale-base): the base sha that isolates a run's OWN work. When staging is on, a run is cut
   * from `stage`; the sha PERSISTED as `entry.baseCommit` at spawn can DRIFT past the worktree's real cut
   * point when `stage` advances between the base capture and the worktree creation (the prior run's
   * two-step stage write — merge-main THEN commit-code — racing the next run's spawn). Trusting that stale
   * sha makes `base..branch` absorb commits that are NOT this run's work (e.g. the previous card's staged
   * code), so a board-data-only run (harness-review/qa) gets MISCLASSIFIED as code-touching and wrongly pushed
   * through the code gate — the freeze story-olr777 hit. Recompute the TRUE fork point at integration time
   * with `git merge-base(stage, branch)`: always the exact commit the branch was cut from, robust to any
   * drift, and it correctly excludes the unreleased code the run inherited from `stage` (that lives on
   * stage's side of the fork, not the branch's). Returns null when staging is off or git can't resolve it
   * → the caller falls back to the persisted `baseCommit`/HEAD (unchanged legacy behavior). Warns when the
   * persisted base disagrees so future drift is observable.
   */
  /**
   * WS-1.2/G5 — the REVISION this entry integrates: the sha `worktree_submit` PINNED, or the branch name.
   *
   * A run's branch is frozen at settle (the process is gone), so tip == pinned and this is a no-op for it.
   * A SESSION is alive: it keeps committing while its entry waits in the queue and while the gate runs. If
   * the train read the branch NAME at merge time it would integrate whatever the tip happens to be at THAT
   * instant — i.e. commits the gate never saw. So everything that READS the work (gate, diff ranges, split,
   * is-ancestor) resolves through here; only ref OPERATIONS (rename/delete) use the branch name, because a
   * sha isn't a ref. Pinning is what makes "the gate validated exactly what got merged" true under a live
   * submitter.
   */
  const integrationRev = (entry: MergeQueueEntry): string => entry.pinnedSha || entry.branch;

  /**
   * Resolve the entry's integration rev to an IMMUTABLE commit sha, REPAIRING a renamed ref when needed.
   * A teardown/GC can rename `run/<id>` → `failed/run/<id>` (or `conflicted/…`) while the entry WAITS its
   * turn — and a `git diff` over the vanished name used to read as an EMPTY change set, landing both split
   * halves "empty" and finalizing the entry `done` with ZERO integrated content (the 94bfdb77 false-done:
   * card advanced, landings stamped `empty:true`, code stranded on the preserved branch). Probing the
   * preserved names RECOVERS the work instead of failing it; pinning the sha up front makes every later
   * diff/apply immune to renames. Returns null only when NO candidate resolves to a commit.
   */
  const resolveIntegrationRef = async (
    entry: MergeQueueEntry,
  ): Promise<{ sha: string; ref: string } | null> => {
    // REFS apenas — nunca o pinnedSha (ele é âncora de CONTEÚDO; aqui a pergunta é "qual NOME de ref
    // ainda existe para as ops de rename/delete e para o diff de uma entry legada sem pin").
    const candidates = [
      entry.branch,
      `failed/${entry.branch}`,
      `conflicted/${entry.branch}`,
      `failed/run/${entry.runId}`,
      `conflicted/run/${entry.runId}`,
    ];
    const seen = new Set<string>();
    for (const ref of candidates) {
      if (!ref || seen.has(ref)) continue;
      seen.add(ref);
      const r = await git(`rev-parse --verify --quiet ${quote(ref)}^{commit}`);
      // `sha` pode vir VAZIO com exit 0 sob execs degenerados (os doubles de teste respondem ok a tudo).
      // Nesse caso o ref é utilizável mas não-pinável — devolve o NOME e deixa o pin para quem tiver um
      // sha real. Git de verdade nunca responde ok+vazio a `--verify`.
      if (r.ok) return { sha: r.stdout.trim(), ref };
    }
    return null;
  };

  const forkPointBase = async (entry: MergeQueueEntry): Promise<string | null> => {
    const stageBranch = cfg.staging?.enabled ? cfg.staging.branch : null;
    if (!stageBranch) return null;
    const mb = await git(`merge-base ${quote(stageBranch)} ${quote(integrationRev(entry))}`);
    const sha = mb.ok ? mb.stdout.trim() : "";
    if (!sha) return null;
    if (entry.baseCommit && entry.baseCommit !== sha) {
      console.warn(
        `[harness-merge-queue] ${entry.branch}: baseCommit ${entry.baseCommit.slice(0, 8)} ≠ fork-point ${sha.slice(0, 8)} — usando o fork-point (drift de base stale, Defect A)`,
      );
    }
    return sha;
  };

  // === Fase 4a — staged release (split integration) ==========================================
  // Helpers below ONLY run when `cfg.staging?.enabled` AND the run touches code — every other run
  // (the ~93% board-data-only case, and ALL runs when staging is off) takes the unchanged merge path.

  /** Apply a patch file to `cwd` IDEMPOTENTLY (crash-safe re-process):
   *   - `--check` clean   → apply with `--index` → "applied"
   *   - already applied   → `--reverse --check` clean → "already" (skip; a prior run/crash landed it)
   *   - `threeway` + overlap → `--3way` auto-merges; leftover conflict markers → "conflict"
   *   - `unionFallback`    → tries `--3way` after a failed `--check`; files marked `merge=union` in
   *                          `.gitattributes` (e.g. board.yaml) resolve concurrent appends cleanly;
   *                          resets cwd and returns "conflict" on any remaining markers or error.
   *   - otherwise          → "error" (cannot apply; the tree is left untouched by `--check`).
   * The board-DATA apply (main) uses `threeway:false, unionFallback:true` — the union driver handles
   * canonical list files (board.yaml) without markers while still signalling "conflict" for non-list
   * overlaps so maybeRedrive can re-drive or park. The CODE apply (stage) uses `threeway:true` so
   * overlapping edits vs prior unreleased staged code merge where possible. */
  const applyPatch = async (
    cwd: string,
    patchFile: string,
    opts: {
      threeway: boolean;
      unionFallback?: boolean;
      /**
       * P-1 — chamado no INSTANTE do conflito, com o stderr do apply, e SEMPRE antes de qualquer
       * restauração da árvore. A ordem é a coisa toda: o `restoreDataPaths` logo abaixo (e o
       * `reset --hard` do chamador) apagam os marcadores no mesmo instante em que eles passam a ser a
       * única evidência do que divergiu. Um hook em vez de um valor de retorno porque só aqui dentro
       * existe a janela entre "o git falhou" e "a árvore foi limpa".
       */
      onConflict?: (stderr: string) => Promise<void>;
    },
  ): Promise<"applied" | "already" | "conflict" | "error"> => {
    if ((await gitAt(cwd, `apply --check ${quote(patchFile)}`)).ok) {
      const r = await gitAt(cwd, `apply --index ${quote(patchFile)}`);
      if (r.ok) return "applied";
      await opts.onConflict?.(r.stderr || r.stdout || "");
      return "error";
    }
    if ((await gitAt(cwd, `apply --reverse --check ${quote(patchFile)}`)).ok) return "already";
    if (opts.threeway) {
      const r = await gitAt(cwd, `apply --index --3way ${quote(patchFile)}`);
      if (r.ok) return "applied";
      await opts.onConflict?.(r.stderr || r.stdout || ""); // markers still on disk — capture NOW
      return "conflict"; // non-zero ⇒ markers left for the operator on `stage`
    }
    if (opts.unionFallback) {
      // Files marked merge=union in .gitattributes (board.yaml) let git resolve concurrent appends
      // via concatenation without conflict markers. Try 3-way only after the direct apply failed
      // so the cheap path still runs first. Non-zero ⇒ genuine non-list conflict → reset to keep
      // cwd pristine and signal "conflict" so the caller can re-drive or park.
      const r = await gitAt(cwd, `apply --index --3way ${quote(patchFile)}`);
      if (r.ok) return "applied";
      await opts.onConflict?.(r.stderr || r.stdout || ""); // BEFORE the restore below wipes the evidence
      // WS1.2 — path-scoped restore, NOT `git reset --hard HEAD` (which nuked the ENTIRE live checkout incl.
      // uncommitted code). The board-data patch only touches boards/, so restoring that subtree leaves cwd
      // pristine for the re-drive while preserving any out-of-boards work.
      const restored = await restoreDataPaths(git, cwd);
      if (!restored.ok) console.warn(`[harness-merge-queue] applyPatch restore: ${restored.detail}`);
      return "conflict";
    }
    return "error";
  };

  /** A board card file (`storymap/boards/<board>/cards/<id>.md`) — the frontmatter-bearing files the
   * merge-back 3-way (story-r4o4wo) merges STRUCTURALLY instead of via the line-based patch. */
  const CARD_MD_RE = /^storymap\/boards\/[^/]+\/cards\/[^/]+\.md$/;

  /** {@link readCardAtRef} amarrado a ESTE train (exec + repoRoot injetados). O corpo vive no módulo para
   *  o teto de bytes do `git show` ser testável sozinho — ver o doc dele. */
  const cardAtRef = (ref: string, relPath: string): Promise<Card | null> =>
    readCardAtRef(cfg.exec, cfg.repoRoot, ref, relPath);

  /** SM-08 fail-closed: scan the LAST commit (`HEAD~1..HEAD`) in `cwd` for secrets. Returns a discriminated
   * failure (`internalError` distinguishes a scanner exit-1/invocation failure from an exit-2 secret) or null
   * when clean. BOTH are fail-closed — the flag only tailors the operator-facing message, MIRRORING the
   * whole-branch merge path (~L1968-1972). We deliberately do NOT fail-OPEN on a scanner error (the sealed
   * SM-08 posture); the HARDENING 1.2 change is purely the non-destructive undo at the call site. Mirrors the
   * merge path's pre-push rescan so the split's main + stage commits get the SAME gate. */
  const scanLastCommitForSecrets = async (
    cwd: string,
  ): Promise<{ internalError: boolean; detail: string } | null> => {
    try {
      await cfg.exec(secretScanCommand(cwd, { range: "HEAD~1..HEAD" }), { cwd, timeout: MERGE_TIMEOUT_MS });
      return null;
    } catch (err) {
      const e = err as { code?: unknown };
      const code = typeof e?.code === "number" ? e.code : null;
      // exit 2 = secret found; anything else (1 = scanner internal error, or an invocation failure) is ALSO
      // fail-closed — we only distinguish for the message/finding, never to let the commit through.
      return { internalError: code !== 2, detail: execErrorDetail(err) || `exit ${e?.code}` };
    }
  };

  /** Ensure the persistent stage worktree exists (idempotent). Creates `<repo>-stage` on the `stage`
   * branch from the current main HEAD the first time (or attaches the existing branch). Throws on a hard
   * `git worktree add` failure so the caller pauses rather than silently skipping the code route. */
  const ensureStageWorktree = async (stagePath: string, branch: string): Promise<void> => {
    const list = await git(`worktree list --porcelain`);
    if (list.ok && list.stdout.includes(stagePath)) return; // already attached
    const hasBranch = await git(`rev-parse --verify --quiet ${quote(branch)}`);
    const add = hasBranch.ok
      ? await git(`worktree add ${quote(stagePath)} ${quote(branch)}`)
      : await git(`worktree add ${quote(stagePath)} -b ${quote(branch)}`); // branches from main HEAD
    if (!add.ok) throw new Error(add.stderr || `worktree add falhou (${add.code})`);
  };

  /**
   * ROOT-CAUSE FIX (stale-stage, card-agnostic). The `stage` branch/worktree is created from the released
   * branch ONCE ({@link ensureStageWorktree}) and never advanced — so it DRIFTS behind `main` as main
   * moves (released code, infra, board commits). Applying a run's code patch (a diff vs the CURRENT
   * released tip) onto a stale stage spuriously conflicts, and a stale stage is exactly what risked the
   * release clobber the release guard now blocks (incident 2026-06). This restores the system invariant
   * the split model assumes: **`stage` == released branch + UNRELEASED code, never behind it.** Called
   * before every code application so the apply context always matches the released tip. Returns:
   *   - "ok": stage is now current (fast-forwarded when it carried no unreleased code — it was an ancestor
   *     of the released branch; or 3-way merged the released branch's advances in, preserving unreleased
   *     code on top).
   *   - "conflict": unreleased staged code GENUINELY overlaps the released branch's newer code → the merge
   *     is aborted (stage left clean) and the caller pauses the entry (fail-safe — NEVER clobbers either side).
   * Idempotent + crash-safe: a re-run simply re-syncs.
   */
  const syncStageWithReleased = async (
    stagePath: string,
    releasedBranch: string,
    stageBranch: string,
  ): Promise<"ok" | "conflict"> => {
    const stageIsAncestor = await gitAt(
      stagePath,
      `merge-base --is-ancestor ${quote(stageBranch)} ${quote(releasedBranch)}`,
    );
    if (stageIsAncestor.ok) {
      // stage ⊆ released → no unreleased code on top; fast-forward to the released tip (no work to lose).
      await gitAt(stagePath, `reset --hard ${quote(releasedBranch)}`);
      return "ok";
    }
    // stage carries unreleased code → bring the released branch's advances in (3-way), preserving it.
    const merged = await gitAt(stagePath, `merge --no-edit ${quote(releasedBranch)}`);
    if (merged.ok) return "ok";
    await gitAt(stagePath, `merge --abort`); // leave stage clean; genuine overlap → caller pauses
    return "conflict";
  };

  /**
   * Recuperação DETERMINÍSTICA do sync stage↔released quando a divergência é a TENTATIVA ANTERIOR do
   * PRÓPRIO card sendo reintegrado — o ciclo de redrive: a implementação antiga parada em `stage` colide
   * com a released que avançou na mesma região (story-tlz0dt: 0706f6260 reescreveu o comparador na main
   * enquanto a 1ª implementação vivia em stage; 2 redrives morreram no muro "stage não sincroniza").
   *
   * Política ESTREITA e card-agnóstica — propriedade lida dos commits, nunca de nomes de produto:
   * um arquivo é EVICTÁVEL quando TODO commit stage-only que o tocou desde o merge-base carrega o cardId
   * da entry no subject (os commits do train/skills sempre carregam: `usm(<card>)` / `· <board>/<card>`).
   * A tentativa antiga desse card é superada POR DEFINIÇÃO — a entry atual É a reimplementação dela — então
   * o lado released vence nesses arquivos e as adições órfãs (arquivos que a released não tem) são removidas,
   * abrindo caminho para o código NOVO da entry aplicar limpo em seguida. Qualquer arquivo em conflito FORA
   * dessa propriedade ⇒ "not-applicable" (fail-closed: o chamador parqueia com receita acionável; nunca chuta
   * trabalho alheio). O gate da entry já validou o código novo; release/deploy seguem donos da verdade final.
   * NUNCA deixa meio-merge: todo caminho de saída aborta ou commita.
   */
  const evictSupersededAndSync = async (
    stagePath: string,
    releasedBranch: string,
    stageBranch: string,
    entry: MergeQueueEntry,
  ): Promise<"synced" | "not-applicable"> => {
    const cardId = entry.cardId;
    if (!cardId || entry.kind === "session") return "not-applicable"; // sessão viva resolve o próprio conflito (D3)
    const mb = await gitAt(stagePath, `merge-base ${quote(stageBranch)} ${quote(releasedBranch)}`);
    const mergeBase = mb.ok ? mb.stdout.trim() : "";
    if (!mergeBase) return "not-applicable";
    // O universo onde a tentativa antiga pode viver: o que o LADO STAGE mudou desde o fork.
    const changed = await gitAt(stagePath, `diff --name-only ${quote(mergeBase)}..${quote(stageBranch)}`);
    if (!changed.ok) return "not-applicable";
    const stageSide = changed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (stageSide.length === 0) return "not-applicable";
    // Match por TOKEN, não substring — `story-abc` não pode reivindicar um commit de `story-abc2` (ids
    // compartilham prefixo). Fronteira = qualquer char fora do alfabeto de id ([a-z0-9-]) ou borda.
    const cardToken = new RegExp(`(^|[^A-Za-z0-9-])${cardId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9-]|$)`);
    const evictable: string[] = [];
    for (const f of stageSide) {
      const log = await gitAt(stagePath, `log --format=%s ${quote(mergeBase)}..${quote(stageBranch)} -- ${quote(f)}`);
      if (!log.ok) return "not-applicable";
      const subjects = log.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      // Sem commit direto (mudou só via merge) ou com QUALQUER commit que não nomeie o card ⇒ não é nosso
      // para evictar — se esse arquivo conflitar adiante, o caso todo é not-applicable (checado abaixo).
      if (subjects.length === 0 || !subjects.every((s) => cardToken.test(s))) continue;
      evictable.push(f);
    }
    if (evictable.length === 0) return "not-applicable";
    const evictSet = new Set(evictable);
    // Merge released→stage: conflitos são esperados EXATAMENTE nos arquivos da tentativa antiga.
    await gitAt(stagePath, `merge --no-commit --no-ff ${quote(releasedBranch)}`);
    const unmerged = await gitAt(stagePath, `diff --name-only --diff-filter=U`);
    const unmergedPaths = unmerged.ok ? unmerged.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    if (!unmergedPaths.every((p) => evictSet.has(p))) {
      await gitAt(stagePath, `merge --abort`); // conflito com dono misto/alheio → fail-closed
      return "not-applicable";
    }
    for (const f of evictable) {
      const inReleased = await gitAt(stagePath, `cat-file -e ${quote(`${releasedBranch}:${f}`)}`);
      if (inReleased.ok) {
        await gitAt(stagePath, `checkout ${quote(releasedBranch)} -- ${quote(f)}`); // released vence
      } else {
        await gitAt(stagePath, `rm -f -q --ignore-unmatch -- ${quote(f)}`); // adição órfã da tentativa antiga
      }
    }
    // Mensagem CONSTANTE + identificadores internos (sem texto livre → sem risco de injeção no -m).
    const committed = await gitAt(
      stagePath,
      `commit --no-verify -m ${quote(`train: sync stage com ${releasedBranch} (evicção da tentativa superada de ${entry.board}/${cardId} — entry ${entry.runId})`)}`,
    );
    if (!committed.ok) {
      await gitAt(stagePath, `merge --abort`);
      await gitAt(stagePath, `reset --hard HEAD`);
      return "not-applicable";
    }
    return "synced";
  };

  /**
   * story-zdeajs (AC1/AC4): REGENERATE the golden snapshots (`*.snap`) in `cwd` from the now-merged
   * source — the SINGLE implementation shared by BOTH the split path (stage worktree) and the staging-OFF
   * pure-merge path (main tree). Snapshots are DERIVED + `.gitattributes:53` marks them `binary`, so git
   * never textually merges them; the integration layer must rebuild them programmatically via `vitest -u`.
   * Mirrors the old inline split-path block (links the main checkout's node_modules in, runs the update,
   * drops the links in a finally), but DI-testable over the injected `snapFs`/`snapRegenTimeoutMs`.
   *
   * Returns `{ status, detail? }` (it NEVER throws — a thrown vitest is mapped to status "failed"):
   *   - "regenerated": `vitest -u` ran and produced a STAGED diff on at least one snap (a real change).
   *   - "noop":        `vitest -u` ran but the snaps were already canonical (idempotent — nothing to commit).
   *   - "failed":      the `vitest -u` invocation itself threw (the caller undoes its merge + re-drives).
   *                    story-zdeajs (LOW #3): the thrown error's detail is CAPTURED in `detail` so the
   *                    caller can surface the REASON (the bare `catch {}` swallowed it, leaving the
   *                    split redrive message reasonless — useless for operator triage).
   * Leaves the regenerated snaps `git add`ed (staged) in `cwd` so the caller can `commit`/`amend` them.
   */
  const regenerateSnapshots = async (
    cwd: string,
    snapFiles: string[],
  ): Promise<{ status: "regenerated" | "noop" | "failed"; detail?: string }> => {
    const pkgDir = path.join(cwd, "packages", "storymap-ui");
    try {
      await provisionNodeModules(snapFs, cfg.repoRoot, cwd);
      await cfg.exec(`bunx vitest run -u`, { cwd: pkgDir, timeout: snapRegenTimeoutMs });
    } catch (err) {
      // The vitest run itself failed (a genuine red test the regen can't paper over) → signal the
      // caller to undo + re-drive, CARRYING the error detail for triage. Links dropped first.
      await deprovisionNodeModules(snapFs, cfg.repoRoot, cwd).catch(() => {});
      return { status: "failed", detail: execErrorDetail(err, 160) };
    }
    await deprovisionNodeModules(snapFs, cfg.repoRoot, cwd).catch(() => {});
    // Stage each regenerated snap; vitest is idempotent when nothing changed → `git add` is a no-op then.
    for (const sf of snapFiles) {
      await gitAt(cwd, `add -- ${quote(sf)}`);
    }
    // A non-empty staged diff means vitest actually rewrote a snap → there is something to commit.
    return { status: (await gitAt(cwd, `diff --cached --quiet`)).ok ? "noop" : "regenerated" };
  };

  /**
   * Recompute ONE artifact declared in `staging.dataDerived`, in the LIVE checkout, from the board data
   * that just landed on main. Deliberately NOT {@link regenerateSnapshots}: that one runs the WHOLE
   * suite with `-u` in a throwaway worktree it must first provision; this runs the single declared
   * command in the running checkout, which already has its `node_modules`. The command comes from the
   * spec, so this stays agnostic about what the artifact IS or which tool rebuilds it.
   *
   * Never throws — a failure is returned so the caller can abort the data half with main pristine
   * rather than commit a source whose artifact is stale (which reds main and freezes the fail-closed gate).
   */
  const runDataDerivedRegen = async (
    d: { artifact: string; cwd: string; regen: string },
  ): Promise<{ ok: true; skipped?: string } | { ok: false; detail: string }> => {
    // O `cwd` declarado pode ter DEIXADO DE EXISTIR no alvo — medido em 2026-09-01: `staging` é lido
    // UMA vez na construção (boot-fixed), o alvo apagou o pacote declarado (Etapa C da inversão) 28 min
    // depois de o serviço subir, e a entrada seguinte com board-data morreu em `spawn /bin/sh ENOENT`
    // (cwd inexistente), abortando a metade de dados inteira por um artefato que já não existia. Um
    // artefato cujo diretório sumiu não tem o que regenerar: PULA anunciando, em vez de abortar.
    const cwd = path.join(cfg.repoRoot, d.cwd);
    if (!existsSync(cwd)) {
      return { ok: true, skipped: `cwd ${d.cwd} não existe no alvo — artefato ${d.artifact} ignorado (config 'staging.dataDerived' obsoleta? o valor é boot-fixed: reinicie o serviço após removê-lo)` };
    }
    try {
      await cfg.exec(d.regen, { cwd, timeout: snapRegenTimeoutMs });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: execErrorDetail(err, 160) || "erro desconhecido" };
    }
  };

  /**
   * story-zdeajs (AC1): the staging-OFF whole-branch merge, made GOLDEN-SNAPSHOT-AWARE. Because `*.snap`
   * is `binary` (.gitattributes:53), a run that regenerated a snap diverging from main makes the plain
   * `git merge --no-ff` ABORT with the snap as an unmerged path — the bug that false-parked CLEAN merges
   * as `conflict` on the storymap board (staging-off). When `snapFiles` is present we do a TWO-PHASE merge:
   *   1. `git merge --no-ff --no-commit <branch>`. On success → no snap conflict, complete with `--no-edit`.
   *   2. On failure, inspect the UNMERGED paths. If they are a SUBSET of `snapFiles`, the ONLY conflict is
   *      the derived snaps → take the run's side (`checkout --theirs`), then REGENERATE from the merged
   *      source ({@link regenerateSnapshots}) so the snap matches the live suite, and `git commit` to
   *      complete the merge. If ANY non-snap path is unmerged → a REAL content conflict → abort + "conflict"
   *      (the existing safe maybeRedrive path). A `vitest -u` failure during regen → "regen-failed" (undo).
   * For the common NO-SNAP case it is a plain `git merge --no-ff --no-edit` (byte-identical to the prior
   * behavior → every existing merge test stays green).
   *
   * Returns `{ outcome, detail }` where outcome is "clean" (merge committed on HEAD), "conflict" (a real
   * content conflict — `detail` carries git's stderr/stdout for the operator), or "regen-failed" (the snap
   * regen vitest threw). The NO-SNAP path does NOT abort on conflict (it leaves the conflicted state so the
   * caller's existing `git merge --abort` + maybeRedrive tail runs byte-identically); the snap paths abort
   * internally so they never leave a half-merge. NEVER leaves a half-merge behind on a snap conflict.
   */
  const mergeWithSnapResolution = async (
    branch: string,
    snapFiles: string[],
  ): Promise<{ outcome: "clean" | "conflict" | "regen-failed"; detail: string }> => {
    if (snapFiles.length === 0) {
      // Common path — byte-identical to the prior bare merge (same command, same NON-aborted conflict
      // state) so every existing merge test stays green; the caller's tail aborts + re-drives on conflict.
      const merge = await git(`merge --no-ff --no-edit ${quote(branch)}`);
      return { outcome: merge.ok ? "clean" : "conflict", detail: merge.stderr || merge.stdout || "" };
    }
    // Snap-bearing branch: phase 1 — merge without committing so we can resolve the binary snaps by hand.
    const merge = await git(`merge --no-ff --no-commit ${quote(branch)}`);
    if (merge.ok) {
      // No conflict at all (the snap happened to match, or git fast-resolved) → just finish the commit.
      const committed = await git(`commit --no-verify --no-edit`);
      if (committed.ok) return { outcome: "clean", detail: "" };
      await git(`merge --abort`);
      return { outcome: "conflict", detail: committed.stderr || committed.stdout || "" };
    }
    // Phase 2 — a conflict. Is it ONLY the derived snaps? `diff --name-only --diff-filter=U` lists the
    // unmerged paths. If every one is a known snap, resolve by regenerating; otherwise it is real.
    const unmerged = await git(`diff --name-only --diff-filter=U`);
    const unmergedPaths = unmerged.ok
      ? unmerged.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
    const snapSet = new Set(snapFiles);
    const onlySnaps = unmergedPaths.length > 0 && unmergedPaths.every((p) => snapSet.has(p));
    if (!onlySnaps) {
      // A non-snap path conflicts → a REAL content conflict → abort + let maybeRedrive own it (safe path).
      await git(`merge --abort`);
      return { outcome: "conflict", detail: merge.stderr || merge.stdout || "" };
    }
    // Only the snaps conflict: take the run's version, then OVERWRITE it with the canonical regenerated
    // output (so the snap matches the merged source, not just blindly the run's side).
    for (const sf of snapFiles) {
      await git(`checkout --theirs -- ${quote(sf)}`);
      await git(`add -- ${quote(sf)}`);
    }
    const regen = await regenerateSnapshots(cfg.repoRoot, snapFiles);
    if (regen.status === "failed") {
      await git(`merge --abort`); // restore the pre-merge tip; nothing half-applied
      return { outcome: "regen-failed", detail: regen.detail ?? "" }; // LOW #3: carry the reason for triage
    }
    const committed = await git(`commit --no-verify --no-edit`);
    if (!committed.ok) {
      await git(`merge --abort`);
      return { outcome: "conflict", detail: committed.stderr || committed.stdout || "" };
    }
    return { outcome: "clean", detail: "" };
  };

  /**
   * WS-1.4/D3/G6 — hand a LIVE SESSION's failed integration back to the session, instead of parking it for
   * the operator or re-driving it headlessly. A session is the best resolver of its own conflict: it has the
   * context, it is alive, and it can `worktree_refresh` (rebase onto the new base) + re-submit in seconds.
   *
   * TERMINAL, exactly like `failed` — this is the whole point of G6. If `returned-to-session` were a live
   * status it would sit at the head of the FIFO waiting on a human-speed agent, blocking every other run's
   * integration: a session would become the new global bottleneck, which is the precise anti-goal of this WS.
   * So the entry closes here; the re-submit arrives as a NEW entry with a NEW pinned sha. The branch is left
   * untouched (the session owns it), nothing parks, and no RedriveHandler is consulted (that path re-runs a
   * SKILL from a trigger — a session has no skill to re-run).
   */
  const returnToSession = async (entry: MergeQueueEntry, conflictDetail: string): Promise<void> => {
    finalize(entry, "returned-to-session", { conflictDetail });
    await persist();
    notify();
  };

  /**
   * D3/G6 — PARQUEAR é um verbo que só existe para RUN. Um `kind: session` NUNCA espera um humano: ele
   * volta para quem escreveu o código, que é o melhor resolvedor possível (tem o contexto, está vivo, e
   * `worktree_refresh` + re-submit custa segundos).
   *
   * ESTE HELPER EXISTE PORQUE A REGRA ESTAVA IMPLEMENTADA EM UM CAMINHO SÓ. `maybeRedrive` e o gate
   * checavam `kind`; os SEIS outros sítios de parque chamavam `finalize(entry, "conflict")` direto. O
   * resultado apareceu em produção: a entrada `b4fcc6e0` (uma SESSÃO) caiu no parque da metade de dados
   * e ficou **43,5 h** esperando um humano — que no fim ABORTOU, deixando o código em `stage` e o
   * board-data fora de `main` para sempre. Uma invariante que vale em um `if` e não nos outros seis não
   * é uma invariante; é uma coincidência com boa documentação.
   *
   * Devolve o que aconteceu para o chamador mapear o fluxo da fila: `returned` é TERMINAL e a fila DRENA
   * (uma sessão jamais segura a cabeça do train — o anti-objetivo do WS); `parked` espera o operador.
   */
  const parkOrReturn = async (
    entry: MergeQueueEntry,
    detail: string,
  ): Promise<"returned" | "parked"> => {
    const enriched = withConflictDetail(entry, detail);
    if (entry.kind === "session") {
      await returnToSession(entry, enriched);
      return "returned";
    }
    finalize(entry, "conflict", { conflictDetail: enriched });
    await persist();
    notify();
    return "parked";
  };

  /** Cola o artefato do conflito (P-1) no texto do desfecho: em vez de "código conflita com stage", os
   *  arquivos e quantas regiões divergiram. Sem artefato, devolve o detalhe original intacto. */
  const withConflictDetail = (entry: MergeQueueEntry, detail: string): string => {
    const described = describeConflictArtifact(entry.conflict);
    return (described ? `${detail} — ${described}` : detail).slice(0, CONFLICT_DETAIL_CAP);
  };

  /** Captura o conflito da árvore `cwd` e o GRAVA na entry, antes de qualquer `reset --hard`. Best-effort
   *  por contrato: a captura roda no caminho de tratamento de erro, e uma exceção aqui trocaria um
   *  conflito (recuperável) por um crash do processador serial (não). */
  const captureConflictInto = async (entry: MergeQueueEntry, cwd: string, applyStderr?: string): Promise<void> => {
    try {
      const artifact = await captureConflictArtifact(
        {
          exec: cfg.exec,
          readFile: (abs) => fsp.readFile(abs, "utf8"),
          join: (base, rel) => path.join(base, rel),
        },
        cwd,
        { applyStderr },
      );
      if (artifact.files.length > 0) entry.conflict = artifact;
    } catch (err) {
      console.warn("[harness-merge-queue] captura do conflito falhou (não-fatal):", err instanceof Error ? err.message : err);
    }
  };

  /**
   * If the run has a `trigger` (auto-driven) and the lineage re-drive cap allows it, re-drives the
   * skill against the updated integration target and returns `"redriven"` (queue keeps draining).
   * Otherwise parks the entry as `conflict` and returns `"parked"`. Both paths finalize+persist+notify.
   * Callers in integrateSplit return `"done"` on `"redriven"` and `"paused"` on `"parked"`. Callers
   * in the non-staging runLoop always continue draining (no head-of-line block on the non-staging path).
   * WS-1.4: a `kind: session` entry never reaches the redrive/park fork — it is returned to its session
   * (terminal), and the caller drains on. Returning `"redriven"` says exactly that to every existing
   * caller: "this entry is finished, keep the queue moving" — no caller-side branching needed.
   */
  /**
   * WS-10.3 — climb the SEMANTIC LADDER for a CODE text conflict, BEFORE the entry parks or re-drives.
   *
   * Called only from the two sites where the conflict IS a text divergence (the stage sync and the code
   * apply). Deliberately NOT from inside {@link maybeRedrive}, which also funnels a failed snapshot regen
   * and the "code didn't land" false-flag — neither is two texts disagreeing, so a judge there would be
   * asked to adjudicate a divergence that does not exist. The ladder answers ONE question; only its own
   * question reaches it.
   *
   * D3: a `kind: session` entry never climbs — a LIVE session resolves its own conflict (it has the
   * context, it is alive, and `worktree_refresh` costs seconds). It is a better-positioned LLM than the
   * judge, so spending a judge on it would be strictly worse AND slower.
   *
   * Returns `"resolved"` when an artifact was materialized and RE-ENQUEUED (a NEW entry — so the GATE runs
   * again over the resolved tree, invariant 1); `"escalated"` otherwise, having ATTACHED the analysis to the
   * entry so the park that follows carries the per-hunk verdicts to Inbox instead of a raw stderr.
   * NEVER throws: the ladder is an ADDITION to the disposition, never a new way for it to break.
   */
  const climbSemanticLadder = async (
    entry: MergeQueueEntry,
    opts: { ours: string; theirs: string; base: string; files: string[]; conflictDetail: string },
  ): Promise<"resolved" | "escalated"> => {
    if (opts.files.length === 0) return "escalated";
    // P-4 — D3 permanece, mas era grosso demais: ele desligava a escada INTEIRA para sessão, e sessão é
    // 96% do tráfego (medido: ZERO acionamentos da escada em 137 h). Os degraus 0 e 1 são GRÁTIS e não
    // decidem nada — o degrau 0 pergunta "isto já aterrissou?" (um conflito fantasma vira um não-evento) e
    // o degrau 1 pergunta "os dois lados são iguais módulo whitespace?". Rodá-los para sessão só ACRESCENTA
    // informação ao que ela recebe de volta. O que D3 protege é o degrau 2, o juiz PAGO: uma sessão viva é
    // um LLM melhor posicionado que ele (tem o contexto, e `worktree_refresh` custa segundos), então gastar
    // um juiz ali seria estritamente pior E mais lento. Por isso a sessão climba SEM `judge`.
    const isSession = entry.kind === "session";
    const enabled = loadRunnerConfig().autorun.mergeTrain?.semanticResolution ?? true;
    const result = await climbLadder(
      {
        exec: cfg.exec,
        repoRoot: cfg.repoRoot,
        judge: isSession ? undefined : cfg.judge,
        enabled,
        // Rung 0's ruler, injected rather than re-implemented (D6: one question, one ruler). The range is
        // the entry's OWN work (baseCommit..pinned/branch) — the same range the split integrates.
        deltaLandedFn: (o) => deltaLanded(cfg.exec, cfg.repoRoot, o),
      },
      {
        sides: { ours: opts.ours, theirs: opts.theirs, files: opts.files },
        base: opts.base,
        origin: "train",
        board: entry.board,
        cardId: entry.cardId,
        conflictDetail: opts.conflictDetail,
        range: { base: opts.base, head: opts.theirs },
        attempts: entry.semanticAttempts ?? 0,
      },
    ).catch((err): ResolutionResult => ({
      outcome: "judge-failed",
      detail: `escada semântica falhou: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`,
      hunks: [],
      files: opts.files,
    }));

    // P-4 — para SESSÃO o degrau 2 não está "indisponível": ele é deliberadamente PULADO (D3). A frase
    // padrão ("sem juiz configurado") mandaria a sessão caçar um defeito de configuração que não existe,
    // em vez de fazer a única coisa que resolve — rebasear e re-submeter.
    if (isSession && result.outcome === "escalated-substantive" && result.hunks.length === 0) {
      result.detail =
        "degraus 0/1 não resolveram a divergência; o degrau 2 (juiz LLM) NÃO roda para sessão viva (D3) — " +
        "o conflito é seu: worktree_refresh e re-submeta";
    }

    void recordResolutionOutcome(entry, result.outcome);

    // The attempt is SPENT the moment the ladder actually judged (invariant 3). `disabled`/`skipped` never
    // spend it: nothing was judged, so a later climb (flag flipped on, a new base) is not a re-judgement of
    // the same text — which is the only thing the counter exists to prevent.
    // P-4: uma SESSÃO também nunca gasta a tentativa — ela climba SEM juiz, então nenhum julgamento foi
    // comprado. O contador responde "quantas vezes um LLM julgou este texto?"; incrementá-lo aqui daria a
    // resposta errada e, pior, gastaria o orçamento de um mecanismo que nem foi acionado.
    if (!isSession && result.outcome !== "disabled" && result.outcome !== "skipped") {
      entry.semanticAttempts = (entry.semanticAttempts ?? 0) + 1;
    }

    if (isResolved(result.outcome)) {
      // Rung 0/1 resolved WITHOUT an artifact (nothing to apply: the delta already landed, or the two sides
      // are the same modulo whitespace) ⇒ this entry's code half has nothing left to do. Fall through to the
      // normal disposition rather than inventing a "success" here: the split's own verify-integration
      // (#38) is the authority on whether the code landed, and a second ruler for that is exactly the
      // duplicated-ruler bug class. The analysis rides the entry either way.
      if (!result.resolvedRef) {
        entry.resolutionAnalysis = { detail: result.detail, outcome: result.outcome, hunks: result.hunks };
        await persist();
        return "escalated";
      }
      // Rung 2 resolved: RE-ENTER through the normal mechanism (invariant 1) — a NEW entry for the resolved
      // ref, so the gate + the split + the secret scan all run again over the judged tree. The judge's word
      // is never the last one; the deterministic gate is.
      const resolvedRunId = `${entry.runId}-resolved`;
      finalize(entry, "re-driving", { conflictDetail: `${opts.conflictDetail}\n[resolvido pelo juiz semântico → ${result.resolvedRef}]`.slice(0, CONFLICT_DETAIL_CAP) });
      await persist();
      notify();
      await enqueueResolved({
        runId: resolvedRunId,
        board: entry.board,
        cardId: entry.cardId,
        branch: result.resolvedRef,
        // The resolved artifact was cut from `ours` (the target's CURRENT tip) and carries the judged delta
        // on top — so THAT is its integration base. Reusing the original entry's baseCommit would re-open
        // the very divergence the judge just closed.
        baseCommit: opts.ours,
        trigger: entry.trigger,
        kind: entry.kind,
        driveCount: entry.driveCount,
        // The counter RIDES the re-entry: if the resolved artifact conflicts AGAIN, the successor must not
        // buy a second judgement. Without this the "1 attempt per entry" cap would reset on every
        // resolution and the loop-guard (acceptance 5) would be decorative.
        semanticAttempts: entry.semanticAttempts,
        resolutionAnalysis: { detail: result.detail, outcome: result.outcome, hunks: result.hunks },
      });
      console.log(`[harness-merge-queue] juiz semântico resolveu ${entry.runId} → ${result.resolvedRef} (re-enfileirado; o gate roda de novo)`);
      return "resolved";
    }

    // Escalation — ATTACH the analysis. This is the WS's deliverable: the parked item stops being a raw
    // stderr and becomes "hunk X: substantive because …" that the operator reads on Inbox.
    entry.resolutionAnalysis = { detail: result.detail, outcome: result.outcome, hunks: result.hunks };
    await persist();
    return "escalated";
  };

  /** Enqueue the judge's resolved artifact as a NEW entry (invariant 1: it re-enters through the normal
   *  mechanism). Inline rather than via the port's `enqueueMerge` to avoid re-entering `ensureLoaded()` from
   *  inside a live integration; the entry shape is identical to any other. */
  const enqueueResolved = async (input: Omit<MergeQueueEntry, "status" | "enqueuedAt">): Promise<void> => {
    entries.push({ ...input, status: "waiting", enqueuedAt: now() });
    await persist();
    notify();
  };

  const maybeRedrive = async (
    entry: MergeQueueEntry,
    conflictDetail: string,
  ): Promise<"redriven" | "parked"> => {
    if (entry.kind === "session") {
      await returnToSession(entry, conflictDetail);
      return "redriven"; // terminal + drain on; NOT parked (never waits for an operator)
    }
    const maxRedrives = loadRunnerConfig().autorun.mergeTrain?.maxRedrives ?? DEFAULT_MAX_REDRIVES;
    // A re-drive RE-RUNS the card's column skill against updated main — so it needs BOTH a trigger (which
    // skill) and a card (which card to run it on). Card-less work has neither a spec to regenerate from nor
    // a card to regenerate onto, so it can never be re-driven; it parks like any un-triggered entry. (In
    // practice a card-less entry is always `kind: session` and returned above — this keeps the invariant
    // true at the type level rather than by coincidence of the caller.)
    const cardId = entry.cardId;
    const trigger = entry.trigger;
    if (cardId && trigger && redriveHandler && (entry.driveCount ?? 0) < maxRedrives) {
      const nextDriveCount = (entry.driveCount ?? 0) + 1;
      // SM-07: PRESERVE the superseded branch instead of force-deleting it — rename run/<id> →
      // conflicted/run/<id> so the diff survives for manual inspection. Fallback to branch -D on name
      // collision (e.g. a prior re-drive already holds the conflicted/... name).
      const conflictedBranch = `conflicted/${entry.branch}`;
      const renamed = await git(`branch -m ${quote(entry.branch)} ${quote(conflictedBranch)}`);
      if (renamed.ok) {
        try {
          await persistConflictedBranchFinding(entry.board, cardId, entry.runId, conflictedBranch, nextDriveCount);
        } catch (err) {
          console.error(
            "[harness-merge-queue] persistConflictedBranchFinding falhou (não-fatal):",
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        await deleteBranchAfterIntegration(entry);
      }
      finalize(entry, "re-driving", { conflictDetail });
      await persist();
      notify();
      // Await only the admission (not run completion): redriveHandler returns once enqueued.
      // If the re-spawn is REJECTED, recover by pointing entry at the preserved branch and
      // re-stamping "conflict" so the operator regains the resolve/abort path.
      const outcome = await redriveHandler({
        board: entry.board,
        cardId,
        trigger,
        driveCount: nextDriveCount,
        conflictDetail,
        // WS-2.2: point the fresh redrive at the preserved code (only when the rename actually took —
        // on the -D fallback there is nothing to reuse).
        preservedBranch: renamed.ok ? conflictedBranch : undefined,
      }).catch(
        (err): RedriveResult => ({
          ok: false,
          reason: "handler-threw",
          detail: String(err instanceof Error ? err.message : err),
        }),
      );
      if (!outcome?.ok) {
        if (renamed.ok) entry.branch = conflictedBranch;
        finalize(entry, "conflict", {
          conflictDetail: `${conflictDetail}\n[re-drive recusado: ${outcome?.reason ?? "desconhecido"}${outcome?.detail ? ` — ${outcome.detail}` : ""}]`.slice(0, CONFLICT_DETAIL_CAP),
        });
        await persist();
        notify();
        return "parked";
      }
      return "redriven"; // admitted → caller can keep draining
    }
    finalize(entry, "conflict", { conflictDetail });
    await persist();
    notify();
    return "parked";
  };

  /**
   * Fase 4a SPLIT integration for a run branch that touches CODE. `packages/**` → the `stage` branch
   * (held for the human release gate); EVERYTHING ELSE (cards/skills/docs) → main so the live board +
   * cascade advance. autonomy-reliability WS-1.1 — ATOMIC ORDER (código antes de dados): the CODE half
   * runs FIRST; the DATA half (the IRREVERSIBLE board commit/status-advance on main) runs ONLY after the
   * code staged clean. Every CODE-half failure RETURNS ("paused"/redrive) before the DATA half, so a board
   * commit is NEVER created for a run whose code didn't land — a split can no longer leave the card reading
   * "done"/advanced without its code on `stage` (the lost-impl class that cost story-qb8z2c ~$13 in 3×
   * re-implementation). The two targets touch DISJOINT paths, so the eventual stage→main release merge is a
   * clean 3-way. Crash-safe via the persisted split markers (`codeStaged`/`dataLanded`) + {@link applyPatch}'s
   * idempotency — a restart resumes the missing half in order. Owns the entry's finalize/persist/notify (like
   * the inline merge path); returns whether the FIFO must pause. INVARIANT: `dataLanded` ⇒ `codeStaged` (or
   * the run carried no code).
   */
  const integrateSplit = async (
    entry: MergeQueueEntry,
    staging: NonNullable<MergeQueueConfig["staging"]>,
  ): Promise<"done" | "paused"> => {
    // WS-1.2/G5: read the work from the PINNED sha (a live session keeps committing past its submit);
    // for a run this IS the branch tip. `entry.branch` stays the ref for delete/rename ops below.
    const branch = integrationRev(entry);
    const dataPatch = path.join(runnerStateDir(), `split-${entry.runId}-data.patch`);
    const codePatch = path.join(runnerStateDir(), `split-${entry.runId}-code.patch`);

    // The INTEGRATION BASE the run was cut from (stale-base fix). Prefer the persisted `baseCommit` (the
    // exact sha of `stage` at spawn) — a FIXED 2-dot range `base..branch` isolates ONLY this run's work,
    // excluding the unreleased code already on `stage` (so the split never re-applies it). A stale base
    // here is harmless: the code apply is idempotent (`apply --reverse --check` skips already-staged code)
    // and the data apply matches (the card at the base == the card on main). The Defect A misclassification
    // is fixed at the gate decision (forkPointBase in runLoop), which is where the stale base actually bit.
    // Fallback to `merge-base HEAD branch` for legacy entries enqueued before this field existed.
    const base = entry.baseCommit || (await git(`merge-base HEAD ${quote(branch)}`)).stdout.trim();
    const branchTip = (await git(`rev-parse ${quote(branch)}`)).stdout.trim();

    // `--no-renames` é OBRIGATÓRIO aqui (a mesma razão do `--binary` logo abaixo): com detecção de
    // rename ligada — o default — o `--name-only` de um `git mv` lista APENAS o caminho NOVO. O caminho
    // ANTIGO some da lista, some do pathspec, e portanto some do patch: o arquivo velho FICA em `stage`
    // (e depois em main) ao lado do novo. Foi assim que, ao renomear Pilotagem→Inbox, a tela antiga
    // sobreviveu importando símbolos que já não existiam — o build passa (a rota morta é inalcançável),
    // então nada grita, e a árvore acumula código fantasma. Sem renames, o par vira delete+add e as duas
    // metades entram no patch. (A deleção PURA, sem par, sempre funcionou — por isso o defeito é
    // invisível até alguém renomear.)
    const changed = await git(`diff --name-only --no-renames ${quote(base)}..${quote(branch)}`);
    // HARD guard (94bfdb77 false-done): a FAILED diff is a failed integration, NEVER an empty change
    // set. Reading `!ok` as `[]` let a vanished/renamed ref sail through both halves as "empty",
    // finalize `done` and advance the card with ZERO content landed. The rev is resolved+pinned at
    // pick-time (resolveIntegrationSha), so reaching this means git itself broke — fail loud, keep the
    // branch preserved, and leave the operator/steward a truthful detail to requeue from.
    if (!changed.ok) {
      finalize(entry, "failed", {
        failureReason:
          `split: diff ${base.slice(0, 8)}..${branch.slice(0, 12)} FALHOU (${(changed.stderr || changed.stdout || "sem detalhe").trim().slice(0, 160)}) — NADA foi integrado; branch preservada, re-enfileire após diagnosticar`,
      });
      await persist();
      notify();
      return "paused";
    }
    const files = changed.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    // A DERIVED artifact travels with the SOURCE it derives from, not with its own path — otherwise the
    // pair is torn in half and both halves are wrong at once (see `staging.dataDerived` in types.ts).
    const dataDerived = staging.dataDerived ?? [];
    const partitioned = partitionPaths(files, staging.codePrefixes, dataDerived.map((d) => d.artifact));
    // …and the MIRROR of that rule: a data-half file that the code half IMPORTS travels WITH the code,
    // or `stage` lands with an import pointing at a file that only exists on main. Reads at the PINNED
    // rev (the tree the gate validated), synchronously pre-fetched because the promotion is pure.
    // Pre-fetch the code half PLUS the promotion CANDIDATES (non-board data) — a promoted file may
    // itself import another one, so the worklist needs their text too. Board cards, the bulk of the
    // data half, are never promotable and are never read here.
    const importerSources = new Map<string, string>();
    for (const f of [...partitioned.code, ...partitioned.data.filter((p) => !p.startsWith("storymap/boards/"))]) {
      const shown = await git(`show ${quote(`${branch}:${f}`)}`);
      if (shown.ok) importerSources.set(f, shown.stdout);
    }
    const { data, code, promoted } = promoteImportedDataPaths(
      partitioned.code,
      partitioned.data,
      (p) => importerSources.get(p) ?? null,
    );
    if (promoted.length > 0) {
      console.warn(
        `[harness-merge-queue] split ${entry.runId}: ${promoted.length} arquivo(s) de dados viajam com o código ` +
          `(importados por ele): ${promoted.join(", ")}`,
      );
    }
    // Everything the data half may legitimately touch on main — board data plus the artifacts it derives.
    // The scoped park/restore below must span exactly this, or a regenerated artifact reads as rogue
    // staged code and aborts the cleanup.
    const dataPathspecs = [BOARD_DATA_PATHSPEC, ...dataDerived.map((d) => d.artifact)];

    // Mark this entry a SPLIT and persist the marker BEFORE touching git — so a crash anywhere below
    // leaves recover() a durable signal to resume via the split path (not the whole-branch merge path).
    entry.split ??= {};
    await persist();

    // --- CODE → STAGE (held for the human release gate) --------------------------------------------
    // Guarded by the persisted `codeStaged` marker so a restart never re-applies/double-commits the code.
    if (!entry.split.codeStaged && code.length === 0) {
      // Board-data-only run. With staging on, EVERY run is routed through the split (a whole-branch merge
      // would leak the unreleased code the run inherited from `stage`), so the common ~93% board-only run
      // lands here with no `packages/**` delta. Mark the code half done WITHOUT touching `stage` — an empty
      // patch can't be committed — and WITHOUT stamping `stagedAt` (the card carries no unreleased code).
      entry.split.codeStaged = true;
      await persist();
      // WS-2: witness the EMPTY half too. Without this line a board-data-only run (the ~93% case) is
      // indistinguishable from one whose code half never ran — and the ruler would have to call it `absent`
      // instead of `n/a`.
      await recordLanding({
        runId: entry.runId,
        board: entry.board,
        cardId: entry.cardId,
        half: "code",
        ref: staging.branch,
        sha: null,
        empty: true,
      });
    } else if (!entry.split.codeStaged) {
      const stagePath = stageWorktreePath(cfg.repoRoot, staging.branch);
      try {
        await ensureStageWorktree(stagePath, staging.branch);
      } catch (err) {
        // D3: uma SESSÃO viva volta para si mesma; só um run espera o operador (ver parkOrReturn).
        const outcome = await parkOrReturn(
          entry,
          `split: stage worktree falhou: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
        );
        return outcome === "returned" ? "done" : "paused";
      }
      // Discard any uncommitted partial from a prior crashed apply (committed staged code is kept).
      await gitAt(stagePath, `reset --hard HEAD`);
      // Keep `stage` CURRENT with the released branch before applying this run's code — the card-agnostic
      // root-cause fix for the stale-stage clobber/conflict (see syncStageWithReleased). A genuine overlap
      // of unreleased code with the released branch's newer code pauses (fail-safe), never clobbers.
      const releasedBranch = (await git(`rev-parse --abbrev-ref HEAD`)).stdout.trim() || "main";
      if ((await syncStageWithReleased(stagePath, releasedBranch, staging.branch)) === "conflict") {
        await gitAt(stagePath, `reset --hard HEAD`); // leave stage clean
        // O conflito aqui é entre BRANCHES (stage×released) — NÃO é do código desta entry. Re-drivar o
        // card não cura divergência de branch: 2 redrives de story-tlz0dt (fe488749, 8258317f) morreram
        // neste exato muro a ~US$3-10 cada, reimplementando um fix que nunca conseguiria aterrissar.
        // Recuperação em escada: (1) evicção DETERMINÍSTICA quando a divergência é a tentativa anterior
        // do PRÓPRIO card (o ciclo de redrive — ver evictSupersededAndSync); (2) sessão viva resolve o
        // próprio conflito (returned-to-session, via maybeRedrive); (3) runs parqueiam com a receita
        // acionável — nunca um redrive.
        if ((await evictSupersededAndSync(stagePath, releasedBranch, staging.branch, entry)) === "synced") {
          console.warn(
            `[harness-merge-queue] ${entry.runId}: stage↔${releasedBranch} divergiam pela tentativa antiga de ${entry.board}/${entry.cardId} — evicção aplicada, sync concluído`,
          );
        } else {
          await gitAt(stagePath, `reset --hard HEAD`); // desfaz qualquer meia-evicção; stage limpo
          const syncDetail =
            `split: stage não sincroniza com ${releasedBranch} (código não-liberado conflita) — run ${entry.runId}. ` +
            `Recuperação: reconcile_stage (mode sync) para reconciliar stage↔${releasedBranch} e depois ` +
            `resolve_merge {runId:"${entry.runId}", action:"requeue"} nesta entry. NÃO re-drivar: reimplementar o card não cura divergência de branch.`;
          if (entry.kind === "session") {
            const result = await maybeRedrive(entry, syncDetail); // sessão viva → returned-to-session (refresh + re-submit)
            if (result === "redriven") return "done";
            return "paused";
          }
          finalize(entry, "conflict", { conflictDetail: syncDetail });
          await persist();
          notify();
          return "paused";
        }
      }
      // Golden snapshots (*.snap) are DERIVED — textual merge of two independently-regenerated
      // snapshots produces YAML-corrupt conflict markers (binary attribute prevents git from
      // attempting the merge, but patch apply still errors out). Separate them from real code:
      // exclude from the diff, regenerate via `vitest -u` against the merged source instead (AC2).
      const snapFiles = code.filter((f) => f.endsWith(".snap"));
      const nonSnapCode = code.filter((f) => !f.endsWith(".snap"));

      let codeApplied: "applied" | "already" | "conflict" | "error" | null = null;
      if (nonSnapCode.length > 0) {
        const nonSnapSpec = nonSnapCode.map((p) => quote(p)).join(" ");
        // `--binary` is MANDATORY: without it git emits the placeholder line "Binary files a/x and
        // b/x differ" — no payload, no full index — and `git apply` refuses the WHOLE patch with
        // "cannot apply binary patch to 'x' without full index line", even under `--3way`. The text
        // hunks in the same patch DO apply, so the run half-lands and the entry parks as `conflict`
        // (that is the .snap "meia-aterrissagem" of storymap/story-sgvqqm). Every asset a run touches
        // — icon, image, font, snapshot — depends on this flag.
        await git(`diff --binary --no-renames ${quote(base)}..${quote(branch)} -- ${nonSnapSpec} > ${quote(codePatch)}`);
        // Varre, ANTES de aplicar, todo resíduo NÃO-RASTREADO nos caminhos que este patch CRIA. O
        // `reset --hard HEAD` lá em cima não remove arquivo NOVO — ignorado ou não-rastreado —, e um que a
        // tentativa anterior deixou (ou outra entrada deixou, meses atrás) faz o degrau 1 do applyPatch
        // morrer com «already exists in working directory», e o veredito vira «código conflita com
        // stage» — que MENTE: o patch aplica limpo num worktree fresco. Medido em 2026-09-01: 5
        // submissões idênticas de um vendoring (arquivo antes gitignorado no alvo). Ver patch-creations.ts.
        // Sem patch legível (exec injetado que não escreve em disco, ou leitura falhando) ⇒ nada a varrer —
        // a varredura é HIGIENE, nunca pode virar a causa de uma falha do split.
        const createdPaths = patchCreatedPaths(await fsp.readFile(codePatch, "utf8").catch(() => ""));
        const sweptBefore = await sweepPatchCreations(git, stagePath, createdPaths);
        if (sweptBefore.length > 0) {
          console.warn(
            `[harness-merge-queue] split: varreu ${sweptBefore.length} resíduo(s) não-rastreado(s) do stage nos caminhos que o patch cria: ${sweptBefore.slice(0, 5).join(", ")}`,
          );
        }
        codeApplied = await applyPatch(stagePath, codePatch, {
          threeway: true,
          // P-1 — captura ANTES do `reset --hard` logo abaixo. Sem esta linha o desfecho é a frase de nove
          // palavras que a sessão não consegue acionar; com ela, os arquivos e as regiões que divergiram.
          onConflict: (stderr) => captureConflictInto(entry, stagePath, stderr),
        });
        if (codeApplied === "error" || codeApplied === "conflict") {
          await gitAt(stagePath, `reset --hard HEAD`); // discard markers; leave stage clean
          // …e o que o patch CRIOU e o reset não alcança (arquivo novo, ignorado ou não) — senão a
          // PRÓXIMA tentativa morre no degrau 1 com o veredito errado (ver a varredura acima).
          await sweepPatchCreations(git, stagePath, createdPaths);
          await persist(); // o artefato recém-capturado precisa sobreviver a um restart aqui
          const conflictDetail = `split: código conflita com ${staging.branch} (run ${entry.runId})`;
          // WS-10.3 — THE genuine text divergence of the train: this run's code and `stage`'s code each
          // carry a different text for the same region. Climb the ladder BEFORE parking/re-driving, so a
          // merely-cosmetic disagreement (a reworded comment, a reformat) never costs a human — and a
          // substantive one reaches them WITH the per-hunk analysis. A resolution re-enters as a NEW entry
          // (the gate re-runs over it), so this entry is done either way.
          // P-1/I-6 — a escada recebe SÓ os arquivos que de fato divergiram, não todo o código da entrada.
          // Antes ela recebia `nonSnapCode` inteiro, e com as invariantes 1 e 2 (degrau 1 exige TODOS
          // equivalentes módulo whitespace; degrau 2 é tudo-ou-nada) qualquer entrada com mais de um ou dois
          // arquivos escalava POR CONSTRUÇÃO — a precisão do juiz era destruída pelo conjunto de entrada
          // antes de ele começar. Sem captura (artefato vazio) volta ao conjunto largo: nunca pior que antes.
          const divergent = (entry.conflict?.files ?? []).filter((f) => nonSnapCode.includes(f));
          if (
            (await climbSemanticLadder(entry, {
              ours: staging.branch,
              theirs: branch,
              base,
              files: divergent.length > 0 ? divergent : nonSnapCode,
              conflictDetail,
            })) === "resolved"
          ) {
            return "done";
          }
          const result = await maybeRedrive(entry, withConflictDetail(entry, conflictDetail));
          if (result === "redriven") return "done";
          return "paused";
        }
      }

      // Regenerate golden snapshots post-merge via the SHARED helper (story-zdeajs, AC4): `vitest -u`
      // rebuilds them from the now-merged source on the stage worktree so they always match the live
      // suite without markers. ONE implementation drives BOTH this split path and the staging-OFF
      // pure-merge path — the helper links node_modules, runs the update, drops the links, stages the
      // snaps and reports whether anything actually changed (DI-testable over snapFs/snapRegenTimeoutMs).
      let snapStaged = false;
      if (snapFiles.length > 0) {
        const regen = await regenerateSnapshots(stagePath, snapFiles);
        if (regen.status === "failed") {
          await gitAt(stagePath, `reset --hard HEAD`);
          const result = await maybeRedrive(
            entry,
            // LOW #3: restore the `: <err>` suffix so the operator sees WHY the regen failed (the bare
            // `catch {}` had swallowed it, leaving a reasonless message useless for triage).
            `split: regeneração de snapshot falhou (run ${entry.runId})${regen.detail ? `: ${regen.detail}` : ""}`,
          );
          if (result === "redriven") return "done";
          return "paused";
        }
        snapStaged = regen.status === "regenerated";
        codeApplied ??= snapStaged ? "applied" : "already"; // treat snap-only run as applied/already
      }

      if (codeApplied === "applied") {
        // --no-verify: the unattended stage commit bypasses the non-security hooks (mirrors
        // commitAllPending); the secret scan below is the security gate. audit #10: a NON-ok commit
        // (delta applied but not committed) now PAUSES instead of silently marking codeStaged:true.
        const committed = await gitAt(
          stagePath,
          // WS-1.3: card-less session work has no card to name in the subject — say what it IS
          // (`usm(undefined)` in the stage history would be a lie a future archaeologist has to decode).
          `commit --no-verify -m ${quote(
            entry.cardId
              ? `usm(${entry.cardId}): código staged (run ${entry.runId})`
              : `usm(sessão): código staged (sessão ${entry.runId})`,
          )}`,
        );
        if (!committed.ok) {
          await gitAt(stagePath, `reset --hard HEAD`); // discard the applied-but-uncommitted delta; stage clean
          const outcome = await parkOrReturn(
            entry,
            `split: commit do código staged falhou (run ${entry.runId}): ${(committed.stderr || `exit ${committed.code}`).slice(0, 160)}`,
          );
          return outcome === "returned" ? "done" : "paused";
        }
        const blocked = await scanLastCommitForSecrets(stagePath);
        if (blocked) {
          // ISOLATED stage worktree (gitAt, not the live `git(...)` runner) → a hard undo of the just-applied
          // staged commit is safe here; there is no uncommitted live-checkout code to clobber.
          await gitAt(stagePath, `reset --hard HEAD^1`); // undo the staged commit; stage pristine
          const reason = blocked.internalError
            ? `split: secret-scan FALHOU (erro interno do scanner) sobre o código staged — fail-closed: ${blocked.detail}`
            : `split: secret-scan DETECTOU secret no código staged: ${blocked.detail}`;
          finalize(entry, "failed", { failureReason: reason });
          try {
            // card-less (session): no card to blocker — the `failed` entry + its failureReason is the record.
            if (entry.cardId) await addSecretScanBlocker(entry.board, entry.cardId, entry.runId, reason);
          } catch (err) {
            entry.secretScanBlockerError = String(err instanceof Error ? err.message : err).slice(0, 200);
          }
          await persist();
          notify();
          return "paused";
        }
        // #37 auto-push: push the staged code; on a non-ff rejection (origin/stage advanced from
        // another checkout) reconcile and retry once, so origin/stage stays == this checkout.
        const stagePushed = await gitAt(stagePath, `push origin ${quote(staging.branch)}`); // best-effort (gitAt never throws)
        if (!stagePushed.ok && (await reconcileWithOrigin(stagePath, staging.branch))) {
          await gitAt(stagePath, `push origin ${quote(staging.branch)}`);
        }
      }
      // #38 verify-integration: before TRUSTING `codeStaged`, CONFIRM the run's code actually landed on
      // `stage`. The lost-impl (commit 325c4435) was a FALSE FLAG — `codeStaged` said staged while the code
      // was gone. A run that changed code (`code.length>0`) MUST now differ on `stage` from its base for
      // those exact files; if `stage` is byte-identical to base on ALL of them, nothing landed → DON'T mark
      // done. `diff --quiet` exits 0 (ok:true) on NO diff (not landed) and 1 (ok:false) when it differs
      // (landed); any other non-zero (git error) leaves ok:false → treated as landed, so the net NEVER
      // false-pauses a healthy integration (incl. a 3-way merge with another run's code — that still
      // changes the files vs base). The run branch is PRESERVED (we return before `branch -D`) → recoverable.
      if (code.length > 0 && base) {
        const codeFilesSpec = code.map((p) => quote(p)).join(" ");
        const noDelta = await gitAt(stagePath, `diff --quiet ${quote(base)} HEAD -- ${codeFilesSpec}`);
        if (noDelta.ok) {
          const result = await maybeRedrive(
            entry,
            `split: código aplicado mas NÃO aterrissou em ${staging.branch} (flag falsa, run ${entry.runId}) — branch preservada para reprocessar`,
          );
          if (result === "redriven") return "done";
          return "paused";
        }
      }
      // "applied" (committed, scanned clean) or "already" (a prior crashed attempt staged it) → mark it.
      entry.split.codeStaged = true;
      await persist();
      // WS-2 — THE RECEIPT, written at the one moment the fact is known first-hand, citing the actual commit
      // on `stage`. Everything downstream (redrive pre-check, teardown, branch-gc) can now READ that the code
      // landed instead of re-deriving it from git and getting it wrong. A sha, not a bool: an operator can go
      // and check the commit this claims.
      await recordLanding({
        runId: entry.runId,
        board: entry.board,
        cardId: entry.cardId,
        half: "code",
        ref: staging.branch,
        sha: (await gitAt(stagePath, `rev-parse HEAD`)).stdout.trim() || null,
      });
      // Fase 4b: stamp `stagedAt` on the card — the signal it has unreleased code on `stage`. Best-effort.
      // Card-less (session): the code IS staged and WILL ship in the next release like any other staged
      // code — there is simply no card whose release gate needs the signal.
      try {
        if (entry.cardId) await stampStaged(entry.board, entry.cardId);
      } catch (err) {
        console.error("[harness-merge-queue] stampStaged falhou (não-fatal):", err instanceof Error ? err.message : err);
      }
    }

    // --- DATA → MAIN (board cards/skills/docs) — runs SECOND, only after CODE staged clean ---------
    // autonomy-reliability WS-1.1: the DATA half (status advance + tasks done on main, IRREVERSIBLE
    // after push) now runs AFTER the CODE half succeeded — every CODE failure above RETURNED before
    // reaching here, so a board commit is NEVER created for a run whose code didn't land. This is the
    // invariant that kills the "done"-without-code state (the lost-impl of story-qb8z2c, ~$13). Guarded
    // by the persisted `dataLanded` marker so a restart never re-applies or double-commits it.
    if (!entry.split.dataLanded) {
      if (data.length === 0) {
        entry.split.dataLanded = true; // pure-code run: nothing to land on main
        await persist();
        // WS-2: the empty DATA half — the mirror of the empty code half above, and the precedent this whole
        // `n/a` distinction is modelled on ("nothing to land on main" is a fact about the RUN).
        await recordLanding({
          runId: entry.runId,
          board: entry.board,
          cardId: entry.cardId,
          half: "data",
          ref: "main",
          sha: null,
          empty: true,
        });
      } else {
        // WS-3.1 — ONE CRITICAL SECTION over the WHOLE data half (apply → structural card merge → commit →
        // secret-scan undo), not just the commit. `cfg.repoRoot` is the SHARED live main tree, and the
        // engine's boundary-1 (the `HEAD=estado` commit every run makes before cutting its worktree) writes
        // it concurrently — that is the whole reason commit-serializer.ts exists. Only the COMMIT below was
        // serialized; the `git apply --index` was NOT, so it raced `.git/index.lock`, died with
        // `fatal: Unable to create '.git/index.lock': File exists` ⇒ applyPatch returns "error" ⇒
        // maybeRedrive ⇒ the card stranded as `{codeStaged: true}` with no `dataLanded` — the exact shape of
        // the two entries wedged in the live runtime (a779b5be, f873d987), whose code was already safe on
        // `stage` while their card sat still.
        //
        // MEASURED, NOT INFERRED (the plan admitted "I never saw the race happen", so it was falsified
        // first): 5/80 unserialized applies died on the lock, 0/80 serialized ones did, and ZERO of the 160
        // hit a content conflict. That last number is why D7 refuses a looser `--3way`/`unionFallback`:
        // there was never a conflict to merge harder at, and loosening would trade a stranded card for a
        // CORRUPTED board. Regression: split-integration.test.ts "the data half survives a concurrent board
        // commit".
        //
        // HALF-SERIALIZING IS WORSE THAN NONE — it looks protected while leaving the exact window open. Two
        // further races the whole-section fix closes, both silent today:
        //   • the CARVE decision reads HEAD to ask "did main move this card?" — a concurrent commit landing
        //     between that read and the apply invalidates the answer the apply then acts on;
        //   • the secret-scan undo is `reset --soft HEAD^1`, which assumes HEAD is still OUR commit — a
        //     concurrent board commit in between makes it drop THEIRS instead.
        // The CODE half stays UNSERIALIZED by design (D9): it writes the isolated `<repo>-stage` worktree,
        // which shares no index with main, so serializing it would only cost throughput.
        //
        // The section returns an OUTCOME instead of acting: maybeRedrive/finalize rename branches and spawn
        // runs, and must never run while holding the tree's lock.
        type DataHalfOutcome =
          | { kind: "landed" }
          | { kind: "apply-failed"; detail: string }
          | { kind: "commit-failed"; detail: string }
          | { kind: "secret"; reason: string; internalError: boolean };

        const dataHalf = async (): Promise<DataHalfOutcome> => {
          // story-r4o4wo: carve out card .md files that DIVERGED on BOTH sides — the run changed them (they
          // are in `data`) AND main moved them since the fork. Those are the ONLY files where the line-based
          // `git apply --3way` can leave frontmatter conflict markers (→ the card parks). Merge THEM
          // structurally by field (mergeCardThreeWay: pipeline fields from the run, authorial from main);
          // line-apply the rest (non-card data, board.yaml union, skills, docs, and cards main never touched —
          // the ~all-runs fast path, byte-identical to the pre-fix behaviour).
          const carved: string[] = [];
          for (const f of data) {
            if (!CARD_MD_RE.test(f)) continue;
            // main diverged vs base for this card? `diff --quiet` exits non-zero (ok:false) ⇒ it changed.
            const mainUnchanged = (await git(`diff --quiet ${quote(base)} HEAD -- ${quote(f)}`)).ok;
            if (!mainUnchanged) carved.push(f);
          }
          const lineData = data.filter((f) => !carved.includes(f));

          // 1) Line-apply everything that is NOT a both-diverged card. On conflict, applyPatch's own
          //    `reset --hard` leaves main pristine (undoing this AND any card staged below) before we park.
          let lineApplied = false;
          if (lineData.length > 0) {
            const lineSpec = lineData.map((p) => quote(p)).join(" ");
            // `--binary` — see the code half above. The data half carries binary too: any
            // `staging.dataDerived` artifact (the golden .snap) travels with its source, and git treats
            // a `binary` .gitattributes file exactly like a real binary when producing the patch.
            await git(`diff --binary --no-renames ${quote(base)}..${quote(branch)} -- ${lineSpec} > ${quote(dataPatch)}`);
            const applied = await applyPatch(cfg.repoRoot, dataPatch, {
              threeway: false,
              unionFallback: true,
              // P-1: o `restoreDataPaths` do próprio applyPatch limpa a árvore logo depois — a captura só
              // cabe aqui dentro. Nomear QUAL card não aplicou é a diferença entre "board data não aplicou"
              // e uma receita acionável.
              onConflict: (stderr) => captureConflictInto(entry, cfg.repoRoot, stderr),
            });
            if (applied === "error" || applied === "conflict") {
              return { kind: "apply-failed", detail: `split: board data não aplicou em main (run ${entry.runId})` };
            }
            if (applied === "applied") lineApplied = true; // "already" ⇒ a prior attempt landed it (no new stage)
          }

          // 2) Field-level 3-way merge each both-diverged card into main (story-r4o4wo): pipeline-advance
          //    fields from the run, authorial from main, never a line-based conflict marker.
          for (const f of carved) {
            const [baseCard, mainCard, runCard] = await Promise.all([
              cardAtRef(base, f),
              cardAtRef("HEAD", f),
              cardAtRef(branch, f), // the PINNED rev (G5) — the same tree the gate validated
            ]);
            if (!baseCard || !mainCard || !runCard) {
              // A delete/rename/unparseable card on some side — fall back to the line patch for THIS file
              // (git handles add/delete cleanly; a genuine modify/delete overlap legitimately parks, its
              // own `reset --hard` leaving main pristine first).
              await git(`diff --binary --no-renames ${quote(base)}..${quote(branch)} -- ${quote(f)} > ${quote(dataPatch)}`);
              const applied = await applyPatch(cfg.repoRoot, dataPatch, { threeway: false, unionFallback: true });
              if (applied === "error" || applied === "conflict") {
                return { kind: "apply-failed", detail: `split: card ${f} não aplicou em main (run ${entry.runId})` };
              }
              continue;
            }
            const merged = mergeCardThreeWay(baseCard, mainCard, runCard);
            await writeCardToPath(path.join(cfg.repoRoot, f), merged);
            await git(`add -- ${quote(f)}`);
          }

          // 2.5) REGENERATE the artifacts derived from the data that just landed, so main is internally
          //    consistent at the instant it commits. Regenerating (never patching) is what makes this
          //    correct under concurrency: the artifact is recomputed from main's POST-merge data, so it is
          //    right even when another run changed the same source — applying the run's bytes verbatim
          //    would encode the run's data instead. A regen failure ABORTS the data half rather than
          //    committing a source whose artifact is stale: a stale artifact reds main's own suite, and
          //    the train's gate is fail-closed, so it would freeze the queue for everyone.
          for (const d of dataDerived) {
            if (!data.some((f) => d.sources.some((s) => f.startsWith(s)))) continue;
            const regen = await runDataDerivedRegen(d);
            if (regen.ok && regen.skipped) {
              console.warn(`[harness-merge-queue] split: ${regen.skipped}`);
              continue; // nada a adicionar ao índice: o artefato não existe
            }
            if (!regen.ok) {
              const restored = await restoreDataPaths(git, cfg.repoRoot, dataPathspecs);
              const suffix = restored.ok ? "" : ` [${restored.detail}]`;
              return {
                kind: "apply-failed",
                detail: `split: regeneração de ${d.artifact} falhou em main (run ${entry.runId}): ${regen.detail}${suffix}`,
              };
            }
            await git(`add -- ${quote(d.artifact)}`);
          }

          // 3) Commit iff something actually staged. For the ~all-runs fast path (NO both-diverged card),
          //    that is exactly the line patch's "applied" — byte-identical to the pre-fix trigger. When cards
          //    were merged (story-r4o4wo) or an artifact was regenerated, a real `git diff --cached --quiet`
          //    (ok:false ⇒ index ≠ HEAD) is the ground truth: it also skips the empty commit on a
          //    crash-resume whose idempotent re-merge produced no new diff.
          let hasStaged = lineApplied;
          if (carved.length > 0 || dataDerived.length > 0) hasStaged = !(await git(`diff --cached --quiet`)).ok;
          if (hasStaged) {
            // --no-verify: an unattended commit must bypass the NON-security pre-commit hooks (test-evidence
            // is non-deterministic); the secret scan below is the security gate. audit #10: a NON-ok commit
            // PAUSES with main left pristine (never a silent staged-but-uncommitted board-state loss).
            const committed = await git(
              // WS-1.3: a card-less session CAN carry board data (it moved a card on some board while doing
              // self-dev) — it takes the normal data→main split; only the subject has no card to name.
              `commit --no-verify -m ${quote(
                entry.cardId ? `board: ${entry.cardId} (run ${entry.runId})` : `board: sessão ${entry.runId}`,
              )}`,
            );
            if (!committed.ok) {
              // WS1.2 — path-scoped restore (was `git reset --hard HEAD` on the live checkout). Discards ONLY
              // the staged board delta → boards/ pristine for the re-drive, while any uncommitted code outside
              // boards/ survives; aborts-without-touching if code is unexpectedly staged.
              const restored = await restoreDataPaths(git, cfg.repoRoot, dataPathspecs);
              const suffix = restored.ok ? "" : ` [${restored.detail}]`;
              return {
                kind: "commit-failed",
                detail: `split: board commit falhou (run ${entry.runId}): ${(committed.stderr || `exit ${committed.code}`).slice(0, 160)}${suffix}`,
              };
            }
          // SM-08 fail-closed: a secret (OR a scanner internal error) in the board commit undoes it and
          // pauses the train. HARDENING 1.2 — the undo is NON-destructive: `reset --soft HEAD^1` drops the
          // board commit (the split guarantees it touches ONLY the DATA half — `storymap/boards/**` plus
          // the artifacts declared in `staging.dataDerived`, which is exactly `dataPathspecs`) then
          // restoreDataPaths scoped-restores that set to HEAD, leaving any uncommitted code OUTSIDE it in
          // the live runtime checkout UNTOUCHED (the data-loss class WS1.2 closed; the sibling commit-fail
          // path at ~L1461 already used this). The secret content survives on the run branch for diagnosis.
            const blocked = await scanLastCommitForSecrets(cfg.repoRoot);
            if (blocked) {
              await git(`reset --soft HEAD^1`);
              const restored = await restoreDataPaths(git, cfg.repoRoot, dataPathspecs);
              const suffix = restored.ok ? "" : ` [${restored.detail}]`;
              const reason = blocked.internalError
                ? `split: secret-scan FALHOU (erro interno do scanner) sobre o board data — fail-closed: ${blocked.detail}${suffix}`
                : `split: secret-scan DETECTOU secret no board data: ${blocked.detail}${suffix}`;
              return { kind: "secret", reason, internalError: blocked.internalError };
            }
          }
          return { kind: "landed" };
        };

        // WS-3.3 — RETRY THE PATCH, NOT THE SKILL. The measured cause is a RACE (5/80 unserialized applies
        // died on `.git/index.lock`, 0 of 160 hit a content conflict) — a transient that clears in a beat.
        // The old remedy was `maybeRedrive`: rename the branch and re-run the WHOLE skill from zero. Wrong in
        // two directions at once — EXPENSIVE (it re-implements code that is already on `stage`: the qb8z2c
        // pattern, ~$13) and INEFFECTIVE (the skill was never the problem; `git apply` was).
        //
        // Each attempt RE-ENTERS the critical section instead of holding it across the backoff. That is the
        // whole trick: the writer we are racing needs that same lock to FINISH — sleeping inside the section
        // would block the very thing whose completion we are waiting for, and the retry could only ever fail.
        // Idempotency is already ours: applyPatch answers "already" via `apply --reverse --check`, so a retry
        // over an applied patch is a safe no-op, never a double-apply.
        const attempts = Math.max(1, cleanTreeAttempts);
        let outcome = await commitSerializer(cfg.repoRoot, dataHalf);
        for (let i = 1; i < attempts && outcome.kind === "apply-failed"; i++) {
          console.warn(
            `[harness-merge-queue] metade de dados não aplicou (run ${entry.runId}, tentativa ${i}/${attempts}) — retentando o PATCH em ${cleanTreeDelayMs}ms (não é redrive)`,
          );
          await sleep(cleanTreeDelayMs); // OUTSIDE the section, so the racing writer can finish and let go
          outcome = await commitSerializer(cfg.repoRoot, dataHalf);
        }

        // Outside the section — these rename branches, spawn runs and notify; none of them may hold the
        // shared tree's lock while doing it.
        if (outcome.kind === "apply-failed") {
          // WS-3.4 — THE BOUND IS SPENT, and the card is now half-landed: the code IS on `stage` and the
          // board-data is NOT on `main`. NEVER maybeRedrive from here (see above). Park it and make it
          // VISIBLE: a blocker that names the right recovery, because the operator's instinct in front of
          // "falhou" is to re-drive — and that is the $13 button.
          //
          // A card-less SESSION gets no finding (there is no card): its equivalent already exists and is
          // STRONGER — `returned-to-session` hands the conflict straight back to the live session.
          if (entry.cardId) {
            try {
              await addDataNotLandedBlocker(entry.board, entry.cardId, entry.runId, outcome.detail);
            } catch (err) {
              console.error(
                "[harness-merge-queue] addDataNotLandedBlocker falhou (não-fatal):",
                err instanceof Error ? err.message : err,
              );
            }
          }
          // D3 (a lição da entrada b4fcc6e0): este parque NÃO checava `kind`, então uma SESSÃO viva
          // ficava aqui esperando um humano — 43,5 h no caso medido, terminando num abort que deixou o
          // código em `stage` e o board-data fora de `main` para sempre. A sessão é quem consegue
          // resolver isto em segundos (`worktree_refresh` + re-submit; o código já staged reaplica como
          // "already", idempotente). O bloqueador no card continua sendo escrito acima, para o caso run.
          const half = await parkOrReturn(
            entry,
            `${outcome.detail} — MEIA-ATERRISSAGEM após ${attempts} tentativa(s) do patch: o código está em ` +
              `'${staging.branch}', o board-data não está em main. Recuperação: retentar a metade de dados ` +
              `(${dataPatch}). NÃO re-drivar (re-implementaria código já publicado).`,
          );
          return half === "returned" ? "done" : "paused";
        }
        if (outcome.kind === "commit-failed") {
          const half = await parkOrReturn(entry, outcome.detail);
          return half === "returned" ? "done" : "paused";
        }
        if (outcome.kind === "secret") {
          finalize(entry, "failed", { failureReason: outcome.reason });
          try {
            if (entry.cardId) await addSecretScanBlocker(entry.board, entry.cardId, entry.runId, outcome.reason);
          } catch (err) {
            entry.secretScanBlockerError = String(err instanceof Error ? err.message : err).slice(0, 200);
          }
          await persist();
          notify();
          return "paused";
        }
        entry.split.dataLanded = true;
        await persist();
        // WS-2 — the receipt for the half git CANNOT prove. The board is live: the service mutates the card
        // right after this, so the post-image diverges by design and no later measurement can tell "did not
        // land" from "landed and the board moved on". This line is the only witness that will ever exist.
        // (`hasStaged:false` ⇒ the patch was already applied by a prior attempt ⇒ HEAD is the commit that
        // carries it — still the honest answer to "where did it land?".)
        await recordLanding({
          runId: entry.runId,
          board: entry.board,
          cardId: entry.cardId,
          half: "data",
          ref: "main",
          sha: (await git(`rev-parse HEAD`)).stdout.trim() || null,
        });
      }
    }

    // --- the run is integrated (data on main, code staged) → done ---------------------------------
    if (base && branchTip && entry.cardId) {
      try {
        await persistDiffSnapshot(entry.board, entry.cardId, { base, mergeCommit: branchTip });
      } catch (err) {
        console.error("[harness-merge-queue] split diffSnapshot falhou (não-fatal):", err instanceof Error ? err.message : err);
      }
    }
    // split onto main+stage → the throwaway branch is done. A SESSION branch is NOT throwaway (the session
    // still holds it and will refresh onto the base this very integration just advanced) → the guard keeps it.
    await deleteBranchAfterIntegration(entry);
    finalize(entry, "done");
    await pushToOrigin(entry); // pushes main's board commit (cumulative, non-fatal)
    await persist();
    notify();
    await resolveRunBlockers(entry); // audit #6: clear this run's gate/secret blockers on success
    emitMergeDone(entry.board, entry.cardId, entry.trigger);
    return "done";
  };

  /** The serial processor. Reentrancy-guarded: a second call while one runs is a no-op (returns the live promise). */
  const process = (): Promise<void> => {
    if (processing) return current;
    processing = true;
    notify();
    current = runLoop().finally(() => {
      processing = false;
      notify();
    });
    return current;
  };

  async function runLoop(): Promise<void> {
    // PARKING, not head-of-line blocking (merge-train rootcause RC2): a `gate-failed`/`conflict` entry
    // is PARKED (still `isLive` → persisted, branch preserved, retriable via resolveGateFailed/
    // resolveMergeConflict) but NO LONGER freezes the FIFO. The loop processes the next `waiting` entry,
    // skipping parked entries ahead of it, so one stuck card can't congelar a entrega de N outros. The
    // merge-back stays STRICTLY SERIAL — at most one `merging`/`gate-running` at a time — because (a)
    // this loop awaits each integration before selecting the next and (b) the defensive guard below
    // pauses if one is somehow mid-flight (re-entrancy / recovery race); the in-flight one's completion
    // re-pumps process(). (Supersedes the old conflict-pause AC3 — the design's deliberate change.)
    for (;;) {
      if (entries.some((e) => e.status === "merging" || e.status === "gate-running")) break; // serial: one integration at a time
      const entry = entries.find((e) => e.status === "waiting");
      if (!entry) break; // nothing left to integrate (queue empty, or only parked/terminal entries remain)

      entry.status = "merging";
      entry.mergeStartedAt = now();
      await persist();
      notify();

      // The ref may have vanished (a crash deleted it) or been RENAMED to a preserved name by a
      // concurrent teardown (`run/<id>` → `failed/run/<id>` — the 94bfdb77 race). Resolve + REPAIR via
      // the preserved-name candidates and PIN the sha before any content op. Only when NO candidate
      // resolves AND there is no pinned sha is the work really gone → fail this one, DON'T block the queue.
      const resolvedRef = await resolveIntegrationRef(entry);
      if (!resolvedRef && !entry.pinnedSha) {
        finalize(entry, "failed", { failureReason: `branch ${entry.branch} inexistente — nada a integrar` });
        await persist();
        notify();
        continue;
      }
      if (resolvedRef) {
        if (!entry.pinnedSha && resolvedRef.sha) entry.pinnedSha = resolvedRef.sha; // runs: tip==work (frozen at settle); sessions pinned at submit
        if (resolvedRef.ref !== entry.branch) {
          console.warn(
            `[harness-merge-queue] ${entry.runId}: ref ${entry.branch} foi renomeada durante a espera — reparada para ${resolvedRef.ref} (integrando ${resolvedRef.sha ? `o sha pinado ${resolvedRef.sha.slice(0, 8)}` : "pelo nome preservado"})`,
          );
          entry.branch = resolvedRef.ref; // ref OPERATIONS (rename/delete) must act on the LIVE name
          await persist();
        }
      }

      // Already integrated before reaching the queue (e.g. fast-forwarded by another path) → done, idempotent.
      // SKIP this short-circuit when staging is on: a run cut from `stage` carries the unreleased code in
      // flight, so it is NEVER an ancestor of main — its idempotency is owned by the split's persisted
      // markers (split.dataLanded/codeStaged), not is-ancestor. (stale-base fix)
      const ancestor = cfg.staging?.enabled
        ? null
        : await git(`merge-base --is-ancestor ${quote(integrationRev(entry))} HEAD`);
      if (ancestor?.ok) {
        await deleteBranchAfterIntegration(entry);
        finalize(entry, "done");
        await pushToOrigin(entry); // story-igl9tl: push accumulated commits to origin (non-fatal)
        await persist();
        notify();
        await resolveRunBlockers(entry); // audit #6: clear this run's gate/secret blockers on success
        emitMergeDone(entry.board, entry.cardId, entry.trigger); // story-r0zr3s: cascade hook fires after merge-back
        continue;
      }

      // HEAD=estado boundary 2: ensure main is CLEAN before the merge-back. Board mutations (writeCard,
      // never committed) may have accumulated on main DURING the runs; a dirty tree makes `git merge
      // --no-ff` abort → the run would falsely pause as `conflict` and never reconcile. Commit the live
      // board state first (board: prefix, separable from the usm(...) code commits); a clean tree is a
      // no-op. story-p3bu01: SCOPED to `storymap/boards/**` (commitBoardDataScoped, NOT the whole-tree
      // `git add -A`) so stray code / a predeploy tarball on the shared runtime checkout is NEVER swept
      // into this `board:` commit — it stays uncommitted, and the VERIFIED-CLEAN GATE below then parks the
      // still-dirty tree SAFELY (as SUJA) for the operator instead of the merge silently carrying the code.
      // A board-commit failure (e.g. secret-scan) must NOT crash the train — log it and let the flow reach
      // that clean-gate. story-ms5rmt: route this commit through the per-cwd mutex (keyed by repoRoot)
      // shared with the engine's boundary-1 start commit, so a run STARTING while this merge runs can't
      // collide on .git/index.lock. The serializer only orders the commit; the try/catch below still owns
      // the error handling (a serialized rejection re-raises here exactly like a direct call would).
      try {
        await commitSerializer(cfg.repoRoot, () =>
          commitBoardDataScoped(cfg.exec, cfg.repoRoot, "board: estado vivo antes do merge-back"),
        );
      } catch (err) {
        console.error(
          "[harness-merge-queue] board-state commit falhou antes do merge:",
          err instanceof Error ? err.message : err,
        );
      }

      // story-zdeajs (AC2/AC3) — VERIFIED-CLEAN GATE before the merge-back. The board commit above is
      // best-effort: it may FAIL (e.g. a secret-scan blocked it), or an EXTERNAL writer (a concurrent
      // autorun board commit, or a manual SSH `git`/`push`) can dirty the shared main tree between the
      // commit and the merge. `git merge --no-ff` ABORTS on a dirty working tree — and the OLD code read
      // that abort's non-zero exit as a CONTENT conflict (both exit 1), false-parking a branch that
      // integrates cleanly. We can't tell a dirty-tree abort from a real conflict AFTER the fact, so we
      // check tree cleanliness BEFORE the merge: still-dirty ⇒ the merge is doomed → DON'T attempt it.
      // PARK with a DISTINCT, accurate detail (NOT "conflito de conteúdo") and `break` — a dirty SHARED
      // tree blocks EVERY merge, so a head-of-line pause is correct here (unlike a content conflict, which
      // only parks one card). The operator resolves via the same conflict resolve/abort path (no new
      // status enum → no MERGE_QUEUE_VERSION bump).
      //
      // WS-3.2 — THE FENCE IS GONE, and the comment that justified it was HALF TRUE, which is worse than
      // wrong: it read *"staging-OFF only — the split path commits to disjoint trees (main data / stage
      // code) and owns its own cleanliness via its persisted markers"*. True of the CODE half (the
      // `<repo>-stage` worktree really is isolated). FALSE of the DATA half, which writes `cfg.repoRoot` —
      // the very same shared main tree this re-poll was hardened for. The split was fenced OUT of the
      // mitigation built for its own problem, by a premise that only described one of its two halves. A
      // comment asserting a false premise is not noise; it is the trap that charges at the worst moment.
      //
      // THE POLICIES DIFFER AFTER THE BOUND, and that difference is the point (D10):
      //   • staging OFF ⇒ a dirty shared tree dooms EVERY merge ⇒ head-of-line pause is correct.
      //   • split ⇒ the CODE half may already be on `stage`. Freezing the whole FIFO over one card's data
      //     half would be worse than the defect — so it does NOT break: it proceeds, the data half retries
      //     the patch (WS-3.3), and a genuine failure becomes a per-card blocker (WS-3.4).
      // Either way the re-poll itself is pure win: it gives a transient (an in-process board commit landing
      // right now) the beat it needs, before anyone pays for it.
      {
        // LOW #4: a transient dirty tree (a concurrent IN-PROCESS board commit racing this merge-back)
        // clears in a beat — re-poll up to `cleanTreeAttempts` times with `cleanTreeDelayMs` backoff
        // BEFORE parking, so the FIFO head isn't false-parked on a momentary race. Park ONLY if STILL
        // dirty after the bound (a genuine external/SSH writer holds it dirty) → manual resolve. The
        // re-check makes the "resolva manualmente ou aguarde o train ocioso" detail HONEST: a persistent
        // dirty tree either needs the operator OR clears once the other in-process writers go idle.
        let stillDirty = true;
        for (let attempt = 0; attempt < cleanTreeAttempts; attempt++) {
          const tree = await git(`status --porcelain`);
          stillDirty = !tree.ok || tree.stdout.trim() !== "";
          if (!stillDirty) break; // tree is clean → the merge can proceed
          if (attempt < cleanTreeAttempts - 1) await sleep(cleanTreeDelayMs); // brief backoff, then re-poll
        }
        if (stillDirty && !cfg.staging?.enabled) {
          // D3 também aqui: a sessão é avisada em vez de esperar um humano. O `break` PERMANECE de
          // qualquer forma — a árvore suja condena TODO merge, então varrer o resto da fila só produziria
          // N falhas idênticas.
          await parkOrReturn(
            entry,
            "árvore de trabalho de main SUJA antes do merge-back (commit do estado do board falhou ou escritor externo concorrente — SSH manual / outro autorun) — resolva manualmente ou aguarde o train ocioso; NÃO é conflito de conteúdo do branch",
          );
          break; // a dirty SHARED tree dooms ALL merges → pause the FIFO at this head until it's clean
        }
        if (stillDirty) {
          // SPLIT (D10): the tree is still dirty, but a `git apply` of a disjoint pathspec is not a
          // `git merge --no-ff` — it is not doomed by unrelated dirt, only by dirt in ITS OWN files. So do
          // NOT park and do NOT `break`: the whole fleet must not freeze over one card, especially when this
          // run's code may already be on `stage`. Proceed; the data half retries the patch (WS-3.3) and a
          // real failure becomes a per-card blocker (WS-3.4) instead of a head-of-line pause.
          console.warn(
            `[harness-merge-queue] árvore de main ainda SUJA após ${cleanTreeAttempts} tentativa(s) — seguindo com o split (run ${entry.runId}): o apply é por pathspec e a metade de dados tem retry próprio; a fila NÃO pausa`,
          );
        }
      }

      // INTEGRATION GATE (story-1k7els): when enabled, validate the merge in a TEMPORARY staging worktree
      // (merge the branch there + run the suite) BEFORE touching main. The staging tree is built from the
      // now-current main HEAD — the ACCUMULATED state of every prior integration — so the gate catches a
      // SEMANTIC break between runs that each isolated per-run test passes (AC4, for free via the serial
      // queue). Gate reproves → main stays intocada, entry parks as `gate-failed`, train PAUSES (the
      // operator retries/aborts via resolveGateFailed). Gate passes → fall through to the real merge-back.
      // Gate disabled (no runner, or live config off) → behavior identical to the pre-gate train.
      //
      // SM-06 hot-reload (AC3): the runner is always WIRED in production (getMergeQueue), but whether it
      // RUNS is read LIVE per entry from settings.yaml — so flipping `mergeGate.enabled` takes effect on
      // the next branch without a service restart. `cfg.gateEnabled`, when set (tests), is the authority.
      // Compute the branch's changed paths ONCE — it decides BOTH whether the CODE gate runs AND
      // (Fase 4a) whether to split. A board-data-only run (the common ~93%: card advances, QA/review
      // stamps, grill questions, status moves) touches no `packages/` code, so `vitest run` can't be
      // affected by it → it must SKIP the code gate and merge straight to main. Gating board-data was
      // wasteful (5-min suite per card edit) AND stranded it on any gate-staging flake — the live grill
      // validation hit exactly this: the questions (a card .md) stuck at `gate-failed`, never reaching main.
      // Diff against the run's integration base (baseCommit, a fixed sha) so the changed-file set is ONLY
      // this run's work — not the unreleased code it inherited from `stage`. Legacy entries (no baseCommit)
      // fall back to the 3-dot merge-base form. (stale-base fix)
      // Defect A: classify by the run's TRUE fork point (merge-base with stage), not the possibly-stale
      // persisted baseCommit — else a board-data-only run cut on top of its own staged code is dragged
      // through the code gate. Falls back to baseCommit / HEAD when staging is off (forkPointBase → null).
      const ownWorkBase = (await forkPointBase(entry)) ?? entry.baseCommit;
      const changed = ownWorkBase
        ? await git(`diff --name-only ${quote(ownWorkBase)}..${quote(integrationRev(entry))}`)
        : await git(`diff --name-only HEAD...${quote(integrationRev(entry))}`);
      const changedFiles = changed.ok ? changed.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      const codePrefixes = cfg.staging?.codePrefixes ?? STAGING_CODE_PREFIXES;
      // story-m3iouv — a régua de "isto exige verificação?" NÃO é mais `pathsTouchCode` (allow-list de
      // prefixo). Era ela que deixava `.github/**`, `justfile`, `scripts/git-hooks/**` (o próprio scanner
      // de segredo) e as configs de raiz FUNDIREM SEM O GATE RODAR NADA. Agora só `storymap/boards/**`
      // (path-disjunto, live por mtime, ~93% dos runs) pula; todo o resto verifica. Ver
      // {@link verificationDemand}. `changed.ok` viaja porque um diff ilegível passa a verificar
      // (fail-closed) em vez de virar lista vazia e, com ela, um "não é código" por acidente.
      const demand = verificationDemand(changedFiles, codePrefixes, { diffReadable: changed.ok });

      const liveMergeGate = loadRunnerConfig().autorun.mergeGate;
      const gateActive =
        (cfg.gateEnabled !== undefined ? cfg.gateEnabled : (liveMergeGate?.enabled ?? false)) && demand.needsVerification;
      // ESCRUTÍNIO EXPLÍCITO para os arquivos que SÃO o controle (`scripts/git-hooks/**`, `.github/**`,
      // `justfile`, `.claude/hooks/**`): o rastro nomeia-os SEMPRE — mesmo com o gate desligado, para que
      // desarmar um controle nunca seja um evento silencioso — e a seleção `affected` é SUSPENSA para eles
      // (ver `affected` abaixo). Um `justfile`/hook mudado não "afeta" arquivo de teste nenhum, então a
      // seleção por afetados escolheria ZERO teste e o gate diria verde sem ter olhado nada.
      if (demand.controlPaths.length > 0) {
        console.warn(
          `[harness-merge-queue] run ${entry.runId}: o delta toca ARQUIVO DE CONTROLE do pipeline ` +
            `(${demand.controlPaths.slice(0, 5).join(", ")}${demand.controlPaths.length > 5 ? ` +${demand.controlPaths.length - 5}` : ""}) ` +
            `— suíte COMPLETA, sem seleção por afetados${gateActive ? "" : " (gate DESLIGADO nesta config — apenas registrado)"}`,
        );
      }
      if (cfg.integrationGate && gateActive) {
        entry.status = "gate-running";
        await persist();
        notify();
        let gate: {
          passed: boolean;
          log: string;
          inconclusive?: boolean;
          flaky?: GateFailure[];
          conflict?: ConflictArtifact;
          preexisting?: GateFailure[];
        };
        // P-8: quem está em quarentena AGORA. Best-effort — falhar em ler o ledger só significa não
        // quarentenar ninguém, que é o comportamento de sempre.
        const quarantine = await quarantinedTestIds().catch(() => ({ testIds: [] as string[], reason: "" }));
        if (quarantine.testIds.length > 0) console.log(`[harness-merge-queue] ${quarantine.reason}`);
        try {
          gate = await cfg.integrationGate({
            exec: cfg.exec,
            repoRoot: cfg.repoRoot,
            // G5: validate the PINNED sha, not the live branch tip — the session may have committed more
            // since it submitted, and the gate's verdict must cover EXACTLY what the merge below lands.
            branch: integrationRev(entry),
            runId: entry.runId,
            // cfg overrides win (test DI); otherwise the LIVE settings.yaml value, then the hard default.
            checkCommand: cfg.gateCheckCommand ?? liveMergeGate?.checkCommand ?? DEFAULT_GATE_CHECK_COMMAND,
            timeoutMs: cfg.gateTimeoutMs ?? liveMergeGate?.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
            retryOnNewFailure: cfg.gateRetryOnNewFailure ?? liveMergeGate?.retryOnNewFailure ?? true,
            // Affected-only selection (perf, opt-in per board). Absent ⇒ full suite (pre-perf behavior).
            // story-m3iouv: SUSPENSA quando o delta toca um arquivo de CONTROLE — a seleção por afetados
            // deriva os testes dos ARQUIVOS mudados, e um `justfile`/hook/workflow não é importado por
            // teste nenhum ⇒ zero testes selecionados ⇒ "verde" sem verificação. Justamente onde o
            // escrutínio tem de ser maior, a otimização o tornaria nulo.
            affected: demand.controlPaths.length > 0 ? undefined : (cfg.gateAffected ?? liveMergeGate?.affected),
            // P-2 — a baseline é o MESMO ref que a aterrissagem escreve, e a base do delta é a MESMA que
            // o split usa. Ausentes (staging off) ⇒ o gate degrada para o merge sobre `main`.
            baselineRef: cfg.staging?.enabled ? cfg.staging.branch : undefined,
            deltaBase: cfg.staging?.enabled ? ownWorkBase || entry.baseCommit : undefined,
            // P-7 — de qual pacote rodar a suíte, lido da config e não de um caminho fixo.
            scope: cfg.gateScope ?? liveMergeGate?.scope,
            // Typecheck binário por árvore — mesma proveniência do scope: override de teste, senão o vivo.
            typecheck: cfg.gateTypecheck ?? liveMergeGate?.typecheck,
            quarantined: new Set(quarantine.testIds),
          });
        } catch (err) {
          // An UNEXPECTED gate error (not a clean pass/fail) is treated as a failure — fail CLOSED: never
          // let an exception in the gate quietly fall through to the main merge.
          gate = { passed: false, inconclusive: true, log: `gate erro inesperado: ${err instanceof Error ? err.message : String(err)}` };
        }
        // P-8 — O PRODUTOR QUE FALTAVA. O gate sempre MEDIU as falhas pré-existentes da baseline (é como
        // ele absolve o card); ninguém nunca as REGISTROU, então a main podia ficar vermelha por semanas
        // enquanto toda entrada passava, cada uma individualmente inocente. Fire-and-forget + fail-open,
        // como toda telemetria aqui: nunca pode perturbar a FIFO.
        if (gate.preexisting) {
          void recordMainRedMeasurement({ failures: gate.preexisting, sha: ownWorkBase || entry.baseCommit || "HEAD" });
        }
        // P-2 — o gate viu que o delta NÃO APLICA na baseline. É CONFLITO, não reprovação: nada foi
        // testado, e chamar isto de "seus testes quebraram" foi por anos a informação errada no pior
        // momento. Dispõe pela rota de conflito — agora ANTES de a suíte custar os ~2 min do p90.
        if (!gate.passed && gate.conflict) {
          entry.conflict = gate.conflict;
          await persist();
          const gateConflictDetail = `gate: o delta não aplica em ${cfg.staging?.branch ?? "stage"} (run ${entry.runId})`;
          const ladderBase = ownWorkBase || entry.baseCommit || "";
          if (
            cfg.staging?.enabled &&
            ladderBase &&
            (await climbSemanticLadder(entry, {
              ours: cfg.staging.branch,
              theirs: integrationRev(entry),
              base: ladderBase,
              files: gate.conflict.files,
              conflictDetail: gateConflictDetail,
            })) === "resolved"
          ) {
            continue; // resolvido: re-entrou como entrada NOVA e o gate roda de novo sobre ela
          }
          await maybeRedrive(entry, withConflictDetail(entry, gateConflictDetail));
          continue; // sessão devolvida OU run parqueado/re-drivado — a fila DRENA nos dois casos
        }
        if (!gate.passed) {
          // Um gate INCONCLUSIVO é INFRA (crash/OOM/flake do processo do gate — NÃO o código do submitter:
          // ex.: morto por um `systemctl restart storymap` concorrente, ou stdout poluído sem JSON parseável):
          // RE-ENFILEIRA um número LIMITADO de vezes antes de devolver/parquear. Um retry absorve o flake
          // transitório sem obrigar um re-submit MANUAL; o teto evita rodar a suíte para sempre num gate
          // quebrado de verdade. Vale para run E session — infra é agnóstica a quem submeteu.
          if (gate.inconclusive) {
            const retries = (entry.gateInconclusiveRetries ?? 0) + 1;
            if (retries <= MAX_GATE_INCONCLUSIVE_RETRIES) {
              entry.gateInconclusiveRetries = retries;
              entry.status = "waiting";
              entry.mergeStartedAt = undefined;
              entry.mergeEndedAt = undefined;
              await persist();
              notify();
              console.warn(
                `[harness-merge-queue] gate INCONCLUSIVO (infra) em ${entry.runId} — re-enfileirando ` +
                  `(tentativa ${retries}/${MAX_GATE_INCONCLUSIVE_RETRIES})`,
              );
              continue; // re-roda o gate num próximo passo do runLoop; main intocada
            }
            // esgotou os retries → segue no tratamento normal abaixo, já rotulado INCONCLUSIVO.
          }
          // WS-1.4/D3: a LIVE session's red gate goes straight BACK to the session (terminal), never to the
          // operator's parking lot — the session wrote the code and can fix + re-submit immediately. The
          // gate log rides along as the conflictDetail so the agent sees WHAT failed without a round-trip.
          if (entry.kind === "session") {
            // An INCONCLUSIVE gate is labelled as such: the submitter is told the gate could not run
            // (infra), not that their tests failed. Re-submitting is the right move; hunting a
            // non-existent regression in unrelated stderr is not.
            const why = gate.inconclusive
              ? `gate de integração INCONCLUSIVO (infra — não produziu veredito após ${MAX_GATE_INCONCLUSIVE_RETRIES + 1} tentativa(s); nada foi atribuído ao seu código; re-submeta)`
              : `gate de integração reprovou`;
            await returnToSession(entry, `${why}: ${gate.log.slice(0, GATE_LOG_CAP)}`);
            continue; // terminal → drain the rest of the queue; main untouched, branch intact
          }
          finalize(entry, "gate-failed", { gateLog: gate.log.slice(0, GATE_LOG_CAP) });
          // AC2: stamp a testing:blocker finding on the card so the failed branch surfaces as a blocked
          // card (held out of QA by `hasNoBlockers`) and the operator sees WHY. Best-effort: a write error
          // logs + records on the entry but NEVER stalls the train (mirrors the pushToOrigin discipline).
          const gateCardId = entry.cardId;
          try {
            if (gateCardId) await addGateBlocker(entry.board, gateCardId, entry.runId, entry.gateLog ?? gate.log);
          } catch (err) {
            const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
            console.error("[harness-merge-queue] addGateBlocker falhou (não-fatal):", msg);
            entry.gateBlockerError = msg;
          }
          await persist();
          notify();
          continue; // PARK this entry (gate-failed, retriable) and DRAIN the rest — no head-of-line block; main untouched
        }
        // WS1.3 — the gate PASSED despite a NEW failure that vanished on the whole-suite retry (flaky):
        // integrate, but AGGREGATE it (flaky.json, for future quarantine) + stamp an ADVISORY (low) finding
        // so the operator sees the card shipped over a flake. Both best-effort — a write error NEVER stalls
        // the train (mirrors addGateBlocker's discipline).
        if (gate.flaky?.length) {
          const testIds = gate.flaky.map((f) => `${f.file}::${f.name}`);
          try {
            const flakyPath = path.join(runnerStateDir(), "flaky.json");
            const prev = await fsp.readFile(flakyPath, "utf8").then((s) => JSON.parse(s) as unknown).catch(() => []);
            const arr = Array.isArray(prev) ? prev : [];
            const at = new Date().toISOString();
            for (const id of testIds) arr.push({ at, testId: id, runId: entry.runId, board: entry.board, cardId: entry.cardId });
            await fsp.writeFile(flakyPath, JSON.stringify(arr.slice(-200), null, 2));
          } catch (err) {
            console.warn("[harness-merge-queue] flaky.json append falhou (não-fatal):", err instanceof Error ? err.message : err);
          }
          try {
            // The flaky ADVISORY is a card finding; card-less work still aggregates into flaky.json above
            // (the data that feeds future quarantine), it just has no card to advise on.
            const flakyCardId = entry.cardId;
            if (flakyCardId) {
              await updateCardOnDisk(entry.board, flakyCardId, (card) => ({
                ...card,
                findings: withFlakyTestFinding(card.findings ?? [], entry.runId, testIds),
              }));
            }
          } catch (err) {
            console.warn("[harness-merge-queue] flaky finding falhou (não-fatal):", err instanceof Error ? err.message : err);
          }
        }
        // Passed → resume the normal merge path (status back to `merging` for the real integration).
        entry.status = "merging";
        await persist();
        notify();
      }

      // Staged release: when staging is on, EVERY run is integrated via the SPLIT (code → `stage`, data →
      // main) — not just code-touching ones. A run cut from `stage` carries the unreleased code in flight,
      // so a whole-branch `git merge` into main would LEAK that code to production; the split's
      // `base..branch` diff (base = the run's stage sha) extracts only this run's own work, routing its
      // board data to main and any code delta to `stage`. A board-only run takes the same path (its code
      // delta is empty → handled by the code-empty guard in integrateSplit). Staging OFF → the unchanged
      // whole-branch merge-back below. (stale-base fix; supersedes the old `&& branchTouchesCode` gate.)
      if (cfg.staging?.enabled) {
        const outcome = await integrateSplit(entry, cfg.staging);
        if (outcome === "paused") {
          // WS-1.2: if the CODE half failed (code not staged), the card did NOT advance — stamp the
          // `code-not-landed` blocker so the parked entry surfaces as a defect (lane travado), never a
          // silent "done"-without-code. No-op when the pause was a data-half failure (code already staged).
          await stampCodeNotLandedIfNeeded(entry);
          break; // conflict/secret → pause the FIFO at this head
        }
        continue; // done → the split integrated; move to the next entry
      }

      // The actual integration (staging OFF only). --no-ff keeps a merge commit per run; --no-edit avoids
      // an editor. story-zdeajs (AC1): the branch's GOLDEN snapshots (*.snap) are `binary` (.gitattributes)
      // so git can't textually merge them — a run that regenerated one diverging from main would make a
      // plain merge ABORT with the snap as an unmerged path (the bug that false-parked CLEAN merges as
      // `conflict` on the staging-off storymap board). `mergeWithSnapResolution` is snap-aware: with NO
      // snaps it is the byte-identical plain `git merge --no-ff --no-edit`; with snaps it resolves a
      // snap-ONLY conflict by regenerating from the merged source, and still treats any non-snap unmerged
      // path as a REAL conflict (abort → maybeRedrive, the existing safe path). `changedFiles` was already
      // read above (the gate/split decision) — reuse it to extract this branch's snap paths.
      const snapFiles = changedFiles.filter((f) => f.endsWith(".snap"));
      // story-apz8sa FIX 3 (.git/index.lock race): the merge-back's `git merge --no-ff` mutates the SHARED
      // main `.git/index`, exactly like the engine's no-worktree board-data settle commit and the
      // boundary-1/boundary-2 commits — which already route through commitSerializer(repoRoot). A board-data
      // commit firing mid-merge would collide on `.git/index.lock` (`fatal: Unable to create
      // '.git/index.lock'`) → the bare merge reads that as a content conflict → false-park / wasteful
      // redrive. Route the merge-back through the SAME per-cwd serializer so it serializes against every
      // other writer of this tree's index. REENTRANCY-SAFE: this runLoop is NOT itself inside a serializer
      // continuation (boundary-2's commit above already SETTLED before we reach here — it was a separate,
      // awaited serializer call), so wrapping the merge cannot deadlock the chain. The conflict ABORT lives
      // INSIDE this critical section too: the no-snap path leaves a half-merge for the caller to abort, and
      // a concurrent board-data commit slipping between the failed merge and the abort could otherwise
      // commit the CONFLICTED index — so merge+abort must be ONE atomic unit. (The snap paths already abort
      // internally; a redundant `merge --abort` there is a harmless captured no-op — git() never throws.)
      const mergeRes = await commitSerializer(cfg.repoRoot, async () => {
        const res = await mergeWithSnapResolution(integrationRev(entry), snapFiles); // G5: the pinned sha the gate validated
        if (res.outcome === "conflict") await git(`merge --abort`); // restore main BEFORE releasing the lock
        return res;
      });
      if (mergeRes.outcome === "regen-failed") {
        // The snap-conflict regen's `vitest -u` threw → mergeWithSnapResolution already aborted the merge
        // (main pristine). Re-drive or park, mirroring the content-conflict tail below. LOW #3: surface the
        // regen error detail (carried in `mergeRes.detail`) so the operator sees WHY, not just THAT, it failed.
        await maybeRedrive(
          entry,
          `snapshot regen falhou pós-merge (run ${entry.runId}) — branch preservada para reprocessar${mergeRes.detail ? `: ${mergeRes.detail}` : ""}`,
        );
        continue; // PARK or REDRIVE — both drain; maybeRedrive finalized + persisted the entry
      }
      // A synthetic GitResult-shaped value carrying the real conflict detail, so the conflict tail below
      // surfaces git's stderr exactly as the prior bare `git merge` did (behavior-neutral, no-snap case).
      const merge = { ok: mergeRes.outcome === "clean", stderr: mergeRes.detail, stdout: "" };
      if (merge.ok) {
        // f3 guard: NEVER `branch -D` a branch that is not actually an ancestor of HEAD. A merge that
        // reports ok but left the branch un-integrated (corruption / a swallowed partial merge) would
        // otherwise be deleted + marked done, silently losing the run's work. Confirm `--is-ancestor`
        // first; if false, PAUSE as `conflict` (branch preserved) for the operator to resolve.
        const integrated = await git(`merge-base --is-ancestor ${quote(integrationRev(entry))} HEAD`);
        if (!integrated.ok) {
          // WS-1.4: for a session this is its own to fix (terminal, branch intact); for a run it parks.
          if (entry.kind === "session") {
            await returnToSession(
              entry,
              `non-ancestor: o merge reportou ok mas o sha submetido não é ancestral do HEAD — nada foi integrado`,
            );
            continue;
          }
          finalize(entry, "conflict", {
            conflictDetail: `non-ancestor: merge reportou ok mas a branch não é ancestral do HEAD — preservada para resolução manual`,
          });
          await persist();
          notify();
          break; // pause the train at this head; never delete an un-integrated branch
        }

        // SM-08: re-scan the MERGE COMMIT for secrets BEFORE pushing to origin. The run-commit scan
        // (worktree.ts commitAllPending, `--staged`) already ran the SAME scanner inside the worktree,
        // but the `--no-ff` merge commit can carry diff the run never produced — board-state metadata
        // committed at boundary 2, the merge itself — so the merge scan COMPLEMENTS (not replaces) the
        // run scan (AC3). It also closes the fail-OPEN: scan-secrets.mjs now exits 1 on its own internal
        // error (e.g. a diff past git's maxBuffer), so a huge merge can't silently bypass the gate.
        //
        // FAIL CLOSED: any non-zero exit (2 = secret found, 1 = internal error) blocks the push. But the
        // merge already created the commit on LOCAL main, and `git push origin HEAD` is CUMULATIVE — a
        // later entry's push would otherwise carry this unpushed commit to origin. So we UNDO the merge
        // (`reset --hard HEAD^1`, back to the pre-merge main tip), preserve the run branch for the
        // operator, stamp a security:blocker finding on the card (held out of QA by hasNoBlockers) and
        // PAUSE the train. main returns pristine; the secret never reaches origin.
        let scanBlock: { internalError: boolean; detail: string } | null = null;
        try {
          await cfg.exec(secretScanCommand(cfg.repoRoot, { range: "HEAD~1..HEAD" }), {
            cwd: cfg.repoRoot,
            timeout: MERGE_TIMEOUT_MS,
          });
        } catch (err) {
          const e = err as { code?: unknown };
          const code = typeof e?.code === "number" ? e.code : null;
          const detail = execErrorDetail(err);
          // exit 2 = secret found; anything else (1 = scanner internal error, or an invocation failure)
          // is ALSO fail-closed — we only distinguish for the operator-facing message/finding.
          scanBlock = { internalError: code !== 2, detail };
        }
        if (scanBlock) {
          // HARDENING 1.2 — non-destructive undo of the just-created LOCAL merge commit: `reset --keep`
          // moves HEAD back to the pre-merge tip and updates the merged files, but ABORTS rather than
          // clobbering uncommitted local changes in the live checkout (was `reset --hard HEAD^1`, the same
          // data-loss class as the split path). On abort the merge commit stays LOCAL + UNPUSHED and the
          // train PAUSES here (the `break` below skips the push), so the poison never reaches origin — the
          // operator undoes it by hand after clearing the dirty tree.
          const undo = await git(`reset --keep HEAD^1`);
          const undoSuffix = undo.ok
            ? ""
            : ` [ATENÇÃO: undo do merge abortou (mudanças locais sobrepõem os arquivos merged) — o merge commit está LOCAL e NÃO-pushado; desfaça à mão após limpar a árvore]`;
          const reason =
            (scanBlock.internalError
              ? `secret-scan FALHOU (erro interno do scanner) sobre o merge commit — fail-closed, push bloqueado: ${scanBlock.detail}`
              : `secret-scan DETECTOU secret no merge commit — push bloqueado: ${scanBlock.detail}`) + undoSuffix;
          finalize(entry, "failed", { failureReason: reason });
          // AC2: stamp a security:blocker finding so the card surfaces as blocked. Best-effort: a write
          // error logs + records on the entry but NEVER un-blocks the push (mirrors addGateBlocker).
          try {
            if (entry.cardId) await addSecretScanBlocker(entry.board, entry.cardId, entry.runId, reason);
          } catch (err) {
            const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
            console.error("[harness-merge-queue] addSecretScanBlocker falhou (não-fatal):", msg);
            entry.secretScanBlockerError = msg;
          }
          await persist();
          notify();
          break; // pause the train; main is pristine again, the run branch is preserved for the operator
        }

        // SM-04: capture the SHAs needed to reconstruct this run's diff AFTER the branch
        // is gone. The diff modal otherwise recomputes `git diff main...run/<id>` live, so
        // it vanishes with the branch below. `HEAD` is the merge commit just created;
        // `HEAD^1` is the main tip immediately before it (the diff base). Non-fatal: the
        // merge already landed — a missing snapshot beats stalling the train.
        try {
          const head = await git("rev-parse HEAD");
          const parent = await git("rev-parse HEAD^1");
          const mergeCommit = head.stdout.trim();
          const base = parent.stdout.trim();
          if (head.ok && parent.ok && mergeCommit && base && entry.cardId) {
            await persistDiffSnapshot(entry.board, entry.cardId, { base, mergeCommit });
          }
        } catch (err) {
          console.error(
            "[harness-merge-queue] diffSnapshot capture failed (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        }
        await deleteBranchAfterIntegration(entry); // integrated → the throwaway branch is done (a session keeps its own)
        finalize(entry, "done");
        await pushToOrigin(entry); // story-igl9tl: push accumulated commits to origin (non-fatal)
        await persist();
        notify();
        await resolveRunBlockers(entry); // audit #6: clear this run's gate/secret blockers on success
        emitMergeDone(entry.board, entry.cardId, entry.trigger); // story-r0zr3s: cascade hook fires after merge-back
        continue;
      }

      // CONFLICT (or any non-clean merge): the merge was already ABORTED inside the serialized critical
      // section above (story-apz8sa FIX 3) — main is pristine — so here we only delegate to maybeRedrive
      // (story-92ldyt + story-ibc64m): re-drive the skill against the updated main up to maxRedrives before
      // parking as conflict for the operator. (Aborting inside the serializer keeps merge+abort atomic vs a
      // concurrent board-data commit on the shared index, which could otherwise commit the conflicted tree.)
      const conflictDetail = (merge.stderr || merge.stdout || "").slice(0, CONFLICT_DETAIL_CAP);
      await maybeRedrive(entry, conflictDetail);
      continue; // PARK or REDRIVE — both drain; maybeRedrive finalized and persisted the entry
    }
  }

  /** Stamp a terminal/paused status + its end time + the relevant detail on an entry. */
  function finalize(
    entry: MergeQueueEntry,
    status: MergeQueueEntry["status"],
    extra: { conflictDetail?: string; failureReason?: string; gateLog?: string } = {},
  ): void {
    const prevStatus = entry.status;
    entry.status = status;
    entry.mergeEndedAt = now();
    if (extra.conflictDetail !== undefined) entry.conflictDetail = extra.conflictDetail;
    if (extra.failureReason !== undefined) entry.failureReason = extra.failureReason;
    if (extra.gateLog !== undefined) entry.gateLog = extra.gateLog;
    // 6.1 — record the merge-back verdict in the durable ledger (approved/reproved/parked). Additive: does
    // NOT move the engine settle's optimistic run:<trigger> hop (spec-judged) — this hop lets the reader tell
    // whether that advance actually landed. Fire-and-forget; recordMergeOutcome is itself fully fail-open.
    // ONLY on a REAL transition (status actually changed): resolveMergeConflict re-finalizes an already-parked
    // entry (conflict→conflict) on a non-ancestor "já integrei", which must NOT append a duplicate merge:parked.
    const outcome = MERGE_OUTCOME[status];
    if (outcome && prevStatus !== status) void recordMergeOutcome(entry, outcome);
    // The verdict, announced to whoever is WAITING on it — keyed by runId, so a card-less session entry
    // is reachable too (see `onEntrySettled`). Emitted on a REAL transition only, mirroring the ledger
    // hop above, so a re-finalize of an already-parked entry doesn't replay a verdict nobody re-earned.
    // LOG-and-KEEP per listener (mirrors emitMergeDone): one throwing waiter must not silence the rest.
    if (prevStatus !== status) {
      const detail = entry.conflictDetail ?? entry.failureReason;
      for (const fn of settleListeners) {
        try {
          fn({ runId: entry.runId, status, ...(detail ? { detail } : {}) });
        } catch (err) {
          console.error("[harness-merge-queue] onEntrySettled listener threw", err instanceof Error ? err.message : err);
        }
      }
    }
  }

  return {
    async ensureRunBase() {
      // The integration base for a NEW run's worktree (stale-base rootcause fix). Staging off → HEAD.
      const headSha = async (): Promise<string> => (await git(`rev-parse HEAD`)).stdout.trim() || "HEAD";
      const staging = cfg.staging;
      if (!staging?.enabled) return headSha();
      try {
        // Ensure the persistent `stage` worktree exists, then sync it with the released branch (main) so
        // the run is cut from `stage` = main's fresh board data + the unreleased code in flight. The two
        // touch DISJOINT paths (board=storymap/**, code=packages/**), so the sync merge is normally clean.
        const stagePath = stageWorktreePath(cfg.repoRoot, staging.branch);
        await ensureStageWorktree(stagePath, staging.branch);
        const released = (await git(`rev-parse --abbrev-ref HEAD`)).stdout.trim() || "main";
        if ((await syncStageWithReleased(stagePath, released, staging.branch)) === "conflict") {
          // Genuine overlap (unreleased code vs main's newer code) → can't cut a clean stage base. Degrade
          // to HEAD rather than block the run; the split's own sync will re-pause on the real conflict.
          console.error("[harness-merge-queue] ensureRunBase: stage não sincroniza com main (conflito real) — base cai p/ HEAD");
          return headSha();
        }
        return (await git(`rev-parse ${quote(staging.branch)}`)).stdout.trim() || headSha();
      } catch (err) {
        console.error("[harness-merge-queue] ensureRunBase falhou — base cai p/ HEAD:", err instanceof Error ? err.message : err);
        return headSha();
      }
    },

    async enqueueMerge(input) {
      await ensureLoaded();
      // Idempotent enqueue: an identical run already live in the queue → ignore the duplicate.
      const prior = entries.find((e) => e.runId === input.runId);
      if (prior && isLive(prior)) return;
      if (prior) entries = entries.filter((e) => e !== prior); // a terminal retry → supersede it
      // INVARIANTE "no máximo UMA integração pendente por (board,cardId)" (merge-train rootcause RC1/RC3):
      // antes de inserir o sucessor, SUPERSEDE toda outra entrada NÃO-ATIVA do mesmo card (waiting/gate-
      // failed/conflict — nunca merging/gate-running, que estão integrando agora). Um card reaberto/
      // regenerado produz um run mais novo com código mais fresco → ele deve VENCER a entrada parqueada
      // antiga. A antiga vira `failed` (sai do conjunto live E da demanda do cockpit — demands só projeta
      // conflict/gate-failed), o branch é PRESERVADO como failed/<branch> (não -D, p/ o diff continuar
      // inspecionável) e os blockers gate/secret daquele run são limpos. Card-agnóstico.
      // WS-1.3: the invariant is "one pending integration per CARD" — it only means anything when there IS a
      // card. Two card-less session entries both carry `cardId: undefined`, and `undefined === undefined` is
      // TRUE, so the raw filter would make two UNRELATED sessions supersede each other: the second submit
      // would silently `failed` the first, whose work is neither integrated nor owned by any card. Card-less
      // entries are therefore never superseded by this rule (they are keyed by runId alone). A session WITH a
      // card follows the normal rule — a newer integration for that card still wins.
      for (const old of entries.filter(
        (e) =>
          !!input.cardId &&
          e.board === input.board &&
          e.cardId === input.cardId &&
          e.runId !== input.runId &&
          (e.status === "waiting" || e.status === "gate-failed" || e.status === "conflict"),
      )) {
        await preserveSupersededBranch(old);
        finalize(old, "failed", { failureReason: `superseded por run mais novo do mesmo card (${input.runId})` });
        await resolveRunBlockers(old); // limpa os gate/secret blockers do run obsoleto (run-scoped, idempotente)
      }
      const inserted: MergeQueueEntry = { ...input, status: "waiting", enqueuedAt: now() };
      // Pin the integration sha AT THE DOOR for entries that didn't pin at submit (run entries; sessions
      // pin in worktree_submit). The branch just received its final commit, so it MUST resolve here; from
      // now on every content op reads the immutable sha — a later rename of the ref (a teardown
      // preserving `run/<id>` → `failed/run/<id>` while the entry waits) can never turn this entry's
      // work into a silent empty diff (the 94bfdb77 false-done). Resolution failure is non-fatal: the
      // pick-time resolveIntegrationSha repairs/pins again with the preserved-name candidates.
      if (!inserted.pinnedSha) {
        const tip = await git(`rev-parse --verify --quiet ${quote(inserted.branch)}^{commit}`);
        const sha = tip.ok ? tip.stdout.trim() : "";
        if (sha) inserted.pinnedSha = sha;
      }
      entries.push(inserted);
      await persist();
      notify();
      void process();
    },

    async resolveMergeConflict(runId, action, actor) {
      await ensureLoaded();
      const entry = entries.find((e) => e.runId === runId && e.status === "conflict");
      if (!entry) return; // unknown / already resolved — no-op
      if (action === "merged") {
        if (entry.split) {
          // Fase 4a SPLIT conflict: the data already landed on main and the code conflicted on `stage`.
          // The is-ancestor guard does NOT apply (a split never merges the run branch into main, so it is
          // never an ancestor of HEAD — the guard would wrongly keep it paused forever). The operator
          // resolved the code on `stage` by hand → trust them: mark the code half staged, drop the run
          // branch, finalize done. (Abort still drops the branch + marks failed via the else-path below.)
          entry.split.codeStaged = true;
          await deleteBranchAfterIntegration(entry);
          entry.conflictDetail = undefined;
          finalize(entry, "done");
          await pushToOrigin(entry);
          await resolveRunBlockers(entry); // audit #6: clear this run's gate/secret blockers on success
          emitMergeDone(entry.board, entry.cardId, entry.trigger);
        } else {
          // f3 guard: the operator says "já integrei", but verify the branch is REALLY an ancestor of
          // HEAD before destroying it — if they were wrong (or the manual merge failed), deleting it
          // would lose the work. Non-ancestor → keep it paused as `conflict` (branch preserved).
          const integrated = await git(`merge-base --is-ancestor ${quote(integrationRev(entry))} HEAD`);
          if (!integrated.ok) {
            finalize(entry, "conflict", {
              conflictDetail: `non-ancestor: branch não é ancestral do HEAD — não foi integrada, preservada para resolução manual`,
            });
            await persist();
            notify();
            return; // do NOT delete; the head stays a conflict and the train remains paused
          }
          // Operator integrated it by hand in the shell → drop the now-merged branch, mark done.
          await deleteBranchAfterIntegration(entry);
          entry.conflictDetail = undefined;
          finalize(entry, "done");
          await pushToOrigin(entry); // story-igl9tl
          await resolveRunBlockers(entry); // audit #6: clear this run's gate/secret blockers on success
          emitMergeDone(entry.board, entry.cardId, entry.trigger); // story-r0zr3s
        }
      } else {
        // Aborted → make sure no half-merge lingers. WS-2.1: PRESERVE the branch when it carries
        // un-integrated code (rename conflicted/run/<id>) — never a blind `-D` (the incident destroyed
        // run/54de4fa8, the 3rd re-implementation of the qb8z2c fix). Only data-only branches are deleted.
        await git(`merge --abort`); // best-effort: a no-op if nothing is in progress
        await preserveAbortedBranch(entry);
        finalize(entry, "failed", { failureReason: `${actor ?? "operador"} abortou a integração` });
      }
      await persist();
      notify();
      void process(); // resume the queue for any entries still waiting behind the conflict
    },

    async resolveGateFailed(runId, action, actor) {
      await ensureLoaded();
      const entry = entries.find((e) => e.runId === runId && e.status === "gate-failed");
      if (!entry) return; // unknown / already resolved — no-op
      // Any staging worktree from the failed gate run is best-effort cleaned up (it was already torn
      // down by the gate runner's finally, but a crash mid-gate could leave one orphan).
      await cleanupGateStaging(cfg.exec, gateFs, cfg.repoRoot, entry.runId);
      if (action === "retry") {
        // Re-drive: the run's branch is preserved; reset to `waiting` so the gate runs again (the
        // operator re-drove the companion run, or the failure was a flake). Clear the stale gate log.
        entry.gateLog = undefined;
        entry.status = "waiting";
        entry.mergeStartedAt = undefined;
        entry.mergeEndedAt = undefined;
      } else {
        // Abort: the integration is given up. WS-2.1: PRESERVE the branch when it carries un-integrated
        // code (rename conflicted/run/<id>) — a gate-failed branch touches code by definition, so this
        // preserves it; only a data-only branch is `-D`'d. Main was never touched by the gate. WS-2.4: who.
        await preserveAbortedBranch(entry);
        finalize(entry, "failed", { failureReason: `${actor ?? "operador"} abortou no gate de integração` });
      }
      await persist();
      notify();
      void process(); // resume the queue (retry re-runs this head; abort lets the next waiter run)
    },

    async retryParkedEntry(runId, actor) {
      await ensureLoaded();
      const entry = entries.find((e) => e.runId === runId);
      if (!entry) return { ok: false, detail: `entry ${runId} não existe na fila` };
      if (entry.status !== "conflict" && entry.status !== "gate-failed") {
        // Not parked ⇒ nothing is waiting on a human, so there is nothing to unblock. Saying so is the point:
        // a silent no-op here would let the steward report "devolvi ao train" for an entry that is already
        // draining, and its own loop-guard would then be spent on a fiction.
        return { ok: false, detail: `entry ${runId} não está parqueada (status ${entry.status}) — nada a devolver` };
      }
      // A gate-failed park may have left an orphan staging worktree (a crash mid-gate); the gate will build a
      // fresh one. Best-effort, exactly as resolveGateFailed does before its own retry.
      if (entry.status === "gate-failed") {
        await cleanupGateStaging(cfg.exec, gateFs, cfg.repoRoot, entry.runId);
      }
      const was = entry.status;
      // Clear ONLY the failed ATTEMPT's residue — never the LINEAGE's counters (see the port's doc). The
      // resolutionAnalysis goes too: it describes the conflict we are about to re-measure, and a stale
      // analysis surviving a retry would show the operator a verdict about text that no longer diverges.
      entry.status = "waiting";
      entry.conflictDetail = undefined;
      entry.gateLog = undefined;
      entry.resolutionAnalysis = undefined;
      entry.mergeStartedAt = undefined;
      entry.mergeEndedAt = undefined;
      entry.stewardAttempts = (entry.stewardAttempts ?? 0) + 1;
      await persist();
      notify();
      void process(); // the head is free again — drain
      const detail = `entry ${runId} (${was}) devolvida ao train por ${actor} — ${entry.stewardAttempts}ª tentativa do steward`;
      console.log(`[harness-merge-queue] ${detail}`);
      return { ok: true, detail };
    },

    async reconcileCardMergeEntries(board, cardId) {
      await ensureLoaded();
      // SUPERSEDE the card's PARKED entries (failed integrations awaiting the operator). Active entries
      // (waiting/merging/gate-running) are left to finish — only gate-failed/conflict are abandoned when
      // the operator moves/reopens the card. Same teardown as the enqueue supersede: failed + preserve
      // branch as failed/<branch> + clear the run's blockers. A no-op when nothing is parked.
      const parked = entries.filter(
        (e) => e.board === board && e.cardId === cardId && (e.status === "gate-failed" || e.status === "conflict"),
      );
      if (parked.length === 0) return;
      for (const old of parked) {
        await preserveSupersededBranch(old);
        finalize(old, "failed", { failureReason: "superseded — card movido/reaberto (integração obsoleta abandonada)" });
        await resolveRunBlockers(old);
      }
      await persist();
      notify();
      void process(); // a parked head removed → drain any waiting entries behind it
    },

    setRedriveHandler(fn) {
      redriveHandler = fn;
    },

    getSnapshot: snapshot,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async recover() {
      await ensureLoaded();
      // GC dos split-*.patch ÓRFÃOS (2026-07-24): o split grava split-<runId>-{code,data}.patch para
      // recuperação a frio; quando a entrada é podada além de MAX_TERMINAL_RETAINED, seus patches viram
      // órfãos e ACUMULAM (318 observados no disco). Apaga só os SEM entrada dona — o de uma entrada retida
      // ainda é seu artefato de recuperação. Best-effort: um unlink que falha NUNCA trava o recover.
      try {
        const dir = runnerStateDir();
        const files = await fsp.readdir(dir).catch(() => [] as string[]);
        const orphans = orphanSplitPatches(files, new Set(entries.map((e) => e.runId)));
        for (const f of orphans) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
        if (orphans.length) console.log(`[harness-merge-queue] recover: ${orphans.length} split-patch órfão(s) removido(s)`);
      } catch (err) {
        console.warn("[harness-merge-queue] recover: sweep de split-patch falhou (não-fatal):", err instanceof Error ? err.message : err);
      }
      let resetToConflict = 0;
      let resumed = 0;
      let resetGateFailed = 0;
      // audit #8: collect every entry recover() drives to `done` so the cascade-after-merge hook fires
      // AFTER the final persist. recover() previously finalized these SILENTLY (no emitMergeDone), so a
      // restart that completed an integration stranded the card in its advanced autorun column with
      // nothing to re-trigger the cascade. Reset-to-`waiting` branches re-emit via runLoop, so they're
      // NOT collected here. trigger is threaded so the re-eval keeps the suppressTrigger loop guard.
      // cardId optional (WS-1.3): a card-less session entry can be completed by recover() too; emitMergeDone
      // simply has no card to cascade on.
      const completedAfterRecover: Array<{ board: string; cardId?: string; trigger?: TriggerId }> = [];
      for (const e of entries) {
        if (e.status === "merging") {
          // Fase 4a: a SPLIT (code→stage / data→main) interrupted by the restart resumes from its
          // persisted progress markers — NOT the whole-branch merge analysis below (a split never merges
          // into main, so is-ancestor is always false for it, which would mis-route it to conflict).
          if (e.split) {
            if (e.split.dataLanded && e.split.codeStaged) {
              // Both halves already landed (data on main, code on stage) — only the final `done` persist
              // was lost. Delete the now-superseded run branch (best-effort) and mark done idempotently.
              await deleteBranchAfterIntegration(e);
              finalize(e, "done");
              resumed += 1;
              completedAfterRecover.push({ board: e.board, cardId: e.cardId, trigger: e.trigger });
            } else {
              // An incomplete half → reset to `waiting`; re-process resumes the missing step (applyPatch's
              // --check/--reverse-check + the markers make every step idempotent, so nothing is redone).
              e.status = "waiting";
              e.mergeStartedAt = undefined;
              e.mergeEndedAt = undefined;
              resumed += 1;
            }
            continue;
          }
          // story-43w10w: inspect the tree BEFORE assuming conflict. Three cases:
          //   1. Branch already ancestor of HEAD → git merge completed before the crash, only the
          //      `done` persist was lost. Mark done idempotently (branch -D safe).
          //   2. Branch NOT ancestor + tree CLEAN → restart struck before/after `git merge --no-ff`
          //      (the common case). Re-drive: reset to `waiting` so the train retries cleanly.
          //   3. Branch NOT ancestor + tree DIRTY → genuine mid-merge crash (rare). Only then park
          //      as `conflict` for the operator — preserving the safety net for the real case.
          const alreadyAncestor = await git(`merge-base --is-ancestor ${quote(integrationRev(e))} HEAD`);
          if (alreadyAncestor.ok) {
            // Case 1: already integrated — mark done, clean up the branch.
            await deleteBranchAfterIntegration(e);
            finalize(e, "done");
            resumed += 1;
            completedAfterRecover.push({ board: e.board, cardId: e.cardId, trigger: e.trigger });
          } else {
            const treeStatus = await git(`status --porcelain`);
            const dirty = !treeStatus.ok || treeStatus.stdout.trim() !== "";
            if (dirty) {
              // Case 3: tree dirty → real conflict; operator must validate.
              finalize(e, "conflict", {
                conflictDetail: "merge interrompido por reinício com árvore suja — verifique antes de retomar",
              });
              resetToConflict += 1;
            } else {
              // Case 2: tree clean → safe to re-drive; reset to waiting.
              e.status = "waiting";
              e.mergeStartedAt = undefined;
              e.mergeEndedAt = undefined;
              e.conflictDetail = undefined;
              resumed += 1;
            }
          }
        } else if (e.status === "gate-running") {
          // A crash struck mid-gate → the staging worktree may be orphan. Best-effort cleanup, then park
          // as `gate-failed` so the operator retries/aborts (never silently auto-resume the gate). Main
          // was NEVER touched (the gate runs before the merge-back), so there is nothing to validate there.
          await cleanupGateStaging(cfg.exec, gateFs, cfg.repoRoot, e.runId);
          finalize(e, "gate-failed", {
            gateLog: "gate interrompido por reinício — staging removido; tente novamente (retry) ou aborte",
          });
          resetGateFailed += 1;
        }
      }
      // WS-1.2 (AC4): retroactively surface LEGACY split entries that PARKED with code NOT staged — the
      // pre-WS-1 inverted-order signature `dataLanded && !codeStaged` (e.g. the incident's run 54de4fa8,
      // `failed` with data on main but code stranded). Stamp the `code-not-landed` blocker so the affected
      // card stops reading "done"/advanced without its code. Idempotent (upsert by runId) + non-fatal; the
      // predicate touches ONLY parked split entries whose code never staged (see stampCodeNotLandedIfNeeded).
      for (const e of entries) await stampCodeNotLandedIfNeeded(e);
      // --- Prune superseded waiting/conflict/gate-failed entries (backlog cleanup) ---------------
      // The pre-fix broken train (no push-on-merge, lock leaks, no mid-merge recover) stranded
      // `run/<id>` branches that never integrated; every restart re-loaded them as `waiting`/
      // `conflict` forever. A stale head-of-line `conflict` then froze the whole serial FIFO (see
      // runLoop), and each entry painted a bogus "aguardando merge" badge on its card — often one
      // already in `concluída`. Drop an entry when it has NOTHING left to integrate:
      //   (a) its branch is gone;
      //   (b) its branch is already an ancestor of HEAD (the work landed via another path);
      //   (c) its card reached a TERMINAL column (a finished card integrates nothing more);
      //   (d) its branch only carried board data (cards/plans/wireframes) — board state lives on
      //       main's working tree (commitBoardState), never integrated FROM a run branch, so a
      //       board-only branch is superseded by definition (the card re-drives fresh if it still
      //       needs the work).
      // `gate-failed` is also pruned by the same criteria: if the branch is already integrated or
      // the card is terminal the gate failure is stale and must not block the FIFO at restart.
      // The branch is NEVER force-merged and is LEFT in git (recoverable) — only the queue entry is
      // dropped. Genuine un-integrated product code on a still-live (non-terminal) card is KEPT.
      let pruned = 0;
      const survivors: MergeQueueEntry[] = [];
      for (const e of entries) {
        if (e.status !== "waiting" && e.status !== "conflict" && e.status !== "gate-failed") {
          survivors.push(e);
          continue;
        }
        // (a) — via resolveIntegrationRef, NUNCA rev-parse do nome cru: uma branch renomeada pelo
        // teardown (`run/<id>` → `failed/run/<id>`) enquanto a entry esperava um restart lia-se como
        // "branch vanished" e a entry era DROPADA silenciosamente — a mesma classe do falso-done
        // 94bfdb77, na passada de prune. Só some de verdade quando nenhum candidato preservado resolve
        // E não há sha pinado.
        const preserved = await resolveIntegrationRef(e);
        if (!preserved && !e.pinnedSha) {
          pruned += 1; // (a) branch vanished (nenhum nome preservado sobrou)
          continue;
        }
        if (preserved && preserved.ref !== e.branch) {
          console.warn(
            `[harness-merge-queue] recover: ref ${e.branch} foi renomeada — reparada para ${preserved.ref} (entry ${e.runId} mantida)`,
          );
          e.branch = preserved.ref;
        }
        const probe = integrationRev(e); // sha pinado, senão o branch (já reparado)
        const ancestor = await git(`merge-base --is-ancestor ${quote(probe)} HEAD`);
        if (ancestor.ok) {
          pruned += 1; // (b) already integrated
          continue;
        }
        // (c) card finished — card-less work has no card that could finish, so this prune rule simply does
        // not apply to it (its branch is judged by the code/board-data rules below, like any other).
        if (e.cardId && cfg.isCardTerminal && (await cfg.isCardTerminal(e.board, e.cardId).catch(() => false))) {
          pruned += 1;
          continue;
        }
        const diff = e.baseCommit
          ? await git(`diff --name-only ${quote(e.baseCommit)}..${quote(probe)}`)
          : await git(`diff --name-only HEAD...${quote(probe)}`);
        const files = diff.ok ? diff.stdout.split("\n").map((f) => f.trim()).filter(Boolean) : [];
        const boardOnly = files.length > 0 && files.every((f) => f.startsWith("storymap/boards/"));
        if (boardOnly) {
          pruned += 1; // (d) only superseded board data
          continue;
        }
        survivors.push(e); // genuine un-integrated product code on a live card → keep
      }
      if (pruned > 0) entries = survivors;
      const waiting = entries.filter((e) => e.status === "waiting").length;
      await persist();
      notify();
      // audit #8: persisted state is now authoritative → fire the cascade hook for every integration
      // recover() completed (a thrown listener can't abort the pass; emitMergeDone swallows throws), so
      // the card resumes its cascade instead of stalling in its advanced autorun column post-restart.
      for (const c of completedAfterRecover) emitMergeDone(c.board, c.cardId, c.trigger);
      void process(); // resume any `waiting` entries (a clean restart picks the train back up)
      return { loaded: entries.length, resetToConflict, resumed, pruned, resetGateFailed, waiting };
    },

    async whenIdle() {
      await current;
      await writeChain;
    },

    onMergeDone(fn) {
      mergeListeners.add(fn);
      return () => mergeListeners.delete(fn);
    },

    onEntrySettled(fn) {
      settleListeners.add(fn);
      return () => settleListeners.delete(fn);
    },

    /**
     * Os runIds das entradas VIVAS (waiting/gate-running/gate-failed/merging/conflict) — o que o nome sempre
     * prometeu e NÃO entregava: devolvia TODAS as entradas, inclusive as terminais.
     *
     * O estrago: a fila retém até MAX_TERMINAL_RETAINED (100) entradas terminais, e o gate de ociosidade do
     * recovery sweep é `liveRunIds().length === 0` (instrumentation.ts). Com o cap saturado — 100 entradas,
     * 96 `done` + 4 `failed`, ZERO vivas — `isIdle()` era SEMPRE falso e o sweep pulava TODO tick, para
     * sempre. Silenciosamente: recuperação de runs órfãos, branch GC e a reconciliação de deploy-failure
     * ficaram mortos assim que a fila encheu, e nada nos logs dizia isso.
     *
     * Quem precisa do conjunto COMPLETO (qualquer entrada, viva ou terminal) tem {@link allRunIds}.
     */
    async liveRunIds() {
      await ensureLoaded();
      return entries.filter(isLive).map((e) => e.runId);
    },

    /**
     * As entradas EM VOO. Mesma família de bug que {@link liveRunIds} corrigiu para as TERMINAIS, um
     * degrau adiante: `liveRunIds` conta as PARKEADAS, e uma entrada parkeada espera um HUMANO — por
     * dias. Quem usa a resposta como portão de ociosidade (`pipelineIdle`) entrava num impasse
     * circular: publicar espera ociosidade → ociosidade espera o conflito parkeado → o conflito
     * parkeado espera alguém decidir. Observado em 2026-07-23: um conflito parkeado desde 21/07 deixou
     * a fila de publicação E o recovery sweep pulando TODO tick, em silêncio, por dois dias.
     *
     * O contrato de `PipelineIdleProbes.liveMergeEntries` já dizia "parked não entra" — só não havia
     * ninguém implementando isso. `liveRunIds` continua contando parkeado de propósito: ali a pergunta
     * é "quem ocupa a fila", e uma entrada parkeada de fato segura a cabeça do train.
     */
    async activeRunIds() {
      await ensureLoaded();
      return entries.filter(isActive).map((e) => e.runId);
    },

    /**
     * TODOS os runIds conhecidos pela fila — vivos E terminais. É o que a proteção anti-órfão do settle-gap
     * quer de fato: um órfão de settle-gap é um run SEM NENHUMA entrada na fila; um run com entrada terminal
     * foi integrado normalmente e não deve ser varrido. Semântica separada de {@link liveRunIds} de propósito
     * — foi conflatá-las num método só (com o nome da outra) que matou o recovery sweep.
     */
    async allRunIds() {
      await ensureLoaded();
      return entries.map((e) => e.runId);
    },

    async sweepStuck() {
      await ensureLoaded();
      const deadline = cfg.entryDeadlineMs ?? DEFAULT_ENTRY_DEADLINE_MS;
      const stuck = stuckEntries(entries, now(), deadline);
      if (stuck.length === 0) return { swept: 0, warned: 0, runIds: [] };
      const minutes = (e: MergeQueueEntry) => Math.round((now() - (e.mergeStartedAt ?? now())) / 60_000);
      if (processing) {
        // O processador está VIVO: pode ser só lentidão. Avisa com a idade e NÃO toca no estado — ver o
        // doc do port: mentir sobre ociosidade é pior que um travamento visível.
        for (const e of stuck) {
          console.warn(
            `[harness-merge-queue] entrada ${e.runId.slice(0, 8)} em ${e.status} há ${minutes(e)}min (prazo ${Math.round(deadline / 60_000)}min) — ` +
              `o processador AINDA está vivo, então nada foi finalizado; se persistir, o train está pendurado`,
          );
        }
        return { swept: 0, warned: stuck.length, runIds: stuck.map((e) => e.runId) };
      }
      for (const e of stuck) {
        finalize(e, "failed", {
          failureReason:
            `entrada ATIVA (${e.status}) por ${minutes(e)}min sem processador vivo — o laço de integração morreu ` +
            `no meio dela e a deixou travando a cabeça do train. Finalizada pela varredura para a fila voltar a ` +
            `drenar; o branch está PRESERVADO. Re-enfileire pelo Inbox se o trabalho ainda for necessário.`,
        });
        console.error(`[harness-merge-queue] varredura destravou a cabeça: ${e.runId.slice(0, 8)} (${minutes(e)}min em ${e.status})`);
      }
      await persist();
      notify();
      void process(); // a cabeça está livre — drena o que estava atrás
      return { swept: stuck.length, warned: 0, runIds: stuck.map((e) => e.runId) };
    },

    async pump() {
      await ensureLoaded();
      const waiting = entries.filter((e) => e.status === "waiting").length;
      // Nada esperando ⇒ nada a fazer. Algo EM VOO ⇒ o laço está vivo e vai seguir sozinho quando aquela
      // integração terminar (ela re-bombeia no `finally`): cutucar agora seria no-op, e chamar de "pumped"
      // um no-op faria o log mentir sobre ter destravado alguma coisa.
      if (waiting === 0 || processing || entries.some((e) => e.status === "merging" || e.status === "gate-running")) {
        return { waiting, pumped: false };
      }
      console.warn(
        `[harness-merge-queue] fila PARADA com ${waiting} entrada(s) esperando e nada em voo — re-cutucando o laço ` +
          `(provável rastro de uma pausa por árvore suja, que não gera evento de retomada)`,
      );
      void process();
      return { waiting, pumped: true };
    },
  };
}

// MERGE_QUEUE_VERSION — bump when the persisted shape changes incompatibly; load() drops a file whose
// version it doesn't recognize. The entries drive the most DESTRUCTIVE ops in the runner (recover()
// fires `git branch -D`, `git worktree remove --force`, `git merge` into main off e.status/e.branch/
// e.split), so reading a foreign/old/garbage schema as-is is the footgun this guards — mirroring the
// journal + telemetry stores, the merge queue's siblings. Kept at 1 (the value already on disk) so
// existing files stay readable with no migration.
const MERGE_QUEUE_VERSION = 1;

// Tolerant shape contract for ONE persisted entry. Drop any entry that doesn't structurally match the
// types recovery branches on (status enum, branch/runId strings, split shape) instead of casting
// garbage in. `trigger` stays loose (z.string) on purpose — same rationale as the journal: an entry
// whose generating skill was renamed between boots is STILL worth keeping so recovery can clean its
// branch (a TriggerId lookup-miss downstream just means "don't re-drive"). Every optional is listed so
// a fully-populated valid entry is never dropped for carrying a known field.
const MergeQueueEntrySchema = z.object({
  runId: z.string(),
  board: z.string(),
  // WS-1.3/D2 — OPTIONAL: a `kind: session` entry may be CARD-LESS (self-dev, a quick fix). It was
  // `z.string()` (required), and `load()` only pushes `parsed.success` — so a card-less entry failed the
  // parse and the WHOLE entry was DISCARDED on boot: the session's work left with no integration and no
  // trace in the queue. A schema that is stricter than its own type is a data-loss bug, not a guard.
  cardId: z.string().optional(),
  branch: z.string(),
  status: z.enum([
    "waiting",
    "gate-running",
    "gate-failed",
    "merging",
    "conflict",
    "re-driving",
    "done",
    "failed",
    // WS-1.4/G6 — absent here, a `returned-to-session` entry failed the parse and vanished from the ledger
    // on the next restart: the operator would lose the record that a session's submit was handed back.
    "returned-to-session",
  ]),
  enqueuedAt: z.number(),
  // PRE-EXISTING BUG (predates storymap-parallel-work — verified absent at 3f88e637a). `baseCommit` is the
  // integration base captured at spawn (ensureRunBase) as a FIXED sha, precisely so it is immune to
  // stage/main advancing between spawn and merge-back. Zod STRIPS unknown keys, so every load() silently
  // dropped it and the split fell back to `HEAD`/merge-base after any restart — resurrecting the exact
  // stale-base class the field was introduced to kill (and re-risking a leak of unreleased stage code to
  // main on a whole-branch merge). Found while wiring WS-10.
  baseCommit: z.string().optional(),
  // WS-1.2/G5 — the sha `worktree_submit` pinned. Dropped on load, the post-restart integration would read
  // the branch's LIVE TIP instead: commits the gate never validated would ride in on a gate verdict earned
  // by different code. G5 is the whole point of the pin; an invariant that dies at the next restart is not
  // an invariant (the same lesson the `kind` comment below records).
  pinnedSha: z.string().optional(),
  mergeStartedAt: z.number().optional(),
  mergeEndedAt: z.number().optional(),
  conflictDetail: z.string().optional(),
  failureReason: z.string().optional(),
  gateLog: z.string().optional(),
  trigger: z.string().optional(),
  driveCount: z.number().optional(),
  pushError: z.string().optional(),
  gateBlockerError: z.string().optional(),
  secretScanBlockerError: z.string().optional(),
  split: z.object({ dataLanded: z.boolean().optional(), codeStaged: z.boolean().optional() }).optional(),
  // WS-1.4/D3 — the entry's kind. Zod STRIPS unknown keys, so a field absent from this schema is silently
  // dropped on every load(): without it a `kind: session` entry comes back from a restart looking like a
  // run, and WS-10's D3 guard ("a live session resolves its own conflict — never the judge") would spend a
  // judge on it. A safety invariant that only holds until the next restart is not an invariant.
  kind: z.enum(["run", "session"]).optional(),
  // WS-10 — the ladder's durable state. `semanticAttempts` is the loop-guard (invariant 3): if it were
  // dropped on load, a restart would refill the entry's judge budget and the "1 attempt per entry" cap
  // would be decorative. `resolutionAnalysis` is what Inbox renders on the parked item.
  semanticAttempts: z.number().optional(),
  resolutionAnalysis: z
    .object({
      detail: z.string(),
      outcome: z.string(),
      hunks: z.array(z.object({ file: z.string(), hunk: z.string(), verdict: z.string(), rationale: z.string() })),
    })
    .optional(),
  // WS-8.1 — the steward's own loop-guard. Same lesson as `semanticAttempts` above: a counter that a restart
  // resets is not a loop-guard. Dropped on load, the steward would re-hand the same parked entry back to the
  // train after every service restart, forever.
  stewardAttempts: z.number().optional(),
  // P-1 — o artefato do conflito. Zod STRIPA chave desconhecida, então um campo ausente daqui é DROPADO em
  // todo load(): a entrada parqueada voltaria de um restart sem os arquivos que o operador precisa ler, e o
  // steward re-devolveria ao train uma divergência que ninguém consegue mais nomear. Mesma lição que os
  // comentários de `kind` e `semanticAttempts` acima registram — um campo que morre no próximo restart não
  // é um campo.
  conflict: z
    .object({
      files: z.array(z.string()),
      hunks: z.array(z.object({ file: z.string(), hunk: z.string() })),
      truncatedFiles: z.number().optional(),
      truncatedHunks: z.number().optional(),
    })
    .optional(),
});

/** Atomic on-disk store: write a temp file then rename over the target (same fs) — mirrors the journal. */
export function diskMergeQueueStore(dir: string): MergeQueueStore {
  const file = path.join(dir, "merge-queue.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        // Foreign / old-schema file → start clean (never feed unrecognized entries to recovery).
        if (data?.version !== MERGE_QUEUE_VERSION || !Array.isArray(data.entries)) {
          // settle-gap/version-bump: a SELF version bump that drops branches mid-integration does so
          // LOUDLY (distinguishable from a clean boot); their run/<id> branches stay in git (recoverable).
          if (data && Array.isArray(data.entries) && data.entries.length && data.version !== MERGE_QUEUE_VERSION) {
            console.warn(
              `[harness-merge-queue] versão ${data.version} ≠ ${MERGE_QUEUE_VERSION}: descartando ${data.entries.length} entrada(s) na fila de merge (bump de schema) — branches run/* permanecem em git.`,
            );
          }
          return [];
        }
        // Keep only structurally-valid entries; a malformed one is dropped, not trusted into git ops.
        const valid: MergeQueueEntry[] = [];
        for (const e of data.entries) {
          const parsed = MergeQueueEntrySchema.safeParse(e);
          if (parsed.success) valid.push(parsed.data as MergeQueueEntry);
        }
        // WS-2.4 — RESOLVE stranded `re-driving` entries on BOOT; do not DELETE them. A re-drive's live work
        // is a FRESH run regenerating the branch, and runs do NOT survive a service restart — so a
        // `re-driving` seen at load() always has no live work AND no operator path
        // (resolveMergeConflict/resolveGateFailed both ignore it), i.e. it would strand TERMINAL forever.
        // That much was right. Silently DROPPING it was not: the entry is the only legible record of what
        // happened, and the two entries wedged in the live runtime (a779b5be, f873d987 — both
        // `{codeStaged:true}` with no `dataLanded`) were one restart away from evaporating, taking the only
        // readable evidence of the half-landing with them. The branch survived in git; the story did not.
        //
        // `failed` instead: same effect (terminal, not live, never blocks the FIFO), but it is REQUEUEABLE
        // by the operator and it SAYS WHY. An erased record is requeueable by nobody. Same pattern the
        // recovery already applies to an interrupted entry ("1 interrompido → 0 retomado, 1 pulado").
        // The durable fact ("this half landed") lives in the append-only landings ledger regardless, so this
        // is about operator legibility, not about proof.
        const stranded = valid.filter((e) => e.status === "re-driving");
        if (stranded.length > 0) {
          console.warn(
            `[harness-merge-queue] resolvendo ${stranded.length} entrada(s) 're-driving' órfã(s) no boot para 'failed' (run de re-drive não sobrevive a restart): ${stranded.map((e) => e.cardId).join(", ")} — branches run/* permanecem em git, entradas requeueáveis`,
          );
        }
        return valid.map((e) =>
          e.status === "re-driving"
            ? {
                ...e,
                status: "failed" as const,
                failureReason:
                  `re-drive órfão: o serviço reiniciou no meio do re-drive (run headless não sobrevive a restart) — ` +
                  `entrada resolvida no boot para não sumir da fila. O branch ${e.branch} permanece em git; ` +
                  `requeue pelo Inbox se o trabalho ainda for necessário.` +
                  (e.split?.codeStaged && !e.split?.dataLanded
                    ? ` ATENÇÃO: MEIA-ATERRISSAGEM (código em stage, board-data NÃO em main) — a recuperação é retentar a metade de dados, NUNCA re-drivar.`
                    : ""),
              }
            : e,
        );
      } catch {
        return []; // absent / unreadable / malformed JSON → start clean
      }
    },
    async persist(entries) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: MERGE_QUEUE_VERSION, entries }, null, 2);
      try {
        await fsp.writeFile(tmp, body, "utf8");
        await fsp.rename(tmp, file); // atomic; overwrites on win32 via MoveFileEx
      } catch {
        await fsp.writeFile(file, body, "utf8"); // fallback if rename is unavailable
      }
    },
  };
}

const KEY = Symbol.for("storymap.runner.mergeQueue");
const store = globalThis as unknown as { [KEY]?: MergeQueuePort };

/** Process-global merge queue over the real git + disk store, bridged to the registry (snapshot/SSE). */
export function getMergeQueue(): MergeQueuePort {
  if (store[KEY]) return store[KEY]!;
  // SM-06 hot-reload (AC3): ALWAYS wire the gate runner; leave `gateEnabled`/`gateCheckCommand`/
  // `gateTimeoutMs` UNSET so `runLoop()` reads the live `loadRunnerConfig().autorun.mergeGate` per
  // entry. Flipping `mergeGate.enabled` (or its check/timeout) in settings.yaml then takes effect on the
  // next processed branch WITHOUT a service restart — the singleton no longer freezes the enabled flag.
  // `makeDefaultGateRunner()` is a pure closure (no I/O until invoked), so wiring it when disabled is free.
  const mq = makeMergeQueue({
    repoRoot: findRepoRoot(),
    // Fase 4a staged release: read ONCE at construction (boot-fixed) — unlike mergeGate.enabled (hot
    // per-entry), splitting a live batch of runs across main/stage mid-flight would corrupt the train.
    // DEFAULT OFF until activation (creating the `stage` branch + flag + restart is an explicit step).
    staging: loadRunnerConfig().autorun.staging,
    exec: defaultExec,
    store: diskMergeQueueStore(runnerStateDir()),
    integrationGate: makeDefaultGateRunner(),
    // WS-10/D14 — rung 2 of the semantic ladder. ALWAYS wired (the port is a pure closure — no IO until a
    // conflict actually invokes it), and gated per-conflict by the `semanticResolution` flag read live in
    // climbSemanticLadder. Same shape as the gate runner above: wiring is free, the flag decides.
    judge: makeJudgePort({ claudeBin: resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin }), exec: defaultExec, repoRoot: findRepoRoot() }),
    // Repo-backed terminal-card check for recover()'s prune (drops merge entries for finished cards).
    // Reads the board's terminal columns once, then the card's current status. Best-effort: any read
    // error resolves to false (keep the entry) so a transient fs hiccup never drops live work.
    isCardTerminal: async (board, cardId) => {
      const [boardCfg, cards] = await Promise.all([readBoardConfig(board), readCards(board)]);
      const terminalStatuses = terminalStatusIds(boardCfg); // single derivation (incl. legacy last-column fallback)
      const card = cards.find((c) => c.id === cardId);
      return !!card?.status && terminalStatuses.has(card.status);
    },
  });
  // Bridge every change into the registry so the runner snapshot + the dedicated SSE
  // `merge-queue` event reflect the queue live (the ops panel consumes it).
  mq.subscribe((snap) => getRunnerRegistry().updateMergeQueue(snap));
  store[KEY] = mq;
  return mq;
}
