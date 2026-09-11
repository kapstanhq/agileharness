// O GATEWAY DO TERMINAL — `/ttyd/*` (HTTP **e** WebSocket) atrás da MESMA sessão do resto do app.
//
// ── Por que isto existe ────────────────────────────────────────────────────────────────────────
// O AgileHarness já nega por default em toda superfície (`src/middleware.ts`), mas o middleware do
// Next só vê REQUESTS. Um WebSocket não é um request: é um `upgrade`, um evento do `http.Server`
// que o `next start` simplesmente não trata (`NextNodeServer.handleUpgrade` é um no-op fora do
// HMR de dev — verificado em node_modules/next/dist/server/next-server.js). Enquanto o terminal
// vivia fora do app, ele precisava de uma autenticação PARALELA — e teve duas, ambas ruins:
//
//   1. `basic_auth` no Caddy: o diálogo nativo do navegador, um segundo login para o mesmo
//      operador, e — pior para um produto open-source — auth que NÃO viaja com o repositório.
//      Quem instalasse atrás de nginx/Traefik/Cloudflare/nada não herdava proteção nenhuma.
//   2. `forward_auth` do Caddy apontando para o app: MEDIDO em produção (2026-07-27) e MORTO. O
//      `forward_auth` copia `Connection: Upgrade`/`Upgrade: websocket` para a sub-requisição de
//      auth; o Node roteia um GET assim para o evento `upgrade`, que o Next não responde — a
//      chamada de auth nunca retorna e o proxy devolve 502. Derrubou o terminal do operador.
//
// A saída não é um terceiro mecanismo: é o app passar a ser dono do `upgrade`. Um servidor HTTP
// próprio (`src/server/main.ts`) delega tudo ao Next e trata o evento ele mesmo, chamando a MESMA
// `verifySession` do middleware. É o desenho do code-server, do JupyterHub, do Coder e do Gitpod:
// origem única, sessão única, o app dono do upgrade, e o backend de PTY preso em loopback.
//
// ── A checagem de Origin (que só esta arquitetura permite) ─────────────────────────────────────
// CORS **não** protege WebSocket: qualquer página consegue abrir um `new WebSocket()` para outra
// origem, e o handshake sai do navegador com os cookies dele. É a CVE ClawJacked, registrada no
// anexo de segurança do plano OSS (`docs/plans/agileharness-oss/07-anexo-pesquisa-seguranca.md`).
// A única defesa é validar o header `Origin` no handshake — o que exige ser dono do upgrade. Com o
// gate no proxy, não havia onde fazer essa checagem; agora há, e é fail-closed (sem `Origin`, nega).
//
// ── O PERÍMETRO: a superfície que entrega SHELL entra na MESMA trava (story-m9jflb) ────────────
// A onda que criou `lib/auth/auth-audit.ts` instrumentou SEIS superfícies self-auth (`/api/mcp`, as
// 4 do runner, o login) e deixou de fora justamente esta. O que isso significava: um atacante
// martelando cookie forjado contra a rota que dá um SHELL não era contado, não era trancado e não
// aparecia no forense — a superfície mais valiosa do sistema era o refúgio de quem já estava trancado
// nas outras seis (o balde é UM por origem para o perímetro inteiro EXATAMENTE para impedir esse
// pivô). Agora `/ttyd/*` e o `upgrade` contam a tentativa forjada na trava por origem, gravam no rastro
// durável e respondem 429 quando a origem está trancada.
//
// ── A ORDEM: a credencial é COMPARADA primeiro, e só então a trava decide ──────────────────────
// O que esta ordem IMPEDE: que a trava vire a ARMA. `/api/mcp` é superfície de MÁQUINA — qualquer
// anônimo a martela SEM apresentar credencial e tranca a chave por até 60 min —, e a chave é
// COMPARTILHADA nas três instalações em que atacante e dono coincidem (self-host sem proxy, todos em
// `sem-proxy`; NAT de escritório/celular; CDN na frente do Caddy). Um pre-check de trava ANTES do
// cookie recusaria a sessão VÁLIDA do dono nessas instalações: qualquer pessoa na internet desligaria
// o terminal — que é como ele opera a máquina pelo celular — de graça. É o desfecho PROIBIDO que a
// seção ORDEM de `lib/auth/auth-audit.ts` descreve, e havia teste exigindo justamente ele.
// Hoje: sessão válida NUNCA é recusada pela trava (e o acerto PERDOA a janela da origem); só a
// tentativa já recusada é contada e trancada. O atacante não ganha nada — cada insistência dele é
// recusada e nenhuma alcança o daemon que spawna shells —, e paga-se por isso o custo de uma
// verificação de HMAC por tentativa, inclusive de origem trancada.
//
// ⚠️ Por que AQUI cabe a trava COMPLETA e no `src/middleware.ts` não: `auth-audit.ts` importa
// `node:fs` (o JSONL append-only é o que sobrevive ao restart, e o restart é o que um invasor causa),
// e o Next 14 roda middleware no runtime EDGE, onde `node:*` não existe — por isso o portão contribui
// só com o RASTRO em `console.warn`. Este arquivo roda no `http.Server` próprio (`src/server/main.ts`
// → `dist/ah-server.mjs`), Node puro, fora do bundle do Next: aqui há `node:fs`, logo há trava por
// origem E rastro durável. As duas superfícies têm capacidades diferentes por limite de runtime, não
// por escolha.
//
// ── A RÉGUA DE COBRANÇA, e por que ela não é "conta tudo" ──────────────────────────────────────
// Só entra na trava a tentativa que apresenta um cookie que NÃO é nosso — a única classe que um
// navegador de terceiro é INCAPAZ de produzir (`Cookie` é forbidden header name e ele não seta cookie
// de outro domínio), ou seja: cliente deliberado, que é exatamente o forjador. As outras duas classes
// ficam de fora, e o motivo é capacidade do dono, medida:
//   • SEM cookie — uma página qualquer consegue `fetch('/ttyd/token', {credentials:'omit'})` do
//     navegador do operador. Contar isso entregaria a ela um jeito de trancar a origem dele SEM nunca
//     chutar um segredo (o mesmo raciocínio que o teto de corpo do login já registrou), e o balde é
//     COMPARTILHADO com `/api/auth/login`: o dono ficaria de fora da própria tela de login.
//   • cookie NOSSO, mas VENCIDO — é o laço de reconexão do próprio terminal (`public/terminal/
//     index.html`: `scheduleReconnect`, backoff ≤ 8s, até 4 painéis). Uma sessão que vence com o
//     painel aberto geraria uma rajada de falhas legítimas da origem do DONO e trancaria o celular
//     dele fora do painel por até 1h. Distinguimos re-verificando a assinatura com `now: 0`.
// A RECUSA por Origin também fica fora da trava de propósito: ali a credencial é VÁLIDA e quem está
// errado é a página que abriu o socket — contá-la daria a um site qualquer o poder de trancar o dono
// usando o navegador dele. Ela segue barulhenta no log, que é onde ela sempre esteve.
//
// CUSTO DE AUTONOMIA: ZERO. Sessão válida abre o WebSocket exatamente como antes.
//
// Este módulo é PURO na decisão e isolado no I/O: as funções de política são testáveis sem socket
// (`terminal-gateway.test.ts`), e o encanamento (`proxyTerminalHttp` / `proxyTerminalUpgrade`) só
// copia bytes depois que a política disse sim.

