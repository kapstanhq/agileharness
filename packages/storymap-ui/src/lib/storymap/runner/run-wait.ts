// story-97gpdm — espera BLOQUEANTE nativa por conclusão de run de card. Hoje o orquestrador só sabe que um
// run terminou por REPOLLING manual (chamar runner_status/card_console de novo e de novo), multiplicando
// turnos e chamadas de tool. Este core resolve numa Promise que se completa por EVENTO (engine.onComplete /
// mergeQueue.onMergeDone) OU por TIMEOUT — nunca bloqueia pra sempre (o wrapper MCP re-chama se preciso).
//
// O CORE é injetável (as 4 deps) para ser determinístico no teste; o wrapper MCP (tools.ts) liga:
//   isActive       → engine.isInFlight(board,cardId) || entrada viva na merge-queue do card
//   latestOutcome  → journal.latest(board,cardId)?.outcome (o forense durável, para o fast-path já-terminou)
//   subscribe      → engine.onComplete + mergeQueue.onMergeDone filtrados por board/cardId
//   schedule       → setTimeout/clearTimeout
// SEM node/browser deps aqui — puro, isomórfico.

/** As dependências que o core precisa — injetadas pelo wrapper MCP (real) ou por fakes (teste). */
export interface RunWaitDeps {
  /** Há um run (ou merge-back) EM ANDAMENTO para este card AGORA? */
  isActive(): boolean;
  /** O último outcome durável do card (journal), para o fast-path "já terminou". Null se nunca rodou. */
  latestOutcome(): string | null;
  /** Assina a conclusão do run (onComplete + onMergeDone). Chama `onDone(outcome)` uma vez; devolve unsubscribe. */
  subscribe(onDone: (outcome: string | null) => void): () => void;
  /** setTimeout-like: agenda `cb` para daqui a `ms`; devolve um cancelador. */
  schedule(ms: number, cb: () => void): () => void;
}

export type RunWaitResult =
  | { state: "already-idle"; outcome: string | null; waitedMs: 0 }
  | { state: "completed"; outcome: string | null; waitedMs: number }
  | { state: "timeout"; waitedMs: number };

/**
 * Aguarda a conclusão de um run. ASSINA PRIMEIRO, depois checa se ainda está ativo — assim um evento que
 * chega entre a checagem e a subscription não é perdido (a corrida clássica de wait). Resolve EXATAMENTE uma
 * vez (o primeiro entre: já-ocioso / evento / timeout) e sempre limpa subscription + timer. `now` é injetado
 * para o waitedMs ser determinístico no teste. PURO (sobre as deps).
 */
export function waitForRunCore(deps: RunWaitDeps, timeoutMs: number, now: () => number): Promise<RunWaitResult> {
  const start = now();
  return new Promise<RunWaitResult>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (r: RunWaitResult) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };
    // 1) Assina ANTES de checar o estado atual (anti missed-event race).
    cleanups.push(deps.subscribe((outcome) => finish({ state: "completed", outcome, waitedMs: now() - start })));
    // 2) Rede de segurança: nunca segura a conexão MCP pra sempre.
    cleanups.push(deps.schedule(timeoutMs, () => finish({ state: "timeout", waitedMs: now() - start })));
    // 3) Já terminou? (nenhum run/merge ativo) → resolve já com o outcome durável.
    if (!deps.isActive()) finish({ state: "already-idle", outcome: deps.latestOutcome(), waitedMs: 0 });
  });
}

// ── espera MULTIPLEXADA (M5) ─────────────────────────────────────────────────────────────────────────

/**
 * Um alvo de espera. `key` volta no resultado — é como o chamador sabe QUEM disparou.
 */
export interface AnyWatcher<E> {
  key: string;
  /** Já aconteceu ANTES de a gente começar a esperar? Devolve o desfecho, ou null se segue pendente. */
  settledNow(): E | null;
  /** Assina; chama `onEvent` quando acontecer. Devolve o cancelador. */
  subscribe(onEvent: (e: E) => void): () => void;
}

export type AnyWaitResult<E> =
  | { state: "already"; key: string; event: E; waitedMs: 0 }
  | { state: "fired"; key: string; event: E; waitedMs: number }
  | { state: "timeout"; waitedMs: number; pending: string[] };

/**
 * Espera o PRIMEIRO de N alvos — o que faltava para um orquestrador de frota.
 *
 * O DEFEITO: todas as esperas bloqueantes eram de ENTIDADE ÚNICA (`wait_for_run(board,cardId)`,
 * `wait_for_submit(sessionId)`, `wait_for_session_idle(session)`). Com 4 sessões vivas, o orquestrador
 * só conseguia bloquear numa por vez — então na prática ele degradava para POLLING, que é exatamente o
 * que essas tools existem para eliminar. Pior: bloquear na sessão A enquanto B termina significa
 * descobrir B só depois do timeout de A.
 *
 * Mesma disciplina do {@link waitForRunCore}, agora N vezes: ASSINA TODOS primeiro, só então pergunta
 * quem já estava pronto (um evento que chegue no meio não se perde). Resolve EXATAMENTE uma vez e
 * sempre cancela todas as assinaturas — um watcher esquecido aqui vazaria um timer por chamada.
 * PURO sobre as deps.
 */
export function waitForAnyCore<E>(
  watchers: readonly AnyWatcher<E>[],
  timeoutMs: number,
  schedule: (ms: number, cb: () => void) => () => void,
  now: () => number,
): Promise<AnyWaitResult<E>> {
  const start = now();
  return new Promise<AnyWaitResult<E>>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (r: AnyWaitResult<E>) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };
    if (!watchers.length) return finish({ state: "timeout", waitedMs: 0, pending: [] });

    for (const w of watchers) {
      cleanups.push(w.subscribe((event) => finish({ state: "fired", key: w.key, event, waitedMs: now() - start })));
    }
    cleanups.push(schedule(timeoutMs, () => finish({ state: "timeout", waitedMs: now() - start, pending: watchers.map((w) => w.key) })));

    for (const w of watchers) {
      if (settled) return;
      const already = w.settledNow();
      if (already !== null) finish({ state: "already", key: w.key, event: already, waitedMs: 0 });
    }
  });
}
