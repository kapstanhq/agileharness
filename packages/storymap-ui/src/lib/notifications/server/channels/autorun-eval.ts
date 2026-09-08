// Autorun evaluation kernel — the SIDE-EFFECTFUL shell of the pipeline cascade,
// extracted from trigger-runner-channel.ts so EVERY path that lands a card in a status
// can trigger autorun through ONE codepath:
//   - the fs-watcher path     → a card.moved / card.created event (an open SSE tab +
//     a recursive fs.watch delivering the change);
//   - the server-action path   → moveCardAction just wrote a new status, in-process
//     (the SAME action a UI drag AND an MCP move_card call funnel through);
//   - the run-completion path   → a run settled and may have advanced its card.
//
// Before this extraction the logic lived as a closure inside the channel, reachable
// ONLY via the watcher — so a drag/MCP move the watcher missed (no open tab, or a
// dropped fs.watch event) never started a run; the cascade was reliable precisely
// because engine.onComplete calls evaluate in-process, NOT through the watcher. The fix
// (story-pqd7gs) gives moveCardAction the same in-process trigger by calling this helper
// directly. The engine's dedupe window (AUTORUN_DEDUPE_MS) + per-card in-flight lock
// collapse the watcher's (possibly duplicate) echo of the same move into a single run.
//
// The RUN / FORWARD / STOP decision itself stays PURE in cascade-decision.ts; this
// module owns the live master-switch read, the fs reads of board + card, the
// engine.runSkill spawn and the writeCard forward (re-entrant dedup-guarded).

import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { resolveStaleQuestions } from "@/lib/storymap/questions";
import { AUTORUN_DEDUPE_MS, getRunnerEngine, isCodeSkill } from "@/lib/storymap/runner/engine";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getTelemetryStore } from "@/lib/storymap/runner/telemetry";
import { supersedeStaleTerminalBlockers, withCardBudgetFinding, withLoopGuardFinding } from "@/lib/storymap/runner/findings";
import { ECONOMY_BLOCKED_AUTORUN_TRIGGERS, loadRunnerConfig } from "@/lib/storymap/runner/config";
import { resolveHeadroomUrl } from "@/lib/storymap/runner/headroom";
import { entryEffect } from "@/lib/storymap/entry-effect";
import { appendTransition, type TransitionActor } from "@/lib/storymap/runner/transitions";
import { runEntryEffect } from "@/lib/storymap/runner/entry-effects";
import { getPendingEffects } from "@/lib/storymap/runner/pending-effects";
import { decideCascade } from "./cascade-decision";
import { isAmbiguousRouting } from "@/lib/storymap/skip-routing";
import type { BoardConfig, Card, StatusDef, TriggerId } from "@/lib/storymap/types";

// `${board}/${id}` currently mid-forward — module-global so the watcher path and the
// server-action path share ONE dedup set (this module loads once per process, like the
// engine singleton it drives).
const forwarding = new Set<string>();

/**
 * Session threading (the "one agent, many hats" theme — e.g. Discovery: Especificar →
 * Entrevista → Estimar). When a run COMPLETES and the cascade decides to run the NEXT step
 * IN THE SAME column, and that column opts in via `threadSession: true`, the next spawn
 * REUSES the just-finished run's `claude` session (`--resume <sessionId>`) instead of a
 * fresh one — so the agent keeps its context + reasoning across the steps and the warm
 * prompt-cache makes the continuation cheap. PURE policy (no spawn) so it stays testable.
 *
 * Guards (ALL required): the call is a run-completion re-eval (`suppressTrigger` set — i.e.
 * back-to-back, cache warm; a fs-watcher/manual/first entry has none → fresh session); the
 * prior step (the one that just finished) and the next step share the column; the column
 * declares `threadSession`; both use the SAME model (a model switch voids the cache + a
 * single session can't change model mid-thread); NEITHER is a code skill (those run in an
 * isolated worktree the resume can't rejoin from repo root). A human gate between steps
 * never reaches here — the cascade STOPS at it, so no resume ever crosses an approval.
 */
