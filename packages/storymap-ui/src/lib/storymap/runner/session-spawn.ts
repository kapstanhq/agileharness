// session-spawn — WS-6.2: `claude_new` ORIENTADO A TRABALHO. The AgileHarness stops being a place where the
// operator hand-rolls tmux and becomes the SPAWNER of the fleet: a session is born with an identity, a tree,
// a claim, a role, a model and a contract — or it is REFUSED with a reason and the queue.
//
// What this module owns (the MCP tool in dev-tools.ts is only the surface over it):
//   • ADMISSION  — a code role competes for the box (cap + the HEAVY lane's thresholds); a refusal names WHO
//                  is holding it, so the caller can wait, re-prioritise, or take card-less work.
//   • ISOLATION  — a code role gets a worktree through WS-1's ONE door (openSessionWorktree), never `git` by
//                  hand: the branch mint, the base and the base-ref stay in one auditable place.
//   • EXCLUSION  — a card gets a claim (WS-4) held by the LOGICAL agent, so it survives recycling.
//   • CONTRACT   — the spawn prompt already CARRIES the rules (your tree, board-data via MCP, submit through
//                  the train, never the runtime checkout). A rule an agent has to go looking for is a rule it
//                  will break at 2am.
//   • AUTHORITY  — G12: the session mounts the AgileHarness MCP with the SCOPED `orch` token, never the operator's
//                  `full` one. Without a token it could not honour "board-data via MCP"; with `full` it could
//                  deploy and delete.
//
// ── FOUR FACTS ABOUT THE CLI + TMUX, EACH VERIFIED ON THE BOX, EACH OF WHICH SILENTLY BREAKS THE SPAWN ──────
//
//  1. `--mcp-config <configs...>` is VARIADIC. `claude --mcp-config <path> "<prompt>"` reads the PROMPT as a
//     second config path and dies with `MCP config file not found: <prompt>`. The prompt therefore goes FIRST,
//     as the positional (see {@link buildSessionClaudeArgs}) — and no flag may ever be appended after it.
//  2. tmux does NOT give a new session the spawning process's env. The session env comes from the tmux SERVER
//     (started long ago) + `update-environment`; a var exported here arrives as ABSENT (measured). So the MCP
//     token CANNOT ride the env of the caller, which is why it rides a 0600 config file instead (`-e` would
//     work but puts the secret in argv, readable by every `ps` on the box).
//  3. Workspace trust INHERITS into subdirectories of a trusted project. An agent tree lives at
//     `<repoRoot>/.worktrees/agent-<id>` — under the trusted repo — so no trust dialog blocks the session.
//     A tree OUTSIDE the repo root would hang forever on "Is this a project you trust?" with nobody to answer.
//  4. `--dangerously-skip-permissions` is NOT needed (and is a root footgun): the box runs as root and the
//     operator's global settings already default to bypass, which an interactive session inherits. Passing the
//     flag explicitly is what trips the CLI's root guard.
//
// The IO is injected (the engine's DI convention) so the decisions below are unit-testable with no tmux, no
// git and no service. SERVER-ONLY in production.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { buildOrchestratorMcpConfig } from "./orchestrator-spawn";
import { CLAIM_TTL_SESSION_MS, sessionClaimActor, type CardClaim, type ClaimKind, type ClaimScope } from "./claims";
import {
  discardSessionWorktree,
  openSessionWorktree,
  registerSession,
  roleNeedsWorktree,
  updateSession,
  type AgentRole,
  type AgentSession,
  type FleetQueueRow,
  type SessionWorktreeDeps,
} from "./session-worktree";
import type { EffortLevel, ModelTier } from "@/lib/storymap/types";

/** How the fleet names a session's tmux: `agent-<slug|short id>`. The `agent-` prefix is what tells the
 *  reaper, the /processes lanes and a human at a keyboard that the tool owns this session. */
