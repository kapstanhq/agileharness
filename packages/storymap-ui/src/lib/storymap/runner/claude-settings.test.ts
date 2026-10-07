import { describe, expect, it } from "vitest";
import { bashGuardHooks, evaluateShellGuard, hardDenyHookInstalled, hookMatcherCoversBash, readInheritedDefaultMode, type RunGuardHook } from "./claude-settings";

const layers = (files: Record<string, unknown>) => (f: string) => {
  if (!(f in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const v = files[f];
  return typeof v === "string" ? v : JSON.stringify(v);
};
const opts = (files: Record<string, unknown>) => ({ home: "/home/op", managedPath: "/etc/managed.json", readFile: layers(files) });

describe("readInheritedDefaultMode — a precedência do CLI", () => {
  it("usuário sozinho decide quando ninguém acima fala", () => {
    expect(readInheritedDefaultMode("/repo", opts({ "/home/op/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } } }))).toBe(
      "bypassPermissions",
    );
  });
  it("projeto vence usuário; local vence projeto; política gerenciada vence todos", () => {
    const base = {
      "/home/op/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } },
      "/repo/.claude/settings.json": { permissions: { defaultMode: "acceptEdits" } },
    };
    expect(readInheritedDefaultMode("/repo", opts(base))).toBe("acceptEdits");
    expect(readInheritedDefaultMode("/repo", opts({ ...base, "/repo/.claude/settings.local.json": { permissions: { defaultMode: "plan" } } }))).toBe("plan");
    expect(readInheritedDefaultMode("/repo", opts({ ...base, "/etc/managed.json": { permissions: { defaultMode: "default" } } }))).toBe("default");
  });
  it("camada sem a chave, ausente ou ilegível cai para a próxima; nada ⇒ undefined", () => {
    expect(
      readInheritedDefaultMode("/repo", opts({ "/repo/.claude/settings.json": { hooks: {} }, "/repo/.claude/settings.local.json": "{ quebrado", "/home/op/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } } })),
    ).toBe("bypassPermissions");
    expect(readInheritedDefaultMode("/repo", opts({}))).toBeUndefined();
  });
});

// A TRAVA DURA do host: o repositório não a traz. Todo poder de shell «sob a trava» pergunta antes se ela existe nos
// settings que a sessão vai carregar — e o serviço a consulta para os caminhos de shell que não passam pela tool Bash.
const guard = (matcher: unknown, command = "node /etc/trava.js") => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command, timeout: 5 }] }] } });

describe("a trava dura do host — instalada?", () => {
  it("um hook PreToolUse que cobre Bash, em qualquer camada (gerenciada, projeto, usuário)", () => {
    expect(hardDenyHookInstalled("/repo", opts({ "/etc/managed.json": guard("Bash") }))).toBe(true);
    expect(hardDenyHookInstalled("/repo", opts({ "/repo/.claude/settings.json": guard("Bash|Edit") }))).toBe(true);
    expect(hardDenyHookInstalled(null, opts({ "/home/op/.claude/settings.json": guard("*") }))).toBe(true);
  });

  it("sem hook, hook de outra tool, ou uma camada que desliga os hooks ⇒ NÃO instalada (o poder cai)", () => {
    expect(hardDenyHookInstalled("/repo", opts({}))).toBe(false);
    expect(hardDenyHookInstalled("/repo", opts({ "/etc/managed.json": guard("Edit") }))).toBe(false);
    expect(hardDenyHookInstalled("/repo", opts({ "/etc/managed.json": guard("Bash"), "/repo/.claude/settings.local.json": { disableAllHooks: true } }))).toBe(false);
  });

  it("sessão sem projeto (cwd temporário): o hook só do PROJETO não vale para ela", () => {
    expect(hardDenyHookInstalled(null, opts({ "/repo/.claude/settings.json": guard("Bash") }))).toBe(false);
    expect(bashGuardHooks("/repo", opts({ "/repo/.claude/settings.json": guard("Bash") }))).toHaveLength(1);
  });

  it("o matcher segue o CLI: ausente/vazio/* casam tudo; regex", () => {
    for (const m of [undefined, "", "*", "Bash", "Bash|Write", "Ba.*"]) expect(hookMatcherCoversBash(m)).toBe(true);
    for (const m of ["Edit", "Write|Edit", "mcp__.*"]) expect(hookMatcherCoversBash(m)).toBe(false);
  });
});

describe("evaluateShellGuard — o serviço pergunta à trava pelos caminhos fora da tool Bash", () => {
  const hooks = [{ source: "/etc/managed.json", command: "trava" }];
  const run = (r: Awaited<ReturnType<RunGuardHook>>): RunGuardHook => async () => r;

  it("exit 2 ou um JSON que nega ⇒ recusado, com o motivo do hook", async () => {
    expect(await evaluateShellGuard("rm -rf /", { hooks, run: run({ code: 2, stdout: "", stderr: "apagar a raiz é proibido" }) })).toEqual({ blocked: true, reason: "apagar a raiz é proibido" });
    const json = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "force-push na principal" } });
    expect(await evaluateShellGuard("git push -f", { hooks, run: run({ code: 0, stdout: json, stderr: "" }) })).toEqual({ blocked: true, reason: "force-push na principal" });
  });

  it("exit 0 ⇒ passa; o payload é o de PreToolUse/Bash com o comando", async () => {
    let seen = "";
    const v = await evaluateShellGuard("git status", { hooks, run: async (_h, p) => ((seen = p), { code: 0, stdout: "", stderr: "" }) });
    expect(v).toEqual({ blocked: false, hooks: 1 });
    expect(JSON.parse(seen)).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } });
  });

  it("a trava que não responde (relógio, binário ausente) RECUSA — fail-closed; sem hook nenhum, nada a perguntar", async () => {
    expect((await evaluateShellGuard("ls", { hooks, run: run({ code: null, stdout: "", stderr: "", error: "timeout" }) })).blocked).toBe(true);
    expect(await evaluateShellGuard("ls", { hooks: [] })).toEqual({ blocked: false, hooks: 0 });
  });
});
