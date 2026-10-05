// A PROVA DE SESSÃO — o vínculo do SERVIDOR entre uma requisição MCP e a sessão da frota que ela diz ser.
//
// POR QUE EXISTE: o rótulo `x-agileharness-caller: session:<id>` é o que o agente declara de si (mcp/caller.ts) — toda
// a frota entra pelo MESMO token, então qualquer agente pode se dizer «a sessão X». Para ATRIBUIÇÃO isso basta; para o
// que DECIDE por sessão (a herança da cadeia de conserto de revisão — runner/review-rounds-agent.ts) não: um rótulo falso
// apontaria a cadeia de outro card. A prova é um HMAC do sessionId com o segredo do serviço, que só o serviço cunha: ele a
// escreve na configuração de MCP da sessão que abre (session-spawn.ts) e a devolve a quem abre a sessão pelo
// `worktree_open`. Sem a prova certa no cabeçalho `x-agileharness-session-proof`, o rótulo vale só como atribuição.
//
// LIMITE (documentado): um agente com acesso de leitura ao diretório de estado do serviço lê a configuração de outra
// sessão — a prova fecha o «basta declarar», não o host em que todo agente roda com o mesmo usuário.

import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecretsFromEnv, type EnvLike } from "@/lib/auth/env";

/** O cabeçalho em que a sessão apresenta a prova. */
export const SESSION_PROOF_HEADER = "x-agileharness-session-proof";

const PROOF_RE = /^[0-9a-f]{32}$/;
/** abaixo disso o segredo não serve de chave (o mesmo piso do login usa {@link authSecretsFromEnv}). */
const MIN_SECRET_LEN = 16;

/** A prova da sessão `sessionId` sob `secret` (32 hex), ou null sem segredo utilizável. PURA. */
export function sessionProofFor(sessionId: string, secret: string): string | null {
  if (!sessionId || !secret || secret.length < MIN_SECRET_LEN) return null;
  return createHmac("sha256", secret).update(`agileharness/session-proof/v1:${sessionId}`).digest("hex").slice(0, 32);
}

/** A prova apresentada é a da sessão? Comparação em tempo constante; formato fora do contrato ⇒ false. PURA. */
export function verifySessionProof(sessionId: string, proof: string | null | undefined, secret: string): boolean {
  if (!proof || !PROOF_RE.test(proof)) return false;
  const want = sessionProofFor(sessionId, secret);
  if (!want) return false;
  return timingSafeEqual(Buffer.from(want, "utf8"), Buffer.from(proof, "utf8"));
}

/** O valor do cabeçalho, ou null quando ausente/fora do formato (nunca aceita texto livre). PURA. */
export function parseSessionProof(raw: string | null | undefined): string | null {
  const text = raw?.trim().toLowerCase();
  return text && PROOF_RE.test(text) ? text : null;
}

/** O segredo do serviço que assina as provas (o mesmo da sessão do operador). */
export function sessionProofSecret(env: EnvLike = process.env): string {
  return authSecretsFromEnv(env).sessionSecret;
}

/** A prova da sessão com o segredo deste serviço (o que o spawn e o `worktree_open` entregam). */
export function currentSessionProof(sessionId: string): string | null {
  return sessionProofFor(sessionId, sessionProofSecret());
}
