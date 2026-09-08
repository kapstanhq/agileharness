// O COOKIE DE SESSÃO da UI — assinado, sem estado no servidor.
//
// Formato: `<payload>.<sig>`, payload = base64url do JSON `{exp}` e sig = HMAC-SHA256 do
// payload sob o segredo do serviço. Sem estado: o servidor não guarda sessão nenhuma, então
// não há tabela para vazar nem GC para escrever; revogar TODAS as sessões = rotacionar o
// segredo (`storymap/.runner/session-secret`).
//
// ⚠️ Web Crypto APENAS — este módulo é importado por `src/middleware.ts`, e o Next 14 roda
// middleware no runtime EDGE, onde `node:crypto` não existe (o runtime nodejs para middleware
// só ficou estável no Next 15.2+). Por isso: `crypto.subtle`, `TextEncoder`, `atob`/`btoa` —
// nada de `Buffer`, nada de `timingSafeEqual`. A comparação constante-no-tempo vem de graça do
// `crypto.subtle.verify`, que é o jeito certo de verificar um MAC (comparar strings de HMAC na
// mão é o oráculo de timing clássico).
//
// O irmão deste módulo é `lib/storymap/mcp/auth.ts` (token do MCP): mesma postura fail-closed,
// mesma recusa a autenticar contra um segredo fraco.

/**
 * OS ATRIBUTOS DO COOKIE — o contrato, num lugar só (story-2i89ai t3).
 *
 * Este módulo assina e verifica o VALOR; quem emite o `Set-Cookie` é `app/api/auth/login/route.ts`.
 * O contrato vivia inteiro naquela chamada, então era invisível de dentro daqui — e cada atributo
 * impede um ataque diferente:
 *
 * • `HttpOnly` — impede que um XSS no painel LEIA a sessão (`document.cookie`) e a exfiltre. Não
 *   impede o XSS de USAR a sessão (o navegador anexa o cookie sozinho): é por isso que a contenção
 *   do conteúdo servido da nossa origem — o `sandbox` de `/avatars/**` — é uma peça separada.
 * • `SameSite=Lax` — impede que POST/iframe/fetch disparado por OUTRO site leve o cookie: é o que
 *   fecha CSRF em todas as mutações do board e o que faz o clickjacking carregar SEM sessão. É a
 *   camada mais carregada do desenho e a mais fácil de derrubar sem perceber (basta alguém precisar
 *   de `None` para um embed) — travada por teste em `app/api/auth/login/route.test.ts`.
 * • `Path=/` — o portão cobre TODA superfície do serviço, então o cookie tem de cobrir também;
 *   um path mais estreito criaria rotas autenticadas onde o cookie não chega.
 * • `Secure` — impede o downgrade que entregaria a sessão em texto claro. Vem de CONFIGURAÇÃO
 *   (`AGILEHARNESS_PUBLIC_URL`), **não** de um header do pedido — a regra inteira, com o porquê de
 *   cada degrau, está em {@link sessionCookieSecure} logo abaixo.
 * • `Max-Age` — espelha o `exp` ASSINADO no payload. A validade real é o `exp`: um cookie que o
 *   navegador guardasse além dele simplesmente não autentica (`verifySession` compara com `now`),
 *   então o atributo é conveniência de limpeza, nunca o controle.
 *
 * A REVOGAÇÃO não é atributo nenhum — é o material de chave (ver `keyMaterial` abaixo).
 */

/** Nome do cookie. `ah` = AgileHarness. */
export const SESSION_COOKIE = "ah_session";

/**
 * Piso do segredo de assinatura. Abaixo disto NADA autentica (fail-closed) — um segredo curto
 * ou vazio (env não setada, arquivo truncado) jamais deve virar "sessão válida por acidente".
 * 32 bytes é o piso que o plano OSS fixa (docs/plans/agileharness-oss/04-frente-agentes.md D-2).
 */
export const MIN_SESSION_SECRET_LEN = 32;

/** Validade default de uma sessão: 30 dias (o operador logando do celular não quer refazer isso toda semana). */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Validade de uma sessão "não manter conectado": só a janela de trabalho. */
export const SESSION_TTL_SHORT_MS = 12 * 60 * 60 * 1000;

/**
 * Env pela qual o OPERADOR declara a origem pública do painel — ex.: `https://board.exemplo.dev`.
 *
 * ⚠️ `src/middleware.ts` exporta o MESMO nome (ele decide o `Location` do bounce para `/login` e roda
 * no Edge). As duas cópias são PINADAS IGUAIS por teste (`session-cookie-secure.test.ts`): sem esse
 * pino, renomear a env de um lado deixaria o outro lendo `undefined` — e o modo de falha desse tipo
 * de drift é silencioso (cookie sem `Secure`, bounce em `localhost`), nunca um build vermelho.
 */
