// Periodic recovery sweep (story-harness-cc HALF #6).
//
// WHY this exists — `recoverInterruptedRuns` (recovery.ts) only runs ONCE, at boot
// (instrumentation.ts). But a run can be left "running" in the journal LONG after boot: a max-turns
// in-process resume that the rate-limit/in-flight race REJECTS just logs "retomável no próximo boot"
// (engine.ts) and the entry sits resumable+running until the next restart. The AgileHarness service is a
// long-lived systemd unit the never-kill guardrail discourages restarting — so "next boot" can be days
// away. This module re-runs the SAME recovery on an interval so an orphaned resumable run is picked up
// in minutes, not on the next restart.
//
// SAFETY — the sweep is GATED on idleness (`isIdle`): it skips a tick while the merge train has live
// entries OR the engine has any run in flight. That keeps it from (a) fighting the serial merge train
// and (b) running reconcileWorktrees (a git subprocess inside recoverInterruptedRuns) needlessly while
// work is active. recoverInterruptedRuns is itself safe to re-run (runSkill self-protects via
// maxConcurrent + rate-limit + the in-flight lock); the gate is an optimization, not the safety net.
//
// Pure + DI-friendly: `runRecoverySweepTick` is awaitable and stub-driven (no real timer); the timer
// wiring (`startRecoverySweep`) is a thin re-arming setTimeout so a tick can never overlap itself.

/** Default sweep cadence (10 min). Env-tunable via USM_AUTORUN_RECOVERY_SWEEP_MS; <=0 disables the sweep. */
export const RECOVERY_SWEEP_DEFAULT_MS = 10 * 60_000;

/** Resolve the sweep interval from the env. Returns 0 (disabled) for an explicit 0 / negative / a
 *  non-finite value other than unset (unset ⇒ the default). Pure — exported for tests. */
export function recoverySweepIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.USM_AUTORUN_RECOVERY_SWEEP_MS;
  if (raw == null || raw === "") return RECOVERY_SWEEP_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0; // explicit disable / garbage → off
  return Math.floor(n);
}

export type SweepStatus = "ran" | "ran-starved" | "skipped-busy" | "skipped-disabled" | "error";

/**
 * How many CONSECUTIVE busy-skips before the sweep runs anyway (~1h at the 10min cadence).
 *
 * The idle gate is an OPTIMIZATION, not a safety net (see the header) — recovery self-protects via
 * maxConcurrent + the rate limit + the in-flight lock. Treating an optimization as a precondition is what
 * turned it into a LIVELOCK: a run stranded in the queue keeps `isIdle` false forever, and the sweep it
 * blocks is the ONE thing that recovers stranded runs. The orphan blocked its own rescuer, for 5h+, while
 * the log dutifully counted the skips ("PULADO 6x seguidas"). Anything that waits on a condition another
 * party must clear needs an escape when that party is the thing that is stuck.
 */
export const SWEEP_BUSY_STARVATION_TICKS = 6;

/**
 * Should this tick run even though the box says "busy"? PURE — the caller owns the streak counter.
 * `busySkips` is the number of consecutive skips BEFORE this tick. Never starves: the escape fires on the
 * tick that would be the (limit+1)-th consecutive skip.
 */
export function shouldRunDespiteBusy(busySkips: number, limit: number = SWEEP_BUSY_STARVATION_TICKS): boolean {
  return busySkips >= limit;
}

