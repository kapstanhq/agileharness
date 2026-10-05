// O VÍNCULO DO SERVIDOR entre a requisição MCP e a sessão da frota que ela diz ser.
//
// O rótulo `session:<id>` (mcp/caller.ts) é o que o agente DECLARA — atribuição. Para o que decide POR SESSÃO (a herança
// da cadeia de conserto de revisão — review-rounds-agent.ts) vale só a sessão PROVADA: o rótulo veio com a prova que o
// serviço cunhou para ela (mcp/session-proof.ts) e a sessão está viva no registro (sem `endedAt`). Rótulo sem prova, com
// prova errada, ou de sessão encerrada ⇒ ignorado para decidir, e REGISTRADO no log do serviço (uma vez por sessão e
// motivo, por hora — um agente insistindo não inunda o log).

import type { McpActor } from "@/lib/storymap/mcp/actor";
import { sessionProofSecret, verifySessionProof } from "@/lib/storymap/mcp/session-proof";
import type { AgentSession } from "./session-worktree";

export type SessionBinding =
  /** a requisição não se declarou sessão. */
  | { state: "none" }
  /** declarou e PROVOU — e a sessão está viva no registro. */
  | { state: "bound"; session: AgentSession }
  /** declarou sem provar (ou a sessão não está viva): vale só como atribuição. */
  | { state: "unproven"; sessionId: string; why: string };

export interface SessionBindingDeps {
  sessions: () => Promise<AgentSession[]>;
  secret: () => string;
  log: (line: string) => void;
  now: () => number;
}

const LOG_EVERY_MS = 60 * 60_000;
const lastLogged = new Map<string, number>();

function defaultDeps(): SessionBindingDeps {
  return {
    sessions: async () => (await import("./session-worktree")).allSessions(),
    secret: () => sessionProofSecret(),
    log: (line) => console.warn(line),
    now: () => Date.now(),
  };
}

/** A sessão PROVADA da requisição (ou por que o rótulo não vale para decidir). Nunca lança. */
export async function sessionBindingOf(actor: McpActor | undefined, deps: Partial<SessionBindingDeps> = {}): Promise<SessionBinding> {
  const d = { ...defaultDeps(), ...deps };
  const caller = actor?.caller;
  if (caller?.kind !== "session") return { state: "none" };
  const sessionId = caller.id;
  const unproven = (why: string): SessionBinding => {
    const key = `${sessionId}|${why}`;
    const at = d.now();
    if ((lastLogged.get(key) ?? -Infinity) + LOG_EVERY_MS <= at) {
      lastLogged.set(key, at);
      d.log(`[session-binding] rótulo «session:${sessionId}» IGNORADO para decidir por sessão (${why}) — vale só como atribuição`);
    }
    return { state: "unproven", sessionId, why };
  };
  if (!verifySessionProof(sessionId, caller.proof, d.secret())) return unproven(caller.proof ? "prova errada" : "sem prova");
  let sessions: AgentSession[];
  try {
    sessions = await d.sessions();
  } catch {
    return unproven("registro de sessões ilegível");
  }
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (!session) return unproven("sessão fora do registro");
  if (session.endedAt) return unproven("sessão encerrada");
  return { state: "bound", session };
}

/** Só para testes: zera o controle de repetição do log. */
export function resetSessionBindingLogForTests(): void {
  lastLogged.clear();
}
