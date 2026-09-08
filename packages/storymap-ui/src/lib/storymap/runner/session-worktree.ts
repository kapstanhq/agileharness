// session-worktree — WS-1: an EPHEMERAL worktree per AGENT SESSION (storymap-parallel-work, D1/D2/D3).
//
// The autorun's headless runs have had isolation for a while (worktree.ts: one `git worktree` per run,
// integrated by the serial merge train). Every OTHER writer of code — an interactive agent session, a
// spawned self-dev session — still shared ONE persistent tree, and "N agents at once" was really N agents
// taking turns by hand. One slip = a clobber (the engine.ts-130-lines class). This module gives a SESSION
// exactly what a run already has: its own tree, cut from the same base, integrated by the same train.
//
// A session differs from a run in ONE way that drives every design choice here: it is ALIVE.
//   • It keeps committing after it submits    → the submit PINS a sha; the train integrates THAT (G5).
//   • It can fix its own conflict in seconds  → a failed integration goes BACK to it, and is TERMINAL on
//                                               the queue (G6) — a live agent must never hold the head of
//                                               the train while it thinks.
//   • It lives for HOURS, not minutes         → no reaper/reconciler may touch its tree while its
//                                               heartbeat is alive (G7). The registry below is what makes
//                                               "alive" a fact on disk that survives a service restart.
//   • It rebases to catch up (refresh)        → the rebase invalidates the reflog's `Created from`, so the
//                                               base is written to `refs/agent-base/<id>` and the own-work
//                                               ruler prefers it (G4, run-base.ts).
//
// The git plumbing, the fs, the clock and the train are all injected (the engine's DI convention), so the
// whole lifecycle is unit-testable against a temp repo with no service running. SERVER-ONLY in production.

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";
import { CLAIM_TTL_SESSION_MS, sessionClaimActor } from "./claims";
import { DEFAULT_MAX_SESSION_WORKTREES } from "./config";
import { quote } from "./git";
import { agentBaseRef, agentSessionIdFromBranch, isExactBase, resolveRunBase, runOwnWork } from "./run-base";
import { isVpsOverloaded, probeVpsResources, type SchedulerThresholds, type VpsResources } from "./scheduler";
import {
  agentBranch,
  agentWorktreePath,
  commitAllPending,
  defaultExec,
  defaultWorktreeFs,
  makeWorktreeOps,
  provisionNodeModules,
  type ExecFn,
  type WorktreeFs,
} from "./worktree";
import type { MergeQueueEntry } from "./types";
import { isSessionAlive, SESSION_HEARTBEAT_TTL_MS } from "./session-liveness";
import { loadRunnerConfig } from "./config";

/** Generous ceiling for the git plumbing here (worktree add + rebase on a big repo = seconds, never minutes). */
const EXEC_TIMEOUT_MS = 120_000;

/**
 * WS-6.1 — the ROLE an agent session plays. Drives the model default (WS-7), whether a worktree is
 * provisioned at all (only code roles need one), and the claim kind it takes (WS-4).
 */
export type AgentRole = "implement" | "review" | "triage" | "steward" | "free";

/** Roles that WRITE CODE ⇒ need an isolated worktree + count against the HEAVY lane. */
export const CODE_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(["implement", "review"]);

/**
 * WS-6.2 — does a SPAWN of this role get an isolated tree? The code roles, plus `free`.
 *
 * `free` is in deliberately, and it is not a synonym for "code role": it means "open-ended" (self-dev, a quick
 * fix, a diagnosis that turns into a patch), i.e. we cannot know in advance whether it writes code. The two
 * mistakes are NOT symmetric — a tree the session never needed costs one cap slot and a directory of symlinks;
 * a tree it needed and lacked means the session's cwd IS the runtime checkout, and the first edit clobbers the
 * live service (the engine.ts-130-lines class this whole WS exists to end). So the ambiguous case gets a tree.
 *
 * `triage`/`steward` stay OUT: they work on board-data through MCP (the light lane's existing, sanctioned
 * pattern — G3), so a tree would buy nothing.
 */
export function roleNeedsWorktree(role: AgentRole): boolean {
  return CODE_ROLES.has(role) || role === "free";
}

/**
 * One agent session in the fleet. Durable — it MUST survive a service restart, because the session is a
 * SEPARATE process that keeps working across it, and the boot reconciler asks this file "is anyone home?"
 * before it prunes anything (G7).
 *
 * WS-6.1 — this is THE fleet registry, not a second one. Before it, session identity was split across two
 * stores: this durable file (worktree/branch/base/heartbeat, keyed by uuid) and an in-memory `globalThis`
 * Map in dev-tools (cwd/transcript, keyed by tmux name) that DIED on every service restart. Two stores for
 * one fact is how a fleet view lies. The fields below absorb the dev-tools map's payload
 * (`tmuxSession`/`cwd`/`transcriptFile`) so there is ONE durable answer to "who is on this box, doing what,
 * in which tree" — which is also the only shape the reaper can safely obey (G7).
 */
export interface AgentSession {
  /**
   * uuid MINTED BY THE TOOL (D12) — never a name the agent chose. Keys the branch, the tree and the base-ref.
   * For a session WITH a worktree this is also the branch's id.
   */
  sessionId: string;
  /**
   * WS-6.3 — the LOGICAL agent identity, stable across RECYCLING. When a session is recycled (context full),
   * the tmux PROCESS is replaced but the agent — its worktree, branch, claims and card — is the same actor
   * continuing the same job. The worktree belongs to the agentId, not to the process. Defaults to sessionId
   * for a session that was never recycled.
   */
  agentId: string;
  role: AgentRole;
  /** `agent/<sessionId>`. ABSENT for a session with no isolation (an ADOPTED legacy tmux session — 6.2). */
  branch?: string;
  /** `<repoRoot>/.worktrees/agent-<sessionId>`. Absent ⇒ this session has no isolated tree (adopted). */
  worktreePath?: string;
  /** the sha the tree was cut from — kept in lockstep with `refs/agent-base/<sessionId>` (G4). */
  baseCommit?: string;
  /** the board/card the session is working on, when it has one. Card-less is legitimate (D2: self-dev). */
  board?: string;
  cardId?: string;
  /** what the session said it was doing — the human-readable "who owns this tree" for /processes. */
  task: string;
  /** who opened it (the MCP token principal / surface), when known. */
  actor?: string;
  /** WS-6.1 — who asked for this session to exist. A human spawn and a copilot dispatch read differently
   *  in the fleet view (and only the copilot's are the steward's to reap). */
  spawnedBy?: "human" | "copilot";
  /** the model the session runs (WS-7 decides the default per role); informational for the fleet view. */
  model?: string;
  /** WS-6.1 — the tmux session name that currently HOSTS this agent. Changes on recycle; absent for a
   *  session with no process attached (e.g. opened by a Claude Code session that is not tmux-hosted). */
  tmuxSession?: string;
  /** cwd of the hosting process + its transcript (absorbed from the dev-tools map — feeds contextPct). */
  cwd?: string;
  transcriptFile?: string;
  /**
   * WS-6.2 — TRUE for a session ADOPTED from a tmux created outside the tool: it has visibility and claims
   * but NO isolated worktree. This is VISIBLE DEBT, not a supported mode: the fleet view warns on it so the
   * pattern gets extinguished, not accommodated.
   */
  adopted?: boolean;
  openedAt: string;
  /** ISO of the last tool call. The ONLY thing standing between a live session's tree and the reaper (G7). */
  heartbeatAt: string;
  /** the last submit's pinned sha + when — so /processes can say "submitted, waiting on the train". */
  lastSubmit?: { at: string; pinnedSha: string };
}

