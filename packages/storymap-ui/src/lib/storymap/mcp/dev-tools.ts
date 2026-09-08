// AgileHarness MCP — DEV/OPS tools: let the phone-side Claude see the REAL app (read the
// code, run checks, read prod errors) and deploy. Registered on the same MCP server as
// the board tools (one connector), so the same path-token guard protects them.
//
// SECURITY MODEL (this surface is reachable over the public tunnel via the URL token):
//   - Code reads are READ-ONLY and confined to the repo root (path-traversal guarded),
//     skip gitignored files (`git check-ignore` → .env/node_modules/secrets invisible)
//     AND a secret-pattern denylist (defense-in-depth for anything sensitive that got
//     committed). Untracked-but-not-ignored files ARE visible (so new, uncommitted code
//     shows up). Every external process is spawned via execFile/spawn with an ARGUMENT
//     ARRAY and shell:false — no string interpolation, so no shell injection.
//   - run_check only runs `just` targets matching a check allowlist (test/validate/lint/
//     typecheck/build/ci-test*) — never deploy/dev/orch or arbitrary shell.
//   - deploy is PRODUCTION and IRREVERSIBLE-ish: gated by an explicit confirm===pkg, a
//     fixed package allowlist, and a read-only deploy_plan preview. Runs async (deploys
//     take minutes) with output to a log polled by deploy_status. If you rely on deploy
//     from the phone, migrate the connector to OAuth — the URL token alone guarding a
//     prod deploy is a thin line.

import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defineTool } from "./register";
import { isScopedActor } from "./actor";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
// F0 (ADR-067) — a contenção do SO. `run_task` é a única superfície de spawn alcançável pela internet
// (tool do endpoint MCP), então é a primeira das sete a migrar do bypass de permissão.
import {
  resolveRunTaskPosture,
  spawnContidoArgv,
  buildSpawnFlags,
  // Sete símbolos saíram daqui em 2026-08-05 — mesmo motivo do engine.ts: resíduo da migração para
  // `resolveRunTaskPosture`, presentes só na linha de import.
  type AutonomyPosture,
} from "@/lib/storymap/runner/autonomy-sandbox";
import { sanitizeSpawnEnv } from "@/lib/storymap/runner/spawn-env";
// story-frente3 — as ferramentas do HOST (`just`) e o script de atualização deixaram de ser um
// endereço da caixa do autor e passaram a ser DECLARAÇÃO com recusa legível. Ver runner/host-tools.ts.
import {
  UPDATE_LOG_ENV,
  resolveHostTool,
  resolveOpsReportScript,
  resolveServiceProbePort,
  resolveServiceUnit,
  resolveUpdateLog,
  resolveUpdateScript,
} from "@/lib/storymap/runner/host-tools";
import { deployRiskSummary } from "@/lib/storymap/runner/deploy-reconcile";
import { defaultExec } from "@/lib/storymap/runner/worktree";
import { deliverToSession, listClaudeProcesses, listSessions,
  sendKeysToSession,
} from "@/lib/vps/tmux";
import { currentTerminalAttention } from "@/lib/terminal/attention-watch";
import { waitedFor } from "@/lib/terminal/attention";
import { assessKillLive } from "@/lib/vps/kill-guard";
import { findNewTranscript, readTranscriptTurns, suggestRecycle } from "@/lib/vps/claude-transcript";
import { readSessionContext } from "@/lib/vps/transcript-usage";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { ensureDetachedSession } from "@/lib/vps/tmux";
import { stageWorktreePath, getMergeQueue } from "@/lib/storymap/runner/merge-queue";
import { isLiveMergeStatus } from "@/lib/storymap/runner/merge-status";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { waitForAnyCore, waitForRunCore, type AnyWatcher } from "@/lib/storymap/runner/run-wait";
import { getRunnerEngine } from "@/lib/storymap/runner/engine";
import { screenStillness } from "@/lib/terminal/attention-watch";
import { currentMcpActor } from "./actor";
// WS-1 — the agent-session worktree lifecycle (open/submit/refresh/discard). The logic lives in the runner
// (DI-testable against a temp repo); these tools are only the MCP surface over it.
import {
  adoptSession,
  allSessions,
  discardSessionWorktree,
  isSessionAlive,
  openSessionWorktree,
  refreshSessionWorktree,
  submitSessionWork,
  type FleetReconcileResult,
  type SessionWorktreeDeps,
} from "@/lib/storymap/runner/session-worktree";
// F2 — a reconciliação da frota (heartbeat/claims/óbito) é do SERVIÇO, não desta tool: o boot a roda num
// tick e `claude_sessions` só pega carona. A fábrica de deps vive lá pelo mesmo motivo.
import { defaultSessionDeps, reconcileFleetNow } from "@/lib/storymap/runner/fleet-deps";
// WS-6.2 — the work-oriented spawn (admission → tree → claim → tmux → registry). Same split: the decisions
// live in the runner, this file is the MCP surface over them.
import {
  findRetrySpawn,
  recycleSession,
  spawnWorkSession,
  SPAWN_RETRY_WINDOW_MS,
  type SessionSpawnDeps,
} from "@/lib/storymap/runner/session-spawn";
import { resolveCardRoute } from "@/lib/storymap/runner/config";
// WS-6.5 — the deterministic "what next?" ranking (pure) + its IO half.
import { collectWorkCandidates, excludedReason, rankWorkCandidates } from "@/lib/storymap/runner/suggest-work";
import { getCardClaims, isClaimLive } from "@/lib/storymap/runner/claims";
import { readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
// Deploy of a product app: the SINGLE source lives in the runner (also used by the onEnter deploy-board
// effect). The MCP `deploy`/`deploy_status` tools reuse the SAME registry — no parallel implementation.
import { productDeployTargets, getProductDeploy } from "@/lib/storymap/runner/product-deploy";
import { resolvedClaudeBin } from "../runner/claude-bin";

const pexec = promisify(execFile);

/**
 * WS-1 — production deps for the session-worktree tools. A FÁBRICA mora em `runner/fleet-deps.ts` (a
 * fiação de produção da frota), não aqui: o tick de boot que reconcilia a frota precisava exatamente
 * dela e teria de importar este módulo de TOOLS só para alcançá-la. Segue resolvida POR CHAMADA.
 */
const sessionDeps = (): SessionWorktreeDeps => defaultSessionDeps();

/** The port the AgileHarness MCP is served on — the SAME default the copiloto's spawn uses (orchestrator-spawn).
 *  The session mounts `http://localhost:<port>/api/usm/<token>/mcp`, i.e. this very service. */
const SERVICE_PORT = Number(process.env.PORT) || 3008;

/**
 * WS-6.2 — production deps for the work-oriented spawn. Resolved PER CALL (never cached), like `sessionDeps`:
 * the cap, the thresholds and the claude binary come from the LIVE settings, so the operator retunes capacity
 * without a restart.
 */
export const sessionSpawnDeps = (): SessionSpawnDeps => {
  const autorun = loadRunnerConfig().autorun;
  const claims = getCardClaims();
  const tmuxAlive = async (name: string): Promise<boolean> =>
    (await run("tmux", ["has-session", "-t", name], { timeoutMs: 8_000 })).code === 0;
  return {
    worktree: sessionDeps(),
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
      exists: tmuxAlive,
      create: async (name, command, cwd) => {
        const r = await ensureDetachedSession(name, command, cwd);
        return { ok: r.ok, error: r.error };
      },
      survives: (name) => pollSessionAlive(() => tmuxAlive(name)),
      kill: async (name) => {
        await run("tmux", ["kill-session", "-t", name], { timeoutMs: 5_000 });
      },
    },
    findTranscript: (since) => findNewTranscript(since),
    fs,
    claudeBin: resolvedClaudeBin({ name: autorun.claudeBin }),
    repoRoot: findRepoRoot(),
    stateDir: runnerStateDir(),
    // G12 — the SCOPED `orch` token, never STORYMAP_MCP_TOKEN (the operator's `full`): a spawned agent may
    // drive the pipeline and publish, but never open a shell through MCP nor delete.
    mcpToken: process.env.STORYMAP_MCP_TOKEN_ORCH,
    port: SERVICE_PORT,
  };
};

// --- result helpers -------------------------------------------------------
const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s || "(vazio)" }] });
const json = (d: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(d, null, 2) }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

// --- process exec (no shell — array args, never interpolated) -------------
async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await pexec(cmd, args, {
      cwd: findRepoRoot(),
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 8_000_000,
      windowsHide: true,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? err.message ?? ""),
    };
  }
}

// --- git reconcile (shared by sync_repo + git_commit_push) ----------------
// On a non-fast-forward divergence with origin, fetch the branch + merge FETCH_HEAD. Board data
// (main) and code (stage) touch DISJOINT paths across checkouts, so the merge auto-resolves clean
// in the common case. MERGE (not rebase) preserves local SHAs (diff snapshots stay valid). On any
// conflict/error, ABORT to leave the tree pristine and return false (the caller surfaces it).
// Mirrors merge-queue.ts reconcileWithOrigin (#37) for the MCP/manual path.
async function reconcileBranch(branch: string): Promise<boolean> {
  if (!isSafeRef(branch)) return false;
  const fetched = await run("git", ["fetch", "origin", branch], { timeoutMs: 60_000 });
  if (fetched.code !== 0) return false;
  const merged = await run("git", ["merge", "--no-edit", "FETCH_HEAD"], { timeoutMs: 30_000 });
  if (merged.code === 0) return true;
  await run("git", ["merge", "--abort"], { timeoutMs: 15_000 });
  return false;
}

// --- path / secret / allowlist guards (pure — exported for tests) ---------
// Secret-shaped paths we refuse to read even if committed (defense in depth on top of
// the gitignore check). Matches anywhere in the relative path.
const SECRET_DENY = /(^|\/)\.env|\.pem$|\.key$|\.p12$|\.pfx$|service[-_]?account|secret|credential|id_rsa/i;
export function isSecretPath(rel: string): boolean {
  return SECRET_DENY.test(rel);
}

// Safe git ref: no leading dash (would be read as a flag), conservative charset.
const SAFE_REF = /^[A-Za-z0-9_.\/~^@{}:-]+$/;
export function isSafeRef(ref: string): boolean {
  return !ref.startsWith("-") && SAFE_REF.test(ref);
}

// `just` targets run_check will allow: checks only, never deploy/dev/orch.
const CHECK_RE = /^(test|validate|lint|typecheck|build|ci-test)[a-z0-9-]*$/;
export function isAllowedCheck(target: string): boolean {
  return CHECK_RE.test(target);
}

// tmux session name: conservative slug, and the FIRST char is never a dash so the value
// can't be read as a tmux flag (defense in depth on top of execFile's shell:false).
const SAFE_SESSION = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export function isSafeSessionName(name: string): boolean {
  return SAFE_SESSION.test(name);
}

function toRepoRel(rel: string): string | null {
  const root = findRepoRoot();
  const resolved = path.resolve(root, rel);
  const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootSep)) return null; // traversal escape
  return path.relative(root, resolved).split(path.sep).join("/");
}

async function isGitIgnored(rel: string): Promise<boolean> {
  const r = await run("git", ["check-ignore", "-q", "--", rel], { timeoutMs: 10_000 });
  return r.code === 0; // exit 0 = path is ignored
}

// F2 — nome de sessão de um terminal do Jido. O prefixo `cop-` é OBRIGATÓRIO (marca a origem em /processes
// e no reaper). O slug (sem prefixo) é validado pela regex MAIS ESTRITA das três existentes: começa com
// [A-Za-z0-9_] + até 63 de [A-Za-z0-9_-] = ≤64 chars. Um `cop-` redundante do chamador é tolerado (strip+revalida).
// Retorna `cop-<slug>` válido ou null. Pura — exportada p/ teste.
const COP_SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export function copSessionName(name: string): string | null {
  const trimmed = (name ?? "").trim();
  const slug = trimmed.startsWith("cop-") ? trimmed.slice(4) : trimmed;
  if (!COP_SLUG_RE.test(slug)) return null;
  return `cop-${slug}`;
}

// --- claude session helpers (pure — exported for tests) -------------------
// claude_new used to return {ok:true} the instant `tmux new-session` exited 0, but the
// `claude` process can die right after (no current client / not-in-a-mode) — so the
// session vanishes and every later claude_send/claude_sessions call breaks. These helpers
// make the contract honest (poll for persistence) and give claude_sessions a real notion
// of how full each session's context is so the orchestrator can recycle BEFORE overflow.

const SESSION_POLL_INTERVAL_MS = 500;
const SESSION_POLL_TIMEOUT_MS = 5_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Poll `check()` (true = session still alive) across the persistence window. Resolves
 * `false` the moment a check reports the session is gone; `true` only if it survives the
 * whole window. Iteration-driven (not wall-clock) so it's deterministic under an injected
 * `sleep` in unit tests — the real call passes a `tmux has-session` probe as `check`.
 */
export async function pollSessionAlive(
  check: () => Promise<boolean>,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? SESSION_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? SESSION_POLL_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const iterations = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let i = 0; i < iterations; i++) {
    await sleep(intervalMs);
    if (!(await check())) return false;
  }
  return true;
}

// Build the argv for `run_task` (headless `claude -p`). Pure so the contract (prompt is a
// single argv entry — never shell-interpolated — and the autonomous flag is opt-out) is
// unit-tested without spawning a process.
//
// ── F0 (ADR-067): ESTA SUPERFÍCIE MIGROU PARA A CONTENÇÃO DO SO ────────────────────────────────────
// `run_task` era uma das sete superfícies que ainda emitiam `--dangerously-skip-permissions`, e é uma
// tool do endpoint MCP que fica na internet pública por desenho. Migrá-la primeiro foi certo: fecha o
// caminho que não depende de credencial de painel.
//
// ⚠ MAS ELA NÃO ERA A "ÚNICA ALCANÇÁVEL DE FORA" — esta linha dizia isso e era FALSA, medido por uma
// revisão. A CAPTURA (`smart-capture/claude.ts`) também é: `report_issue` e `usm_capture` chegam nela
// pelo mesmo endpoint MCP, com token de nível `write`, porque `requireSession` aceita ator MCP sem
// cookie (`auth/action-guard.ts`). E é a superfície que ingere TEXTO LIVRE não confiável — a de maior
// risco de prompt-injection do repositório, pelo cabeçalho do próprio `spawn-chokepoint.test.ts`.
//
// Pior: pelo caminho MCP ela não emitia flag nenhuma, o que parecia seguro e não era. Sem
// `--permission-mode`, o modo efetivo vinha do `~/.claude/settings.json` do host — `bypassPermissions`
// na instalação de referência — somado ao `IS_SANDBOX=1` que ela injetava sempre que root. Autonomia
// plena por herança de settings, invisível no argv. Fechado em `smart-capture/claude.ts` nesta fase;
// a migração dela para a postura é a PRIMEIRA da fila de F1, acima das que exigem painel.
//
// A postura vem do MESMO resolvedor do autorun, então esta tool herda tudo: sandbox do SO quando
// disponível, RECUSA quando o modo é `required` e não há sandbox, rebaixamento com perda real de Bash
// quando é `preferred`, e a mesma válvula explícita. `workdir` é ao mesmo tempo a raiz de projeto (de
// onde o CLI lê settings) e a árvore de escrita — aqui os dois coincidem, diferente do autorun.
// A postura é OBRIGATÓRIA. A primeira versão desta migração deixou um ramo legado que ainda emitia a
// flag perigosa quando a postura não vinha — e um caminho sem consumidor de produção que emite a coisa
// que a fase existe para remover é a definição de dívida disfarçada de compatibilidade. Se um chamador
// novo aparecer, o compilador o obriga a resolver a postura, que é o comportamento correto.
export function buildRunTaskArgs(
  prompt: string,
  posture: AutonomyPosture,
): { args: string[]; needsRootBypass: boolean } {
  // ⚠ `permissionArgs` NÃO pode ser vazio (achado de revisão). A primeira migração passava `[]`, e o
  // comando saía sem `--permission-mode acceptEdits` — o modo que este mesmo módulo declara
  // load-bearing, apoiado na medição de que o `Write` NATIVO escapa da árvore fora dele. Pior: o
  // portão REJEITA essa forma ("--permission-mode (ausente)"), então a tool montava um comando que a
  // própria fase considera inválido, e nada percebia porque o portão não era chamado.
  const { flags, needsRootBypass } = buildSpawnFlags({
    posture,
    permissionArgs: posture.kind === "unsandboxed-escape" ? [] : ["--permission-mode", "acceptEdits"],
  });
  return { args: ["-p", prompt, "--output-format", "text", ...flags], needsRootBypass };
}

// Context/transcript helpers moved to lib/vps/claude-transcript.ts (WS-6.4): the fleet view and the
// /processes page need the SAME answer, and importing THIS module for it would drag the MCP SDK into the
// page graph (and cycle back through session-spawn). Re-exported so this file stays the one import site
// the existing dev-tools tests know.
export {
  computeContextPct,
  contextPctFromTranscript,
  findNewTranscript,
  RECYCLE_THRESHOLD,
  suggestRecycle,
} from "@/lib/vps/claude-transcript";