export function threadResumeSessionId(
  boardId: string,
  cardId: string,
  config: BoardConfig,
  nextStatus: StatusDef,
  nextTrigger: TriggerId,
  suppressTrigger: TriggerId | undefined,
  // WS-8.3: the card's MOST-RECENT run ended `cancelled`. A cancel is the operator saying "I do NOT want that
  // context continuing" — so NEVER re-seed the dead session; a fresh session is minted when the cascade
  // legitimately resumes. Default false ⇒ legacy behaviour (the callers that don't pass it are unaffected).
  lastRunCancelled = false,
): string | undefined {
  if (!suppressTrigger) return undefined;
  const column = config.columns?.find((c) => c.id === nextStatus.column);
  if (!column?.threadSession) return undefined;
  const prior = config.statuses.find((s) => s.trigger === suppressTrigger);
  if (!prior || prior.column !== nextStatus.column) return undefined;
  if ((prior.model ?? null) !== (nextStatus.model ?? null)) return undefined;
  if (isCodeSkill(suppressTrigger) || isCodeSkill(nextTrigger)) return undefined;
  if (lastRunCancelled) return undefined; // WS-8.3 — don't thread a session the operator cancelled
  return getRunnerRegistry().lastSessionId(boardId, cardId);
}

// Forward a card to the next pipeline status (the cascade bridge). The RUN/FORWARD/STOP
// + next-status/gate/terminal decision is pure (decideCascade); here we only perform the
// resolved write, dedup-guarded against a concurrent forward of the same card.
async function forward(board: string, card: Card, toStatusId: string, config: BoardConfig, actorOverride?: TransitionActor): Promise<void> {
  const key = `${board}/${card.id}`;
  if (forwarding.has(key)) return;
  forwarding.add(key);
  try {
    // audit (unlocked-write class): apply ONLY the status delta to the FRESHLY-read card under the
    // per-card lock, instead of blind-writing the stale in-memory snapshot — a harness-* agent (or any
    // writer) touching this card's content in the read→write window is no longer clobbered.
    // HITL: forwarding INTO a terminal column resolves any still-open questions as stale — the auto-
    // cascade shipped the card without the human answer, so they must not strand as "precisa de você"
    // on a concluded card (orphan-questions bug; same rule as moveCardAction).
    const intoTerminal = !!config.statuses.find((s) => s.id === toStatusId)?.terminal;
    const written = await updateCardOnDisk(board, card.id, (fresh) => {
      // Anti-clobber: decideCascade chose toStatusId from a card read OUTSIDE this lock. If another writer
      // re-routed the card in the read→write window — e.g. a fast deploy-failure revert reopened a card in
      // the optimistic `deploy` step to `desenvolver` (mode:fix) — our toStatusId is STALE; blindly applying
      // it would clobber that reopen (the card would jump to `concluida` while still carrying reopenPending/
      // mode:fix). When the on-disk status no longer matches what we decided from, ABORT — the writer that
      // moved the card wins, and the cascade re-evaluates from its new status on the next entry.
      if (fresh.status !== card.status) return null;
      // Entrar num terminal supersede os MECHANISM blockers residuais (code/data-not-landed, merge-back) além
      // de stale as perguntas — mesma régua do move manual e do settle de deploy. Sem isto o card fica com o
      // selo "Bloqueio" para sempre (um terminal nunca re-integra → withRunBlockersResolved nunca dispara).
      const terminalStamp = { by: `terminal:${toStatusId}`, at: new Date().toISOString().slice(0, 10) };
      const superseded = intoTerminal ? supersedeStaleTerminalBlockers(fresh.findings ?? [], terminalStamp) : null;
      return {
        ...fresh,
        status: toStatusId,
        questions: intoTerminal ? resolveStaleQuestions(fresh.questions ?? [], terminalStamp.at) : fresh.questions,
        ...(superseded ? { findings: superseded } : {}),
      };
    });
    if (!written) {
      console.log(`[harness-autorun forward ${key}] abortado — card saiu de ${card.status} sob o lock (re-roteado por outro writer); cascata re-avalia do novo status`);
      return;
    }
    console.log(`[harness-autorun forward ${key}] ${card.status} → ${toStatusId}`);
    // WS2 — record the automation transition (AFTER the write succeeded, still under the forwarding lock).
    // actor: an explicit override (the merge-back cascade → "merge") wins; else "system" when the SOURCE
    // step auto-enters terminal (the optimistic deploy→concluida), else the default "cascade".
    const sourceAutoTerminal = !!config.statuses.find((s) => s.id === card.status)?.autoEnterTerminal;
    void appendTransition({
      board,
      cardId: card.id,
      from: card.status,
      to: toStatusId,
      actor: actorOverride ?? (sourceAutoTerminal ? "system" : "cascade"),
    });
    // B3: forwarding INTO a step that declares an `onEnter` effect must FIRE it — the SAME effect the
    // human-move path (moveCardAction) fires. Without this the auto-cascade would advance a card PAST
    // `release` (promote-stage: code stage→main) without ever promoting. `release` is autorun:false, so
    // the cascade RESTS there after promoting and NEVER auto-forwards into `deploy` — deploy-board (the
    // self-deploy/restart) only ever fires on a human drag into Publicar. Best-effort: a failed effect
    // logs and never breaks the forward (idempotent + retriable on the next entry).
    // entryEffect(toStatus=DESTINO, prevStatus=ORIGEM) — a ordem importa: ele resolve o onEnter
    // do DESTINO. Estava invertido (card.status, toStatusId) → buscava o onEnter da ORIGEM, então
    // promote-stage/deploy-board NUNCA disparavam no forward automático (só no human-move/harness,
    // que já chamam na ordem certa). Bug: o release auto-cascateado não promovia stage→main.
    const effect = entryEffect(config, toStatusId, card.status);
    if (effect) {
      // story-harness-adk A5: the status is now durably advanced on disk, but runEntryEffect fires
      // FIRE-AND-FORGET — a crash before it completes leaves the card advanced while promote/deploy never
      // ran (and crash recovery NEVER re-fires an onEnter; it only respawns the skill / drops). Record the
      // pending effect DURABLY (flushed to disk BEFORE the fire) and resolve it on success, so boot recovery
      // (recoverPendingEffects) re-fires an unresolved one. The effects are idempotent → a re-fire is safe.
      const pending = getPendingEffects();
      await pending.record({ board, cardId: card.id, effect, status: toStatusId, recordedAt: Date.now() });
      await pending.flush(); // durability point: the entry is on disk before the (possibly long) effect runs
      void runEntryEffect(effect, board, card.id)
        .then(() => pending.resolve(board, card.id, effect))
        .catch((err) =>
          // A best-effort effect that THREW (rare — effects swallow their own errors): leave the entry
          // pending so boot recovery retries it; never break the forward.
          console.error(`[harness-autorun forward ${key}] onEnter ${effect} falhou:`, err instanceof Error ? err.message : err),
        );
    }
  } catch (err) {
    console.error(`[harness-autorun forward ${key}] failed:`, err instanceof Error ? err.message : err);
  } finally {
    forwarding.delete(key);
  }
}