export interface SessionStore {
  /**
   * LENIENT read — an unreadable registry reads as empty. Right for the callers that only ever REFUSE
   * work with it (the cap, the listings): being wrong costs a rejected request.
   */
  load(): Promise<AgentSession[]>;
  /**
   * STRICT read — THROWS when the registry exists but cannot be understood, and returns `[]` only when
   * it genuinely isn't there. Required by any caller building a PROTECTION list ({@link liveSessionIds}),
   * where "I couldn't read it" and "nobody is alive" must never be the same answer.
   *
   * Optional so an injected fake (tests) needn't implement it — those supply their data directly, and
   * {@link liveSessionIds} falls back to {@link load}.
   */
  loadStrict?(): Promise<AgentSession[]>;
  persist(sessions: AgentSession[]): Promise<void>;
}

/**
 * How long a session with NO heartbeat is still considered alive. Deliberately GENEROUS: the cost of
 * waiting is a leaked directory (cheap, node_modules are links); the cost of being wrong is deleting the
 * tree of a working agent MID-EDIT — which has already happened once to a RUN worktree, whose life is
 * minutes (memory `harness-do-worktree-reaped-midrun`). A session's is hours, so the same reaper aimed at it
 * is a much bigger gun. Even past the TTL only the FOLDER is freed; the BRANCH goes through the
 * fail-closed teardown, which preserves un-integrated work.
 */
// A regra de liveness mora em `session-liveness.ts` (o guard de `worktree.ts` precisa dela e não
// pode importar ESTE módulo — seria ciclo). Importada para uso local E re-exportada, para não
// quebrar quem já a importava daqui.
export { SESSION_HEARTBEAT_TTL_MS, isSessionAlive };

// --- PURE decisions (no IO — the testable core) -----------------------------------------------------


/**
 * WS-6.2 — one live session, as the REFUSAL reports it. The refusal carries the QUEUE (structured, not prose)
 * because the caller's next move depends on WHO is holding the box: a human waits, the copilot re-prioritises,
 * an agent takes card-less work. "Saturated, try later" would make all three of them poll blindly.
 */
export interface FleetQueueRow {
  sessionId: string;
  agentId: string;
  role: AgentRole;
  task: string;
  board?: string;
  cardId?: string;
  heartbeatAt: string;
}

export type AdmissionVerdict = { ok: true } | { ok: false; reason: string; queue: FleetQueueRow[] };

/** The live sessions, in the shape a refusal (or the fleet view) reports them. PURE. */
export function fleetQueue(live: AgentSession[], now: number, ttlMs = SESSION_HEARTBEAT_TTL_MS): FleetQueueRow[] {
  return live
    .filter((s) => isSessionAlive(s, now, ttlMs))
    .map((s) => ({
      sessionId: s.sessionId,
      agentId: s.agentId,
      role: s.role,
      task: s.task,
      board: s.board,
      cardId: s.cardId,
      heartbeatAt: s.heartbeatAt,
    }));
}

/**
 * May another session worktree be opened right now? PURE. Two independent gates:
 *   • the CAP — N simultaneous trees (disk is cheap: node_modules are links; simultaneous BUILDS are not);
 *   • the BOX — the same RAM/load thresholds the HEAVY autorun lane already respects, since a session does
 *     exactly what a heavy run does (build + suite). Admission is the ONLY thing protecting the VPS here,
 *     because unlike a run nothing else throttles a session.
 * Only sessions still ALIVE count against the cap — a dead one's tree is garbage the reaper will collect,
 * and letting it block new work would turn a crash into a permanent capacity loss.
 */
/**
 * Separa as sessões cuja ÁRVORE ainda existe no disco das que viraram FANTASMA (registro diz que
 * existe, disco diz que não).
 *
 * Isto não é hipótese: em 2026-07-21 o cap ficou 4/4 com QUATRO fantasmas e recusou todo
 * `worktree_open` novo — a capacidade inteira da frota travada por entradas cujas pastas já não
 * existiam. O caminho sancionado de limpeza (`worktree_discard`) já é idempotente para uma árvore
 * ausente; o que faltava era alguém NOTAR sozinho, sem depender de um humano adivinhar quais ids
 * descartar na mão.
 *
 * Uma sessão ADOTADA (6.2) não tem `worktreePath` e por definição não tem árvore — ela NUNCA é
 * fantasma, senão a limpeza comeria justamente as sessões que existem sem isolamento.
 */
export async function partitionByTreePresence(
  fs: Pick<WorktreeFs, "isDir">,
  sessions: AgentSession[],
): Promise<{ present: AgentSession[]; ghosts: AgentSession[] }> {
  const present: AgentSession[] = [];
  const ghosts: AgentSession[] = [];
  for (const s of sessions) {
    if (!s.worktreePath) {
      present.push(s); // adotada: sem árvore POR DESENHO
      continue;
    }
    // Erro de leitura ⇒ trata como PRESENTE. "Não consegui olhar" nunca pode virar "não existe":
    // é a mesma regra fail-closed que impede o reaper de varrer uma sessão viva.
    const exists = await fs.isDir(s.worktreePath).catch(() => true);
    (exists ? present : ghosts).push(s);
  }
  return { present, ghosts };
}

export function admissionVerdict(
  live: AgentSession[],
  now: number,
  opts: { maxWorktrees: number; resources?: VpsResources; thresholds?: SchedulerThresholds; ttlMs?: number },
): AdmissionVerdict {
  const alive = live.filter((s) => isSessionAlive(s, now, opts.ttlMs));
  const queue = fleetQueue(live, now, opts.ttlMs);
  if (alive.length >= opts.maxWorktrees) {
    const who = alive.map((s) => `${s.sessionId.slice(0, 8)} (${s.task.slice(0, 40)})`).join(", ");
    return {
      ok: false,
      queue,
      reason:
        `cap de worktrees de sessão atingido: ${alive.length}/${opts.maxWorktrees} vivos — ${who}. ` +
        `Feche uma sessão (worktree_discard) ou aumente autorun.sessions.maxWorktrees.`,
    };
  }
  if (opts.resources && opts.thresholds && isVpsOverloaded(opts.resources, opts.thresholds)) {
    return {
      ok: false,
      queue,
      reason:
        `VPS saturada (RAM livre ${Math.round(opts.resources.freeRamMb)}MB < ${opts.thresholds.ramFreeMb}MB ou ` +
        `load ${opts.resources.loadAvg1.toFixed(2)} > ${opts.thresholds.loadAvg1}) — tente de novo quando a fila drenar.`,
    };
  }
  return { ok: true };
}

// --- IO ---------------------------------------------------------------------------------------------

