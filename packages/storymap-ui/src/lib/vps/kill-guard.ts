// The FAIL-CLOSED "is it safe to kill this tmux session?" predicate — ONE place, so every kill path
// (the web terminal DELETE route, killTmuxSessionAction, the claude_kill MCP tool) enforces the same
// rule. An over-permissive guard is the worst failure mode here (it would drop the master, a live
// autorun run, or an agent's uncommitted work), so EVERY uncertainty resolves to `protected: true`.
//
// Two layers by design:
//   • `assessKill(name, snapshots)` is PURE over injected snapshots → unit-testable exhaustively.
//   • `gatherKillSnapshots()` collects the live state once; ANY probe failure ⇒ null ⇒ the callers
//     treat the verdict as protected. The DELETE route re-derives the verdict server-side (via
//     `assessKillLive`) — the client's `protected` flag is display-only and never trusted.
//
// Server-only (spawns tmux/ps, reads the registry + sessions.json).

import { listSessions, listProcesses, listPaneOwners, MASTER_SESSION_PREFIX, type TmuxSession } from "./tmux";
import { attributeClaudeProcesses, type ClaudeAgent } from "./process-attribution";
import { readFileSync } from "node:fs";
import { cardSessionName } from "./processes";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import type { AgentSession } from "@/lib/storymap/runner/session-worktree";
import { isSessionAlive, sessionsFilePath } from "@/lib/storymap/runner/session-liveness";
import { cliFlagIsStale } from "@/lib/terminal/attention";
import { screenStillness } from "@/lib/terminal/attention-watch";

/**
 * The fleet registry, PRESERVING the unreadable signal — null on missing/corrupt/non-array, an array
 * otherwise. Mirrors readSessionsFromDisk (session-liveness.ts) but keeps the full AgentSession type
 * (we match by `tmuxSession`, which SessionLiveness drops). `makeSessionStore().load()` cannot be used
 * here: it catches every failure and returns [], collapsing "unreadable" into "empty" — which would
 * make the fail-closed class-6 below unreachable (an actual review finding).
 */
export function readAgentSessionsOrNull(): AgentSession[] | null {
  try {
    const raw = JSON.parse(readFileSync(sessionsFilePath(), "utf8"));
    const rows = Array.isArray(raw) ? raw : raw?.sessions;
    return Array.isArray(rows) ? (rows as AgentSession[]) : null;
  } catch {
    return null;
  }
}

export interface KillVerdict {
  protected: boolean;
  reason: string;
}

export interface KillSnapshots {
  sessions: TmuxSession[];
  /** live Claude agents on the box, attributed to their owning tmux session / run */
  agents: ClaudeAgent[];
  /** `card-<board>__<cardId>` names of runs the registry reports as RUNNING right now */
  runningCardSessions: Set<string>;
  /** the fleet session registry (sessions.json), or null when UNREADABLE (fail-closed signal) */
  agentSessions: AgentSession[] | null;
  now: number;
  /**
   * Há quanto tempo a TELA de cada sessão não muda (ms) — a mesma evidência que o medidor usa para
   * decidir se o flag busy/idle do CLI ainda vale (`screenStillness`, attention-watch.ts).
   *
   * Aqui ela separa "hospeda um agente VIVO" de "hospeda um agente DORMENTE". Sessão AUSENTE do mapa
   * = sem evidência de tela ⇒ tratada como VIVA (protegida): num guarda fail-closed, ausência de
   * prova nunca autoriza um kill.
   */
  screenStill: Map<string, number>;
  /** the master session name convention — `claude`, `claude-jonatas`, … (the box's control session) */
  masterPrefix: RegExp;
  /** long-lived infra sessions that are never disposable per-card terminals */
  protectedNames: Set<string>;
}

// The generic AgileHarness terminal convention (mirrors attach-session.sh + processes.ts classifyTmux):
// the master is `claude`/`claude-*`, the durable shell is `shell`. These are conventions of THIS
// tool's terminal, not product constants — a future settings knob can override via gatherKillSnapshots.
// O prefixo do MASTER vem de `tmux.ts` (uma verdade só): a mesma régua governa o guarda de kill, a
// exclusão de colagem do overlay e a entrega de texto do MCP (`planSessionDelivery`).
const MASTER_PREFIX = MASTER_SESSION_PREFIX;
const PROTECTED_NAMES = new Set(["shell"]);