export function sessionTmuxName(sessionId: string, slug?: string): string {
  const clean = (slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `agent-${clean || sessionId.slice(0, 8)}`;
}

// ── the ROLE → (claim kind, scope) map ───────────────────────────────────────────────────────────────────
//
// D8's exclusivity is per (card, kind) + card-exclusive for anything touching CODE. The map is small and
// CLOSED on purpose: a role that invents its own kind would be excluded from nothing.

/** What a session of this role reserves on its card. PURE. */
export function claimForRole(role: AgentRole): { kind: ClaimKind; scope: ClaimScope } {
  switch (role) {
    case "implement":
      // `both`: an implementer writes the code AND the card's own data (tasks done, findings) — the
      // card-exclusive axis, so a second implementer is refused.
      return { kind: "implement", scope: "both" };
    case "review":
      return { kind: "review", scope: "both" };
    case "triage":
      return { kind: "triage", scope: "board" };
    case "steward":
      return { kind: "steward", scope: "board" };
    case "free":
      // Open-ended work on a card is implementation until proven otherwise (it gets a tree for the same
      // reason — roleNeedsWorktree): claiming it weakly would let a second implementer in behind it.
      return { kind: "implement", scope: "both" };
  }
}

// ── the ROUTE (model, effort) ────────────────────────────────────────────────────────────────────────────

export interface SessionRoute {
  model?: ModelTier;
  effort?: EffortLevel;
  /** the one-line ARITHMETIC of why — the fleet view shows it, and "why is this on sonnet?" must be answerable. */
  why: string;
}

/**
 * WS-6.2/WS-7 — the (model, effort) a spawned session runs on. This is NOT a new routing axis (D10 forbids a
 * fourth door): it MAPS onto the doors that already exist, exactly as model-routing.ts's canonical table says.
 *
 *   • an explicit HUMAN override always wins — it is the operator on the keyboard, and a tool that argued with
 *     them would just be worked around (the effort still comes from the card's rule: overriding the tier is a
 *     statement about capability, not about how hard to think);
 *   • a session ON A CARD gets THE CARD'S OWN RULE — the same `resolveCardRoute` a headless run goes through
 *     (door 3, capped by the column and the card's route profile). "The same card, a different tier, because a
 *     human happened to spawn it" is precisely the unpredictability D10 exists to prevent;
 *   • CARD-LESS open-ended work (`free`/`implement`/`review` with no card) gets opus/high: nothing bounds it,
 *     so the reasoning has to;
 *   • `triage`/`steward` are mechanical by definition → sonnet/medium.
 *
 * `cardRoute` is INJECTED (the caller reads the card + the board config + the settings) so this stays pure.
 */
export function resolveSessionRoute(input: {
  role: AgentRole;
  override?: ModelTier;
  cardRoute?: { model?: ModelTier; effort?: EffortLevel } | null;
}): SessionRoute {
  if (input.override) {
    return {
      model: input.override,
      effort: input.cardRoute?.effort,
      why: `override explícito do chamador (${input.override}) — a escolha humana vence a derivação`,
    };
  }
  if (input.cardRoute && (input.cardRoute.model || input.cardRoute.effort)) {
    return {
      model: input.cardRoute.model,
      effort: input.cardRoute.effort,
      why: "a regra do próprio card (mesma derivação dos runs: coluna × complexidade × route profile)",
    };
  }
  if (input.role === "triage" || input.role === "steward") {
    return { model: "sonnet", effort: "medium", why: "papel mecânico (triagem/steward) — tier barato" };
  }
  return { model: "opus", effort: "high", why: "trabalho aberto sem card — nada limita o escopo, o raciocínio limita" };
}

// ── retry de rede ≠ pedido novo (F7) ─────────────────────────────────────────────────────────────────────

/** Janela em que dois spawns IDÊNTICOS são lidos como um pedido só (um retry), não como dois. */
export const SPAWN_RETRY_WINDOW_MS = 120_000;

/**
 * A sessão que um spawn IDÊNTICO acabou de criar — ou undefined.
 *
 * O DEFEITO: `claude_new` não tinha chave de idempotência. Uma chamada MCP que estoure o timeout do
 * intermediário (o conector remoto atravessa um proxy) é re-tentada pelo cliente, e o servidor spawna a
 * SEGUNDA sessão: dois tmux, duas árvores, duas vagas do cap gastas no mesmo trabalho. Trabalho COM card
 * se defendia sozinho (o claim recusa o segundo), mas trabalho SEM card — legítimo e comum (self-dev,
 * fix rápido) — não tinha nenhuma trava.
 *
 * A régua é a INTENÇÃO (papel + tarefa + card), não um token que o chamador precisaria inventar e
 * lembrar: um `claude_new` repetido com a MESMA tarefa dentro de 2 minutos é, na prática, sempre o mesmo
 * pedido chegando duas vezes. Fora da janela é um pedido novo e legítimo (o operador quis um segundo
 * agente na mesma tarefa) e passa. PURA.
 */
export function findRetrySpawn<T extends { role: AgentRole; task: string; board?: string; cardId?: string; openedAt: string }>(
  sessions: readonly T[],
  intent: { role: AgentRole; task: string; board?: string; cardId?: string },
  now: number,
  windowMs: number = SPAWN_RETRY_WINDOW_MS,
): T | undefined {
  return sessions.find((s) => {
    if (s.role !== intent.role || s.task !== intent.task) return false;
    if ((s.board ?? undefined) !== (intent.board ?? undefined)) return false;
    if ((s.cardId ?? undefined) !== (intent.cardId ?? undefined)) return false;
    const opened = Date.parse(s.openedAt);
    return Number.isFinite(opened) && now - opened >= 0 && now - opened <= windowMs;
  });
}

// ── the CONTRACT prompt ──────────────────────────────────────────────────────────────────────────────────

export interface SessionPromptInput {
  sessionId: string;
  agentId: string;
  role: AgentRole;
  task: string;
  board?: string;
  cardId?: string;
  cardTitle?: string;
  worktreePath?: string;
  branch?: string;
  /** WS-6.3 — this process REPLACES one that ran out of context; the tree/branch/claims are already ours. */
  handoff?: boolean;
}

/**
 * The prompt the session WAKES UP holding. It carries the four things a fresh agent cannot look up and must
 * not guess: who it is, what the work is, where its tree is, and the rules of the road.
 *
 * The rules are stated as PROHIBITIONS with their reason, not as etiquette: "never edit the runtime checkout"
 * without "because it is the live service and a stray write clobbers it" is a rule an agent will helpfully
 * optimise away the moment its own tree seems inconvenient.
 */
export function buildSessionPrompt(i: SessionPromptInput): string {
  const lines: string[] = [];
  lines.push(
    `Você é um agente da FROTA do AgileHarness (papel: ${i.role}; agentId: ${i.agentId.slice(0, 8)}; sessionId: ${i.sessionId}).`,
    "",
    `TAREFA: ${i.task}`,
  );
  if (i.board && i.cardId) {
    lines.push(
      `CARD: ${i.board}/${i.cardId}${i.cardTitle ? ` — ${i.cardTitle}` : ""} (o claim já é SEU; leia o card com get_card).`,
    );
  } else if (i.board) {
    lines.push(`BOARD: ${i.board} (trabalho sem card — legítimo; integra igual).`);
  }
  lines.push("");
  if (i.worktreePath) {
    lines.push(
      "SEU WORKTREE (trabalhe SÓ aqui):",
      `  ${i.worktreePath}   [branch ${i.branch ?? "?"}]`,
      "",
      "CONTRATO (não negociável):",
      `  1. CÓDIGO: só dentro de ${i.worktreePath}. NUNCA edite o checkout de runtime nem o worktree de stage —`,
      "     o runtime é o serviço VIVO (uma escrita solta o derruba) e o stage é a engrenagem interna do merge train.",
      "  2. BOARD-DATA urgente (status, findings, respostas): via MCP (update_card etc.) — aterrissa na hora.",
      "     O PRODUTO do trabalho (código + o card/sidecar que ele muda) vai no seu worktree e integra pelo train.",
      `  3. INTEGRAR: worktree_submit({sessionId:"${i.sessionId}"}). O train pina o sha e roda o gate; se voltar`,
      "     `returned-to-session`, o conflito é SEU: worktree_refresh, resolva, submeta de novo.",
      `  4. AO TERMINAR: worktree_discard({sessionId:"${i.sessionId}"}) libera sua vaga no cap da frota.`,
      "     Depois, suggest_work({board}) diz o próximo card livre (e adquira o claim antes de começar).",
    );
  } else {
    lines.push(
      "SEM WORKTREE: seu papel trabalha em board-data via MCP (get_card/update_card/move_card), não em código.",
      `Se o trabalho virar código, abra uma árvore isolada: worktree_open({task:"..."}) — NUNCA edite o checkout`,
      "de runtime direto (é o serviço vivo).",
    );
  }
  if (i.handoff) {
    lines.push(
      "",
      "RECICLAGEM: você ASSUME o trabalho de um processo anterior que encheu o contexto. A árvore, o branch e os",
      "claims são os MESMOS (o agentId não mudou) — leia o estado no disco (git status/log no seu worktree) e no",
      "card antes de agir; não recomece do zero.",
    );
  }
  return lines.join("\n");
}

// ── the CLI args ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The argv for the session's `claude`. THE PROMPT IS FIRST and everything else follows — see fact 1 in the
 * header: `--mcp-config` is variadic, so a prompt placed after it is eaten as a config path and the CLI dies
 * before the session exists. Do not "tidy" the order. PURE.
 */
export function buildSessionClaudeArgs(input: {
  prompt: string;
  model?: ModelTier;
  effort?: EffortLevel;
  mcpConfigPath?: string;
}): string[] {
  const args: string[] = [input.prompt];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  // LAST, and last on purpose (variadic): nothing may follow it.
  if (input.mcpConfigPath) args.push("--mcp-config", input.mcpConfigPath);
  return args;
}

/** POSIX single-quote: the ONLY safe way to hand caller data to `bash -lc` (tmux runs the session's command
 *  through a shell). `'` closes, escapes, reopens. PURE. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The one-line shell command tmux runs for the session. PURE. */
export function buildSessionCommand(claudeBin: string, args: string[]): string {
  return [claudeBin, ...args].map(shellQuote).join(" ");
}

// ── the MCP surface (G12) ────────────────────────────────────────────────────────────────────────────────

/** Where a session's MCP config lives: `storymap/.runner/sessions/<sessionId>.mcp.json` (gitignored — the
 *  whole `.runner/` tree is). It must OUTLIVE the spawn (unlike the orchestrator's tmpdir config, which the
 *  run deletes on exit): a session re-reads nothing, but it lives for hours and may be recycled onto it. */
export function sessionMcpConfigPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, "sessions", `${sessionId}.mcp.json`);
}