/** The durable "last run" facts the loop-guard reads (a projection of the journal entry via
 * {@link getRunnerEngine}().lastRun). Kept structural so {@link nextNoProgressCount} is pure/engine-free. */
export interface PriorRunFacts {
  column?: string;
  noProgressRuns?: number;
  trigger?: TriggerId;
}

/**
 * ADR-063 (4b) — PURE: the next MONOTONIC same-column-no-progress count for a fresh cascade eval. If the
 * card is STILL in the same status the last run of THIS trigger processed (no column advance ⇒ no
 * progress), increment the prior counter; ANY status change OR a different trigger RESETS it to 0 (the
 * card progressed, or a different kind of work started — e.g. a manual run stamps no column, so its next
 * eval resets, which is the natural override). Exported so the guard's arithmetic is unit-testable
 * without wiring the engine + journal.
 */
export function nextNoProgressCount(
  prior: PriorRunFacts | undefined,
  status: string,
  trigger: TriggerId,
): number {
  if (prior && prior.column === status && prior.trigger === trigger) {
    return (prior.noProgressRuns ?? 0) + 1;
  }
  return 0;
}

/** Options for {@link evaluateAutorunOnEntry}. */
export interface EvaluateAutorunOpts {
  /**
   * The skill that JUST finished, when re-evaluating on run-completion. If the card is
   * still resting in a column whose trigger equals it (the run did NOT advance it), STOP
   * instead of re-firing the same skill (the loop guard). Omitted on the watcher and the
   * server-action entry paths.
   */
  suppressTrigger?: TriggerId;
  /** WS2 — attribute the ledger transition this cascade produces to a specific actor (e.g. "merge" when
   *  fired by the merge-back onMergeDone). Default: "cascade" (or "system" for an auto-enter-terminal). */
  transitionActor?: TransitionActor;
}

