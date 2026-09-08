// O `Secure` DO COOKIE DE SESSÃO — quem decide é a config do operador, não quem faz o pedido (t3 do
// story-2i89ai).
//
// O que estes testes impedem de voltar: a sessão do operador nascendo SEM `Secure` num deploy HTTPS.
// A decisão morava num `=== "https"` sobre o `x-forwarded-proto` inteiro, e `x-forwarded-proto` é
// texto que passa por (ou nasce em) quem faz o pedido: um único salto a mais na cadeia — proxy que
// APÊNDA em vez de sobrescrever, ou um cliente que manda o header e o proxy acrescenta o dele — e a
// string vira `"http, https"`, que não é igual a `"https"`. Resultado medido: o board inteiro passa a
// emitir a sessão sem `Secure` atrás de TLS, e nada fica vermelho. Cookie sem `Secure` é cookie que o
// navegador entrega em texto claro no primeiro `http://` — e provocar downgrade é justamente o que o
// atacante sabe fazer.
//
// Cada teste nomeia o ATAQUE (ou o cenário de operação que não pode regredir), nunca a linha que o
// implementa. Custo de autonomia: ZERO — nada aqui restringe o que o agente executa.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/auth/login/route";
import { flushAuthFailures, resetPerimeterState } from "@/lib/auth/auth-audit";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { PUBLIC_ORIGIN_ENV, SESSION_COOKIE, sessionCookieSecure } from "@/lib/auth/session";
import { PUBLIC_ORIGIN_ENV as PUBLIC_ORIGIN_ENV_DO_PORTAO } from "@/middleware";

/** Token e segredo FORTES (≥ 32 chars): abaixo do piso a rota fail-closed e não emitiria cookie nenhum. */
const TOKEN = "T".repeat(43);
const SESSION_SECRET = "S".repeat(43);

/**
 * Faz um login que DÁ CERTO e devolve os atributos do `Set-Cookie` como o navegador os leria.
 *
 * `ip` é próprio de cada caso porque a trava de força-bruta do perímetro é um balde por origem — dois
 * testes na mesma identidade se contaminariam.
 */