/**
 * G12 — write the session's AgileHarness MCP mount, carrying the SCOPED `orch` token (never the operator's `full`
 * one): the session may drive the pipeline and publish, but never open a shell through MCP nor delete.
 *
 * The token is INLINED in the file (0600, gitignored dir) rather than passed through the env — the precedent
 * is the copilot's own spawn (`buildOrchestratorMcpConfig`), and both alternatives are worse here: the env
 * does not survive tmux at all (fact 2), and `-e` would print the secret into argv for every `ps` on the box.
 * Returns the path, or null when there is no token — the caller then spawns a session that simply has no
 * AgileHarness tools, and SAYS SO, rather than pretending the contract is honourable.
 */
export async function writeSessionMcpConfig(
  fs: Pick<typeof fsp, "mkdir" | "writeFile">,
  stateDir: string,
  sessionId: string,
  token: string | undefined,
  port: number,
): Promise<string | null> {
  const clean = token?.trim();
  if (!clean) return null;
  const file = sessionMcpConfigPath(stateDir, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, buildOrchestratorMcpConfig(clean, port), { encoding: "utf8", mode: 0o600 });
  return file;
}

// ── the spawn ────────────────────────────────────────────────────────────────────────────────────────────

export interface SessionSpawnDeps {
  /** WS-1's deps — the SAME door runs go through (base, train, admission, registry). */
  worktree: SessionWorktreeDeps;
  /** WS-4 — the live claim registry. Three verbs: look, take, give back (the rollback needs the third). */
  claims: {
    conflictFor(req: { board: string; cardId: string; actor: string; kind: ClaimKind; scope: ClaimScope; ttlMs: number }): Promise<CardClaim | null>;
    acquire(req: { board: string; cardId: string; actor: string; kind: ClaimKind; scope: ClaimScope; ttlMs: number; note?: string }): Promise<{ ok: true; claim: CardClaim } | { ok: false; holder: CardClaim }>;
    release(board: string, cardId: string, actor: string): Promise<void>;
  };
  /** the card's route, resolved by the caller (reads card + board config + settings); null ⇒ no card/unknown. */
  cardRoute(board: string, cardId: string): Promise<{ model?: ModelTier; effort?: EffortLevel; title?: string } | null>;
  /** tmux: create detached, probe existence, probe survival, kill. */
  tmux: {
    exists(name: string): Promise<boolean>;
    create(name: string, command: string, cwd: string): Promise<{ ok: boolean; error?: string }>;
    /** true when the session is STILL there after the persistence window (the honest `claude_new` contract). */
    survives(name: string): Promise<boolean>;
    kill(name: string): Promise<void>;
  };
  /** the transcript the CLI just started writing (feeds contextPct); best-effort. */
  findTranscript(since: number): Promise<string | null>;
  fs: Pick<typeof fsp, "mkdir" | "writeFile">;
  claudeBin: string;
  repoRoot: string;
  stateDir: string;
  /** the scoped `orch` MCP token (STORYMAP_MCP_TOKEN_ORCH); absent ⇒ the session mounts no AgileHarness tools. */
  mcpToken?: string;
  port: number;
  now?: () => number;
}

