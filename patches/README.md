# patches/

Correções versionadas de dependências de terceiros, aplicadas pelo próprio `bun install` (`patchedDependencies` no
`package.json` raiz; fluxo oficial: `bun patch <pkg>` → editar → `bun patch --commit`). Cada patch tem um teste que falha sem ele.

## `mcp-handler@1.1.0.patch`

**Defeito.** `createServerResponseAdapter` entrega ao Next um `ReadableStream` sem `cancel`, e o `write()` do objeto que
imita o `ServerResponse` faz `controller.enqueue(data)` sem guarda. Quando o cliente MCP desliga no meio de uma chamada longa
(`worktree_submit` espera o gate do merge train por minutos) e o Next cancela o corpo, o resultado da tool chega depois e o
`enqueue` lança `Invalid state: Controller is already closed` — um `unhandledRejection` no log do serviço (45 ocorrências em 29/09).

**Conserto.** `cancel()` no stream (marca fechado e emite `close`, que o `@hono/node-server` usa para parar de ler) e `write()`
que descarta o que chegar depois. O `write()` devolve `true` (e não `false`) de propósito: o hono trata `false` como
contrapressão e espera um `drain` que este objeto nunca emite — devolver `false` a um consumidor que já foi embora penduraria a
chamada.

**Upstream.** `mcp-handler@1.1.0` é a última 1.x; a 2.x exige migrar o servidor inteiro para `@modelcontextprotocol/server` v2
(outra API). Um terceiro (motir-core, PR #3081) chegou ao mesmo diagnóstico e ao mesmo remédio.
**Remover** este patch quando o servidor migrar para a 2.x (ou se uma 1.x corrigida sair) — o teste abaixo diz se a versão nova já resolve.

**Teste.** `packages/storymap-ui/src/app/api/mcp/mcp-client-hangup.test.ts` (reproduz o erro de produção sem o patch).
