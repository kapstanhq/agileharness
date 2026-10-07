// sentinel-spawn.ts — o IO que lança UMA sessão da Sentinela: `claude -p` NOVA (nunca retoma o chat), Sonnet, enxuta,
// com as tools do modo (sentinel.ts). Detached + unref (o despertar sobrevive ao laço que o lançou); stdout num ARQUIVO
// (um pipe cujo dono morre mataria o filho), lido enquanto a sessão roda (os comandos vão ao registro na hora) e no `exit`.
//
// ONDE ELA RODA. O `cwd` é um diretório temporário do despertar — NUNCA o checkout de runtime compartilhado (lá a regra
// é «o serviço é o único escritor do board» e só git de leitura). Sem projeto no cwd, valem os settings GERENCIADOS e os
// do usuário: é onde mora a trava dura do host, e é por isso que a prontidão do conserto pergunta por ela com `cwd` nulo.
//
// O CONSERTO SÓ COM A CASA EM ORDEM (sentinel.ts `SentinelRepairReadiness`). Antes de dar Bash, três conferências:
//   1. a trava dura instalada (claude-settings.ts `hardDenyHookInstalled`) — o repositório não a traz;
//   2. a CONTENÇÃO DO SO — a mesma postura dos agentes headless (proxy-spawn.ts `resolveProxyPosture`): o shell lê o
//      repositório, escreve só no diretório do despertar, e não lê as credenciais do serviço. Postura recusada ou
//      rebaixada ⇒ diagnóstico. O portão de contenção (`spawnContidoArgv`) confere o comando montado;
//   3. o MCP por uma credencial DE PAPEL: um handle efêmero (lib/auth/mcp-handle.ts) com o rótulo `sentinel:<board>`,
//      revogado no fim. O SERVIDOR o reconhece pelo rótulo e prende a superfície às tools da Sentinela e o papel a
//      `sentinel` (route.ts) — o recorte deixa de ser um cabeçalho que o cliente declara. Nível `ro` em diagnóstico
//      (as tools de escrita da Sentinela nem montam), `orch` no conserto (o nível e a matriz do board decidem o resto).
// O arquivo de MCP mora num diretório À PARTE, negado à leitura das tools e do shell da sessão.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { makeHarnessTempDir } from "./temp";
import { sanitizeSpawnEnv } from "./spawn-env";
import { MCP_CALLER_HEADER, callerTag } from "@/lib/storymap/mcp/caller";
import { MCP_TOOLSET_HEADER } from "@/lib/storymap/mcp/toolsets";
import { createNdjsonParser, extractFinalResult } from "./stream-json";
import { hardDenyHookInstalled } from "./claude-settings";
import type { AutonomyPosture } from "./autonomy-sandbox";
import {
  SENTINEL_TIMEOUT_MINUTES,
  buildSentinelArgs,
  buildSentinelPrompt,
  buildSentinelSystemPrompt,
  costByDifference,
  extractBashCommands,
  scrubSecrets,
  sentinelSpawnEnv,
  type SentinelCause,
  type SentinelMode,
  type SentinelRepairReadiness,
} from "./sentinel";

/** O que um despertar devolve ao morrer. */
export interface SentinelRunResult {
  sessionId: string;
  /** custo DESTE despertar (pela diferença; sessão nova ⇒ o reportado). */
  costUSD: number;
  /** o texto final (o diagnóstico / o que fez), sem o que tem forma de segredo. */
  finalText?: string;
  /** cada comando de shell pedido (modo conserto). */
  commands: string[];
  exitCode: number | null;
  /** o CLI parou num teto (`error_max_budget_usd`, `error_max_turns`) ou o relógio matou. */
  stop?: "budget-cut" | "max-turns" | "timeout";
  /** o modo em que a sessão de fato rodou (o conserto pedido pode ter virado diagnóstico). */
  mode?: SentinelMode;
  /** por que o conserto pedido virou diagnóstico. */
  downgraded?: string;
}

/** O prefixo do rótulo do handle da Sentinela — o servidor reconhece o papel por ele (route.ts). */
export const SENTINEL_HANDLE_LABEL_PREFIX = "sentinel:";
/** Um handle da Sentinela vivo há mais que isto é de um despertar órfão (o relógio do despertar + folga): é revogado. */
export const SENTINEL_HANDLE_MAX_AGE_MS = (SENTINEL_TIMEOUT_MINUTES + 15) * 60_000;

