// A tool MCP `sync_skills` de ponta a ponta sobre árvores REAIS (tmp): a escrita passa pelo MECANISMO CERTO — um
// worktree de SESSÃO (openSessionWorktree) e a submissão ao merge train (submitSessionWork) — e NUNCA toca o
// checkout de runtime do alvo. As funções do ciclo de sessão são as reais do módulo, espionadas; o registro, o
// git e o train ficam de fora (o worktree é um diretório tmp).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const { roots, open, submit, discard } = vi.hoisted(() => ({
  roots: { tool: "", target: "", worktree: "" },
  open: vi.fn(),
  submit: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("@/lib/storymap/runner/session-worktree", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/runner/session-worktree")>()),
  openSessionWorktree: open,
  submitSessionWork: submit,
  discardSessionWorktree: discard,
}));
// A matriz de risco de escopo REPO (settings.yaml) com `write-board: auto` — é o que deixa a chamada de um token
// escopado CHEGAR ao handler (senão o guard a segura antes, e o teste da recusa de overwrite provaria o guard, não
// a tool).
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  return {
    ...actual,
    loadRunnerConfig: () => {
      const real = actual.loadRunnerConfig();
      return { ...real, orchestrator: { ...real.orchestrator!, riskMatrix: { "write-board": "auto" as const } } };
    },
  };
});
vi.mock("@/lib/storymap/paths", async (orig) => ({
  ...(await orig<typeof import("@/lib/storymap/paths")>()),
  findToolRoot: () => roots.tool,
  findRepoRoot: () => roots.target,
}));

import { registerDevTools } from "./dev-tools";
import { runWithMcpActor } from "./actor";
import { riskClassForTool } from "./register";
import { resolveToolScope } from "./scope";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
function handler(): Handler {
  const map = new Map<string, Handler>();
  const server = { registerTool: (name: string, _m: unknown, h: Handler) => map.set(name, h) } as unknown as McpServer;
  registerDevTools(server);
  return map.get("sync_skills")!;
}

const tmp: string[] = [];
function tree(skills: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ah-sync-"));
  tmp.push(root);
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(path.join(root, ".claude", "skills", name), { recursive: true });
    writeFileSync(path.join(root, ".claude", "skills", name, "SKILL.md"), body);
  }
  return root;
}
const skill = (root: string, name: string) => path.join(root, ".claude", "skills", name, "SKILL.md");

beforeEach(() => {
  roots.tool = tree({ "harness-conductor": "condutor", "harness-qa": "qa v0.7", "harness-grill": "grill" });
  roots.target = tree({ "harness-qa": "qa customizada", "harness-grill": "grill" });
  roots.worktree = tree({ "harness-qa": "qa customizada", "harness-grill": "grill" }); // a base de integração
  open.mockReset().mockImplementation(async () => ({ ok: true, session: { sessionId: "s-1", worktreePath: roots.worktree } }));
  submit.mockReset().mockResolvedValue({ ok: true, entryId: "s-1", pinnedSha: "0123456789abcdef", committed: true });
  discard.mockReset().mockResolvedValue({ ok: true, branchPreserved: false, detail: "" });
});
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

describe("sync_skills (MCP) — a escrita pelo mecanismo certo", () => {
  it("copia a que FALTA para o worktree de SESSÃO e submete ao train; o runtime do alvo fica intocado", async () => {
    const out = await handler()({});
    expect(out.isError).toBeFalsy();
    const res = JSON.parse((out.content[0] as { text: string }).text);
    expect(res).toMatchObject({ ok: true, submitted: true, sessionId: "s-1", copied: ["harness-conductor"], overwritten: [] });

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][1]).toMatchObject({ task: expect.stringContaining("sync_skills: harness-conductor") });
    expect(readFileSync(skill(roots.worktree, "harness-conductor"), "utf8")).toBe("condutor");
    expect(submit).toHaveBeenCalledWith(expect.anything(), { sessionId: "s-1", message: expect.stringMatching(/faltavam: harness-conductor/) });

    // o checkout de runtime: nada novo, nada trocado
    expect(existsSync(skill(roots.target, "harness-conductor"))).toBe(false);
    expect(readFileSync(skill(roots.target, "harness-qa"), "utf8")).toBe("qa customizada");
    // …e a customizada também não foi tocada no worktree (ninguém pediu)
    expect(readFileSync(skill(roots.worktree, "harness-qa"), "utf8")).toBe("qa customizada");
  });

  it("com overwrite (operador), a que difere é trocada NO WORKTREE — nunca no runtime", async () => {
    const out = await handler()({ overwrite: ["harness-qa"] });
    const res = JSON.parse((out.content[0] as { text: string }).text);
    expect(res).toMatchObject({ overwritten: ["harness-qa"] });
    expect(readFileSync(skill(roots.worktree, "harness-qa"), "utf8")).toBe("qa v0.7");
    expect(readFileSync(skill(roots.target, "harness-qa"), "utf8")).toBe("qa customizada");
  });

  it("um token ESCOPADO não sobrescreve: overwrite recusado PELA TOOL, nada aberto nem escrito", async () => {
    const out = await runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, () => handler()({ overwrite: ["harness-qa"] }));
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/overwrite. só com o token full/);
    expect(open).not.toHaveBeenCalled();
    expect(readFileSync(skill(roots.worktree, "harness-qa"), "utf8")).toBe("qa customizada");
  });

  it("…e o mesmo token escopado SEM overwrite traz as que faltam (write-board, como board-data)", async () => {
    const out = await runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, () => handler()({}));
    expect(out.isError).toBeFalsy();
    expect(existsSync(skill(roots.worktree, "harness-conductor"))).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("dryRun e 'nada falta' não abrem worktree", async () => {
    await handler()({ dryRun: true });
    roots.target = tree({ "harness-conductor": "condutor", "harness-qa": "qa customizada", "harness-grill": "grill" });
    await handler()({});
    expect(open).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("a classe é write-board (como as escritas de board-data) e o escopo é do REPO", async () => {
    expect(riskClassForTool("sync_skills")).toBe("write-board");
    expect(await resolveToolScope("sync_skills", {})).toEqual({ kind: "repo" });
  });
});
