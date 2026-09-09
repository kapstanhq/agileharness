// O PORTÃO DA LANE SAME-ORIGIN, dentro da própria rota (story-14xvpa, passo 2 — issue #2 do repo).
//
// `/api/feedback/intake` e `/api/feedback/shot` saíram de trás do middleware para a lane de INGEST
// (relay servidor-a-servidor, sem cookie) e a lane EMBED (navegador de outra origem, com nonce)
// existirem de verdade. O que o middleware fazia por elas — exigir a sessão do operador — a rota
// passa a fazer AQUI, e só para a lane same-origin: as outras duas trazem a própria prova (token
// timing-safe, nonce cunhado pelo board) e são colapsadas a triage-only.
//
// Por que não confiar só no sinal de origem: `classifyIntake` concede same-origin quando `Origin`
// casa com `Host`, e um `curl` escreve o `Origin` que quiser. O navegador não forja Origin; um cliente
// não-navegador forja. Sem esta verificação, abrir a rota entregaria capacidade plena (reabrir card
// por id, colar texto numa sessão Claude viva) a quem mandasse dois headers.
//
// MESMA `verifySession` do middleware e do gateway do terminal: um único predicado de sessão no
// serviço, o que `oss-docs-truth.test.ts` já cobra para o terminal.
import { authSecretsFromEnv, type EnvLike } from "@/lib/auth/env";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import type { HeaderReader } from "./guard";

/** O mesmo texto do middleware — quem lê o JSON não precisa saber qual camada recusou. */
export const SESSION_REQUIRED_ERROR = "não autenticado — faça login no AgileHarness";

/**
 * Lê UM cookie do header `Cookie` (a rota recebe um `Request` cru, sem `req.cookies`).
 * Casamento por nome exato; o primeiro vence, como no navegador. Valor sem decodificação:
 * a sessão é base64url, que não carrega `;`, `=` ambíguo nem `%`.
 */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v === "" ? undefined : v;
  }
  return undefined;
}

/**
 * A requisição carrega uma sessão VÁLIDA do operador? Fail-closed em tudo: sem cookie, cookie
 * malformado, segredo ausente/fraco na env ⇒ `false` (a `verifySession` já garante isso).
 */
export async function hasBoardSession(
  headers: HeaderReader,
  env: EnvLike = process.env,
  now: number = Date.now(),
): Promise<boolean> {
  const token = readCookie(headers.get("cookie"), SESSION_COOKIE);
  return verifySession({ token, ...authSecretsFromEnv(env), now });
}