export interface SweepTickDeps {
  /** autorun + resumeOnBoot — re-read each tick so a settings change takes effect without a restart. */
  enabled: boolean;
  /** false ⇒ work is in flight (merge train live OR engine has a run) → skip this tick. */
  isIdle: () => Promise<boolean> | boolean;
  /** Consecutive busy-skips BEFORE this tick (the caller owns the counter — it already tracks it to alarm
   *  on the streak). Past {@link SWEEP_BUSY_STARVATION_TICKS} the tick stops deferring. Absent ⇒ 0 ⇒ the
   *  pre-fix behavior (defer forever), so a caller that doesn't count is unchanged. */
  busySkips?: number;
  /** Override the starvation limit (tests). */
  starvationLimit?: number;
  /** build the deps + call recoverInterruptedRuns (the SAME recovery the boot path runs). */
  runRecovery: () => Promise<unknown>;
  /** WS1.6 — optional idle-gated branch GC (harvest proven-integrated preserved run branches). Best-effort:
   *  its own failure never fails the tick (recovery already succeeded). */
  runBranchGc?: () => Promise<unknown>;
  /** RECONCILIAÇÃO de deploy-failure (deploy-reconcile.ts): retira o alarme dos cards cujo código já está
   *  provadamente publicado. Precisa ser PERIÓDICO — e não só reativo ao settle — porque a publicação pode
   *  acontecer FORA do serviço (`just orch-deploy` no shell não passa pelo registry, logo não emite onDone).
   *  Foi exatamente esse caminho que deixou 2 cards do acme travados por 5 dias com o código no ar.
   *  Best-effort: sua falha nunca rebaixa um tick de recovery bem-sucedido. */
  runDeployReconcile?: () => Promise<unknown>;
  /** autonomo-liberdade-humana M2 — optional idle-gated trash GC (prune soft-deleted board data older than 7d).
   *  Board-data fs ops only (no git), best-effort: its failure never demotes a successful recovery tick. */
  runTrashGc?: () => Promise<unknown>;
  /** session GC (session-gc.ts) — deregister the fleet rows of long-dead sessions with nothing to lose (the
   *  adopted zombies the worktree reaper could never reach). Fail-closed selection; idle-gated with the rest
   *  (discard may touch git for an isolated tree); best-effort — its failure never demotes a recovery tick. */
  runSessionGc?: () => Promise<unknown>;
  /**
   * P-3 — a VARREDURA DA CABEÇA DO TRAIN, e a ÚNICA que roda ANTES do portão de ociosidade.
   *
   * A ordem não é detalhe: uma entrada travada em `merging` é justamente o que faz `isIdle` responder
   * `false`, então rodá-la depois do portão seria a mesma livelock que a fuga por inanição
   * ({@link SWEEP_BUSY_STARVATION_TICKS}) existe para quebrar — quem espera uma condição que OUTRO
   * precisa limpar precisa de uma saída quando esse outro é o que está travado. Aqui a saída é medir a
   * cabeça primeiro.
   *
   * É segura de rodar com o sistema ocupado porque ela não faz IO de git: lê o estado da fila, e só age
   * quando o processador comprovadamente morreu (ver `MergeQueuePort.sweepStuck`). Best-effort: sua
   * falha nunca impede o resto do tick.
   */
  sweepStuckEntries?: () => Promise<unknown>;
  /**
   * P-3b — RE-CUTUCA a fila do train quando ela parou com trabalho dentro. Roda junto de
   * {@link sweepStuckEntries}, ANTES do portão, e pelo MESMO motivo: uma fila parada com entradas
   * `waiting` é trabalho que ninguém vai buscar.
   *
   * O laço do train só é bombeado por EVENTO — enqueue, resolve de conflito/gate, recover de boot, e a
   * varredura da cabeça. Não existia tick nenhum. Quando o clean-gate parqueia a cabeça por árvore suja
   * ele dá `break` na FIFO inteira, e as entradas atrás ficam `waiting` até alguém enfileirar outra coisa
   * ou resolver a parqueada NA MÃO — mesmo depois de a árvore ter limpado sozinha. Quem esperava era uma
   * sessão que já tinha submetido, sem nenhuma superfície dizendo que ninguém viria.
   *
   * É in-memory e idempotente (o laço tem guarda de reentrância), então um tick sem trabalho é no-op.
   */
  pumpMergeQueue?: () => Promise<unknown>;
  /** P-9 — poda de reservas vencidas (`claims.sweepExpired`). Não faz git; roda com o resto. A poda já
   *  existia, mas só era chamada pelo reconciliador da FROTA, que depende de tmux — então uma reserva de
   *  sessão sem tmux ficava viva para sempre (medido: 58 de 58 claims expirados, zero podas). */
  runClaimsGc?: () => Promise<unknown>;
  /** P-9 — recolhe as árvores `gate-*`/`run-*` sem dono (worktree-gc.ts). Toca git ⇒ mesma janela ociosa
   *  das demais; fail-closed (nunca `agent-*`, nunca árvore suja). */
  runWorktreeGc?: () => Promise<unknown>;
}

/**
 * Run ONE sweep tick: skip when disabled or busy, else run recovery. Never throws (a recovery error is
 * swallowed into "error" so the re-arming timer keeps going). Pure control-flow — unit-tested directly.
 */
