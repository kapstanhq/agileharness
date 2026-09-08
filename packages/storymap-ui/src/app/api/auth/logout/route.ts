// Encerra a sessão deste dispositivo — apaga o cookie e nada mais.
//
// Não invalida as OUTRAS sessões: como o cookie é assinado e sem estado (lib/auth/session.ts),
// não há registro para revogar. Derrubar TODAS de uma vez = rotacionar o `session-secret` OU o
// token do operador — os dois entram na chave de assinatura — e reiniciar o serviço.

import { NextResponse } from "next/server";

import { SESSION_COOKIE, sessionCookieSecure } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // Mesmo guarda de content-type do login, pela mesma razão: um `<form>` hospedado em outro site
  // consegue POSTar `x-www-form-urlencoded` sem preflight, mas NÃO `application/json`. Sem isto,
  // qualquer página que o operador abrisse conseguia deslogá-lo do board de fora (CSRF de logout)
  // — não vaza nada, mas é um incômodo repetível indefinidamente por quem quiser atrapalhar.
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json(
      { ok: false, error: "content-type inválido" },
      { status: 415, headers: { "cache-control": "no-store" } },
    );
  }

  const res = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    // `secure` sai da MESMA régua que decidiu o cookie no login (`sessionCookieSecure`), e não de um
    // default. O que isso impede: um "sair" que responde `{ok:true}` sem apagar nada. Um Set-Cookie SEM
    // `Secure` recebido por canal não-seguro é IGNORADO pelo navegador quando já existe um cookie
    // `Secure` de mesmo nome/path (a regra anti-shadowing do RFC 6265bis, §5.6) — então num board que
    // atende http E https (LAN + túnel) o logout pelo lado http deixava a sessão https VIVA, e o
    // operador acreditava ter encerrado o dispositivo. Atributo de criação e de destruição são a mesma
    // decisão; duas réguas para o mesmo cookie é a que apodrece.
    //
    // `forwardedProto: null` é deliberado: aqui o header do pedido NÃO tem voz. Deixá-lo decidir
    // devolveria o mesmo buraco que o portão fechou — um `x-forwarded-proto: http` forjado desligaria
    // o `Secure` da limpeza e faria o navegador manter o cookie `Secure` que já existe.
    secure: sessionCookieSecure({ requestUrl: req.url, forwardedProto: null }),
    path: "/",
    maxAge: 0,
  });
  return res;
}
