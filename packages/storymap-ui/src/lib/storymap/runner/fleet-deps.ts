// fleet-deps — WS-6.4: the PRODUCTION wiring of the FLEET (the page, the API route, the boot tick and any
// future steward all read/reconcile the same registries, through the same factories).
//
// A separate file from fleet-view.ts on purpose: fleet-view is pure + DI (unit-tested with fakes), while this
// is the half that knows about disk, tmux and the live merge train. It is also what keeps the Next page from
// importing the MCP tool module just to reach a dep factory.

import { getMergeQueue } from "./merge-queue";
import { allSessions, defaultSessionWorktreeDeps, reconcileFleet, type FleetReconcileResult, type SessionWorktreeDeps } from "./session-worktree";
import { getCardClaims } from "./claims";
import { loadRunnerConfig } from "./config";
import { findRepoRoot } from "@/lib/storymap/paths";
import { RECYCLE_THRESHOLD } from "@/lib/vps/claude-transcript";
import { readSessionContext } from "@/lib/vps/transcript-usage";
import { listSessions, probeLiveTmuxSessions } from "@/lib/vps/tmux";
import { readCard } from "@/lib/storymap/repo";
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
  return defaultSessionWorktreeDeps({
    repoRoot: findRepoRoot(),
    ensureRunBase: () => mq.ensureRunBase(),
    enqueueMerge: (entry) => mq.enqueueMerge(entry),
    liveRunIds: () => mq.liveRunIds(),
    maxWorktrees: autorun.sessions?.maxWorktrees,
    thresholds: autorun.scheduler?.thresholds,
  });
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
  return reconcileFleet(
    {
      ...defaultSessionDeps(),
      sweepDeadActors: async (deadActors) => claims.sweepExpired(deadActors),
      // O claim tem TTL de 60min e sessões rotineiramente trabalham mais; sem esta renovação o card se
      // liberaria sozinho embaixo de um agente que ainda está com a árvore aberta.
      renewClaim: (board, cardId, actor, ttlMs) => claims.renew(board, cardId, actor, ttlMs),
    },
    probe.ok ? probe.names : null,
  );
}