/** O rótulo do handle de um despertar. PURA. */
export function sentinelHandleLabel(board: string): string {
  return `${SENTINEL_HANDLE_LABEL_PREFIX}${board === "*" ? "host" : board}`;
}

/** O JSON de MCP da sessão: só o AgileHarness, com o rótulo `sentinel:<board>` e o conjunto de tools da Sentinela. PURA. */
export function buildSentinelMcpConfig(token: string, port: number, board: string): string {
  const id = board === "*" ? "host" : board;
  return JSON.stringify({
    mcpServers: {
      storymap: {
        type: "http",
        url: `http://localhost:${port}/api/mcp/${token}/mcp`,
        // atribuição e recorte de cortesia — a credencial de papel é o que o servidor de fato confere (route.ts)
        headers: { [MCP_CALLER_HEADER]: callerTag({ kind: "sentinel", id }), [MCP_TOOLSET_HEADER]: "sentinel" },
      },
    },
  });
}

/** PURA — o resultado a partir do stream-json inteiro (custo, texto final, comandos, o teto que parou). */
export function parseSentinelStream(raw: string): Omit<SentinelRunResult, "sessionId" | "exitCode"> {
  const commands: string[] = [];
  let finalText: string | undefined;
  let reported: number | undefined;
  let subtype: string | undefined;
  const parser = createNdjsonParser((obj) => {
    commands.push(...extractBashCommands(obj));
    const r = extractFinalResult(obj);
    if (r) {
      if (r.finalText) finalText = scrubSecrets(r.finalText).slice(0, 2_000);
      if (typeof r.cost === "number") reported = r.cost;
      if (r.subtype) subtype = r.subtype;
    }
  });
  parser.feed(raw);
  parser.flush();
  const stop = subtype === "error_max_budget_usd" ? "budget-cut" : subtype === "error_max_turns" ? "max-turns" : undefined;
  return { costUSD: costByDifference(0, reported), ...(finalText ? { finalText } : {}), commands, ...(stop ? { stop } : {}) };
}

/** A credencial de papel de um despertar: o valor apresentável e quem a revoga. */
export interface SentinelCredential {
  token: string;
  revoke: () => Promise<void>;
}

/** Os caminhos que a sessão NUNCA lê, além dos segredos do serviço (credential-deny.ts): o MCP dela e o ambiente dos processos. */
export function sentinelExtraDeny(credentialDir: string): string[] {
  return [`${credentialDir}/**`, "/proc/*/environ"];
}

/**
 * A prontidão do conserto, PURA sobre os fatos: a trava dura instalada e uma postura que CONTÉM (sandbox, ou a válvula
 * que o operador declarou por escrito). Recusada/rebaixada ⇒ o motivo.
 */
export function repairReadinessOf(hardDeny: boolean, posture: Pick<AutonomyPosture, "kind"> & { reason?: string; warn?: string } | null): SentinelRepairReadiness {
  if (!hardDeny) return { ok: false, why: "a trava dura do host (hook PreToolUse de Bash) não está instalada" };
  if (!posture) return { ok: false, why: "a contenção do sistema não pôde ser resolvida" };
  if (posture.kind === "sandboxed" || posture.kind === "unsandboxed-escape") return { ok: true };
  if (posture.kind === "refused") return { ok: false, why: `a contenção do sistema recusou: ${(posture.reason ?? "").slice(0, 200)}` };
  return { ok: false, why: `sem contenção do sistema neste host (${posture.kind})` };
}

export interface SentinelSpawnDeps {
  claudeBin: string;
  port?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** relógio de parede (ms); default {@link SENTINEL_TIMEOUT_MINUTES}. */
  timeoutMs?: number;
  /** DI do teste: o `spawn` do node. */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** a trava dura instalada para uma sessão sem projeto (cwd temporário). Default: os settings do host. */
  hardDenyInstalled?: () => boolean;
  /** a postura de contenção do conserto, sobre o diretório do despertar. Default: a dos agentes headless. */
  resolvePosture?: (cwd: string, key: string, extraDeny: readonly string[]) => AutonomyPosture;
  /** o settings só-de-negação (diagnóstico, ou a válvula sem sandbox). Default: as regras do host + o extra. */
  denySettingsFile?: (extraDeny: readonly string[]) => string | null;
  /** a credencial de papel (handle efêmero). Default: lib/auth/mcp-handle.ts. null = sem MCP. */
  mintCredential?: (mode: SentinelMode, board: string) => Promise<SentinelCredential | null>;
  /** o diretório temporário (o cwd e o do MCP). Default: a raiz de scratch do harness. */
  tempDir?: (prefix: string) => Promise<string>;
  /** a sessão nasceu (o pid vai ao registro: a reconciliação de um órfão o confere). */
  onStart?: (pid: number | undefined, mode: SentinelMode, downgraded?: string) => void;
  /** os comandos pedidos ENQUANTO a sessão roda (o registro não espera o fim). */
  onCommands?: (commands: string[]) => void;
  /** a cadência da leitura do progresso (ms). */
  pollMs?: number;
}

