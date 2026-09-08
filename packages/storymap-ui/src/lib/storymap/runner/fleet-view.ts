// fleet-view — WS-6.4: the fleet, as ONE row per agent. This is the surface that replaces the Operator's
// mental map ("who is doing what, where, and is anyone stuck?"), which until now lived only in his head and
// in three tmux windows.
//
// The row JOINS four registries that each know a fifth of the truth: the session registry (identity, role,
// tree, heartbeat), the claims (which card is actually reserved, by whom), the merge train (is the work
// waiting on integration — or did the integration come back to a session that no longer exists?), and the
// live tmux/transcript (is the process there, how full is its context).
//
// ── GAP 1.3c — THE ORPHANED INTEGRATION ──────────────────────────────────────────────────────────────────
// A session's failed integration goes BACK to the session (`returned-to-session`, WS-1.4/G6) instead of
// parking for the operator. That is right while the session is ALIVE — it is the only actor who can resolve
// its own conflict, and parking it would put a live agent at the head of the train. But a session that DIED
// never read the verdict, and its entry is terminal: nothing will ever pick it up. For a session WITH a card,
// the card is still a handle. For a CARD-LESS one (self-dev, D2) there is no handle at all: every cockpit
// surface is keyed by `cardsById.get(...)`, so the failure is invisible in the product. D13 forbids inventing
// a card for it (a card is a spec, not a receipt), so the demand needs a home of its own — and the fleet view
// IS that home: it is the one surface keyed by AGENT rather than by card. {@link FleetRow.orphanedIntegration}
// is that demand, and it is the only reason a fleet row can be "travado".
//
// PURE core (buildFleetRows) + a thin IO wrapper, like suggest-work: the join is where the lies would hide,
// so it is the part that is unit-tested.

import { isSessionAlive, type AgentRole, type AgentSession } from "./session-worktree";
import { isClaimLive, sessionClaimActor, type CardClaim } from "./claims";
import type { MergeQueueEntry, MergeQueueStatus } from "./types";

/** Merge-train statuses that mean "this integration is NOT going to happen unless someone acts". A live
 *  session acts on its own (that is the design); a dead one cannot, which is what makes it a demand. */
const UNRESOLVED_TRAIN: ReadonlySet<MergeQueueStatus> = new Set<MergeQueueStatus>([
  "returned-to-session",
  "gate-failed",
  "conflict",
  "failed",
]);

/** One agent, as the operator needs to see it. */
export interface FleetRow {
  sessionId: string;
  /** the LOGICAL identity — stable across recycling. The row's real key. */
  agentId: string;
  role: AgentRole;
  task: string;
  board: string | null;
  cardId: string | null;
  cardTitle: string | null;
  branch: string | null;
  worktreePath: string | null;
  model: string | null;
  spawnedBy: "human" | "copilot" | null;
  tmuxSession: string | null;
  heartbeatAt: string;
  /** heartbeat inside the TTL (the fact the reaper obeys — G7). */
  alive: boolean;
  /** the hosting tmux is up. `null` = no process handle at all (opened by a non-tmux session) — NOT death. */
  processAlive: boolean | null;
  contextPct: number | null;
  /** context is close enough to the ceiling that the agent should be recycled BEFORE it overflows. */
  suggestRecycle: boolean;
  /** the card this agent actually holds right now (WS-4), if any. */
  claim: { kind: string; scope: string; acquiredAt: string; expiresAt: string } | null;
  /** its entry on the merge train, if it has submitted. */
  train: { status: MergeQueueStatus; pinnedSha: string | null; enqueuedAt: number } | null;
  /** WS-6.2 — ADOPTED from a tmux made outside the tool: no isolated tree, and no contract we can hand a
   *  replacement process — so the view offers no Recycle for it (recycleSession refuses too). */
  adopted: boolean;
  /** the human-readable face of `adopted`: visible debt, not a mode. */
  warning: string | null;
  /**
   * GAP 1.3c — an integration that came back to an agent that is GONE. Nobody will ever act on it: the entry
   * is terminal on the train and the process that owned it is dead. This is a DEMAND on the operator, and for
   * a card-less session it is the ONLY place it can appear.
   */
  orphanedIntegration: { status: MergeQueueStatus; branch: string; pinnedSha: string | null; detail: string } | null;
}

export interface FleetInputs {
  sessions: AgentSession[];
  claims: CardClaim[];
  /** every train entry (live + history) — the join is by runId === sessionId. */
  entries: MergeQueueEntry[];
  /** tmux session names that exist right now. */
  liveTmux: Set<string>;
  /** contextPct per sessionId (read from the transcript by the caller — IO). */
  contextBySession: Map<string, number | null>;
  /** card titles, by `<board>/<cardId>` — the operator reads titles, not ids. */
  cardTitles?: Map<string, string>;
  /** the recycle threshold (dev-tools' RECYCLE_THRESHOLD) — injected so this file owns no policy. */
  recycleThresholdPct: number;
}

/**
 * Join the registries into fleet rows. PURE.
 *
 * Ordering is by ATTENTION, mirroring /processes' own doctrine: what needs a human first (orphaned
 * integration), then what is about to (recycle), then the working fleet, oldest heartbeat last. A fleet
 * sorted by id would make the operator scan; a fleet sorted by attention answers "is anything wrong?" at a
 * glance, which is the entire reason this table exists.
 */
