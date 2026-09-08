// deploy-agent-spawn — the IO behind a board's `deploy.kind: "agent"` (D-AG3, docs/plans/deploy-agnostic/):
// ONE bounded headless `claude` run that executes the board's OWN deploy recipe and answers a strict
// machine-readable verdict. The spawn precedent is resolution-judge-spawn.ts (infra spawns an LLM without
// the copilot being on): same sanitizeSpawnEnv, same root/IS_SANDBOX guard, same hard timeout, same
// fail-closed-on-everything posture.
//
// TRUST BOUNDARY — where the prompt comes from decides what this is. The recipe (`deploy.description`)
// comes from the BOARD CONFIG (board.yaml), authored by the board's human owner — the exact same channel
// column triggers ride. It is NEVER caller free text: deployBoard threads the config verbatim, no MCP tool
// accepts a prompt for this spawn (D-AG5 — the MCP surface is untouched). So the agent is the same risk
// class as any pipeline run: it executes the owner's declared intent, bounded by turns and wall clock.
//
// WHY THE WRAPPER, NOT THE LLM, IS THE AUTHORITY — the two things this file refuses to delegate:
//   1. THE SUCCESS DECISION feeds the EXISTING registry cycle. The agent's exit + parsed verdict become
//      the launch's completion code, so the ProductDeployRegistry tracks it (running/done/failed), the
//      G3 onDone subscribers revert on failure, and the settle handler decides advancement — no parallel
//      state machine, no bespoke "agent deployed" path.
//   2. THE PROOF (D-AG4). A verdict's `liveSha` is a CLAIM, never a stamp: deployBoard re-measures it with
//      the settle's single ancestry ruler (releasedSha ∈ liveSha, real git) before `deployProof` exists.
//      A verdict without a verifiable liveSha leaves the card WAITING in Publicando — deploy ok, proof
//      absent, watchdog armed (the deploy-truth asymmetry, preserved).
//
// FAIL-CLOSED EVERYWHERE: spawn error, timeout, non-zero exit, unreadable/off-contract verdict — every
// one becomes a FAILED completion (the registry's onDone reverts the card like any failed deploy). This
// module never throws to its caller.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import { loadRunnerConfig } from "./config";
import { mcpContainmentFlags } from "./flags";
import { headroomUrlIfKnownAlive } from "./headroom";
import { sanitizeSpawnEnv } from "./spawn-env";
import type { DeployLaunch } from "./product-deploy";
import { resolvedClaudeBin } from "./claude-bin";

/** Default wall-clock budget (minutes) when the board's descriptor declares none. Generous for a deploy
 *  (build + upload + provider propagation) yet bounded: an overrun is a FAILED deploy ⇒ revert + finding,
 *  which is exactly what a hung `orch-deploy` child would eventually earn from the operator. */
export const DEPLOY_AGENT_TIMEOUT_MINUTES_DEFAULT = 15;

/** `--max-turns` for the deploy agent. Conservative on purpose: the agent FOLLOWS a declared recipe (run
 *  the command, read its output, confirm health) — it is mechanical-profile work (WS-7 §7.2 class), not
 *  open-ended exploration. A deploy that needs more than this is a deploy the human should be looking at. */
export const DEPLOY_AGENT_MAX_TURNS = 50;

/** Model/effort — the `mechanical` tier named explicitly, same rationale as the resolution judge: this
 *  spawn is card-less (no column, no card signals to route on), and resolving a board profile that may
 *  not exist must never mean "spawn uncapped". Closed recipe work does not pay for opus. */
const DEPLOY_AGENT_MODEL = "sonnet";
const DEPLOY_AGENT_EFFORT = "medium";

/** How much of the agent's stdout is retained in memory for verdict parsing. The contract is the LAST
 *  line, so a bounded tail is enough — and it keeps a chatty agent from ballooning the service's heap. */
const STDOUT_TAIL_BYTES = 64 * 1024;

/**
 * The facts of ONE agent deploy, assembled by deployBoard FROM THE BOARD CONFIG + the card being
 * published. Everything the prompt says comes from here — see the trust-boundary note in the header.
 */
