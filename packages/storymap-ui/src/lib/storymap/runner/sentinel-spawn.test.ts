import { EventEmitter } from "node:events";
import { promises as fs, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildSentinelMcpConfig,
  parseSentinelStream,
  repairReadinessOf,
  sentinelExtraDeny,
  sentinelHandleLabel,
  spawnSentinel,
  type SentinelCredential,
  type SentinelSpawnDeps,
} from "./sentinel-spawn";
import type { SentinelCause, SentinelMode } from "./sentinel";
import type { AutonomyPosture } from "./autonomy-sandbox";
import { resolveProxyPosture } from "./proxy-spawn";
import { MCP_CALLER_HEADER } from "@/lib/storymap/mcp/caller";
import { MCP_TOOLSET_HEADER } from "@/lib/storymap/mcp/toolsets";

/** As flags que NUNCA podem aparecer no argv da Sentinela — cada uma desliga hook, troca as fontes de configuração (onde
 *  mora a trava dura), pula permissões, alarga o acesso a arquivo ou retoma uma sessão. O `--settings` da CONTENÇÃO é o
 *  único permitido (uma camada a mais, nunca a troca das fontes) — conferido à parte. */
const SENTINEL_FORBIDDEN_FLAGS = ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--setting-sources", "--restricted", "--add-dir", "--resume", "--continue"];

const CAUSE: SentinelCause = { kind: "stalled-run", key: "stalled-run:livraria:x", board: "livraria", cardIds: ["story-ex9001"], summary: "Execução parada: sandbox" };

const STREAM = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls /tmp" } }] } },
  { type: "result", subtype: "success", result: "Consertei: o cache estava corrompido.", total_cost_usd: 0.42 },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

/** Um `spawn` falso: escreve o stream no stdout (o fd do arquivo) e sai com 0. Guarda o que recebeu. */
function fakeSpawn(stream = STREAM) {
  const calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
  const impl = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args, opts });
    const fd = (opts.stdio as unknown[])[1] as number;
    writeSync(fd, stream);
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    (child as unknown as { unref: () => void }).unref = () => {};
    (child as unknown as { pid: number }).pid = 4242;
    setTimeout(() => child.emit("exit", 0), 5);
    return child;
  };
  return { impl, calls };
}

/** As deps de um despertar: tudo injetado, nada do host (nem a trava, nem o sandbox, nem o registro de handles). */
function deps(over: Partial<SentinelSpawnDeps> & { minted?: Array<{ mode: SentinelMode; board: string; revoked: boolean }> } = {}) {
  const minted = over.minted ?? [];
  const { impl, calls } = fakeSpawn();
  const d: SentinelSpawnDeps = {
    claudeBin: "claude",
    env: { PATH: "/usr/bin", AH_HARD_DENY_ALLOW: "deploy", AGILEHARNESS_MCP_TOKEN_ORCH: "orch-secret", AGILEHARNESS_MCP_TOKEN: "full-secret" },
    spawnImpl: impl,
    hardDenyInstalled: () => true,
    resolvePosture: () => ({ kind: "unsandboxed-escape", tier: "full", warn: "válvula declarada" }),
    denySettingsFile: () => "/srv/estado/sandbox/deny-ex.json",
    mintCredential: async (mode, board): Promise<SentinelCredential> => {
      const rec = { mode, board, revoked: false };
      minted.push(rec);
      return { token: `ahk_ex${minted.length}.segredo`, revoke: async () => void (rec.revoked = true) };
    },
    ...over,
  };
  return { d, calls, minted };
}

