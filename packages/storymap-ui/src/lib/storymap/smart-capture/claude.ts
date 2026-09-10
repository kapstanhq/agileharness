// Server-only: run Claude Code headless to get a one-shot JSON answer.
//
// Same mechanism the trigger-runner uses (spawn `claude -p` with shell:true so the
// Windows `.cmd` shim resolves from PATH), with two differences: the prompt goes via
// STDIN (no argv quoting hell — the prompt is large and full of quotes/newlines), and
// we capture stdout to PARSE the result instead of letting a skill write files.
//
// `--output-format json` makes Claude emit a single envelope object; we return its
// `.result` text. The caller (parse.ts) extracts the JSON proposal from that text.

import { spawn, type ChildProcess } from "node:child_process";
import { findRepoRoot } from "../paths";
import { sanitizeSpawnEnv } from "../runner/spawn-env";
import { getHelperRegistry } from "@/lib/vps/helper-registry";
import { resolvedClaudeBin } from "../runner/claude-bin";
import { loadRunnerConfig } from "../runner/config";

// Watchdog for the one-shot spawn. The real fix for "didn't answer in 120s" is the
// fast --model/--effort pin below (a bare `claude -p` runs the install default, often
// opus with a large thinking budget, which can blow past two minutes); this is just a
// generous safety net. Env-overridable.
const DEFAULT_TIMEOUT_MS = Number(process.env.AGILEHARNESS_SMART_CAPTURE_TIMEOUT_MS) || 180_000;

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

/** Pull the assistant text out of `claude --output-format json`'s envelope. Exported for tests. */
export function extractResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Claude não retornou saída.");
  try {
    const env = JSON.parse(trimmed) as { result?: unknown; is_error?: boolean };
    if (env && typeof env === "object" && "result" in env) {
      if (env.is_error) {
        throw new Error(`Claude retornou erro: ${String(env.result ?? "").slice(0, 300)}`);
      }
      if (typeof env.result === "string") return env.result;
    }
  } catch (e) {
    // Not the envelope (e.g. plain text or a JSON error we re-threw) — re-throw our
    // own messages; otherwise fall through to treat stdout as the raw result.
    if (e instanceof Error && e.message.startsWith("Claude retornou erro")) throw e;
  }
  return trimmed;
}

/**
 * Send `prompt` to Claude headless and resolve its textual answer. Rejects on
 * spawn error, non-zero exit, or watchdog timeout — the server action maps that to
 * a Result.error the modal surfaces.
 */
