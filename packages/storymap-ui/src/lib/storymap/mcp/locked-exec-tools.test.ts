// As duas portas MCP da EXECUÇÃO APROVADA: `propose_locked_command` (o agente propõe — nada roda) e
// `locked_command_status` (só leitura, SEM a saída dos comandos). Aprovar não tem tool: é a server action do dono.
// Fixtures INVENTADAS (o cofre de chaves de um ateliê fictício).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

let service: import("../runner/locked-exec-service").LockedExecService | null = null;
vi.mock("@/lib/storymap/runner/locked-exec-service", async (orig) => {
  const actual = await orig<typeof import("../runner/locked-exec-service")>();
  return { ...actual, getLockedExecService: () => service! };
});
// o guard por chamada (matriz de risco) tem os testes dele; aqui ele deixa passar, para medir a régua de ESCOPO da tool
// — e para nenhum pedido de aprovação do guard ser gravado no board-data do checkout que roda a suíte.
vi.mock("./guard", async (orig) => ({ ...(await orig<typeof import("./guard")>()), guardToolCall: async () => null }));
let sessions: Array<{ sessionId: string; cardId?: string; task?: string; driver?: string }> = [];
vi.mock("@/lib/storymap/runner/session-worktree", async (orig) => ({
  ...(await orig<typeof import("../runner/session-worktree")>()),
  allSessions: async () => sessions,
}));

import { registerStorymapTools } from "./tools";
import { levelAllows } from "./register";
import { runWithMcpActor } from "./actor";
import { LockedExecService } from "../runner/locked-exec-service";

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  registerStorymapTools({ registerTool: (name: string, _m: unknown, h: ToolHandler) => void out.set(name, h) } as unknown as McpServer);
  return out;
}
const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