describe("spawnSentinel — o despertar (com um spawn falso)", () => {
  it("Máxima com a casa em ordem: cwd TEMPORÁRIO (nunca o checkout), Bash, a contenção no --settings, a credencial de papel revogada no fim", async () => {
    const minted: Array<{ mode: SentinelMode; board: string; revoked: boolean }> = [];
    const progress: string[][] = [];
    const { d, calls } = deps({ minted, onCommands: (c) => progress.push(c), pollMs: 200 });
    const r = await spawnSentinel(CAUSE, "repair", 2, d);
    expect(r).toMatchObject({ costUSD: 0.42, commands: ["git status", "ls /tmp"], exitCode: 0, mode: "repair", finalText: expect.stringContaining("cache") });
    const { args, opts } = calls[0];
    // o cwd é o diretório do despertar — não o checkout de runtime (lá só o serviço escreve no board)
    expect(String(opts.cwd)).not.toBe(process.cwd());
    expect(path.basename(String(opts.cwd))).toMatch(/sentinel/);
    // a liberação da trava e os tokens do serviço não chegam ao filho
    expect(opts.env).toEqual({ PATH: "/usr/bin" });
    for (const f of SENTINEL_FORBIDDEN_FLAGS) expect(args).not.toContain(f);
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
    expect(args[args.indexOf("--settings") + 1]).toBe("/srv/estado/sandbox/deny-ex.json");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,ToolSearch,Bash");
    // o MCP mora num diretório À PARTE do cwd (negado à leitura da sessão) e usa a credencial de papel
    const mcp = args[args.indexOf("--mcp-config") + 1];
    expect(path.dirname(mcp)).not.toBe(String(opts.cwd));
    expect(minted).toEqual([{ mode: "repair", board: "livraria", revoked: true }]);
    // os comandos chegaram ao registro (o progresso não espera só o fim)
    expect(progress.flat()).toEqual(["git status", "ls /tmp"]);
  });

  it("Máxima SEM a trava dura do host: roda em diagnóstico — nenhum Bash, credencial só de leitura, e o motivo volta", async () => {
    const minted: Array<{ mode: SentinelMode; board: string; revoked: boolean }> = [];
    const { d, calls } = deps({ minted, hardDenyInstalled: () => false });
    const r = await spawnSentinel(CAUSE, "repair", 2, d);
    expect(r).toMatchObject({ mode: "diagnose", downgraded: expect.stringMatching(/trava dura/) });
    const { args } = calls[0];
    expect(args.join(",")).not.toContain("Bash");
    expect(minted[0].mode).toBe("diagnose");
  });

  it("Máxima sem contenção do sistema (postura recusada ou rebaixada): diagnóstico, nunca shell solto", async () => {
    for (const posture of [
      { kind: "refused", reason: "o alvo amplia a cerca" },
      { kind: "downgraded", tier: "write", warn: "sem bwrap" },
    ] as AutonomyPosture[]) {
      const { d, calls } = deps({ resolvePosture: () => posture });
      const r = await spawnSentinel(CAUSE, "repair", 2, d);
      expect(r?.mode).toBe("diagnose");
      expect(calls[0].args.join(",")).not.toContain("Bash");
      expect(calls[0].args[calls[0].args.indexOf("--allowedTools") + 1]).toBe("mcp__storymap");
    }
  });

  it("Máxima com o SANDBOX de verdade: o portão de contenção aceita o argv (um --settings, o da postura, e acceptEdits)", async () => {
    const support = { available: true, mechanism: "bubblewrap" as const, requiresWeakerNested: false, reason: "sonda ok", missing: [], method: "sonda" as const };
    const { d, calls } = deps({
      resolvePosture: (cwd, key, extra) => resolveProxyPosture(cwd, key, { support, env: {}, readTarget: () => null, declaredDenyRead: [...extra] }),
    });
    const r = await spawnSentinel(CAUSE, "repair", 2, d);
    expect(r?.mode).toBe("repair");
    const { args } = calls[0];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    const settings = JSON.parse(await fs.readFile(args[args.indexOf("--settings") + 1], "utf8"));
    expect(settings.sandbox.enabled).toBe(true);
    // a escrita do shell fica no diretório do despertar; a leitura nega o MCP dele e o ambiente dos processos
    expect(settings.sandbox.filesystem.allowWrite).toEqual([String(calls[0].opts.cwd)]);
    expect(JSON.stringify(settings.permissions.deny)).toContain("/proc/*/environ");
  });

  it("Mínima: nenhum Bash nem shell pré-aprovado; o MCP é a credencial de papel SÓ DE LEITURA", async () => {
    const minted: Array<{ mode: SentinelMode; board: string; revoked: boolean }> = [];
    const { d, calls } = deps({ minted });
    await spawnSentinel(CAUSE, "diagnose", 1, d);
    const { args } = calls[0];
    expect(args.join(",")).not.toContain("Bash");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__storymap");
    expect(minted).toEqual([{ mode: "diagnose", board: "livraria", revoked: true }]);
  });

  it("sem credencial (o registro de handles falhou): a sessão nasce sem MCP", async () => {
    const { d, calls } = deps({ mintCredential: async () => null });
    await spawnSentinel(CAUSE, "diagnose", 1, d);
    expect(calls[0].args).not.toContain("--mcp-config");
  });

  it("a prontidão: trava dura e uma postura que contém", () => {
    expect(repairReadinessOf(true, { kind: "sandboxed" })).toEqual({ ok: true });
    expect(repairReadinessOf(true, { kind: "unsandboxed-escape" })).toEqual({ ok: true });
    expect(repairReadinessOf(false, { kind: "sandboxed" }).ok).toBe(false);
    expect(repairReadinessOf(true, { kind: "downgraded" }).ok).toBe(false);
    expect(repairReadinessOf(true, null).ok).toBe(false);
  });

  it("o MCP se apresenta como a Sentinela; o rótulo do handle é o que o servidor confere", () => {
    const cfg = JSON.parse(buildSentinelMcpConfig("tok", 3999, "livraria"));
    expect(cfg.mcpServers.storymap.headers[MCP_CALLER_HEADER]).toBe("sentinel:livraria");
    expect(JSON.parse(buildSentinelMcpConfig("tok", 3999, "*")).mcpServers.storymap.headers[MCP_CALLER_HEADER]).toBe("sentinel:host");
    expect(cfg.mcpServers.storymap.headers[MCP_TOOLSET_HEADER]).toBe("sentinel");
    expect(sentinelHandleLabel("livraria")).toBe("sentinel:livraria");
    expect(sentinelHandleLabel("*")).toBe("sentinel:host");
    expect(sentinelExtraDeny(path.join(os.tmpdir(), "cred"))).toContain("/proc/*/environ");
  });

  it("parseSentinelStream: o teto que parou a sessão, e o texto final sem o que tem forma de segredo", () => {
    expect(parseSentinelStream(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", total_cost_usd: 2 })).stop).toBe("budget-cut");
    expect(parseSentinelStream("lixo\n{").costUSD).toBe(0);
    // montado em runtime: a linha literal `NOME_DO_TOKEN=valor` seria (com razão) barrada pela varredura de segredos do repo
    const leakedLine = ["AGILEHARNESS", "MCP", "TOKEN"].join("_") + "=" + "abcdef0123456789abcdef";
    const leaked = parseSentinelStream(JSON.stringify({ type: "result", subtype: "success", result: `Achei ${leakedLine} no .env`, total_cost_usd: 0.1 }));
    expect(leaked.finalText).not.toContain("abcdef0123456789abcdef");
  });
});