async function atributosDoCookie(opts: {
  ip: string;
  /** A URL do pedido como o SERVIDOR a vê. Loopback = self-host; domínio = alcançado de fora. */
  url?: string;
  /** O `x-forwarded-proto` CRU (é aqui que entra o header duplicado). */
  forwardedProto?: string;
}): Promise<{ status: number; raw: string; attrs: Map<string, string> }> {
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": opts.ip });
  if (opts.forwardedProto !== undefined) headers.set("x-forwarded-proto", opts.forwardedProto);
  const res = await POST(
    new Request(opts.url ?? "http://localhost:3008/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
  const raw = res.headers.get("set-cookie") ?? "";
  const attrs = new Map<string, string>();
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    attrs.set(k.toLowerCase(), rest.join("="));
  }
  return { status: res.status, raw, attrs };
}

let prevToken: string | undefined;
let prevSecret: string | undefined;
let prevPublicUrl: string | undefined;
let prevStateDir: string | undefined;
let stateDir = "";

beforeEach(() => {
  prevToken = process.env[TOKEN_ENV];
  prevSecret = process.env[SESSION_SECRET_ENV];
  prevPublicUrl = process.env[PUBLIC_ORIGIN_ENV];
  prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
  process.env[TOKEN_ENV] = TOKEN;
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  delete process.env[PUBLIC_ORIGIN_ENV];
  // O rastro do perímetro é um ARQUIVO: cada teste ganha o seu, para nenhum escrever no estado do
  // serviço vivo desta VPS.
  stateDir = mkdtempSync(path.join(tmpdir(), "cookie-secure-"));
  process.env.STORYMAP_RUNNER_STATE_DIR = stateDir;
  resetPerimeterState();
});

afterEach(async () => {
  await flushAuthFailures();
  resetPerimeterState();
  for (const [nome, valor] of [
    [TOKEN_ENV, prevToken],
    [SESSION_SECRET_ENV, prevSecret],
    [PUBLIC_ORIGIN_ENV, prevPublicUrl],
    ["STORYMAP_RUNNER_STATE_DIR", prevStateDir],
  ] as const) {
    if (valor === undefined) delete process.env[nome];
    else process.env[nome] = valor;
  }
  // DEPOIS do flush: o rastro do perímetro ainda escreve neste diretório. Apagá-lo antes trocaria
  // um diretório órfão por um erro de escrita intermitente.
  rmSync(stateDir, { recursive: true, force: true });
});

describe("cookie de sessão · Secure decidido por configuração", () => {
  it("ATAQUE: um x-forwarded-proto DUPLICADO não rebaixa o cookie de um deploy https", async () => {
    // O board está declarado como https. A partir daí, NADA que venha no pedido pode fazer a sessão
    // nascer sem `Secure` — nem uma lista com o `http` na frente (proxy que apenda depois de o cliente
    // ter mandado o seu), nem uma lista com o `http` no fim, nem um `http` sozinho (o proxy TLS que
    // OMITE o header e deixa o do cliente passar).
    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";

    const forjados = ["http, https", "https, http", "http", "HTTP", " http ", "http;https"];
    for (const [i, proto] of forjados.entries()) {
      const { status, attrs } = await atributosDoCookie({ ip: `198.51.100.${i + 1}`, forwardedProto: proto });
      expect(status, `login legítimo deveria passar (proto=${proto})`).toBe(200);
      expect(attrs.has("secure"), `x-forwarded-proto=${proto} NÃO pode desligar o Secure`).toBe(true);
    }
  });

  it("ATAQUE: sem o header nenhum, o deploy https declarado ainda nasce Secure", async () => {
    // O resíduo real do desenho antigo: nginx sem `proxy_set_header X-Forwarded-Proto $scheme`. O
    // header simplesmente não existe, a conexão até o app é http, e o cookie saía em claro.
    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";
    const { status, attrs } = await atributosDoCookie({ ip: "198.51.100.20" });
    expect(status).toBe(200);
    expect(attrs.has("secure")).toBe(true);
  });

  it("os outros atributos sobrevivem ao Secure — HttpOnly, SameSite=Lax, Path=/ e Max-Age juntos", async () => {
    // O `Secure` não pode ter vindo no lugar de nenhum dos outros: HttpOnly barra a LEITURA por XSS,
    // SameSite=Lax barra CSRF e clickjacking com sessão, Path=/ cobre toda superfície que o portão
    // cobre, e o Max-Age espelha o `exp` ASSINADO (a validade real, que `verifySession` confere).
    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";
    const { raw, attrs } = await atributosDoCookie({ ip: "198.51.100.21" });
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(attrs.has("secure")).toBe(true);
    expect(attrs.has("httponly")).toBe(true);
    expect(raw.toLowerCase()).toMatch(/;\s*samesite=lax\b/);
    expect(attrs.get("path")).toBe("/");
    expect(Number(attrs.get("max-age"))).toBeGreaterThan(0);
  });

  it("self-host em http://localhost continua utilizável — o Secure não entra em laço de login", async () => {
    // O que este caso protege: cravar `Secure` sempre faria o navegador DESCARTAR o cookie em
    // `http://localhost:3008`, e o operador cairia num laço (loga, volta para /login, loga…). Sem env
    // declarada e em loopback, o cookie nasce sem `Secure` — exatamente como antes desta mudança.
    const { status, attrs } = await atributosDoCookie({ ip: "198.51.100.30" });
    expect(status).toBe(200);
    expect(attrs.has("secure")).toBe(false);
  });

  it("sem env declarada, um pedido que chega de FORA da máquina já nasce Secure", async () => {
    // O default seguro: se o serviço está sendo alcançado por um endereço que não é loopback, não é
    // dev — e "não declarei a env" não pode significar "então manda a sessão em claro".
    const { status, attrs } = await atributosDoCookie({
      ip: "198.51.100.31",
      url: "http://board.exemplo.dev/api/auth/login",
    });
    expect(status).toBe(200);
    expect(attrs.has("secure")).toBe(true);
  });

  it("http DECLARADO é escolha explícita do operador — e o cliente não consegue desfazê-la", async () => {
    // Quem escreve `AGILEHARNESS_PUBLIC_URL=http://…` (LAN, túnel local) aceitou texto claro por
    // escrito. O ponto do teste é o outro lado: um `x-forwarded-proto: https` forjado NÃO liga o
    // `Secure` para derrubar o login desse operador — a config decide nos dois sentidos.
    process.env[PUBLIC_ORIGIN_ENV] = "http://192.168.1.10:3008";
    const { status, attrs } = await atributosDoCookie({ ip: "198.51.100.40", forwardedProto: "https" });
    expect(status).toBe(200);
    expect(attrs.has("secure")).toBe(false);
  });
});

describe("sessionCookieSecure · a régua isolada", () => {
  const decidir = (env: Record<string, string | undefined>, url: string, proto?: string) =>
    sessionCookieSecure({ requestUrl: url, forwardedProto: proto, env });

  it("a config DECLARADA ganha de qualquer header, nos dois sentidos", () => {
    const https = { [PUBLIC_ORIGIN_ENV]: "https://board.exemplo.dev" };
    expect(decidir(https, "http://localhost:3008/x", "http")).toBe(true);
    expect(decidir(https, "http://localhost:3008/x")).toBe(true);

    const http = { [PUBLIC_ORIGIN_ENV]: "http://board.local:3008" };
    expect(decidir(http, "https://board.local/x", "https")).toBe(false);
  });

  it("env impensável NÃO conta como declaração — cai no degrau seguinte, nunca em 'confia no cliente'", () => {
    for (const bruto of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "board.exemplo.dev", "://x"]) {
      // Sem declaração válida + loopback http ⇒ sem Secure (dev). O que importa é que um valor
      // impossível não vire "declarada como https" nem trave o self-host.
      expect(decidir({ [PUBLIC_ORIGIN_ENV]: bruto }, "http://127.0.0.1:3008/x"), bruto).toBe(false);
      expect(decidir({ [PUBLIC_ORIGIN_ENV]: bruto }, "http://board.exemplo.dev/x"), bruto).toBe(true);
    }
  });

  it("todo endereço de loopback é loopback — 127.0.0.0/8, ::1 e .localhost", () => {
    for (const url of [
      "http://localhost:3008/x",
      "http://LOCALHOST:3008/x",
      "http://board.localhost:3008/x",
      "http://127.0.0.1:3008/x",
      "http://127.0.0.2:3008/x",
      "http://[::1]:3008/x",
    ]) {
      expect(decidir({}, url), url).toBe(false);
    }
    // …e o resto não é: LAN, IP público e o bind curinga.
    for (const url of ["http://192.168.1.10:3008/x", "http://203.0.113.7/x", "http://0.0.0.0:3008/x"]) {
      expect(decidir({}, url), url).toBe(true);
    }
  });

  it("qualquer salto dizendo https vale como https — acrescentar só LIGA o Secure", () => {
    // Direção monotônica de propósito: quem forja o header consegue no máximo ligar o flag e sumir
    // com o próprio cookie (auto-sabotagem). Desligar, não.
    expect(decidir({}, "http://localhost:3008/x", "https")).toBe(true);
    expect(decidir({}, "http://localhost:3008/x", "http, https")).toBe(true);
    expect(decidir({}, "http://localhost:3008/x", "https,http")).toBe(true);
    expect(decidir({}, "http://localhost:3008/x", "http")).toBe(false);
    expect(decidir({}, "http://localhost:3008/x", "")).toBe(false);
    // A própria URL do pedido em https também é sinal (acesso direto ao serviço sob TLS).
    expect(decidir({}, "https://localhost:3008/x")).toBe(true);
  });

  it("URL impensável cai no lado SEGURO — 'não sei onde estou' não pode virar texto claro", () => {
    expect(decidir({}, "isto não é uma url")).toBe(true);
  });

  it("o nome da env é o MESMO que o portão usa — drift aqui falha calado", () => {
    // Duas cópias da string existem por limite de runtime (o middleware roda no Edge). O pino é este
    // teste: renomear de um lado deixaria o outro lendo `undefined` — cookie sem Secure de um lado,
    // bounce em localhost do outro, suíte verde.
    expect(PUBLIC_ORIGIN_ENV).toBe(PUBLIC_ORIGIN_ENV_DO_PORTAO);
  });
});