export interface DeployAgentSpec {
  kind: "agent";
  /** the board whose config authored the recipe (also the registry job key — D-AG2). */
  board: string;
  /** the card being published (absent for a manual, card-less dispatch). */
  cardId?: string;
  /** board.yaml `deploy.description` — the owner's free-text recipe "how this app is deployed". */
  description: string;
  /** the main sha the release proved carries the card's code — WHAT the agent must publish. */
  releasedSha?: string;
  /** the files the release promoted (context: what changed in this publish). */
  changedFiles?: string[];
  /** board.yaml `deploy.healthUrl` — where the agent can confirm the app is live. */
  healthUrl?: string;
  /** board.yaml `deploy.timeoutMinutes` — wall-clock budget override. */
  timeoutMinutes?: number;
}

/** The strict verdict the agent must emit as the LAST line of its stdout (see the prompt contract). */
export interface DeployAgentVerdict {
  ok: boolean;
  /** the sha the agent claims it published — a CLAIM the settle re-measures by ancestry, never a stamp. */
  liveSha?: string;
  /** how the agent confirmed the publish (free text, forensics). */
  evidence?: string;
  /** why it failed / could not confirm (free text, surfaced into the failure finding's log). */
  reason?: string;
}

/**
 * PURE — the prompt handed to the headless agent, assembled ONLY from the board config + card facts.
 * The output contract is spelled out verbatim because the wrapper parses it mechanically: prose that
 * does not end in the JSON line is a FAILED deploy, so the prompt makes honesty the cheap path
 * (an honest `ok:false` reverts cleanly; a dishonest `ok:true` earns a revert + finding later anyway).
 */
export function buildDeployAgentPrompt(spec: DeployAgentSpec): string {
  const files = spec.changedFiles ?? [];
  const shownFiles = files.slice(0, 40);
  return [
    `# Deploy do board ${spec.board}`,
    "",
    "Você é o AGENTE DE DEPLOY da pipeline. Publique este app em produção seguindo a receita",
    "declarada pelo dono do board (abaixo) e responda EXATAMENTE no contrato de saída.",
    "",
    "## Como este app é publicado (deploy.description do board.yaml)",
    spec.description,
    "",
    "## Contexto do card",
    `- Board: ${spec.board}`,
    spec.cardId ? `- Card: ${spec.cardId}` : "- Card: (nenhum — disparo manual)",
    spec.releasedSha
      ? `- Código a publicar (sha de main): ${spec.releasedSha}`
      : "- Código a publicar: (sha não informado — publique o estado atual de main)",
    ...(shownFiles.length > 0
      ? [
          "- Arquivos promovidos nesta publicação:",
          ...shownFiles.map((f) => `  - ${f}`),
          ...(files.length > shownFiles.length ? [`  - … e mais ${files.length - shownFiles.length} arquivo(s)`] : []),
        ]
      : []),
    ...(spec.healthUrl ? [`- Health check para confirmar o app no ar: ${spec.healthUrl}`] : []),
    "",
    "## Contrato de saída (OBRIGATÓRIO)",
    "A ÚLTIMA linha da sua resposta final deve ser UM JSON de uma linha, e nada depois dela:",
    '{"ok": true|false, "liveSha": "<sha publicado>", "evidence": "<como confirmou>", "reason": "<por que falhou>"}',
    "- `ok: true` SÓ quando o deploy completou E você confirmou o app no ar.",
    "- `liveSha`: o sha git efetivamente publicado. Informe SÓ se tiver certeza — a pipeline vai",
    "  re-medir por ancestralidade antes de dar o card como no ar; sem liveSha o card fica aguardando",
    "  confirmação humana (não avança sozinho).",
    '- Falhou ou não confirmou ⇒ {"ok": false, "reason": "..."} — honestidade > otimismo: um ok sem',
    "  publicação real será revertido com finding depois.",
  ].join("\n");
}

/**
 * Parse + VALIDATE the agent's stdout tail against the contract. Every rejection is fail-closed on
 * purpose (the caller turns an error into a FAILED deploy):
 *   - no last line / non-JSON last line ⇒ the agent did not answer the question it was asked;
 *   - `ok` missing or non-boolean ⇒ same (never coerced — a truthy string is not a deploy confirmation);
 *   - a `liveSha` that is not a git sha ⇒ the WHOLE verdict is rejected, not just the field: a claim in
 *     the wrong shape means the agent is improvising the contract, and its `ok` cannot be trusted either.
 * PURE — exported for tests.
 */