/**
 * Evaluate the autorun cascade for a card sitting in its CURRENT (on-disk) status and
 * ACT on the decision — run the column's skill, forward past a gated landing, or stop.
 *
 * Best-effort + idempotent: it honors the LIVE master switch (settings.yaml enabled:false
 * OR USM_AUTORUN=0), reads the card fresh from disk, and the engine's dedupe window
 * (AUTORUN_DEDUPE_MS) + per-card in-flight lock collapse a duplicate fire (e.g. the watcher
 * echoing the same move this call already handled) into a single run. Safe to call from a
 * server action without awaiting completion — it never throws into the caller's happy path.
 */
export async function evaluateAutorunOnEntry(
  boardId: string,
  cardId: string,
  opts: EvaluateAutorunOpts = {},
): Promise<void> {
  // Master switch, evaluated LIVE (settings.yaml enabled:false OR USM_AUTORUN=0).
  const runnerConfig = loadRunnerConfig();
  if (!runnerConfig.autorun.enabled) return;

  const config = await readBoardConfig(boardId).catch(() => null);
  if (!config) return;
  // story-fr5bnt: PER-BOARD autorun kill-switch. A board flagged `autorunDisabled` (e.g. `storymap` —
  // the tool's OWN board, where the operator rule is ALWAYS a manual guided session, never the autonomous
  // pipeline refactoring the tool itself) NEVER auto-fires a skill on move/accept/cascade. This is the
  // SINGLE chokepoint every autorun path funnels through (in-process cascade, the fs-watcher dispatcher,
  // post-merge re-eval, recovery), so gating here disables autorun board-wide regardless of entry point.
  // A human still runs skills EXPLICITLY via run_skill/enqueue → runCardSkillAction/engine.runSkill, which
  // do NOT pass through this function, so the manual guided session is unaffected. Distinct from the LIVE
  // master switch above (global): this is scoped to one board, and it is read PER-BOARD (after the config).
  if (config.autorunDisabled) {
    console.log(
      `[harness-autorun ${boardId}/${cardId}] autorun desabilitado para o board '${boardId}' (autorunDisabled) — nenhuma skill disparada (rode manualmente via run_skill)`,
    );
    return;
  }
  // Read the card from disk = source of truth for its CURRENT status (events don't carry
  // the raw status id; the completion path has only board/card).
  const cards = await readCards(boardId).catch(() => null);
  const card = cards?.find((c) => c.id === cardId);
  if (!card) return;

  // WS-8.1 — the cancel PHASE-BRAKE. If the operator just cancelled THIS card, do NOT re-engage the cascade
  // (this ONE chokepoint covers BOTH the run-completion threading path AND the fs-watch path). Without it the
  // cancelled run's own settle→cascade and the fs-watch of its status-advance write re-spawn the next threaded
  // step ~0,4s later — the story-f6rr4p whack-a-mole (two cancels for one intent). The brake self-releases on
  // the TTL, on a human MOVE (the card's status changes → engine drops the marker), or on an explicit
  // retry/enqueue (engine.clearRecentlyCancelled). Read the brake against the card's CURRENT on-disk status so
  // a move already clears it here.
  // Optional-chained: a test double / partial engine mock without this method degrades to "not braked"
  // (the brake is best-effort, in-memory); the real RunnerEngine always exposes it, so prod is unchanged.
  const brakeAgeMs = getRunnerEngine().recentlyCancelledAgeMs?.(boardId, cardId, card.status) ?? null;
  if (brakeAgeMs != null) {
    const line = `cascata pausada — card cancelado pelo operador há ${Math.round(brakeAgeMs / 1000)}s; mova o card ou re-enfileire para retomar`;
    console.log(`[harness-autorun ${boardId}/${cardId}] ${line}`);
    getRunnerRegistry().appendLog(boardId, cardId, "system", `⏸ ${line}`);
    return;
  }

  // Observability for the AMBIGUOUS routing seam: a mixed-kind refine (visual + non-visual) is the
  // one case the deterministic rules can't settle — it warrants the light agent (harness-refine)
  // precomputing `card.routing`. When such a card has NO persisted routing decision yet, the pure
  // kernel falls back to the conservative default (KEEP the design block), which is safe but may run a
  // wireframe step the work didn't need. Surface it so an operator/agent can see the agent verdict is
  // pending and the fallback is in effect. Pure read, never blocks/alters the RUN/FORWARD/STOP decision.
  if (isAmbiguousRouting(card) && !card.routing) {
    console.log(
      `[harness-autorun ${boardId}/${cardId}] routing ambíguo (refine kinds visual+não-visual) sem decisão persistida — fallback conservador (mantém design block); aguardando verdict do harness-refine`,
    );
  }

  const decision = decideCascade(card, config, { suppressTrigger: opts.suppressTrigger });
  if (decision.action === "run") {
    // Economy mode: skip autorun for heavy triggers (harness-refine, harness-fix) — user runs them manually.
    if (runnerConfig.economyMode && ECONOMY_BLOCKED_AUTORUN_TRIGGERS.includes(decision.trigger)) {
      console.log(`[harness-autorun ${boardId}/${cardId}] economy mode — autorun skipped for ${decision.trigger}`);
      return;
    }
    const status = config.statuses.find((s) => s.id === card.status)!;

    // ADR-063 (4a) — OPT-IN per-card lifetime $ backstop. DEFAULT OFF (cardBudgetUSD undefined) ⇒ inert
    // (no telemetry read, no behaviour change). When set, sum this card's telemetry `costUSD` across ALL
    // its runs; once it reaches the ceiling, STOP (never spawn) + write an idempotent operator finding
    // (null-guarded so the card write can't loop the fs-watcher). The telemetry read is wrapped so a read
    // failure NEVER throws into the cascade (fail-open: a broken ledger must not block autorun). Runs BEFORE
    // the 4b loop-guard (spec-permitted) — a card over budget is stopped regardless of its progress state.
    const cardBudgetUSD = runnerConfig.autorun.cardBudgetUSD;
    if (typeof cardBudgetUSD === "number" && cardBudgetUSD > 0) {
      try {
        const records = await getTelemetryStore().listByCard(boardId, card.id);
        const spent = records.reduce((s, r) => s + (r.costUSD ?? 0), 0);
        if (spent >= cardBudgetUSD) {
          await updateCardOnDisk(boardId, card.id, (fresh) => {
            const next = withCardBudgetFinding(fresh.findings ?? [], card.id, spent, cardBudgetUSD, records.length);
            return next ? { ...fresh, findings: next } : null; // null ⇒ finding unchanged ⇒ no write (loop-safe)
          });
          console.log(
            `[harness-autorun ${boardId}/${cardId}] budget do card estourado ($${spent.toFixed(2)} ≥ $${cardBudgetUSD}) — autorun pausado`,
          );
          return;
        }
      } catch (err) {
        console.error(
          `[harness-autorun ${boardId}/${cardId}] leitura de telemetria (budget) falhou:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ADR-063 (4b) — DURABLE same-column-no-progress loop-guard. Read the card's LAST run from the journal
    // (survives a restart, unlike the in-memory registry) and compute the next monotonic no-progress count:
    // still resting in the SAME status the last run of THIS trigger processed ⇒ +1, else reset to 0. Once it
    // reaches the cap (> 0 = enabled), STOP (never spawn) + write an idempotent operator finding (null-
    // guarded — a card write re-triggers the watcher, so a non-null write on every re-eval would loop
    // forever). NOTE the anti-over-count invariant: recordStart fires once per ACTUAL spawn (a deduped/
    // rejected eval never recordStarts), so `prior` reflects the last REAL run — the count lives only here.
    const prior = await getRunnerEngine().lastRun(boardId, card.id);
    const nextNoProgress = nextNoProgressCount(prior, status.id, decision.trigger);
    const noProgressMax = runnerConfig.autorun.noProgressMax;
    if (noProgressMax > 0 && nextNoProgress >= noProgressMax) {
      await updateCardOnDisk(boardId, card.id, (fresh) => {
        const next = withLoopGuardFinding(fresh.findings ?? [], card.id, status.id, nextNoProgress);
        return next ? { ...fresh, findings: next } : null; // null ⇒ finding unchanged ⇒ no write (loop-safe)
      });
      console.log(
        `[harness-autorun ${boardId}/${cardId}] loop-guard acionado — ${nextNoProgress} run(s) sem avançar em '${status.id}' (cap ${noProgressMax}); autorun pausado`,
      );
      return;
    }

    // WS-8.3 — was the card's MOST-RECENT run cancelled? Only relevant when threading (suppressTrigger set),
    // so the telemetry read is scoped to that path. A cancelled last run means don't re-seed the dead session.
    let lastRunCancelled = false;
    if (opts.suppressTrigger) {
      const recent = await getTelemetryStore().listByCard(boardId, card.id, 1).catch(() => []);
      lastRunCancelled = recent[0]?.status === "cancelled";
    }
    // Session threading (one-agent-many-hats): a same-column autorun continuation of a
    // `threadSession` column resumes the prior step's claude session instead of a fresh one.
    const resumeSessionId = threadResumeSessionId(
      boardId,
      card.id,
      config,
      status,
      decision.trigger,
      opts.suppressTrigger,
      lastRunCancelled,
    );
    // Autorun passes the dedupe window so a double-fired / rename-echoed event — or the
    // watcher's card.moved racing this server-action-driven eval — can't double-spawn the
    // same skill (manual "Rodar agora" omits it). The per-card in-flight lock backs this up.
    getRunnerEngine().runSkill(boardId, card.id, decision.trigger, status, {
      dedupeWindowMs: AUTORUN_DEDUPE_MS,
      // Route this run's Anthropic traffic through the headroom compression proxy when the board
      // enables it (board.yaml headroom.enabled) / STORYMAP_HEADROOM_URL is set. Resolved HERE
      // because the engine has no BoardConfig in scope — without this the proxy is never injected.
      headroomUrl: resolveHeadroomUrl(config, process.env),
      // Reuse the theme's session when the column threads it (Discovery), else a fresh id.
      ...(resumeSessionId ? { resumeSessionId } : {}),
      // ADR-063 (4b): stamp the loop-guard column + monotonic no-progress count so recordStart persists
      // them on the journal entry — the next fresh eval reads them back (durable, survives restart).
      column: status.id,
      noProgressRuns: nextNoProgress,
    });
  } else if (decision.action === "forward") {
    await forward(boardId, card, decision.to, config, opts.transitionActor);
    // audit (forward-fs-watch-only): re-evaluate the cascade IN-PROCESS for the forwarded status,
    // instead of relying solely on the fs.watcher to detect the write — mirrors the run-completion
    // (onComplete) and moveCardAction paths, so a forwarded card never strands if the watcher event
    // is lost (e.g. a restart in the debounce window re-seeds the snapshot at the forwarded status →
    // no diff → no card.moved). It re-reads from disk (source of truth → sees `decision.to`). Bounded:
    // decideForward is monotonic (one skip→run hop in the canonical pipeline), the `forwarding` set
    // guards a re-entrant forward, and the engine's dedupe window + in-flight lock collapse this
    // in-process spawn and the watcher's later echo into ONE run. Fire-and-forget (never blocks).
    void evaluateAutorunOnEntry(boardId, cardId, {}).catch((err) =>
      console.error(`[harness-autorun forward-retrigger ${boardId}/${cardId}]`, err instanceof Error ? err.message : err),
    );
  } else if (decision.reason === "manual") {
    console.log(`[harness-autorun ${boardId}/${cardId}] autorun:false em '${card.status}' — skip`);
  } else if (decision.reason.startsWith("gate:")) {
    console.log(`[harness-autorun ${boardId}/${cardId}] forward bloqueado — ${decision.reason}`);
  }
}
