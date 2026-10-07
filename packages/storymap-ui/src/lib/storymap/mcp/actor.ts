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
//
// ATRIBUIÇÃO POR PAPEL (fase 6). O ledger de transições gravava TODO movimento de agente como `run:orch` — condutores,
// o tique do Jido e a sessão externa do dono eram indistinguíveis, e um movimento do próprio dono, feito por uma
// sessão de operador, pareceu «um agente desfazendo o que eu fiz». Agora a requisição carrega o PAPEL real
// ({@link actorRole}): `conductor:<card>`, `sentinel`, `chat`, `proxy`, `critic`, `external:<nome>`, `session:<nome>`.
// O papel vem do rótulo que o agente declara (mcp/caller.ts — ATRIBUIÇÃO, nunca autorização) e, para uma sessão, do
// registro de sessões (qual card ela conduz), que a guarda resolve uma vez por chamada e deixa no ator
// ({@link noteResolvedRole}) para as escritas síncronas da mesma requisição.

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
  /** o papel já resolvido (com o registro de sessões) pela guarda desta requisição — ver {@link noteResolvedRole}. */
  resolvedRole?: ActorRole;
  /** o rótulo do HANDLE que autenticou (lib/auth/mcp-handle.ts) — o que prova um papel do serviço (mcp/caller.ts). */
  credentialLabel?: string;
}

/**
 * QUEM agiu, por papel. `human` = o operador (token full sem rótulo de agente) ou uma ação da UI; `external:anon` = um
 * agente escopado que não se nomeou (o que antes era `run:orch`).
 */
export type ActorRole =
  | "human"
  | "sentinel"
  | "chat"
  | "proxy"
  | "critic"
  | `conductor:${string}`
  | `external:${string}`
  | `session:${string}`;

/** O tipo do papel — a chave do limite por hora (todos os condutores dividem o balde `conductor`). */
export type ActorRoleKind = "human" | "sentinel" | "chat" | "proxy" | "critic" | "conductor" | "external" | "session";

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

/**
 * Um AGENTE está chamando — não o dono na tela nem o conector dele: um token escopado, ou o token do operador com o
 * rótulo de um agente (a conversa do Jido). É a régua dos portões que um juiz independente segura (o plano aprovado, a
 * entrega verificada): o chat tem os poderes do dono, mas é um agente que escreve o que move — o dono pela tela passa.
 */
export function isAgentActor(): boolean {
  const a = STORE.getStore();
  if (!a) return false;
  if (a.level !== "full") return true;
  return actorRole(a) !== "human";
}

/** O rótulo é o da conversa do Jido (o chat do board ou a de uma página de documento)? PURA. */
export function isChatCaller(c: McpCaller | null | undefined): boolean {
  return c?.kind === "copilot-chat" || c?.kind === "doc-chat";
}

/**
 * O PAPEL do ator. PURA. `session` = o que o registro de sessões diz da sessão chamadora (o card que ela conduz); sem
 * ele, uma sessão é dita pelo id. Um rótulo declarado vence o nível do token (o chat do Copiloto usa o token full e
 * continua sendo o `chat`, não o dono).
 */
export function actorRole(actor: McpActor | undefined, session?: CallerSessionFacts | null): ActorRole {
  if (!actor) return "human";
  if (actor.resolvedRole && session === undefined) return actor.resolvedRole;
  const c = actor.caller;
  if (c) {
    if (isChatCaller(c)) return "chat";
    // o tique autônomo do Jido foi substituído pela Sentinela: um rótulo de tique antigo é ela
    if (c.kind === "copilot-tick" || c.kind === "sentinel") return "sentinel";
    if (c.kind === "proxy") return "proxy";
    if (c.kind === "critic") return "critic";
    if (c.kind === "external") return `external:${c.id}`;
    if (c.kind === "session") {
      if (session?.driver === "conductor" && session.cardId) return `conductor:${session.cardId}`;
      return `session:${session?.name?.trim() || c.id}`;
    }
  }
  return actor.level === "full" ? "human" : "external:anon";
}

/** O tipo de um papel gravado (`conductor:story-x` → `conductor`). Texto fora do vocabulário ⇒ `external`. PURA. */
export function roleKindOf(role: string): ActorRoleKind {
  const head = role.includes(":") ? role.slice(0, role.indexOf(":")) : role;
  switch (head) {
    case "human":
    case "sentinel":
    case "chat":
    case "proxy":
    case "critic":
    case "conductor":
    case "session":
    case "external":
      return head;
    default:
      return "external";
  }
}

/** A guarda resolveu o papel (com o registro de sessões): guarda no ator para as escritas da MESMA requisição. */
export function noteResolvedRole(actor: McpActor, role: ActorRole): void {
  actor.resolvedRole = role;
}

/**
 * A atribuição de autoria p/ o ledger de transições: o PAPEL do ator corrente ({@link actorRole}) — `human` fora de um
 * request MCP ou para o operador. Era `run:orch` para todo agente.
 */
export function transitionActorLabel(): ActorRole {
  return actorRole(STORE.getStore());
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