// (F8) `parseTmuxSessions` foi REMOVIDA: era um segundo parse de `tmux list-sessions`, mais pobre que o
// de `lib/vps/tmux.ts listSessions()` (que já traz cwd, criação, comando e geometria) e usado por um
// consumidor só. Duas leituras do mesmo comando são duas verdades — e a que apodrece é sempre a cópia.

// --- session registry (cwd + transcript per claude_new session) -----------
// globalThis-pinned so it survives Next's HMR (same trick as the deploy registry).
interface SessionMeta {
  cwd: string;
  createdAt: number;
  transcriptFile?: string;
}
const SESSION_META_KEY = Symbol.for("storymap.mcp.sessionMeta");
const sessionStore = globalThis as unknown as { [SESSION_META_KEY]?: Map<string, SessionMeta> };
function getSessionMetaMap(): Map<string, SessionMeta> {
  return (sessionStore[SESSION_META_KEY] ??= new Map());
}

/**
 * O transcript de uma sessão tmux, com a MESMA precedência que `claude_sessions` usa para o resto:
 * registro DURÁVEL da frota (sobrevive a restart) → resolução VIVA pelo pane (o pidfile do próprio CLI)
 * → o Map em memória. `null` quando a sessão não roda um Claude (um shell `cop-*`) ou o CLI ainda não
 * gravou nada — os dois casos são respostas, não erros.
 */
async function resolveTranscriptFor(session: string): Promise<{ path: string; source: string } | null> {
  const fromFleet = (await allSessions().catch(() => [])).find((s) => s.tmuxSession === session)?.transcriptFile;
  if (fromFleet) return { path: fromFleet, source: "registro da frota" };
  try {
    const { resolvePaneLive } = await import("@/lib/vps/pane-claude-map");
    const r = await resolvePaneLive(session);
    if (r.ok && r.pane.transcriptPath) return { path: r.pane.transcriptPath, source: `pane (${r.pane.source})` };
  } catch {
    /* degrada para o mapa em memória */
  }
  const fromMap = getSessionMetaMap().get(session)?.transcriptFile;
  return fromMap ? { path: fromMap, source: "registro em memória" } : null;
}

// --- checks em BACKGROUND (M9) --------------------------------------------
// globalThis-pinned pelo mesmo motivo do registro de sessões: sobreviver ao HMR do Next. Efêmero por
// desenho — um restart do serviço perde os jobs, e a consulta diz isso em vez de mentir "não existe".
interface CheckJob {
  id: string;
  target: string;
  status: "running" | "done";
  exitCode?: number;
  startedAt: number;
  finishedAt?: number;
  /** ring buffer das últimas linhas — um `just test-*` cospe dezenas de milhares. */
  out: string[];
}
const CHECK_JOBS_KEY = Symbol.for("storymap.mcp.checkJobs");
const checkStore = globalThis as unknown as { [CHECK_JOBS_KEY]?: Map<string, CheckJob> };
function getCheckJobs(): Map<string, CheckJob> {
  return (checkStore[CHECK_JOBS_KEY] ??= new Map());
}

const CHECK_LOG_LINES = 400;

/** O unit transiente do self-update. NOSSO (nós o criamos e coletamos) e FIXO → um segundo update
 *  enquanto o primeiro roda é no-op, a mesma disciplina do DEPLOY_UNIT. Não confundir com o SCRIPT,
 *  que é do operador e por isso é declarado (`AGILEHARNESS_UPDATE_SCRIPT`). */
export const UPDATE_UNIT = "storymap-update";

/** Dispara `just <target>` desanexado e registra o job. O target JÁ passou pela allowlist no chamador,
 *  e o `just` JÁ foi resolvido por ele (story-frente3) — aqui não se adivinha executável. */
function startCheckJob(target: string, justPath: string): CheckJob {
  const id = `check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: CheckJob = { id, target, status: "running", startedAt: Date.now(), out: [] };
  getCheckJobs().set(id, job);
  const child = spawn(justPath, [target], { cwd: findRepoRoot(), windowsHide: true });
  const absorve = (chunk: Buffer | string) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      job.out.push(line);
      if (job.out.length > CHECK_LOG_LINES) job.out.shift();
    }
  };
  child.stdout?.on("data", absorve);
  child.stderr?.on("data", absorve);
  child.on("close", (code) => {
    job.status = "done";
    job.exitCode = code ?? 1;
    job.finishedAt = Date.now();
  });
  child.on("error", (err) => {
    job.status = "done";
    job.exitCode = 1;
    job.finishedAt = Date.now();
    job.out.push(`[erro ao lançar] ${err.message}`);
  });
  return job;
}

// --- wait_for_session_idle core (story-97gpdm) ----------------------------
// Não existe SINAL de idle para uma sessão Claude tmux (só contextPct + has-session). O proxy mais robusto:
// a ESTABILIDADE da tela — o Claude muda o terminal enquanto responde e o deixa estático (prompt) quando
// termina. O core polla um `sample()` (um token que muda a cada atividade — no wrapper, o conteúdo da tela
// via capture-pane) até ele ficar estável por `idleMs`, ou até o timeout. Injetável ⇒ determinístico no teste.
export interface IdleWaitDeps {
  /** Token que MUDA quando há atividade na sessão (conteúdo da tela). null ⇒ não deu pra amostrar. */
  sample(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}
export type IdleWaitResult = { state: "idle"; stableForMs: number } | { state: "timeout" } | { state: "unknown" };

/**
 * Aguarda uma sessão ficar OCIOSA por estabilidade do `sample()`. Reseta o relógio de estabilidade a cada
 * mudança (atividade); declara `idle` quando o sample fica igual por ≥ `idleMs`; `timeout` se não estabilizar
 * a tempo; `unknown` se não conseguir amostrar (nunca finge ocioso). PURO sobre as deps.
 */
export async function waitForIdleCore(
  deps: IdleWaitDeps,
  opts: { idleMs: number; timeoutMs: number; pollMs: number },
): Promise<IdleWaitResult> {
  const start = deps.now();
  let last = await deps.sample();
  if (last == null) return { state: "unknown" };
  let stableSince = deps.now();
  while (deps.now() - start < opts.timeoutMs) {
    await deps.sleep(opts.pollMs);
    const cur = await deps.sample();
    if (cur == null) return { state: "unknown" };
    if (cur !== last) {
      last = cur;
      stableSince = deps.now(); // atividade → reseta a janela de estabilidade
    } else if (deps.now() - stableSince >= opts.idleMs) {
      return { state: "idle", stableForMs: deps.now() - stableSince };
    }
  }
  return { state: "timeout" };
}

// --- git worktree inspection (story-08969p) -------------------------------
// PURE parse + classify, extracted from the worktree_list tool so the merge-back-travado diagnostic
// (which worktree is a LEAKED/orphan run) is unit-testable WITHOUT spawning git or the runner.

/** One record of `git worktree list --porcelain`. `branch` is the short name (refs/heads/ stripped). */
export interface ParsedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

/** Parse the `--porcelain` output into one record per worktree. Records are separated by a blank line;
 *  each attribute is `key value` (or a bare flag). Unknown attributes are ignored (forward-compatible). */
export function parseWorktreeList(porcelain: string): ParsedWorktree[] {
  const records: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;
  const flush = (): void => {
    if (cur) records.push(cur);
    cur = null;
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    switch (key) {
      case "worktree":
        flush();
        cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
        break;
      case "HEAD":
        if (cur) cur.head = val || null;
        break;
      case "branch":
        if (cur) cur.branch = val.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        if (cur) cur.detached = true;
        break;
      case "bare":
        if (cur) cur.bare = true;
        break;
      case "locked":
        if (cur) {
          cur.locked = true;
          if (val) cur.lockedReason = val;
        }
        break;
      case "prunable":
        if (cur) {
          cur.prunable = true;
          if (val) cur.prunableReason = val;
        }
        break;
      default:
        break; // unknown attribute → ignore
    }
  }
  flush(); // last record when the output has no trailing blank line
  return records;
}

export type WorktreeRole = "runtime" | "stage" | "run" | "session" | "other";

/** A parsed worktree + the diagnostic verdict. For `run` worktrees (branch `run/<sessionId>`):
 *  `active` = the run's session is live in the registry; `parkedMerge` = a merge-queue entry is holding
 *  its branch; `orphan` = NEITHER → a LEAKED worktree nothing will advance or clean up (the classic
 *  "merge-back travado" tell: runner idle + mergeQueue empty, yet the run/<id> worktree lingers).
 *
 *  WS-1 — `session` worktrees (branch `agent/<sessionId>`) reuse `active` with a DIFFERENT meaning and,
 *  crucially, NO orphan verdict: a session's tree legitimately sits idle between tool calls for hours, so
 *  "nothing is holding it right now" is its normal state, not a leak. An agent tree is only ever garbage
 *  once its heartbeat dies (the registry's TTL judgement — never this snapshot's). `owner`/`task` answer
 *  the question the panel exists for: whose tree is this, and what is it doing? */
export interface ClassifiedWorktree extends ParsedWorktree {
  role: WorktreeRole;
  sessionId?: string;
  active?: boolean;
  orphan?: boolean;
  parkedMerge?: boolean;
  /** `session` only: what the agent said it was doing (`worktree_open({task})`). */
  task?: string;
  /** `session` only: who opened it (the MCP token's authority), when known. */
  owner?: string;
  /** `session` only: ISO of the last tool call — the fact the reaper/reconciler actually obey. */
  heartbeatAt?: string;
}

const stripRef = (b: string): string => b.replace(/^refs\/heads\//, "");
const normPath = (p: string): string => p.replace(/[/\\]+$/, "");

/** Attach the role + orphan verdict to each worktree, cross-referencing the live runner state. PURE:
 *  the caller injects the runtime facts (repoRoot, live session ids, staging branch, parked branches). */
export function classifyWorktrees(
  worktrees: ParsedWorktree[],
  ctx: {
    repoRoot: string;
    runningSessionIds: Iterable<string>;
    stageBranch?: string | null;
    parkedBranches?: Iterable<string>;
    /** WS-1 — the agent-session registry, so an `agent/*` tree shows its owner + state (AC5). */
    sessions?: Array<{ sessionId: string; task: string; actor?: string; heartbeatAt: string; alive: boolean }>;
  },
): ClassifiedWorktree[] {
  const running = new Set(ctx.runningSessionIds);
  const parked = new Set([...(ctx.parkedBranches ?? [])].map(stripRef));
  const stageBranch = ctx.stageBranch ? stripRef(ctx.stageBranch) : null;
  const sessions = new Map((ctx.sessions ?? []).map((s) => [s.sessionId, s]));
  return worktrees.map((w) => {
    const runMatch = w.branch ? /^run\/(.+)$/.exec(w.branch) : null;
    if (runMatch) {
      const sessionId = runMatch[1];
      const active = running.has(sessionId);
      const parkedMerge = w.branch ? parked.has(w.branch) : false;
      return { ...w, role: "run" as const, sessionId, active, parkedMerge, orphan: !active && !parkedMerge };
    }
    const agentMatch = w.branch ? /^agent\/(.+)$/.exec(w.branch) : null;
    if (agentMatch) {
      const sessionId = agentMatch[1];
      const s = sessions.get(sessionId);
      // NO `orphan` verdict here, deliberately (see the type's note): an idle session tree is normal, and
      // a tree the registry doesn't know is a diagnostic curiosity for a human — never an auto-delete cue.
      return {
        ...w,
        role: "session" as const,
        sessionId,
        active: s?.alive,
        task: s?.task,
        owner: s?.actor,
        heartbeatAt: s?.heartbeatAt,
      };
    }
    if (normPath(w.path) === normPath(ctx.repoRoot)) return { ...w, role: "runtime" as const };
    if (stageBranch && w.branch === stageBranch) return { ...w, role: "stage" as const };
    return { ...w, role: "other" as const };
  });
}

// --- registration ---------------------------------------------------------