import { connect as netConnect, type Socket } from "node:net";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

import {
  PERIMETER_SURFACES,
  TERMINAL_PERIMETER_SURFACES,
  checkPerimeter,
  perimeterLockedResponse,
  recordAuthFailure,
  recordAuthSuccess,
  type AuthFailureReason,
  type PerimeterGate,
} from "@/lib/auth/auth-audit";
import { authSecretsFromEnv, type EnvLike } from "@/lib/auth/env";
import { MIN_SESSION_SECRET_LEN, SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/**
 * O prefixo público do backend de terminal. Espelha o que o Caddy fazia com
 * `uri strip_prefix /ttyd` — mantido IDÊNTICO para que a página do terminal (que monta
 * `/ttyd/ws?arg=<sessão>` no cliente) não precise saber que o dono da rota mudou.
 *
 * O TIPO o pina ao vocabulário canônico do perímetro (`PERIMETER_SURFACES.terminalHttp`): o que isso
 * impede é o prefixo de ROTEAMENTO e o rótulo FORENSE andarem separados — se alguém mexer em um dos
 * dois, isto deixa de compilar em vez de o rastro passar a acusar uma superfície que não existe (ou o
 * balde do terminal a virar um balde à parte, que é a rotação de superfície que o balde único fecha).
 */
export const TERMINAL_PROXY_PREFIX: typeof PERIMETER_SURFACES.terminalHttp = "/ttyd";

// AS DUAS SUPERFÍCIES DO TERMINAL NO PERÍMETRO vêm de `TERMINAL_PERIMETER_SURFACES`
// (`lib/auth/auth-audit.ts`), que as DERIVA de `PERIMETER_SURFACES`. Aqui existia uma cópia LOCAL com a
// mesma forma, e o que uma segunda lista impedia era estrutural: o balde da trava é UM por origem para o
// perímetro INTEIRO justamente para o atacante não rotacionar de superfície e multiplicar o orçamento —
// com duas listas, nada garante que a superfície declarada só numa delas compartilhe o balde, apareça no
// resumo forense (`bySurface`) ou colapse em `canonicalSurface`. Rodar fora do Next (`http.Server`
// próprio) é limite de RUNTIME, não perímetro diferente. O rótulo segue por FUNÇÃO (`http`/`upgrade`) e
// nunca pelo path do request: o path abaixo de `/ttyd/` é texto do CLIENTE, e passar `req.url` deixaria
// o atacante inventar uma chave nova a cada tentativa e afogar o resumo forense.

/** Onde o ttyd escuta. Loopback por contrato — ele NUNCA deve ser alcançável de fora. */
export const DEFAULT_TTYD_HOST = "127.0.0.1";
export const DEFAULT_TTYD_PORT = 7681;

export interface TtydTarget {
  host: string;
  port: number;
}

/**
 * Alvo do proxy a partir da env. `AGILEHARNESS_TTYD_URL` existe para quem sobe o ttyd noutra porta
 * (ou noutro container); o default é o loopback padrão do `tools/web-terminal/ttyd.service`.
 * Entrada inválida cai no default em vez de derrubar o boot — um typo na env não pode ser o motivo
 * de o serviço inteiro não subir.
 */
export function ttydTargetFromEnv(env: EnvLike = process.env): TtydTarget {
  const raw = env.AGILEHARNESS_TTYD_URL?.trim();
  if (!raw) return { host: DEFAULT_TTYD_HOST, port: DEFAULT_TTYD_PORT };
  try {
    const url = new URL(raw);
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    return { host: url.hostname || DEFAULT_TTYD_HOST, port };
  } catch {
    console.warn(`[terminal] AGILEHARNESS_TTYD_URL inválida (${raw}) — usando o default de loopback`);
    return { host: DEFAULT_TTYD_HOST, port: DEFAULT_TTYD_PORT };
  }
}

/** O pathname de uma URL de request (que pode trazer query e nunca traz origem). */
export function pathnameOf(url: string | undefined): string {
  const raw = url ?? "/";
  const cut = raw.indexOf("?");
  return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * O request é para o backend de terminal?
 *
 * Casa por SEGMENTO (`=== prefixo` ou `startsWith(prefixo + "/")`), nunca `startsWith` cru — a
 * mesma régua de `lib/auth/public-routes.ts`. Com `startsWith` cru, `/ttyd-publico` cairia aqui e
 * qualquer rota do app com esse nome viraria um proxy para o ttyd.
 */
export function isTerminalProxyPath(pathname: string): boolean {
  return pathname === TERMINAL_PROXY_PREFIX || pathname.startsWith(`${TERMINAL_PROXY_PREFIX}/`);
}

/**
 * A URL que o ttyd vê: sem o prefixo, com a query preservada.
 *
 * A query IMPORTA — o ttyd roda com `--url-arg` e lê `?arg=<sessão tmux>` para escolher em qual
 * sessão atar (via `attach-session.sh`, que valida o nome). Perder a query aqui faria todo terminal
 * cair na sessão default.
 */
export function upstreamUrlOf(url: string | undefined): string {
  const raw = url ?? "/";
  const cut = raw.indexOf("?");
  const path = cut === -1 ? raw : raw.slice(0, cut);
  const query = cut === -1 ? "" : raw.slice(cut);
  const stripped = path.slice(TERMINAL_PROXY_PREFIX.length) || "/";
  return `${stripped}${query}`;
}

/** Lê UM cookie do header `Cookie`. Sem dependência de parser — o header é trivial e conhecido. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const piece = part.trim();
    if (piece.startsWith(`${name}=`)) return piece.slice(name.length + 1);
  }
  return undefined;
}

/** O primeiro salto de um header que pode vir em lista (`a, b, c`). */
function firstHop(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim() ?? "";
}

/**
 * O host que o NAVEGADOR usou — `x-forwarded-host` (posto pelo proxy) e, sem proxy, o `Host`.
 *
 * Um cliente não consegue forjar isto num handshake de WebSocket: o navegador não deixa JS setar
 * header nenhum em `new WebSocket()`, e um proxy reverso reescreve `x-forwarded-host` de qualquer
 * forma. É por isso que a comparação abaixo é confiável mesmo lendo um header de proxy.
 */
export function expectedHostOf(headers: IncomingMessage["headers"]): string {
  return (firstHop(headers["x-forwarded-host"]) || firstHop(headers.host)).toLowerCase();
}

/**
 * O `Origin` do handshake é a NOSSA origem?
 *
 * Fail-closed: sem `Origin`, sem `Host` conhecido, ou com `Origin` malformado ⇒ `false`. Todo
 * navegador manda `Origin` num handshake de WebSocket (é obrigatório na especificação da API), então
 * negar o ausente não custa nada ao caso legítimo e fecha a porta para clientes que o omitem.
 *
 * Compara só o HOST, não o esquema, de propósito: atrás de um proxy que termina TLS o navegador
 * manda `Origin: https://dominio` enquanto o app fala HTTP no loopback, e nem todo proxy que
 * alguém vai usar para self-host manda `x-forwarded-proto`. Exigir o esquema quebraria instalações
 * corretas sem fechar nenhum ataque: quem controla `http://dominio` já está dentro do perímetro.
 */
export function isSameOriginRequest(headers: IncomingMessage["headers"]): boolean {
  const origin = firstHop(headers.origin);
  if (!origin) return false;
  const expected = expectedHostOf(headers);
  if (!expected) return false;
  try {
    return new URL(origin).host.toLowerCase() === expected;
  } catch {
    return false;
  }
}

/**
 * A visão MÍNIMA dos headers que o perímetro precisa: só o sinal de ORIGEM.
 *
 * `auth-audit` deriva a chave de trava de `x-forwarded-for` (`clientKey`) e não lê mais nada. Copiar o
 * header inteiro entregaria de graça o `Cookie` de sessão a um módulo que GRAVA ARQUIVO — a mesma
 * higiene que `upstreamHeaders` já aplica ao não repassar o cookie ao ttyd: o segredo não passa por
 * onde não precisa passar.
 *
 * Fail-safe por construção: um valor que `Headers` recuse (o `Set` lança em nome/valor inválido) não
 * derruba a rota do terminal — a origem só cai no balde compartilhado (`sem-proxy`), onde CONTA igual.
 * Nunca passa direto.
 */
export function perimeterHeaders(raw: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  const bruto = raw["x-forwarded-for"];
  // Array só aparece se o Node não tiver juntado duplicatas; juntar preservando a ORDEM dos saltos é
  // obrigatório — `clientKey` lê o ÚLTIMO, que é o que o NOSSO proxy escreveu.
  const xff = Array.isArray(bruto) ? bruto.join(", ") : bruto;
  if (xff) {
    try {
      out.set("x-forwarded-for", xff);
    } catch {
      /* header malformado: esta origem cai no balde compartilhado, nunca fora da trava */
    }
  }
  return out;
}

/**
 * O veredito da credencial do terminal — e se ela é COBRADA na trava por origem.
 *
 * `charged` não é detalhe de implementação: é a régua documentada no cabeçalho (só o cookie que NÃO é
 * nosso entra na trava). Ele é explícito no tipo para que uma mudança futura tenha de escolher o valor
 * de propósito, em vez de herdar um default.
 */
export type TerminalCredentialVerdict =
  | { ok: true }
  /** recusada, mas FORA da trava e do rastro — pode ser o cliente do próprio operador. */
  | { ok: false; charged: false }
  /** recusada e COBRADA: conta na trava por origem e grava a linha durável. */
  | { ok: false; charged: true; reason: AuthFailureReason; presented: string };

/**
 * Classifica o cookie apresentado. Mesma régua e mesmo segredo do middleware — `verifySession`.
 *
 * As três classes de recusa existem para separar ATAQUE de OPERADOR (ver o cabeçalho):
 *   • `ausente`      — ninguém apresentou credencial: não conta (seria lever de DoS contra o dono).
 *   • VENCIDO        — assinatura NOSSA, validade estourada. É o laço de reconexão do painel dele.
 *                      Medido re-verificando com `now: 0`: a assinatura confere, só o `exp` não.
 *   • `token-fraco`  — o SERVIÇO subiu sem segredo forte, então nada autentica. Conta, pelo mesmo
 *                      motivo do login: o ramo depende da NOSSA config e ninguém o exercita de fora.
 *   • `desconhecida` — cookie que não é nosso: forjado (ou de um segredo já rotacionado). Conta.
 */
export async function classifyTerminalCredential(
  headers: IncomingMessage["headers"],
  env: EnvLike = process.env,
): Promise<TerminalCredentialVerdict> {
  const cookie = cookieValue(headers.cookie, SESSION_COOKIE);
  const segredos = authSecretsFromEnv(env);
  if (await verifySession({ token: cookie, ...segredos })) return { ok: true };
  if (!cookie) return { ok: false, charged: false };
  if (
    segredos.sessionSecret.length < MIN_SESSION_SECRET_LEN ||
    segredos.operatorToken.length < MIN_SESSION_SECRET_LEN
  ) {
    return { ok: false, charged: true, reason: "token-fraco", presented: cookie };
  }
  // `now: 0` isola o ÚNICO fator que muda entre as duas chamadas: qualquer `exp` que já assinamos é
  // > 0, então passar aqui prova que a ASSINATURA é nossa e que só a validade venceu.
  if (await verifySession({ token: cookie, ...segredos, now: 0 })) return { ok: false, charged: false };
  return { ok: false, charged: true, reason: "desconhecida", presented: cookie };
}

/** A sessão do AgileHarness está válida neste request? Mesma régua do middleware, mesmo segredo. */
export async function hasValidSession(headers: IncomingMessage["headers"]): Promise<boolean> {
  return (await classifyTerminalCredential(headers)).ok;
}

/**
 * Headers repassados ao ttyd.
 *
 * Duas remoções deliberadas:
 *   • `host` — reescrito para o upstream (senão o ttyd recebe o domínio público).
 *   • `cookie` — o ttyd não tem nada que fazer com a sessão do operador, e ele é um daemon que
 *     spawna shells. Não entregar o cookie de sessão a ele é higiene barata: se um dia o ttyd
 *     logar headers (ou for trocado por outro backend), o segredo simplesmente não passou por lá.
 */
function upstreamHeaders(req: IncomingMessage, target: TtydTarget): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i]!;
    const value = req.rawHeaders[i + 1]!;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "cookie") continue;
    // Repetido (ex.: `Sec-WebSocket-Extensions`) ⇒ junta como o HTTP manda, sem perder valor.
    out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`;
  }
  out.Host = `${target.host}:${target.port}`;
  return out;
}

function denyHttp(res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void {
  const body = JSON.stringify({ ok: false, error });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...extra,
  });
  res.end(body);
}

/** Recusa um upgrade falando HTTP na mão — o socket já foi sequestrado, não há `ServerResponse`. */
function denyUpgrade(socket: Socket, status: number, reason: string, extra: Record<string, string> = {}): void {
  if (socket.writable) {
    const linhas = [`HTTP/1.1 ${status} ${reason}`, "Connection: close", "Cache-Control: no-store"];
    for (const [k, v] of Object.entries(extra)) linhas.push(`${k}: ${v}`);
    socket.write(`${linhas.join("\r\n")}\r\n\r\n`);
  }
  socket.destroy();
}

/**
 * A recusa de uma origem TRANCADA, postura `declarada` — o status e o `Retry-After` saem de
 * `perimeterLockedResponse`, que é a régua única das outras superfícies do perímetro.
 *
 * `declarada` (429 + `Retry-After`) e não `muda` (404) porque estas duas superfícies JÁ respondiam
 * 401/JSON: elas admitem existir, então a trava não conta nada novo — e ensina o cliente legítimo (a
 * página do terminal, que reconecta sozinha) a esperar em vez de martelar.
 */
function lockedStatus(gate: PerimeterGate): { status: number; retryAfter?: string } {
  const canonica = perimeterLockedResponse("declarada", gate);
  const retryAfter = canonica.headers.get("retry-after");
  return { status: canonica.status, ...(retryAfter ? { retryAfter } : {}) };
}

/** A recusa por trava no caminho HTTP: JSON, porque quem lê é o `fetch` da página do terminal. */
function denyLockedHttp(res: ServerResponse, gate: PerimeterGate): void {
  const { status, retryAfter } = lockedStatus(gate);
  const extra: Record<string, string> = retryAfter ? { "retry-after": retryAfter } : {};
  denyHttp(res, status, "muitas tentativas — aguarde e tente de novo", extra);
}

/** A mesma recusa no caminho do upgrade, falada na mão sobre o socket já sequestrado. */
function denyLockedUpgrade(socket: Socket, gate: PerimeterGate): void {
  const { status, retryAfter } = lockedStatus(gate);
  denyUpgrade(socket, status, "Too Many Requests", retryAfter ? { "Retry-After": retryAfter } : {});
}

/**
 * O veredito da TRAVA para uma credencial que JÁ foi comparada e JÁ foi recusada.
 *
 * Roda depois da comparação, nunca antes — é essa ordem que impede a trava de recusar o DONO (ver a
 * seção ORDEM no cabeçalho). Dois caminhos, e a diferença é a régua de cobrança:
 *   • classe COBRÁVEL (cookie que não é nosso) ⇒ `recordAuthFailure`, que decide e incrementa no MESMO
 *     passo (o orçamento da rajada é o teto configurado, não o número de pedidos em voo) e grava a
 *     linha durável — estrangulada quando a origem já estava trancada;
 *   • classe FORA da trava (sem cookie, ou cookie nosso já vencido) ⇒ nada é contado; a trava é apenas
 *     OBSERVADA (`checkPerimeter`) para escolher o status de uma recusa que já está decidida. Observar
 *     aqui não pode negar serviço a ninguém: quem chegou a esta linha não apresentou credencial válida.
 */
function recusaDoTerminal(
  verdict: Extract<TerminalCredentialVerdict, { ok: false }>,
  origem: Headers,
  surface: string,
): PerimeterGate {
  if (!verdict.charged) return checkPerimeter(origem);
  return recordAuthFailure({
    headers: origem,
    surface,
    via: "cookie",
    reason: verdict.reason,
    // Cru de propósito: o mascaramento (só o COMPRIMENTO sai) acontece dentro do ledger. Mascarar
    // aqui daria a cada chamador a chance de inventar a própria régua.
    presented: verdict.presented,
  });
}

/**
 * `/ttyd/*` por HTTP (hoje: `GET /ttyd/token`, que o cliente busca antes de abrir o socket).
 *
 * Nega com 401 em JSON (429 + `Retry-After`, também em JSON, quando a origem está trancada), nunca com
 * redirect: quem chama é `fetch` dentro da página, e um 307 para `/login` viraria um HTML opaco no
 * `catch` do cliente em vez de um erro legível.
 *
 * ⚠️ NÃO checa `Origin`, e isto é deliberado — não é um esquecimento a "corrigir": um `fetch` GET
 * same-origin NÃO manda `Origin` nenhum (a especificação o omite para GET/HEAD), então uma checagem
 * fail-closed aqui recusaria justamente a chamada legítima da página e derrubaria o terminal do dono.
 * O que fecha esta porta para outra aba é a dupla `SameSite=Lax` (o cookie não viaja num GET
 * cross-site) + a sessão exigida acima. No `upgrade` a história é outra: lá o navegador SEMPRE manda
 * `Origin`, e é lá que a checagem existe.
 */