export interface SessionWorktreeDeps {
  exec: ExecFn;
  fs: WorktreeFs;
  repoRoot: string;
  store: SessionStore;
  /** the SAME integration base the runs are cut from (`mergeQueue.ensureRunBase()` — stage, synced). */
  ensureRunBase: () => Promise<string>;
  /** the SAME train the runs integrate through — the only integrator of code (D12). */
  enqueueMerge: (entry: Omit<MergeQueueEntry, "status" | "enqueuedAt">) => Promise<void>;
  /** runIds with a LIVE entry on the train — a session may not submit twice concurrently (see submit). */
  liveRunIds: () => Promise<string[]>;
  now?: () => number;
  maxWorktrees?: number;
  probeResources?: () => VpsResources;
  thresholds?: SchedulerThresholds;
  ttlMs?: number;
}

const nowOf = (deps: SessionWorktreeDeps): number => (deps.now ?? Date.now)();

/** An {@link AgentSession} that PROVABLY has an isolated tree — the shape every git op below needs. */
export type IsolatedSession = AgentSession & { branch: string; worktreePath: string; baseCommit: string };

/**
 * WS-6.1/6.2 — narrow a registry entry to one that actually HAS a worktree, or say why not, in ONE place.
 * An ADOPTED session (a legacy tmux the tool did not create) is registered for visibility + claims but owns
 * no tree, so submit/refresh/discard are meaningless for it. Refusing here with a prescriptive message beats
 * every call site re-deriving the same `if` — and beats a non-null assertion, which would turn "adopted" into
 * a runtime crash reading `undefined.worktreePath`.
 */
function requireIsolated(session: AgentSession): { ok: true; session: IsolatedSession } | { ok: false; reason: string } {
  if (session.branch && session.worktreePath && session.baseCommit) {
    return { ok: true, session: session as IsolatedSession };
  }
  return {
    ok: false,
    reason:
      `sessão ${session.sessionId.slice(0, 8)} não tem worktree isolado` +
      (session.adopted ? " (foi ADOTADA de um tmux criado fora da ferramenta)" : "") +
      ` — abra uma com worktree_open para trabalhar em código pelo train.`,
  };
}

/** git that never throws — a failure is a RESULT here, not an exception (the merge-queue/run-base idiom). */
async function tryGit(
  exec: ExecFn,
  cwd: string,
  cmd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(`git ${cmd}`, { cwd, timeout: EXEC_TIMEOUT_MS });
    return { ok: true, stdout: String(stdout), stderr: String(stderr ?? "") };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return { ok: false, stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? e?.message ?? "") };
  }
}

export interface OpenSessionInput {
  board?: string;
  cardId?: string;
  task: string;
  actor?: string;
  /** WS-6.1 — defaults to `implement` (the historical behaviour: worktree_open was for code work). */
  role?: AgentRole;
  spawnedBy?: "human" | "copilot";
  model?: string;
  tmuxSession?: string;
  /** WS-6.3 — RECYCLING: pass the previous agent's id so the new process inherits the SAME logical
   *  identity (its claims and its history follow it). Omitted ⇒ a brand-new agent (agentId = sessionId). */
  agentId?: string;
}

export type OpenSessionResult =
  | { ok: true; session: AgentSession }
  /** `queue` is present ONLY on an ADMISSION refusal (who is holding the box) — never on a git/plumbing failure. */
  | { ok: false; reason: string; queue?: FleetQueueRow[] };

/**
 * WS-1.1/1.2 — provision a session's tree. EXACTLY the runs' path (`ensureRunBase` → `worktree add -b` →
 * `provisionNodeModules`), plus the base-ref that keeps the own-work ruler honest across refreshes (G4).
 *
 * Why this is a TOOL and not "the agent runs git": the branch mint, the base, the admission and (WS-4) the
 * claim then live in ONE auditable place. A session that cut its own branch would eventually cut it from
 * the wrong base — the single most expensive recurring bug in this system (memory `storymap-run-base-one-truth`).
 */
/**
 * ADR-065 — the registry mutex. EVERY mutator here is a read-modify-write over the WHOLE session list
 * (`load()` → change → `persist(all)`), so two that interleave lose one of the two edits: last writer wins,
 * with the loser's session silently GONE from the registry.
 *
 * This is not theoretical, and it is not rare — it is the fleet's front door. `openSessionWorktree` holds
 * its stale read across `git worktree add` + `provisionNodeModules` + `update-ref`, a window of hundreds of
 * milliseconds. Opening 3 sessions at once (the ADR-065 headline scenario, and literally what the 2026-07-16
 * collisions were) left ONE in the registry. The other two got a worktree and a branch on disk that the
 * registry does not know about, so `submit`/`refresh`/`discard` all answered "sessão desconhecida (já
 * descartada?)" and the agent could never integrate its work; the admission cap, which counts registry
 * entries, was defeated at the same time. The heartbeat (`touchSession`) races the same way, on every tick.
 *
 * ONE key for the whole file: the unit of contention is the LIST, not a session — a per-session key would
 * serialize nothing (the concurrent writers touch different sessions and still clobber the same array).
 * In-process is the RIGHT scope here (unlike board data — see the D4 rule): sessions.json has exactly one
 * writer, this service. The mutators never call each other, so a single key cannot deadlock.
 */
const SESSIONS_LOCK = "agent-sessions";
const withSessionsLock = <T>(fn: () => Promise<T>): Promise<T> => withKeyedLock(SESSIONS_LOCK, fn);

export async function openSessionWorktree(
  deps: SessionWorktreeDeps,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  return withSessionsLock(() => openSessionWorktreeUnlocked(deps, input));
}