/**
 * Would a session with this NAME be protected-by-name forever (master `claude*` / infra `shell`)?
 * The create route refuses these: minting one would make a permanently-unkillable session (its kill
 * button disabled and every kill path refusing it), removable only via a raw tmux command on the box.
 */
export function isReservedSessionName(
  name: string,
  over?: { masterPrefix?: RegExp; protectedNames?: Set<string> },
): boolean {
  return (over?.masterPrefix ?? MASTER_PREFIX).test(name) || (over?.protectedNames ?? PROTECTED_NAMES).has(name);
}

/**
 * Is this the MASTER control session (`claude*`) — the box's orchestrator/driver? NARROWER than
 * isReservedSessionName (which ALSO covers the durable infra `shell`). The feedback terminal round-trip
 * uses THIS as its paste-exclusion: `shell` and worker/adhoc sessions ARE valid paste targets when they
 * host a live Claude agent (the operator's own interactive session usually lives in `shell`), but the
 * orchestrator must NEVER receive a pasted prompt (it drives autorun box-wide). Paired with
 * sendToClaudeSession's identity allowlist (which refuses any non-Claude session).
 */
export function isMasterSession(name: string, over?: { masterPrefix?: RegExp }): boolean {
  return (over?.masterPrefix ?? MASTER_PREFIX).test(name);
}

/**
 * Collect the live box state ONCE. Returns null if ANY probe throws — the callers turn null into a
 * protected verdict, so a momentary tmux/ps/registry failure can never authorize a kill.
 */
export async function gatherKillSnapshots(overrides?: {
  masterPrefix?: RegExp;
  protectedNames?: Set<string>;
}): Promise<KillSnapshots | null> {
  try {
    const running = getRunnerRegistry().snapshot().running ?? [];
    const [sessions, procs, panes] = await Promise.all([listSessions(), listProcesses(), listPaneOwners()]);

    // FAIL-CLOSED on a probe failure. listProcesses/listPaneOwners/listSessions are best-effort and
    // return [] on error (never throw), so an empty result is AMBIGUOUS — and the live-agent signal
    // (class 4, "hosts a live claude") would then go blind and wrongly report a session as safe. An
    // empty PROCESS table is impossible on a live box ⇒ `ps` failed; tmux reporting sessions but zero
    // panes ⇒ `list-panes` failed. Either way we cannot prove a session safe, so refuse to assess.
    if (procs.length === 0) return null;
    if (sessions.length > 0 && panes.length === 0) return null;

    // sessions.json read that PRESERVES the unreadable signal (null → fail-closed via class 6) vs a
    // legitimately empty registry ([] → nothing to protect). See readAgentSessionsOrNull.
    const agentSessions = readAgentSessionsOrNull();

    const knownRunSessionIds = new Set(
      running.map((r) => r.sessionId?.toLowerCase()).filter((x): x is string => !!x),
    );
    const agents = attributeClaudeProcesses({ procs, panes, knownRunSessionIds });
    const runningCardSessions = new Set(
      running.filter((r) => r.board && r.cardId).map((r) => cardSessionName(r.board, r.cardId)),
    );

    return {
      sessions,
      agents,
      runningCardSessions,
      agentSessions,
      now: Date.now(),
      // Leitura de MEMÓRIA do vigia (≤1 ciclo de 6s), não uma sonda nova: o veredito de kill precisa
      // ser fresco, e por isso este gather não compartilha o memo de 5s do pane-map.
      screenStill: screenStillness(),
      masterPrefix: overrides?.masterPrefix ?? MASTER_PREFIX,
      protectedNames: overrides?.protectedNames ?? PROTECTED_NAMES,
    };
  } catch {
    return null;
  }
}

