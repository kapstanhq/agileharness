// O teste que impede a 4ª ocorrência: toda tool GATED tem de ser CLASSIFICÁVEL em um escopo. A regressão que
// este arquivo trava é silenciosa por natureza — nada quebra quando alguém registra uma tool nova sem chave de
// escopo; ela só passa a ser recusada com um conselho impossível, em produção, meses depois.
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setServerLevel, riskClassForTool } from "./register";
import { registerStorymapTools } from "./tools";
import { registerDevTools } from "./dev-tools";
import { REPO_SCOPED_TOOLS, SCOPE_ARG_KEYS, resolveToolScope } from "./scope";

// Um McpServer FALSO que só grava (nome, chaves do inputSchema) — a mesma técnica de register.test.ts, mas
// guardando também o SCHEMA, que é a evidência de se um board é derivável da assinatura.
function registeredTools(): { name: string; keys: string[] }[] {
  const rows: { name: string; keys: string[] }[] = [];
  const server = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "registerTool"
          ? (name: string, cfg: { inputSchema?: Record<string, unknown> }) =>
              void rows.push({ name, keys: Object.keys(cfg?.inputSchema ?? {}) })
          : () => {},
    },
  ) as unknown as McpServer;
  setServerLevel(server, "full"); // `full` monta TUDO — a superfície máxima é a que precisa ser total
  registerStorymapTools(server);
  registerDevTools(server);
  return rows;
}

describe("escopo de tool — exaustividade", () => {
  it("toda tool gated ou expõe uma chave de escopo, ou é declarada REPO_SCOPED (nenhuma fica órfã)", () => {
    const orphans = registeredTools()
      .filter((t) => riskClassForTool(t.name) !== "read")
      .filter((t) => !t.keys.some((k) => (SCOPE_ARG_KEYS as readonly string[]).includes(k)))
      .filter((t) => !REPO_SCOPED_TOOLS.has(t.name))
      // `cards[]` carrega o board ANINHADO (enqueue_batch) — escopo derivável, só não no topo.
      .filter((t) => !t.keys.includes("cards"))
      .map((t) => `${t.name} (${riskClassForTool(t.name)}) keys=[${t.keys.join(",")}]`);

    expect(
      orphans,
      `Tool(s) gated sem escopo resolvível. Sob um token escopado elas caem em "unscoped" e são RECUSADAS com ` +
        `um conselho que o chamador não tem como seguir. Classifique cada uma: se a ação é de um BOARD, exponha ` +
        `board/sessionId/runId no inputSchema; se é do REPO (stage, suíte, serviço, shell), declare em ` +
        `REPO_SCOPED_TOOLS (scope.ts).`,
    ).toEqual([]);
  });

  it("nenhuma tool declarada REPO_SCOPED deixou de existir (o registro não guarda nome morto)", () => {
    const live = new Set(registeredTools().map((t) => t.name));
    expect([...REPO_SCOPED_TOOLS].filter((n) => !live.has(n))).toEqual([]);
  });
});

describe("resolveToolScope", () => {
  it("args.board explícito vence tudo", async () => {
    await expect(resolveToolScope("update_card", { board: "acme", cardId: "c1" })).resolves.toEqual({
      kind: "board",
      board: "acme",
    });
  });

  it("reconcile_stage (schema sem board) resolve REPO — antes caía em unscoped e era recusada", async () => {
    await expect(resolveToolScope("reconcile_stage", { mode: "sync" })).resolves.toEqual({ kind: "repo" });
  });

  it("um lote de UM board resolve por dentro de cards[] (o board estava aninhado)", async () => {
    const args = { cards: [{ board: "acme", cardId: "a" }, { board: "acme", cardId: "b" }] };
    await expect(resolveToolScope("enqueue_batch", args)).resolves.toEqual({ kind: "board", board: "acme" });
  });

  it("um lote que CRUZA boards não tem dono único ⇒ unscoped (recusa com conselho seguível: divida o lote)", async () => {
    const args = { cards: [{ board: "acme", cardId: "a" }, { board: "orbit", cardId: "b" }] };
    await expect(resolveToolScope("enqueue_batch", args)).resolves.toEqual({ kind: "unscoped" });
  });

  it("uma tool de board SEM board na chamada segue unscoped (o conselho 'nomeie o board' continua honesto)", async () => {
    await expect(resolveToolScope("update_card", { cardId: "c1" })).resolves.toEqual({ kind: "unscoped" });
  });

  it("sessionId desconhecido degrada para unscoped — nunca lança no caminho quente", async () => {
    vi.doMock("@/lib/storymap/runner/session-worktree", () => ({
      makeSessionStore: () => ({ load: async () => { throw new Error("registro ilegível"); } }),
    }));
    await expect(resolveToolScope("worktree_submit", { sessionId: "nao-existe" })).resolves.toEqual({
      kind: "unscoped",
    });
    vi.doUnmock("@/lib/storymap/runner/session-worktree");
  });
});