export interface SpawnSessionInput {
  role: AgentRole;
  task: string;
  board?: string;
  cardId?: string;
  /** an explicit tier from the caller — always wins (see resolveSessionRoute). */
  model?: ModelTier;
  /** a readable suffix for the tmux name; defaults to the session's short id. */
  name?: string;
  actor?: string;
  spawnedBy?: "human" | "copilot";
  /** WS-6.3 — recycle: keep this LOGICAL identity (its claims and its tree follow it to the new process). */
  agentId?: string;
}

/**
 * WHY a spawn was refused — the caller's next move differs per code, so it is a FIELD, not a phrase to
 * regex out of `reason`:
 *  - `no_capacity`  → the box is full; `queue` says who has it (wait, or re-prioritise).
 *  - `card_claimed` → someone owns the card; `holder` says who (take the next suggestion).
 *  - `name_taken`   → the tmux name collides; pick another `name`.
 *  - `session_lost` → the process died on arrival (the honest contract the old claude_new learned the hard
 *                     way: `tmux new-session` exiting 0 does NOT mean the agent lives).
 *  - `spawn_failed` → the plumbing itself failed (git/tmux/fs).
 */
export type SpawnFailureCode = "no_capacity" | "card_claimed" | "name_taken" | "session_lost" | "spawn_failed";

