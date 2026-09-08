import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendAgentAction,
  flushAgentActions,
  readAgentActions,
  resetAgentActionSink,
  setAgentActionSink,
  type AgentAction,
} from "./agent-actions";

afterEach(() => resetAgentActionSink());

describe("agent-actions audit ledger (F5.6)", () => {
  it("appends one JSON line per guard decision, stamping v + at, fire-and-forget", async () => {
    const lines: string[] = [];
    setAgentActionSink({ append: async (l) => void lines.push(l) });

    await appendAgentAction({ actor: "STORYMAP_MCP_TOKEN_ORCH", board: "acme", tool: "move_card", cls: "write-board", disposition: "auto", outcome: "executed" });
    await appendAgentAction({ board: "acme", tool: "deploy", cls: "deploy", disposition: "ask", outcome: "pending", approvalId: "apr-1" });

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as AgentAction;
    expect(first).toMatchObject({ v: 1, tool: "move_card", cls: "write-board", disposition: "auto", outcome: "executed", actor: "STORYMAP_MCP_TOKEN_ORCH" });
    expect(typeof first.at).toBe("string");
    const second = JSON.parse(lines[1]) as AgentAction;
    expect(second).toMatchObject({ outcome: "pending", approvalId: "apr-1" });
  });

  it("NEVER rejects — a failing sink is swallowed (the audit must not break a tool call)", async () => {
    setAgentActionSink({ append: async () => { throw new Error("disk full"); } });
    // resolves (does not throw) despite the sink error
    await expect(appendAgentAction({ tool: "x", cls: "read", disposition: "auto", outcome: "executed" })).resolves.toBeUndefined();
  });

  // WS-12.1 (D16) — o ledger virou a FONTE da atribuição do backoff por-item, então ele passou a precisar de
  // duas coisas: carregar o cardId, e ser DRENÁVEL (o guard faz fire-and-forget; um leitor que corre logo após
  // a morte do run perderia a última ação — e "não mutou nada" é justamente o veredito que pune todo mundo).
  it("carrega o cardId da chamada, e flushAgentActions espera as escritas já enfileiradas", async () => {
    const lines: string[] = [];
    setAgentActionSink({ append: async (l) => void lines.push(l) });

    void appendAgentAction({ actor: "STORYMAP_MCP_TOKEN_ORCH", board: "acme", cardId: "story-xfleex", tool: "move_card", cls: "write-board", disposition: "auto", outcome: "executed" });
    void appendAgentAction({ board: "acme", cardId: "story-eqpdtz", tool: "update_card", cls: "write-board", disposition: "auto", outcome: "executed" });
    expect(lines).toHaveLength(0); // ainda em voo — é exatamente a corrida que o flush fecha

    await flushAgentActions();
    expect(lines.map((l) => (JSON.parse(l) as AgentAction).cardId)).toEqual(["story-xfleex", "story-eqpdtz"]);
  });
});

describe("readAgentActions — janela + legado (WS-12.1)", () => {
  let dir: string;
  const prev = process.env.STORYMAP_RUNNER_STATE_DIR;
  const T0 = Date.parse("2026-07-16T15:00:00Z");
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({ v: 1, at: new Date(T0).toISOString(), tool: "move_card", cls: "write-board", disposition: "auto", outcome: "executed", ...over }) + "\n";

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-"));
    process.env.STORYMAP_RUNNER_STATE_DIR = dir;
    await fs.writeFile(
      path.join(dir, "agent-actions.jsonl"),
      line({ at: new Date(T0 - 60_000).toISOString(), board: "acme", cardId: "antes" }) +
        line({ board: "acme", cardId: "dentro" }) +
        line({ board: "acme" }) + // LEGADO: linha sem cardId (escrita antes do WS-12)
        "{ lixo não-parseável\n" +
        line({ at: new Date(T0 + 60_000).toISOString(), board: "acme", cardId: "depois" }),
      "utf8",
    );
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
    else process.env.STORYMAP_RUNNER_STATE_DIR = prev;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a janela [since, until] devolve só as ações do run — e a linha corrompida não derruba a leitura", async () => {
    const inWindow = await readAgentActions({ since: T0 - 1_000, until: T0 + 1_000 });
    expect(inWindow.map((a) => a.cardId)).toEqual(["dentro", undefined]);
  });

  it("ledger LEGADO (linhas sem cardId) continua legível — nada de migração (AC5)", async () => {
    const all = await readAgentActions({ board: "acme" });
    expect(all).toHaveLength(4); // as 4 linhas boas; o lixo é pulado
    expect(all.filter((a) => a.cardId === undefined)).toHaveLength(1);
  });

  it("ledger ausente ⇒ [] (a atribuição degrada, nunca lança)", async () => {
    const missing = path.join(dir, "vazio");
    process.env.STORYMAP_RUNNER_STATE_DIR = missing;
    await expect(readAgentActions()).resolves.toEqual([]);
    process.env.STORYMAP_RUNNER_STATE_DIR = dir;
  });
});
