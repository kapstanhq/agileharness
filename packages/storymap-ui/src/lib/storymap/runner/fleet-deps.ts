// fleet-deps — WS-6.4: the PRODUCTION wiring of the FLEET (the page, the API route, the boot tick and any
// future steward all read/reconcile the same registries, through the same factories).
//
// A separate file from fleet-view.ts on purpose: fleet-view is pure + DI (unit-tested with fakes), while this
// is the half that knows about disk, tmux and the live merge train. It is also what keeps the Next page from
// importing the MCP tool module just to reach a dep factory.

import { promises as fsp } from "node:fs";
import { getMergeQueue } from "./merge-queue";
import { allSessions, defaultSessionWorktreeDeps, reconcileFleet, type FleetReconcileResult, type SessionWorktreeDeps } from "./session-worktree";
import { getCardClaims } from "./claims";
import { loadRunnerConfig } from "./config";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { findNewTranscript, RECYCLE_THRESHOLD } from "@/lib/vps/claude-transcript";
import { readSessionContext } from "@/lib/vps/transcript-usage";
import { ensureDetachedSession, hasSession, killSession, listSessions, probeLiveTmuxSessions } from "@/lib/vps/tmux";
import { readBoardConfig, readCard } from "@/lib/storymap/repo";
import { resolveCardRoute } from "./config";
import { getCapacityGovernor } from "./capacity-service";
import { resolvedClaudeBin } from "./claude-bin";
import { pollSessionAlive, spawnWorkSession, type SessionSpawnDeps } from "./session-spawn";
import { isSessionAlive } from "./session-liveness";
import { upsertFindingIfChanged } from "./findings";
import {
  admitConductorCard,
  CONDUCTOR_DISPATCH_FINDING_ID,
  diskConductorQueueStore,
  pumpConductorQueue,
  type ConductorDeps,
  type ConductorPumpReport,
} from "./conductor";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { readWorktreeSessionCost } from "@/lib/vps/session-cost";
import { recordSessionSpend, type SessionTelemetryDeps } from "./session-telemetry";
import { getTelemetryStore } from "./telemetry";
import type { AgentSession } from "./session-worktree";
import { withDriver, withoutDriver } from "@/lib/storymap/driver";
import type { CollectFleetDeps } from "./fleet-view";
import type { CardClaim } from "./claims";

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
  return res;
}

/** The spend of the sessions a reconcile pass found dead, booked once each (session-telemetry.ts). */
async function bookEndedSessions(res: FleetReconcileResult): Promise<void> {
  if (!res.died.length) return;
  const dead = new Set(res.died.map((d) => d.sessionId));
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
    // A despacho do condutor é AUTOMAÇÃO para a janela da conta (ver ConductorDeps.admission).
    admission: () => getCapacityGovernor().admission("automation"),
  };
}

/** One pump pass with the production deps — the fleet tick calls it (and the entry path fires it). */
export function pumpConductorsNow(): Promise<ConductorPumpReport> {
  return pumpConductorQueue(defaultConductorDeps());
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
