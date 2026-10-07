// claude-settings — what a Claude Code session started in a repo INHERITS from the settings layers, read the way
// the CLI resolves them: `permissions.defaultMode` (session-spawn.ts, fact 4: as root with an inherited
// `bypassPermissions` the session dies at birth unless the command carries IS_SANDBOX=1) and — fase 6 — the HARD LOCK
// of the host (a `PreToolUse` hook that matches `Bash`, e.g. the operator's `hard-deny`). The repository does not ship
// that hook: it is the HOST's. Every grant of a shell to an agent that says «under the hard lock» checks here that the
// lock exists for the session it is about to start ({@link hardDenyHookInstalled}); without it the grant falls back.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The CLI's managed-policy file on Linux — the highest-precedence layer. */
export const MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/**
 * The settings files a `claude` started in `cwd` loads, highest precedence first: managed policy, project local,
 * project, user. `cwd` null ⇒ no project layers (a session started in a scratch dir that is not a checkout). PURE.
 */
export function settingsLayersFor(cwd: string | null, opts: { home?: string; managedPath?: string } = {}): string[] {
  return [
    opts.managedPath ?? MANAGED_SETTINGS_PATH,
    ...(cwd ? [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json")] : []),
    path.join(opts.home ?? os.homedir(), ".claude", "settings.json"),
  ];
}

/** One command hook that guards `Bash` before it runs (the CLI's `PreToolUse`). */
export interface ShellGuardHook {
  /** the settings file it came from (for the log / the health line). */
  source: string;
  command: string;
  /** seconds, as the settings declare it. */
  timeout?: number;
}

/** Does a `PreToolUse` matcher cover the `Bash` tool? Absent/empty/`*` = every tool; otherwise the CLI's regex. PURE. */
export function hookMatcherCoversBash(matcher: unknown): boolean {
  if (matcher === undefined || matcher === null) return true;
  if (typeof matcher !== "string") return false;
  const m = matcher.trim();
  if (!m || m === "*") return true;
  try {
    return new RegExp(`^(?:${m})$`).test("Bash");
  } catch {
    return m.split("|").map((s) => s.trim()).includes("Bash");
  }
}

/**
 * The `PreToolUse` command hooks that guard `Bash` for a `claude` started in `cwd`, across every layer it loads (hooks
 * MERGE across layers). A layer that declares `disableAllHooks: true` turns the answer into NONE — fail-closed: a grant
 * that depends on the lock must not trust a lock that a settings layer switched off. Never throws. PURE over `readFile`.
 */
export function bashGuardHooks(
  cwd: string | null,
  opts: { home?: string; managedPath?: string; readFile?: (f: string) => string } = {},
): ShellGuardHook[] {
  const read = opts.readFile ?? ((f: string) => readFileSync(f, "utf8"));
  const out: ShellGuardHook[] = [];
  for (const f of settingsLayersFor(cwd, opts)) {
    let parsed: { disableAllHooks?: unknown; hooks?: { PreToolUse?: unknown } } | null;
    try {
      parsed = JSON.parse(read(f)) as typeof parsed;
    } catch {
      continue; // absent or unreadable ⇒ this layer adds nothing
    }
    if (parsed?.disableAllHooks === true) return [];
    const groups = parsed?.hooks?.PreToolUse;
    if (!Array.isArray(groups)) continue;
    for (const g of groups as Array<{ matcher?: unknown; hooks?: unknown }>) {
      if (!g || typeof g !== "object" || !hookMatcherCoversBash(g.matcher) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks as Array<{ type?: unknown; command?: unknown; timeout?: unknown }>) {
        if (h?.type !== "command" || typeof h.command !== "string" || !h.command.trim()) continue;
        out.push({ source: f, command: h.command, ...(typeof h.timeout === "number" && h.timeout > 0 ? { timeout: h.timeout } : {}) });
      }
    }
  }
  return out;
}

/** Is the host's hard lock (a `PreToolUse` command hook covering `Bash`) in force for a `claude` started in `cwd`? */
export function hardDenyHookInstalled(cwd: string | null, opts: Parameters<typeof bashGuardHooks>[1] = {}): boolean {
  return bashGuardHooks(cwd, opts).length > 0;
}

/** What the hook said about one shell command. `blocked` carries the hook's own reason (stderr / JSON). */
export type ShellGuardVerdict = { blocked: false; hooks: number } | { blocked: true; reason: string };

/** Runs ONE hook command with the `PreToolUse` payload on stdin; resolves exit code + output. Never rejects. */
export type RunGuardHook = (hook: ShellGuardHook, payload: string) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;

const runGuardHookDefault: RunGuardHook = (hook, payload) =>
  new Promise((resolve) => {
    // the operator's override of the lock (`AH_HARD_DENY_*`) belongs to HIS session — the service never forwards it
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^AH_HARD_DENY/i.test(k)) env[k] = v;
    const child = execFile(
      "sh",
      ["-c", hook.command],
      // o tipo nominal do Node exige NODE_ENV; este ambiente é o do serviço menos a liberação da trava (spawn-env.ts faz o mesmo)
      { timeout: Math.max(1, hook.timeout ?? 10) * 1000, maxBuffer: 256 * 1024, env: env as unknown as NodeJS.ProcessEnv, encoding: "utf8" },
      (err: Error | null, stdout: string, stderr: string) => {
        const raw = (err as { code?: unknown } | null)?.code;
        const code = !err ? 0 : typeof raw === "number" ? raw : null;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(err && code === null ? { error: err.message } : {}) });
      },
    );
    child.stdin?.end(payload);
  });

