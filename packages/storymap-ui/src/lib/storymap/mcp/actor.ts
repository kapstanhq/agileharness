// F5.1 — a IDENTIDADE do ator MCP da requisição em curso, propagada por AsyncLocalStorage. route.ts resolve o
// token da URL → um McpActor {level, tokenEnv} e roda o handler DENTRO de runWithMcpActor; qualquer server
// action / guard alcançado SÍNCRONO na cadeia async do request lê currentMcpActor(). É o que deixa o guard por
// chamada (5.2) e a atribuição do ledger (5.1) distinguirem um agente escopado (tick, token `write`) do
// operador humano (`full`) — sem passar um parâmetro `actor` por toda a árvore de chamadas.
//
// FRONTEIRA (documentada no design 5.1): o store SÓ existe no caminho SÍNCRONO do request. Efeitos
// fire-and-forget (`void ENTRY_EFFECTS[...]`, evaluateAutorunOnEntry, fs.watch→trigger-runner) rodam FORA
// dessa cadeia → currentMcpActor() é undefined lá (fail-open p/ "full"/interno). O guard de 5.3 roda ANTES do
// commit do move (síncrono), então os efeitos pós-commit já nascem de um move aprovado; o risco residual seria
// um efeito que RE-dispara uma ação guardada fora do request — por isso o guard trata actor ausente como
// interno/full e as ações guardadas NÃO são dirigidas por efeitos de origem escopada (ver análise no design).

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpLevel } from "@/lib/storymap/types";

export interface McpActor {
  /** o nível de autoridade do token que abriu a requisição (full = operador; write/ro = agente escopado). */
  level: McpLevel;
  /** o env-var que segura o token (p/ auditoria); undefined p/ o token primário do operador. */
  tokenEnv?: string;
}

const STORE = new AsyncLocalStorage<McpActor>();

/** Roda `fn` com `actor` como o ator MCP corrente (route.ts embrulha o handler por request). */
export function runWithMcpActor<T>(actor: McpActor, fn: () => T): T {
  return STORE.run(actor, fn);
}

/** O ator MCP da requisição corrente, ou undefined fora de um request MCP (chamada interna do serviço). */
export function currentMcpActor(): McpActor | undefined {
  return STORE.getStore();
}

/** True quando o chamador é um AGENTE ESCOPADO (token != full). Ausente/full ⇒ false (operador ou interno). */
export function isScopedActor(): boolean {
  const a = STORE.getStore();
  return a != null && a.level !== "full";
}

/** A atribuição de autoria p/ o ledger de transições: `run:orch` p/ um ator escopado, senão "human". */
export function transitionActorLabel(): "human" | `run:${string}` {
  return isScopedActor() ? "run:orch" : "human";
}
