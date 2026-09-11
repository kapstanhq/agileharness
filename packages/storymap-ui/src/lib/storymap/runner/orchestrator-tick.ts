// orchestrator-tick.ts — WS8 (F7) — the in-process TICK that makes the board copiloto AUTONOMOUS. Modeled
// exactly on recovery-sweep.ts: a pure, DI-driven decision (`runOrchestratorTick`) + a thin re-arming timer
// (`startOrchestratorTick`) so a slow tick never overlaps itself and the timer never keeps the process alive.
//
// The DECISION is deterministic and ZERO-TOKEN: the copiloto's LLM (`/harness-orchestrator`) is spawned for
// a board ONLY when a cheap pre-check says there is work (the human inbox has items / a card is stagnant / a
// temporal demand fired) AND the board is `autonomous` AND no paired human holds the lease AND the daily
// budget isn't spent. Every gate that fails SKIPS the spawn — so an idle board costs nothing. OFF by default
// (settings.orchestrator.enabled=false ⇒ the whole tick is a no-op), byte-identical to no Jido.

import type { OrchestratorMode } from "@/lib/storymap/types";

/** Per-board outcome of a tick, for logs/tests. `ran` = the copiloto was spawned. */
export type OrchestratorTickStatus =
  | "ran"
  | "skipped-not-autonomous"
  | "skipped-leased"
  | "skipped-running"
  | "skipped-budget"
  | "skipped-no-work"
  | "skipped-backoff"
  | "skipped-spawn-failed"
  | "skipped-spawn-broken"
  | "error";

/** One active board the tick considers: its id + its declared mode (off boards are pre-filtered out). */
export interface ActiveBoard {
  board: string;
  mode: OrchestratorMode;
}

export interface OrchestratorTickDeps {
  /** settings.orchestrator.enabled — re-read each tick so a settings toggle takes effect without a restart. */
  enabled: boolean;
  /** boards whose orchestrator.mode is `paired` or `autonomous` (mode:off already excluded). */
  activeBoards: () => Promise<ActiveBoard[]> | ActiveBoard[];
  /** a paired human session currently holds the board's lease → the autonomous tick stands down. */
  leaseHeldByHuman: (board: string) => Promise<boolean> | boolean;
  /** the board's daily budget (ticks/cost) is NOT yet exhausted. */
  budgetOk: (board: string) => Promise<boolean> | boolean;
  /** o CIRCUIT BREAKER de spawn está aberto: os últimos K spawns nasceram e morreram SEM olhar o board (exit≠0,
   *  $0) ⇒ o arranque está quebrado. Checado ANTES do budget de propósito: um defeito precede a economia, e o
   *  operador precisa ver "meu spawn está quebrado", não "acabou o budget" — que foi exatamente a mentira que
   *  escondeu 19 crashes em 2026-07-13. Opcional (ausente ⇒ sem breaker, comportamento legado). */
  spawnBroken?: (board: string) => Promise<boolean> | boolean;
  /** ZERO-TOKEN pre-check: does the board have work the copiloto could ACT ON right now — a system demand
   *  (stuck run / merge conflict), NOT a pending-human decision (a question the copiloto can't answer FOR the
   *  human)? Empty ⇒ no spawn. 6.4 made this the ACTIONABLE subset (was: any cockpit item, a daily no-op loop). */
  hasWork: (board: string) => Promise<boolean> | boolean;
  /** 6.4 — anti-noop backoff: the last K spawns saw the SAME actionable-work signature (no board progress) ⇒
   *  skip this spawn to avoid burning budget on a stuck loop. Optional (absent ⇒ no backoff). Checked AFTER
   *  hasWork, so it only fires when there IS work but the copiloto isn't moving it. */
  shouldBackoff?: (board: string) => Promise<boolean> | boolean;
  /** Wake — um run do Jido DESTE board ainda está em voo (lease `tick` vivo) ⇒ não spawna um segundo. Com o
   *  wake por evento, o timer e N eventos podem cair na mesma janela; sem esta trava dois copilotos escreveriam
   *  no mesmo board ao mesmo tempo. Opcional (ausente ⇒ sem trava, comportamento legado). */
  runInFlight?: (board: string) => Promise<boolean> | boolean;
  /** spawn `claude -p "/harness-orchestrator <board> <mode> --tick"` (board-data, no worktree/train). `reason`
   *  = o evento que acordou o Jido (ausente no tick periódico). Devolver `false` = o run NÃO nasceu (sem
   *  token, binário ausente): o tick então NÃO debita o budget — antes ele debitava, e um board sem token
   *  gastava os 20 ticks do dia sem nunca ter rodado nada (o estado do acme mostrava 6 ticks / $0). */
  spawn: (board: string, mode: OrchestratorMode, reason?: string) => Promise<void | boolean>;
  /** WS-8 (D11) — o PASSE DO STEWARD: os playbooks determinísticos (conflito parqueado / claim órfão / card
   *  parado num gate já satisfeito) rodam ANTES do spawn, em processo, a ZERO TOKEN. Roda DEPOIS do hasWork e
   *  do backoff de propósito: são os MESMOS gates que decidem se este board merece atenção agora, e um steward
   *  que os furasse seria um segundo tick sem budget (e alcançaria itens de que o Jido já desistiu — o que
   *  o WS-12 resolve na régua certa, não aqui). O que ele resolve some do trabalho do LLM que nasce em
   *  seguida; o que ele escala já chega ao humano com a análise. Opcional (ausente ⇒ sem steward,
   *  comportamento legado) e best-effort: a impl nunca lança, então nunca troca um spawn por um `error`. */
  stewardPass?: (board: string) => Promise<void>;
  /** O passe de RECUPERAÇÃO ($0, sem spawn) para o caminho `skipped-no-work`. Só o playbook 8.4: quando TODOS
   *  os itens caem no backoff anti-noop, `hasWork` fica false para sempre e o steward completo — que roda
   *  depois dele — nunca alcança os itens travados. A recuperação ficaria atrás da própria condição que ela
   *  existe para recuperar. Este passe NÃO fura os gates dos outros playbooks (8.1/8.2/8.3 seguem exigindo
   *  hasWork) e só age sob PROVA de que o fato de mundo mudou. Opcional (ausente ⇒ comportamento legado). */
  recoveryPass?: (board: string) => Promise<void>;
  /** Wake — por que este tick está rodando (o evento que o disparou); vai no prompt do run e nos logs. */
  reason?: string;
  /** record the tick against the board's daily budget + lastTickAt (best-effort). */
  recordTick: (board: string) => Promise<void>;
  /** 3.5a — record the OUTCOME of a STAND-DOWN tick (a skipped-… status or error) WITHOUT consuming budget, so
   *  the chat/cockpit can show WHY the autonomous copiloto didn't act. The `ran` path uses recordTick (budget).
   *  Optional + best-effort (never throws — the impl swallows write errors), so it can't misclassify a branch. */
  recordOutcome?: (board: string, outcome: OrchestratorTickStatus) => Promise<void>;
}