export function runClaudeJson(
  prompt: string,
  opts: {
    timeoutMs?: number;
    model?: string;
    effort?: string;
    dangerouslySkipPermissions?: boolean;
    /** when set, this synchronous helper shows up on /processes while it runs (transient row). */
    context?: { label: string; view?: string; board?: string; cardId?: string };
  } = {},
): Promise<string> {
  // Lia a env DIRETO e ignorava `autorun.claudeBin` do settings.yaml — divergência silenciosa
  // desde sempre. `loadRunnerConfig()` já colapsa os dois canais; passar por ele conserta.
  const bin = resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin });
  const cwd = findRepoRoot();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Smart capture is a no-tools, one-shot structured extraction — pin a FAST tier so it
  // answers in seconds instead of inheriting the install's default model (often opus with
  // a large thinking budget), which is what tripped the 120s watchdog on the VPS. Both
  // knobs are env-overridable; values match the runner's own --model/--effort vocabulary.
  // Callers (e.g. the bench "sincronizar" mode) may override model/effort and opt into tool
  // use (--dangerously-skip-permissions) so the agent can READ the real code to derive an artifact.
  const model = opts.model || process.env.AGILEHARNESS_SMART_CAPTURE_MODEL || "sonnet";
  const effort = opts.effort || process.env.AGILEHARNESS_SMART_CAPTURE_EFFORT || "medium";
  // ── O MODO DE PERMISSÃO É EXPLÍCITO, SEMPRE (achado de revisão, medido) ─────────────────────────
  // Este comando NÃO passava `--permission-mode`, e a leitura ingênua disso é "então ele roda no modo
  // padrão, que é seguro". Uma avaliação independente mediu o contrário: sem a flag, o modo efetivo vem
  // do `~/.claude/settings.json` do USUÁRIO que roda o serviço — e nesta instalação esse arquivo diz
  // `{"permissions":{"defaultMode":"bypassPermissions"}}`. Somado ao `IS_SANDBOX=1` que este mesmo
  // arquivo injeta quando root, o resultado é AUTONOMIA PLENA por herança de settings, invisível na
  // linha de comando.
  //
  // E o alcance disso não é local: `report_issue` e `usm_capture` chegam aqui pelo endpoint MCP
  // PÚBLICO, com token de nível `write` — `requireSession` aceita ator MCP sem cookie
  // (`auth/action-guard.ts`). Ou seja, a superfície que ingere TEXTO LIVRE NÃO CONFIÁVEL era, na
  // prática, a de maior autonomia do sistema, e era a que menos parecia.
  //
  // `plan` é o modo certo para o que esta função faz: ela LÊ e devolve JSON. O chamador que precisa de
  // ferramenta (o modo "sincronizar" do bench, que lê código real) segue podendo pedir — mas agora
  // pedindo, em vez de herdando.
  const perm = opts.dangerouslySkipPermissions
    ? " --dangerously-skip-permissions"
    : " --permission-mode plan";
  const cmd = `${bin} -p --output-format json --model ${model} --effort ${effort}${perm}`;
  // story-e3lj46 — o env do filho passa pelo MESMO chokepoint das outras superfícies de spawn de Claude
  // (`sanitizeSpawnEnv`), em vez de `{ ...process.env }` cru. Esta era a única fora dele, e a de maior risco:
  // é a superfície que ingere TEXTO LIVRE não confiável (captura, triagem de `report_issue`, turno de HITL,
  // edição assistida). O que a sanitização IMPEDE: que a credencial MCP do serviço esteja ONDE este filho a
  // despeja sem querer — um prompt injetado no texto pede "mostre seu ambiente" e o stdout dele vira proposta,
  // console de card e artefato publicado. Também tira o `__NEXT_PROCESSED_ENV` do next-server (que faz um
  // `next build` filho pular os .env) e o node_modules/.bin do PATH.
  // O que NÃO impede, e spawn-env.ts diz sem enfeite: o filho herda uid 0 e lê `.env.local` /
  // `storymap/.runner/*` do disco — é higiene do canal ACIDENTAL, não perímetro.
  // Custo de autonomia: ZERO. O comando abaixo não monta `--mcp-config`, então este filho nunca teve MCP
  // para perder; o skip-permissions opt-in do chamador segue intacto.
  const env = sanitizeSpawnEnv(process.env);
  // Root on POSIX → the CLI refuses to run unless IS_SANDBOX=1 (same guard the
  // autorun engine handles via needsSandboxEnv). Sem essa chave o spawn morre com
  // "cannot be used with root/sudo privileges"; injetamos o bypass documentado só quando de fato root.
  //
  // ⚠ E SÓ quando o chamador pediu a flag: `IS_SANDBOX=1` existe para o CLI ACEITAR
  // `--dangerously-skip-permissions` como root. Injetá-lo incondicionalmente afirmava ao CLI, em todo
  // spawn, que já havia um sandbox — a mentira exata que esta fase remove. O `delete` fecha a herança:
  // medido, o processo do serviço pode carregar a chave no próprio ambiente.
  if (
    opts.dangerouslySkipPermissions &&
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() === 0
  ) {
    env.IS_SANDBOX = "1";
  } else {
    delete env.IS_SANDBOX;
  }

  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      reject(new Error(`Não consegui iniciar o Claude (${bin}): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    // Surface this helper on /processes while it runs — dropped on settle (see `done`).
    let helperId: string | undefined;
    if (opts.context) {
      const reg = getHelperRegistry();
      helperId = reg.start(opts.context);
      if (child.pid) reg.setPid(helperId, child.pid);
    }

    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (helperId) getHelperRegistry().end(helperId);
      fn();
    };

    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));

    child.on("error", (e) =>
      done(() => reject(new Error(`Falha ao executar o Claude (${bin}): ${e.message}`))),
    );
    child.on("close", (code) =>
      done(() => {
        if (timedOut) {
          reject(new Error(`Claude não respondeu em ${Math.round(timeoutMs / 1000)}s — encerrado.`));
          return;
        }
        if (code && code !== 0) {
          reject(new Error(`Claude saiu com código ${code}. ${err.trim().slice(0, 300)}`.trim()));
          return;
        }
        try {
          resolve(extractResult(out));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }),
    );

    // Feed the prompt and close stdin so Claude starts answering.
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