export function parseDeployAgentVerdict(stdout: string): DeployAgentVerdict | { error: string } {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return { error: "o agente não escreveu nada no stdout — sem veredito, deploy tratado como falho" };
  let doc: unknown;
  try {
    doc = JSON.parse(last);
  } catch {
    return { error: `a última linha do stdout não é JSON (contrato: {"ok": …}): ${last.slice(0, 120)}` };
  }
  if (!doc || typeof doc !== "object" || typeof (doc as { ok?: unknown }).ok !== "boolean") {
    return { error: "veredito sem o campo booleano `ok` — o agente não respondeu no contrato" };
  }
  const v = doc as Record<string, unknown>;
  const out: DeployAgentVerdict = { ok: v.ok as boolean };
  if (v.liveSha != null && String(v.liveSha).trim() !== "") {
    const sha = String(v.liveSha).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      return { error: `liveSha "${sha.slice(0, 60)}" não é um sha git — veredito rejeitado (fail-closed)` };
    }
    out.liveSha = sha;
  }
  if (typeof v.evidence === "string" && v.evidence.trim()) out.evidence = v.evidence.trim().slice(0, 2000);
  if (typeof v.reason === "string" && v.reason.trim()) out.reason = v.reason.trim().slice(0, 2000);
  return out;
}

/** DI surface — the real spawn in prod, a fake in tests. `logFile` is the registry's per-target log
 *  (deploy_status tails it); the agent's stdout+stderr stream into it like any other deploy job. */
export interface DeployAgentLaunchDeps {
  logFile: string;
  repoRoot?: string;
  /** the `claude` binary; defaults to settings.autorun.claudeBin (same source as every other spawn). */
  claudeBin?: string;
  /** wall-clock override (tests); defaults to spec.timeoutMinutes || DEPLOY_AGENT_TIMEOUT_MINUTES_DEFAULT. */
  timeoutMs?: number;
  spawnFn?: typeof spawn;
}

/**
 * Launch the deploy agent as a {@link DeployLaunch} — the SAME shape the registry's default launcher
 * returns for `just orch-deploy`, so ProductDeployRegistry.start tracks it with zero special-casing.
 * Completion semantics (all fail-closed, D-AG3):
 *   - exit 0 + parsable verdict `ok:true`  ⇒ whenDone(0) — a successful deploy settle;
 *   - exit 0 + verdict `ok:false`          ⇒ whenDone(1) — the agent honestly failed;
 *   - exit 0 + off-contract stdout         ⇒ whenDone(1) — no contract, no success;
 *   - non-zero exit / spawn error / timeout ⇒ whenDone(exit|-1) — failed, verdict synthesized with WHY.
 * The parsed verdict is exposed via `verdict()` so the registry can thread `liveSha` onto its done
 * event (read at close time — the registry is the only reader, inside whenDone).
 */
