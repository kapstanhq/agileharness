// O cliente MCP que DESLIGA no meio de uma chamada longa não pode gerar `unhandledRejection`.
//
// Sintoma: várias linhas "⨯ unhandledRejection: TypeError: Invalid state: Controller is already closed" no journal do
// serviço, logo depois das linhas do merge gate — isto é, de chamadas MCP longas (worktree_submit espera o gate do
// train por minutos) cujo cliente já tinha ido embora. A causa está em `mcp-handler@1.1.0`: `createServerResponseAdapter`
// entrega ao Next um ReadableStream SEM `cancel` e o seu `write()` faz `controller.enqueue(data)` sem guarda — quando o
// consumidor cancela o corpo e o resultado da tool chega depois, o enqueue lança dentro da cadeia de promessas do transporte.
// Não há versão 1.x corrigida (a 2.x exige migrar para `@modelcontextprotocol/server` v2), então o conserto é um PATCH
// versionado (`bun patch` → patches/mcp-handler@1.1.0.patch). Este teste é o que o protege: ele falha sem o patch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "mcp-handler";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mcp-handler — cliente que desliga no meio de uma tool lenta", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  function handler(toolMs: number) {
    return createMcpHandler(
      (server) => {
        server.tool("slow", "tool lenta de teste", {}, async () => {
          await sleep(toolMs);
          return { content: [{ type: "text" as const, text: "pronto" }] };
        });
      },
      {},
      { basePath: "/api/mcp/teste", disableSse: true, maxDuration: 10, verboseLogs: false },
    );
  }

  const call = () =>
    new Request("http://localhost/api/mcp/teste/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }),
    });

  it("o consumidor CANCELA o corpo antes de a tool terminar ⇒ nenhum unhandledRejection", async () => {
    const res = await handler(120)(call());
    expect(res.status).toBe(200);
    await res.body!.cancel(); // o cliente desligou (e o Next derrubou a resposta)
    await sleep(400); // a tool termina DEPOIS e tenta entregar o resultado num stream que já não existe
    expect(unhandled.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
  });

  it("[CONTROLE] o cliente que NÃO desliga recebe o resultado inteiro — o patch não quebra o caminho feliz", async () => {
    const res = await handler(30)(call());
    const body = await res.text();
    expect(body).toContain("pronto");
    expect(unhandled).toEqual([]);
  });

  it("vários clientes desligando ao mesmo tempo também não vazam rejeição", async () => {
    const h = handler(80);
    const responses = await Promise.all([h(call()), h(call()), h(call())]);
    await Promise.all(responses.map((r) => r.body!.cancel()));
    await sleep(400);
    expect(unhandled).toEqual([]);
  });
});