export async function runRecoverySweepTick(deps: SweepTickDeps): Promise<SweepStatus> {
  if (!deps.enabled) return "skipped-disabled";
  try {
    // P-3 — ANTES do portão, sempre: a cabeça travada é o que fecha o portão. Ver o doc da dep.
    if (deps.sweepStuckEntries) await deps.sweepStuckEntries().catch(() => {});
    // P-3b — e, logo depois, re-cutuca a fila: destravar a cabeça sem bombear o laço só troca uma fila
    // parada por outra. Mesma janela, mesmo motivo (ver o doc da dep).
    if (deps.pumpMergeQueue) await deps.pumpMergeQueue().catch(() => {});
    let starved = false;
    if (!(await deps.isIdle())) {
      // Busy — normally skip. But if we have skipped this many times in a row, the "busy" we are deferring
      // to may BE the stuck work we exist to recover, so defer no longer (see SWEEP_BUSY_STARVATION_TICKS).
      if (!shouldRunDespiteBusy(deps.busySkips ?? 0, deps.starvationLimit)) return "skipped-busy";
      starved = true;
    }
    await deps.runRecovery();
    // The STARVATION escape runs recovery ONLY. The two piggybacks below are the ones the header calls
    // "git subprocesses that must not fight the train" — and unlike recovery they are not what the
    // livelock is starving, so there is no reason to buy their contention risk while the box is busy.
    // They resume on the next genuinely idle tick, which the escape has just made reachable again.
    if (starved) return "ran-starved";
    // WS1.6 — piggyback the branch GC on the SAME idle window (git subprocesses that must not fight the
    // train). Best-effort: a GC error never demotes a successful recovery tick.
    if (deps.runBranchGc) await deps.runBranchGc().catch(() => {});
    // Mesma janela ociosa, mesmo motivo (git subprocesses fora do caminho do train): reconcilia os
    // deploy-failure contra a realidade publicada. Best-effort — nunca rebaixa um recovery bem-sucedido.
    if (deps.runDeployReconcile) await deps.runDeployReconcile().catch(() => {});
    // M2 — same idle window: prune the soft-delete trash past its 7-day window. Board-data only (no git), so it
    // can't fight the train; best-effort — a GC error never demotes a successful recovery tick.
    if (deps.runTrashGc) await deps.runTrashGc().catch(() => {});
    // Same idle window: forget the fleet rows of long-dead sessions (discard may prune an isolated tree, so it
    // rides the train-idle gate). Best-effort — a GC error never demotes a successful recovery tick.
    if (deps.runSessionGc) await deps.runSessionGc().catch(() => {});
    // P-9 — as duas varreduras de lixo que faltavam. Best-effort como as irmãs: nenhuma falha delas
    // rebaixa um tick de recovery bem-sucedido.
    if (deps.runClaimsGc) await deps.runClaimsGc().catch(() => {});
    if (deps.runWorktreeGc) await deps.runWorktreeGc().catch(() => {});
    return "ran";
  } catch {
    return "error";
  }
}

export interface SweepTimer {
  unref?: () => void;
}

export interface StartSweepOpts {
  intervalMs: number;
  /** the work of one tick (typically `() => runRecoverySweepTick(...)`). */
  tick: () => Promise<unknown>;
  /** DI seam for tests — defaults to global setTimeout. Returns a handle with an optional unref(). */
  setTimer?: (fn: () => void, ms: number) => SweepTimer;
  clearTimer?: (handle: SweepTimer) => void;
}

/**
 * Arm a RE-ARMING timer (not setInterval) so a slow tick can never overlap the next one: each tick
 * runs, then schedules the following one in its `finally`. `.unref()` so the timer never keeps the
 * process alive. intervalMs <= 0 ⇒ no-op (sweep disabled). Returns a stop() that cancels the loop.
 */
export function startRecoverySweep(opts: StartSweepOpts): () => void {
  if (opts.intervalMs <= 0) return () => {};
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as SweepTimer);
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  let stopped = false;
  let handle: SweepTimer | undefined;
  const arm = () => {
    if (stopped) return;
    handle = setTimer(() => {
      void opts.tick().catch(() => {}).finally(arm);
    }, opts.intervalMs);
    handle?.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    if (handle) clearTimer(handle);
  };
}