async function openSessionWorktreeUnlocked(
  deps: SessionWorktreeDeps,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  const now = nowOf(deps);
  const loaded = await deps.store.load();
  // SELF-HEAL antes de julgar o cap: uma entrada cuja árvore sumiu do disco é lixo puro e não pode
  // segurar uma vaga da frota. Desregistramos (o registro é a fonte do cap) e seguimos — sem isto,
  // uma árvore removida por fora do fluxo transforma um incidente pontual em perda PERMANENTE de
  // capacidade, que só um humano descobrindo os ids na mão consegue destravar.
  const { present: sessions, ghosts } = await partitionByTreePresence(deps.fs, loaded);
  if (ghosts.length > 0) {
    await deps.store.persist(sessions);
    console.warn(
      `[sessão] ${ghosts.length} entrada(s) FANTASMA no registro (árvore ausente) — desregistrada(s): ` +
        ghosts.map((g) => `${g.sessionId.slice(0, 8)} (${g.task.slice(0, 30)})`).join(", "),
    );
  }
  const verdict = admissionVerdict(sessions, now, {
    maxWorktrees: deps.maxWorktrees ?? DEFAULT_MAX_SESSION_WORKTREES,
    resources: deps.probeResources?.(),
    thresholds: deps.thresholds,
    ttlMs: deps.ttlMs,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason, queue: verdict.queue };

  const sessionId = randomUUID();
  const branch = agentBranch(sessionId);
  const worktreePath = agentWorktreePath(deps.repoRoot, sessionId);

  const base = await deps.ensureRunBase();
  if (!base) return { ok: false, reason: "não consegui resolver a base de integração (ensureRunBase vazio)" };

  const added = await tryGit(
    deps.exec,
    deps.repoRoot,
    `worktree add ${quote(worktreePath)} -b ${quote(branch)} ${quote(base)}`,
  );
  if (!added.ok) return { ok: false, reason: `git worktree add falhou: ${added.stderr.slice(0, 300)}` };

  // The deps a fresh checkout has NONE of (node_modules is gitignored and does not hoist) — linked in, not
  // installed: instantaneous, no network. Without it tsc/test/build fail by ENVIRONMENT, not by the code.
  await provisionNodeModules(deps.fs, deps.repoRoot, worktreePath);

  // G4: record the base OUTSIDE the branch's own history, so a later rebase can't erase it.
  const ref = await tryGit(deps.exec, deps.repoRoot, `update-ref ${quote(agentBaseRef(sessionId))} ${quote(base)}`);
  if (!ref.ok) {
    // FAIL CLOSED: without the base-ref the own-work ruler would silently fall back to the reflog and, after
    // the first refresh, over-attribute the stage's commits to this session — /processes lies, the GC
    // mis-judges. Better no tree than an unmeasurable one; roll the half-provisioned tree back.
    await tryGit(deps.exec, deps.repoRoot, `worktree remove ${quote(worktreePath)} --force`);
    await tryGit(deps.exec, deps.repoRoot, `branch -D ${quote(branch)}`);
    return { ok: false, reason: `não consegui gravar ${agentBaseRef(sessionId)}: ${ref.stderr.slice(0, 200)}` };
  }

  const at = new Date(now).toISOString();
  const session: AgentSession = {
    sessionId,
    // A fresh agent IS its session; a RECYCLED one carries the previous agentId so its claims/worktree
    // history stay attached to the same logical actor across the process swap (6.3).
    agentId: input.agentId ?? sessionId,
    role: input.role ?? "implement",
    branch,
    worktreePath,
    baseCommit: base,
    board: input.board,
    cardId: input.cardId,
    task: input.task,
    actor: input.actor,
    spawnedBy: input.spawnedBy,
    model: input.model,
    tmuxSession: input.tmuxSession,
    openedAt: at,
    heartbeatAt: at,
  };
  await deps.store.persist([...sessions, session]);
  return { ok: true, session };
}

export type SubmitSessionResult =
  | { ok: true; entryId: string; pinnedSha: string; committed: boolean }
  | { ok: false; reason: string };

/**
 * WS-1.2 — commit whatever the session has pending, PIN the sha, and hand it to the train.
 *
 * The pin is the whole point (G5): from this instant the session is free to keep working, and whatever it
 * commits NEXT is simply not part of this submit. Without it the train would gate one tree and merge
 * another — silently shipping code no gate ever saw.
 */
export async function submitSessionWork(
  deps: SessionWorktreeDeps,
  input: { sessionId: string; message?: string },
): Promise<SubmitSessionResult> {
  return withSessionsLock(() => submitSessionWorkUnlocked(deps, input));
}

async function submitSessionWorkUnlocked(
  deps: SessionWorktreeDeps,
  input: { sessionId: string; message?: string },
): Promise<SubmitSessionResult> {
  const sessions = await deps.store.load();
  const entry = sessions.find((s) => s.sessionId === input.sessionId);
  if (!entry) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?)` };
  const isolated = requireIsolated(entry);
  if (!isolated.ok) return { ok: false, reason: isolated.reason };
  const session = isolated.session;

  // One in-flight submit per session. The train's enqueue is idempotent BY runId, so a second submit while
  // the first is still live would be SILENTLY IGNORED — the session would believe it had submitted and wait
  // forever on a verdict for the older sha. Refuse loudly instead.
  const live = await deps.liveRunIds().catch(() => [] as string[]);
  if (live.includes(session.sessionId)) {
    return {
      ok: false,
      reason:
        `esta sessão já tem uma submissão EM VOO no train (sha ${session.lastSubmit?.pinnedSha.slice(0, 8) ?? "?"}). ` +
        `Aguarde o veredito (wait_for_run/runner_status) antes de submeter de novo.`,
    };
  }

  // Same commit path as a run's settle: fail-closed secret scan, `--no-verify` (the non-security hooks are
  // for humans at a keyboard), message via file (never interpolated into a shell — story-yy3hds).
  let committed = false;
  try {
    const res = await commitAllPending(
      deps.exec,
      session.worktreePath,
      deps.repoRoot,
      input.message ?? `sessão(${session.sessionId.slice(0, 8)}): ${session.task}`.slice(0, 200),
    );
    committed = res.committed;
  } catch (err) {
    return { ok: false, reason: `commit da sessão falhou: ${String(err instanceof Error ? err.message : err).slice(0, 300)}` };
  }

  const head = await tryGit(deps.exec, deps.repoRoot, `rev-parse ${quote(session.branch)}`);
  const pinnedSha = head.stdout.trim();
  if (!head.ok || !pinnedSha) return { ok: false, reason: `não consegui resolver o sha de ${session.branch}` };

  // Nothing to integrate: the tree was clean AND the branch never moved past its base. Enqueuing here would
  // put a no-op on the train (a full gate suite for zero delta) — the exact waste the run path also refuses.
  const { base, provenance } = await resolveRunBase(deps.exec, deps.repoRoot, session.branch, {
    // o branch de integração é DECLARADO (`autorun.staging.branch`); fixar o literal aqui
  // sobrescrevia a declaração do repositório — o train já lia o declarado, as réguas de ciclo de vida não
    stageBranch: loadRunnerConfig().autorun.staging?.branch ?? "stage",
  });
  if (base && isExactBase(provenance)) {
    const work = await runOwnWork(deps.exec, deps.repoRoot, session.branch, base);
    if (work && work.commits === 0) {
      return { ok: false, reason: "nada a submeter: a sessão não commitou nada acima da sua base" };
    }
  }

  await deps.enqueueMerge({
    runId: session.sessionId,
    kind: "session",
    // A card-less session still needs a board slot on the entry (the field is not optional): its own board
    // when it has one, else empty — which matches no board, so no board's cockpit ever projects it. Every
    // card EFFECT is keyed off `cardId`, not this.
    board: session.board ?? "",
    cardId: session.cardId,
    branch: session.branch,
    baseCommit: session.baseCommit,
    pinnedSha,
  });

  session.lastSubmit = { at: new Date(nowOf(deps)).toISOString(), pinnedSha };
  session.heartbeatAt = new Date(nowOf(deps)).toISOString();
  await deps.store.persist(sessions);
  return { ok: true, entryId: session.sessionId, pinnedSha, committed };
}

export type RefreshSessionResult =
  | { ok: true; baseCommit: string; rebased: boolean }
  | { ok: false; reason: string; conflict?: boolean };

/**
 * WS-1.2/G4 — catch the session up to the current integration base: rebase its branch onto the new base
 * INSIDE its own worktree, and move `refs/agent-base/<id>` with it.
 *
 * The ref update is not bookkeeping — it is the load-bearing half. After a rebase the reflog still says
 * `Created from <original cut>`, so `original..branch` would re-absorb every commit stage gained since,
 * counting them as this session's work: /processes cries wolf, the GC mis-judges, convergence errs. The
 * ref is therefore updated ONLY on a completed rebase; a conflicted rebase is left IN the session's tree
 * for it to resolve (never touching main/stage), and the base-ref stays on the old base until the session
 * finishes and calls refresh again — at which point the rebase is a no-op and the ref moves. Stale-but-true
 * beats moved-but-wrong.
 */
export async function refreshSessionWorktree(
  deps: SessionWorktreeDeps,
  input: { sessionId: string },
): Promise<RefreshSessionResult> {
  return withSessionsLock(() => refreshSessionWorktreeUnlocked(deps, input));
}

async function refreshSessionWorktreeUnlocked(
  deps: SessionWorktreeDeps,
  input: { sessionId: string },
): Promise<RefreshSessionResult> {
  const sessions = await deps.store.load();
  const entry = sessions.find((s) => s.sessionId === input.sessionId);
  if (!entry) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?)` };
  const isolated = requireIsolated(entry);
  if (!isolated.ok) return { ok: false, reason: isolated.reason };
  const session = isolated.session;

  const base = await deps.ensureRunBase();
  if (!base) return { ok: false, reason: "não consegui resolver a base de integração (ensureRunBase vazio)" };

  const rebase = await tryGit(deps.exec, session.worktreePath, `rebase ${quote(base)}`);
  if (!rebase.ok) {
    return {
      ok: false,
      conflict: true,
      reason:
        `rebase sobre ${base.slice(0, 8)} conflitou — os conflitos estão NO SEU worktree (${session.worktreePath}). ` +
        `Resolva (git add + git rebase --continue) ou aborte (git rebase --abort) e chame worktree_refresh de novo. ` +
        `Detalhe: ${(rebase.stderr || rebase.stdout).slice(0, 400)}`,
    };
  }

  const ref = await tryGit(deps.exec, deps.repoRoot, `update-ref ${quote(agentBaseRef(session.sessionId))} ${quote(base)}`);
  if (!ref.ok) return { ok: false, reason: `rebase ok mas não consegui mover ${agentBaseRef(session.sessionId)}: ${ref.stderr.slice(0, 200)}` };

  const rebased = session.baseCommit !== base;
  session.baseCommit = base;
  session.heartbeatAt = new Date(nowOf(deps)).toISOString();
  await deps.store.persist(sessions);
  return { ok: true, baseCommit: base, rebased };
}