export type SpawnSessionResult =
  | {
      ok: true;
      session: AgentSession;
      tmuxSession: string;
      route: SessionRoute;
      claim: CardClaim | null;
      /** false ⇒ no `orch` token on the box: the session has NO AgileHarness tools (the contract is degraded). */
      mcpMounted: boolean;
    }
  | { ok: false; code: SpawnFailureCode; reason: string; queue?: FleetQueueRow[]; holder?: CardClaim };

const nowOf = (deps: SessionSpawnDeps): number => (deps.now ?? Date.now)();

/**
 * WS-6.2 — birth a working session. The ORDER below is the whole design, and each step undoes itself on the
 * next one's failure, because a half-born session is worse than none: a tree nobody owns, or a card reserved
 * by a process that never existed, both need a human to notice and clean up.
 *
 *   1. CLAIM PRE-CHECK (a cheap READ) — refuse a taken card BEFORE building anything for it.
 *   2. TREE (code roles) — admission lives inside WS-1's door; its refusal carries the queue.
 *   3. CLAIM ACQUIRE (authoritative, first-writer-wins) — a race lost here rolls the tree back.
 *   4. SPAWN — a session that dies on arrival releases the claim and discards the tree, and says so
 *      (`session_lost`) instead of the old false `{ok:true}`.
 *   5. STAMP — tmux/cwd/transcript/model onto the registry row: the fleet view's whole content.
 */
