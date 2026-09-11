// O PORTÃO — nega por default, em TODA superfície do serviço.
//
// Antes deste arquivo, a autenticação do AgileHarness era o `basic_auth` do Caddy no :443. Isso
// tinha dois defeitos: (1) o :3008 escutava em `0.0.0.0` e servia o board inteiro SEM auth
// nenhuma para quem batesse direto na porta; (2) não viajava com o repositório — quem instalasse
// o open-source e usasse nginx/Traefik/Cloudflare/nada não herdava proteção alguma. O plano OSS
// (04-frente-agentes.md D-2) fixa o desenho: middleware único, token fail-closed, e o basic_auth
// do proxy rebaixado a defesa-em-profundidade documentada — nunca requisito.
//
// ⚠️ EDGE RUNTIME: o Next 14 roda middleware no Edge. Nada de `node:*` aqui — só Web Crypto (via
// lib/auth/session), módulos puros (lib/auth/{env,next-path,public-routes,rate-limit}) e
// `process.env`, que `instrumentation.ts` popula no boot. É essa fronteira que explica por que o
// rastro do portão sai em `console.warn` e não no ledger em disco do perímetro — ver `noteCookieRecusado`.

import { NextResponse, type NextRequest } from "next/server";

import { authSecretsFromEnv, type EnvLike } from "@/lib/auth/env";
import { safeNextPath } from "@/lib/auth/next-path";
import { isPublicPath } from "@/lib/auth/public-routes";
import { clientKey } from "@/lib/auth/rate-limit";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { PATHNAME_HEADER } from "@/lib/feedback/overlay-mount";

/**
 * O matcher exclui os estáticos do Next por PERFORMANCE (não por segurança — `isPublicPath`
 * também os libera). Segurança não pode depender de matcher: qualquer path que ESCAPE do
 * matcher chega sem passar pelo portão, e é assim que gate por regex vira bypass. Por isso o
 * matcher é deliberadamente amplo (tudo menos assets) e quem decide é `isPublicPath`.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};

/**
 * Env pela qual o OPERADOR declara a origem pública do painel — ex.: `https://ah.exemplo.dev`.
 *
 * ⚠️ Se `lib/auth/env.ts` passar a declarar este nome (o cookie `Secure` do login precisa do MESMO
 * valor — t3 do story-2i89ai), importe de lá e apague esta constante: duas cópias da string são
 * duas verdades, e a que apodrece falha calada.
 */
export const PUBLIC_ORIGIN_ENV = "AGILEHARNESS_PUBLIC_URL";

/**
 * A origem DECLARADA, normalizada — `""` quando ausente ou impensável.
 *
 * Config de operador é entrada confiável, mas nem por isso se cola crua num header: `new URL` +
 * `.origin` descarta path/credencial/fragmento que alguém tenha colado por engano, e o filtro de
 * esquema impede que um `javascript:` (ou um `file:`) no `.env` vire o destino de um `Location`.
 * Valor impossível cai no fallback SEGURO abaixo — nunca em "então confia no cliente".
 */