export const PUBLIC_ORIGIN_ENV = "AGILEHARNESS_PUBLIC_URL";

/** O mínimo que este módulo precisa de um ambiente (mesma forma do `EnvLike` de `lib/auth/env.ts`). */
type EnvRecord = Record<string, string | undefined>;

/**
 * A origem pública DECLARADA, normalizada — `""` quando ausente ou impensável.
 *
 * Config de operador é entrada confiável, mas nem por isso se usa crua: `new URL().origin` descarta
 * path/credencial/fragmento colados por engano, e o filtro de esquema impede que um `javascript:` no
 * `.env` conte como "declaração válida". Valor impossível cai no degrau de fallback, nunca em
 * "então pergunta ao cliente".
 */
function declaredPublicOrigin(env: EnvRecord): string {
  const bruto = env[PUBLIC_ORIGIN_ENV]?.trim();
  if (!bruto) return "";
  try {
    const url = new URL(bruto);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

/**
 * `x-forwarded-proto` chega como LISTA quando há mais de um salto (ou quando o proxy APÊNDA em vez
 * de sobrescrever): `"http, https"`. Qualquer salto dizendo `https` vale como https, e essa direção
 * é monotônica de propósito — quem faz o pedido consegue ACRESCENTAR um valor, e acrescentar só
 * LIGA o `Secure` (auto-sabotagem: o cookie some no próprio navegador dele). O que ele não pode é
 * DESLIGAR, que era o buraco: comparar a string inteira com `"https"` fazia `"http, https"` — um
 * deploy HTTPS atrás de proxy que apenda — decidir "não é https" e emitir a sessão sem `Secure`.
 */
function anyHopSaysHttps(forwardedProto: string | null | undefined): boolean {
  if (!forwardedProto) return false;
  return forwardedProto.split(",").some((hop) => hop.trim().toLowerCase() === "https");
}

/**
 * Loopback = a única situação em que servir a sessão em texto claro é aceitável, porque o texto claro
 * não sai da máquina. `.localhost` entra por RFC 6761 (o navegador resolve toda a árvore para
 * loopback) e `127.0.0.0/8` inteiro entra porque `127.0.0.2` é tão local quanto `127.0.0.1`.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * DECIDE o `Secure` do cookie de sessão. O que este controle IMPEDE: que a sessão do operador nasça
 * sem `Secure` num deploy HTTPS — cookie sem `Secure` é cookie que o navegador entrega em texto claro
 * no primeiro downgrade (link `http://`, redirect, rede hostil), e o downgrade é justamente o que o
 * atacante consegue provocar.
 *
 * A palavra final é a CONFIGURAÇÃO, nunca um header:
 *
 *   1. `AGILEHARNESS_PUBLIC_URL` declarada ⇒ ela decide, e decide nos DOIS sentidos. `https:` ⇒
 *      `Secure` sempre, e nenhum header consegue rebaixar. `http:` ⇒ sem `Secure`, porque o operador
 *      declarou por escrito que o painel dele é texto claro (LAN, túnel local) — e aí um
 *      `x-forwarded-proto: https` forjado NÃO pode ligar o flag e derrubar o login dele.
 *   2. Sem declaração, um sinal de https (qualquer salto do `x-forwarded-proto`, ou a própria URL do
 *      pedido) ⇒ `Secure`.
 *   3. Sem declaração e sem sinal de https, o desempate é o ENDEREÇO: loopback ⇒ sem `Secure` (é o
 *      self-host em `http://localhost:3008`, onde cravar o flag faria o navegador descartar o cookie
 *      e o login entrar em laço); qualquer outro endereço ⇒ `Secure`, porque um serviço alcançado de
 *      fora da máquina não é dev.
 *
 * O degrau 3 não é reconfiguração imposta a ninguém: `AGILEHARNESS_PUBLIC_URL` JÁ é obrigatória em
 * todo acesso não-loopback (sem ela o `Location` do portão sai em `http://localhost:3008/login` e
 * quem chega pelo domínio não loga — ver `src/middleware.ts`). Então quem está de fato num deploy
 * já declarou, e quem não declarou está em loopback, onde nada muda.
 */
export function sessionCookieSecure(opts: {
  /** A URL do pedido como o SERVIDOR a vê (`req.url`). */
  requestUrl: string;
  /** O `x-forwarded-proto` CRU, como chegou — pode vir vazio, único ou em lista. */
  forwardedProto?: string | null;
  env?: EnvRecord;
}): boolean {
  const env = opts.env ?? (typeof process === "undefined" ? {} : process.env);
  const declarada = declaredPublicOrigin(env);
  if (declarada) return declarada.startsWith("https:");

  if (anyHopSaysHttps(opts.forwardedProto)) return true;
  try {
    const url = new URL(opts.requestUrl);
    if (url.protocol === "https:") return true;
    return !isLoopbackHost(url.hostname);
  } catch {
    // URL impensável: não sabemos onde estamos, e "não sei" tem de cair no lado seguro.
    return true;
  }
}

const encoder = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Retorna `Uint8Array<ArrayBuffer>` (não `ArrayBufferLike`): `crypto.subtle` exige um
// `BufferSource` respaldado por ArrayBuffer de verdade, e um Uint8Array genérico poderia estar
// sobre um SharedArrayBuffer — o TS reprova, com razão.
function bytesFromB64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * O MATERIAL DE CHAVE = segredo de sessão **+** token do operador.
 *
 * Amarrar o token à chave resolve um buraco de rotação: com a chave saindo só do
 * `session-secret`, trocar o token do operador (o que se faz JUSTAMENTE quando ele vaza) não
 * derrubava nenhuma sessão — quem estivesse dentro com um cookie roubado continuava dentro, e o
 * operador acreditava ter revogado o acesso. Agora rotacionar QUALQUER um dos dois invalida todos
 * os cookies em circulação, sem nenhum estado no servidor e sem custo por request.
 *
 * O separador `\n` não pode aparecer em nenhum dos dois (ambos são base64url), então não há como
 * dois pares distintos colidirem no mesmo material.
 */
function keyMaterial(sessionSecret: string, operatorToken: string): string {
  return `${sessionSecret}\n${operatorToken}`;
}

async function hmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(material), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/**
 * Assina uma sessão que expira em `now + ttlMs`.
 *
 * Lança se o segredo for fraco — quem chama (a rota de login) trata isso como erro de SETUP do
 * serviço, não como senha errada: emitir um cookie sob segredo fraco seria emitir um cookie
 * forjável, e falhar barulhento no login é melhor que uma sessão que qualquer um refaz.
 */
export async function signSession(opts: {
  sessionSecret: string;
  operatorToken: string;
  ttlMs?: number;
  now?: number;
}): Promise<string> {
  const { sessionSecret, operatorToken, ttlMs = SESSION_TTL_MS } = opts;
  if (sessionSecret.length < MIN_SESSION_SECRET_LEN || operatorToken.length < MIN_SESSION_SECRET_LEN) {
    throw new Error(`segredo de sessão ou token fraco (< ${MIN_SESSION_SECRET_LEN} chars) — recusando assinar`);
  }
  const now = opts.now ?? Date.now();
  const payload = b64urlFromBytes(encoder.encode(JSON.stringify({ exp: now + ttlMs })));
  const key = await hmacKey(keyMaterial(sessionSecret, operatorToken));
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `${payload}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

/**
 * Verifica um cookie de sessão. `true` só quando a assinatura confere E a sessão não expirou.
 *
 * Fail-closed em TODOS os caminhos de erro (token ausente/malformado, base64 inválido, JSON
 * inválido, segredo fraco, exp ausente): qualquer exceção vira `false`, nunca uma exceção que
 * suba para o middleware e vire um 500 — um 500 no gate seria "não sei, deixa passar?" e essa
 * ambiguidade é justamente o que não pode existir aqui.
 */
export async function verifySession(opts: {
  /** o valor do cookie. */
  token: string | undefined | null;
  sessionSecret: string;
  operatorToken: string;
  now?: number;
}): Promise<boolean> {
  const { token, sessionSecret, operatorToken } = opts;
  if (!token) return false;
  if (sessionSecret.length < MIN_SESSION_SECRET_LEN || operatorToken.length < MIN_SESSION_SECRET_LEN) {
    return false;
  }
  const now = opts.now ?? Date.now();
  try {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return false;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Assinatura ANTES do parse: só olhamos o conteúdo depois de provar que fomos nós que o
    // escrevemos (parsear primeiro daria a um payload forjado a chance de exercitar o parser).
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(keyMaterial(sessionSecret, operatorToken)),
      bytesFromB64url(sig),
      encoder.encode(payload),
    );
    if (!ok) return false;
    const decoded = JSON.parse(new TextDecoder().decode(bytesFromB64url(payload))) as { exp?: unknown };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp) && decoded.exp > now;
  } catch {
    return false;
  }
}
