// F5.1 — a IDENTIDADE do ator MCP da requisição em curso, propagada por AsyncLocalStorage. route.ts resolve o
// token da URL → um McpActor {level, tokenEnv} e roda o handler DENTRO de runWithMcpActor; qualquer server
// action / guard alcançado SÍNCRONO na cadeia async do request lê currentMcpActor(). É o que deixa o guard por
// chamada (5.2) e a atribuição do ledger (5.1) distinguirem um agente escopado (tick, token `write`) do
// operador humano (`full`) — sem passar um parâmetro `actor` por toda a árvore de chamadas.
//
// FRONTEIRA — ATENÇÃO: o AsyncLocalStorage ATRAVESSA promessas, `void` fire-and-forget, `import().then` e callbacks
// (inclusive o de saída de processo filho) criados DENTRO do request. Um efeito disparado por um request MCP
// (`void ENTRY_EFFECTS[...]`, o produtor de provas, a auditoria) continua vendo o ator MCP — currentMcpActor() NÃO é
// undefined lá. Só o que nasce fora de um request (fs.watch→trigger-runner, timers do boot) roda sem ator. Por isso:
// trabalho do SERVIÇO que decide por «quem chamou» não pode confiar no contexto — ou declara a origem explicitamente
// (ex.: `createCardAction({ system: true })`) ou roda dentro de `runAsService` (abaixo), que zera o ator.

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpLevel } from "@/lib/storymap/types";
import { callerAttribution, type CallerSessionFacts, type McpCaller } from "./caller";

export interface McpActor {
  /** o nível de autoridade do token que abriu a requisição (full = operador; write/ro = agente escopado). */
  level: McpLevel;
  /** o env-var que segura o token (p/ auditoria); undefined p/ o token primário do operador. */
  tokenEnv?: string;
  /** o rótulo que o agente declarou de si (mcp/caller.ts) — ATRIBUIÇÃO, nunca autorização. */
  caller?: McpCaller;
}

const STORE = new AsyncLocalStorage<McpActor>();

/** Roda `fn` com `actor` como o ator MCP corrente (route.ts embrulha o handler por request). */
export function runWithMcpActor<T>(actor: McpActor, fn: () => T): T {
  return STORE.run(actor, fn);
}

/**
 * Roda `fn` SEM ator MCP: o trabalho do próprio serviço (um efeito, um produtor, uma auditoria) disparado de dentro
 * de um request MCP não herda a identidade do agente que o disparou. Não toca o escopo do request do Next.
 */
export function runAsService<T>(fn: () => T): T {
  return STORE.exit(fn);
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

/**
 * B4 — o rótulo de ATRIBUIÇÃO do ator MCP da requisição corrente (`mcp:<nível>(<env do token>)`, ou o `handle:<id>`
 * que a rota já grava como tokenEnv) — o MESMO formato que as tools de dev já registram. É o que um pedido de
 * aprovação grava como `requestedBy`: antes era "run:orch" para todo agente, e o Inbox dizia «Jido pede» até para
 * uma sessão externa de orquestração. Sem ator (chamada interna) ⇒ "run:orch" (o legado).
 */
export function mcpActorAttribution(actor: McpActor | undefined = STORE.getStore(), session?: CallerSessionFacts | null): string {
  if (!actor) return "run:orch";
  // o rótulo que o agente declarou de si diz mais que a credencial (que toda a frota compartilha)
  const declared = callerAttribution(actor.caller, session);
  if (declared) return declared;
  if (actor.tokenEnv?.startsWith("handle:")) return actor.tokenEnv;
  return `mcp:${actor.level}${actor.tokenEnv ? `(${actor.tokenEnv})` : ""}`;
}