export function buildFleetRows(inputs: FleetInputs, now: number): FleetRow[] {
  const claimByActor = new Map<string, CardClaim>();
  for (const c of inputs.claims) {
    if (isClaimLive(c, now)) claimByActor.set(`${c.actor}|${c.board}|${c.cardId}`, c);
  }
  const entryByRun = new Map(inputs.entries.map((e) => [e.runId, e] as const));

  const rows = inputs.sessions.map((s): FleetRow => {
    const alive = isSessionAlive(s, now);
    const processAlive = s.tmuxSession ? inputs.liveTmux.has(s.tmuxSession) : null;
    const contextPct = inputs.contextBySession.get(s.sessionId) ?? null;
    const claim =
      s.board && s.cardId ? (claimByActor.get(`${sessionClaimActor(s.agentId)}|${s.board}|${s.cardId}`) ?? null) : null;
    const entry = entryByRun.get(s.sessionId) ?? null;
    // DEAD means the process is provably gone — never merely "no heartbeat lately" and never "no tmux handle"
    // (a session opened outside tmux has no handle by construction; guessing there would cry wolf forever).
    const dead = processAlive === false || !alive;
    const orphaned =
      entry && dead && UNRESOLVED_TRAIN.has(entry.status)
        ? {
            status: entry.status,
            branch: entry.branch,
            pinnedSha: entry.pinnedSha ?? null,
            detail:
              entry.status === "returned-to-session"
                ? "a integração voltou para esta sessão resolver — e ela morreu antes de ler o veredito. " +
                  "Ninguém mais vai pegar: o branch está preservado; recicle o agente ou faça o cherry-pick."
                : `a integração parou em "${entry.status}" e o agente dono já morreu — o branch está preservado.`,
          }
        : null;
    return {
      sessionId: s.sessionId,
      agentId: s.agentId,
      role: s.role,
      task: s.task,
      board: s.board ?? null,
      cardId: s.cardId ?? null,
      cardTitle: s.board && s.cardId ? (inputs.cardTitles?.get(`${s.board}/${s.cardId}`) ?? null) : null,
      branch: s.branch ?? null,
      worktreePath: s.worktreePath ?? null,
      model: s.model ?? null,
      spawnedBy: s.spawnedBy ?? null,
      tmuxSession: s.tmuxSession ?? null,
      heartbeatAt: s.heartbeatAt,
      alive,
      processAlive,
      contextPct,
      suggestRecycle: contextPct !== null && contextPct >= inputs.recycleThresholdPct && !dead,
      claim: claim ? { kind: claim.kind, scope: claim.scope, acquiredAt: claim.acquiredAt, expiresAt: claim.expiresAt } : null,
      train: entry ? { status: entry.status, pinnedSha: entry.pinnedSha ?? null, enqueuedAt: entry.enqueuedAt } : null,
      adopted: !!s.adopted,
      warning: s.adopted ? "SEM ISOLAMENTO — sessão adotada, edita fora de um worktree próprio" : null,
      orphanedIntegration: orphaned,
    };
  });

  const rank = (r: FleetRow): number => (r.orphanedIntegration ? 0 : r.suggestRecycle ? 1 : r.alive ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || b.heartbeatAt.localeCompare(a.heartbeatAt) || a.agentId.localeCompare(b.agentId));
}

/** Rows that need a HUMAN — the fleet's own "travados" (today: only the orphaned integrations of 1.3c). */
export function fleetAttention(rows: FleetRow[]): FleetRow[] {
  return rows.filter((r) => r.orphanedIntegration);
}

// ── IO wrapper (SERVER-ONLY) ──────────────────────────────────────────────────────────────────────────────

export interface CollectFleetDeps {
  sessions(): Promise<AgentSession[]>;
  claims(): Promise<CardClaim[]>;
  entries(): Promise<MergeQueueEntry[]>;
  liveTmux(): Promise<string[]>;
  /** `hints` — o modelo pinado no spawn e o cwd de LANÇAMENTO da sessão. Sem eles a janela é resolvida
   *  pelo id PELADO do transcript, que nunca carrega o `[1m]`: uma sessão de 1M media contra 200k e o
   *  `suggestRecycle` mandava reciclar um agente 20% cheio. */
  contextPct(
    transcriptFile: string,
    hints?: { model?: string | null; cwd?: string | null },
  ): Promise<number | null>;
  cardTitle(board: string, cardId: string): Promise<string | null>;
  recycleThresholdPct: number;
  now?: () => number;
}

/**
 * Read every registry and build the rows. EVERY lookup is best-effort: this is a diagnostic surface, and a
 * fleet view that 500s because the merge queue is cold tells the operator strictly less than a partial one
 * (the same posture `worktree_list` takes). A missing input degrades a COLUMN, never the page.
 */
export async function collectFleet(deps: CollectFleetDeps): Promise<FleetRow[]> {
  const [sessions, claims, entries, tmux] = await Promise.all([
    deps.sessions().catch(() => [] as AgentSession[]),
    deps.claims().catch(() => [] as CardClaim[]),
    deps.entries().catch(() => [] as MergeQueueEntry[]),
    deps.liveTmux().catch(() => [] as string[]),
  ]);
  const contextBySession = new Map<string, number | null>();
  await Promise.all(
    sessions.map(async (s) => {
      if (!s.transcriptFile) return;
      contextBySession.set(
        s.sessionId,
        await deps.contextPct(s.transcriptFile, { model: s.model, cwd: s.cwd }).catch(() => null),
      );
    }),
  );
  const cardTitles = new Map<string, string>();
  await Promise.all(
    [...new Set(sessions.filter((s) => s.board && s.cardId).map((s) => `${s.board}/${s.cardId}`))].map(async (key) => {
      const [board, cardId] = key.split("/");
      const title = await deps.cardTitle(board, cardId).catch(() => null);
      if (title) cardTitles.set(key, title);
    }),
  );
  return buildFleetRows(
    { sessions, claims, entries, liveTmux: new Set(tmux), contextBySession, cardTitles, recycleThresholdPct: deps.recycleThresholdPct },
    (deps.now ?? Date.now)(),
  );
}