export async function proxyTerminalHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: TtydTarget,
): Promise<void> {
  const origem = perimeterHeaders(req.headers);
  // ORDEM: COMPARA a credencial → só então a trava decide (ver a seção ORDEM acima).
  const credencial = await classifyTerminalCredential(req.headers);
  if (!credencial.ok) {
    const gate = recusaDoTerminal(credencial, origem, TERMINAL_PERIMETER_SURFACES.http);
    // Trancada (por esta falha ou por qualquer das outras superfícies) ⇒ 429 com `Retry-After`, para o
    // cliente aprender a esperar na hora em vez de descobrir no request seguinte.
    if (!gate.allowed) {
      denyLockedHttp(res, gate);
      return;
    }
    denyHttp(res, 401, "não autenticado — faça login no AgileHarness");
    return;
  }
  recordAuthSuccess(origem);

  const upstream = httpRequest(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: upstreamUrlOf(req.url),
      headers: upstreamHeaders(req, target),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    console.error("[terminal] ttyd inalcançável:", err instanceof Error ? err.message : err);
    if (!res.headersSent) denyHttp(res, 502, "terminal indisponível — o serviço ttyd não respondeu");
    else res.destroy();
  });
  req.pipe(upstream);
}

/**
 * `/ttyd/ws` — o handshake de WebSocket e, depois dele, o túnel de bytes.
 *
 * Ordem das checagens de propósito: sessão → origem → trava. A SESSÃO vem primeiro porque ela é o
 * portão, e porque a trava não sabe comparar credencial nenhuma: consultá-la antes recusaria também a
 * do dono (ver a seção ORDEM acima). Depois a origem, que é a defesa contra uma página de terceiro
 * usando a sessão LEGÍTIMA do operador — só faz sentido perguntar depois que há sessão. A trava decide
 * por último, e só sobre uma tentativa que JÁ foi recusada.
 */