/**
 * The SERVICE asks the host's hard lock about a shell command it is about to run or type on an agent's behalf (a
 * terminal opened by MCP, text typed into a raw shell pane, a signal source's argv) — paths that never pass through
 * the CLI's `Bash` tool, so the hook would never see them. Same contract as the CLI: exit 2, or a JSON answer that
 * blocks/denies, refuses. FAIL-CLOSED where the CLI is not: a hook that cannot run or times out refuses (the lock that
 * did not answer is not a yes). No hook configured ⇒ nothing to ask (`hooks: 0`) — the caller decides what that means.
 */
export async function evaluateShellGuard(
  command: string,
  opts: { cwd?: string | null; hooks?: ShellGuardHook[]; run?: RunGuardHook } = {},
): Promise<ShellGuardVerdict> {
  const hooks = opts.hooks ?? bashGuardHooks(opts.cwd ?? null);
  if (hooks.length === 0) return { blocked: false, hooks: 0 };
  const payload = JSON.stringify({
    session_id: "agileharness-service",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: opts.cwd ?? process.cwd(),
  });
  const run = opts.run ?? runGuardHookDefault;
  for (const hook of hooks) {
    const r = await run(hook, payload).catch((err) => ({ code: null, stdout: "", stderr: "", error: String(err) }));
    if (r.code === null) return { blocked: true, reason: `a trava dura do host não respondeu (${r.error ?? "sem saída"}) — sem resposta, nada roda` };
    if (r.code === 2) return { blocked: true, reason: r.stderr.trim().slice(0, 600) || "recusado pela trava dura do host" };
    try {
      const o = JSON.parse(r.stdout.trim() || "{}") as { decision?: unknown; reason?: unknown; hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown } };
      const denied = o?.decision === "block" || o?.hookSpecificOutput?.permissionDecision === "deny";
      if (denied) {
        const why = o.hookSpecificOutput?.permissionDecisionReason ?? o.reason;
        return { blocked: true, reason: typeof why === "string" && why.trim() ? why.trim().slice(0, 600) : "recusado pela trava dura do host" };
      }
    } catch {
      /* saída que não é JSON: só o código conta (a semântica do CLI) */
    }
  }
  return { blocked: false, hooks: hooks.length };
}

/**
 * The `permissions.defaultMode` a session started in `repoRoot` inherits, by the CLI's precedence (highest
 * first): managed policy, project local, project, user. A layer that is absent, unreadable or silent on the key
 * falls through to the next; nothing found ⇒ `undefined`. Never throws — a read failure must degrade to "no
 * bypass inherited" (the previous behaviour), never to a wider one.
 */
export function readInheritedDefaultMode(
  repoRoot: string,
  opts: { home?: string; managedPath?: string; readFile?: (f: string) => string } = {},
): unknown {
  const read = opts.readFile ?? ((f: string) => readFileSync(f, "utf8"));
  for (const f of settingsLayersFor(repoRoot, opts)) {
    try {
      const mode = (JSON.parse(read(f)) as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
      if (mode !== undefined) return mode;
    } catch {
      /* absent or unreadable ⇒ next layer */
    }
  }
  return undefined;
}