/**
 * Run ONE orchestrator tick across all active boards. Per board (independent): a `paired` board is the human's
 * to drive (skip — the copiloto only SUGGESTS there); an `autonomous` board is spawned when not human-leased,
 * within budget, and with work to do. Never throws (a per-board error is swallowed to `error` so the re-arming
 * timer keeps going). Returns a per-board status list. Pure control-flow — unit-tested directly.
 */
export async function runOrchestratorTick(deps: OrchestratorTickDeps): Promise<OrchestratorTickStatus[]> {
  if (!deps.enabled) return [];
  const boards = await deps.activeBoards();
  const out: OrchestratorTickStatus[] = [];
  for (const { board, mode } of boards) {
    try {
      // paired mode: the human drives an interactive session; the autonomous tick never acts (it only
      // suggests in paired mode, which is the human's session, not this timer).
      if (mode !== "autonomous") {
        out.push("skipped-not-autonomous");
        await deps.recordOutcome?.(board, "skipped-not-autonomous");
        continue;
      }
      if (await deps.leaseHeldByHuman(board)) {
        out.push("skipped-leased");
        await deps.recordOutcome?.(board, "skipped-leased");
        continue;
      }
      // Wake — um copiloto DESTE board já está rodando: não empilha um segundo (o run em voo já vai ver o
      // trabalho novo, e dois agentes escrevendo o mesmo board é a corrida que o lease existe p/ evitar).
      if (deps.runInFlight && (await deps.runInFlight(board))) {
        out.push("skipped-running");
        await deps.recordOutcome?.(board, "skipped-running");
        continue;
      }
      // O BREAKER vem ANTES do budget: se o arranque está quebrado, o budget é irrelevante — e (com o estorno
      // do tick abortivo em applyRunResult) ele nem estaria esgotado. Um DEFEITO tem precedência sobre um
      // limite de economia na hora de dizer ao operador por que o Jido não agiu.
      if (deps.spawnBroken && (await deps.spawnBroken(board))) {
        out.push("skipped-spawn-broken");
        await deps.recordOutcome?.(board, "skipped-spawn-broken");
        continue;
      }
      if (!(await deps.budgetOk(board))) {
        out.push("skipped-budget");
        await deps.recordOutcome?.(board, "skipped-budget");
        continue;
      }
      // ZERO-TOKEN gate: nothing ACTIONABLE to do ⇒ no LLM spawn.
      if (!(await deps.hasWork(board))) {
        // Sem trabalho acionável não nasce LLM — mas é EXATAMENTE aqui que um item pode estar preso no
        // backoff com o fato de mundo já resolvido. O passe de recuperação é $0, não spawna e só age sob
        // prova; sem ele, item em backoff nunca mais é reavaliado (o deadlock medido em 2026-07-18).
        await deps.recoveryPass?.(board);
        out.push("skipped-no-work");
        await deps.recordOutcome?.(board, "skipped-no-work");
        continue;
      }
      // 6.4 — there IS work, but the last spawns didn't move it ⇒ back off this tick (budget hygiene).
      if (deps.shouldBackoff && (await deps.shouldBackoff(board))) {
        out.push("skipped-backoff");
        await deps.recordOutcome?.(board, "skipped-backoff");
        continue;
      }
      // WS-8 (D11) — o steward age AQUI: passados todos os gates (é um board autônomo, sem humano no comando,
      // com trabalho acionável e dentro do budget), mas ANTES de gastar um token. Ele destrava o que é FATO
      // mecânico; o LLM que nasce logo abaixo pega o board já limpo disso.
      await deps.stewardPass?.(board);
      const started = await deps.spawn(board, mode, deps.reason);
      if (started === false) {
        // o run não nasceu ⇒ não é um tick "gasto": não debita budget, e o operador vê o motivo real.
        out.push("skipped-spawn-failed");
        await deps.recordOutcome?.(board, "skipped-spawn-failed");
        continue;
      }
      await deps.recordTick(board);
      out.push("ran");
    } catch {
      out.push("error");
      await deps.recordOutcome?.(board, "error");
    }
  }
  return out;
}

