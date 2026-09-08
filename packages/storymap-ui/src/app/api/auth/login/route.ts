// TROCA o token do operador por um cookie de sessão. É a única rota que fala com o segredo forte.
//
// Pública no middleware por necessidade (`public-routes.ts`, motivo "pre-session") — ela se
// autentica sozinha, timing-safe, e é a superfície mais exposta do serviço. Daí as travas:
// content-type JSON obrigatório, teto de corpo/tempo antes de materializar nada, trava de
// força-bruta sem isenção de loopback, resposta genérica e rastro durável de cada recusa.
//
// A TRAVA DESTA ROTA É A DO PERÍMETRO (story-m9jflb). Antes, o login mantinha o SEU próprio Map de
// tentativas: três réguas de contagem no mesmo serviço (login, MCP, runner) e, na prática, nenhuma
// contagem — porque um atacante que alternasse de superfície nunca encostava em teto nenhum, e nada
// disso deixava linha. Hoje o balde é UM por origem para as 6 superfícies (`lib/auth/auth-audit.ts`),
// e o Map local — que crescia sem `maxKeys`, o buraco de memória do story-mkk680 — deixou de existir:
// o teto de origens rastreadas mora no módulo do perímetro (`MAX_TRACKED_CLIENTS`).
//
// E A ORDEM É O CONTROLE: o token é COMPARADO primeiro, e só então a trava decide (`guardPerimeter`).
// A ordem inversa fazia deste portão um interruptor de negação de serviço contra o próprio dono —
// a chave da trava é a ORIGEM, e em três topologias reais ela é COMPARTILHADA com o atacante (self-host
// sem proxy, NAT de escritório/celular, CDN na frente do Caddy), então 8 chutes anônimos em qualquer
// superfície do perímetro desligavam o painel do operador por até 60 minutos. O que se perde ao
// consertar: nada. O que NÃO se ganha: barreira contra adivinhação — um chute certo durante o bloqueio
// entra por desenho, e a barreira ali é o segredo de 32 bytes.
//
// O que NÃO mudou, de propósito: a régua de identidade (`clientKey`, o último salto do XFF, sem
// isenção de loopback — a lição do ClawJacked), o teto de 8 falhas na janela de 15 min, e o CORPO
// JSON das respostas. A tela de login lê `remaining`/`locked`/`retryAfterMs` para desenhar o
// contador, então esta rota não usa `perimeterLockedResponse` (texto puro, para as rotas de máquina):
// a postura é a mesma daquela (`declarada` — 429 com `Retry-After`, já que a rota admite existir), só
// o corpo é o que a tela do operador sabe ler. Trocar isso quebraria a UI do dono sem fechar nada.

import { NextResponse } from "next/server";

import {
  PERIMETER_SURFACES,
  guardPerimeter,
  stanceOfSurface,
  type PerimeterGate,
} from "@/lib/auth/auth-audit";
import { SESSION_SECRET_ENV, authSecretsFromEnv } from "@/lib/auth/env";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_SHORT_MS,
  sessionCookieSecure,
  signSession,
} from "@/lib/auth/session";
import { MIN_OPERATOR_TOKEN_LEN, isOperatorTokenValid } from "@/lib/auth/token";

import { declaredTooLarge, readBoundedBody } from "./body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A recusa por CREDENCIAL: 401 com o JSON que a TELA lê.
 *
 * `remaining`/`locked`/`retryAfterMs` são contrato de UI — a tela desenha o contador com eles, e é por
 * isso que esta rota passa um `deny` próprio ao portão em vez de aceitar a recusa muda de texto puro
 * (que serve às rotas de máquina). O MOTIVO da recusa nunca entra aqui: distinguir "não mandou token" de
 * "mandou um que não casa" de "este serviço subiu sem token forte" só ajudaria quem está sondando — o
 * operador legítimo descobre o problema de setup pelo log do serviço, que é onde ele tem acesso.
 */
function respostaCredencialInvalida(gate: PerimeterGate): Response {
  return NextResponse.json(
    {
      ok: false,
      error: "token inválido",
      remaining: gate.remaining,
      locked: !gate.allowed,
      retryAfterMs: gate.retryAfterMs,
    },
    { status: 401 },
  );
}