export function launchDeployAgent(spec: DeployAgentSpec, deps: DeployAgentLaunchDeps): DeployLaunch {
  const repoRoot = deps.repoRoot ?? findRepoRoot();
  const timeoutMs = deps.timeoutMs ?? (spec.timeoutMinutes ?? DEPLOY_AGENT_TIMEOUT_MINUTES_DEFAULT) * 60_000;
  const doSpawn = deps.spawnFn ?? spawn;
  const tag = `[deploy-agent ${spec.board}]`;

  mkdirSync(path.dirname(deps.logFile), { recursive: true });
  const out = createWriteStream(deps.logFile, { flags: "w" });

  let verdict: DeployAgentVerdict | null = null;
  let onDone: ((code: number | null) => void) | undefined;
  let settled = false;
  const finish = (v: DeployAgentVerdict, code: number | null) => {
    if (settled) return; // first outcome wins (timeout kill also fires 'close' — must not double-settle)
    settled = true;
    verdict = v;
    out.write(
      v.ok
        ? `\n${tag} veredito: ok${v.liveSha ? ` (liveSha ${v.liveSha})` : " — SEM liveSha (prova pendente, card aguarda confirmação)"}\n`
        : `\n${tag} veredito: FALHOU — ${v.reason ?? "sem motivo"}\n`,
    );
    out.end();
    onDone?.(code);
  };

  const args = [
    "-p",
    buildDeployAgentPrompt(spec),
    "--model",
    DEPLOY_AGENT_MODEL,
    "--effort",
    DEPLOY_AGENT_EFFORT,
    "--max-turns",
    String(DEPLOY_AGENT_MAX_TURNS),
    // The agent runs the owner's REAL deploy shell (vercel/firebase/ssh…) from the repo root — it needs
    // Bash like every code skill. Containment here is the BOUNDS (turns + wall clock + the board-config
    // trust boundary), deliberately NOT a worktree: a deploy acts on the live world by design.
    "--dangerously-skip-permissions",
    // …but the bounds must also cover the MCP surface: under skip-permissions every inherited server is
    // AUTO-APPROVED. This spawn declares no mounts, so containment means ZERO servers — never the host's
    // ambient connectors (the account-level Gmail/Drive/Calendar this used to inherit silently).
    ...mcpContainmentFlags(),
  ];
  // The CLI refuses --dangerously-skip-permissions as root unless IS_SANDBOX=1 (its own guard) — the
  // resolution-judge lesson: without this the spawn dies at launch with a mute exit 1.
  const env = sanitizeSpawnEnv(process.env);
  // ⊕ headroom (2026-07-28) — este é o ÚNICO spawn site SÍNCRONO (launchDeployAgent devolve o
  // handle na hora; torná-lo async arrastaria a cadeia de deploy inteira), então ele não pode
  // esperar uma sonda. Usa o espelho síncrono: roteia só se uma sonda recente viu o proxy vivo,
  // e vai DIRETO quando não sabe — o lado seguro.
  const headroomUrl = headroomUrlIfKnownAlive();
  if (headroomUrl) env.ANTHROPIC_BASE_URL = headroomUrl;
  if (process.platform !== "win32" && process.getuid?.() === 0) env.IS_SANDBOX = "1";

  let child: ChildProcess;
  try {
    // claudeBin resolved lazily (inside the try): a broken settings read must become a FAILED launch,
    // never a throw into the registry's synchronous start().
    const claudeBin = deps.claudeBin ?? resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
    out.write(`${tag} ${claudeBin} -p … (timeout ${Math.round(timeoutMs / 60_000)}min, max-turns ${DEPLOY_AGENT_MAX_TURNS})\n`);
    child = doSpawn(claudeBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
  } catch (err) {
    // Synchronous spawn failure — settle on a microtask so the registry registers whenDone first.
    const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
    queueMicrotask(() => finish({ ok: false, reason: `spawn do agente de deploy falhou: ${msg}` }, -1));
    return { pid: null, whenDone: (cb) => (onDone = cb), verdict: () => verdict };
  }

  // stdout streams to the job log (operator visibility via deploy_status) AND into a bounded in-memory
  // tail the verdict is parsed from — parsing from memory keeps stderr interleaving in the log file from
  // ever corrupting the contract's "last line of stdout".
  let stdoutTail = "";
  child.stdout?.on("data", (d: Buffer) => {
    out.write(d);
    stdoutTail = (stdoutTail + d.toString("utf8")).slice(-STDOUT_TAIL_BYTES);
  });
  child.stderr?.on("data", (d: Buffer) => out.write(d));

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    finish({ ok: false, reason: `o agente estourou o orçamento de ${Math.round(timeoutMs / 60_000)}min — deploy tratado como falho` }, -1);
  }, timeoutMs);

  child.on("error", (e) => {
    clearTimeout(timer);
    finish({ ok: false, reason: `spawn do agente de deploy falhou: ${e.message}` }, -1);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (settled) return;
    if (code !== 0) {
      finish({ ok: false, reason: `o agente saiu com exit ${code} — fail-closed, deploy tratado como falho` }, code ?? -1);
      return;
    }
    const parsed = parseDeployAgentVerdict(stdoutTail);
    if ("error" in parsed) {
      finish({ ok: false, reason: parsed.error }, 1);
      return;
    }
    finish(parsed, parsed.ok ? 0 : 1);
  });

  return { pid: child.pid ?? null, whenDone: (cb) => (onDone = cb), verdict: () => verdict };
}
