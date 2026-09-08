// TRAVA DE FORÇA-BRUTA do login — pura, para ser testável sem relógio nem rede.
//
// Lição do ClawJacked (docs/plans/agileharness-oss/07-anexo-pesquisa-seguranca.md, padrão 2): o
// rate-limiter do OpenClaw ISENTAVA loopback, e qualquer página aberta no navegador do operador
// virava um cliente "local confiável" que podia martelar o endpoint à vontade. Aqui **não existe
// isenção de origem**: 127.0.0.1 conta igual a um IP da internet.
//
// Janela deslizante por chave: N falhas dentro de `windowMs` ⇒ bloqueio por `lockoutMs`. Um
// acerto zera a contagem. O estado é um Map em memória do processo — some no restart, o que é
// aceitável e até desejável: o objetivo é encarecer o brute-force de um token de 32 bytes
// (inviável mesmo sem trava), não construir um WAF.

export interface AttemptRecord {
  /** timestamps das falhas ainda dentro da janela. */
  failures: number[];
  /** quando o bloqueio acaba (0 = sem bloqueio). */
  lockedUntil: number;
}

export interface RateLimitPolicy {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
}

export const LOGIN_POLICY: RateLimitPolicy = {
  maxFailures: 8,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
};

export interface RateLimitVerdict {
  allowed: boolean;
  /** ms restantes de bloqueio — vira o `Retry-After` e o contador na tela. */
  retryAfterMs: number;
  /** tentativas que ainda restam antes do bloqueio (0 quando já bloqueado). */
  remaining: number;
}

/** O pedido pode ser tentado agora? Não muta nada — só lê. */
export function checkAttempt(
  state: Map<string, AttemptRecord>,
  key: string,
  now: number,
  policy: RateLimitPolicy = LOGIN_POLICY,
): RateLimitVerdict {
  const rec = state.get(key);
  if (!rec) return { allowed: true, retryAfterMs: 0, remaining: policy.maxFailures };
  if (rec.lockedUntil > now) {
    return { allowed: false, retryAfterMs: rec.lockedUntil - now, remaining: 0 };
  }
  const live = rec.failures.filter((t) => now - t < policy.windowMs);
  return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, policy.maxFailures - live.length) };
}

/** Registra uma FALHA e devolve o veredito já atualizado (podendo ter acabado de bloquear). */
export function recordFailure(
  state: Map<string, AttemptRecord>,
  key: string,
  now: number,
  policy: RateLimitPolicy = LOGIN_POLICY,
): RateLimitVerdict {
  const rec = state.get(key) ?? { failures: [], lockedUntil: 0 };
  const live = rec.failures.filter((t) => now - t < policy.windowMs);
  live.push(now);
  const locked = live.length >= policy.maxFailures;
  const next: AttemptRecord = {
    // Ao bloquear, zera o histórico: o bloqueio JÁ é a punição da janela. Sem isso as falhas
    // antigas sobrevivem ao lockout e a primeira tentativa depois dele re-bloqueia na hora.
    failures: locked ? [] : live,
    lockedUntil: locked ? now + policy.lockoutMs : rec.lockedUntil,
  };
  state.set(key, next);
  return locked
    ? { allowed: false, retryAfterMs: policy.lockoutMs, remaining: 0 }
    : { allowed: true, retryAfterMs: 0, remaining: policy.maxFailures - live.length };
}

/** Login bem-sucedido: limpa a chave. */
export function recordSuccess(state: Map<string, AttemptRecord>, key: string): void {
  state.delete(key);
}

/**
 * Descarta chaves ociosas (sem falhas vivas e sem bloqueio) para o Map não crescer sem fim num
 * serviço de longa duração sendo varrido por scanners com IPs sempre novos.
 */
export function pruneAttempts(
  state: Map<string, AttemptRecord>,
  now: number,
  policy: RateLimitPolicy = LOGIN_POLICY,
): void {
  for (const [key, rec] of state) {
    const liveFailures = rec.failures.some((t) => now - t < policy.windowMs);
    if (!liveFailures && rec.lockedUntil <= now) state.delete(key);
  }
}

/**
 * Identidade do cliente para efeito de trava — o ÚLTIMO salto do `x-forwarded-for`.
 *
 * Atrás de proxy o socket é sempre 127.0.0.1, então sem nenhum header todo mundo dividiria a
 * mesma trava e um atacante trancaria o operador de fora (DoS trivial). A questão é em QUAL
 * header confiar, e isso foi MEDIDO contra o Caddy desta instalação, não suposto:
 *
 *   • `x-forwarded-for` forjado pelo cliente é **descartado**: o Caddy SUBSTITUI o header pelo
 *     peer real (não anexa) quando não há `trusted_proxies` configurado. Mandar
 *     `X-Forwarded-For: 1.2.3.4` chega no app como `127.0.0.1`.
 *   • `x-real-ip` forjado **passa intacto** — o Caddy não escreve nem sanitiza esse header.
 *
 * Daí duas decisões: (1) `x-real-ip` saiu de vez. Era fallback de um header que o atacante
 * controla por completo — bastava rotacioná-lo a cada tentativa para anular a trava. Hoje ele é
 * inalcançável (o XFF do Caddy sempre vence), mas era uma mina para quem trocasse de proxy.
 * (2) usamos o ÚLTIMO elemento do XFF, não o primeiro: o último é o que o NOSSO proxy escreveu;
 * os anteriores, quando existem, vieram de quem chamou. Com um único proxy que substitui (o
 * nosso caso) os dois coincidem — a diferença aparece se alguém puser um CDN na frente, e aí o
 * primeiro passa a ser texto do cliente.
 *
 * Sem XFF (app exposto direto, sem proxy) todos caem num balde só — conservador de propósito:
 * uma trava compartilhada é uma negação de serviço limitada e visível; confiar num header
 * forjável seria não ter trava nenhuma. A segurança real continua sendo o token de 32 bytes.
 */
export function clientKey(headers: Headers, fallback = "sem-proxy"): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",");
    const last = hops[hops.length - 1]?.trim();
    if (last) return last;
  }
  return fallback;
}