export async function proxyTerminalUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: TtydTarget,
): Promise<void> {
  socket.on("error", () => socket.destroy());

  const origem = perimeterHeaders(req.headers);
  const credencial = await classifyTerminalCredential(req.headers);
  if (!credencial.ok) {
    // Trancada nas outras superfícies, esta origem NÃO pivota para o shell: cada insistência é contada
    // e recusada aqui — o balde é UM para o perímetro inteiro justamente para o atacante não rotacionar
    // de superfície. O que ela ganha é o custo de UMA verificação de HMAC por tentativa, que é o preço
    // de não existir um interruptor de negação de serviço contra o dono.
    const gate = recusaDoTerminal(credencial, origem, TERMINAL_PERIMETER_SURFACES.upgrade);
    if (!gate.allowed) {
      denyLockedUpgrade(socket, gate);
      return;
    }
    denyUpgrade(socket, 401, "Unauthorized");
    return;
  }
  if (!isSameOriginRequest(req.headers)) {
    // Barulhento de propósito: um handshake autenticado vindo de OUTRA origem é, por definição,
    // uma tentativa de sequestro do terminal do operador — não um erro de configuração comum.
    console.warn(
      `[terminal] upgrade RECUSADO por origem (origin=${firstHop(req.headers.origin) || "ausente"}, ` +
        `esperado=${expectedHostOf(req.headers) || "desconhecido"})`,
    );
    // Fora da trava de propósito: a credencial aqui é VÁLIDA (é a do operador) e quem está errado é a
    // página que abriu o socket. Contar isto entregaria a um site qualquer o poder de trancar o dono
    // usando o navegador dele — e a defesa contra o sequestro é a recusa, que não mudou.
    denyUpgrade(socket, 403, "Forbidden");
    return;
  }

  // Handshake ACEITO ⇒ perdoa a janela desta origem: o operador que colou um cookie velho antes não
  // carrega backoff depois de entrar (e quem acertou já tem o que a trava protegia).
  recordAuthSuccess(origem);

  // Sem timeout e sem Nagle: um terminal fica horas ocioso e cada tecla é um pacote minúsculo cuja
  // latência o operador SENTE. O default do Node (agrupar writes pequenos) é o oposto do que se
  // quer aqui.
  socket.setNoDelay(true);
  socket.setTimeout(0);

  const upstream = netConnect(target.port, target.host);
  upstream.setNoDelay(true);
  upstream.setTimeout(0);

  let established = false;
  upstream.on("error", (err) => {
    console.error("[terminal] túnel ttyd falhou:", err instanceof Error ? err.message : err);
    if (!established) denyUpgrade(socket, 502, "Bad Gateway");
    else socket.destroy();
    upstream.destroy();
  });
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());

  upstream.on("connect", () => {
    established = true;
    const headers = upstreamHeaders(req, target);
    const lines = [`${req.method ?? "GET"} ${upstreamUrlOf(req.url)} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    // `head` são os bytes que o Node já leu do socket junto com o handshake. Escrevê-los ANTES de
    // ligar os canos é obrigatório: perdê-los corromperia o primeiro frame do WebSocket.
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}
