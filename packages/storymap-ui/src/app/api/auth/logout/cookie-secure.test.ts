// O `Secure` DO COOKIE DE LIMPEZA — criação e destruição decididas pela MESMA régua (t3 do story-2i89ai).
//
// O que estes testes impedem de voltar: um "sair" que responde `{ok:true}` sem apagar nada. A onda 3
// passou a decidir o `Secure` do cookie de sessão pela CONFIG do operador (`sessionCookieSecure`, degraus
// documentados em `lib/auth/session.ts`) e fiou isso no `/api/auth/login` — o logout continuou emitindo o
// cookie vazio com atributos FIXOS, sem `Secure`. Um `Set-Cookie` sem `Secure` recebido por canal
// não-seguro é IGNORADO pelo navegador quando já existe um cookie `Secure` de mesmo nome/path (a regra
// anti-shadowing do RFC 6265bis §5.6): num board alcançável por http E https (LAN + túnel, o self-host
// comum), sair pelo lado http deixava a sessão https VIVA — e o operador acreditava ter encerrado o
// dispositivo, que é a única leitura possível de um `{ok:true}`.
//
// Vive num arquivo próprio (e não junto do `route.test.ts`, que congela o perímetro CSRF do logout)
// porque a régua sob teste aqui é a do COOKIE, a mesma de `session-cookie-secure.test.ts` no login.
// CUSTO DE AUTONOMIA: ZERO — nada aqui muda o que o agente executa.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PUBLIC_ORIGIN_ENV, SESSION_COOKIE } from "@/lib/auth/session";
import { POST } from "./route";

/** Faz um logout LEGÍTIMO e devolve os atributos do `Set-Cookie` como o navegador os leria. */
async function limpeza(opts: {
  /** A URL do pedido como o SERVIDOR a vê. Loopback = self-host; domínio = alcançado de fora. */
  url?: string;
  /** O `x-forwarded-proto` CRU (é aqui que entra o header forjado/duplicado). */
  forwardedProto?: string;
}): Promise<{ status: number; raw: string; attrs: Map<string, string> }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.forwardedProto !== undefined) headers.set("x-forwarded-proto", opts.forwardedProto);
  const res = await POST(
    new Request(opts.url ?? "http://localhost:3008/api/auth/logout", { method: "POST", headers, body: "{}" }),
  );
  const raw = res.headers.get("set-cookie") ?? "";
  const attrs = new Map<string, string>();
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    attrs.set(k.toLowerCase(), rest.join("="));
  }
  return { status: res.status, raw, attrs };
}

let prevPublicUrl: string | undefined;

beforeEach(() => {
  prevPublicUrl = process.env[PUBLIC_ORIGIN_ENV];
  delete process.env[PUBLIC_ORIGIN_ENV];
});

afterEach(() => {
  if (prevPublicUrl === undefined) delete process.env[PUBLIC_ORIGIN_ENV];
  else process.env[PUBLIC_ORIGIN_ENV] = prevPublicUrl;
});

describe("logout · o cookie de limpeza espelha o Secure decidido na criação", () => {
  it("num deploy https DECLARADO a limpeza sai Secure — senão o navegador a ignora", async () => {
    // O cenário do defeito: o cookie de sessão nasceu `Secure` (a config manda), e a limpeza saía sem.
    // Cookie que não casa não é apagado — e a resposta `{ok:true}` mente para o operador.
    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";
    const { status, raw, attrs } = await limpeza({});
    expect(status).toBe(200);
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(attrs.has("secure"), "limpeza sem Secure não apaga um cookie Secure de mesmo nome/path").toBe(true);
  });

  it("sem env declarada, um pedido que chega de FORA da máquina também limpa com Secure", async () => {
    // Mesmo degrau do login: serviço alcançado por endereço que não é loopback não é dev, e "não
    // declarei a env" não pode significar "então emite a limpeza em claro".
    const { attrs } = await limpeza({ url: "http://board.exemplo.dev/api/auth/logout" });
    expect(attrs.has("secure")).toBe(true);
  });

  it("self-host em http://localhost continua conseguindo SAIR — Secure ali não apagaria nada", async () => {
    // O outro lado, e o motivo de a régua não ser `secure: true` incondicional: em
    // `http://localhost:3008` o navegador DESCARTA um Set-Cookie `Secure`, e o operador ficaria sem
    // conseguir encerrar a sessão. Os dois lados coincidem por construção porque a régua é UMA.
    const { status, attrs } = await limpeza({});
    expect(status).toBe(200);
    expect(attrs.has("secure")).toBe(false);
  });

  it("ATAQUE: x-forwarded-proto forjado não decide o Secure da limpeza — a CONFIG decide", async () => {
    // O mesmo resíduo que o login fechou: quem faz o pedido acrescenta saltos ao header. Com a config
    // declarada http (LAN/túnel, escolha escrita do operador), um `https` forjado não pode ligar o flag e
    // tirar dele o botão de sair; com a config https, nenhum `http` — nem em lista — o desliga.
    process.env[PUBLIC_ORIGIN_ENV] = "http://192.168.1.10:3008";
    expect((await limpeza({ forwardedProto: "https" })).attrs.has("secure")).toBe(false);

    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";
    for (const proto of ["http, https", "https, http", "http", "HTTP", " http "]) {
      const { attrs } = await limpeza({ forwardedProto: proto });
      expect(attrs.has("secure"), `x-forwarded-proto=${proto} NÃO pode desligar o Secure da limpeza`).toBe(true);
    }
  });

  it("o Secure não entrou no lugar dos outros atributos — o par continua casando", async () => {
    // Um `path`/`sameSite`/`httpOnly` diferente do usado na criação produz o MESMO efeito de "não casa,
    // logo não apaga"; e o cookie tem de sair vazio e expirado, não só com atributos bonitos.
    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";
    const { raw, attrs } = await limpeza({});
    expect(attrs.has("httponly")).toBe(true);
    expect(raw.toLowerCase()).toMatch(/;\s*samesite=lax\b/);
    expect(attrs.get("path")).toBe("/");
    expect(attrs.get("max-age")).toBe("0");
    expect(attrs.get(SESSION_COOKIE.toLowerCase()), "a limpeza não pode carregar valor de sessão").toBe("");
  });
});