function declaredOrigin(env: EnvLike): string {
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
 * A origem do `Location` do portão — de CONFIGURAÇÃO ou do próprio servidor. Do CLIENTE, nunca.
 *
 * O que este controle IMPEDE: que um pedido escolha para onde o portão manda o operador. A versão
 * anterior montava a origem com `x-forwarded-host`/`x-forwarded-proto` e caía no `host` — os três
 * são texto de quem faz o pedido em qualquer deploy cujo proxy não os REESCREVA (o Caddy desta VPS
 * reescreve; isso protege ESTE deploy, não o produto que vai para o OSS). Com isso, um link
 * legítimo para `/board` respondia `307 Location: http://evil.example/login?next=%2Fboard`
 * (REPRODUZIDO ao vivo) — o vetor clássico de roubo de credencial de operador: clone da tela de
 * login no domínio do atacante, alcançado a partir de uma URL que a vítima reconhece. O `no-store`
 * da resposta reduz a janela de envenenamento de cache, mas quem fecha o vetor é não ler o header.
 *
 * Por que não Location RELATIVO, que seria seguro por construção: o runtime de middleware do Next
 * 14 faz `new NextURL(location)` SEM base (`server/web/adapter.js`, ramo `Location`) e estoura
 * `ERR_INVALID_URL` — conferido no 14.2.35 instalado. Absoluto é obrigação do framework, então a
 * pergunta deixa de ser "relativo ou absoluto" e passa a ser "absoluto a partir de QUÊ".
 *
 * A resposta tem dois degraus:
 *   1. a origem DECLARADA (`AGILEHARNESS_PUBLIC_URL`) — mesma direção do `ALLOWED_HOSTS` do Django:
 *      quem sabe o domínio público é o operador, e ele diz uma vez;
 *   2. na ausência dela, `req.nextUrl.origin`, que — MEDIDO na fonte, não suposto — é a origem do
 *      PRÓPRIO servidor: `next-server.js` monta a URL do middleware com o `hostname`/`port` que o
 *      `next({ hostname, port })` de `server/main.ts` fixou (`127.0.0.1:3008`, que o NextURL
 *      normaliza para `localhost`), e só cai no header `Host` sob `experimental.trustHostHeader`,
 *      que este projeto não liga. Daí o degrau 2 ser inalcançável pelo cliente.
 *
 * O CUSTO honesto do degrau 2: atrás de proxy num domínio público e SEM a env declarada, o bounce
 * para o login sai em `http://localhost:3008/login` — o operador precisa declarar a origem. É o
 * preço de não perguntar ao cliente onde fica a nossa casa, e é config de UMA linha; manter o
 * header por conveniência custaria a credencial.
 */
function redirectOrigin(req: NextRequest, env: EnvLike = process.env): string {
  return declaredOrigin(env) || req.nextUrl.origin;
}

/**
 * Deixa passar CARIMBANDO o pathname no request.
 *
 * O root layout não conhece a rota (limitação do App Router) e precisa dela para decidir se monta
 * o overlay de feedback — ver lib/feedback/overlay-mount.ts. O middleware já roda em tudo e já
 * conhece o pathname, então carimbar aqui é de graça e evita um segundo mecanismo.
 */
function passThrough(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(PATHNAME_HEADER, req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

/**
 * O RASTRO DO PORTÃO — a linha que o `journalctl -u storymap` não tinha (story-m9jflb).
 *
 * O que ele IMPEDE: que uma tentativa de MINTAR sessão seja invisível. Um cookie que falha na
 * verificação é evento de credencial — sessão expirada, token rotacionado (a revogação funcionando)
 * ou cookie FORJADO, e esse último não deixava rastro nenhum. Sem fonte de log não existe detecção.
 *
 * Só quem APRESENTOU cookie gera linha, de propósito: um pedido sem cookie é visita não autenticada
 * (o scanner que varre a porta, o navegador abrindo `/` antes do login) e uma linha por pedido desses
 * entregaria o nosso journal ao atacante como alvo de escrita, além de afogar o sinal.
 *
 * ⚠️ O portão contribui com o RASTRO, não com a TRAVA, e isso é limite de runtime, não escolha:
 * `lib/auth/auth-audit.ts` (o balde por origem + o JSONL durável das superfícies self-auth) importa
 * `node:fs`, que não existe no Edge — onde o Next 14 roda middleware (não há `nodeMiddleware` no
 * 14.2.35; conferido no `config-schema` do pacote). O que dá para compartilhar daqui é a RÉGUA DE
 * IDENTIDADE: `clientKey` (`lib/auth/rate-limit.ts`, módulo sem imports, logo Edge-safe) — o mesmo
 * último salto do XFF que o perímetro usa, para as duas fontes falarem do mesmo "quem".
 */
const GATE_LOG_THROTTLE_MS = 60_000;
const GATE_LOG_MAX_KEYS = 500;
const cookieRecusado = new Map<string, { count: number; lastLogAt: number }>();

/**
 * A RÉGUA ÚNICA de campo de log: reduz o valor a um alfabeto FECHADO e trunca.
 *
 * O que isto IMPEDE: que quem faz o pedido ESCREVA no nosso journal. Tudo que entra nesta linha é
 * texto do cliente, e a linha é `chave=valor` separada por espaço — então não basta olhar CR/LF: um
 * espaço já forja CAMPOS dentro da mesma linha (um `ip=` a mais e o forense lê o valor do atacante),
 * e um ESC solto (0x1b — MEDIDO como aceito em valor de header, ao contrário de CR/LF, que o
 * transporte recusa) carrega sequência ANSI que reescreve o terminal de quem lê o `journalctl`.
 * Lista de permissão, nunca de proibição: caractere que não está no alfabeto vira `·` e o teto de
 * tamanho impede que um campo só empurre a linha inteira para fora da tela.
 */
function campoSeguro(valor: string, foraDoAlfabeto: RegExp, teto: number): string {
  return valor.replace(foraDoAlfabeto, "·").slice(0, teto);
}

/** Alfabeto de um pathname: o que uma rota nossa de verdade usa, e nada além. */
const FORA_DO_PATH = /[^\w\-./[\]@]/g;

/**
 * Alfabeto de uma identidade de cliente. Vale o `:` (senão TODO IPv6 viraria ruído e o rastro
 * perderia justo o "quem" que ele existe para registrar) e o `-` do fallback `sem-proxy`.
 */
const FORA_DO_IP = /[^\w\-.:[\]]/g;

function pathSeguro(pathname: string): string {
  return campoSeguro(pathname, FORA_DO_PATH, 120) || "/";
}

/**
 * O `ip` sai pela MESMA régua do path — a assimetria era o buraco.
 *
 * `clientKey` devolve o último salto do `x-forwarded-for` SEM validar caractere nenhum (ver
 * `lib/auth/rate-limit.ts`): atrás do Caddy ele é reescrito, mas num deploy sem proxy que o
 * reescreva é string escolhida pelo cliente. Ela ia CRUA para o `console.warn` enquanto o path já
 * era saneado — mesmo risco, meia defesa.
 */
function ipSeguro(key: string): string {
  return campoSeguro(key, FORA_DO_IP, 64) || "?";
}

function noteCookieRecusado(req: NextRequest, apresentado: string): void {
  const key = clientKey(req.headers);
  const agora = Date.now();
  // Teto de chaves: uma varredura com IP sempre novo não pode virar memória sem fim no sandbox do
  // Edge. Ao encostar no teto o mapa é limpo por inteiro — mais permissivo por uma janela, nunca
  // crescente (mesma direção de `auth-audit.ts` e do limiter de feedback).
  if (cookieRecusado.size >= GATE_LOG_MAX_KEYS) cookieRecusado.clear();
  const st = cookieRecusado.get(key) ?? { count: 0, lastLogAt: -Infinity };
  st.count += 1;
  const janela = agora - st.lastLogAt >= GATE_LOG_THROTTLE_MS;
  // Rajada estrangulada: 1ª, potências de 10 e a cada janela. N tentativas ⇒ O(log₁₀ N) linhas, e a
  // linha carrega a MAGNITUDE — "487", não "houve".
  if (janela || /^10*$/.test(String(st.count))) {
    st.lastLogAt = agora;
    // O VALOR do cookie nunca sai: só o comprimento, que o atacante já conhece (é o que ele mandou) e
    // que distingue "veio vazio" de "veio algo do nosso formato".
    console.warn(
      `[auth] sessão recusada rota=${pathSeguro(req.nextUrl.pathname)} ip=${ipSeguro(key)} ` +
        `cookie=<oculto: ${apresentado.length} chars> tentativas=${st.count}`,
    );
  }
  cookieRecusado.set(key, st);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;

  // ── `.well-known` é superfície de MÁQUINA e nunca pode virar uma tela de login ────────────────
  // Um cliente MCP faz DESCOBERTA aqui antes de tentar a credencial: pergunta por
  // `/.well-known/oauth-protected-resource` e decide, pela resposta, se o servidor fala OAuth.
  //
  // Medido em 2026-08-06, e é uma falha de PRODUTO, não de instalação: sem este ramo o caminho
  // caía no deny-por-default e devolvia `307 → /login`. O cliente lê um redirect para uma tela de
  // login como "existe um serviço de login OAuth aqui", tenta registrar um client, falha, e
  // apresenta ao operador "Não foi possível registrar no serviço de login" — sem NUNCA chegar ao
  // endpoint MCP. A prova é a ausência: zero requisições a `/api/mcp` no log do proxy durante as
  // tentativas, e o handle recém-cunhado com "último uso nunca".
  //
  // Não publicamos nenhum documento `.well-known`. A resposta honesta é 404, e é ela que faz o
  // cliente cair para a credencial no path — que é o desenho declarado deste servidor. Um 401
  // seria pior: convida o cliente a negociar autenticação que não existe aqui.
  //
  // Vem ANTES do portão de propósito: uma resposta de descoberta não depende de sessão, e fazê-la
  // depender é o que produziu o redirect em primeiro lugar.
  if (pathname === "/.well-known" || pathname.startsWith("/.well-known/")) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }

  if (isPublicPath(pathname)) return passThrough(req);

  // O token entra na chave (lib/auth/session.ts): rotacioná-lo derruba TODA sessão viva, que é o
  // que se espera de "meu token vazou, troquei o token".
  const apresentado = req.cookies.get(SESSION_COOKIE)?.value;
  const ok = await verifySession({ token: apresentado, ...authSecretsFromEnv() });
  if (ok) return passThrough(req);

  // Segredo ausente/fraco ⇒ `verifySession` já devolveu false (fail-closed): um serviço mal
  // inicializado tranca, não abre.

  if (apresentado) noteCookieRecusado(req, apresentado);

  // A régua é o PATH, não o header `Accept`. Farejar `Accept: text/html` parece mais esperto e é
  // pior: uma navegação que não mande esse header (curl, um webview econômico, um cliente
  // qualquer) ficava presa num 401 sem NENHUM caminho até a tela de login. `/api/*` é máquina e
  // recebe JSON; todo o resto é gente e recebe a tela.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "não autenticado — faça login no AgileHarness" },
      // `no-store` para nenhum intermediário guardar a NEGATIVA e devolvê-la depois que o
      // operador já entrou (nem o contrário, que seria pior).
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  // O destino passa pelo MESMO saneador que a tela usa (lib/auth/next-path.ts) — aqui ele nasce
  // do nosso próprio pathname, mas mandá-lo por outro caminho criaria uma segunda régua.
  const target = safeNextPath(`${pathname}${search}`);
  const suffix = target && target !== "/" ? `?next=${encodeURIComponent(target)}` : "";
  const res = NextResponse.redirect(new URL(`/login${suffix}`, redirectOrigin(req)));
  res.headers.set("cache-control", "no-store");
  return res;
}