/**
 * PURE verdict. `protected: true` if ANY protected class holds, in cheapest-first order. The classes
 * (and WHY each is protected):
 *   1. MASTER      — the box's control session (`claude*`); killing it drops the interactive driver.
 *   2. INFRA       — a configured long-lived name (`shell`); not a disposable per-card terminal.
 *   3. LIVE RUN    — a `card-<board>__<cardId>` paired with a RUNNING registry run → mid-pipeline kill.
 *   4. HOSTS AGENT — the session's process tree contains a LIVE claude agent (headless OR interactive);
 *                    killing it drops live work. Subsumes SELF (a claude killing its own session).
 *   5. LIVE FLEET  — an `agent-*` session whose registry row is still alive (heartbeat within TTL) →
 *                    its worktree may hold un-integrated / uncommitted work.
 *   6. UNREADABLE  — sessions.json unreadable AND the name is a fleet `agent-*` → cannot prove dead.
 * SAFE only when NONE hold: an idle `cop-*`/adhoc/settled `card-*` at a bash prompt with no live agent.
 */
export function assessKill(name: string, snap: KillSnapshots): KillVerdict {
  const P = (reason: string): KillVerdict => ({ protected: true, reason });

  if (snap.masterPrefix.test(name)) return P("sessão master (interativa) — controla a caixa");
  if (snap.protectedNames.has(name)) return P("infra de longa duração — não é um terminal descartável");

  if (snap.runningCardSessions.has(name)) {
    return P("hospeda um run de autorun ATIVO — encerrá-la mataria o card no meio do pipeline");
  }

  // Classe 4 protege um agente VIVO, e a palavra faz o trabalho todo: a razão desta trava é
  // "encerrá-la derrubaria trabalho em andamento". Um agente cuja TELA está congelada há muito tempo
  // não tem trabalho em andamento para derrubar — ele é justamente o que o operador quer reciclar, e
  // enquanto a trava não distinguia os dois casos, a máquina acumulava sessões dormentes que a
  // interface mostrava e ninguém conseguia encerrar por ela. A régua é a MESMA de `cliFlagIsStale`
  // (uma casa, um limiar), e a direção do erro continua fail-closed: sem evidência de tela a sessão
  // conta como viva. Master, run de autorun ativo e sessão de frota com trabalho não-integrado são
  // classes PRÓPRIAS (1, 3, 5) e seguem protegidas por dormência nenhuma.
  const hosted = snap.agents.find((a) => a.owner.kind === "tmux" && a.owner.session === name);
  if (hosted && !cliFlagIsStale(snap.screenStill.get(name))) {
    return P(
      hosted.headless
        ? "hospeda um agente Claude headless vivo (run em andamento)"
        : "hospeda um agente Claude interativo vivo — encerrá-la o derrubaria",
    );
  }

  const isFleetName = /^agent-/.test(name);
  if (snap.agentSessions === null) {
    if (isFleetName) {
      return P("registro de sessões ilegível — não dá para provar que a sessão de agente está morta");
    }
  } else {
    const row = snap.agentSessions.find((s) => s.tmuxSession === name);
    if (row && isSessionAlive(row, snap.now)) {
      const t = row.task ? ` · ${row.task.slice(0, 60)}` : "";
      return P(`sessão de agente VIVA${t} — trabalho não-integrado seria perdido`);
    }
  }

  return { protected: false, reason: "" };
}

/** Fresh authoritative verdict for one session (the DELETE route + kill actions use THIS). */
export async function assessKillLive(name: string): Promise<KillVerdict> {
  const snap = await gatherKillSnapshots();
  if (!snap) return { protected: true, reason: "não foi possível verificar o estado da caixa — recusado por segurança" };
  return assessKill(name, snap);
}

/** One gather, many names — for the enriched sessions list (display-only `protected`). */
export async function assessKillBatch(names: string[]): Promise<Map<string, KillVerdict>> {
  const snap = await gatherKillSnapshots();
  const out = new Map<string, KillVerdict>();
  for (const n of names) {
    out.set(n, snap ? assessKill(n, snap) : { protected: true, reason: "estado indisponível — recusado por segurança" });
  }
  return out;
}