async function defaultResolvePosture(cwd: string, key: string, extraDeny: readonly string[]): Promise<AutonomyPosture> {
  const [{ resolveProxyPosture }, { declaredDenyReadGlobs }] = await Promise.all([import("./proxy-spawn"), import("./autonomy-sandbox")]);
  return resolveProxyPosture(cwd, key, { declaredDenyRead: [...declaredDenyReadGlobs(), ...extraDeny] });
}

async function defaultDenySettingsFile(extraDeny: readonly string[]): Promise<string | null> {
  const { credentialDenyRulesDoHost, declaredDenyReadGlobs, writeCredentialDenySettingsFile } = await import("./autonomy-sandbox");
  return writeCredentialDenySettingsFile(credentialDenyRulesDoHost({ declared: [...declaredDenyReadGlobs(), ...extraDeny] }));
}

async function defaultMintCredential(mode: SentinelMode, board: string): Promise<SentinelCredential | null> {
  const { createMcpHandle, revokeMcpHandle } = await import("@/lib/auth/mcp-handle");
  const created = await createMcpHandle({ level: mode === "repair" ? "orch" : "ro", label: sentinelHandleLabel(board) });
  return {
    token: created.handle,
    revoke: async () => {
      await revokeMcpHandle(created.record.id).catch(() => undefined);
    },
  };
}

/**
 * Lança o despertar. Resolve com o resultado quando o filho morre; `null` quando ele nem nasceu (nunca lança). O teto
 * de dinheiro do despertar vai no argv (`budgetUSD`, já limitado ao que sobra do dia).
 */
