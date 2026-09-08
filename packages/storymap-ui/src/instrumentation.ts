// Next.js instrumentation — runs ONCE per server boot (a full start, NOT an HMR reload).
// Two boot-time jobs the AgileHarness autorun pipeline needs, neither of which should wait
// for the first browser to open the board:
//   1. Start the filesystem watcher at boot. It previously started only on the first SSE
//      connection, so autorun was effectively dead until someone opened the UI.
//   2. Recover runs the previous process left in-flight when it crashed/restarted — the
//      in-memory registry is gone, but the durable journal (runner/journal.ts) remembers
//      them, and recovery.ts re-drives exactly the genuinely-interrupted ones.
//
// Guarded to the Node.js server runtime (a no-op in the edge runtime / browser bundle).
// Carregado por DEFAULT pelo Next 15 (no 14 dependia de `experimental.instrumentationHook`, flag
// removida do config em 2026-08-25 porque o 15 a rejeita como chave desconhecida).

import type { Landedness } from "@/lib/storymap/runner/convergence";
import type { RecoveryDeps } from "@/lib/storymap/runner/recovery";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next.prepare()` NÃO aguarda este hook até o fim — medido: o `listen` do servidor acontece com o
  // `register()` ainda correndo. O sinal abaixo (lido por src/server/main.ts, que vive noutro grafo de
  // módulo) é o que torna essa janela MEDIDA em vez de invisível. Ver runner/boot-signal.ts.
  const { markEngineBooted } = await import("@/lib/storymap/runner/boot-signal");
  try {
    await registerImpl();
  } finally {
    // `finally`, e não no fim do caminho feliz: o motor sai cedo quando está inerte (worktree) e pode
    // lançar. Um sinal que só dispara quando tudo dá certo mente exatamente quando mais importa.
    markEngineBooted();
  }
}

async function registerImpl(): Promise<void> {

  // 0−−−−) A CERCA DO ALVO, antes de QUALQUER segredo existir. `ensureAuthSecrets` (logo abaixo)
  //        escreve `auth-token` e `session-secret` dentro de `<alvo>/storymap/.runner/`, e sob
  //        `STORYMAP_TARGET` esse alvo é o repositório de outra pessoa. A regra de ignore precisa
  //        estar posta ANTES do primeiro byte, senão existe um instante em que o segredo está no
  //        disco e descoberto. Sonda antes de escrever: em repositório já coberto (umbrella, repo
  //        extraído) isto não encosta em disco nenhum.
  try {
    const { ensureTargetFence } = await import("@/lib/storymap/target-fence");
    ensureTargetFence();
  } catch (e) {
    // Uma cerca é defesa em profundidade: se ela falhar, o boot segue. Derrubar o servidor aqui
    // trocaria um risco por uma indisponibilidade.
    console.warn(`[cerca] não foi possível verificar o ignore do alvo: ${(e as Error).message}`);
  }

  // 0−−−) AUTENTICAÇÃO. ANTES do portão do engine, e de propósito: o middleware (Edge) só enxerga
  //       o segredo de sessão através de `process.env`, e ele NEGA quando o segredo falta
  //       (fail-closed). Se isto ficasse depois do `return` de engine inerte, todo servidor subido
  //       de dentro de um worktree — o caminho normal de validar UI e o que o dogfood do harness-qa faz
  //       — trancaria 100% das rotas sem NENHUMA forma de entrar. Auth não é função do engine:
  //       vale para qualquer boot, armado ou inerte.
  try {
    const { ensureAuthSecrets, authTokenFile } = await import("@/lib/auth/token");
    const { tokenCreated, tokenSource } = ensureAuthSecrets();
    if (tokenCreated) {
      // O momento de onboarding do self-host: o token nasceu agora e ninguém o viu ainda.
      console.info(
        `\n  AgileHarness — token do operador criado em ${authTokenFile()}\n` +
          `  Leia com:  cat ${authTokenFile()}\n` +
          `  Use-o na tela de login. Guarde-o num gerenciador de senhas.\n`,
      );
    } else if (tokenSource === "file") {
      console.info(`[auth] token do operador carregado de ${authTokenFile()}`);
    }
  } catch (err) {
    // Falhar aqui deixa o serviço TRANCADO (o middleware nega sem segredo). É barulhento de
    // propósito: um disco cheio ou um `.runner` sem permissão precisa aparecer no log, não virar
    // "o board não abre e ninguém sabe por quê".
    console.error("[auth] FALHA ao preparar token/segredo de sessão — o serviço ficará trancado:", err);
  }

  // 0−−) O PORTÃO. Tudo daqui para baixo AGE sobre o repositório compartilhado — escreve o
  //      service.lock, remove worktree com `git worktree remove --force`, recupera o merge train
  //      (merge/push no mesmo `.git`), respawna runs, arma a fila que DEPLOYA e o tick que gasta.
  //      Antes disto, nada disso tinha gate: `USM_AUTORUN=0` cobre 4 dos ~15 efeitos e NÃO cobre nem
  //      o reaper nem o train. Subir um servidor de dentro de um worktree — o que se faz para validar
  //      UI, e o que o dogfood do harness-qa faz por desenho — armava um SEGUNDO motor sobre o repo do
  //      serviço de produção (2026-07-23: quatro worktrees de sessão vivos declarados mortos).
  //      ANTES do service.lock de propósito: escrevê-lo de dentro de um worktree arma o hook D4
  //      contra o board-data DAQUELE worktree, que por contrato (ADR-065) é livre para a sessão editar.
  //      Ver engine-armed.ts para a régua e a direção da falha.
  const { engineArmedDecision, engineInertWarning } = await import("@/lib/storymap/runner/engine-armed");
  const { findRepoRoot } = await import("@/lib/storymap/paths");
  // F0 (achado de revisão): este `catch` engolia o `RepoRootUnresolvedError` — construído em paths.ts
  // justamente para CARREGAR os caminhos percorridos — e devolvia `null`, fazendo o serviço subir INERTE
  // com uma razão genérica. O aceite da fase pede o contrário: falhar ALTO, dizendo onde procurou.
  // Raiz não resolvida e `.git` ausente são coisas DIFERENTES e agora são tratadas como tais.
  const gitIsDirectory = await (async () => {
    const [{ promises: fsp }, { default: nodePath }] = await Promise.all([
      import("node:fs"),
      import("node:path"),
    ]);
    let root: string;
    try {
      root = findRepoRoot();
    } catch (err) {
      // NÃO degrada para inerte: sem raiz, o boot não tem o que armar E o operador precisa da mensagem
      // com os caminhos buscados. Propagar é o comportamento correto — o serviço não sobe fingindo saber
      // onde está, que é a condição em que os reapers apagavam branch no diretório errado.
      console.error(`[harness-boot] raiz de repositório NÃO RESOLVIDA — o motor não pode subir.\n${String(err)}`);
      throw err;
    }
    try {
      return (await fsp.stat(nodePath.join(root, ".git"))).isDirectory();
    } catch {
      return null; // `.git` ausente/ilegível ⇒ o veredito abaixo trata como inerte (caso legítimo)
    }
  })();
  const engineGate = engineArmedDecision({ flag: process.env.STORYMAP_ENGINE, gitIsDirectory });
  if (!engineGate.armed) {
    console.warn(engineInertWarning(engineGate.reason));
    return;
  }
  console.log(`[harness-boot] motor ARMADO: ${engineGate.reason}`);

  // 0−) WS-3/D4 — declare, ANTES de tudo, que É NESTE checkout que o serviço roda: escreve
  //     storymap/.runner/service.lock {pid, port, startedAt}. É o sinal que o hook
  //     block-runtime-board-writes lê para recusar Write/Edit de agente em `storymap/boards/**`
  //     daqui (o serviço é o único escritor de board-data do checkout runtime; o lock de write.ts
  //     é in-process e não vale contra outro processo). PRIMEIRO de tudo porque a recuperação
  //     abaixo (passos 1/1b/1c) já respawna runs e re-dispara efeitos que ESCREVEM board-data —
  //     a autoridade tem de valer desde o primeiro instante do boot, não depois dele. Sobrescreve
  //     um lock stale de crash (pid novo vence). Best-effort: nunca lança, nunca atrasa o boot.
  const { writeServiceLock } = await import("@/lib/storymap/runner/service-lock");
  const serviceLock = await writeServiceLock();
  if (serviceLock) console.log(`[harness-boot] service.lock: pid=${serviceLock.pid} port=${serviceLock.port}`);
  else console.warn("[harness-boot] service.lock: não foi possível escrever (hook de board-data ficará inerte)");

  const [
    { ensureWatching },
    recovery,
    { loadRunnerConfig },
    repo,
    { getRunnerEngine },
    { getRunnerJournal },
    { getMergeQueue },
    { getDispatcher },
    { startRecoverySweep, runRecoverySweepTick, recoverySweepIntervalMs },
    { pipelineIdle },
  ] = await Promise.all([
    import("@/lib/notifications/server/watcher"),
    import("@/lib/storymap/runner/recovery"),
    import("@/lib/storymap/runner/config"),
    import("@/lib/storymap/repo"),
    import("@/lib/storymap/runner/engine"),
    import("@/lib/storymap/runner/journal"),
    import("@/lib/storymap/runner/merge-queue"),
    import("@/lib/notifications/server/dispatcher"),
    import("@/lib/storymap/runner/recovery-sweep"),
    import("@/lib/storymap/runner/pipeline-idle"),
  ]);

  // 0) Wire the dispatcher EAGERLY — its trigger-runner channel subscribes engine.onComplete +
  //    mergeQueue.onMergeDone (the cascade-after-merge hook). Recovery below (steps 1/1b) can FIRE
  //    those events — a resumed run that completes, or recoverMergeQueue finalizing an integration
  //    → emitMergeDone (audit #8). The dispatcher otherwise builds LAZILY on the first watcher event
  //    (step 2), which runs AFTER recovery, so a boot-time emission would hit ZERO listeners and the
  //    cascade would silently stall (undoing audit #8). Constructing it first guarantees the
  //    subscriber exists before any emission. Idempotent (process-global singleton).
  getDispatcher();

  // 1) Recover anything the last process left mid-run BEFORE arming the watcher, so no watcher
  //    event can interleave with the recovery scan (a fresh run for the same card must not
  //    clobber an interrupted entry mid-resolve). Gated by autorun + resumeOnBoot.
  let recovered = { interrupted: 0, respawned: 0, dropped: 0, skipped: 0, deferred: 0 };
  const engine = getRunnerEngine();
  // Build the recovery deps FRESH each call so the periodic sweep (step 2.5) re-reads settings (cfg)
  // per tick — a `enabled`/`resumeOnBoot` toggle takes effect without a restart. Boot reuses it too.
  const makeRecoveryDeps = (): RecoveryDeps => {
    const cfg = loadRunnerConfig();
    return {
      enabled: cfg.autorun.enabled && cfg.autorun.resumeOnBoot,
      journal: getRunnerJournal(),
      readBoardConfig: (b) => repo.readBoardConfig(b).catch(() => null),
      readCards: (b) => repo.readCards(b).catch(() => []),
      runSkill: (board, cardId, trigger, def, opts) => engine.runSkill(board, cardId, trigger, def, opts),
      killOrphan: recovery.defaultKillOrphan,
      cleanupWorktree: recovery.defaultCleanupWorktree,
      // story-watchdog: the resume pre-condition probe — a crashed run is `claude --resume`d ONLY when
      // its ephemeral worktree still exists on disk; a missing one is failed gracefully (no loop).
      checkWorktreeExists: recovery.checkWorktreeOnDisk,
      reconcileWorktrees: recovery.defaultReconcileWorktrees,
      // settle-gap-resume: protect run branches the merge train is mid-integrating from the
      // orphan-branch sweep (only a true settle-gap orphan — no entry — is disposed/preserved).
      // allRunIds (não liveRunIds): "sem NENHUMA entrada" é a definição de órfão de settle-gap — um run com
      // entrada TERMINAL foi integrado normalmente e não pode ser varrido. Este consumidor sempre quis o
      // conjunto completo; era o outro (o gate de ociosidade do sweep) que estava recebendo a coisa errada.
      mergeQueueRunIds: () => getMergeQueue().allRunIds(),
      // un-strand: stop a crashed run's still-live `systemd-run` SCOPE (it survives a service restart in
      // the disjoint claude-runs.slice cgroup) BEFORE resuming its session — and defer the resume if it
      // refuses to die. The kill is allowlisted to `harness-run-*.scope`, never the AgileHarness service.
      stopScope: recovery.defaultStopScope,
      isScopeActive: recovery.defaultIsScopeActive,
    };
  };
  // 1a′) WS-4.4 (parallel-work) — free the card claims of RUN actors from the PREVIOUS life of this service.
  //      Their processes died with it, so those reservations reserve nothing; the runs recovery re-spawns
  //      below RE-ACQUIRE through the engine's chokepoint (same `run:<sessionId>` actor → a clean re-take).
  //      MUST precede recoverInterruptedRuns: a stale reservation would refuse its OWN run's respawn. Session
  //      claims are deliberately spared — a session outlives the service and expires by its own TTL.
  try {
    const { getCardClaims } = await import("@/lib/storymap/runner/claims");
    await getCardClaims().releaseRunClaimsOnBoot();
  } catch (err) {
    console.error("[harness-boot] claims boot-release failed:", err instanceof Error ? err.message : err);
  }

  try {
    recovered = await recovery.recoverInterruptedRuns(makeRecoveryDeps());
  } catch (err) {
    console.error("[harness-boot] run recovery failed:", err instanceof Error ? err.message : err);
  }

  // 1b) Recover the SM-2 merge train: initialize the singleton (wires its registry/SSE bridge),
  //     reset a crashed mid-merge entry to `conflict`, and resume any branches left `waiting`.
  let mqRecovery = { loaded: 0, resetToConflict: 0, resumed: 0, pruned: 0, resetGateFailed: 0, waiting: 0 };
  try {
    mqRecovery = await recovery.recoverMergeQueue(getMergeQueue());
  } catch (err) {
    console.error("[harness-boot] merge-queue recovery failed:", err instanceof Error ? err.message : err);
  }

  // 1b′) ADR-063 Fase 3b: recover the ASYNC test queue — a test the last process fired and left in-flight
  //      (the storymap restart killed its detached child) is reloaded from the durable ledger and RE-DRIVEN,
  //      so its result still lands + resumes the cascade. Must run AFTER getDispatcher() (step 0) so the
  //      onDone subscriber exists before a re-driven test can complete. Gated on the same autorun switch.
  let testQueueRecovered = 0;
  try {
    const { loadRunnerConfig: loadCfg } = await import("@/lib/storymap/runner/config");
    const cfg = loadCfg();
    if (cfg.autorun.enabled && cfg.autorun.resumeOnBoot) {
      const { getTestQueue } = await import("@/lib/storymap/runner/test-queue");
      testQueueRecovered = (await getTestQueue().recover()).redriven;
    }
  } catch (err) {
    console.error("[harness-boot] test-queue recovery failed:", err instanceof Error ? err.message : err);
  }

  // 1c) story-harness-adk A5: recover onEnter effects a forward COMMITTED to (status advanced on disk) but
  //     whose promote/deploy never confirmed before the crash. recoverInterruptedRuns (step 1) only respawns
  //     skills / drops runs — it NEVER re-fires an onEnter, so a card stuck "liberado/no ar" with un-promoted
  //     code is invisible to it. Re-fire the unresolved ones ONCE (idempotent), gated on the same
  //     autorun+resumeOnBoot switch (never auto-deploy what an operator disabled).
  let effectsRecovery = { pending: 0, refired: 0, dropped: 0, skipped: 0, deferred: 0, failed: 0 };
  try {
    const [{ getPendingEffects, recoverPendingEffects }, { runEntryEffect }, { deployPkgForPackage }, { updateCardOnDisk }, { withPendingEffectFailureFinding }] = await Promise.all([
      import("@/lib/storymap/runner/pending-effects"),
      import("@/lib/storymap/runner/entry-effects"),
      import("@/lib/storymap/runner/product-deploy"),
      import("@/lib/storymap/write"),
      import("@/lib/storymap/runner/findings"),
    ]);
    const cfg = loadRunnerConfig();
    const pe = getPendingEffects();
    effectsRecovery = await recoverPendingEffects({
      enabled: cfg.autorun.enabled && cfg.autorun.resumeOnBoot,
      loadPending: () => pe.loadPending(),
      resolve: (b, c, eff) => pe.resolve(b, c, eff),
      cardExists: async (b, c) => (await repo.readCards(b).catch(() => [])).some((card) => card.id === c),
      runEffect: (eff, b, c) => runEntryEffect(eff, b, c),
      // A product production deploy must be human-initiated — never auto-shipped on boot. promote-stage is
      // always boot-safe (idempotent code promote); a storymap self-deploy is too (deployPkgForPackage→null,
      // it is not a product app). Only a deploy whose board maps to a DECLARED deploy target is deferred.
      isBootSafe: async (eff, b) => {
        if (eff === "promote-stage") return true;
        const bc = await repo.readBoardConfig(b).catch(() => null);
        return deployPkgForPackage(bc?.package) === null;
      },
      // WS1.4: a boot re-fire that THROWS stamps a `high` finding on the card (the old `.catch(() => {})`
      // let a failed re-deploy die mute while the card kept lying "no ar"). Read-modify-write under the
      // per-card lock (mirrors every merge-train stamper). Best-effort — recoverPendingEffects wraps it.
      onRefireFailure: async (eff, b, c, error) => {
        const msg = error instanceof Error ? error.message : String(error);
        await updateCardOnDisk(b, c, (card) => ({
          ...card,
          findings: withPendingEffectFailureFinding(card.findings ?? [], c, eff, msg),
        }));
      },
    });
  } catch (err) {
    console.error("[harness-boot] pending-effects recovery failed:", err instanceof Error ? err.message : err);
  }

  // 2) Boot the watcher so autorun reacts to board changes without an open tab.
  try {
    await ensureWatching();
  } catch (err) {
    console.error("[harness-boot] watcher start failed:", err instanceof Error ? err.message : err);
  }

  // 2.1) O VIGIA DOS TERMINAIS — pelo mesmo motivo do watcher acima: SEM ABA ABERTA. O antecessor dele só
  //      vigiava enquanto a página do terminal estava viva, então um prompt parado num terminal que ninguém
  //      abriu era invisível para o push, para os alertas e para o próprio Jido. Timer unref'd; um `tmux`
  //      ausente simplesmente devolve zero sessões para sempre.
  try {
    const { startTerminalAttentionWatch } = await import("@/lib/terminal/attention-watch");
    startTerminalAttentionWatch();
  } catch (err) {
    console.error("[harness-boot] vigia de terminais falhou ao subir:", err instanceof Error ? err.message : err);
  }

  // 2.2) A RECONCILIAÇÃO DA FROTA — pelo mesmo motivo dos dois acima, e por um pior: ela não dependia de
  //      uma ABA aberta, dependia de um AGENTE chamar `claude_sessions`. Era o único chamador de
  //      `reconcileFleet` no repositório inteiro, então a liveness da frota (renovar o heartbeat de quem
  //      está vivo, renovar os claims, liberar os de quem morreu) era efeito colateral de alguém LISTAR.
  //      Sem ninguém polando: heartbeat envelhecendo sob um agente que está trabalhando (e a varredura
  //      julga árvore por heartbeat), e card de sessão morta reservado até o TTL de 60min. Timer unref'd;
  //      a sonda de tmux é fail-closed (não sei ⇒ não julgo ninguém). USM_FLEET_RECONCILE_MS (<=0 desliga).
  const fleetMs = (() => {
    const raw = Number(process.env.USM_FLEET_RECONCILE_MS);
    return Number.isFinite(raw) ? raw : 60_000;
  })();
  if (fleetMs > 0) {
    const { reconcileFleetNow } = await import("@/lib/storymap/runner/fleet-deps");
    const tick = async () => {
      try {
        const res = await reconcileFleetNow();
        // Só fala quando ALGO mudou: um tick de minuto em minuto que loga "nada" é ruído que esconde sinal.
        if (res.died.length) {
          console.log(
            `[harness-fleet] ${res.died.length} sessão(ões) sem tmux → claims liberados:`,
            res.died.map((d) => `${d.tmuxSession ?? d.agentId}(${d.claimsReleased})`).join(", "),
          );
        }
      } catch (err) {
        console.error("[harness-fleet] reconciliação falhou:", err instanceof Error ? err.message : err);
      }
    };
    const timer = setInterval(() => void tick(), fleetMs);
    timer.unref?.();
    void tick();
  }

  // 2.5) Periodic recovery sweep (story-harness-cc #6): recoverInterruptedRuns runs ONCE at boot, but a
  //      run can be left "running" LONG after boot — a max-turns in-process resume rejected by the
  //      rate-limit just logs "retomável no próximo boot" and the entry sits resumable+running until a
  //      restart. The systemd service is long-lived (never-kill discourages restarts), so "next boot"
  //      can be days away. This re-runs the SAME recovery on an interval, GATED on idleness (engine has
  //      no run in flight AND the merge train has no live entry) so it never fights the train nor runs
  //      reconcileWorktrees (a git subprocess) while work is active. Timer is unref'd (never holds the
  //      process open). Env USM_AUTORUN_RECOVERY_SWEEP_MS (<=0 disables).
  const sweepMs = recoverySweepIntervalMs();
  if (sweepMs > 0) {
    // OBSERVABILIDADE do sweep — o subsistema que morreu em SILÊNCIO.
    //
    // `runRecoverySweepTick` sempre DEVOLVEU um status ("ran" | "skipped-busy" | …) — e o timer o jogava fora.
    // Resultado: quando `liveRunIds()` passou a devolver as 100 entradas TERMINAIS da merge-queue, `isIdle()`
    // virou permanentemente false e o sweep passou a pular TODO tick, para sempre, sem UMA linha de log. Com
    // ele morreram a recuperação de runs órfãos, o branch GC e (depois) a reconciliação de deploy-failure —
    // e ninguém soube por semanas. O bug foi achado por acaso, porque um recurso NOVO não rodava.
    //
    // Agora: o streak de skips é contado, o motivo é NOMEADO, e o alarme escala. Um sweep que pula 6x seguidas
    // (1 hora) grita; um que volta a rodar avisa que voltou. Silêncio deixa de ser um estado possível.
    const SWEEP_ALARM_EVERY = 6; // ~1h no intervalo default de 10min
    let skipStreak = 0;
    let idleBlockedBy: string | null = null;
    // Stale advisories repeat every tick for a branch's whole life — this Set (alive for the process)
    // makes the branch GC journal each one ONCE, killing the 2480-duplicate-line churn the old GC caused.
    const branchGcAdvised = new Set<string>();
    // Mesmo papel, outra varredura: os nomes de árvore cuja linha "ficou" já foi dita neste processo.
    const worktreeGcJournaled = new Set<string>();
    // …e o resumo, que só fala quando os números mudam (ver o comentário no ponto de log).
    let lastWorktreeGcSummary = "";

    const runSweepTick = async () => {
      const status = await runRecoverySweepTick({
        enabled: (() => {
          const c = loadRunnerConfig();
          return c.autorun.enabled && c.autorun.resumeOnBoot;
        })(),
        // The streak this wiring ALREADY tracked in order to alarm on it — now it also ACTS on it. The
        // alarm was written because a starving sweep is invisible; but counting to 6 and shouting is not a
        // fix when the thing being deferred to is itself the stuck work (acme/story-novo-item, 5h+).
        busySkips: skipStreak,
        isIdle: async () => {
          // A régua saiu daqui para runner/pipeline-idle: o mesmo predicado agora serve o sweep E a fila
          // de publicação, e passou a ter teste. Morar inline no bootstrap de UM consumidor foi o que
          // deixou o bug das 100 entradas terminais passar semanas sem ninguém ver.
          // `onProbeError: "idle"` PRESERVA o fail-open histórico deste caller (o trabalho do sweep é
          // idempotente; deixar de rodar é pior que rodar a mais). Quem publica usa o default fail-closed.
          const verdict = await pipelineIdle(
            // activeRunIds, NÃO liveRunIds: uma entrada PARKEADA (gate-failed/conflict) espera um
            // humano, por dias — contá-la aqui fazia o sweep pular todo tick enquanto houvesse um
            // conflito na fila. É o mesmo bug das 100 entradas terminais, um degrau adiante.
            { hasInFlight: () => engine.hasInFlight(), liveMergeEntries: () => getMergeQueue().activeRunIds() },
            { onProbeError: "idle" },
          );
          idleBlockedBy = verdict.blockedBy;
          return verdict.idle; // merge train must be idle too (reconcileWorktrees touches run trees)
        },
        runRecovery: () => recovery.recoverInterruptedRuns(makeRecoveryDeps()),
        // Harvest the SUPERSEDED preserved run branches (failed/run/*, conflicted/run/*, orphan run/*) in
        // the same idle window. It shares the /processes verdict (classifyPreservedBranch) — the run's own
        // work from its reflog cut point, cherry-picks acquitted by content, conflicted snapshots of
        // finished cards recognised as redrive losers — instead of the old `--is-ancestor` proof that was
        // blind to both cherry-pick and stage inheritance and so harvested nothing (23 branches piled up).
        // dryRun defaults OFF now (the classifier is proven safe: it only deletes SUPERSEDED verdicts, and
        // an estimated base can only OVER-report work, so a "superseded" verdict is trustworthy even when
        // estimated). Escape hatch: USM_BRANCH_GC_ENABLED=0 restores observe-only.
        runBranchGc: async () => {
          const [
            { runBranchGc, appendBranchGcJournal, makeAgeDaysOf },
            { listPreservedRunBranches, defaultPreservedBranchesDeps },
            { defaultExec },
            { findRepoRoot },
            { resolveReaperMode, guardDestructive },
          ] = await Promise.all([
            import("@/lib/storymap/runner/branch-gc"),
            import("@/lib/storymap/runner/preserved-branches"),
            import("@/lib/storymap/runner/worktree"),
            import("@/lib/storymap/paths"),
            import("@/lib/storymap/runner/reaper-mode"),
          ]);
          // F0: o interruptor do modo relatório. `git branch -D` é a única operação do sistema sem
          // desfazer, e ela roda sobre uma raiz RESOLVIDA — o par que o plano nomeia como risco nº 1.
          const reaperMode = resolveReaperMode(process.env);
          const repoRoot = findRepoRoot();
          const now = Date.now();
          const q = (s: string) => JSON.stringify(s);
          await runBranchGc({
            listPreserved: () => listPreservedRunBranches(defaultPreservedBranchesDeps()),
            ageDaysOf: makeAgeDaysOf(defaultExec, repoRoot, now),
            deleteBranch: async (branch) =>
              guardDestructive(
                reaperMode,
                { kind: "branch", ref: branch, wouldDeleteAt: now },
                async () => {
                  try {
                    await defaultExec(`git branch -D ${q(branch)}`, { cwd: repoRoot, timeout: 15_000 });
                    return true;
                  } catch {
                    return false;
                  }
                },
                // O que o modo relatório PRODUZ: uma linha no journal do branch-gc, que é onde o
                // operador já procura o que a limpeza fez. Sem consumidor, a callback seria decoração.
                // Entrada COMPLETA e dentro do esquema. A versão anterior passava três campos com
                // `as never` — o registro saía fora do tipo que o próprio módulo publica, invisível
                // para quem escrevesse um leitor a partir dele.
                (r) =>
                  void appendBranchGcJournal({
                    at: new Date(r.wouldDeleteAt).toISOString(),
                    branch: r.ref,
                    action: "reaper-report-only",
                    deleted: false, // o ponto da linha: o freio estava puxado
                  }).catch(() => {}),
              ),
            // WS-2.3 (autonomy-reliability): FAIL-CLOSED signal for the code guard — is the branch's tip an
            // ancestor of main OR stage? (its code is safely landed). Cherry-picked (new-sha) integrations
            // are already acquitted by the verdict ("integrated"), so this only runs for stuck code branches.
            // Read-only; exit 0 = ancestor. Neither ref → the code is NOT integrated → the GC keeps it.
            codeReachedMainOrStage: async (branch) => {
              for (const ref of ["main", "stage"]) {
                try {
                  await defaultExec(`git merge-base --is-ancestor ${q(branch)} ${ref}`, { cwd: repoRoot, timeout: 15_000 });
                  return true;
                } catch {
                  /* not ancestor (exit 1) or ref missing → try the next */
                }
              }
              return false;
            },
            // WS-5.4: the CONTENT answer for the branches ancestry could not clear — the shared convergence
            // ruler over the branch's own work against main and stage. This is what sees a cherry-pick/squash
            // (new sha, new patch-id, same content) and lets the GC finally harvest it; without it those
            // branches were kept forever. ADR-065: this used to be an inline COPY of the ruler here, and the
            // copy gated on `provenance !== "reflog"` — which made every `agent/*` branch (whose exact base is
            // the base-ref, not the reflog) permanently `unknown`, so the GC could never harvest a session
            // branch. It now delegates, so there is exactly one implementation to be right.
            contentLandedInMainOrStage: async (branch) => {
              const { branchWorkLandedInMainOrStage } = await import("@/lib/storymap/runner/convergence");
              // o branch de integração é DECLARADO (`autorun.staging.branch`); fixar o literal aqui
  // sobrescrevia a declaração do repositório — o train já lia o declarado, as réguas de ciclo de vida não
              return branchWorkLandedInMainOrStage(defaultExec, repoRoot, branch, {
                stageBranch: loadRunnerConfig().autorun.staging?.branch ?? "stage",
              });
            },
            // A prova sobre o CARD (não sobre a branch): a tentativa perdedora de um card que ENTREGOU.
            // `expectedDeltaOf` + `rangeLandedBySplit` — a MESMA primitiva de convergência que o
            // deploy-reconcile usa; nunca uma régua nova. Um card sem range recorded ⇒ `false` (nada a
            // provar ⇒ nada autorizado), e o guard fail-closed segue segurando.
            cardDeliveredLanded: async (b) => {
              if (!b.board || !b.cardId) return false;
              const [{ expectedDeltaOf, rangeLandedBySplit }, { readCards }] = await Promise.all([
                import("@/lib/storymap/runner/convergence"),
                import("@/lib/storymap/repo"),
              ]);
              const card = (await readCards(b.board)).find((c) => c.id === b.cardId);
              const range = expectedDeltaOf(card);
              if (!range) return false;
              const r = await rangeLandedBySplit(defaultExec, repoRoot, { range });
              // SÓ a metade de CÓDIGO, e ESTRITAMENTE `landed`. Duas decisões, cada uma com um motivo:
              //
              // • A metade de DADOS fica de fora porque ela é ESTRUTURALMENTE imensurável por git — o
              //   board é vivo e o serviço muta o card DEPOIS que o patch aplicou, então a pós-imagem
              //   diverge por desenho (o header de convergence.ts diz isto). Exigi-la aqui reprovaria
              //   por ruído, não por risco: o que se arrisca perder ao apagar um snapshot é CÓDIGO.
              //   Medido: 2 das 9 candidatas dariam `data: absent` por esse ruído.
              // • `n/a` no código NÃO serve: significa "o card não entregou código nenhum" — e uma
              //   branch que TOCA código cujo card entregou zero código é exatamente o caso suspeito.
              //   Só a prova positiva de que o código do card aterrissou torna a tentativa perdedora
              //   demonstravelmente redundante.
              return r.code === "landed";
            },
            now,
            dryRun: process.env.USM_BRANCH_GC_ENABLED === "0",
            journal: appendBranchGcJournal,
            advisedThisRun: branchGcAdvised,
          });
        },
        // Reconcilia os `deploy-failure` contra a realidade publicada, em TODO board. É o backstop que cobre a
        // publicação feita FORA do serviço (`just orch-deploy` no shell não passa pelo ProductDeployRegistry,
        // logo não dispara onDone): sem ele o card fica com o alarme aberto para sempre, mesmo com o código no
        // ar — o deadlock que travou acme/story-99wmbx e acme/story-dfbig1 por 5 dias. Barato: só cards COM o
        // finding aberto chegam a tocar git (o caso normal é zero e nem abre subprocesso).
        runDeployReconcile: async () => {
          const [{ reconcileBoardDeployFailures }, { listBoards }] = await Promise.all([
            import("@/lib/storymap/runner/deploy-reconcile"),
            import("@/lib/storymap/repo"),
          ]);
          for (const b of await listBoards()) await reconcileBoardDeployFailures(b.id);
        },
        // autonomo-liberdade-humana M2 — prune the soft-delete trash past its 7-day window, every board. Board-data
        // fs ops only (no git subprocess), so it never contends with the train. Best-effort by contract.
        runTrashGc: async () => {
          const { runTrashGc } = await import("@/lib/storymap/runner/trash-gc");
          await runTrashGc();
        },
        // Forget the fleet registry rows of long-dead sessions with nothing to lose — the ADOPTED zombies the
        // worktree reaper could never reach (it only ever touched worktrees, and an adopted session has none),
        // so their rows piled up for days (8 of 10 fleet rows measured in prod). Fail-closed selection
        // (session-gc.ts): never a live session, never one still holding an un-integrated branch, never an
        // orphaned integration (a demand). discard is the SAME fail-closed teardown the MCP tool uses, so even a
        // mis-pick preserves committed code. Same idle window as branch-gc (an isolated discard may touch git).
        runSessionGc: async () => {
          const [
            { runSessionGc, appendSessionGcJournal, sessionGcGraceMs },
            { allSessions, defaultSessionWorktreeDeps, discardSessionWorktree },
            { getMergeQueue },
            { listSessions },
            { findRepoRoot },
          ] = await Promise.all([
            import("@/lib/storymap/runner/session-gc"),
            import("@/lib/storymap/runner/session-worktree"),
            import("@/lib/storymap/runner/merge-queue"),
            import("@/lib/vps/tmux"),
            import("@/lib/storymap/paths"),
          ]);
          const mq = getMergeQueue();
          const worktreeDeps = defaultSessionWorktreeDeps({
            repoRoot: findRepoRoot(),
            ensureRunBase: () => mq.ensureRunBase(),
            enqueueMerge: (entry) => mq.enqueueMerge(entry),
            liveRunIds: () => mq.liveRunIds(),
          });
          await runSessionGc({
            listSessions: () => allSessions(),
            trainEntries: async () => mq.getSnapshot().entries.map((e) => ({ runId: e.runId, status: e.status })),
            liveTmux: async () => (await listSessions()).map((s) => s.name),
            discard: (sessionId) => discardSessionWorktree(worktreeDeps, { sessionId }),
            journal: appendSessionGcJournal,
            graceMs: sessionGcGraceMs(),
          });
        },
        // P-3 — roda ANTES do portão de ociosidade, porque a cabeça travada é o que fecha o portão. Não
        // faz IO de git (só lê o estado da fila) e só age com o processador comprovadamente morto.
        sweepStuckEntries: async () => {
          const res = await getMergeQueue().sweepStuck();
          if (res.swept > 0) {
            console.error(`[harness-sweep] destravei ${res.swept} entrada(s) travada(s) na cabeça do train: ${res.runIds.join(", ")}`);
          }
        },
        // P-3b — e o tick que o train nunca teve. Destravar a cabeça sem bombear o laço só troca uma fila
        // parada por outra; e a pausa por árvore suja sai do laço sem gerar evento de retomada nenhum.
        // In-memory, idempotente: um tick sem trabalho é no-op silencioso.
        pumpMergeQueue: async () => {
          const res = await getMergeQueue().pump();
          if (res.pumped) console.warn(`[harness-sweep] re-cutuquei o train: ${res.waiting} entrada(s) esperando`);
        },
        // P-9 — as duas varreduras baratas que faltavam. CLAIMS: `sweepExpired` já existia e só era
        // chamada pelo reconciliador da frota, que depende de tmux — então uma reserva vencida de uma
        // sessão sem tmux ficava viva para sempre (medido: 58 de 58 claims expirados no runtime, sem uma
        // única poda). Não faz git; roda com o resto da manutenção.
        runClaimsGc: async () => {
          const { getCardClaims } = await import("@/lib/storymap/runner/claims");
          const freed = await getCardClaims().sweepExpired();
          if (freed.length > 0) console.log(`[harness-sweep] ${freed.length} claim(s) vencido(s) liberado(s)`);
        },
        // ÁRVORES órfãs (`gate-*`/`run-*` sem dono). NUNCA toca `agent-*`: sessão fica ociosa por
        // desenho, o julgamento dela é outro, e já ceifamos uma árvore de agente uma vez.
        runWorktreeGc: async () => {
          const [
            { runWorktreeGc },
            { defaultExec },
            { findRepoRoot },
            { getRunnerRegistry },
            path,
            fsp,
          ] = await Promise.all([
            import("@/lib/storymap/runner/worktree-gc"),
            import("@/lib/storymap/runner/worktree"),
            import("@/lib/storymap/paths"),
            import("@/lib/storymap/runner/registry"),
            import("node:path"),
            import("node:fs/promises"),
          ]);
          const repoRoot = findRepoRoot();
          const root = path.join(repoRoot, ".worktrees");
          const q = (s: string) => JSON.stringify(s);
          const mq = getMergeQueue();
          const res = await runWorktreeGc({
            listDirs: async () => {
              const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
              return entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: path.join(root, e.name) }));
            },
            facts: async () => ({
              activeRunIds: new Set(await mq.activeRunIds()),
              allRunIds: new Set(await mq.allRunIds()),
              liveRunIds: new Set(getRunnerRegistry().snapshot().running.map((r) => r.sessionId)),
            }),
            // A PRIMEIRA pergunta (incidente 2026-07-27): o git conhece esta pasta como worktree? As 4
            // pastas `run-*` do runtime NÃO eram — o registro delas já tinha sido podado —, e como
            // ficam DENTRO do repo, todo `git -C <pasta>` subia e respondia sobre o repo PRINCIPAL.
            // Foi assim que um "resgate" commitou na main com uma mensagem que promete outro branch.
            isRegisteredWorktree: async (p) => {
              const { stdout } = await defaultExec(`git worktree list --porcelain`, { cwd: repoRoot, timeout: 15_000 });
              return String(stdout ?? "")
                .split("\n")
                .some((line) => line.trim() === `worktree ${p}`);
            },
            isDirty: async (p) => {
              const { stdout } = await defaultExec(`git status --porcelain`, { cwd: p, timeout: 15_000 });
              return String(stdout ?? "").trim().length > 0;
            },
            remove: async (p) => {
              try {
                await defaultExec(`git worktree remove ${q(p)} --force`, { cwd: repoRoot, timeout: 30_000 });
                await defaultExec(`git worktree prune`, { cwd: repoRoot, timeout: 15_000 }).catch(() => {});
                return true;
              } catch {
                return false;
              }
            },
            // O MESMO resgate que o teardown de sessão usa — commita o não-commitado e preserva o
            // branch antes do `--force`. Sem ele o GC era um no-op ruidoso: medido no primeiro tick em
            // produção, 5 órfãs detectadas, 5 preservadas por sujeira, 0 removidas. Ele LANÇA quando não
            // consegue salvar (ex.: secret-scan), e é assim que a árvore fica intocável.
            rescue: async (p, branch) => {
              const { rescueUncommitted, defaultWorktreeFs } = await import("@/lib/storymap/runner/worktree");
              return rescueUncommitted(defaultExec, defaultWorktreeFs, p, repoRoot, branch);
            },
            journal: (v) =>
              console.log(
                `[harness-worktree-gc] ${v.name}: ${v.action}${v.removed ? " (removida)" : ""}${v.rescued ? " (trabalho SALVO)" : ""} — ${v.reason}`,
              ),
            // Dedupe por PROCESSO das linhas sem ação (o Set vive fora do tick, ao lado do branchGcAdvised).
            journaledThisRun: worktreeGcJournaled,
          });
          // O resumo é a MESMA não-notícia enquanto os números não mudam — e ele escapou do dedupe da
          // primeira versão, então seguiu repetindo a cada 2min exatamente o defeito que essa versão
          // tinha ido corrigir. Fala quando MUDA; silêncio aqui significa "nada mudou".
          const summary = `${res.scanned} árvore(s) varrida(s): ${res.removed} removida(s), ${res.rescued} com trabalho salvo, ${res.keptDirty} preservada(s), ${res.orphanDirs} diretório(s) órfão(s)`;
          if (summary !== lastWorktreeGcSummary && (res.removed > 0 || res.rescued > 0 || res.keptDirty > 0 || res.orphanDirs > 0)) {
            lastWorktreeGcSummary = summary;
            console.log(`[harness-worktree-gc] ${summary}`);
          }
        },
      });

      // O ALARME. Um tick que pula não é um não-evento — é o subsistema deixando de existir.
      // `ran-starved` conta como RODOU (zera a streak): o escape de inanição rodou a recovery apesar do
      // "ocupado" — foi exatamente para isso que a streak passou a ser um input, e não só um contador.
      if (status === "ran-starved") {
        console.warn(
          `[harness-sweep] escape de inanição: rodei a recovery MESMO ocupado (${skipStreak} pulos seguidos${idleBlockedBy ? ` — ${idleBlockedBy}` : ""}). ` +
            `O que bloqueava podia SER o trabalho preso que a recovery existe para resgatar. Branch GC e deploy-reconcile ficam para o próximo tick ocioso.`,
        );
      }
      if (status === "ran" || status === "ran-starved") {
        if (skipStreak >= SWEEP_ALARM_EVERY) {
          console.log(`[harness-sweep] voltou a rodar (estava pulando há ${skipStreak} ticks).`);
        }
        skipStreak = 0;
      } else {
        skipStreak++;
        const why = status === "skipped-busy" ? ` — ${idleBlockedBy ?? "ocupado"}` : "";
        // grita no 1º skip (barato, informativo) e depois a cada SWEEP_ALARM_EVERY (~1h) — nunca em silêncio.
        if (skipStreak === 1 || skipStreak % SWEEP_ALARM_EVERY === 0) {
          const level = skipStreak >= SWEEP_ALARM_EVERY ? console.warn : console.log;
          level(
            `[harness-sweep] PULADO ${skipStreak}x seguidas (${status})${why}. ` +
              `Enquanto pula, NÃO rodam: recuperação de runs órfãos, branch GC e reconciliação de deploy-failure.`,
          );
        }
      }
      return status;
    };

    startRecoverySweep({ intervalMs: sweepMs, tick: runSweepTick });
    // story-harness-adk G4b: ALSO run the sweep EVENT-DRIVEN — the moment the engine drains (a run settled
    // and nothing is in flight), pick up an orphaned resumable run NOW instead of waiting up to a full
    // interval for the next poll. The tick is idempotent + idle-gated (merge-train + engine), so an extra
    // firing is a safe no-op; the periodic timer stays as the safety net (covers a stall with NO completion).
    engine.onIdle(() => void runSweepTick());
    console.log(`[harness-boot] recovery sweep armado a cada ${Math.round(sweepMs / 1000)}s (idle-gated + on-idle)`);
  }

  // 2.3c) A VARREDURA DA RAIZ DE SCRATCH (runner/temp.ts). Ela existe para o caso que NÃO tem
  //       `finally` possível: um filho `detached` que sobrevive ao pai. MEDIDO: 1044 diretórios
  //       órfãos vieram dos 3 sites que limpavam dentro de um handler, e o maior deles (841) só
  //       removia em `child.on("exit")` — se o serviço reinicia antes de o filho sair, esse handler
  //       nunca roda. Nenhum conserto local alcança isso; alguém tem de varrer depois, e o boot é a
  //       hora certa: é exatamente quando os órfãos do processo anterior existem e ninguém mais
  //       responde por eles.
  //
  //       A janela é generosa DE PROPÓSITO (24h, ~20x a maior duração já observada num run e 24x o
  //       teto duro): varrer curto trocaria órfão por corrupção — apagar o scratch de um processo
  //       vivo. E o resultado é REPORTADO: uma limpeza que ninguém vê é indistinguível de não ter
  //       tido o que limpar, que é justamente como esta classe ficou invisível por 29 dias.
  void (async () => {
    try {
      const { sweepHarnessTempRoot, harnessTempRoot } = await import("@/lib/storymap/runner/temp");
      const r = await sweepHarnessTempRoot();
      if (r.removidos.length > 0 || r.erros > 0)
        console.log(
          `[harness-boot] scratch: ${r.removidos.length} diretório(s) abandonado(s) removido(s) de ${harnessTempRoot()}` +
            `${r.erros > 0 ? ` (${r.erros} inacessível(is))` : ""}`,
        );
    } catch (err) {
      console.warn("[harness-boot] varredura de scratch falhou (não-fatal):", err instanceof Error ? err.message : err);
    }
  })();

  // 2.4b) A FILA DE PUBLICAÇÃO (runner/publish-queue) — drena "publique este sha quando der" na MESMA
  //       janela de ociosidade do sweep. Fecha o único trecho da entrega que ainda exigia card: o train
  //       já integra trabalho de sessão, mas promote+deploy é onEnter de um PASSO, e passo quem atravessa
  //       é card — então trabalho de sessão encalhava em `stage`.
  //
  //       DENTRO do serviço, de propósito. Um daemon externo (systemd) seria um TERCEIRO escritor na
  //       árvore de trabalho de `main` que o train também mexe, e a proteção contra isso é operacional,
  //       não um lock — exatamente o cenário que o clean-gate parqueia. Aqui compartilhamos processo com
  //       o train, então herdamos a serialização que já existe.
  //
  //       Gatilho duplo pelo mesmo motivo do sweep: `onIdle` publica no INSTANTE em que o pipeline
  //       esvazia (sem esperar até um intervalo inteiro) e o timer é a rede de segurança para o caso em
  //       que nada mais completa (pedido enfileirado com o sistema já parado — não haveria evento algum).
  {
    const { drainPublishQueue, defaultPublishQueueStore, registerPublishDrainTrigger, drainDeferred, reapInterruptedAtBoot, enqueuePublish, listPublishRequests } = await import("@/lib/storymap/runner/publish-queue");
    const { listBoards, readBoardConfig } = await import("@/lib/storymap/repo");
    const { releaseModeOf, shouldAutoEnqueue } = await import("@/lib/storymap/release-policy");
    const { frontierOf } = await import("@/lib/storymap/runner/delivery-deps");
    const { defaultExec } = await import("@/lib/storymap/runner/worktree");
    const { publishAgentAlert } = await import("@/lib/notifications/server/alert-bus");
    const { ALERT_URGENCY } = await import("@/lib/notifications/event");
    const { firePromoteAndDeploy } = await import("@/lib/storymap/runner/entry-effects");
    const { stagingShaOf } = await import("@/lib/storymap/runner/publish-git");

    // Retry CURTO quando o dreno dispara com o pipeline ainda ASSENTANDO (`skipped-busy`) ou o pedido segue
    // segurado por algo transitório (`held`: concurrent-work de uma sessão que está integrando). Sem ele o
    // próximo gatilho é o sweep esparso (medido 2026-07-24: ~5-10min de espera pura DEPOIS de o trabalho já
    // ter ficado publicável — o nudge/onIdle disparou cedo demais e nada re-tentou). Um gatilho FRESCO
    // reabastece o orçamento; cada retry o consome; um só timer pendente por vez (guard `!drainRetryTimer`,
    // então N gatilhos ~simultâneos não viram enxame). Pipeline genuinamente ocupado (run longo) ⇒ o retry
    // vira no-op idle-gated e o orçamento zera — o `onIdle` pega quando o run terminar. Publicar reinicia o
    // serviço, então nenhum timer sobrevive a uma publicação.
    const DRAIN_RETRY_MS = 15_000;
    const DRAIN_RETRY_BUDGET = 4; // ~60s de re-tentativas curtas após um gatilho, depois cai no onIdle/sweep
    let drainRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let drainRetriesLeft = 0;

    // A ETA que o dreno grava nos pedidos que ficam esperando. É DERIVADA do estado real dos timers deste
    // bloco — a única forma de ela não virar uma segunda verdade sobre a cadência: com orçamento de retry
    // sobrando, a próxima batida é a curta; esgotado, é o sweep esparso. É este número que faz "33
    // tentativas" deixar de ser um número sem eixo na tela da Entrega.
    const retryEtaMs = (): number => (drainRetriesLeft > 0 ? DRAIN_RETRY_MS : sweepMs);

    /**
     * O PRODUTOR do modo `auto` — a metade "publica sozinho" da política de release.
     *
     * Sem ele, `auto` dependeria de cada agente lembrar de chamar `publish_when_idle` depois do submit:
     * funcionava por hábito, não por construção. Com ele, o board declara o modo e o sistema cumpre.
     *
     * Best-effort e silencioso no caminho feliz: é um tick, não uma operação do usuário. Só loga quando
     * de fato abre um pedido, porque aí houve um efeito que alguém pode querer explicar depois.
     */
    const enqueueAutoBoards = async () => {
      try {
        const boards = await listBoards().catch(() => []);
        const open = await listPublishRequests().catch(() => []);
        for (const { id: board } of boards) {
          const mode = releaseModeOf(await readBoardConfig(board).catch(() => null));
          if (mode !== "auto") continue; // o caso comum sai daqui sem tocar git
          const frontier = await frontierOf(board, defaultExec).catch(() => null);
          if (!frontier?.stageSha) continue;
          const hasOpenRequest = open.some(
            (r) => r.board === board && (r.status === "waiting" || r.status === "publishing"),
          );
          if (!shouldAutoEnqueue({ mode, stagedTotal: frontier.stagedTotal, hasOpenRequest })) continue;
          const { request, deduped } = await enqueuePublish({
            board,
            requestedSha: frontier.stageSha,
            requestedBy: "auto",
            allowNewer: false,
          });
          if (!deduped) {
            console.warn(
              `[harness-publish] auto: ${board} tem ${frontier.stagedTotal} entrega(s) staged e release.mode=auto ` +
                `— pedido ${request.id} aberto para ${frontier.stageSha.slice(0, 8)}`,
            );
          }
        }
      } catch (e) {
        console.warn("[harness-publish] produtor auto falhou (segue para o dreno):", e instanceof Error ? e.message : e);
      }
    };

    const drainTick = async (isRetry = false) => {
      const cfg = loadRunnerConfig().autorun;
      const pq = cfg.publishQueue;
      if (!pq?.enabled) return; // kill-switch global desligado ⇒ nem lê o disco
      // O PRODUTOR do modo `auto`: é ele que faz "publica sozinho" ser uma propriedade do SISTEMA, e
      // não do agente lembrar de chamar a tool depois de cada submit. Roda antes do dreno para que o
      // pedido que ele cria já seja servido nesta mesma batida.
      await enqueueAutoBoards();
      const outcome = await drainPublishQueue({
        store: defaultPublishQueueStore(),
        // Fail-CLOSED aqui (o default): este caller REINICIA o serviço. Sondar errado e publicar mesmo
        // assim derruba run em voo — a dúvida tem de custar espera, nunca risco.
        idle: () =>
          pipelineIdle({
            hasInFlight: () => engine.hasInFlight(),
            // activeRunIds: publicar não pode esperar um conflito PARKEADO sair — ele espera um humano.
            // Com liveRunIds isto era um impasse circular (publicar→ociosidade→parkeado→humano), e os
            // pedidos ficavam `waiting` para sempre sem uma linha de log dizendo por quê.
            liveMergeEntries: () => getMergeQueue().activeRunIds(),
          }),
        stageSha: stagingShaOf,
        // Quem SERVE o pedido não olha o modo do board: um pedido existente é publicado do mesmo jeito,
        // tenha sido pedido por humano, por agente autorizado ou pelo produtor do `auto`. O que ainda
        // pode mudar entre ticks é o kill-switch global, e por isso ele é RE-LIDO aqui.
        boardEnabled: () => !!loadRunnerConfig().autorun.publishQueue?.enabled,
        // Traduz o veredito do release para o que a fila precisa decidir. `revert:false` significa que o
        // código ESTÁ em main (promovido agora ou já estava) — é a única coisa que autoriza `published`.
        // `concurrent-work` é adiamento, não defeito: volta para `waiting` e o próximo tick tenta sozinho.
        publish: async (board, excludeSessionId, publishOpts) => {
          // excludeSessionId = a sessão que pediu (o dono do trabalho staged). A sonda de concorrência da
          // promoção tem de ignorá-la — o trabalho dela É o que vai ao ar —, senão o fluxo documentado
          // (submit → publish_when_idle → discard) trava: o promote adia por `concurrent-work` a cada tick
          // e nunca aterrissa até a sessão ser descartada.
          const r = await firePromoteAndDeploy(board, undefined, {
            excludeSessionId,
            // A dispensa do embargo viaja COM o pedido (não é um knob global): quem publica sem a guarda é
            // só o pedido em que alguém pediu isso explicitamente.
            overrideEmbargo: publishOpts?.overrideEmbargo,
          });
          return { landed: !r.revert, deferred: r.outcome === "concurrent-work", reason: r.reason, heldBy: r.heldBy };
        },
        retryEtaMs,
        // A BORDA de "isto virou bloqueio". Um aviso só, na transição — nunca por tentativa (seriam
        // dezenas). `blocking` porque a publicação de fato não anda sem alguém: ou o trabalho sobreposto
        // integra, ou alguém dispensa o embargo. Leva direto para a Entrega, onde ficam os dois botões.
        onBlocked: (req) => {
          publishAgentAlert({
            id: `publish-blocked-${req.id}`,
            kind: "publish-blocked",
            urgency: ALERT_URGENCY["publish-blocked"],
            at: Date.now(),
            title: "Publicação bloqueada",
            body:
              `O pedido do board ${req.board} já foi adiado ${req.heldCount ?? 0}x. ` +
              (req.reason ?? "Sem motivo registrado."),
            tag: `publish-blocked-${req.board}`,
            url: `/board/${req.board}/entrega`,
            boardId: req.board,
            push: true,
          });
        },
      }).catch((err) => {
        console.error("[harness-publish] dreno falhou:", err instanceof Error ? err.message : err);
        return null;
      });
      // Silêncio só para o caso comum (fila vazia). Todo desfecho que MUDA algo, ou que explica por que
      // nada mudou, aparece — um dreno mudo é indistinguível de um dreno morto.
      // O comentário acima sempre disse "todo desfecho que explica por que nada mudou aparece" — mas o
      // filtro calava `skipped-busy`, que é EXATAMENTE esse desfecho. Foi o que deixou a fila passar dois
      // dias sem publicar e sem uma linha de log: um pedido `waiting` para sempre lia-se igual a um board
      // ocioso. Agora ele fala, com o motivo, e no máximo uma vez a cada 10min (é o intervalo do sweep).
      if (outcome && outcome.status !== "empty") {
        console.log(`[harness-publish] ${JSON.stringify(outcome)}`);
      }
      // Desfecho TRANSITÓRIO (assentando) com trabalho ainda na fila ⇒ re-tenta em segundos, em vez de
      // esperar o próximo tick esparso do sweep. `drainDeferred` decide (skipped-busy / held).
      if (drainDeferred(outcome)) {
        if (!isRetry) drainRetriesLeft = DRAIN_RETRY_BUDGET; // gatilho fresco reabastece o orçamento
        if (drainRetriesLeft > 0 && !drainRetryTimer) {
          drainRetriesLeft--;
          drainRetryTimer = setTimeout(() => {
            drainRetryTimer = null;
            void drainTick(true);
          }, DRAIN_RETRY_MS);
        }
      } else if (drainRetryTimer) {
        // resolvido (published/superseded/failed) ou fila vazia ⇒ cancela qualquer retry pendente.
        clearTimeout(drainRetryTimer);
        drainRetryTimer = null;
        drainRetriesLeft = 0;
      }
    };

    // O reap de boot: todo `publishing` órfão vira `interrupted` UMA vez, aqui, PERSISTIDO — antes de
    // qualquer dreno. Saiu do `store.load()` porque lá ele mentia sobre publicação em voo (ver o doc de
    // `reapInterrupted`); a trava contra o laço de deploy nunca dependeu dele.
    const reaped = await reapInterruptedAtBoot();
    if (reaped > 0) console.warn(`[harness-publish] ${reaped} pedido(s) interrompido(s) por restart, marcados no boot`);

    startRecoverySweep({ intervalMs: sweepMs, tick: drainTick });
    engine.onIdle(() => void drainTick());
    // ...E no SETTLE do MERGE TRAIN (2026-07-24). A sonda de ociosidade do dreno considera o train
    // (`activeRunIds`), mas os GATILHOS só olhavam o engine — e trabalho de SESSÃO (sem run no engine) só
    // fica publicável quando o TRAIN esvazia, uma borda que `engine.onIdle` nunca vê (o engine ficou ocioso
    // o tempo todo). Sem ela, o nudge no enqueue corre contra a cauda do train e, se perde, o pedido caía no
    // sweep de ~10min. `onEntrySettled` dispara também para entrada de sessão SEM card (que `onMergeDone`
    // pula de propósito); idle-gated ⇒ no-op barato a cada settle até o train de fato esvaziar.
    getMergeQueue().onEntrySettled(() => void drainTick());
    // NUDGE no ENQUEUE (quarto gatilho): um publish_when_idle pedido com o pipeline JÁ ocioso não gera
    // transição de idle nem settle, então nenhuma borda dispara e o pedido esperaria um intervalo INTEIRO do
    // sweep (~10min) — lento justo quando o sistema está mais parado. O enqueue cutuca o dreno por este
    // gatilho; é idle-gated + guardado contra concorrência, então cutucar sem trabalho publicável é no-op.
    registerPublishDrainTrigger(() => void drainTick());
    console.log(`[harness-boot] fila de publicação armada (idle-gated + on-idle + on-settle + on-enqueue; ligada por settings)`);
  }

  // 2.5b) WS-4.4 (parallel-work) — the CLAIM sweep: free every card reservation whose TTL lapsed, so an
  //       orphaned claim (a session that died, a holder that vanished) can never wedge a card. Deliberately
  //       NOT idle-gated, unlike the recovery sweep above: reservations expire while OTHER runs are in flight,
  //       and an "only when the board is quiet" sweep would leave exactly the busy boards stuck. Cheap (an
  //       in-memory scan + at most one write when something actually frees) and idempotent, so a 60s cadence
  //       costs nothing on an idle board. The dead-SESSION probe (releasing on `session-died` before the TTL)
  //       is WS-6's fleet liveness — passed in here once it exists; until then the TTL is the backstop.
  const CLAIM_SWEEP_MS = 60_000;
  const claimTimer = setInterval(() => {
    void (async () => {
      try {
        const { getCardClaims } = await import("@/lib/storymap/runner/claims");
        await getCardClaims().sweepExpired();
      } catch (err) {
        console.error("[harness-claims] sweep falhou:", err instanceof Error ? err.message : err);
      }
    })();
  }, CLAIM_SWEEP_MS);
  // Never hold the event loop open for a reservation sweep (mirrors every other timer here).
  (claimTimer as unknown as { unref?: () => void }).unref?.();

  // 2.6) WS8 (F7) — the board COPILOTO/orchestrator TICK. In-process, re-arming, unref'd (mirrors the
  //      recovery sweep). Per tick it does a ZERO-TOKEN pre-check (the board's ACTIONABLE cockpit) and, when
  //      there's work + budget + no lease, spawns the storymap-orchestrator skill to act gate-respecting. An
  //      idle board costs nothing (no LLM spawn). STORYMAP_ORCH_ENABLED=0/1.
  //
  //      O timer é armado SEMPRE (não mais só quando `enabled`): o gate de enabled vive DENTRO do tick
  //      (buildTickDeps re-lê settings a cada ciclo e runOrchestratorTick devolve [] na hora quando desligado,
  //      custo zero). Antes, o timer só nascia se `enabled` estivesse true NO BOOT — por isso o toggle
  //      "Jido ligado" pedia restart do serviço, o que derruba runs em voo. Agora ligar/desligar e mudar a
  //      cadência valem no ciclo seguinte, sem restart.
  try {
    const [{ runOrchestratorTick, startOrchestratorTick }, { buildTickDeps }, { armClock, disarmClock }] =
      await Promise.all([
        import("@/lib/storymap/runner/orchestrator-tick"),
        import("@/lib/storymap/runner/orchestrator-run"),
        import("@/lib/storymap/runner/orchestrator-clock"),
      ]);
    // Item 2 — as deps do tick moram em orchestrator-run (buildTickDeps): UMA fonte, reusada pelo tick IMEDIATO
    // (toggle) e pelo WAKE por evento (orchestrator-wake).
    const runOrchTick = () => runOrchestratorTick(buildTickDeps());
    startOrchestratorTick({
      // função ⇒ re-lida a cada re-arm: mudar tickMinutes em settings vale no ciclo seguinte (sem restart).
      intervalMs: () => (loadRunnerConfig().orchestrator?.tickMinutes ?? 30) * 60_000,
      tick: runOrchTick,
      // alimenta o relógio que o header lê ("age em 12min") — sem isto a UI só sabia a cadência, não o horário.
      onArm: (nextTickAt, intervalMs) => armClock(nextTickAt, intervalMs),
      onStop: () => disarmClock(),
    });
    const orchMin = loadRunnerConfig().orchestrator?.tickMinutes ?? 30;
    console.log(`[harness-boot] copiloto (orchestrator) armado a cada ${orchMin}min (pré-check zero-token, gate ao vivo)`);

    // WAKE por evento — o Jido autônomo não espera o próximo tick p/ ver um run que MORREU ou um conflito
    // do merge train: esses vivem na telemetria/registry (não em arquivos de board), então NÃO passam pelo
    // watcher de notificações. O onIdle do engine (o runner drenou) é o gatilho exato. As demais fontes (card
    // travado/movido, finding, pergunta, item na fila de decisão) chegam pelo copilot-wake-channel.
    const { wakeAutonomousBoards } = await import("@/lib/storymap/runner/orchestrator-wake");
    engine.onIdle(() => void wakeAutonomousBoards("um run terminou"));
  } catch (err) {
    console.error("[harness-boot] orchestrator tick wiring falhou:", err instanceof Error ? err.message : err);
  }

  // story-43w10w (task t4): drain the merge train before the process dies. Without this, a
  // SIGTERM from update_vps/systemd can land mid-merge, leaving the working tree dirty → the
  // next boot's recover() marks the entry `conflict` and freezes the whole queue. With a
  // graceful drain, the merge either completes (no mid-merge crash) or the signal arrives
  // before the merge starts (tree clean → boot recover re-drives it as `waiting`).
  // Timeout: 10 s — generous enough for a normal merge, short enough not to block restarts.
  const DRAIN_TIMEOUT_MS = 10_000;
  process.once("SIGTERM", () => {
    const timer = setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    getMergeQueue()
      .whenIdle()
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        process.exit(0);
      });
  });

  // Always log (observability): confirms instrumentation ran + the watcher booted, and reports
  // the recovery outcome even when nothing was interrupted.
  console.log(
    `[harness-boot] pronto — watcher no boot ativo; recovery: ${recovered.interrupted} interrompido(s) → ` +
      `${recovered.respawned} retomado(s), ${recovered.dropped} descartado(s), ${recovered.skipped} pulado(s), ` +
      `${recovered.deferred} adiado(s) (scope vivo); ` +
      `merge-queue: ${mqRecovery.loaded} entrada(s) → ${mqRecovery.resetToConflict} em conflito (árvore suja), ` +
      `${mqRecovery.resumed} retomado(s) (árvore limpa), ${mqRecovery.pruned} podado(s) (superados), ` +
      `${mqRecovery.resetGateFailed} gate reprovado (reinício), ${mqRecovery.waiting} aguardando merge; ` +
      `test-queue: ${testQueueRecovered} teste(s) re-disparado(s); ` +
      `onEnter pendentes: ${effectsRecovery.pending} → ${effectsRecovery.refired} re-disparado(s), ` +
      `${effectsRecovery.dropped} descartado(s) (card removido), ${effectsRecovery.skipped} pulado(s) (resume off), ` +
      `${effectsRecovery.deferred} adiado(s) (deploy de produto não auto-dispara no boot), ` +
      `${effectsRecovery.failed} falhou/falharam (finding gravado no card)`,
  );
}