export function registerDevTools(server: McpServer): void {
  // ===== CODE (read-only) ===============================================

  defineTool(server,
    "search_code",
    {
      title: "Buscar no código",
      description:
        "Busca um padrão (regex) no código do repo via git grep (inclui arquivos novos não-commitados, " +
        "exclui gitignored). Use para 'onde está X', 'quem chama Y'. Filtre por pathGlob (ex.: 'packages/<app>/**').",
      inputSchema: {
        query: z.string().describe("padrão/regex a buscar"),
        pathGlob: z.string().optional().describe("pathspec git para limitar, ex.: packages/storymap-ui/**"),
        maxResults: z.number().int().positive().max(300).optional().describe("padrão 80"),
      },
    },
    async ({ query, pathGlob, maxResults }) => {
      const args = ["grep", "-n", "-I", "--untracked", "-e", query];
      if (pathGlob) args.push("--", pathGlob);
      const r = await run("git", args, { timeoutMs: 25_000 });
      if (r.code !== 0 && r.code !== 1) return fail(r.stderr.slice(0, 500) || "erro na busca");
      const all = r.stdout.split("\n").filter(Boolean);
      const cap = Math.min(maxResults ?? 80, 300);
      return json({ query, matches: all.length, shown: Math.min(all.length, cap), truncated: all.length > cap, results: all.slice(0, cap) });
    },
  );

  defineTool(server,
    "read_file",
    {
      title: "Ler arquivo do repo",
      description:
        "Lê um arquivo versionado/novo do repo (read-only). Recusa gitignored (.env, node_modules) e caminhos " +
        "com cara de segredo. Use startLine/endLine para um trecho (default: primeiras 400 linhas).",
      inputSchema: {
        filePath: z.string().describe("caminho relativo ao repo, ex.: packages/storymap-ui/src/lib/storymap/paths.ts"),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
    },
    async ({ filePath, startLine, endLine }) => {
      const rel = toRepoRel(filePath);
      if (!rel) return fail("Caminho fora do repositório.");
      if (isSecretPath(rel)) return fail("Caminho bloqueado (parece conter segredo).");
      if (await isGitIgnored(rel)) return fail("Arquivo gitignored (ex.: .env, node_modules) — leitura recusada.");
      let content: string;
      try {
        content = await fs.readFile(path.join(findRepoRoot(), rel), "utf8");
      } catch {
        return fail(`não consegui ler: ${rel}`);
      }
      const lines = content.split("\n");
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? start + 399);
      const out = lines.slice(start - 1, end).join("\n").slice(0, 40_000);
      return json({ file: rel, totalLines: lines.length, range: [start, Math.min(end, lines.length)], content: out });
    },
  );

  defineTool(server,
    "list_files",
    {
      title: "Listar arquivos",
      description:
        "Lista os arquivos do repo (versionados + novos não-ignorados) — opcionalmente filtrados por um pathspec git.",
      inputSchema: {
        pattern: z.string().optional().describe("pathspec, ex.: packages/<app>/**/*.ts"),
        limit: z.number().int().positive().max(1000).optional().describe("padrão 200"),
      },
    },
    async ({ pattern, limit }) => {
      const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
      if (pattern) args.push("--", pattern);
      const r = await run("git", args, { timeoutMs: 15_000 });
      if (r.code !== 0) return fail(r.stderr.slice(0, 300) || "erro");
      const files = r.stdout.split("\n").filter(Boolean).filter((f) => !isSecretPath(f));
      const cap = Math.min(limit ?? 200, 1000);
      return json({ total: files.length, shown: Math.min(files.length, cap), files: files.slice(0, cap) });
    },
  );

  defineTool(server,
    "file_tree",
    {
      title: "Árvore de diretórios",
      description: "Estrutura de diretórios/arquivos do repo (até `depth` níveis) a partir de `dir`.",
      inputSchema: {
        dir: z.string().optional().describe("subdiretório raiz, ex.: packages/storymap-ui/src"),
        depth: z.number().int().positive().max(5).optional().describe("padrão 2"),
      },
    },
    async ({ dir, depth }) => {
      const base = (dir ?? "").replace(/^\/+|\/+$/g, "");
      if (base && !toRepoRel(base)) return fail("Caminho fora do repositório.");
      const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
      if (base) args.push("--", base);
      const r = await run("git", args, { timeoutMs: 15_000 });
      if (r.code !== 0) return fail(r.stderr.slice(0, 300) || "erro");
      const d = Math.min(depth ?? 2, 5);
      const set = new Set<string>();
      for (const f of r.stdout.split("\n").filter(Boolean)) {
        if (isSecretPath(f)) continue;
        const rest = base ? f.slice(base.length + 1) : f;
        const parts = rest.split("/");
        let acc = base;
        for (let i = 0; i < Math.min(d, parts.length); i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          set.add(acc + (i === parts.length - 1 ? "" : "/"));
        }
      }
      return json({ dir: base || ".", depth: d, entries: [...set].sort().slice(0, 600) });
    },
  );

  // ===== GIT ============================================================

  defineTool(server,
    "git_status",
    {
      title: "git status",
      description: "Branch atual + arquivos modificados/novos (working tree). O estado REAL não-commitado.",
      inputSchema: {},
    },
    async () => {
      const r = await run("git", ["status", "--porcelain=v1", "-b"], { timeoutMs: 15_000 });
      if (r.code !== 0) return fail(r.stderr.slice(0, 300));
      let out = r.stdout || "(working tree limpo)";
      // audit #7: when staging is active, the most-recently-BUILT code lives on the `stage` branch
      // (held for the human release), NOT on this checkout — so an agent reading code here can wrongly
      // conclude a just-shipped feature "não existe". Surface the delta so it checks stage first.
      try {
        const st = loadRunnerConfig().autorun.staging;
        if (st?.enabled && st.branch) {
          const ahead = await run("git", ["rev-list", "--count", `HEAD..${st.branch}`], { timeoutMs: 10_000 });
          const n = Number(ahead.stdout.trim());
          if (ahead.code === 0 && Number.isFinite(n) && n > 0) {
            out +=
              `\n\n⚠ main está ${n} commit(s) ATRÁS de \`${st.branch}\`: há código staged ainda não publicado.` +
              ` Antes de concluir que algo "não existe", veja \`git log ${st.branch} --oneline\` /` +
              ` \`git diff HEAD..${st.branch} -- 'packages/**'\`.`;
          }
        }
      } catch {
        /* config unreadable → omit the banner (behaviour identical to pre-fix) */
      }
      return text(out);
    },
  );

  defineTool(server,
    "git_diff",
    {
      title: "git diff",
      description:
        "Diff do working tree (ou contra uma ref: HEAD~1, uma branch, um sha). Opcionalmente de um arquivo. Patch truncado.",
      inputSchema: {
        ref: z.string().optional().describe("ref de comparação, ex.: HEAD~1, main, <sha>"),
        filePath: z.string().optional(),
      },
    },
    async ({ ref, filePath }) => {
      if (ref && !isSafeRef(ref)) return fail("ref inválida.");
      const args = ["diff"];
      if (ref) args.push(ref);
      if (filePath) {
        const rel = toRepoRel(filePath);
        if (!rel) return fail("Caminho fora do repositório.");
        args.push("--", rel);
      }
      const r = await run("git", args, { timeoutMs: 20_000, maxBuffer: 8_000_000 });
      if (r.code !== 0 && r.stderr) return fail(r.stderr.slice(0, 300));
      const patch = r.stdout.slice(0, 60_000);
      return text(patch ? patch + (r.stdout.length > 60_000 ? "\n…(truncado)" : "") : "(sem diferenças)");
    },
  );

  defineTool(server,
    "git_log",
    {
      title: "git log",
      description: "Commits recentes (hash, data, autor, assunto). Opcionalmente de um arquivo/path.",
      inputSchema: {
        n: z.number().int().positive().max(100).optional().describe("padrão 15"),
        filePath: z.string().optional(),
      },
    },
    async ({ n, filePath }) => {
      const count = Math.min(Math.max(n ?? 15, 1), 100);
      const args = ["log", "-n", String(count), "--pretty=format:%h %ad %an  %s", "--date=short"];
      if (filePath) {
        const rel = toRepoRel(filePath);
        if (!rel) return fail("Caminho fora do repositório.");
        args.push("--", rel);
      }
      const r = await run("git", args, { timeoutMs: 15_000 });
      return r.code === 0 ? text(r.stdout) : fail(r.stderr.slice(0, 300));
    },
  );

  defineTool(server,
    "git_show",
    {
      title: "git show",
      description: "Detalha um commit/objeto (stat + patch) por ref/sha. Patch truncado.",
      inputSchema: { ref: z.string().describe("sha/ref, ex.: HEAD, 42ab9d66") },
    },
    async ({ ref }) => {
      if (!isSafeRef(ref)) return fail("ref inválida.");
      const r = await run("git", ["show", "--stat", ref], { timeoutMs: 20_000, maxBuffer: 8_000_000 });
      return r.code === 0 ? text(r.stdout.slice(0, 60_000)) : fail(r.stderr.slice(0, 300));
    },
  );

  defineTool(server,
    "worktree_list",
    {
      title: "git worktree list (diagnóstico)",
      description:
        "Lista os git worktrees ATIVOS do runtime (equivalente a `git worktree list`) com DIAGNÓSTICO: rotula cada " +
        "worktree (runtime = o checkout principal / stage = worktree interno do merge train / run = worktree " +
        "efêmero de um run / session = worktree de uma sessão de agente / other) e, para os worktrees de run " +
        "(branch `run/<sessionId>`), cruza com o estado vivo do runner: `active` (a sessão está rodando), " +
        "`parkedMerge` (há um merge parkado segurando o branch) e `orphan` (NENHUM dos dois → worktree VAZADO que " +
        "nada vai avançar nem limpar). Os worktrees de sessão (branch `agent/<sessionId>`) mostram dono, task e " +
        "heartbeat, e NUNCA recebem veredito de órfão (uma sessão fica ociosa entre chamadas por horas — isso é " +
        "normal, não vazamento). Use para diagnosticar um merge-back que aparentemente não aconteceu (runner " +
        "ocioso + mergeQueue vazia, mas o run/<id> sobrou) SEM abrir um terminal manual.",
      inputSchema: {},
    },
    async () => {
      const r = await run("git", ["worktree", "list", "--porcelain"], { timeoutMs: 15_000 });
      if (r.code !== 0) return fail(r.stderr.slice(0, 300) || "git worktree list falhou");
      const parsed = parseWorktreeList(r.stdout);
      // Cross-reference the SAME in-process runner state runner_status reads: live sessions + parked merges.
      // Each lookup is best-effort — a diagnostic must degrade to the raw list, never fail, if a store is cold.
      let runningSessionIds: string[] = [];
      try {
        runningSessionIds = getRunnerRegistry().snapshot().running.map((x) => x.sessionId);
      } catch {
        /* registry unavailable → no active/orphan cross-ref (list still returned) */
      }
      let parkedBranches: string[] = [];
      try {
        parkedBranches = getMergeQueue()
          .getSnapshot()
          .entries.filter((e) => e.status === "gate-failed" || e.status === "conflict")
          .map((e) => e.branch);
      } catch {
        /* merge queue unavailable → omit parkedMerge cross-ref */
      }
      let stageBranch: string | null = null;
      try {
        stageBranch = loadRunnerConfig().autorun.staging?.branch ?? null;
      } catch {
        /* config unreadable → stage worktree just falls through to role:other */
      }
      // WS-1 (AC5): cross-reference the agent-session registry so an `agent/*` tree shows WHO owns it and
      // WHAT it is doing. Best-effort like every other lookup here — a cold registry degrades to a bare row.
      let sessions: Array<{ sessionId: string; task: string; actor?: string; heartbeatAt: string; alive: boolean }> = [];
      try {
        const now = Date.now();
        sessions = (await allSessions()).map((s) => ({
          sessionId: s.sessionId,
          task: s.task,
          actor: s.actor,
          heartbeatAt: s.heartbeatAt,
          alive: isSessionAlive(s, now),
        }));
      } catch {
        /* registry unreadable → session rows still listed, just without owner/task */
      }
      const worktrees = classifyWorktrees(parsed, {
        repoRoot: findRepoRoot(),
        runningSessionIds,
        stageBranch,
        parkedBranches,
        sessions,
      });
      const orphans = worktrees.filter((w) => w.orphan);
      const live = worktrees.filter((w) => w.role === "session" && w.active);
      const sessionNote = live.length ? ` ${live.length} sessão(ões) de agente viva(s).` : "";
      const summary =
        (orphans.length
          ? `⚠ ${orphans.length} worktree(s) de run ÓRFÃO(S) — sem run vivo nem merge na fila (possível merge-back travado): ` +
            orphans.map((o) => o.branch ?? o.path).join(", ")
          : `${worktrees.length} worktree(s), nenhum órfão.`) + sessionNote;
      return json({ summary, worktrees });
    },
  );

  // ===== WORKTREE DE SESSÃO (WS-1) =====================================
  // O contrato que uma sessão de agente usa para tocar CÓDIGO sem colidir com ninguém: abre a SUA árvore,
  // trabalha, submete pelo train. As 4 tools abaixo são a ÚNICA superfície sancionada — o mint do branch, a
  // base, a admissão e o pin do sha ficam em UM lugar auditável. Uma sessão que rodasse `git worktree add`
  // na mão acabaria cortando da base errada (o bug recorrente mais caro deste sistema).
  //
  // Contrato de escrita (G8), a regra prática:
  //   • o PRODUTO do trabalho (código, e o card/sidecar que ele muda) vai no SEU worktree → integra pelo
  //     train, com gate e 3-way por elemento;
  //   • estado de pipeline URGENTE (status, findings, respostas) vai por MCP (update_card etc.) → aterrissa
  //     em main na hora, sem esperar o train.
  // Os dois convergem (o merge por elemento do WS-2 não deixa um reverter o outro).

  defineTool(server,
    "worktree_open",
    {
      title: "Abrir worktree de sessão",
      description:
        "Provisiona um git worktree EFÊMERO e EXCLUSIVO desta sessão para trabalhar em CÓDIGO, cortado da mesma " +
        "base dos runs (stage sincronizado) e com node_modules já linkado. Devolve {sessionId, path, branch, " +
        "baseCommit} — trabalhe DENTRO de `path`. NUNCA edite o checkout de runtime nem o worktree de stage " +
        "(é a engrenagem interna do merge train). Passe `cardId` quando o trabalho for de um card; trabalho " +
        "sem card (self-dev, fix rápido) é legítimo e integra igual. Recusa quando o cap de sessões " +
        "(autorun.sessions.maxWorktrees) ou a VPS estão saturados — a recusa diz quem está segurando.",
      inputSchema: {
        board: z.string().optional().describe("board do card, quando houver"),
        cardId: z.string().optional().describe("card que este trabalho serve; omita para trabalho sem card"),
        task: z.string().min(3).describe("o que esta sessão vai fazer — aparece em /processes como o dono da árvore"),
      },
    },
    async ({ board, cardId, task }) => {
      // WHO opened it, for /processes + the steward: the token's authority level and the env-var holding
      // it — the only identity the MCP layer actually has (McpActor carries no free-form principal).
      const who = currentMcpActor();
      const res = await openSessionWorktree(sessionDeps(), {
        board,
        cardId,
        task,
        actor: who ? `mcp:${who.level}${who.tokenEnv ? `(${who.tokenEnv})` : ""}` : undefined,
      });
      if (!res.ok) return fail(res.reason);
      const s = res.session;
      return json({
        sessionId: s.sessionId,
        path: s.worktreePath,
        branch: s.branch,
        baseCommit: s.baseCommit,
        next: "trabalhe em `path`; depois worktree_submit({sessionId}) para integrar pelo merge train",
      });
    },
  );

  defineTool(server,
    "worktree_submit",
    {
      title: "Submeter worktree de sessão ao merge train",
      description:
        "Commita o que estiver pendente no worktree da sessão (com secret-scan fail-closed), PINA o sha atual e " +
        "enfileira no merge train. O train integra EXATAMENTE o sha pinado — você pode continuar trabalhando " +
        "que os commits novos NÃO entram nesta submissão (eles vão na próxima). O gate roda a suíte e o split " +
        "manda código→stage e board-data→main. Acompanhe por wait_for_run/runner_status. Se conflitar ou o gate " +
        "reprovar, a entrada volta PARA VOCÊ (`returned-to-session`) — nada parqueia para o operador: rode " +
        "worktree_refresh e submeta de novo. O branch NUNCA é deletado pelo train.",
      inputSchema: {
        sessionId: z.string().describe("o sessionId devolvido por worktree_open"),
        message: z.string().optional().describe("mensagem do commit (default: a task da sessão)"),
      },
    },
    async ({ sessionId, message }) => {
      const res = await submitSessionWork(sessionDeps(), { sessionId, message });
      if (!res.ok) return fail(res.reason);
      return json({
        entryId: res.entryId,
        pinnedSha: res.pinnedSha,
        committed: res.committed,
        // `committed: true` significa "commitado e ENFILEIRADO", não "integrado" — o veredito vem do train
        // depois. A instrução aqui apontava para `wait_for_run({runId})`, uma assinatura que NÃO EXISTE
        // (aquela tool recebe board+cardId, e uma entrada de sessão não tem card): quem seguisse o conselho
        // à risca não conseguia descobrir o próprio desfecho. Aponte para a tool que responde de fato.
        next:
          `o train integra o sha ${res.pinnedSha.slice(0, 8)} — isto ainda NÃO é o veredito; ` +
          `bloqueie em wait_for_submit({sessionId:"${sessionId}"}) para receber o desfecho COM o motivo`,
      });
    },
  );

  defineTool(server,
    "wait_for_submit",
    {
      title: "Aguardar o veredito da submissão desta sessão",
      description:
        "BLOQUEIA até o merge train decidir a submissão desta sessão e devolve o VEREDITO COM O MOTIVO — " +
        "em vez de repolling de runner_status (que projeta só entradas VIVAS e por isso NUNCA mostra um " +
        "desfecho terminal como `returned-to-session`). Devolve {status, detail, next}: `done` (integrou), " +
        "`returned-to-session` (o conflito é seu: `detail` diz qual — rode worktree_refresh e re-submeta), " +
        "`conflict`/`gate-failed`/`failed` (parqueado, `detail` diz por quê) ou `waiting` com state " +
        "'timeout' (ainda na fila — re-chame). Se a submissão JÁ foi decidida, responde na hora.",
      inputSchema: {
        sessionId: z.string().describe("o sessionId devolvido por worktree_open (== runId da entrada)"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600000)
          .optional()
          .describe("teto de espera em ms antes de devolver 'timeout' (padrão 120000, máx 600000)"),
      },
    },
    async ({ sessionId, timeoutMs }) => {
      const mq = getMergeQueue();
      // As mesmas fases vivas que runner_status projeta; qualquer outra coisa é veredito. A régua vem de
      // `merge-status.ts` — era a SEXTA cópia hardcoded dela.
      // Uma entrada por runId (enqueueMerge supersede a anterior), então isto é sempre a submissão atual.
      const entryOf = () => mq.getSnapshot().entries.find((e) => e.runId === sessionId);
      const current = entryOf();
      if (!current) {
        return fail(
          `nenhuma submissão de ${sessionId} no train — ela nunca foi enfileirada, ou o registro já foi ` +
            `coletado. Rode worktree_submit({sessionId:"${sessionId}"}) para submeter.`,
        );
      }
      const result = await waitForRunCore(
        {
          // `gate-failed`/`conflict` são TERMINAIS para quem espera (parqueados, ninguém mais os move
          // sozinho): tratá-los como vivos deixaria a sessão bloqueada até o timeout por um veredito que
          // já saiu. Vivo aqui é só o que o train ainda está processando.
          isActive: () => {
            const e = entryOf();
            return !!e && isLiveMergeStatus(e.status) && e.status !== "gate-failed" && e.status !== "conflict";
          },
          latestOutcome: () => entryOf()?.status ?? null,
          subscribe: (onDone) =>
            mq.onEntrySettled((ev) => {
              if (ev.runId === sessionId) onDone(ev.status);
            }),
          schedule: (ms, cb) => {
            const t = setTimeout(cb, ms);
            return () => clearTimeout(t);
          },
        },
        Math.min(timeoutMs ?? 120000, 600000),
        () => Date.now(),
      );
      // Releia a entrada para o veredito AUTORITATIVO: o evento carrega o status, mas o motivo (e um
      // status que tenha avançado entre o evento e agora) vive na entrada.
      const settled = entryOf();
      const status = settled?.status ?? ("outcome" in result ? result.outcome : null) ?? "desconhecido";
      const detail = settled?.conflictDetail ?? settled?.failureReason;
      const next =
        status === "done"
          ? "integrado — nada a fazer; worktree_discard quando terminar a sessão"
          : status === "returned-to-session"
            ? `o conflito é SEU: worktree_refresh({sessionId:"${sessionId}"}) rebasa sobre a base nova, resolva e re-submeta`
            : result.state === "timeout"
              ? "ainda na fila — re-chame esta tool para continuar esperando"
              : `parqueado como ${status} — leia o motivo em detail e trate antes de re-submeter`;
      return json({
        sessionId,
        state: result.state,
        status,
        // SEMPRE presente quando há motivo: era exatamente isto que não tinha leitor nenhum na superfície
        // MCP, e por isso a devolução chegava à sessão sem nada em que agir.
        ...(detail ? { detail } : {}),
        waitedMs: "waitedMs" in result ? result.waitedMs : 0,
        next,
      });
    },
  );

  // M5 — a espera MULTIPLEXADA. Ver o doc de `waitForAnyCore` para o defeito que ela cura.
  defineTool(server,
    "wait_for_any",
    {
      title: "Aguardar o PRIMEIRO de vários alvos",
      description:
        "BLOQUEIA até o PRIMEIRO dos alvos acontecer e diz QUAL foi — a espera que faltava para pilotar " +
        "uma frota. As outras esperas são de entidade única (wait_for_run, wait_for_submit, " +
        "wait_for_session_idle), então com N sessões vivas você só conseguia bloquear numa por vez e " +
        "acabava voltando a fazer polling. Combine os alvos: `runs` (cards rodando), `submits` (sessões no " +
        "merge train) e `sessions` (terminais que você mandou trabalhar). Devolve {state:'fired'|'already'" +
        "|'timeout', key, event}: `key` identifica o alvo ('run:<board>/<card>', 'submit:<id>', " +
        "'session:<tmux>'). Em 'timeout' nada aconteceu ainda — re-chame com os MESMOS alvos.",
      inputSchema: {
        runs: z
          .array(z.object({ board: z.string(), cardId: z.string() }))
          .optional()
          .describe("cards cujo run/merge-back você espera"),
        submits: z.array(z.string()).optional().describe("sessionIds cujo veredito do train você espera"),
        sessions: z.array(z.string()).optional().describe("nomes de sessão tmux que você espera ficarem ociosas"),
        idleMs: z.number().int().positive().max(120000).optional().describe("silêncio de tela p/ 'ociosa' (padrão 4000)"),
        timeoutMs: z.number().int().positive().max(600000).optional().describe("teto de espera (padrão 120000)"),
      },
    },
    async ({ runs, submits, sessions, idleMs, timeoutMs }) => {
      const engine = getRunnerEngine();
      const mq = getMergeQueue();
      await mq.liveRunIds(); // garante o store carregado antes de qualquer snapshot
      const quieto = Math.min(idleMs ?? 4000, 120000);
      const watchers: AnyWatcher<Record<string, unknown>>[] = [];

      for (const r of runs ?? []) {
        const key = `run:${r.board}/${r.cardId}`;
        const liveMerge = () =>
          mq.getSnapshot().entries.some((e) => e.board === r.board && e.cardId === r.cardId && isLiveMergeStatus(e.status));
        watchers.push({
          key,
          settledNow: () =>
            engine.isInFlight(r.board, r.cardId) || liveMerge() ? null : { tipo: "run", board: r.board, cardId: r.cardId },
          subscribe: (onEvent) => {
            const u1 = engine.onComplete((ev) => {
              if (ev.board === r.board && ev.cardId === r.cardId) onEvent({ tipo: "run", board: r.board, cardId: r.cardId, outcome: ev.outcome ?? null });
            });
            const u2 = mq.onMergeDone((ev) => {
              if (ev.board === r.board && ev.cardId === r.cardId) onEvent({ tipo: "merge", board: r.board, cardId: r.cardId });
            });
            return () => {
              u1();
              u2();
            };
          },
        });
      }

      for (const sid of submits ?? []) {
        const entryOf = () => mq.getSnapshot().entries.find((e) => e.runId === sid);
        watchers.push({
          key: `submit:${sid}`,
          settledNow: () => {
            const e = entryOf();
            // Mesma régua do wait_for_submit: parqueado É veredito para quem espera.
            if (!e) return null;
            const vivo = isLiveMergeStatus(e.status) && e.status !== "gate-failed" && e.status !== "conflict";
            return vivo ? null : { tipo: "submit", sessionId: sid, status: e.status, detail: e.conflictDetail ?? e.failureReason };
          },
          subscribe: (onEvent) =>
            mq.onEntrySettled((ev) => {
              if (ev.runId === sid) onEvent({ tipo: "submit", sessionId: sid, status: ev.status, detail: entryOf()?.conflictDetail });
            }),
        });
      }

      // Sessão ociosa NÃO tem evento — mas o vigia de terminais já mantém, EM MEMÓRIA, há quanto tempo
      // cada tela não produz nada. Então o watcher é um poll de leitura de memória (zero IO, zero
      // capture-pane), e não uma sonda nova. Sessão fora do retrato do vigia é dita ao chamador em vez
      // de esperar em silêncio até o timeout por um evento que nunca poderia disparar.
      const stillness = () => screenStillness();
      const naoObservadas = (sessions ?? []).filter((s) => !stillness().has(s));
      for (const s of sessions ?? []) {
        watchers.push({
          key: `session:${s}`,
          settledNow: () => {
            const parada = stillness().get(s);
            return parada != null && parada >= quieto ? { tipo: "session", session: s, paradaHaMs: parada } : null;
          },
          subscribe: (onEvent) => {
            const t = setInterval(() => {
              const parada = stillness().get(s);
              if (parada != null && parada >= quieto) onEvent({ tipo: "session", session: s, paradaHaMs: parada });
            }, 1000);
            t.unref?.();
            return () => clearInterval(t);
          },
        });
      }

      if (!watchers.length) return fail("passe ao menos um alvo: runs, submits ou sessions.");
      const res = await waitForAnyCore(
        watchers,
        Math.min(timeoutMs ?? 120000, 600000),
        (ms, cb) => {
          const t = setTimeout(cb, ms);
          return () => clearTimeout(t);
        },
        () => Date.now(),
      );
      return json({
        ...res,
        ...(naoObservadas.length
          ? {
              naoObservadas,
              aviso:
                "estas sessões não estão no retrato do vigia de terminais (teto de sessões observadas, ou o " +
                "vigia não as viu ainda) — a espera NUNCA dispararia por elas. Use wait_for_session_idle nelas.",
            }
          : {}),
        ...(res.state === "timeout" ? { next: "nada aconteceu ainda — re-chame com os MESMOS alvos para continuar esperando." } : {}),
      });
    },
  );

  defineTool(server,
    "worktree_refresh",
    {
      title: "Atualizar a base do worktree de sessão",
      description:
        "Re-sincroniza a base de integração e REBASA o branch da sessão sobre ela, DENTRO do seu worktree (main e " +
        "stage nunca são tocados), e atualiza o base-ref que mede o trabalho próprio da sessão. Use depois de um " +
        "`returned-to-session` (o conflito é seu para resolver) ou quando quiser pegar o que já foi integrado. Se " +
        "o rebase conflitar, os conflitos ficam NO SEU worktree: resolva (git add + git rebase --continue) ou " +
        "aborte (git rebase --abort) e chame esta tool de novo.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const res = await refreshSessionWorktree(sessionDeps(), { sessionId });
      if (!res.ok) return fail(res.reason);
      return json({
        baseCommit: res.baseCommit,
        rebased: res.rebased,
        detail: res.rebased ? "branch rebasado sobre a base nova" : "já estava na base atual (no-op)",
      });
    },
  );

  defineTool(server,
    "worktree_discard",
    {
      title: "Descartar worktree de sessão",
      description:
        "Encerra a sessão: remove a PASTA do worktree e dispõe o branch com o teardown FAIL-CLOSED — um branch com " +
        "commits não integrados é PRESERVADO como `failed/agent/<id>` (recuperável por cherry-pick), só um " +
        "provadamente vazio é deletado. Devolve o veredito. Chame ao terminar para liberar uma vaga do cap.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const res = await discardSessionWorktree(sessionDeps(), { sessionId });
      if (!res.ok) return fail(res.reason);
      return json({ branchPreserved: res.branchPreserved, detail: res.detail });
    },
  );

  defineTool(server,
    "suggest_work",
    {
      title: "Sugerir próximo trabalho (determinístico)",
      description:
        "Lista os cards ACIONÁVEIS de um board que NINGUÉM está trabalhando (sem claim vivo), ordenados por: " +
        "coluna mais à direita primeiro (WIP antes de trabalho novo — um card em QA está a um passo de " +
        "shipar; um em Spec está a um pipeline inteiro), depois prioridade (3 Crítica → 0 Baixa). É CÓDIGO, " +
        "não LLM: duas chamadas simultâneas recebem o MESMO ranking. NÃO reserva nada — a exclusão acontece " +
        "quando você ADQUIRE o claim (o 1º ganha; o 2º pega o próximo da lista). Chame ao terminar um card. " +
        "Exclui: coluna terminal, coluna sem automação (trabalho de humano), card com blocker aberto.",
      inputSchema: {
        board: z.string().describe("board a consultar"),
        role: z
          .enum(["implement", "review", "triage", "steward", "free"])
          .optional()
          .describe("filtra pelo tipo de trabalho (implement = colunas que escrevem código)"),
        count: z.number().int().positive().max(10).optional().describe("quantas sugestões (padrão 3)"),
      },
    },
    async ({ board, role, count }) => {
      const candidates = await collectWorkCandidates(board, {
        readCards: (b) => readCards(b) as Promise<never>,
        readBoardConfig: (b) => readBoardConfig(b) as Promise<never>,
        liveClaims: async () => {
          const now = Date.now();
          return (await getCardClaims().list(board)).filter((c) => isClaimLive(c, now));
        },
      });
      const suggestions = rankWorkCandidates(candidates, { role, count });
      if (!suggestions.length) {
        // An empty list is a RESULT, not a shrug: say why each near-miss was excluded, so the caller can tell
        // "the board is done" from "everything is claimed" from "everything is blocked".
        const near = candidates.map((c) => ({ cardId: c.cardId, status: c.status, motivo: excludedReason(c) })).filter((x) => x.motivo);
        return json({
          suggestions: [],
          summary: `nenhum card acionável e livre em ${board}`,
          excluidos: near.slice(0, 10),
        });
      }
      return json({ suggestions, summary: `${suggestions.length} sugestão(ões); adquira o claim para reservar de fato` });
    },
  );

  defineTool(server,
    "adopt_session",
    {
      title: "Adotar uma sessão tmux existente na frota",
      description:
        "Registra uma sessão tmux criada FORA da ferramenta na frota: ela ganha identidade, papel e claims, " +
        "e passa a aparecer no fleet view. ATENÇÃO — a adoção NÃO dá isolamento: ela não muda o cwd de um " +
        "processo já rodando, então a sessão continua editando onde já estava (o fleet view marca isso como " +
        "'sem isolamento'). É uma superfície de VISIBILIDADE de dívida, não o fluxo normal — para trabalho " +
        "novo em código use claude_new (que já nasce com worktree próprio). Idempotente pelo nome do tmux.",
      inputSchema: {
        sessionName: z.string().describe("nome da sessão tmux (veja claude_sessions)"),
        role: z.enum(["implement", "review", "triage", "steward", "free"]),
        board: z.string().optional(),
        cardId: z.string().optional(),
        task: z.string().optional().describe("o que essa sessão está fazendo"),
      },
    },
    async ({ sessionName, role, board, cardId, task }) => {
      if (!isSafeSessionName(sessionName)) return fail("nome de sessão inválido.");
      const has = await run("tmux", ["has-session", "-t", sessionName], { timeoutMs: 8_000 });
      if (has.code !== 0) return fail(`sessão tmux "${sessionName}" não existe — veja claude_sessions.`);
      const who = currentMcpActor();
      const res = await adoptSession(sessionDeps(), {
        tmuxSession: sessionName,
        role,
        board,
        cardId,
        task,
        actor: who ? `mcp:${who.level}` : undefined,
      });
      if (!res.ok) return fail(res.reason);
      return json({
        ok: true,
        agentId: res.session.agentId,
        adopted: true,
        warning:
          "sessão SEM isolamento (worktree próprio) — ela edita o checkout onde já estava. Dívida visível: " +
          "prefira claude_new para trabalho novo em código.",
      });
    },
  );

  // ===== RUN CHECKS (just allowlist — never deploy/dev) =================

  defineTool(server,
    "run_check",
    {
      title: "Rodar verificação (just)",
      description:
        "Roda um check via `just <target>` — ALLOWLIST: targets que começam com test/validate/lint/typecheck/" +
        "build/ci-test (ex.: test-storymap, validate-all, ci-test). Deploy/dev/orch e shell arbitrário são " +
        "BLOQUEADOS. Retorna exit code + as últimas linhas. (typecheck/build podem competir com o dev server.) " +
        "Uma suíte de verdade leva MINUTOS: passe background:true para receber um `jobId` na hora e depois " +
        "consultar com run_check({jobId}) — é o único caminho que funciona pelo conector remoto, onde o " +
        "intermediário corta a conexão bem antes do fim do teste.",
      inputSchema: {
        target: z.string().optional().describe("alvo just, ex.: test-storymap, validate-all"),
        timeoutSec: z.number().int().positive().max(600).optional().describe("padrão 120, máx 600"),
        background: z
          .boolean()
          .optional()
          .describe("não espera: devolve um jobId na hora (use para suíte/build, que levam minutos)"),
        jobId: z.string().optional().describe("consulta um check iniciado com background:true (em vez de iniciar outro)"),
      },
    },
    async ({ target, timeoutSec, background, jobId }) => {
      // ── consulta de um job em andamento ──
      if (jobId) {
        if (target) return fail("passe `target` (para iniciar) OU `jobId` (para consultar), nunca os dois.");
        const job = getCheckJobs().get(jobId);
        if (!job) return fail(`job "${jobId}" não existe (ou o serviço reiniciou desde que ele começou).`);
        return json({
          jobId,
          target: job.target,
          status: job.status,
          exitCode: job.exitCode ?? null,
          ok: job.status === "done" ? job.exitCode === 0 : undefined,
          startedAt: new Date(job.startedAt).toISOString(),
          durationSec: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
          output: job.out.slice(-60).join("\n").slice(0, 12_000),
          next: job.status === "running" ? "ainda rodando — re-chame run_check({jobId}) daqui a pouco." : undefined,
        });
      }
      if (!target) return fail("passe `target` para iniciar um check, ou `jobId` para consultar um já iniciado.");
      if (!isAllowedCheck(target)) {
        return fail(`Target não permitido: "${target}". Só checks (test*/validate*/lint*/typecheck*/build*/ci-test). Deploy/dev são bloqueados.`);
      }
      // story-frente3 — `just` é ferramenta do HOST, não deste repositório: o justfile do umbrella NÃO
      // viaja na extração. Sem a resolução aqui, um clone recebia um ENOENT cru (ou, no modo background,
      // um job que nasce "running" e morre sem nunca ter começado). A recusa diz o que instalar/declarar.
      const just = resolveHostTool("just");
      if (!just.ok) return fail(`não dá para rodar \`just ${target}\`: ${just.refusal}`);
      const to = Math.min(Math.max(timeoutSec ?? 120, 10), 600) * 1000;

      // ── background: devolve o jobId na hora ──
      // M9 — o modo síncrono segura a conexão pelo tempo INTEIRO do check. Localmente isso só é lento;
      // pelo conector remoto é IMPOSSÍVEL: o intermediário corta muito antes de uma suíte terminar, e o
      // agente ficava sem nenhuma forma de rodar os testes. Mesma coreografia já provada pelo `deploy`
      // (dispara, devolve handle, consulta) — sem tool nova, porque a superfície já é grande demais.
      if (background) {
        const job = startCheckJob(target, just.path);
        return json({
          jobId: job.id,
          target,
          status: "running",
          startedAt: new Date(job.startedAt).toISOString(),
          hint: `consulte com run_check({jobId:"${job.id}"}) — não segure a conexão esperando.`,
        });
      }

      const r = await run(just.path, [target], { timeoutMs: to, maxBuffer: 8_000_000 });
      const tail = `${r.stdout}\n${r.stderr}`.split("\n").filter(Boolean).slice(-60).join("\n");
      return json({ target, exitCode: r.code, ok: r.code === 0, output: tail.slice(0, 12_000) });
    },
  );

  // ===== OPS (Error Reporting / health) =================================
  //
  // `query_errors` e `ops_health` chamam um script que a extração NÃO leva. Sem declaração elas nem
  // chegam a ser registradas: a lista de ferramentas que o adotante vê passa a conter só o que
  // funciona na instalação dele. Ver OPS_REPORT_SCRIPT_ENV em runner/host-tools.ts.
  const opsReport = resolveOpsReportScript();
  if (opsReport.ok) {

  defineTool(server,
    "query_errors",
    {
      title: "Erros de produção",
      description:
        "Consulta os erros de produção pelo script de relatório que ESTA instalação declarou. Filtre por " +
        "SERVIÇO e por janela. " +
        "Os serviços válidos são os deste deployment. Requer ADC auth ativa no servidor.",
      inputSchema: {
        service: z.string().regex(/^[a-z0-9_-]+$/i).optional().describe("nome do serviço"),
        lastHours: z.number().int().positive().max(168).optional().describe("janela em horas, padrão 1"),
      },
    },
    async ({ service, lastHours }) => {
      const args = [opsReport.script, "--json"];
      if (service) args.push("--service", service);
      args.push("--last", `${lastHours ?? 1}h`);
      const r = await run(process.execPath, args, { timeoutMs: 60_000, maxBuffer: 8_000_000 });
      const raw = r.stdout || r.stderr;
      try {
        return json({ exitCode: r.code, errors: JSON.parse(raw) });
      } catch {
        return json({ exitCode: r.code, output: raw.slice(0, 12_000) });
      }
    },
  );

  defineTool(server,
    "ops_health",
    {
      title: "Saúde de produção",
      description:
        "Health check de ops (autenticação do provedor + contagem de erros por serviço) via o script de " +
        "relatório declarado por esta instalação, com --health.",
      inputSchema: {},
    },
    async () => {
      const r = await run(process.execPath, [opsReport.script, "--health"], { timeoutMs: 60_000, maxBuffer: 8_000_000 });
      return text((r.stdout || r.stderr).slice(0, 12_000));
    },
  );

  }

  defineTool(server,
    "service_health",
    {
      title: "Saúde do serviço AgileHarness",
      description:
        "Verifica a saúde desta instalação: um GET HTTP via node fetch (NUNCA curl — curl dispara WAF de " +
        "CDN) na porta local do serviço e, QUANDO esta instalação declarou uma unidade de serviço, o " +
        "systemctl is-active dela. Retorna o estado do supervisor (ou null quando não há unidade " +
        "declarada), status/latência do HTTP e um veredito healthy. Use pra confirmar que o serviço subiu " +
        "após um restart.",
      inputSchema: {
        port: z.number().int().positive().max(65535).optional().describe("porta HTTP local (padrão: a do serviço)"),
      },
    },
    async ({ port }) => {
      const p = port ?? resolveServiceProbePort();
      // A unidade é DECLARADA ou não existe: perguntar ao systemd por um nome fixo produzia, na máquina
      // do adotante, um "inactive" sobre uma unidade que nunca existiu — um veredito falso, não um erro.
      const unit = resolveServiceUnit();
      const systemd = unit
        ? ((await run("systemctl", ["is-active", unit], { timeoutMs: 10_000 })).stdout.trim() || "desconhecido")
        : null;
      // node fetch (global em Node 18+), localhost direto — não passa pelo Cloudflare/WAF.
      const started = Date.now();
      let http: { ok: boolean; status: number | null; latencyMs: number | null; error?: string };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(`http://127.0.0.1:${p}/`, { signal: controller.signal, redirect: "manual" });
        clearTimeout(timer);
        http = { ok: res.status < 500, status: res.status, latencyMs: Date.now() - started };
      } catch (e) {
        http = { ok: false, status: null, latencyMs: null, error: e instanceof Error ? e.message : String(e) };
      }
      // Sem unidade declarada o veredito é o do HTTP — que é o que o operador de fato consegue observar.
      return json({ unit, port: p, systemd, http, healthy: (unit ? systemd === "active" : true) && http.ok });
    },
  );

  // ===== DEPLOY (production — guarded + async) ==========================
  //
  // POR QUE `z.string()` E NÃO `z.enum` (a troca que esta seção sofreu). O `pkg` era um `z.enum` sobre uma
  // lista literal no fonte do motor, e um `z.enum` viaja LITERALMENTE dentro do `tools/list` — o catálogo
  // de apps de um deployment era, portanto, parte do contrato publicado do protocolo. Três razões para o
  // enum não voltar de outra forma:
  //   1. O conjunto agora é DADO, e pode ser vazio. `z.enum([])` é inválido em zod e o schema é construído
  //      em tempo de REGISTRO — um alvo sem alvos declarados derrubaria a superfície MCP inteira, não só
  //      estas três tools.
  //   2. O registro roda UMA vez por credencial e o handler fica cacheado pela vida do processo. Um enum
  //      construído ali congela: declarar um alvo novo no settings.yaml só valeria depois de reiniciar.
  //   3. É a forma que `board` já usa nesta mesma superfície — `z.string()` + validação no handler +
  //      recusa que ENUMERA o que é válido. Um segundo padrão para o mesmo problema seria dívida.
  //
  // O CUSTO, ESCRITO: o cliente perde o enum como DESCOBERTA. A recusa abaixo é o que devolve isso — ela
  // lista os alvos válidos, então uma primeira chamada errada ensina a segunda.

  /**
   * A peneira de `pkg` das tools que EXECUTAM algo com ele. Devolve a recusa (com os alvos válidos) ou
   * null quando o alvo é declarado.
   *
   * ⚠️ ELA SUBSTITUI UMA BARREIRA QUE EXISTIA POR ACIDENTE. Enquanto `pkg` era `z.enum`, o SDK recusava
   * qualquer coisa fora da lista ANTES do handler — e era só isso que impedia um `pkg` com `../` de
   * atravessar `logFileFor()` (que interpola o valor num caminho) e de virar argumento de `just`. Sem o
   * enum, essa recusa é nossa. A lista contra a qual comparamos já passou pela peneira de FORMA do
   * carregador de settings, então só slug entra aqui — e por isso enumerá-la na mensagem de erro (texto
   * que o modelo do outro lado lê) não reintroduz o risco de instrução injetada.
   */
  const recusaDeAlvoDeDeploy = (pkg: string) => {
    const alvos = productDeployTargets();
    if (alvos.includes(pkg)) return null;
    if (alvos.length === 0) {
      return fail(
        "Este alvo não declara nenhum app deployável por esta via (settings.yaml → deploy.targets está " +
          "ausente ou vazio). Publique declarando `deploy:` no board.yaml do board (kind: command|agent), " +
          "que é o caminho por descritor.",
      );
    }
    return fail(`Alvo de deploy desconhecido: "${pkg}". Os alvos declarados por este alvo são: ${alvos.join(", ")}.`);
  };

  defineTool(server,
    "deploy_plan",
    {
      title: "Plano de deploy (dry-run)",
      description:
        "Mostra o que um deploy faria (just orch-plan <pkg>) — READ-ONLY, sem efeito. Use ANTES de deploy para " +
        "revisar as unidades com drift. Os alvos válidos são os que ESTE alvo declara; um `pkg` inválido " +
        "devolve a lista deles na recusa.",
      inputSchema: { pkg: z.string().describe("id do alvo deployável declarado por este alvo") },
    },
    async ({ pkg }) => {
      const recusa = recusaDeAlvoDeDeploy(pkg);
      if (recusa) return recusa;
      const just = resolveHostTool("just");
      if (!just.ok) return fail(`não dá para montar o plano: ${just.refusal}`);
      const r = await run(just.path, ["orch-plan", pkg], { timeoutMs: 120_000, maxBuffer: 8_000_000 });
      // WS-11.1: attach the SCOPED risk (what ACTUALLY enters this deploy) so the operator reads "2 commits
      // entram", not the misleading monorepo-wide "119 de backlog" that framed the incident's deploy question.
      // Best-effort — a git hiccup just omits the summary; never blocks the plan.
      let risk: Awaited<ReturnType<typeof deployRiskSummary>> | null = null;
      try {
        risk = await deployRiskSummary(defaultExec, findRepoRoot(), pkg);
      } catch {
        /* best-effort */
      }
      return json({ pkg, exitCode: r.code, plan: (r.stdout || r.stderr).slice(0, 14_000), risk });
    },
  );

  defineTool(server,
    "deploy",
    {
      title: "Deploy em PRODUÇÃO",
      description:
        "Faz deploy de um pacote para PRODUÇÃO (just --yes orch-deploy <pkg>). IRREVERSÍVEL na prática. GUARD: " +
        "confirm precisa ser EXATAMENTE o nome do pacote. Roda em background (deploys levam minutos) — acompanhe " +
        "com deploy_status. Rode deploy_plan antes para revisar.",
      inputSchema: {
        pkg: z.string().describe("id do alvo deployável declarado por este alvo"),
        confirm: z.string().describe("repita o nome do pacote para confirmar o deploy em produção"),
      },
    },
    async ({ pkg, confirm }) => {
      // A RECUSA VEM PRIMEIRO, antes do guard de confirmação — e a ordem não é estética. `pkg` entra num
      // argv de `just` e num nome de arquivo de log; enquanto era `z.enum`, o SDK recusava o inválido antes
      // do handler. Trocado por `z.string()`, essa recusa passou a ser NOSSA, e ela tem de acontecer antes
      // de qualquer uso do valor.
      const recusa = recusaDeAlvoDeDeploy(pkg);
      if (recusa) return recusa;
      if (confirm !== pkg) {
        return fail(`Confirmação obrigatória: passe confirm exatamente igual a "${pkg}" para deployar em PRODUÇÃO.`);
      }
      const reg = getProductDeploy();
      if (reg.isRunning(pkg)) return fail(`Já há um deploy de ${pkg} em andamento — veja deploy_status.`);
      const job = reg.start(pkg);
      return json({
        ok: true,
        deploying: pkg,
        status: "running",
        pid: job.pid,
        startedAt: job.startedAt,
        hint: "Acompanhe com deploy_status (o deploy roda em background, leva minutos).",
        // WS-10.3: torna o footgun VISÍVEL no ponto de uso. Esta tool crua roda `orch-deploy` SEM
        // `promoteStageToMain` e SEM o face-chain (mosaico.app/...). Para PUBLICAR UM CARD do AgileHarness, o
        // caminho correto é o pipeline (move_card → step `deploy` = promote-and-deploy + face-chain); use
        // esta tool crua SÓ para deploy de infra fora de card.
        pipelineNote:
          "⚠️ Deploy de um CARD deve ir pelo PIPELINE (move_card → step `deploy`), que promove stage→main e " +
          "encadeia a face — esta tool crua PULA os dois. Use-a só para infra fora de card.",
      });
    },
  );

  defineTool(server,
    "deploy_status",
    {
      title: "Status do deploy",
      description: "Estado do deploy em andamento/recente (running/done/failed) + as últimas linhas do log.",
      inputSchema: { pkg: z.string().optional().describe("id do alvo; omita para o mais recente") },
    },
    async ({ pkg }) => {
      const reg = getProductDeploy();
      // Sem peneira aqui, de propósito: `pkg` só chega a `Map.get` (não a um argv nem a um caminho), e o
      // job de uma SUPERFÍCIE COMPOSTA tem chave que não está em `deploy.targets` — recusá-la esconderia
      // justamente o status que o operador mais precisa ver quando a face falha.
      const job = pkg ? reg.get(pkg) : reg.latest();
      if (!job) return json({ message: "Nenhum deploy registrado nesta sessão do servidor." });
      return json({
        pkg: job.pkg,
        status: job.status,
        exitCode: job.exitCode ?? null,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? null,
        durationSec: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
        log: await reg.tail(job, 80),
      });
    },
  );

  // ===== SELF-UPDATE DA MÁQUINA (o script DECLARADO — async) ============
  // O nome do unit transiente é NOSSO (nós o criamos e o coletamos), então ele é constante de propósito:
  // fixo ⇒ idempotente (um segundo update enquanto o primeiro roda é no-op), igual ao DEPLOY_UNIT.

  defineTool(server,
    "update_vps",
    {
      title: "Atualizar esta máquina (o script DECLARADO)",
      // O nome da variável entra LITERAL na description abaixo: a superfície de instrução é PINADA
      // (story-j23byv) — uma description montada a partir de constante importada deixa de ser legível
      // estaticamente, e o pino existe para que ninguém precise executar o servidor para saber o que o
      // cliente recebe.
      description:
        "Roda o script de auto-atualização que ESTA instalação declarou em `AGILEHARNESS_UPDATE_SCRIPT` " +
        "(tipicamente git pull --ff-only + instalar dependências + build + restart). Roda em BACKGROUND via " +
        "systemd-run (sobrevive ao restart do próprio serviço). Acompanhe com update_status. Use depois de um " +
        "git_commit_push (ou de pushar de outro checkout). Sem declaração a tool RECUSA — nada é executado.",
      inputSchema: {},
    },
    async () => {
      // story-frente3 — o script vem da DECLARAÇÃO, nunca de um caminho cravado. Esta tool executa como
      // ROOT e um agente autônomo pode chamá-la sozinho: um default (`/root/update.sh`) seria a aposta de
      // que o arquivo naquele caminho, na máquina de QUEM CLONOU, faz o que o nome sugere.
      const decl = resolveUpdateScript();
      if (!decl.ok) return fail(decl.refusal);
      await run("systemctl", ["reset-failed", UPDATE_UNIT], { timeoutMs: 10_000 });
      const r = await run(
        "systemd-run",
        ["--collect", "--unit", UPDATE_UNIT, ...decl.argv],
        { timeoutMs: 15_000 },
      );
      if (r.code !== 0) return fail(`falha ao iniciar update: ${(r.stderr || r.stdout).slice(0, 400)}`);
      return json({ ok: true, status: "iniciado", script: decl.script, hint: "Acompanhe com update_status — roda em background e reinicia o serviço." });
    },
  );

  defineTool(server,
    "update_status",
    {
      title: "Status do update da VPS",
      description: "Estado do último update_vps (ativo/concluído) + as últimas linhas do log.",
      inputSchema: { lines: z.number().int().positive().max(300).optional().describe("padrão 60") },
    },
    async ({ lines }) => {
      const active = await run("systemctl", ["is-active", UPDATE_UNIT], { timeoutMs: 10_000 });
      // story-frente3 — o arquivo de log também era um endereço desta caixa (`/var/log/storymap-update.log`).
      // Ele é do SCRIPT, não do motor: quem escreve o log é o script declarado, então só quem o declara sabe
      // para onde ele escreve. Sem declaração dizemos isso — em vez de mostrar "(sem log ainda)" para um
      // arquivo que nunca vai existir naquela máquina, que se lê como "o update não começou".
      const logPath = resolveUpdateLog();
      let log = logPath ? "(sem log ainda)" : `(nenhum log declarado — aponte ${UPDATE_LOG_ENV} para o arquivo em que o seu script escreve)`;
      if (logPath) {
        try {
          const c = await fs.readFile(logPath, "utf8");
          log = c.split("\n").slice(-(lines ?? 60)).join("\n");
        } catch {
          /* sem log */
        }
      }
      return json({
        unit: UPDATE_UNIT,
        logPath,
        state: active.stdout.trim() || active.stderr.trim() || "desconhecido",
        log: log.slice(-12_000),
      });
    },
  );

  // ===== GIT (commit + push — write, guarded) ===========================

  defineTool(server,
    "git_commit_push",
    {
      title: "Commit + push (GitHub)",
      description:
        "Faz stage de tudo (git add -A), commita com a mensagem e dá push. Por padrão pusha a branch ATUAL; " +
        "push pra 'main' exige confirmMain:true. Use pra publicar o trabalho feito na VPS. Siga Conventional Commits. " +
        "RESILIENTE: numa rejeição non-fast-forward (origin avançou — autorun/outro checkout) RECONCILIA " +
        "(fetch + merge FETCH_HEAD, paths disjuntos, NUNCA --force) e re-tenta o push UMA vez.",
      inputSchema: {
        message: z.string().min(3).describe("mensagem (Conventional Commits, ex.: 'fix(storymap): ...')"),
        branch: z.string().optional().describe("branch destino (padrão: atual)"),
        confirmMain: z.boolean().optional().describe("precisa ser true se a branch for main"),
      },
    },
    async ({ message, branch, confirmMain }) => {
      const cur = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
      const target = (branch || cur.stdout.trim()).trim();
      if (!isSafeRef(target)) return fail("branch inválida.");
      if (target === "main" && confirmMain !== true) {
        return fail("Push pra main exige confirmMain:true (proteção). Ou passe uma branch.");
      }
      const add = await run("git", ["add", "-A"], { timeoutMs: 30_000 });
      if (add.code !== 0) return fail(`git add falhou: ${add.stderr.slice(0, 300)}`);
      const commit = await run("git", ["commit", "-m", message], { timeoutMs: 30_000 });
      if (commit.code !== 0) {
        const out = commit.stdout + commit.stderr;
        if (/nothing to commit/i.test(out)) return json({ ok: false, note: "nada para commitar (working tree limpo)" });
        return fail(`git commit falhou: ${out.slice(0, 400)}`);
      }
      let push = await run("git", ["push", "origin", `HEAD:${target}`], { timeoutMs: 90_000 });
      let reconciled = false;
      if (
        push.code !== 0 &&
        /non-fast-forward|fetch first|\brejected\b|tip of your current branch is behind/i.test(push.stdout + push.stderr)
      ) {
        // #39 resilient push: origin advanced under us (autorun / another checkout pushed). Reconcile
        // the disjoint paths (fetch + merge FETCH_HEAD, NEVER --force) and retry the push ONCE.
        reconciled = await reconcileBranch(target);
        if (reconciled) push = await run("git", ["push", "origin", `HEAD:${target}`], { timeoutMs: 90_000 });
      }
      if (push.code !== 0) {
        return fail(`git push falhou${reconciled ? " (mesmo após reconciliar com origin)" : ""}: ${(push.stdout + push.stderr).slice(0, 500)}`);
      }
      return json({
        ok: true,
        branch: target,
        reconciled,
        commit: commit.stdout.split("\n").filter(Boolean)[0] ?? "(ok)",
        push: (push.stdout + push.stderr).split("\n").filter(Boolean).slice(-3).join("\n"),
      });
    },
  );

  // ===== GIT SYNC (fetch + ff/reconcile — write, guarded) ==============

  defineTool(server,
    "sync_repo",
    {
      title: "Sincronizar checkout com origin",
      description:
        "Traz o checkout para origin: fetch + reporta ahead/behind, depois tenta fast-forward; numa " +
        "divergência non-ff RECONCILIA (fetch + merge FETCH_HEAD — board(main)⊕código(stage) tocam paths " +
        "disjuntos → limpo) em vez de ficar pra trás. NUNCA --force, NUNCA rebase. Conflito real → aborta " +
        "(tree intacta) e devolve action:'diverged' pra você resolver. Use ANTES de editar/commitar — o " +
        "autorun pusha direto, então o checkout fica atrás rápido.",
      inputSchema: {
        branch: z.string().optional().describe("branch a sincronizar (padrão: a atual)"),
      },
    },
    async ({ branch }) => {
      const cur = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
      const target = (branch || cur.stdout.trim()).trim();
      if (!isSafeRef(target)) return fail("branch inválida.");
      const fetched = await run("git", ["fetch", "origin", target], { timeoutMs: 60_000 });
      if (fetched.code !== 0) return fail(`git fetch falhou: ${(fetched.stderr || fetched.stdout).slice(0, 300)}`);
      // left = commits em origin/<target> ausentes no HEAD (behind); right = HEAD ausentes em origin (ahead).
      const counts = await run("git", ["rev-list", "--left-right", "--count", `origin/${target}...HEAD`], { timeoutMs: 15_000 });
      const [behindStr, aheadStr] = counts.stdout.trim().split(/\s+/);
      const behind = Number(behindStr) || 0;
      const ahead = Number(aheadStr) || 0;
      if (behind === 0) {
        return json({ ok: true, branch: target, ahead, behind, action: "already-current" });
      }
      // Fast-forward first (clean when local has no divergent commits on this branch).
      const ff = await run("git", ["merge", "--ff-only", `origin/${target}`], { timeoutMs: 30_000 });
      if (ff.code === 0) {
        return json({ ok: true, branch: target, ahead, behind, action: "fast-forwarded" });
      }
      // Non-ff (local diverged): reconcile by merge of disjoint paths.
      const ok = await reconcileBranch(target);
      return json({
        ok,
        branch: target,
        ahead,
        behind,
        action: ok ? "reconciled-merge" : "diverged",
        ...(ok ? {} : { note: "conflito real — merge abortado, tree intacta; resolva na mão (resolve_merge/terminal)" }),
      });
    },
  );

  // ===== STAGE RECONCILE (the release branch — write, guarded) =========
  // sync_repo reconciles the live checkout (main); this reconciles the `stage` branch worktree
  // (`<repo>-stage`) where the merge train holds unreleased code. When `stage` drifts STALE behind
  // main (e.g. a card's code landed direct-on-main → stage's unique commits are SUPERSEDED), every
  // release becomes a fail-clean no-op and the cascade can't promote. This is the chat-side cure for
  // that, mirroring the engine's syncStageWithReleased: SAFE by default, with an explicit destructive
  // reset for the supersed case. (#edk504 item 2)

  defineTool(server,
    "reconcile_stage",
    {
      title: "Reconciliar a branch stage (release)",
      description:
        "Reconcilia o worktree LOCAL da branch `stage` (onde o merge train segura o código não-liberado) " +
        "com a released branch (main) DESTA VPS — sync_repo cuida do checkout/main, este cuida do stage. " +
        "Use quando os releases viram no-op (stage preso defasado da main). Modo padrão SEGURO ('sync'): se " +
        "o stage não tem código além da main, fast-forward; se tem código não-liberado, traz o avanço da main " +
        "por merge 3-way PRESERVANDO-O; um conflito REAL aborta (stage intacto) e devolve action:'diverged'. " +
        "Modo 'reset' (DESTRUTIVO, exige confirmReset:true): `reset --hard main` cego, DESCARTA os commits " +
        "únicos do stage — só quando você SABE que o código do stage já está na main (card já liberado/superado).",
      inputSchema: {
        mode: z.enum(["sync", "reset"]).optional().describe("padrão 'sync' (seguro). 'reset' = reset --hard main, destrutivo"),
        confirmReset: z.boolean().optional().describe("precisa ser true quando mode='reset'"),
      },
    },
    async ({ mode, confirmReset }) => {
      // A classe de risco é por TOOL, mas as duas MODALIDADES desta não têm o mesmo risco: `sync` é seguro e
      // idempotente (ff, ou merge 3-way que PRESERVA o não-liberado, ou aborta limpo); `reset` é um
      // `reset --hard` cego que DESCARTA os commits únicos do stage. Sob um escopo repo declarado
      // `merge-resolve: auto` (settings.yaml), a matriz concederia a modalidade DESTRUTIVA de carona com a
      // segura — nada impediria um agente de passar mode:'reset'+confirmReset:true. O corte fica aqui, onde a
      // diferença é visível: descartar código não-liberado é decisão do OPERADOR (token `full`), sempre.
      if (mode === "reset" && isScopedActor()) {
        return fail(
          "mode='reset' DESCARTA os commits não-liberados do stage — é irreversível e só o operador (token " +
            "full) pode executá-lo. Use mode='sync' (seguro: preserva o não-liberado); se o sync devolver " +
            "action:'diverged', escale ao operador com o motivo.",
        );
      }
      const staging = loadRunnerConfig().autorun.staging;
      if (!staging?.enabled || !staging.branch) {
        return fail("staging está desabilitado (autorun.staging.enabled=false) — não há branch stage para reconciliar.");
      }
      const stageBranch = staging.branch;
      if (!isSafeRef(stageBranch)) return fail("branch stage inválida.");
      const stagePath = stageWorktreePath(findRepoRoot(), stageBranch);

      // The stage worktree must already exist (the merge train creates it on the first code run). Don't
      // create it here — nothing to reconcile if it was never staged.
      const wl = await run("git", ["worktree", "list", "--porcelain"], { timeoutMs: 15_000 });
      if (wl.code !== 0) return fail(`git worktree list falhou: ${wl.stderr.slice(0, 300)}`);
      if (!wl.stdout.includes(stagePath)) {
        return fail(`worktree do stage não existe em ${stagePath} (o merge train ainda não o criou). Nada a reconciliar.`);
      }

      // released branch = the branch the live checkout has out (main).
      const cur = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
      const released = cur.stdout.trim() || "main";
      if (!isSafeRef(released)) return fail("released branch inválida.");

      // git inside the stage worktree (-C). shell:false array args (run) — no injection.
      const gitS = (args: string[], timeoutMs = 30_000) => run("git", ["-C", stagePath, ...args], { timeoutMs });

      // Discard any uncommitted partial from a crashed apply first (committed staged code is kept).
      await gitS(["reset", "--hard", "HEAD"], 15_000);

      // unreleased = commits on stage not yet on the released branch (the "genuine unreleased code").
      const aheadR = await gitS(["rev-list", "--count", `${released}..${stageBranch}`], 15_000);
      const unreleased = Number(aheadR.stdout.trim()) || 0;

      if (mode === "reset") {
        if (confirmReset !== true) {
          return fail(
            `mode='reset' é DESTRUTIVO (descarta ${unreleased} commit(s) único(s) do stage) — passe confirmReset:true para confirmar.`,
          );
        }
        const reset = await gitS(["reset", "--hard", released], 30_000);
        if (reset.code !== 0) return fail(`reset --hard ${released} falhou: ${reset.stderr.slice(0, 300)}`);
        return json({ ok: true, stageBranch, released, action: "reset-hard", discardedCommits: unreleased });
      }

      // mode = sync (default, SAFE) — mirrors syncStageWithReleased (merge-queue.ts).
      const isAncestor = await gitS(["merge-base", "--is-ancestor", stageBranch, released], 15_000);
      if (isAncestor.code === 0) {
        // stage ⊆ released → no unreleased code on top; fast-forward to the released tip (nothing to lose).
        const reset = await gitS(["reset", "--hard", released], 30_000);
        if (reset.code !== 0) return fail(`fast-forward (reset --hard ${released}) falhou: ${reset.stderr.slice(0, 300)}`);
        return json({ ok: true, stageBranch, released, action: "fast-forwarded", unreleasedCommits: 0 });
      }
      // stage carries unreleased code → bring the released branch's advances in (3-way), preserving it.
      const merged = await gitS(["merge", "--no-edit", released], 30_000);
      if (merged.code === 0) {
        return json({ ok: true, stageBranch, released, action: "merged", unreleasedCommits: unreleased });
      }
      await gitS(["merge", "--abort"], 15_000); // genuine overlap → leave stage clean, never clobber
      return json({
        ok: false,
        stageBranch,
        released,
        action: "diverged",
        unreleasedCommits: unreleased,
        note:
          `o código não-liberado do stage conflita REALMENTE com ${released} — merge abortado, stage intacto. ` +
          `Se você SABE que o código do stage já está em ${released} (card liberado/superado), rode de novo com mode:'reset', confirmReset:true.`,
      });
    },
  );

  // ===== CLAUDE INSTANCES (tmux sessions on the VPS) ====================
  // Control the Claude Code instances running on the box from the phone-side MCP.
  // Everything goes through tmux (sessions survive SSH disconnects). These deliberately
  // do NOT touch the storymap service (systemd, not tmux) nor kill PIDs directly — the
  // autorun's headless `claude -p` children aren't tmux sessions, so claude_kill can't
  // reach them. All args go through execFile arrays (shell:false) — no injection.

  defineTool(server,
    "claude_sessions",
    {
      title: "Listar instâncias Claude (VPS)",
      description:
        "Lista as sessões tmux (Claude interativos/persistentes na máquina) + os processos `claude` rodando " +
        "(inclui os runs headless do autorun). Comece por aqui antes de mandar mensagem, capturar ou matar. " +
        "Cada sessão traz `waitingForHuman`: não-nulo = ela está PARADA esperando o operador (`asking` = num " +
        "prompt, travando trabalho; `idle` = terminou/espera instrução), com há quanto tempo e a pergunta lida " +
        "da tela. Responder por ele NÃO é seu papel (prompt de terminal é humano em qualquer modo) — AVISAR é.",
      inputSchema: {},
    },
    async () => {
      // F8 — `listSessions()` (o primitivo que /processes já usa) no lugar do parse próprio que esta tool
      // mantinha. Ele traz `path` e `createdAt` DO PRÓPRIO TMUX, e é isso que cura o buraco: o cwd/idade
      // de um terminal `cop-*` vivia só no Map em memória, então um restart do serviço apagava o retrato
      // de sessões que CONTINUAVAM existindo no tmux. Duas leituras do mesmo `list-sessions` também eram
      // duas verdades — a régua da casa é um primitivo, não um por consumidor.
      const rows = await listSessions();
      // O MESMO primitivo que a página /processes usa (identidade pelo `comm`, não `grep` na linha de
      // comando). O filtro antigo — `/\bclaude\b/` sobre a linha inteira — listava o `bash` que apenas
      // MENCIONA claude nos args e todo Bash tool call que carrega `/root/.claude/…` no path, ou seja,
      // a própria sessão que estava perguntando. Ver lib/vps/process-attribution.ts.
      const claudeProcs = (await listClaudeProcesses())
        .map((p) => `${p.pid}\t${p.etime}\t${p.args}`)
        .slice(0, 40);
      const meta = getSessionMetaMap();

      // WS-6.3 — this poll IS the fleet's life sign. Renew the heartbeat of every registered agent whose tmux
      // is still up (without it a working agent that simply hasn't called a tool in hours would "die" on paper
      // and have its tree reaped — G7), and release the claims of the ones whose tmux vanished, with the
      // named reason `session-died`, so their cards free up NOW instead of waiting out the claim TTL.
      // Best-effort: a registry hiccup must never break the listing the operator is asking for.
      let fleetDied: FleetReconcileResult["died"] = [];
      let fleet: Awaited<ReturnType<typeof allSessions>> = [];
      try {
        fleetDied = (await reconcileFleetNow()).died;
        fleet = await allSessions();
      } catch (err) {
        console.warn("[mcp] reconcileFleet falhou (não-fatal):", err instanceof Error ? err.message : err);
      }
      const byTmux = new Map(fleet.filter((f) => f.tmuxSession).map((f) => [f.tmuxSession!, f]));
      // Quem está ESPERANDO O OPERADOR (vigia de terminais). Sem isto, "listar as sessões" respondia
      // quantas existem e não a única pergunta que importa numa: alguma está travada num prompt? Leitura de
      // memória — o vigia já mantém o retrato, então isto não custa nem uma captura de tela.
      const attentionBySession = new Map(currentTerminalAttention().map((t) => [t.session, t]));
      const now = Date.now();

      const tmuxSessions = await Promise.all(
        rows.map(async (row) => {
          const m = meta.get(row.name);
          const agent = byTmux.get(row.name);
          const waiting = attentionBySession.get(row.name);
          // The durable registry wins over the in-memory map: it survives the restarts the map does not.
          const transcript = agent?.transcriptFile ?? m?.transcriptFile;
          // Precedência: registro DURÁVEL da frota → Map em memória → o TMUX. O último é o que faz um
          // `cop-*` sobreviver a um restart do serviço com cwd e idade intactos (o tmux nunca esqueceu).
          const cwd = agent?.cwd ?? m?.cwd ?? row.path ?? null;
          // A MESMA leitura do medidor dos terminais: o `computeContextPct` legado fixa a janela em 200k
          // e clampa em 100%, então toda sessão de 1M chegava aqui como "100% · recicle" — o conselho
          // exatamente invertido para uma sessão com 800k de folga.
          const contextPct = transcript
            ? await readSessionContext(transcript, agent?.model, cwd).then((c) => c?.pct ?? null)
            : null;
          return {
            name: row.name,
            windows: row.windows,
            attached: row.attached,
            cwd,
            createdAt: m?.createdAt ?? row.createdAt ?? null,
            contextPct,
            suggestRecycle: suggestRecycle(contextPct),
            // `asking` TRAVA trabalho (ninguém anda até o humano responder); `idle` é "acabou / espera
            // instrução". Você NÃO responde por ele — um prompt de terminal é humano em qualquer modo —,
            // mas é seu papel AVISAR o operador de que esta sessão está parada esperando.
            waitingForHuman: waiting
              ? {
                  kind: waiting.kind,
                  since: waiting.since,
                  waitedFor: waitedFor(waiting.since, now),
                  question: waiting.question ?? null,
                }
              : null,
            // WS-6.1/6.4 — the fleet identity of this session, when it has one.
            agent: agent
              ? {
                  agentId: agent.agentId,
                  role: agent.role,
                  board: agent.board ?? null,
                  cardId: agent.cardId ?? null,
                  task: agent.task,
                  branch: agent.branch ?? null,
                  worktree: agent.worktreePath ?? null,
                  model: agent.model ?? null,
                  spawnedBy: agent.spawnedBy ?? null,
                  heartbeatAt: agent.heartbeatAt,
                  // Adoption = the session edits some checkout we do not control. Surface it as a WARNING so
                  // the pattern gets extinguished, not normalised (WS-6.2).
                  warning: agent.adopted ? "SEM ISOLAMENTO — sessão adotada, edita fora de um worktree próprio" : null,
                }
              : null,
          };
        }),
      );
      return json({
        tmuxSessions: tmuxSessions.length ? tmuxSessions : "(nenhuma sessão tmux / tmux indisponível)",
        claudeProcesses: claudeProcs.length ? claudeProcs : "(nenhum processo claude)",
        ...(fleetDied.length
          ? {
              fleetDied: fleetDied.map((d) => ({
                agentId: d.agentId,
                tmuxSession: d.tmuxSession,
                claimsReleased: d.claimsReleased,
                nota: "tmux sumiu → claims liberados (session-died); o worktree segue preservado se tinha código não-integrado",
              })),
            }
          : {}),
      });
    },
  );

  defineTool(server,
    "wait_for_session_idle",
    {
      title: "Aguardar uma sessão Claude ficar ociosa",
      description:
        "BLOQUEIA até a sessão tmux PARAR de mudar a tela por `idleMs` (= o Claude terminou de responder) — " +
        "em vez de capturar a tela repetidamente à espera. Devolve {state}: 'idle' (parou de responder), " +
        "'timeout' (ainda ativa — apenas re-chame para continuar esperando) ou 'unknown' (não deu pra ler a " +
        "tela / tmux indisponível). Proxy por estabilidade de tela (capture-pane); passe a sessão (veja claude_sessions). " +
        "Quando devolve 'idle', devolve TAMBÉM o `motivo`: 'terminou' (acabou a resposta), 'aguardando-humano' " +
        "(PAROU num prompt — mandar a próxima instrução não adianta, ela nem é lida) ou 'sem-evidencia' (o vigia " +
        "não estava olhando esta sessão — não presuma que terminou).",
      inputSchema: {
        session: z.string().describe("nome da sessão tmux (veja claude_sessions)"),
        idleMs: z
          .number()
          .int()
          .positive()
          .max(120000)
          .optional()
          .describe("silêncio de tela (ms) para considerar ociosa (padrão 4000)"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600000)
          .optional()
          .describe("teto de espera antes de devolver 'timeout' (padrão 120000, máx 600000)"),
      },
    },
    async ({ session, idleMs, timeoutMs }) => {
      if (!isSafeSessionName(session)) return fail("nome de sessão inválido (use [A-Za-z0-9_-]).");
      const sample = async (): Promise<string | null> => {
        const r = await run("tmux", ["capture-pane", "-p", "-t", session], { timeoutMs: 10_000 });
        return r.code === 0 ? r.stdout : null; // null ⇒ sessão sumiu / tmux indisponível → 'unknown'
      };
      const result = await waitForIdleCore(
        { sample, sleep: (ms) => new Promise((res) => setTimeout(res, ms)), now: () => Date.now() },
        {
          idleMs: Math.min(idleMs ?? 4000, 120000),
          timeoutMs: Math.min(timeoutMs ?? 120000, 600000),
          pollMs: 1500,
        },
      );
      // F4 — 'idle' de TELA é ambíguo: cobre "terminou de responder" E "parou num prompt esperando o
      // humano". Um orquestrador que lesse só `state` concluiria "pronto" e mandaria a instrução seguinte
      // para uma sessão travada, que não a lê. O vigia de terminais JÁ mantém a distinção em memória
      // (custo zero, sem captura nova) — o que faltava era ligá-la aqui. `sem-evidencia` é deliberado:
      // o vigia tem teto de sessões observadas, e ausência de evidência não é prova de que terminou.
      const waiting = result.state === "idle" ? currentTerminalAttention().find((t) => t.session === session) : undefined;
      const motivo =
        result.state !== "idle"
          ? undefined
          : !waiting
            ? "sem-evidencia"
            : waiting.kind === "asking"
              ? "aguardando-humano"
              : "terminou";
      return json({
        session,
        ...result,
        ...(motivo ? { motivo } : {}),
        ...(waiting
          ? {
              waitingForHuman: {
                kind: waiting.kind,
                since: waiting.since,
                waitedFor: waitedFor(waiting.since, Date.now()),
                question: waiting.question ?? null,
              },
            }
          : {}),
        ...(motivo === "aguardando-humano"
          ? {
              next:
                "ela está PARADA num prompt: responder por ela NÃO é seu papel (prompt de terminal é humano em " +
                "qualquer modo) — avise o operador. Mandar a próxima instrução agora não avança nada.",
            }
          : {}),
      });
    },
  );

  defineTool(server,
    "claude_capture",
    {
      title: "Ler a tela de uma sessão Claude",
      description:
        "Captura o conteúdo atual do terminal de uma sessão tmux (capture-pane) — use para ver o estado ou a " +
        "resposta do Claude. `lines` puxa N linhas de histórico (padrão: só a tela visível). Após um claude_send, " +
        "dê alguns segundos antes de capturar.",
      inputSchema: {
        session: z.string().describe("nome da sessão tmux (veja claude_sessions)"),
        lines: z.number().int().positive().max(2000).optional().describe("linhas de scrollback"),
      },
    },
    async ({ session, lines }) => {
      if (!isSafeSessionName(session)) return fail("nome de sessão inválido (use [A-Za-z0-9_-]).");
      const args = ["capture-pane", "-p", "-t", session];
      if (lines) args.push("-S", `-${lines}`);
      const r = await run("tmux", args, { timeoutMs: 10_000 });
      if (r.code !== 0) return fail(r.stderr.trim() || `sessão "${session}" não encontrada`);
      return text(r.stdout.slice(-40_000) || "(tela vazia)");
    },
  );

  // M3/M6 — LER A CONVERSA, não a tela. `claude_capture` devolve até 40k chars de terminal cru (~10k
  // tokens) por olhada, e a tela é o meio errado: tem wrap, scrollback, spinner e caixa de status, então
  // a mesma resposta lida duas vezes não é o mesmo texto. O transcript é a fonte que o próprio CLI grava
  // e já estava no disco — a frota só o usava para calcular % de contexto. Medido num transcript real de
  // 1994 linhas: 1196 chars devolvidos contra 40000 da tela.
  defineTool(server,
    "session_read",
    {
      title: "Ler a conversa de uma sessão (barato)",
      description:
        "Devolve os últimos TURNOS de conversa de uma sessão Claude — lidos do transcript do próprio CLI, " +
        "não da tela. Muito mais barato e estável que claude_capture (sem wrap/scrollback/spinner) e sem o " +
        "raciocínio interno nem o corpo das tool calls (só os NOMES das tools que ela chamou). Devolve um " +
        "`cursor`: passe-o como `sinceLine` na próxima chamada para receber SÓ o que é novo — é assim que " +
        "acompanhar uma sessão longa custa O(delta) em vez de O(tela). Use claude_capture só quando " +
        "precisar mesmo ver o TERMINAL (um prompt de permissão, um TUI, uma sessão que não é Claude).",
      inputSchema: {
        session: z.string().describe("nome da sessão tmux (veja claude_sessions)"),
        turns: z.number().int().positive().max(20).optional().describe("quantos turnos (padrão 3)"),
        sinceLine: z.number().int().min(0).optional().describe("o `cursor` de uma leitura anterior — devolve só o novo"),
        maxChars: z.number().int().positive().max(20000).optional().describe("teto por turno (padrão 4000)"),
      },
    },
    async ({ session, turns, sinceLine, maxChars }) => {
      if (!isSafeSessionName(session)) return fail("nome de sessão inválido (use [A-Za-z0-9_-]).");
      const found = await resolveTranscriptFor(session);
      if (!found) {
        return fail(
          `não achei o transcript da sessão "${session}" — ou ela não roda um Claude (um shell cop-*, por ` +
            `exemplo), ou o CLI ainda não gravou nada. Para um terminal que não é Claude, use claude_capture.`,
        );
      }
      const read = await readTranscriptTurns(found.path, { maxTurns: turns, sinceLine, maxChars });
      if (!read) return fail(`o transcript de "${session}" existe mas não deu para ler (${found.path}).`);
      return json({
        session,
        fonte: found.source,
        // O CURSOR é o contrato da leitura incremental: guarde-o e mande de volta em `sinceLine`.
        cursor: read.cursor,
        novo: sinceLine != null ? read.cursor - sinceLine : undefined,
        turnosOmitidos: read.dropped || undefined,
        turns: read.turns,
        hint:
          read.turns.length === 0
            ? "nenhum turno novo desde o cursor — a sessão não falou nada ainda (wait_for_session_idle bloqueia até ela parar)."
            : `re-chame com sinceLine:${read.cursor} para receber só o próximo turno.`,
      });
    },
  );

  // M4 — o TURNO INTEIRO numa chamada. O laço real de orquestração era send → adivinhar um sleep →
  // capturar a tela: 3 chamadas, uma heurística de tempo e ~10k tokens por pergunta. Aqui a espera é por
  // EVENTO (estabilidade de tela) e a leitura é o DELTA do transcript a partir do cursor de ANTES do
  // envio — então a resposta que volta é exatamente o que a sessão disse por causa desta mensagem.
  defineTool(server,
    "session_ask",
    {
      title: "Perguntar a uma sessão e esperar a resposta",
      description:
        "Manda um texto para uma sessão Claude, BLOQUEIA até ela parar de responder e devolve A RESPOSTA " +
        "(os turnos novos do transcript) — tudo numa chamada, no lugar de claude_send + esperar + " +
        "claude_capture. Devolve também o `motivo` da parada: 'terminou' ou 'aguardando-humano' (ela parou " +
        "num prompt — a resposta pode estar incompleta e mandar outra mensagem não adianta). Em 'timeout' a " +
        "sessão ainda está trabalhando: re-chame session_read com o `cursor` devolvido, sem re-enviar nada.",
      inputSchema: {
        session: z.string().describe("nome da sessão tmux"),
        text: z.string().describe("o que perguntar/instruir"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600000)
          .optional()
          .describe("teto de espera pela resposta (padrão 180000, máx 600000)"),
        idleMs: z.number().int().positive().max(120000).optional().describe("silêncio de tela p/ considerar pronto (padrão 4000)"),
        turns: z.number().int().positive().max(20).optional().describe("quantos turnos devolver (padrão 2)"),
        multiline: z.boolean().optional().describe("consentimento p/ multi-linha num SHELL (cada linha executa)"),
        confirmMaster: z.boolean().optional().describe("consentimento p/ escrever na sessão MASTER"),
      },
    },
    async ({ session, text: msg, timeoutMs, idleMs, turns, multiline, confirmMaster }) => {
      if (!isSafeSessionName(session)) return fail("nome de sessão inválido (use [A-Za-z0-9_-]).");
      // O cursor é tirado ANTES do envio: é o que faz a leitura devolver a resposta A ESTA mensagem, e
      // não o fim da conversa anterior (que é o que uma captura de tela devolveria).
      const found = await resolveTranscriptFor(session);
      const antes = found ? ((await readTranscriptTurns(found.path, { maxTurns: 1 }))?.cursor ?? 0) : 0;

      const entrega = await deliverToSession(session, msg, { submit: true, multiline, confirmMaster });
      if (!entrega.ok) return fail(entrega.error);

      const espera = await waitForIdleCore(
        {
          sample: async () => {
            const r = await run("tmux", ["capture-pane", "-p", "-t", session], { timeoutMs: 10_000 });
            return r.code === 0 ? r.stdout : null;
          },
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
          now: () => Date.now(),
        },
        { idleMs: Math.min(idleMs ?? 4000, 120000), timeoutMs: Math.min(timeoutMs ?? 180000, 600000), pollMs: 1500 },
      );

      const waiting = espera.state === "idle" ? currentTerminalAttention().find((t) => t.session === session) : undefined;
      const motivo =
        espera.state !== "idle" ? undefined : !waiting ? "sem-evidencia" : waiting.kind === "asking" ? "aguardando-humano" : "terminou";
      const depois = found ? await readTranscriptTurns(found.path, { maxTurns: turns ?? 2, sinceLine: antes }) : null;

      return json({
        session,
        entregue: { modo: entrega.mode === "paste" ? "colagem" : "digitação", linhas: entrega.lines },
        state: espera.state,
        ...(motivo ? { motivo } : {}),
        ...(waiting?.question ? { perguntaNaTela: waiting.question } : {}),
        ...(depois ? { cursor: depois.cursor, resposta: depois.turns } : {}),
        // Sem transcript (shell cop-*, ou um Claude que ainda não gravou) a chamada NÃO falha: ela
        // entregou e esperou de verdade. Só a leitura barata não está disponível — diga qual é a saída.
        ...(found ? {} : { aviso: "sem transcript para esta sessão — leia o terminal com claude_capture." }),
        next:
          espera.state === "timeout"
            ? "ainda trabalhando: NÃO re-envie — chame session_read({session, sinceLine: <cursor>}) para pegar o resto."
            : motivo === "aguardando-humano"
              ? "ela parou num prompt esperando o OPERADOR. Responder por ele não é seu papel — avise."
              : undefined,
      });
    },
  );

  defineTool(server,
    "claude_send",
    {
      title: "Mandar mensagem a uma sessão Claude",
      description:
        "Entrega um texto/prompt numa sessão tmux e, por padrão, pressiona Enter para submeter. O MODO é " +
        "escolhido pelo ALVO: numa sessão que roda um agente Claude o texto vai como COLAGEM (bloco inteiro, " +
        "multi-linha preservada — nunca fatiado em vários submits); num SHELL ele é digitado, e por isso um " +
        "texto de várias linhas é RECUSADO (cada quebra executaria um comando) até você passar multiline:true. " +
        "A sessão MASTER (`claude*`) exige confirmMaster:true. Bytes de controle/ESC são removidos sempre. " +
        "Depois use claude_capture (ou wait_for_session_idle) para ler a resposta.",
      inputSchema: {
        session: z.string().describe("nome da sessão tmux"),
        text: z.string().describe("o texto/prompt a enviar"),
        submit: z.boolean().optional().describe("pressionar Enter ao final (padrão true)"),
        multiline: z
          .boolean()
          .optional()
          .describe("consentimento p/ texto multi-linha num SHELL — cada linha vira um comando executado"),
        confirmMaster: z
          .boolean()
          .optional()
          .describe("consentimento p/ escrever na sessão MASTER (`claude*`), a que pilota a caixa"),
      },
    },
    async ({ session, text: msg, submit, multiline, confirmMaster }) => {
      const res = await deliverToSession(session, msg, { submit, multiline, confirmMaster });
      if (!res.ok) return fail(res.error);
      return json({
        ok: true,
        session,
        // O MODO é o que separa "o agente recebeu meu prompt inteiro" de "o shell executou 12 comandos".
        // Devolvê-lo é o que deixa o chamador conferir o que realmente aconteceu, em vez de supor.
        modo: res.mode === "paste" ? "colagem (agente Claude)" : "digitação (shell)",
        linhas: res.lines,
        sentChars: res.sentChars,
        submetido: res.submitted,
        hint:
          res.mode === "paste"
            ? "bloqueie em wait_for_session_idle({session}) para saber quando ele terminou — e o motivo da parada."
            : "comando digitado; claude_capture lê a saída.",
      });
    },
  );

  defineTool(server,
    "claude_keys",
    {
      title: "Navegar numa sessão por TECLAS nomeadas",
      description:
        "Manda uma sequência de TECLAS para uma sessão tmux — o par do `claude_send` para quem precisa " +
        "NAVEGAR em vez de digitar: formulário de opções, menu, confirmação. Use quando `claude_capture` " +
        "mostrar uma sessão parada num formulário: ali digitar número não seleciona, ele ALTERNA o item sob " +
        "o cursor, e sair exige seta/Tab/Enter. Vocabulário FECHADO (nome de tecla, nunca byte): " +
        "Up, Down, Left, Right, Tab, BTab, Enter, Space, Escape, Home, End, PageUp, PageDown — qualquer " +
        "outro nome é RECUSADO. Interromper/encerrar/suspender (C-c, C-d, C-z) NÃO estão aqui de propósito: " +
        "não são navegação, e encerrar sessão é `claude_kill`. Teto de 24 teclas por chamada, e uma tecla " +
        "por vez no fio — LEIA a tela entre as chamadas (`claude_capture`), porque navegar às cegas é o que " +
        "produz o clique errado. A sessão MASTER (`claude*`) exige confirmMaster:true.",
      inputSchema: {
        session: z.string().describe("nome da sessão tmux (veja claude_sessions)"),
        keys: z
          .array(z.string())
          .min(1)
          .describe("as teclas, em ordem. Ex.: [\"Down\",\"Space\",\"Enter\"] marca o 2º item e submete"),
        confirmMaster: z
          .boolean()
          .optional()
          .describe("consentimento p/ navegar na sessão MASTER (`claude*`), a que pilota a caixa"),
      },
    },
    async ({ session, keys, confirmMaster }) => {
      const res = await sendKeysToSession(session, keys, { confirmMaster });
      if (!res.ok) return fail(res.error);
      return json({
        ok: true,
        session,
        teclas: res.keys,
        hint: "leia a tela agora (claude_capture) — a próxima tecla depende do que a TUI repintou.",
      });
    },
  );

  defineTool(server,
    "claude_new",
    {
      title: "Criar uma sessão de agente (frota)",
      description:
        "Cria uma sessão Claude ORIENTADA A TRABALHO na VPS e a coloca na frota: ela nasce com identidade, " +
        "PAPEL, worktree PRÓPRIO (quando toca código), CLAIM do card (ninguém mais pega) e o contrato já no " +
        "prompt inicial — depois aparece inteira em /processes. Passe `cardId` quando o trabalho for de um " +
        "card (get_card/suggest_work ajudam a escolher); trabalho sem card (self-dev, fix rápido) é legítimo. " +
        "O MODELO sai da MESMA regra dos runs (coluna × complexidade do card); `model` só se você quiser " +
        "forçar. RECUSA com o motivo E a fila (quem está segurando a máquina) quando o cap de sessões / a VPS " +
        "estão saturados, e com o HOLDER quando o card já tem dono — nos dois casos nada é criado pela metade. " +
        "Depois: claude_send manda instruções, claude_capture lê a tela, claude_kill encerra.",
      inputSchema: {
        role: z
          .enum(["implement", "review", "triage", "steward", "free"])
          .describe(
            "implement/review/free tocam código → ganham worktree isolado e disputam a capacidade da máquina; " +
              "triage/steward mexem em board-data via MCP (sem árvore)",
          ),
        task: z.string().min(3).describe("o que esta sessão vai fazer — vai no prompt inicial e em /processes"),
        board: z.string().optional().describe("board do card, quando houver"),
        cardId: z.string().optional().describe("o card que este trabalho serve (adquire o claim); omita p/ trabalho sem card"),
        model: z
          .enum(["haiku", "sonnet", "opus"])
          .optional()
          .describe("força o tier (vence a derivação); omita para usar a regra do card — o padrão certo"),
        name: z.string().optional().describe("sufixo legível do nome do tmux (padrão: o id curto da sessão)"),
      },
    },
    async ({ role, task, board, cardId, model, name }) => {
      if (cardId && !board) return fail("cardId sem board — passe os dois (o claim é por board/card).");
      // F7 — um retry de rede não pode virar uma segunda sessão. Uma chamada que estoure o timeout do
      // proxy é re-tentada pelo cliente, e sem isto o servidor spawnava outro tmux + outra árvore + outra
      // vaga do cap para o MESMO trabalho. Trabalho com card se defendia pelo claim; sem card, nada.
      const jaExiste = findRetrySpawn(
        (await allSessions().catch(() => [])).filter((s) => isSessionAlive(s, Date.now())),
        { role, task, board, cardId },
        Date.now(),
      );
      if (jaExiste) {
        return json({
          ok: true,
          reaproveitada: true,
          session: jaExiste.tmuxSession ?? null,
          agentId: jaExiste.agentId,
          sessionId: jaExiste.sessionId,
          worktree: jaExiste.worktreePath ?? null,
          branch: jaExiste.branch ?? null,
          motivo:
            "uma sessão com a MESMA intenção (papel + tarefa + card) foi aberta há menos de " +
            `${Math.round(SPAWN_RETRY_WINDOW_MS / 1000)}s — devolvendo ELA em vez de spawnar uma segunda. ` +
            'Se você quer MESMO um segundo agente na mesma tarefa, mude a "task" ou espere a janela passar.',
        });
      }
      const who = currentMcpActor();
      const res = await spawnWorkSession(sessionSpawnDeps(), {
        role,
        task,
        board,
        cardId,
        model,
        name,
        actor: who ? `mcp:${who.level}${who.tokenEnv ? `(${who.tokenEnv})` : ""}` : undefined,
        // A scoped token IS the copiloto acting; the operator's `full` token is a human at a keyboard. Only the
        // copiloto's own sessions are the steward's to reap (WS-6.1), so the distinction has to be recorded.
        spawnedBy: who && who.level !== "full" ? "copilot" : "human",
      });
      if (!res.ok) {
        // A refusal is a RESULT the caller acts on, not an error to retry blindly: it carries the queue (wait
        // or re-prioritise?) or the holder (take another card). `isError` would hide the structure from it.
        return json({
          ok: false,
          error: res.holder ? "card_claimed" : res.queue ? "no_capacity" : "spawn_failed",
          motivo: res.reason,
          ...(res.queue ? { fila: res.queue } : {}),
          ...(res.holder ? { holder: { actor: res.holder.actor, kind: res.holder.kind, expiresAt: res.holder.expiresAt } } : {}),
          proximo: res.queue
            ? "espere uma vaga (claude_sessions mostra quem está rodando) ou rode um papel sem árvore (triage/steward)"
            : res.holder
              ? "suggest_work({board}) devolve o próximo card livre"
              : undefined,
        });
      }
      return json({
        ok: true,
        session: res.tmuxSession,
        agentId: res.session.agentId,
        sessionId: res.session.sessionId,
        role,
        board: res.session.board ?? null,
        cardId: res.session.cardId ?? null,
        worktree: res.session.worktreePath ?? null,
        branch: res.session.branch ?? null,
        model: res.route.model ?? null,
        effort: res.route.effort ?? null,
        modelPorque: res.route.why,
        claim: res.claim ? { kind: res.claim.kind, scope: res.claim.scope, expiresAt: res.claim.expiresAt } : null,
        // A session with no AgileHarness tools cannot honour the contract its own prompt states. Say it out loud
        // instead of letting the operator discover it when the agent reports it "can't find get_card".
        ...(res.mcpMounted
          ? {}
          : {
              aviso:
                "sem STORYMAP_MCP_TOKEN_ORCH no ambiente do serviço: a sessão NÃO tem as tools do AgileHarness " +
                "(não consegue ler/escrever o board por MCP). Configure o token e recicle a sessão.",
            }),
        hint: "Sessão viva e já trabalhando (o prompt inicial carrega card + worktree + contrato). Acompanhe em /processes ou com claude_capture.",
      });
    },
  );

  defineTool(server,
    "claude_recycle",
    {
      title: "Reciclar a sessão de um agente (contexto cheio)",
      description:
        "Troca o PROCESSO de uma sessão da frota mantendo o AGENTE: o worktree, o branch, o card e o claim " +
        "continuam exatamente onde estão (a identidade lógica não muda) e só o processo Claude é substituído " +
        "por um novo, que acorda com um prompt de HANDOFF (lê o estado antes de agir). Use quando " +
        "claude_sessions marcar `suggestRecycle` (contexto perto do teto) — é o contrário de descartar e " +
        "recriar, que jogaria fora o trabalho não-integrado. A sessão NOVA nasce e é verificada ANTES de a " +
        "antiga morrer: se ela não subir, nada muda. Passe o sessionId (veja /processes ou claude_sessions).",
      inputSchema: { sessionId: z.string().describe("o sessionId da sessão a reciclar (NÃO o nome do tmux)") },
    },
    async ({ sessionId }) => {
      const res = await recycleSession(sessionSpawnDeps(), { sessionId });
      if (!res.ok) return fail(res.reason);
      return json({
        ok: true,
        agentId: res.session.agentId,
        sessionId: res.session.sessionId,
        session: res.tmuxSession,
        anterior: res.previousTmux ?? null,
        worktree: res.session.worktreePath ?? null,
        branch: res.session.branch ?? null,
        model: res.route.model ?? null,
        preservado: "worktree, branch e claim seguem do MESMO agente — só o processo mudou",
      });
    },
  );

  defineTool(server,
    "term_new",
    {
      title: "Criar um terminal compartilhado (tmux)",
      description:
        "Cria um TERMINAL tmux DETACHED (raw shell) que VOCÊ e o HUMANO veem AO VIVO em /terminal?b=<session>. " +
        "`name` = slug curto e descritivo SEM prefixo (o `cop-` é adicionado automaticamente). `command` = o que " +
        "roda no terminal (padrão `bash` — um shell persistente; prefira criar o shell e depois digitar comandos " +
        "com claude_send, senão um comando one-shot encerra o terminal ao terminar). `cwd` = diretório relativo ao " +
        "repo (padrão raiz). Depois: claude_capture LÊ a tela, claude_send DIGITA, claude_kill encerra. Terminais " +
        "cop-* são EFÊMEROS — NÃO sobrevivem a um restart do serviço/deploy; não deixe job longo/crítico atravessar um deploy.",
      inputSchema: {
        name: z.string().describe("slug curto e descritivo, SEM o prefixo cop- (ex.: build-web). [A-Za-z0-9_-], ≤64"),
        command: z.string().optional().describe("comando a rodar no terminal (padrão: bash — shell persistente)"),
        cwd: z.string().optional().describe("diretório de trabalho relativo ao repo (padrão raiz)"),
      },
    },
    async ({ name, command, cwd }) => {
      const session = copSessionName(name);
      if (!session) {
        return fail(
          "nome inválido — use um slug começando com [A-Za-z0-9_] seguido de [A-Za-z0-9_-], até 64 chars. O prefixo cop- é adicionado automaticamente.",
        );
      }
      let absCwd = findRepoRoot();
      let relDir = ".";
      if (cwd && cwd !== ".") {
        const rel = toRepoRel(cwd);
        if (!rel) return fail("cwd fora do repositório.");
        absCwd = path.join(findRepoRoot(), rel);
        relDir = rel;
      }
      const cmd = (command && command.trim()) || "bash";
      const r = await ensureDetachedSession(session, cmd, absCwd);
      if (!r.ok) return fail(r.error || "falha ao criar o terminal (tmux disponível?).");
      // Carimba createdAt no registry (cwd/idade) — feeds /processes e a passada `cop-*` ociosas do reaper.
      getSessionMetaMap().set(session, { cwd: absCwd, createdAt: Date.now() });
      const url = `/terminal?b=${session}`;
      return json({
        ok: true,
        session,
        created: r.created,
        dir: relDir,
        url,
        hint: `Terminal ${r.created ? "criado" : "reutilizado"}. Abra em ${url} · leia a tela com claude_capture · digite com claude_send · encerre com claude_kill.`,
      });
    },
  );

  defineTool(server,
    "claude_kill",
    {
      title: "Encerrar uma sessão Claude (VPS)",
      description:
        "Mata uma sessão tmux por nome (kill-session). NÃO afeta o serviço do AgileHarness (systemd) nem os runs do " +
        "autorun (que não são sessões tmux). Encerra o Claude e tudo o mais daquela sessão.",
      inputSchema: { session: z.string().describe("nome da sessão tmux a encerrar") },
    },
    async ({ session }) => {
      if (!isSafeSessionName(session)) return fail("nome de sessão inválido.");
      // Same fail-closed never-kill guard the web terminal + killTmuxSessionAction use: refuses the
      // master, a live autorun run, a session hosting a live agent, or a live fleet worktree. A claude
      // trying to kill its OWN session is caught by class 4 (the session hosts a live agent — itself).
      const verdict = await assessKillLive(session);
      if (verdict.protected) return fail(`sessão protegida — ${verdict.reason || "não pode ser encerrada"}`);
      const r = await run("tmux", ["kill-session", "-t", session], { timeoutMs: 10_000 });
      if (r.code !== 0) return fail(r.stderr.trim() || `sessão "${session}" não encontrada`);
      getSessionMetaMap().delete(session);
      return json({ ok: true, killed: session });
    },
  );

  // ===== RUN TASK (headless `claude -p` — no persistent tmux session) ====
  // For one-off work that doesn't deserve a card (diagnostics, maintenance scripts,
  // sub-tasks): run Claude headless in a cwd and return the result directly. Unlike
  // claude_new it leaves NO tmux session behind — the child is awaited to completion (or
  // killed at timeout) and never registered with tmux.
  defineTool(server,
    "run_task",
    {
      title: "Executar tarefa Claude headless (sem sessão persistente)",
      description:
        "Roda `claude -p <prompt>` no diretório indicado e retorna o resultado direto. NÃO cria sessão tmux — " +
        "use para tarefas pontuais (diagnósticos, scripts, sub-tarefas sem card). `cwd` = diretório relativo ao " +
        "repo (padrão raiz). `skipPermissions` padrão true (headless autônomo). Timeout padrão 120 s, máx 600.",
      inputSchema: {
        prompt: z.string().min(1).max(50_000).describe("prompt a executar"),
        cwd: z.string().optional().describe("diretório de trabalho relativo ao repo, ex.: packages/<app>"),
        timeoutSec: z.number().int().positive().max(600).optional().describe("padrão 120, máx 600"),
        skipPermissions: z.boolean().optional().describe("autonomia plena (padrão true). O run é CONTIDO pelo sandbox do SO; `false` rebaixa e tira o shell. Não emite mais bypass de permissão — ver ADR-067."),
      },
    },
    async ({ prompt, cwd, timeoutSec, skipPermissions }) => {
      let workdir = findRepoRoot();
      if (cwd && cwd !== ".") {
        const rel = toRepoRel(cwd);
        if (!rel) return fail("cwd fora do repositório.");
        workdir = path.join(findRepoRoot(), rel);
      }
      const to = Math.min(Math.max(timeoutSec ?? 120, 10), 600) * 1000;
      // F0 (ADR-067): a postura de autonomia, resolvida pelo MESMO caminho do autorun.
      //
      // ⚠ A RAIZ DE PROJETO NÃO É O `workdir` (bloqueador de revisão). O comentário anterior dizia "aqui
      // a raiz de projeto e a árvore de escrita coincidem" e estava errado sempre que a tool recebe
      // `cwd`: o CLI resolve `.claude/settings.json` SUBINDO até a raiz do repositório — medido com
      // `claude config list` a partir de um subdiretório, que reporta "repo root, two levels up from
      // your cwd". Com `projectRoot = workdir`, a detecção da cerca ampliável lia dois caminhos
      // inexistentes enquanto o CLI mesclava o que existia na raiz: defesa presente na sintaxe e zero na
      // semântica, na única superfície alcançável pela internet.
      //
      // A detecção agora varre a cadeia inteira (ver `diretoriosDeSettings`), e o `projectRoot` passa a
      // ser a raiz — o começo da cadeia, não o meio dela.
      // F0 (ADR-067): a postura vive numa função NOMEADA (`resolveRunTaskPosture`), que recebe só o
      // workdir e deriva o resto — inclusive a raiz de PROJETO, que é a raiz do repositório e não o
      // workdir (o CLI resolve `.claude/settings.json` SUBINDO; passar o workdir deixava a detecção da
      // cerca ampliável cega, e foi um bloqueador de revisão). Os argumentos deixaram de ser texto que
      // alguém reescreve sem uma prova reclamar.
      const posture = resolveRunTaskPosture({
        workdir,
        // Chave com ENTROPIA: `Date.now()` sozinho colide entre duas chamadas no mesmo milissegundo.
        key: `run-task-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      });
      // Fail-closed também aqui: se a postura recusou, a tool não spawna. Uma tool alcançável pela
      // internet que ignora a recusa seria a porta que a fase inteira existe para fechar.
      if (posture.kind === "refused") return fail(`autonomia sem contenção recusada: ${posture.reason}`);
      // `skipPermissions` deixou de decidir a postura — ela vem do resolvedor, como no autorun. O
      // parâmetro sobrevive na assinatura da tool por compatibilidade e passou a ser um pedido de
      // AUTONOMIA, não de bypass: `false` rebaixa explicitamente (sem shell), em vez de apenas omitir
      // uma flag. Mentir sobre o que um parâmetro faz seria a mesma classe que a fase remove.
      // ⚠ `skipPermissions: false` NÃO pode DESCARTAR uma cerca disponível (achado de revisão, e a
      // inversão era feia: o valor "seguro" do parâmetro produzia um run com MENOS proteção). Trocar a
      // postura inteira por um `downgraded` sintético jogava fora o `--settings` — e com ele a fronteira
      // do SO, a allowlist de egresso e a negação de ~/.ssh, ~/.aws e das credenciais do harness —
      // restando só `acceptEdits` + `--disallowedTools Bash`. O que o parâmetro pede é MENOS AUTONOMIA,
      // não menos contenção: o rebaixamento acontece DENTRO da cerca.
      const semShell = skipPermissions === false;
      const posturaEfetiva: AutonomyPosture =
        semShell && posture.kind !== "sandboxed"
          ? { kind: "downgraded", tier: "write", warn: "skipPermissions=false" }
          : posture;
      const { args: argsBase, needsRootBypass } = buildRunTaskArgs(prompt, posturaEfetiva);
      // Contido E sem shell: mantém a cerca, tira o Bash por cima dela.
      const args = semShell && posturaEfetiva.kind === "sandboxed" ? [...argsBase, "--disallowedTools", "Bash"] : argsBase;
      // ── O MESMO PORTÃO DO ENGINE (achado de revisão) ────────────────────────────────────────────
      // A migração inicial desta tool parou na montagem das flags e não chamou o portão. Um revisor
      // filtrou `--settings` do argv logo antes do `pexec` e a suíte do módulo ficou verde: a tese do
      // módulo — "a propriedade não pode viver num teste, tem de ser recusa de produção" — valia só
      // para o engine, e justamente na única superfície alcançável pela internet ela não valia.
      // A válvula explícita precisa do bypass de root para o CLI aceitar a flag; descartar
      // `needsRootBypass` fazia `AGILEHARNESS_ALLOW_UNSANDBOXED_FULL=1` produzir um comando que o
      // próprio CLI recusa — uma alavanca declarada e quebrada, que é pior que não ter alavanca.
      //
      // ⚠ E o env do filho passa pelo CHOKEPOINT (achado de revisão). A fase editou exatamente esta
      // linha para acrescentar `env` e passou `process.env` CRU — entregando ao filho todo tier de
      // credencial MCP do harness (`STORYMAP_MCP_TOKEN*`), que `sanitizeSpawnEnv` existe para remover.
      // O `run_task` ingere prompt de fora: um pedido tão simples quanto "mostre seu ambiente" bastava
      // para o segredo virar texto no output da tool. Antes desta linha existir a tool não passava `env`
      // nenhum e herdava por omissão — o defeito é anterior à fase, mas passou a ser explícito nela.
      const envBase = sanitizeSpawnEnv(process.env);
      const bypassEnv =
        needsRootBypass && process.platform !== "win32" && process.getuid?.() === 0
          ? { ...envBase, IS_SANDBOX: "1" }
          : envBase;
      // execFile (shell:false) with `killSignal` ensures the child is reaped at timeout —
      // no orphaned `claude` process, and (since we never touch tmux) no residual session.
      try {
        // ── VERIFICA E SPAWNA NA MESMA EXPRESSÃO (ver spawnContidoArgv) ────────────────────────
        // A chamada avulsa do portão que existia 12 linhas acima foi ABSORVIDA aqui: um revisor mediu
        // que `pexec("claude", args.filter(...))` passava em 7167 de 7167 provas, porque o portão
        // verificava um argv e o processo executava outro.
        const { stdout, stderr } = await spawnContidoArgv(posturaEfetiva, args, (verificado) =>
          pexec(resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin }), verificado as string[], {
            cwd: workdir,
            env: bypassEnv,
            timeout: to,
            killSignal: "SIGKILL",
            maxBuffer: 8_000_000,
            windowsHide: true,
          }),
        );
        return json({
          ok: true,
          output: String(stdout).trim(),
          stderr: String(stderr).trim().slice(0, 500) || undefined,
        });
      } catch (e: unknown) {
        const err = e as { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
        if (err.killed || err.signal === "SIGKILL") {
          return json({ ok: false, error: "timeout", timeoutSec: Math.round(to / 1000), output: String(err.stdout ?? "").trim().slice(0, 2_000) });
        }
        return json({
          ok: false,
          exitCode: typeof err.code === "number" ? err.code : 1,
          error: String(err.stderr ?? err.message ?? "").slice(0, 2_000),
          output: String(err.stdout ?? "").trim().slice(0, 2_000) || undefined,
        });
      }
    },
  );
}
