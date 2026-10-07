// orchestrator-spawn.ts — o que SOBROU do spawn do tique antigo do Jido (WS8/F7). A fase 6 trocou o tique que RETOMAVA a
// conversa do chat (Opus, ~200 mil tokens) pela SENTINELA (runner/sentinel*.ts: sessão nova, Sonnet, uma por causa), e o
// lançador antigo saiu com tudo o que só ele usava (o prompt de acordar, a stance só-negócio, o parser do resultado). Ficam
// as duas peças que outros leem: o JSON de MCP que aponta um filho headless para o MCP deste serviço (sessões, chat) e a
// forma do prompt antigo do tique (o histórico do chat ainda reconhece esses turnos — copilot/tick-turn.ts).

import { MCP_CALLER_HEADER, callerTag, type McpCaller } from "@/lib/storymap/mcp/caller";
import { SESSION_PROOF_HEADER } from "@/lib/storymap/mcp/session-proof";
import type { OrchestratorMode } from "@/lib/storymap/types";

/** Build the MCP config JSON that points a headless run at THIS service's AgileHarness MCP endpoint. The token is
 *  the URL `secret` segment; 6.5 — level enforcement is now REAL server-side (register.ts filters the tool
 *  surface by the token's McpLevel), so a scoped `write` orchestrator token never even mounts deploy/destructive
 *  tools. Pair this with the spawn's `--strict-mcp-config` and a `--tools` allowlist for defense in depth. PURE. */
export function buildOrchestratorMcpConfig(token: string, port: number, caller?: McpCaller, sessionProof?: string | null): string {
  return JSON.stringify({
    mcpServers: {
      storymap: {
        type: "http",
        url: `http://localhost:${port}/api/mcp/${token}/mcp`,
        // QUEM chama (mcp/caller.ts): a frota inteira entra pelo mesmo token, e sem este rótulo a trilha de auditoria e
        // o diário do board não sabiam dizer qual agente fez o quê. Atribuição, nunca autorização. Uma SESSÃO leva ao
        // lado a prova que o serviço cunhou para ela (mcp/session-proof.ts) — é o que liga a requisição à sessão para o
        // que decide por sessão (a herança da cadeia de conserto de revisão).
        ...(caller
          ? {
              headers: {
                [MCP_CALLER_HEADER]: callerTag(caller),
                ...(caller.kind === "session" && sessionProof ? { [SESSION_PROOF_HEADER]: sessionProof } : {}),
              },
            }
          : {}),
      },
    },
  });
}

/** O prompt do tique ANTIGO (o histórico do chat ainda tem esses turnos). `reason` (o evento que acordou o Jido) entra como CONTEXTO — argv é um array (sem
 *  shell), então não há injeção; ainda assim achatamos aspas/quebras p/ o prompt ficar legível. PURA. */
export function buildOrchestratorPrompt(board: string, mode: OrchestratorMode, reason?: string): string {
  const base = `/harness-orchestrator ${board} ${mode} --tick`;
  const clean = reason
    ?.replace(/[\n\r"]+/g, " ")
    .replace(/\s+/g, " ") // colapsa o que sobrou (senão o motivo chega ao agente cheio de espaços duplos)
    .trim()
    .slice(0, 160);
  return clean ? `${base} --motivo "${clean}"` : base;
}