export type DiscardSessionResult =
  | { ok: true; branchPreserved: boolean; detail: string }
  | { ok: false; reason: string };

/**
 * WS-1.1 — tear the session's tree down through the SAME fail-closed teardown the runs use
 * (`WorktreeOps.remove` → `disposeRunBranch`): a branch carrying un-integrated commits is PRESERVED as
 * `failed/agent/<id>` (recoverable by cherry-pick), and only a provably-empty one is deleted. This is the
 * ONLY place a session's branch is ever disposed — the train never deletes it (see
 * `deleteBranchAfterIntegration` in merge-queue.ts).
 */
export async function discardSessionWorktree(
  deps: SessionWorktreeDeps,
  input: { sessionId: string },
): Promise<DiscardSessionResult> {
  return withSessionsLock(() => discardSessionWorktreeUnlocked(deps, input));
}

async function discardSessionWorktreeUnlocked(
  deps: SessionWorktreeDeps,
  input: { sessionId: string },
): Promise<DiscardSessionResult> {
  const sessions = await deps.store.load();
  const entry = sessions.find((s) => s.sessionId === input.sessionId);
  if (!entry) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?)` };
  const isolated = requireIsolated(entry);
  if (!isolated.ok) {
    // An ADOPTED session owns no tree and no branch — there is nothing to tear down, but it must still
    // LEAVE the fleet (otherwise a dead adopted row lingers forever holding a slot in the view). Not an
    // error: deregistering is exactly what "discard" means for a session with no isolation.
    await deps.store.persist(sessions.filter((s) => s.sessionId !== entry.sessionId));
    return { ok: true, branchPreserved: false, detail: "sessão sem worktree (adotada) — apenas desregistrada da frota" };
  }
  const session = isolated.session;

  const ops = makeWorktreeOps(deps.exec, deps.fs);
  try {
    // `consent`: ESTE é o caminho sancionado — o próprio agente pediu para descartar a sua árvore.
    // Sem esta declaração o guard de `remove` recusaria (a sessão ainda está viva no registro; só
    // desregistramos no fim desta função).
    await ops.remove(session.worktreePath, session.branch, session.baseCommit, { consent: "session-discard" });
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err);
    // IDEMPOTÊNCIA — uma árvore que JÁ não existe é um teardown BEM-SUCEDIDO, não um erro.
    //
    // Sem isto o fantasma é IMORTAL, e isso não é teórico: quando algo remove a pasta pelas costas do
    // registro (o bug irmão deste arquivo — ver liveSessionIds), `git worktree remove` passa a responder
    // "is not a working tree" PARA SEMPRE. O `return {ok:false}` abortava ANTES do `store.persist` que
    // desregistra a sessão — então a entrada morta ficava no registro, e como o cap conta sessões
    // REGISTRADAS, cada fantasma consumia uma vaga permanentemente. Medido em produção: 4/4 vagas ocupadas
    // por sessões cujas árvores não existiam, bloqueando qualquer `worktree_open` novo. O caminho sancionado
    // de limpeza era o ÚNICO que não conseguia limpar exatamente o lixo que ele existe para limpar.
    //
    // Só o "não é worktree/não existe" é absolvido: qualquer OUTRA falha (permissão, git travado, disco)
    // continua abortando, porque aí a árvore pode estar viva e desregistrá-la perderia a pista dela.
    if (!/not a working tree|No such file or directory|is not a valid path/i.test(detail)) {
      return { ok: false, reason: `teardown falhou: ${detail.slice(0, 300)}` };
    }
    // A pasta já se foi, mas o BRANCH pode carregar trabalho — segue para a disposição fail-closed abaixo,
    // que é quem decide preservar (`failed/agent/<id>`) ou deletar. Nada de atalho: a regra é a mesma.
    await tryGit(deps.exec, deps.repoRoot, `worktree prune`);
    await ops.disposeBranch(deps.repoRoot, session.branch, session.baseCommit).catch(() => {});
  }

  // Did the fail-closed tail keep the work? Ask git, don't assume: `remove` decides preserve-vs-delete on
  // its own and the answer is what we must report back to the agent (its code may still be recoverable).
  // The format string MUST be quoted: `%(refname:short)` bare is a shell syntax error (`(` is special),
  // which would make this read as "no branch left" and report a PRESERVED branch as deleted — a lie about
  // the one thing the agent needs the truth about.
  const still = await tryGit(
    deps.exec,
    deps.repoRoot,
    `for-each-ref --format='%(refname:short)' ${quote(`refs/heads/agent/${session.sessionId}`)} ` +
      `${quote(`refs/heads/failed/agent/${session.sessionId}`)} ${quote(`refs/heads/conflicted/agent/${session.sessionId}`)}`,
  );
  const remaining = still.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const branchPreserved = remaining.length > 0;

  // The base-ref outlives the branch only as long as the branch does: while a `failed/agent/<id>` snapshot
  // exists, the ruler still needs the base to measure it. With no branch left there is nothing to measure,
  // so the ref is dropped instead of leaking forever.
  if (!branchPreserved) {
    await tryGit(deps.exec, deps.repoRoot, `update-ref -d ${quote(agentBaseRef(session.sessionId))}`);
  }

  await deps.store.persist(sessions.filter((s) => s.sessionId !== session.sessionId));
  return {
    ok: true,
    branchPreserved,
    detail: branchPreserved
      ? `worktree removido; branch PRESERVADO como ${remaining.join(", ")} (commits não integrados — recuperável por cherry-pick)`
      : "worktree removido; branch sem trabalho próprio → deletado (nada a preservar)",
  };
}

/**
 * WS-6.2 — ADOPT a tmux session created OUTSIDE the tool: give it identity, role and (via the caller) claims,
 * WITHOUT a worktree. Adoption does NOT move a running agent's cwd, so it cannot retrofit isolation — the
 * session keeps editing wherever it already was.
 *
 * This exists to make the legacy pattern VISIBLE, not to support it: an adopted row is flagged `adopted` so
 * the fleet view can warn, which is how the pattern gets extinguished rather than accommodated. Idempotent by
 * tmux name (re-adopting updates the row instead of forking a second identity for one process).
 */
export async function adoptSession(
  deps: SessionWorktreeDeps,
  input: { tmuxSession: string; role: AgentRole; board?: string; cardId?: string; task?: string; actor?: string; cwd?: string },
): Promise<{ ok: true; session: AgentSession } | { ok: false; reason: string }> {
  return withSessionsLock(() => adoptSessionUnlocked(deps, input));
}

async function adoptSessionUnlocked(
  deps: SessionWorktreeDeps,
  input: { tmuxSession: string; role: AgentRole; board?: string; cardId?: string; task?: string; actor?: string; cwd?: string },
): Promise<{ ok: true; session: AgentSession } | { ok: false; reason: string }> {
  const sessions = await deps.store.load();
  const at = new Date(nowOf(deps)).toISOString();
  const existing = sessions.find((s) => s.tmuxSession === input.tmuxSession);
  if (existing) {
    existing.role = input.role;
    existing.board = input.board ?? existing.board;
    existing.cardId = input.cardId ?? existing.cardId;
    existing.task = input.task ?? existing.task;
    existing.heartbeatAt = at;
    await deps.store.persist(sessions);
    return { ok: true, session: existing };
  }
  // ...Unlocked: we are ALREADY inside the registry lock, and it is not reentrant (a keyed FIFO chain —
  // re-acquiring it here would make this call wait on the tail its own caller is holding, i.e. deadlock).
  return registerSessionUnlocked(deps, {
    role: input.role,
    board: input.board,
    cardId: input.cardId,
    task: input.task ?? `sessão adotada (${input.tmuxSession})`,
    actor: input.actor,
    cwd: input.cwd,
    tmuxSession: input.tmuxSession,
    spawnedBy: "human", // adoption only ever happens for a tmux a human made by hand
    adopted: true,
  });
}

export interface RegisterSessionInput {
  role: AgentRole;
  task: string;
  board?: string;
  cardId?: string;
  actor?: string;
  cwd?: string;
  tmuxSession?: string;
  model?: string;
  spawnedBy?: "human" | "copilot";
  agentId?: string;
  /**
   * TRUE only for {@link adoptSession} — a tmux the tool did NOT create, editing who-knows-where. A session
   * the tool SPAWNED into a non-code role (triage/steward, board-data via MCP) has no tree either, but it is
   * not debt: it needs none. Conflating the two would make the fleet view warn about healthy sessions until
   * the operator learned to ignore the warning — which is how a debt marker dies.
   */
  adopted?: boolean;
}

/**
 * WS-6.2 — put a session in the registry WITHOUT a worktree. Two callers, one shape: `adoptSession` (legacy
 * tmux, `adopted: true`) and `claude_new` for a non-code role (triage/steward — board-data through MCP).
 *
 * No admission check here, deliberately: the cap counts TREES (`maxWorktrees`) and the thresholds gate work
 * that builds/tests. A session that only reads the board and writes cards through MCP costs neither, so
 * refusing it when the box is busy would block the cheapest way to unblock the box.
 */
export async function registerSession(
  deps: SessionWorktreeDeps,
  input: RegisterSessionInput,
): Promise<{ ok: true; session: AgentSession }> {
  return withSessionsLock(() => registerSessionUnlocked(deps, input));
}

async function registerSessionUnlocked(
  deps: SessionWorktreeDeps,
  input: RegisterSessionInput,
): Promise<{ ok: true; session: AgentSession }> {
  const sessions = await deps.store.load();
  const at = new Date(nowOf(deps)).toISOString();
  const sessionId = randomUUID();
  const session: AgentSession = {
    sessionId,
    agentId: input.agentId ?? sessionId,
    role: input.role,
    board: input.board,
    cardId: input.cardId,
    task: input.task,
    actor: input.actor,
    spawnedBy: input.spawnedBy,
    model: input.model,
    tmuxSession: input.tmuxSession,
    cwd: input.cwd,
    ...(input.adopted ? { adopted: true } : {}),
    openedAt: at,
    heartbeatAt: at,
  };
  await deps.store.persist([...sessions, session]);
  return { ok: true, session };
}

/**
 * WS-6.1/6.3 — patch the mutable half of a registry row: which tmux HOSTS the agent right now, its cwd, its
 * transcript (only discoverable AFTER the process exists — it is how `claude_sessions` computes contextPct)
 * and the model it ended up on. Recycling swaps exactly these while `sessionId`/`agentId`/`branch`/
 * `worktreePath` stay put — the tree belongs to the logical agent, not to the process (6.3).
 *
 * Returns the updated row, or null when the session is gone (discarded mid-spawn) — never throws: the callers
 * are stamping metadata, and losing a transcript path must not fail a spawn that already succeeded.
 */
export async function updateSession(
  deps: SessionWorktreeDeps,
  sessionId: string,
  patch: Partial<Pick<AgentSession, "tmuxSession" | "cwd" | "transcriptFile" | "model" | "task" | "role" | "board" | "cardId">>,
): Promise<AgentSession | null> {
  return withSessionsLock(() => updateSessionUnlocked(deps, sessionId, patch));
}

async function updateSessionUnlocked(
  deps: SessionWorktreeDeps,
  sessionId: string,
  patch: Partial<Pick<AgentSession, "tmuxSession" | "cwd" | "transcriptFile" | "model" | "task" | "role" | "board" | "cardId">>,
): Promise<AgentSession | null> {
  try {
    const sessions = await deps.store.load();
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return null;
    Object.assign(session, patch);
    session.heartbeatAt = new Date(nowOf(deps)).toISOString();
    await deps.store.persist(sessions);
    return session;
  } catch {
    return null;
  }
}

/** Refresh a session's heartbeat (every tool call proves the agent is alive). Best-effort — never throws. */
export async function touchSession(deps: SessionWorktreeDeps, sessionId: string): Promise<void> {
  return withSessionsLock(() => touchSessionUnlocked(deps, sessionId));
}

async function touchSessionUnlocked(deps: SessionWorktreeDeps, sessionId: string): Promise<void> {
  try {
    const sessions = await deps.store.load();
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) return;
    session.heartbeatAt = new Date(nowOf(deps)).toISOString();
    await deps.store.persist(sessions);
  } catch {
    /* a missed heartbeat is harmless (the TTL is hours); a throw here would fail a real tool call */
  }
}

/**
 * Renova o heartbeat de uma sessão a partir da PROVA DE TRABALHO (a árvore foi editada), e não de uma
 * chamada de tool. Best-effort, sob o mesmo lock de sempre.
 *
 * Por que isto existe em vez de a varredura simplesmente "proteger e seguir": `heartbeatAt` é lido por
 * MUITO mais gente que a varredura — o cap de admissão, o painel /processes, o `liveSessionIds` que serve
 * de lista de PROTEÇÃO ao branch-gc. Se a varredura guardasse a descoberta só para si, uma sessão
 * trabalhando seguiria "morta" para todos esses (frota mostrando um agente vivo como morto, cap
 * contando errado, GC tratando o branch dele como órfão) — duas respostas para "esta sessão está viva?".
 * Alimentando o MESMO carimbo, a atividade da árvore vira o segundo PRODUTOR de um sinal único, e todo
 * consumidor existente passa a acertar sem saber que ela existe.
 */
export async function renewHeartbeatFromActivity(sessionId: string, deps?: Pick<SessionWorktreeDeps, "store" | "now">): Promise<void> {
  const store = deps?.store ?? makeSessionStore();
  return withSessionsLock(async () => {
    try {
      const sessions = await store.load();
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) return;
      session.heartbeatAt = new Date(deps?.now ? deps.now() : Date.now()).toISOString();
      await store.persist(sessions);
    } catch {
      /* o carimbo é otimização de verdade compartilhada; a proteção em si não depende dele */
    }
  });
}

/** What one pass of {@link reconcileFleet} did — reported so the caller/UI can say WHY a row changed. */
export interface FleetReconcileResult {
  /** sessions whose hosting tmux is gone (their claims were released as `session-died`). */
  died: Array<{ sessionId: string; agentId: string; tmuxSession?: string; claimsReleased: number }>;
  /** sessions whose heartbeat was renewed because their tmux is alive. */
  alive: string[];
}

/**
 * WS-6.3 — the fleet's LIFE SIGN, run on every `claude_sessions` poll (the UI already polls it).
 *
 * Two directions, and both matter:
 *  • ALIVE: a session whose tmux is still there gets its heartbeat renewed. This is what makes the TTL
 *    meaningful — without it a working agent that simply hasn't called a tool in hours would "die" on paper
 *    and have its tree reaped (G7), which is the failure this whole registry exists to prevent.
 *  • DEAD: a session whose tmux vanished releases its claims with a NAMED reason (`session-died`), so the
 *    card is immediately available to someone else instead of waiting out the claim TTL. The WORKTREE is NOT
 *    touched here — it goes through the fail-closed teardown (branch preserved if it holds un-integrated
 *    code); the folder is disposable, the work never is.
 *
 * `liveTmuxSessions` is injected (the caller already listed them) so this stays pure-ish and testable.
 * Sessions with NO tmux at all (opened by a non-tmux Claude Code session via worktree_open) are left ALONE:
 * absence of a process handle is not evidence of death, and guessing here would reap live work.
 *
 * ⚠️ `null` = A SONDA NÃO RESPONDEU, e é um valor distinto de "zero sessões vivas". A lista vazia diz
 * "todos morreram" e LIBERA os claims; um `tmux list-sessions` que estourou o timeout sob carga diria
 * exatamente a mesma coisa se as duas respostas colapsassem — entregando os cards de agentes que estão
 * trabalhando neste instante. Com `null` esta função não infere NADA (nem vida, nem morte) e devolve um
 * resultado vazio. Quem sonda usa {@link probeLiveTmuxSessions}, que preserva a distinção.
 */
export async function reconcileFleet(
  deps: SessionWorktreeDeps & {
    /** WS-4's `sweepExpired(deadActors)` — it already stamps the tombstone `released: "session-died"` and is
     *  atomic under the claims lock, so the dead set goes in as ONE call rather than N racing releases. */
    sweepDeadActors?: (deadAgentIds: Set<string>) => Promise<Array<{ board: string; cardId: string; actor: string }>>;
    /** WS-4.4/6.3 — push a LIVE session's reservation out by another TTL. Without this a session working
     *  longer than the claim TTL (60min — most of them) silently loses its card to the next asker while it is
     *  still holding the tree: the reservation must live as long as the agent proves it is alive. */
    renewClaim?: (board: string, cardId: string, actor: string, ttlMs: number) => Promise<unknown>;
  },
  liveTmuxSessions: Iterable<string> | null,
): Promise<FleetReconcileResult> {
  if (liveTmuxSessions === null) return { died: [], alive: [] };
  return withSessionsLock(() => reconcileFleetUnlocked(deps, liveTmuxSessions));
}

async function reconcileFleetUnlocked(
  deps: SessionWorktreeDeps & {
    sweepDeadActors?: (deadAgentIds: Set<string>) => Promise<Array<{ board: string; cardId: string; actor: string }>>;
    renewClaim?: (board: string, cardId: string, actor: string, ttlMs: number) => Promise<unknown>;
  },
  liveTmuxSessions: Iterable<string>,
): Promise<FleetReconcileResult> {
  const live = new Set(liveTmuxSessions);
  const sessions = await deps.store.load();
  const at = new Date(nowOf(deps)).toISOString();
  const out: FleetReconcileResult = { died: [], alive: [] };
  const dead: AgentSession[] = [];
  const alive: AgentSession[] = [];
  let dirty = false;

  for (const s of sessions) {
    if (!s.tmuxSession) continue; // no process handle → nothing to infer, either way
    if (live.has(s.tmuxSession)) {
      s.heartbeatAt = at;
      out.alive.push(s.sessionId);
      alive.push(s);
      dirty = true;
      continue;
    }
    dead.push(s); // the tmux is GONE
  }
  if (dirty) await deps.store.persist(sessions);

  // The same proof of life, applied to the RESERVATION. Best-effort per session: a renew that fails (the claim
  // lapsed and someone else took the card) is not this function's problem to solve — the session finds out when
  // it tries to submit, and the fleet view shows the card as someone else's.
  if (deps.renewClaim) {
    await Promise.all(
      alive
        .filter((s) => s.board && s.cardId)
        .map((s) =>
          deps.renewClaim!(s.board!, s.cardId!, sessionClaimActor(s.agentId), CLAIM_TTL_SESSION_MS).catch(() => {}),
        ),
    );
  }

  if (dead.length && deps.sweepDeadActors) {
    // The dead set is the CLAIM ACTOR, not the bare agentId: claims are held as `session:<agentId>`
    // (claims.ts `sessionClaimActor` — the one source both sides read). Passing the bare id here would
    // match NO claim, and a dead agent's cards would stay reserved until their 60min TTL, silently.
    const released = await deps.sweepDeadActors(new Set(dead.map((s) => sessionClaimActor(s.agentId)))).catch(() => []);
    for (const s of dead) {
      out.died.push({
        sessionId: s.sessionId,
        agentId: s.agentId,
        tmuxSession: s.tmuxSession,
        claimsReleased: released.filter((c) => c.actor === sessionClaimActor(s.agentId)).length,
      });
    }
  } else {
    for (const s of dead) {
      out.died.push({ sessionId: s.sessionId, agentId: s.agentId, tmuxSession: s.tmuxSession, claimsReleased: 0 });
    }
  }
  return out;
}

// --- production wiring ------------------------------------------------------------------------------

/** `storymap/.runner/sessions.json` — durable BECAUSE the reaper/reconciler consult it across restarts. */
export function sessionsStatePath(): string {
  return path.join(runnerStateDir(), "sessions.json");
}

/**
 * Disk store: atomic temp+rename (the project's IO discipline — a half-written registry would read as
 * "nobody home" and authorise reaping live trees).
 *
 * TWO reads, because there are two kinds of caller. `load` is LENIENT (unreadable ⇒ empty), which is
 * correct for the callers that can only REFUSE work with the answer. `loadStrict` THROWS instead, for
 * the callers building a PROTECTION list.
 *
 * That split is not decoration. This function used to have ONE lenient read, and its doc claimed the
 * leniency "can only ever REFUSE work (cap), never authorise a delete" — true when the cap was the only
 * reader, and false the moment {@link liveSessionIds} started using it as "do not delete these". The
 * bare `catch { return [] }` below turned a corrupt or unreadable registry into "no session is alive",
 * which is precisely the fail-OPEN that {@link LiveSessionIdsResult} was introduced (2026-07-21, after
 * real work loss) to make impossible — the discriminated type forced the caller to decide, but the
 * value handed to it was always `ok`. Observed live on 2026-07-23: a server booted from a worktree
 * whose `.runner/` is gitignored (so: no registry file) declared FOUR live session trees "heartbeat
 * morto + TTL vencido"; only `removeWorktree`'s own fail-closed guard stopped the deletion.
 *
 * An ABSENT file is a FAILURE for the strict read, not an empty registry — and that distinction is the
 * incident above. "There is no registry here" is absence of EVIDENCE, never proof that nobody is alive;
 * the process that reads it may simply be looking at the wrong root (a worktree, where `.runner/` is
 * gitignored) while the real fleet is registered elsewhere. This module already states which way to err:
 * "the cost of waiting is a leaked directory (cheap, node_modules are links); the cost of being wrong is
 * deleting the tree of a working agent MID-EDIT". On a genuinely fresh box there are no session trees to
 * reap anyway, so refusing costs nothing there either. The lenient `load` keeps ENOENT ⇒ `[]`, which is
 * right for the cap (a missing registry means no sessions counted, which can only REFUSE work).
 */
export function makeSessionStore(file: string = sessionsStatePath()): SessionStore {
  const readOrThrow = async (): Promise<AgentSession[]> => {
    const raw = await fsp.readFile(file, "utf8"); // ENOENT included: "no registry" ≠ "nobody alive"
    const parsed = JSON.parse(raw) as unknown; // corrupt JSON throws — that is the point
    const list = Array.isArray(parsed) ? parsed : (parsed as { sessions?: unknown })?.sessions;
    if (!Array.isArray(list)) {
      throw new Error(`registro de sessões malformado (nem array nem {sessions:[…]}): ${file}`);
    }
    return list as AgentSession[];
  };

  return {
    async load() {
      try {
        return await readOrThrow();
      } catch {
        return [];
      }
    },
    loadStrict: readOrThrow,
    async persist(sessions) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ v: 1, sessions }, null, 2), "utf8");
      await fsp.rename(tmp, file);
    },
  };
}

/**
 * The session ids with a LIVE (heartbeat-fresh) worktree — what the boot reconciler and the branch GC must
 * NOT touch (G7). Reads the durable registry, so it is correct on the first tick after a restart.
 *
 * O RESULTADO É DISCRIMINADO — `{ok:false}` quando o registro não pôde ser LIDO — e isso não é preciosismo
 * de tipo, é a correção de uma perda de trabalho real (2026-07-21). Esta função devolvia `[]` num
 * `.catch()` mudo, e os DOIS consumidores dela são listas de PROTEÇÃO ("não apague estes"): o reconciler
 * de boot (`isSessionReapable = !live.includes(id)`) e o GC de branches. Com `[]`, "não consegui ler o
 * registro" vira "NENHUMA sessão está viva" — isto é, **toda** árvore de sessão passa a ser reapável de
 * uma vez. Fail-OPEN exatamente no ponto em que o desenho exige fail-CLOSED, e a assinatura escondia isso
 * do compilador: o chamador não tinha como distinguir "registro vazio" de "registro ilegível".
 *
 * Agora ele tem, e o tipo o obriga a decidir. Um registro legitimamente VAZIO continua sendo
 * `{ok:true, ids:[]}` — que é uma resposta diferente, e reapar aí é correto.
 */
export type LiveSessionIdsResult = { ok: true; ids: string[] } | { ok: false; error: string };

export async function liveSessionIds(
  store: SessionStore = makeSessionStore(),
  now: number = Date.now(),
  ttlMs: number = SESSION_HEARTBEAT_TTL_MS,
): Promise<LiveSessionIdsResult> {
  let sessions: AgentSession[];
  try {
    // STRICT on purpose: `load` swallows every read/parse failure into `[]`, which would make the
    // `ok:false` branch below unreachable and hand this protection list an empty answer it cannot
    // distinguish from "the registry is fine and nobody is alive". An injected fake without
    // `loadStrict` supplies its own data, so falling back to `load` there is exact.
    sessions = await (store.loadStrict ? store.loadStrict() : store.load());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, ids: sessions.filter((s) => isSessionAlive(s, now, ttlMs)).map((s) => s.sessionId) };
}

/** Every session id in the registry (alive or not) — for surfaces that want to SHOW a dead session. */
export async function allSessions(store: SessionStore = makeSessionStore()): Promise<AgentSession[]> {
  return store.load().catch(() => [] as AgentSession[]);
}

export { agentSessionIdFromBranch };

/** Production deps: real git, real fs, the live train, the live settings. */
export function defaultSessionWorktreeDeps(args: {
  repoRoot: string;
  ensureRunBase: () => Promise<string>;
  enqueueMerge: SessionWorktreeDeps["enqueueMerge"];
  liveRunIds: () => Promise<string[]>;
  maxWorktrees?: number;
  thresholds?: SchedulerThresholds;
}): SessionWorktreeDeps {
  return {
    exec: defaultExec,
    fs: defaultWorktreeFs,
    repoRoot: args.repoRoot,
    store: makeSessionStore(),
    ensureRunBase: args.ensureRunBase,
    enqueueMerge: args.enqueueMerge,
    liveRunIds: args.liveRunIds,
    maxWorktrees: args.maxWorktrees,
    // A session builds and runs the suite exactly like a HEAVY run → it answers to the same box thresholds.
    probeResources: () => probeVpsResources(),
    thresholds: args.thresholds,
  };
}