/** Default tick cadence (30 min) when settings omit it. */
export const ORCHESTRATOR_TICK_DEFAULT_MINUTES = 30;

export interface OrchestratorTimer {
  unref?: () => void;
}
export interface StartOrchestratorTickOpts {
  /** cadence in ms; <= 0 ⇒ no-op (disabled). Uma FUNÇÃO é re-lida a cada re-arm ⇒ mudar a cadência em settings
   *  vale no ciclo seguinte, SEM restart do serviço (era a única razão da tag "restart" na UI — e reiniciar o
   *  serviço derruba runs em voo, então a tag empurrava o operador p/ um footgun). */
  intervalMs: number | (() => number);
  /** the work of one tick (typically `() => runOrchestratorTick(deps)`). */
  tick: () => Promise<unknown>;
  /** chamado a cada re-arm com o epoch ms do PRÓXIMO tick — alimenta o relógio que a UI lê (countdown). */
  onArm?: (nextTickAt: number, intervalMs: number) => void;
  /** chamado quando o loop para (stop()) — a UI para de prometer um próximo tick. */
  onStop?: () => void;
  setTimer?: (fn: () => void, ms: number) => OrchestratorTimer;
  clearTimer?: (handle: OrchestratorTimer) => void;
  now?: () => number;
}

/**
 * Arm a RE-ARMING timer (not setInterval) so a slow tick never overlaps the next — each tick runs, then
 * schedules the following one in its `finally`. `.unref()` so it never keeps the process alive. intervalMs
 * <= 0 ⇒ no-op. Returns a stop() that cancels the loop. Identical shape to startRecoverySweep.
 */
export function startOrchestratorTick(opts: StartOrchestratorTickOpts): () => void {
  const readInterval = (): number => (typeof opts.intervalMs === "function" ? opts.intervalMs() : opts.intervalMs);
  if (readInterval() <= 0) return () => {};
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as OrchestratorTimer);
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const now = opts.now ?? Date.now;
  let stopped = false;
  let handle: OrchestratorTimer | undefined;
  const arm = () => {
    if (stopped) return;
    const ms = readInterval();
    if (ms <= 0) {
      // a cadência foi zerada em settings enquanto rodávamos → para o loop (e a UI deixa de prometer um tick).
      stopped = true;
      opts.onStop?.();
      return;
    }
    opts.onArm?.(now() + ms, ms);
    handle = setTimer(() => {
      void opts.tick().catch(() => {}).finally(arm);
    }, ms);
    handle?.unref?.();
  };
  arm();
  return () => {
    stopped = true;
    if (handle) clearTimer(handle);
    opts.onStop?.();
  };
}
