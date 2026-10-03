// fleet-deps — WS-6.4: the PRODUCTION wiring of the FLEET (the page, the API route, the boot tick and any
// future steward all read/reconcile the same registries, through the same factories).
//
// A separate file from fleet-view.ts on purpose: fleet-view is pure + DI (unit-tested with fakes), while this
// is the half that knows about disk, tmux and the live merge train. It is also what keeps the Next page from
// importing the MCP tool module just to reach a dep factory.

import { existsSync, promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { readInheritedDefaultMode } from "./claude-settings";
import { getMergeQueue } from "./merge-queue";
import {
  allSessions,
  defaultSessionWorktreeDeps,
  reconcileFleet,
  sessionWorkSettled,
  type FleetReconcileResult,
  type SessionWorktreeDeps,
} from "./session-worktree";
import { getCardClaims, sessionClaimActor } from "./claims";
import { loadRunnerConfig } from "./config";
import { cpus } from "node:os";
import { probeVpsResources } from "./scheduler";
import { isActiveMergeStatus } from "./merge-status";
import { quotaPace } from "./card-budget";
import { extraSlotBoardVerdict, extraSlotVerdict, gateCoresBetween, type ExtraSlotFacts } from "./extra-slot";
import { GATE_SLICE } from "./gate-sandbox";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";
import { cardPath, findRepoRoot, runnerStateDir, trashedCardPath } from "@/lib/storymap/paths";
import { readTransitions } from "./transitions";
import { findNewTranscript, RECYCLE_THRESHOLD } from "@/lib/vps/claude-transcript";
import { readSessionContext } from "@/lib/vps/transcript-usage";
import {
  deliverToSession,
  ensureDetachedSession,
  hasSession,
  killSession,
  listSessions,
  probeLiveTmuxSessions,
  sessionRunsClaude,
} from "@/lib/vps/tmux";
import { listBoards, readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import { resolveCardRoute } from "./config";
import { getCapacityGovernor } from "./capacity-service";
import { resolvedClaudeBin } from "./claude-bin";
import { hostNeedsRootBypass, pollSessionAlive, spawnWorkSession, type SessionSpawnDeps } from "./session-spawn";
import { isSessionAlive } from "./session-liveness";
import { upsertFindingIfChanged } from "./findings";
import { currentTerminalAttention } from "@/lib/terminal/attention-watch";
import {
  admitConductorCard,
  cardMissingDecision,
  CONDUCTOR_DISPATCH_FINDING_ID,
  conductorSlotFacts,
  countLiveConductorsByBoard,
  diskConductorQueueStore,
  finishedConductors,
  isLiveConductor,
  type ConductorSlotFacts,
  endFinishedConductors,
  endOrphanConductorTerminals,
  pumpConductorQueue,
  type ConductorDeps,
  type ConductorEndDeps,
  type ConductorEndReport,
  type ConductorEndState,
  type ConductorOrphanReport,
  type ConductorOrphanState,
  type ConductorPumpReport,
  type QueuedCardMiss,
} from "./conductor";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { readWorktreeSessionCost } from "@/lib/vps/session-cost";
import { recordSessionSpend, type SessionTelemetryDeps } from "./session-telemetry";
import { getTelemetryStore } from "./telemetry";
import type { AgentSession } from "./session-worktree";
import { resolveConductorPolicy, withDriver, withoutDriver } from "@/lib/storymap/driver";
import { maybeSweepProxy } from "./proxy-deps";
import { maybeSweepTriageJudge } from "./triage-judge-deps";
import { maybeSweepDeployProofs } from "./deploy-proof-deps";
import { maybeSweepTechnicalAudits } from "./technical-audit-deps";
import { maybeSendWeeklySummary } from "./weekly-summary-push";
import type { CollectFleetDeps } from "./fleet-view";
import type { CardClaim } from "./claims";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { boardGateNow } from "./board-pace-store";

/** Every registry the fleet row joins, wired to production. Each reader is best-effort AT THE CALL SITE
 *  (collectFleet catches): a cold merge queue must degrade a column, never 500 the page. */
export function defaultFleetDeps(): CollectFleetDeps {
  return {
    sessions: () => allSessions(),
    // Live AND released: a row shows its reservation, and `isClaimLive` in the join is what filters — asking
    // for "live only" here would silently hide a tombstone the operator may need to understand.
    claims: async (): Promise<CardClaim[]> => getCardClaims().list(),
    entries: async () => getMergeQueue().getSnapshot().entries,
    liveTmux: async () => (await listSessions()).map((s) => s.name),
    // A MESMA leitura do medidor dos terminais (`readSessionContext`), e não o `computeContextPct`
    // legado: aquele fixa a janela em 200k e ainda CLAMPA em 100%, então uma sessão de 1M aparecia
    // eternamente "contexto 100% · reciclar" com 26% de uso — e o operador reciclava trabalho vivo.
    contextPct: (file, hints) => readSessionContext(file, hints?.model, hints?.cwd).then((c) => c?.pct ?? null),
    cardTitle: async (board, cardId) => (await readCard(board, cardId))?.title ?? null,
    recycleThresholdPct: RECYCLE_THRESHOLD,
  };
}

/**
 * As deps do ciclo de vida do worktree de sessão, resolvidas POR CHAMADA (nunca cacheadas): o cap e os
 * limiares saem do `settings.yaml` VIVO, então o operador retuna capacidade sem restart — a mesma
 * disciplina de hot-reload do merge gate. A base, a fila e o check de run vivo vêm do ÚNICO merge train:
 * uma sessão integra pela mesma porta que um run.
 *
 * Morava dentro de `mcp/dev-tools.ts`, o que obrigava qualquer outro consumidor (o tick de boot abaixo) a
 * importar o módulo de TOOLS só para alcançar uma fábrica de deps.
 */
export function defaultSessionDeps(): SessionWorktreeDeps {
  const mq = getMergeQueue();
  const autorun = loadRunnerConfig().autorun;
  return {
    ...defaultSessionWorktreeDeps({
      repoRoot: findRepoRoot(),
      ensureRunBase: () => mq.ensureRunBase(),
      enqueueMerge: (entry) => mq.enqueueMerge(entry),
      liveRunIds: () => mq.liveRunIds(),
      maxWorktrees: autorun.sessions?.maxWorktrees,
      thresholds: autorun.scheduler?.thresholds,
    }),
    // The session is LEAVING the registry (worktree_discard): the last moment the service still knows its tree,
    // so a conductor's spend is booked here (session-telemetry.ts), and its conductor slot is re-offered to the
    // queue right away instead of on the next fleet tick.
    onSessionEnd: async (s) => {
      await recordSessionSpend(sessionTelemetryDeps(), s).catch((err) =>
        console.error("[session-cost] registro no descarte falhou:", err instanceof Error ? err.message : err),
      );
      if (s.driver === "conductor") void pumpConductorsNow().catch(() => {});
    },
  };
}

/** Production deps of the session-spend bookkeeping: the run ledger + the worktree's transcripts. */
export function sessionTelemetryDeps(): SessionTelemetryDeps {
  return {
    telemetry: getTelemetryStore(),
    readCost: (s: AgentSession) => readWorktreeSessionCost(s.worktreePath ?? s.cwd ?? null),
  };
}

/**
 * UMA passada de reconciliação da frota, com a sonda de tmux FAIL-CLOSED.
 *
 * O DEFEITO que ela cura (F2): `reconcileFleet` — que renova o heartbeat de quem está vivo, renova os
 * claims e varre quem morreu — tinha EXATAMENTE UM chamador, a tool MCP `claude_sessions`. A liveness da
 * frota era efeito colateral de alguém *listar*: sem ninguém polando, heartbeats envelheciam sob agentes
 * trabalhando e claims de sessão morta seguravam cards até o TTL. Agora o serviço a roda por conta
 * própria (instrumentation.ts) e a tool só aproveita a carona.
 *
 * A sonda é {@link probeLiveTmuxSessions} e não `listSessions()` justamente porque esta função DECIDE
 * ÓBITO: `[]` de "não consegui perguntar" mataria a frota inteira. `!ok` vira `null` ⇒ ninguém é julgado.
 */
export async function reconcileFleetNow(): Promise<FleetReconcileResult> {
  const probe = await probeLiveTmuxSessions();
  const claims = getCardClaims();
  const res = await reconcileFleet(
    {
      ...defaultSessionDeps(),
      sweepDeadActors: async (deadActors) => claims.sweepExpired(deadActors),
      // O claim tem TTL de 60min e sessões rotineiramente trabalham mais; sem esta renovação o card se
      // liberaria sozinho embaixo de um agente que ainda está com a árvore aberta.
      renewClaim: (board, cardId, actor, ttlMs) => claims.renew(board, cardId, actor, ttlMs),
    },
    probe.ok ? probe.names : null,
  );
  // Uma sessão que MORREU (tmux sumiu) encerrou o seu gasto: o de um condutor entra no ledger do card agora
  // (idempotente — o óbito se repete a cada tick enquanto a linha segue no registro). E a vaga que ela ocupava
  // volta para a fila do condutor na MESMA passada — "re-checar quando uma sessão termina" é isto, sem outra
  // fiação. Os dois são best-effort e nunca derrubam a reconciliação (que é a liveness da frota inteira).
  void bookEndedSessions(res).catch((err) =>
    console.error("[session-cost] registro dos óbitos falhou:", err instanceof Error ? err.message : err),
  );
  void pumpConductorsNow().catch((err) => console.error("[conductor] pump falhou:", err instanceof Error ? err.message : err));
  // O condutor cuja story ACABOU (No ar, arquivado, lixeira, sem driver) já não ocupa vaga no pump acima; aqui ele é
  // encerrado — depois da carência e só com o trabalho integrado (conductor.ts, endFinishedConductors).
  void endFinishedConductorsNow().catch((err) => console.error("[conductor] encerramento falhou:", err instanceof Error ? err.message : err));
  // …e o terminal que SOBROU de um condutor que já saiu do registro (ele descarta o próprio worktree ao terminar):
  // sem linha, o passe acima não o enxerga e ele ficaria na lista de terminais do operador para sempre.
  void endOrphanConductorTerminalsNow().catch((err) => console.error("[conductor] encerramento de terminal órfão falhou:", err instanceof Error ? err.message : err));
  // A rede de segurança do PROXY do modo ultra (runner/proxy.ts): pergunta proxiável que nenhum ask anunciou (uma
  // skill que escreveu direto no card, um restart no meio) é oferecida ao proxy aqui — no máximo a cada 5 min.
  void maybeSweepProxy().catch((err) => console.error("[proxy] varredura falhou:", err instanceof Error ? err.message : err));
  // A rede de segurança do JUIZ DA TRIAGEM (só-negócio): card na Triagem que nenhum nudge anunciou.
  void maybeSweepTriageJudge().catch((err) => console.error("[triage-judge] varredura falhou:", err instanceof Error ? err.message : err));
  // A rede de segurança do PRODUTOR DA PROVA (deploy needs-proof): o pedido que um restart interrompeu.
  void maybeSweepDeployProofs().catch((err) => console.error("[deploy-proof] varredura falhou:", err instanceof Error ? err.message : err));
  // A rede de segurança do AUDITOR TÉCNICO (grill 2, D): a entrega técnica sorteada que um restart interrompeu.
  void maybeSweepTechnicalAudits().catch((err) => console.error("[technical-audit] varredura falhou:", err instanceof Error ? err.message : err));
  // O RELÓGIO do disjuntor da publicação (publish-retry.ts): card que espera em «Liberar» com o recuo vencido é reavaliado
  // pela cascata — ela é movida a evento e, sem este aviso, a espera nunca acabaria.
  void import("./publish-retry")
    .then((m) => m.retryDuePublishesNow())
    .catch((err) => console.error("[publish-retry] varredura falhou:", err instanceof Error ? err.message : err));
  // ESTACIONAR (conductor-pause.ts): o condutor quieto que espera o DONO há mais que a carência recebe o pedido de
  // guardar o trabalho e encerrar — a vaga que ele segura volta para a fila.
  void import("./conductor-pause-deps")
    .then((m) => m.parkWaitingConductorsNow())
    .catch((err) => console.error("[conductor] passe de estacionar falhou:", err instanceof Error ? err.message : err));
  // PEDIDOS DE PERMISSÃO DE FERRAMENTA (permission-prompt.ts): uma sessão da frota parada num «Do you want to proceed?»
  // não tem quem responda (já houve sessão presa horas num aviso de rm). O sistema aprova o falso positivo provado, recusa o que o
  // isolamento não prova e recusa o que não consegue julgar depois de 10 min — nenhuma sessão fica horas num pedido.
  void import("./conductor-pause-deps")
    .then((m) => m.healPermissionPromptsNow())
    .catch((err) => console.error("[prompt-heal] passe falhou:", err instanceof Error ? err.message : err));
  // O TETO DE GASTO DO CARD (card-budget.ts): aprova o pedido de aumento que esperava a cota voltar ao ritmo e avisa o
  // condutor vivo que passou do teto sem pedir nada. No máximo a cada 5 min.
  void import("./card-budget-deps")
    .then((m) => m.maybeSweepCardBudgets())
    .catch((err) => console.error("[card-budget] varredura falhou:", err instanceof Error ? err.message : err));
  // O VIGIA DE CARD PARADO (stall-watch.ts): card em passo do sistema, sem dono e sem explicação há 15 minutos, tem o
  // passo refeito uma vez; parando de novo, vira conserto + item no Inbox. Import dinâmico: as deps dele puxam o
  // engine e o merge train, que este módulo não pode importar de cima.
  void import("./stall-watch-deps")
    .then((m) => m.maybeSweepStalledCards())
    .catch((err) => console.error("[stall-watch] varredura falhou:", err instanceof Error ? err.message : err));
  // O RITMO DO BOARD (board-pace.ts): a pausa cujo PRAZO venceu devolve ao pipeline o que segurou e re-bombeia as filas.
  void import("./board-pace-actions")
    .then((m) => m.sweepBoardPaceNow())
    .catch((err) => console.error("[board-pace] varredura do prazo falhou:", err instanceof Error ? err.message : err));
  // O RESUMO DA SEMANA (grill 2, E): segunda às 9h no fuso do dono, um push com o link para /semana.
  void maybeSendWeeklySummary().catch((err) => console.error("[weekly-summary] envio falhou:", err instanceof Error ? err.message : err));
  return res;
}

/** The spend of the sessions a reconcile pass found dead, booked once each (session-telemetry.ts). */
async function bookEndedSessions(res: FleetReconcileResult): Promise<void> {
  // Os que morreram AGORA + os já conhecidos que seguem no registro: lançar o gasto é idempotente por sessão, e incluir os
  // antigos preserva a re-tentativa de um lançamento que falhou no óbito (antes ela vinha de graça do óbito re-detectado a
  // cada passada; agora o óbito é um evento e a re-tentativa é explícita).
  const ids = [...res.died.map((d) => d.sessionId), ...res.lingering];
  if (!ids.length) return;
  const dead = new Set(ids);
  const rows = (await allSessions()).filter((s) => dead.has(s.sessionId));
  const deps = sessionTelemetryDeps();
  for (const s of rows) await recordSessionSpend(deps, s);
}

/** The port the AgileHarness MCP is served on — the SAME default the copiloto's spawn uses (orchestrator-spawn).
 *  A spawned session mounts `http://localhost:<port>/api/mcp/<token>/mcp`, i.e. this very service. */
const SERVICE_PORT = Number(process.env.PORT) || 3008;

/**
 * WS-6.2 — production deps for the work-oriented spawn (`spawnWorkSession`). Resolved PER CALL (never cached),
 * like {@link defaultSessionDeps}: the cap, the thresholds and the claude binary come from the LIVE settings, so
 * the operator retunes capacity without a restart.
 *
 * Moved here from `mcp/dev-tools.ts` for the same reason `defaultSessionDeps` was: it has TWO consumers now —
 * the `claude_new` tool and the CONDUCTOR dispatch (runner/conductor.ts), which spawns a conductor session
 * through exactly this door (same admission, same claim, same scoped token) and must not import the MCP tools
 * module to reach it.
 */
export const sessionSpawnDeps = (): SessionSpawnDeps => {
  const autorun = loadRunnerConfig().autorun;
  const claims = getCardClaims();
  return {
    worktree: defaultSessionDeps(),
    claims: {
      conflictFor: (req) => claims.conflictFor(req),
      acquire: (req) => claims.acquire(req),
      release: (board, cardId, actor) => claims.release(board, cardId, actor),
    },
    // The card's OWN route — literally the runs' path (config.resolveCardRoute → deriveCardModelEffort).
    // A card in a status the board no longer declares still yields its title (the prompt wants it) but no
    // route: we would rather spawn on the CLI's default than invent a tier from a column that doesn't exist.
    cardRoute: async (board, cardId) => {
      const [card, config] = await Promise.all([readCard(board, cardId), readBoardConfig(board)]);
      if (!card) return null;
      const def = config.statuses.find((s) => s.id === card.status);
      if (!def) return { title: card.title };
      return { ...resolveCardRoute(card, def, loadRunnerConfig()), title: card.title };
    },
    tmux: {
      exists: (name) => hasSession(name),
      create: async (name, command, cwd) => {
        const r = await ensureDetachedSession(name, command, cwd);
        return { ok: r.ok, error: r.error };
      },
      survives: (name) => pollSessionAlive(() => hasSession(name)),
      kill: async (name) => {
        await killSession(name);
      },
    },
    findTranscript: (since) => findNewTranscript(since),
    fs: fsp,
    claudeBin: resolvedClaudeBin({ name: autorun.claudeBin }),
    repoRoot: findRepoRoot(),
    stateDir: runnerStateDir(),
    // G12 — the SCOPED `orch` token, never AGILEHARNESS_MCP_TOKEN (the operator's `full`): a spawned agent may
    // drive the pipeline and publish, but never open a shell through MCP nor delete.
    mcpToken: process.env.AGILEHARNESS_MCP_TOKEN_ORCH,
    // Fact 4 of session-spawn.ts: as root with an inherited `bypassPermissions` the CLI dies at birth unless the
    // command carries IS_SANDBOX=1 (the escape every headless spawn already uses). Re-read per call, like the rest.
    rootBypass: hostNeedsRootBypass({
      uid: process.getuid?.(),
      platform: process.platform,
      inheritedDefaultMode: readInheritedDefaultMode(findRepoRoot()),
    }),
    port: SERVICE_PORT,
    // O governador de capacidade: a sessão aberta pela AUTOMAÇÃO (o copiloto) passa pela janela da conta.
    admission: (initiator) => getCapacityGovernor().admission(initiator),
  };
};

/**
 * The CONDUCTOR dispatch, wired to production (runner/conductor.ts is the DI-tested core). Resolved PER CALL,
 * like the two factories above: the master switch and the spawn deps come from the LIVE settings.
 */
export function defaultConductorDeps(): ConductorDeps {
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    queue: diskConductorQueueStore(),
    sessions: () => allSessions(),
    liveTmux: async () => {
      const probe = await probeLiveTmuxSessions();
      return probe.ok ? new Set(probe.names) : null;
    },
    heartbeatAlive: (s) => isSessionAlive(s, Date.now()),
    treeGone: conductorTreeGone,
    readCard: (board, cardId) => readCard(board, cardId),
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    markDriver: async (board, cardId) => {
      await updateCardOnDisk(board, cardId, (card) => {
        const routing = withDriver(card, "conductor", today());
        return routing ? { ...card, routing } : null; // null ⇒ already conducted ⇒ no write (loop-safe)
      });
    },
    clearDriver: async (board, cardId) => {
      await updateCardOnDisk(board, cardId, (card) => {
        const routing = withoutDriver(card);
        return routing === undefined ? null : { ...card, routing };
      });
    },
    stampDispatchFailure: async (board, cardId, detail) => {
      await updateCardOnDisk(board, cardId, (card) => {
        const findings = upsertFindingIfChanged(card.findings ?? [], {
          id: CONDUCTOR_DISPATCH_FINDING_ID,
          lens: "general",
          severity: "high",
          title: "o condutor não conseguiu abrir a sessão",
          detail,
          status: "open",
        });
        return findings ? { ...card, findings } : null;
      });
    },
    spawn: (input) => spawnWorkSession(sessionSpawnDeps(), input),
    masterEnabled: () => loadRunnerConfig().autorun.enabled,
    boardGate: boardGateNow,
    // A despacho do condutor é AUTOMAÇÃO para a janela da conta (ver ConductorDeps.admission).
    admission: () => getCapacityGovernor().admission("automation"),
    // O teto de gasto do card vale em código também para o conduzido: acima dele a entrada espera um aumento aprovado.
    budgetRefusal: async (board, card) => (await import("./card-budget-deps")).conductorBudgetRefusal(board, card),
    // A vaga extra (extra-slot.ts): com o board no limite, um card pequeno nasce mesmo assim se máquina, cota e fila de
    // integração têm folga — as travas «conservadoras» do dono.
    extraSlot: async (_board, card, live, maxSessions) => extraSlotVerdict(card, extraSlotFactsNow(live, maxSessions), loadRunnerConfig().autorun.extraSlot),
    onExtraSlot: async (board, card, why) => {
      await appendSystemDecision({
        v: 1,
        id: newSystemDecisionId(),
        at: new Date().toISOString(),
        board,
        cardId: card.id,
        agent: "system",
        kind: "extra-slot",
        what: `Abriu uma vaga extra de condutor para «${card.title}»`,
        why,
      });
    },
    // …e o que ela retém ENTRA na conta do painel ("retidos") e no aviso de >24h, como a fila do engine.
    reportHeld: (keys) => getCapacityGovernor().reportHeld("conductor", keys),
    explainMissingCard,
    orphanCandidates: conductorOrphanCandidates,
    // Órfão é quem ninguém carrega: a régua `inFlight` do vigia (stall-watch-deps.ts) — claim ativo de qualquer ator, run
    // do engine, entrada viva no merge train. O engine vem por import tardio (ele alcança este módulo pelo autorun-eval).
    cardInFlight: async (board, cardId) => {
      if ((await getCardClaims().list(board)).some((c) => c.cardId === cardId)) return true;
      if (getMergeQueue().getSnapshot().entries.some((e) => e.board === board && e.cardId === cardId && isActiveMergeStatus(e.status))) return true;
      return (await import("./engine")).getRunnerEngine().isInFlight(board, cardId);
    },
    // Um card que SUMIU com a fila esperando nunca sai em silêncio: alerta no journal + decisão do sistema (Inbox).
    recordCardMissing: async (entry, miss) => {
      console.error(`[conductor] ALERTA: ${entry.board}/${entry.cardId} sumiu do disco com a fila esperando — registrado como card-missing`);
      await appendSystemDecision(cardMissingDecision(entry, miss, new Date().toISOString(), newSystemDecisionId()));
    },
  };
}

/**
 * Os fatos da vaga extra AGORA (extra-slot.ts): máquina, cota no ritmo, integração — com a carga medida SEM a
 * integração em curso (WP5-F2, {@link gateCoresBusy}).
 */
function extraSlotFactsNow(live: number, maxSessions: number): ExtraSlotFacts {
  const cfg = loadRunnerConfig().autorun;
  const res = probeVpsResources();
  const reading = (() => {
    try {
      return getCapacityGovernor().snapshot().reading;
    } catch {
      return null;
    }
  })();
  const pace = quotaPace(reading ? { usage7dPct: reading.usage7dPct, usage5hPct: reading.usage5hPct, resetsAt7d: reading.resetsAt7d, stale: reading.stale } : null, Date.now(), {
    maxPct: cfg.budgetRaise.maxPct,
    fiveHourMaxPct: cfg.extraSlot.fiveHourMaxPct,
  });
  const mergeBusy = getMergeQueue().getSnapshot().entries.filter((x) => isActiveMergeStatus(x.status)).length;
  return { live, maxSessions, loadAvg1: res.loadAvg1, gateLoad: gateCoresBusy(), cores: cpus().length, freeRamMb: res.freeRamMb, pace, mergeBusy };
}

/** O contador de CPU do slice do gate, como o systemd o monta: `a-b.slice` mora em `a.slice/a-b.slice`. */
const GATE_CPU_STAT = path.join("/sys/fs/cgroup", `${GATE_SLICE.split("-")[0]}.slice`, GATE_SLICE, "cpu.stat");
const GATE_SAMPLE_KEY = Symbol.for("agileharness.conductor.gateCpuSample");

/**
 * Núcleos que a integração (o slice do gate) ocupou desde a leitura anterior — a parte PASSAGEIRA da carga, que a vaga
 * extra desconta (o merge train tem a sua trava própria). IO na borda; a conta é `gateCoresBetween`. Nunca lança.
 */
export function gateCoresBusy(now: number = Date.now()): number {
  const store = globalThis as unknown as { [GATE_SAMPLE_KEY]?: { at: number; usec: number; cores: number } };
  const prev = store[GATE_SAMPLE_KEY];
  // Duas passadas seguidas (o pump de um evento logo depois do tick): a medida de agora segue valendo, e a base fica.
  if (prev && now - prev.at < 10_000) return prev.cores;
  let usec: number;
  try {
    const m = /^usage_usec\s+(\d+)/m.exec(readFileSync(GATE_CPU_STAT, "utf8"));
    if (!m) return 0;
    usec = Number(m[1]);
  } catch {
    return 0;
  }
  const cores = gateCoresBetween(prev, { at: now, usec });
  store[GATE_SAMPLE_KEY] = { at: now, usec, cores };
  return cores;
}

/**
 * WP5-F2 — as vagas de condutor de um board AGORA, para o nav e o Kanban: a MESMA conta do pump (vivos sem zumbi e
 * sem quem terminou a story) e a vaga extra do board, sem card na mão. IO na borda; a conta é `conductorSlotFacts`.
 */
export async function conductorSlotFactsNow(board: string): Promise<ConductorSlotFacts> {
  const deps = defaultConductorDeps();
  const [sessions, live, config, queue] = await Promise.all([
    deps.sessions().catch(() => [] as AgentSession[]),
    deps.liveTmux().catch(() => null),
    deps.readBoardConfig(board),
    deps.queue.load(),
  ]);
  const liveConductors = sessions.filter((s) => isLiveConductor(s, live, deps.heartbeatAlive, deps.treeGone));
  const finished = new Set((await finishedConductors(deps, liveConductors)).keys());
  const used = liveConductors.filter((s) => s.board === board && !finished.has(s.sessionId));
  const policy = resolveConductorPolicy(config);
  const extra = policy ? extraSlotBoardVerdict(extraSlotFactsNow(countLiveConductorsByBoard(used).get(board) ?? 0, policy.maxSessions), loadRunnerConfig().autorun.extraSlot) : null;
  return conductorSlotFacts(board, { config, liveConductors, finished, queue, extra, gate: boardGateNow(board, config) });
}

/**
 * WP5-F1 — o card de uma entrada da fila não veio do `readCard`: ele SUMIU, foi para a lixeira, ou só não foi lido
 * agora? (o `readCard` do repo devolve null para os três). IO na borda; o que fazer com a resposta é do pump.
 */
export async function explainMissingCard(board: string, cardId: string): Promise<QueuedCardMiss> {
  const code = await fsp.stat(cardPath(board, cardId)).then(
    () => "exists",
    (err: NodeJS.ErrnoException) => err?.code ?? "unknown",
  );
  if (code === "exists") return { kind: "unreadable", detail: "o arquivo existe mas não foi lido (recusado pelo chokepoint ou ilegível)" };
  if (code !== "ENOENT" && code !== "ENOTDIR") return { kind: "unreadable", detail: `stat do card falhou (${code})` };
  if (await fsp.access(trashedCardPath(board, cardId)).then(() => true, () => false)) return { kind: "trashed" };
  const last = (await readTransitions({ board, cardId })).at(-1);
  return { kind: "missing", lastHop: last ? { from: last.from, to: last.to, at: last.at } : null };
}

/**
 * WP5-F2 — a árvore de trabalho desta linha foi APAGADA (o tmux zumbi: o claude segue no prompt com cwd «(deleted)»)?
 * Um `existsSync` por linha — barato, e só diz «sim» com prova: sem caminho registrado, ninguém é zumbi.
 */
export function conductorTreeGone(s: AgentSession): boolean {
  const tree = s.worktreePath ?? s.cwd;
  return !!tree && !existsSync(tree);
}

/** A varredura dos órfãos lê todos os cards dos boards com condutor: no máximo a cada 5 min (a 1ª passada do boot, já). */
export const ORPHAN_SCAN_MIN_INTERVAL_MS = 5 * 60_000;
const ORPHAN_SCAN_KEY = Symbol.for("agileharness.conductor.orphanScan");

/**
 * WP5-F2 — os boards com o condutor ligado e o autorun armado, com os cards de agora, para o pump admitir os órfãos
 * (conductor.ts `isConductorOrphan`). Fora do intervalo devolve [] (a leitura dos cards é o custo). Nunca lança.
 */
async function conductorOrphanCandidates(): Promise<Array<{ board: string; config: BoardConfig; cards: Card[] }>> {
  const store = globalThis as unknown as { [ORPHAN_SCAN_KEY]?: number };
  const now = Date.now();
  if (now - (store[ORPHAN_SCAN_KEY] ?? 0) < ORPHAN_SCAN_MIN_INTERVAL_MS) return [];
  store[ORPHAN_SCAN_KEY] = now;
  const out: Array<{ board: string; config: BoardConfig; cards: Card[] }> = [];
  for (const b of await listBoards().catch(() => [])) {
    const config = await readBoardConfig(b.id).catch(() => null);
    if (!config || boardGateNow(b.id, config).held || !resolveConductorPolicy(config)) continue;
    const cards = await readCards(b.id).catch(() => null);
    if (cards) out.push({ board: b.id, config, cards });
  }
  return out;
}

/** One pump pass with the production deps — the fleet tick calls it (and the entry path fires it). */
export function pumpConductorsNow(): Promise<ConductorPumpReport> {
  return pumpConductorQueue(defaultConductorDeps());
}

/** The end pass's grace clock — one per PROCESS (Symbol.for: the instrumentation and route bundles share it). */
const CONDUCTOR_END_STATE_KEY = Symbol.for("agileharness.conductor.endState");

/** The END pass wired to production: the train's history, git, the pane and the claim registry. */
export function defaultConductorEndDeps(): ConductorEndDeps {
  const store = globalThis as unknown as { [CONDUCTOR_END_STATE_KEY]?: ConductorEndState };
  const base = defaultConductorDeps();
  const worktree = defaultSessionDeps();
  return {
    sessions: base.sessions,
    liveTmux: base.liveTmux,
    heartbeatAlive: base.heartbeatAlive,
    readCard: base.readCard,
    readBoardConfig: base.readBoardConfig,
    workSettled: (s) => sessionWorkSettled(worktree, s, getMergeQueue().getSnapshot().entries),
    // The words are the code's (a fixed `/exit`), and only a pane PROVEN to run claude receives them — never a shell
    // (the proxy's resumeConductor reasoning, proxy-deps.ts).
    requestExit: async (s) => {
      if (!s.tmuxSession || !(await sessionRunsClaude(s.tmuxSession))) return false;
      return (await deliverToSession(s.tmuxSession, "/exit", { submit: true })).ok;
    },
    kill: async (s) => {
      if (s.tmuxSession) await killSession(s.tmuxSession);
    },
    releaseClaims: async (s) => {
      if (s.board && s.cardId) await getCardClaims().release(s.board, s.cardId, sessionClaimActor(s.agentId));
    },
    state: (store[CONDUCTOR_END_STATE_KEY] ??= new Map()),
  };
}

/** One end pass with the production deps — the fleet tick calls it right after the pump. */
export function endFinishedConductorsNow(): Promise<ConductorEndReport> {
  return endFinishedConductors(defaultConductorEndDeps());
}

const CONDUCTOR_ORPHAN_STATE_KEY = Symbol.for("agileharness.conductor.orphanState");

/** The ORPHAN pass wired to production (conductor.ts `endOrphanConductorTerminals`) — same words, same pane proof. */
export function endOrphanConductorTerminalsNow(): Promise<ConductorOrphanReport> {
  const store = globalThis as unknown as { [CONDUCTOR_ORPHAN_STATE_KEY]?: ConductorOrphanState };
  const base = defaultConductorDeps();
  return endOrphanConductorTerminals({
    sessions: base.sessions,
    liveTmux: base.liveTmux,
    asking: (tmux) => currentTerminalAttention().some((t) => t.session === tmux && t.kind === "asking"),
    requestExit: async (tmux) => {
      if (!(await sessionRunsClaude(tmux))) return false;
      return (await deliverToSession(tmux, "/exit", { submit: true })).ok;
    },
    kill: async (tmux) => {
      await killSession(tmux);
    },
    state: (store[CONDUCTOR_ORPHAN_STATE_KEY] ??= new Map()),
  });
}

/**
 * The ENTRY half, for the autorun kernel: admit (driver + queue, awaited — every evaluation after this one sees
 * a conducted card) and then fire a pump without holding the entry path (the spawn takes seconds).
 */
export async function dispatchConductorOnEntry(board: string, cardId: string): Promise<void> {
  const deps = defaultConductorDeps();
  await admitConductorCard(deps, board, cardId);
  void pumpConductorQueue(deps).catch((err) =>
    console.error(`[conductor] pump falhou:`, err instanceof Error ? err.message : err),
  );
}