let dir: string;
let ran: string[];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "locked-exec-tools-"));
  ran = [];
  sessions = [];
  service = new LockedExecService({
    stateDir: () => dir,
    classifier: () => ({
      ok: true,
      classify: async (argv) => ({
        ok: true,
        c: argv[1] === "rotate" ? { locked: true, approvable: true } : argv[1] === "destroy" ? { locked: true, approvable: false, reason: "apagar o cofre" } : { locked: false, approvable: false },
      }),
    }),
    run: async (argv) => (ran.push(argv.join(" ")), { exitCode: 0, stdout: 'segredo {"client_secret": "nao-volta"}', stderr: "" }),
    notify: () => {},
    wake: () => {},
    log: () => {},
    repoRoot: () => "/srv/alvo",
    defer: (fn) => fn(),
    resolveProgram: (a) => ({ ok: true, path: a.startsWith("/") ? a : `/opt/cofre/bin/${a}` }),
    // o host libera `rotate` para conferir de propósito: «liberado» não dispensa «não travado» (o caso abaixo)
    checkPrefixes: () => ({ ok: true, prefixes: [["cofre-cli", "status"], ["cofre-cli", "verifica"], ["cofre-cli", "rotate"]] }),
    workDir: async () => ({ path: "/lx-passo", cleanup: async () => {} }),
    exists: () => false,
    cardExists: async (b, c) => b === "atelie" && c === "story-ex7001",
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = {
  board: "atelie",
  cardId: "story-ex7001",
  summary: "Troca a chave de API do cofre por uma nova e guarda a anterior por um ciclo.",
  argv: ["cofre-cli", "rotate", "--key=api"],
  undoArgv: null,
  noUndoPlan: "Voltar à chave anterior pelo painel do cofre, com o operador.",
  preflight: [{ label: "o cofre existe", argv: ["cofre-cli", "status"] }],
  verify: [{ label: "a chave nova está ativa", argv: ["cofre-cli", "verifica"], expectStdoutIncludes: "ativa" }],
};
const propose = (args: Record<string, unknown>) => handlers().get("propose_locked_command")!(args);

describe("propose_locked_command", () => {
  it("grava o pedido pendente, devolve os programas resolvidos e NÃO roda nada (nem o preflight)", async () => {
    const r = await propose(call);
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({ ok: true, status: "pending", id: expect.stringMatching(/^lx-/), programas: { main: "/opt/cofre/bin/cofre-cli" } });
    expect(ran).toEqual([]);
  });

  it.each([
    ["não travado", { argv: ["cofre-cli", "status"] }, /não está travado/],
    ["não aprovável", { argv: ["cofre-cli", "destroy"] }, /não deixa este comando ganhar o botão/],
    ["conferência liberada pelo host mas TRAVADA", { verify: [{ label: "x", argv: ["cofre-cli", "rotate", "--de-novo"] }] }, /conferência #1 é um comando travado/],
    ["conferência fora da lista do host", { verify: [{ label: "x", argv: ["cofre-cli", "inventory"] }] }, /não é um comando que o servidor liberou/],
    ["argumento que lê arquivo", { argv: ["cofre-cli", "rotate", "--de-arquivo=/tmp/pedido.yaml"] }, /parece um caminho de arquivo/],
    ["verify vazio", { verify: [] }, /verify/],
    ["interpretador", { argv: ["python3", "-c", "print(1) # $(cofre-cli rotate --key=todos)"] }, /sintaxe de shell|executa o que vier/],
    ["interpretador puro", { argv: ["/usr/bin/env", "cofre-cli", "rotate"] }, /executa o que vier/],
    ["metacaractere", { argv: ["cofre-cli", "rotate", "--key=a|b"] }, /sintaxe de shell/],
    ["card inexistente", { cardId: "story-ex0000" }, /card não encontrado/],
    ["board inexistente", { board: "outro" }, /card não encontrado/],
  ])("recusa: %s", async (_n, over, re) => {
    const r = await propose({ ...call, ...over });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(re as RegExp);
    expect(ran).toEqual([]);
  });

  it("escopo: um agente escopado só propõe para o card da sessão que conduz", async () => {
    sessions = [{ sessionId: "s1", cardId: "story-ex7001" }, { sessionId: "s2", cardId: "story-ex7002" }];
    const other = await runWithMcpActor({ level: "orch", caller: { kind: "session", id: "s2" } }, () => propose(call));
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/só propõe para o card que conduz/);
    const anon = await runWithMcpActor({ level: "write" }, () => propose(call));
    expect(text(anon)).toMatch(/não conduz nenhum/);
    const mine = await runWithMcpActor({ level: "orch", caller: { kind: "session", id: "s1" } }, () => propose(call));
    expect(mine.isError).toBeFalsy();
  });

  // story-ex9603 (acabamento): quem pede é dito pela tarefa que a sessão declarou ao abrir — numa linha, sem caractere de
  // controle/bidi, curta — ou pelo condutor do card; nunca pelo uuid cru da sessão.
  it("quem pediu: a tarefa declarada da sessão (limpa e curta) ou o condutor do card — nunca o uuid", async () => {
    sessions = [{ sessionId: "00000000-0000-4000-8000-0000000000a1", cardId: "story-ex7001", task: "trocar a chave\n\u202eda API do cofre de chaves do ateliê, com calma e sem pressa nenhuma hoje" }];
    const r = await runWithMcpActor({ level: "orch", caller: { kind: "session", id: "00000000-0000-4000-8000-0000000000a1" } }, () => propose(call));
    const rec = (await service!.get(JSON.parse(text(r)).id as string))!;
    expect(rec.proposedBy.startsWith("session:trocar a chave da API do cofre")).toBe(true);
    expect(rec.proposedBy).not.toMatch(/[\n\u202e]/);
    expect(rec.proposedBy).not.toContain("00000000-0000-4000");
    expect(rec.proposedBy.length).toBeLessThanOrEqual("session:".length + 60);
    sessions = [{ sessionId: "c9", cardId: "story-ex7001", driver: "conductor" }];
    const c = await runWithMcpActor({ level: "orch", caller: { kind: "session", id: "c9" } }, () => propose({ ...call, argv: ["cofre-cli", "rotate", "--key=outra"] }));
    expect((await service!.get(JSON.parse(text(c)).id as string))!.proposedBy).toBe("conductor:story-ex7001");
  });

  it("limite de pendentes por card", async () => {
    await propose(call);
    await propose({ ...call, argv: ["cofre-cli", "rotate", "--key=api-2"] });
    const third = await propose({ ...call, argv: ["cofre-cli", "rotate", "--key=api-3"] });
    expect(text(third)).toMatch(/já tem 2 pedidos/);
  });

  it("a montagem: propor é escrita (write/orch), nunca leitura; o status é leitura", () => {
    const ann = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
    expect(levelAllows("ro", "propose_locked_command", ann)).toBe(false);
    expect(levelAllows("write", "propose_locked_command", ann)).toBe(true);
    expect(levelAllows("ro", "locked_command_status", { readOnlyHint: true })).toBe(true);
  });

  it("nenhuma tool de APROVAR/DESFAZER existe", () => {
    const names = [...handlers().keys()].filter((n) => /locked/.test(n)).sort();
    expect(names).toEqual(["locked_command_status", "propose_locked_command"]);
  });
});

describe("locked_command_status — sem a saída dos comandos (S4)", () => {
  it("devolve o passo, se passou e o código; nunca stdout/stderr", async () => {
    const id = JSON.parse(text(await propose({ ...call, undoArgv: ["cofre-cli", "rollback"], noUndoPlan: undefined }))).id as string;
    const rec = (await service!.get(id))!;
    await service!.approve({ id, hash: rec.hash, caller: "operator-session" });
    await service!.flush();
    const st = text(await handlers().get("locked_command_status")!({ id }));
    const body = JSON.parse(st);
    expect(body.results.length).toBeGreaterThan(0);
    for (const r of body.results) expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(["exitCode", "ok", "step"]));
    expect(st).not.toMatch(/stdout|stderr|client_secret|nao-volta|segredo/);
  });
});