export async function spawnWorkSession(deps: SessionSpawnDeps, input: SpawnSessionInput): Promise<SpawnSessionResult> {
  const wantsTree = roleNeedsWorktree(input.role);
  const claimSpec = claimForRole(input.role);

  // 1 — is the card already taken? A read, not a reservation: the authoritative answer is step 3, but paying
  // for a worktree just to lose the race is waste we can see coming.
  const card = input.board && input.cardId ? { board: input.board, cardId: input.cardId } : null;
  if (card) {
    const probeActor = sessionClaimActor(input.agentId ?? "probe");
    const holder = await deps.claims
      .conflictFor({ ...card, actor: probeActor, ...claimSpec, ttlMs: CLAIM_TTL_SESSION_MS })
      .catch(() => null);
    if (holder && holder.actor !== probeActor) {
      return {
        ok: false,
        code: "card_claimed",
        holder,
        reason:
          `${card.board}/${card.cardId} já está reservado por ${holder.actor} (${holder.kind}/${holder.scope}, ` +
          `até ${holder.expiresAt})${holder.note ? ` — "${holder.note}"` : ""}. ` +
          `Pegue outro card (suggest_work) ou espere a reserva cair.`,
      };
    }
  }

  // 2 — the tree (with the admission the box actually needs).
  let session: AgentSession;
  if (wantsTree) {
    const opened = await openSessionWorktree(deps.worktree, {
      board: input.board,
      cardId: input.cardId,
      task: input.task,
      actor: input.actor,
      role: input.role,
      spawnedBy: input.spawnedBy,
      agentId: input.agentId,
    });
    // WS-1's door refuses for exactly one reason a caller can act on (admission) — it carries the queue when
    // so; anything else is plumbing (git/fs) that no queue explains.
    if (!opened.ok) {
      return { ok: false, code: opened.queue ? "no_capacity" : "spawn_failed", reason: opened.reason, queue: opened.queue };
    }
    session = opened.session;
  } else {
    const reg = await registerSession(deps.worktree, {
      role: input.role,
      board: input.board,
      cardId: input.cardId,
      task: input.task,
      actor: input.actor,
      spawnedBy: input.spawnedBy,
      agentId: input.agentId,
      cwd: deps.repoRoot,
    });
    session = reg.session;
  }

  // Everything from here can fail with a session already registered → ONE rollback, used by every exit below.
  // It must be blind-safe (releasing a claim never taken is a documented no-op; discarding a tree-less session
  // just deregisters it), because a failure path that can itself fail leaves the mess it was meant to clean.
  const rollback = async (claimed: boolean): Promise<void> => {
    if (card && claimed) {
      await deps.claims.release(card.board, card.cardId, sessionClaimActor(session.agentId)).catch(() => {});
    }
    await discardSessionWorktree(deps.worktree, { sessionId: session.sessionId }).catch(() => {});
  };

  // 3 — the reservation, for real.
  let claim: CardClaim | null = null;
  if (card) {
    const res = await deps.claims.acquire({
      ...card,
      actor: sessionClaimActor(session.agentId),
      ...claimSpec,
      ttlMs: CLAIM_TTL_SESSION_MS,
      note: input.task.slice(0, 120),
    });
    if (!res.ok) {
      await rollback(false);
      return {
        ok: false,
        code: "card_claimed",
        holder: res.holder,
        reason:
          `perdi a corrida pelo claim de ${card.board}/${card.cardId}: ${res.holder.actor} pegou primeiro ` +
          `(${res.holder.kind}/${res.holder.scope}). Nada foi criado; pegue outro card (suggest_work).`,
      };
    }
    claim = res.claim;
  }

  // 4 — the process.
  const tmuxSession = sessionTmuxName(session.sessionId, input.name);
  if (await deps.tmux.exists(tmuxSession)) {
    await rollback(!!claim);
    return { ok: false, code: "name_taken", reason: `já existe uma sessão tmux "${tmuxSession}" — escolha outro \`name\`.` };
  }
  const cardRoute = card ? await deps.cardRoute(card.board, card.cardId).catch(() => null) : null;
  const route = resolveSessionRoute({ role: input.role, override: input.model, cardRoute });
  const mcpPath = await writeSessionMcpConfig(deps.fs, deps.stateDir, session.sessionId, deps.mcpToken, deps.port).catch(
    () => null,
  );
  const prompt = buildSessionPrompt({
    sessionId: session.sessionId,
    agentId: session.agentId,
    role: input.role,
    task: input.task,
    board: input.board,
    cardId: input.cardId,
    cardTitle: cardRoute?.title,
    worktreePath: session.worktreePath,
    branch: session.branch,
    handoff: !!input.agentId,
  });
  const cwd = session.worktreePath ?? deps.repoRoot;
  const command = buildSessionCommand(
    deps.claudeBin,
    buildSessionClaudeArgs({ prompt, model: route.model, effort: route.effort, mcpConfigPath: mcpPath ?? undefined }),
  );
  const created = await deps.tmux.create(tmuxSession, command, cwd);
  if (!created.ok) {
    await rollback(!!claim);
    return { ok: false, code: "spawn_failed", reason: created.error ?? "falha ao criar a sessão tmux (tmux disponível?)." };
  }
  // The honest contract (AC1 of the old claude_new, kept): `tmux new-session` exiting 0 only means tmux made a
  // session — the `claude` inside can die a second later (a bad flag, the root guard). Verify, then commit.
  const startedAt = nowOf(deps);
  if (!(await deps.tmux.survives(tmuxSession))) {
    await deps.tmux.kill(tmuxSession).catch(() => {});
    await rollback(!!claim);
    return {
      ok: false,
      code: "session_lost",
      reason:
        `a sessão "${tmuxSession}" morreu logo após nascer — o processo claude não persistiu. ` +
        `Nada ficou pendurado: claim e worktree foram desfeitos.`,
    };
  }

  // 5 — the row the fleet view reads.
  const transcriptFile = (await deps.findTranscript(startedAt).catch(() => null)) ?? undefined;
  const stamped = await updateSession(deps.worktree, session.sessionId, {
    tmuxSession,
    cwd,
    transcriptFile,
    model: route.model,
  });
  return { ok: true, session: stamped ?? session, tmuxSession, route, claim, mcpMounted: !!mcpPath };
}