export async function spawnSentinel(
  cause: SentinelCause,
  askedMode: SentinelMode,
  budgetUSD: number,
  deps: SentinelSpawnDeps,
): Promise<SentinelRunResult | null> {
  const tempDir = deps.tempDir ?? makeHarnessTempDir;
  let dir: string | null = null;
  let credDir: string | null = null;
  let credential: SentinelCredential | null = null;
  const cleanup = async () => {
    await credential?.revoke().catch(() => undefined);
    credential = null;
    for (const d of [dir, credDir]) if (d) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    dir = await tempDir("sentinel");
    credDir = await tempDir("sentinel-cred");
    const scratch = dir;
    const env = deps.env ?? process.env;
    const sessionId = randomUUID();
    const extraDeny = sentinelExtraDeny(credDir);

    // a prontidão do conserto: trava dura + contenção; faltou uma ⇒ diagnóstico (o motivo vai ao registro)
    let mode: SentinelMode = askedMode;
    let downgraded: string | undefined;
    let posture: AutonomyPosture | null = null;
    if (askedMode === "repair") {
      const hardDeny = (deps.hardDenyInstalled ?? (() => hardDenyHookInstalled(null)))();
      posture = hardDeny ? await Promise.resolve((deps.resolvePosture ?? defaultResolvePosture)(scratch, `sentinel-${sessionId}`, extraDeny)).catch(() => null) : null;
      const ready = repairReadinessOf(hardDeny, posture as (AutonomyPosture & { reason?: string }) | null);
      if (!ready.ok) {
        mode = "diagnose";
        downgraded = ready.why;
        posture = null;
      }
    }
    const sandboxed = mode === "repair" && posture?.kind === "sandboxed" ? posture : null;
    const settingsFile = sandboxed ? sandboxed.settingsFile : await Promise.resolve((deps.denySettingsFile ?? defaultDenySettingsFile)(extraDeny)).catch(() => null);

    const sysPath = path.join(dir, "system.txt");
    const outPath = path.join(dir, "out.jsonl");
    await fs.writeFile(sysPath, buildSentinelSystemPrompt(mode), { encoding: "utf8", mode: 0o600 });
    credential = await (deps.mintCredential ?? defaultMintCredential)(mode, cause.board).catch(() => null);
    let mcpConfigPath: string | null = null;
    if (credential) {
      mcpConfigPath = path.join(credDir, "mcp.json");
      await fs.writeFile(mcpConfigPath, buildSentinelMcpConfig(credential.token, deps.port ?? 3008, cause.board), { encoding: "utf8", mode: 0o600 });
    }
    const args = buildSentinelArgs({
      prompt: buildSentinelPrompt(cause),
      mode,
      sessionId,
      systemPromptFile: sysPath,
      budgetUSD,
      mcpConfigPath,
      settingsFile,
      permissionMode: sandboxed ? "acceptEdits" : "default",
    });
    const out = await fs.open(outPath, "a");
    // o seam com o nome que o censo de spawns reconhece (spawn-chokepoint.test.ts): uma superfície de Claude não fica calada
    const doSpawn = deps.spawnImpl ?? nodeSpawn;
    const launch = (argv: readonly string[]) =>
      doSpawn(deps.claudeBin, [...argv], {
        cwd: scratch,
        detached: true,
        stdio: ["ignore", out.fd, "ignore"],
        // o chokepoint de env de spawn (spawn-env.ts) e, por cima, o que é só da Sentinela (a liberação da trava dura)
        env: sentinelSpawnEnv(sanitizeSpawnEnv(env as NodeJS.ProcessEnv)),
      });
    let child: ChildProcess;
    if (mode === "repair" && posture) {
      // o PORTÃO de contenção confere o comando montado contra a postura (um --settings, o modo de permissão…)
      const { spawnContidoArgv } = await import("./autonomy-sandbox");
      child = spawnContidoArgv(posture, args, launch);
    } else {
      child = launch(args);
    }
    deps.onStart?.(child.pid, mode, downgraded);
    // os ouvintes ANTES de qualquer await: um filho que morre no arranque (flag que o CLI recusa) sairia durante o
    // `close` e o `exit` se perderia — o despertar ficaria pendurado até o relógio.
    const settled = new Promise<SentinelRunResult | null>((resolve) => {
      let killedByClock = false;
      let offset = 0;
      let seen = 0;
      const progress = createNdjsonParser((obj) => {
        const cmds = extractBashCommands(obj);
        if (cmds.length) {
          seen += cmds.length;
          deps.onCommands?.(cmds);
        }
      });
      const poll = async () => {
        try {
          const fh = await fs.open(outPath, "r");
          try {
            const { size } = await fh.stat();
            if (size > offset) {
              const buf = Buffer.alloc(size - offset);
              await fh.read(buf, 0, buf.length, offset);
              offset = size;
              progress.feed(buf.toString("utf8"));
            }
          } finally {
            await fh.close();
          }
        } catch {
          /* o progresso é best-effort: o desfecho relê o arquivo inteiro */
        }
      };
      const ticker = deps.onCommands ? setInterval(() => void poll(), Math.max(200, deps.pollMs ?? 5_000)) : null;
      (ticker as unknown as { unref?: () => void } | null)?.unref?.();
      const timeoutMs = deps.timeoutMs ?? SENTINEL_TIMEOUT_MINUTES * 60_000;
      const clock = setTimeout(() => {
        killedByClock = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* já morto */
        }
      }, timeoutMs);
      (clock as unknown as { unref?: () => void }).unref?.();
      child.on("error", () => {
        clearTimeout(clock);
        if (ticker) clearInterval(ticker);
        void cleanup().finally(() => resolve(null));
      });
      child.on("exit", (code) => {
        clearTimeout(clock);
        if (ticker) clearInterval(ticker);
        void (async () => {
          if (deps.onCommands) {
            await poll();
            progress.flush();
          }
          const raw = await fs.readFile(outPath, "utf8").catch(() => "");
          await cleanup();
          const parsed = parseSentinelStream(raw);
          // os comandos que o progresso ainda não registrou (o último pedaço, ou sem leitor de progresso)
          if (deps.onCommands && parsed.commands.length > seen) deps.onCommands(parsed.commands.slice(seen));
          // morto pelo relógio sem custo reportado ⇒ cobra o teto do despertar (o lado seguro de um orçamento)
          const costUSD = killedByClock && parsed.costUSD === 0 ? budgetUSD : parsed.costUSD;
          resolve({
            ...parsed,
            costUSD,
            sessionId,
            exitCode: code,
            mode,
            ...(downgraded ? { downgraded } : {}),
            ...(killedByClock ? { stop: "timeout" as const } : {}),
          });
        })();
      });
      child.unref?.();
    });
    await out.close();
    return await settled;
  } catch (err) {
    await cleanup();
    console.error("[sentinel] spawn falhou:", err instanceof Error ? err.message : err);
    return null;
  }
}