/**
 * A recusa por TRAVA: 429 + `Retry-After`, também em JSON.
 *
 * A postura é a `declarada` de `perimeterLockedResponse` (esta rota já admite existir), mas o CORPO é o
 * daqui: a resposta pronta é texto puro, e usá-la faria a tela do operador perder `locked`/`retryAfterMs`
 * e parar de desenhar o contador — regressão de UX servida de graça junto do hardening.
 */
function respostaTrancada(gate: PerimeterGate): Response {
  return NextResponse.json(
    { ok: false, error: "muitas tentativas", retryAfterMs: gate.retryAfterMs, locked: true },
    { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))) } },
  );
}

export async function POST(req: Request): Promise<Response> {
  // CSRF: um <form> de outro site consegue POSTar `application/x-www-form-urlencoded` sem
  // preflight, mas NÃO `application/json` — exigir o content-type real fecha o caminho clássico
  // de login-CSRF, junto do SameSite=Lax do cookie. Mesmo padrão de /api/terminal/scroll.
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json({ ok: false, error: "content-type inválido" }, { status: 415 });
  }

  // O teto de bytes vem ANTES da trava e ANTES de qualquer leitura: é a recusa mais barata que existe
  // (só headers) e é o que garante que um `content-length` de 64 MiB não nos faz alocar nada. Corpo
  // grande demais também NÃO conta como tentativa de credencial — ele não exercitou o segredo, e
  // contá-lo daria ao atacante um jeito de trancar a origem sem nunca chutar um token.
  if (declaredTooLarge(req.headers)) {
    return NextResponse.json({ ok: false, error: "corpo grande demais" }, { status: 413 });
  }

  const now = Date.now();

  // O corpo é lido ANTES da trava, e a inversão é DELIBERADA: o portão compara a credencial primeiro,
  // então ele precisa do token em mão mesmo quando a origem já está trancada. O custo é uma leitura
  // LIMITADA por tentativa de origem trancada — o teto de bytes acima já decidiu que ela é barata —, e é
  // o preço de não existir um interruptor de negação de serviço contra o dono (ver o portão abaixo).
  //
  // Um corpo malformado/grande/lento continua NÃO contando como tentativa de credencial: ele não
  // exercitou o segredo, responde igual em qualquer estado da trava (logo não é oráculo) e contá-lo daria
  // ao atacante um jeito de encher a trava sem nunca chutar um token.
  const corpo = await readBoundedBody(req);
  if (!corpo.ok) {
    const erro =
      corpo.status === 413 ? "corpo grande demais" : corpo.status === 408 ? "corpo lento demais" : "corpo inválido";
    return NextResponse.json({ ok: false, error: erro }, { status: corpo.status });
  }

  let token = "";
  let remember = true;
  try {
    const body = JSON.parse(corpo.text) as { token?: unknown; remember?: unknown };
    token = typeof body.token === "string" ? body.token.trim() : "";
    remember = body.remember !== false;
  } catch {
    return NextResponse.json({ ok: false, error: "corpo inválido" }, { status: 400 });
  }

  const { operatorToken } = authSecretsFromEnv();

  // O PORTÃO. A ordem é o controle: COMPARA o token → só então a trava decide.
  //
  // ⚠️ A ordem inversa (trava → compara) era um interruptor de DoS contra o próprio dono, e nesta rota
  // ela desligava o PAINEL. A chave da trava é a origem, e em três topologias REAIS o atacante e o dono
  // dividem a MESMA: self-host sem proxy (todos caem em `sem-proxy`), NAT compartilhado (escritório,
  // celular) e CDN na frente do Caddy (o último salto passa a ser o proxy). Bastavam 8 chutes anônimos —
  // aqui ou em qualquer outra das superfícies, já que o balde é um só por origem — para o dono levar 429
  // com o token CERTO na mão por até 60 minutos. Qualquer pessoa na internet desligava o painel de graça,
  // sem nunca adivinhar nada.
  //
  // O que isso NÃO é: bypass. Um chute CERTO durante o bloqueio entra por desenho — a barreira contra
  // adivinhação é o segredo de 32 bytes, não o contador; a trava encarece, nega serviço a quem martela e
  // produz o rastro. E o acerto ZERA o balde, então o operador que colou um token velho três vezes não
  // arrasta backoff depois de acertar.
  const portao = await guardPerimeter<true>({
    headers: req.headers,
    surface: PERIMETER_SURFACES.login,
    via: "body",
    stance: stanceOfSurface(PERIMETER_SURFACES.login),
    // Cru de propósito: o ledger mascara para o comprimento antes de tocar o disco.
    presented: token,
    now,
    // Sem try/catch defensivo de propósito: se o comparador lançar, `guardPerimeter` conta a tentativa,
    // grava `erro-na-comparacao` e recusa com a MESMA resposta — fail-closed, sem canal de sondagem.
    validate: () => {
      if (isOperatorTokenValid(token, operatorToken)) return { valid: true, value: true };
      // O MOTIVO só existe no rastro, nunca na resposta. Distinguir "não mandou token" de "mandou um
      // que não casa" de "este serviço subiu sem token forte" é o que transforma o arquivo forense em
      // diagnóstico; dizer isso ao cliente ajudaria só quem está sondando.
      //
      // Setup quebrado (`token-fraco`) CONTA na trava igual aos outros: o motivo depende da NOSSA
      // config, não do que o cliente manda, então não há como um atacante escolher esse ramo — e um
      // ramo isento seria uma exceção que ninguém consegue exercitar de fora, só um caminho a mais
      // para regredir.
      const reason = !token
        ? "ausente"
        : operatorToken.length < MIN_OPERATOR_TOKEN_LEN
          ? "token-fraco"
          : "desconhecida";
      return { valid: false, reason };
    },
    deny: respostaCredencialInvalida,
  });
  if (!portao.ok) {
    // Trancada (por esta falha ou por qualquer outra superfície do perímetro) ⇒ 429, para o cliente
    // aprender a esperar na hora em vez de descobrir no request seguinte. O corpo sai daqui e não da
    // resposta pronta, senão a tela do operador perderia o contador.
    if (!portao.gate.allowed) return respostaTrancada(portao.gate);
    return portao.response;
  }

  let cookieValue: string;
  try {
    cookieValue = await signSession({
      ...authSecretsFromEnv(),
      ttlMs: remember ? SESSION_TTL_MS : SESSION_TTL_SHORT_MS,
    });
  } catch {
    // Token certo mas segredo de sessão fraco/ausente: é falha de SETUP do serviço, não do
    // operador — e emitir cookie sob segredo fraco seria emitir cookie forjável. NÃO entra na trava:
    // quem chegou aqui apresentou a credencial CERTA, e trancá-lo faria o operador que está
    // consertando a env perder também o caminho de volta.
    console.error(`[auth] ${SESSION_SECRET_ENV} ausente ou fraco — instrumentation.ts não rodou?`);
    return NextResponse.json(
      { ok: false, error: "serviço sem segredo de sessão — verifique o log do AgileHarness" },
      { status: 500 },
    );
  }

  // O acerto já PERDOOU a janela desta origem dentro do portão (`guardPerimeter` chama
  // `recordAuthSuccess` no ramo válido) — registrá-lo de novo aqui seria uma segunda régua para a mesma
  // coisa, e a que apodrece. Note que o perdão acontece ANTES da assinatura, de propósito: quem
  // apresentou a credencial certa não pode ficar preso por um defeito de SETUP nosso (segredo de sessão
  // fraco) justamente quando está consertando a env.

  // `no-store`: esta resposta CARREGA o Set-Cookie da sessão. Um intermediário que a guardasse
  // entregaria a sessão do operador para o próximo que pedisse.
  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    // `secure` sai da CONFIG do operador, não do pedido: um `x-forwarded-proto` duplicado
    // (`"http, https"`, o que um proxy que apenda produz) fazia a comparação com `"https"` falhar e a
    // sessão nascer em texto claro atrás de TLS. A regra e os degraus estão em `sessionCookieSecure`.
    secure: sessionCookieSecure({ requestUrl: req.url, forwardedProto: req.headers.get("x-forwarded-proto") }),
    path: "/",
    maxAge: Math.floor((remember ? SESSION_TTL_MS : SESSION_TTL_SHORT_MS) / 1000),
  });
  return res;
}