// ── RECYCLING (6.3) ──────────────────────────────────────────────────────────────────────────────────────

export type RecycleSessionResult =
  | { ok: true; session: AgentSession; tmuxSession: string; previousTmux?: string; route: SessionRoute }
  | { ok: false; reason: string };

/**
 * WS-6.3 — replace the PROCESS of a session whose context filled up, keeping the AGENT.
 *
 * The decision this implements: the worktree belongs to the LOGICAL agent (agentId), not to the process. So
 * recycling is deliberately NOT "discard + claude_new": the tree, the branch, the base-ref, the card and the
 * claim all stay exactly where they are (the claim is held as `session:<agentId>`, which does not change), and
 * only `tmuxSession`/`transcriptFile` are swapped. A recycle that re-opened a tree would throw away hours of
 * un-integrated work and re-acquire its own card as a stranger.
 *
 * ORDER: the new process is born and PROVEN to survive BEFORE the old one is killed. The reverse (kill first)
 * leaves a window where the agent does not exist, and a failed spawn in that window would strand the tree with
 * nobody attached. The cost of this order is a few seconds of two processes on one tree — during which the OLD
 * one is the only writer (the new one starts by reading), which is why the handoff prompt tells it to read the
 * state before acting.
 */
export async function recycleSession(deps: SessionSpawnDeps, input: { sessionId: string }): Promise<RecycleSessionResult> {
  const sessions = await deps.worktree.store.load().catch(() => [] as AgentSession[]);
  const cur = sessions.find((s) => s.sessionId === input.sessionId);
  if (!cur) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?)` };
  if (cur.adopted) {
    return {
      ok: false,
      reason:
        `sessão ${input.sessionId.slice(0, 8)} foi ADOTADA (tmux criado fora da ferramenta): não temos o contrato ` +
        `dela nem árvore própria, então reciclar seria criar um agente novo com outra cara. Encerre-a e abra uma ` +
        `sessão com claude_new.`,
    };
  }

  const card = cur.board && cur.cardId ? { board: cur.board, cardId: cur.cardId } : null;
  const cardRoute = card ? await deps.cardRoute(card.board, card.cardId).catch(() => null) : null;
  const route = resolveSessionRoute({ role: cur.role, override: cur.model as ModelTier | undefined, cardRoute });
  const mcpPath = await writeSessionMcpConfig(deps.fs, deps.stateDir, cur.sessionId, deps.mcpToken, deps.port).catch(
    () => null,
  );
  const prompt = buildSessionPrompt({
    sessionId: cur.sessionId,
    agentId: cur.agentId,
    role: cur.role,
    task: cur.task,
    board: cur.board,
    cardId: cur.cardId,
    cardTitle: cardRoute?.title,
    worktreePath: cur.worktreePath,
    branch: cur.branch,
    handoff: true,
  });
  const cwd = cur.worktreePath ?? deps.repoRoot;
  // A DIFFERENT tmux name, because the old session is still alive at this point (see ORDER above). The name is
  // just the host; identity is the agentId, which the fleet view keys on.
  const tmuxSession = sessionTmuxName(cur.sessionId, `${cur.agentId.slice(0, 8)}-${nowOf(deps).toString(36).slice(-4)}`);
  const created = await deps.tmux.create(
    tmuxSession,
    buildSessionCommand(
      deps.claudeBin,
      buildSessionClaudeArgs({ prompt, model: route.model, effort: route.effort, mcpConfigPath: mcpPath ?? undefined }),
    ),
    cwd,
  );
  if (!created.ok) return { ok: false, reason: `falha ao criar a sessão nova: ${created.error ?? "?"} (a antiga segue viva)` };
  const startedAt = nowOf(deps);
  if (!(await deps.tmux.survives(tmuxSession))) {
    await deps.tmux.kill(tmuxSession).catch(() => {});
    return { ok: false, reason: "a sessão nova morreu ao nascer — a ANTIGA segue viva e dona da árvore (nada mudou)." };
  }

  const previousTmux = cur.tmuxSession;
  if (previousTmux && previousTmux !== tmuxSession) await deps.tmux.kill(previousTmux).catch(() => {});
  const transcriptFile = (await deps.findTranscript(startedAt).catch(() => null)) ?? undefined;
  const stamped = await updateSession(deps.worktree, cur.sessionId, { tmuxSession, cwd, transcriptFile, model: route.model });
  return { ok: true, session: stamped ?? cur, tmuxSession, previousTmux, route };
}
