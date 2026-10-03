// QUEM pede uma aprovação, dito em palavras. PURE, client-safe.
//
// O pedido dizia «Jido pede» para qualquer agente — medido: os pedidos vinham de uma sessão externa de
// orquestração (credencial AGILEHARNESS_MCP_TOKEN_ORCH), não do Jido. `requestedBy` agora guarda o ator MCP real
// (mcp/actor.ts `mcpActorAttribution`); aqui ele vira uma frase. Registros antigos dizem "run:orch" para todo agente.

import { callerWords } from "./mcp/caller";

/** «O Jido» / «O condutor do card X» (o agente que se nomeou) / «Um agente com a credencial X» / «Um agente com o acesso H» / «Um agente autônomo» (legado) / «Um agente». */
export function approvalRequesterText(requestedBy: string | null | undefined): string {
  const who = requestedBy?.trim();
  if (!who) return "Um agente";
  // o agente que se nomeou (mcp/caller.ts): «O Jido», «O condutor do card X», «Uma sessão de agente (nome)»
  const named = callerWords(who);
  if (named) return named;
  const handle = /^handle:(.+)$/.exec(who);
  if (handle) return `Um agente com o acesso ${handle[1]}`;
  const env = /^mcp:[a-z]+\(([^)]+)\)$/.exec(who);
  if (env) return `Um agente com a credencial ${env[1]}`;
  if (/^mcp:[a-z]+$/.test(who)) return "Um agente com uma credencial MCP";
  if (who === "run:orch") return "Um agente autônomo";
  return `Um agente (${who})`;
}
