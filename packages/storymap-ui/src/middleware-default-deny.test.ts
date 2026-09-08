// TRAVA DE REGRESSÃO do PORTÃO (story-l9y3wh) — a camada 1 das três que fecham o perímetro.
//
// `public-routes.test.ts` crava o PREDICADO (`isPublicPath`) e congela a lista pública. O que faltava
// é a trava do PORTÃO em si: que o middleware realmente nega por default, que ele usa o predicado, e
// que um serviço mal inicializado TRANCA em vez de abrir. Sem isto, dá para regredir o gate inteiro
// (trocar `isPublicPath` por um `startsWith`, tratar segredo ausente como "sem auth configurada",
// devolver `next()` no caminho de erro) com a suíte verde do começo ao fim.
//
// Nenhum caso aqui restringe o que o agente faz: o portão é sobre QUEM entra, não sobre o que se
// executa depois de entrar.

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { MIN_SESSION_SECRET_LEN, SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { PUBLIC_ORIGIN_ENV, middleware } from "@/middleware";

const TOKEN = "T".repeat(43);
const SESSION_SECRET = "S".repeat(43);

function request(pathname: string, opts: { cookie?: string; headers?: Record<string, string> } = {}): NextRequest {
  const headers = new Headers(opts.headers ?? {});
  if (opts.cookie !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${opts.cookie}`);
  return new NextRequest(new Request(`http://localhost:3008${pathname}`, { headers }));
}

/** `NextResponse.next()` se identifica por este header — é como se vê "o portão DEIXOU passar". */
function passedThrough(res: Response): boolean {
  return res.headers.get("x-middleware-next") === "1";
}

let prevToken: string | undefined;
let prevSecret: string | undefined;
let prevPublicOrigin: string | undefined;

beforeEach(() => {
  prevToken = process.env[TOKEN_ENV];
  prevSecret = process.env[SESSION_SECRET_ENV];
  prevPublicOrigin = process.env[PUBLIC_ORIGIN_ENV];
  process.env[TOKEN_ENV] = TOKEN;
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  // Estado default de TODO caso: origem pública NÃO declarada — o pior cenário, em que só o
  // fallback protege. Quem quiser a origem declarada a seta explicitamente no próprio caso.
  delete process.env[PUBLIC_ORIGIN_ENV];
});

afterEach(() => {
  if (prevToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = prevToken;
  if (prevSecret === undefined) delete process.env[SESSION_SECRET_ENV];
  else process.env[SESSION_SECRET_ENV] = prevSecret;
  if (prevPublicOrigin === undefined) delete process.env[PUBLIC_ORIGIN_ENV];
  else process.env[PUBLIC_ORIGIN_ENV] = prevPublicOrigin;
});

const validCookie = () => signSession({ sessionSecret: SESSION_SECRET, operatorToken: TOKEN });

describe("o portão nega por default", () => {
  it("página sem sessão vai para o login, carregando o destino saneado", async () => {
    // ATAQUE que isto impede: o serviço escuta em :3008 e, antes deste portão, servia o board INTEIRO
    // para quem batesse direto na porta — a autenticação vivia no basic_auth do proxy, que não viaja
    // com o repositório. Quem instala o OSS atrás de nginx/nada não herdava proteção nenhuma.
    const res = await middleware(request("/board/storymap?card=story-1"));
    expect(passedThrough(res)).toBe(false);
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain(`next=${encodeURIComponent("/board/storymap?card=story-1")}`);
    // Nenhum cache pode guardar a NEGATIVA e devolvê-la depois que o operador já entrou.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("`.well-known` responde 404, NUNCA um redirect para o login", async () => {
    // BUG DE PRODUTO medido em 2026-08-06, com o operador travado na tela do conector.
    //
    // Um cliente MCP faz DESCOBERTA antes de tentar a credencial: pergunta por
    // `/.well-known/oauth-protected-resource` e decide, pela resposta, se o servidor fala OAuth.
    // Sem este ramo o caminho caía no deny-por-default e devolvia `307 → /login`; o cliente lê um
    // redirect para uma tela de login como "existe OAuth aqui", tenta registrar um client e falha
    // com "Não foi possível registrar no serviço de login" — sem NUNCA bater no endpoint MCP.
    //
    // A prova do diagnóstico foi a AUSÊNCIA: zero requisições a `/api/usm` no log do proxy durante
    // as tentativas, e o handle recém-cunhado marcado "último uso nunca".
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/mcp",
      "/.well-known",
    ]) {
      const res = await middleware(request(p));
      expect(res.status, `${p} precisa devolver 404`).toBe(404);
      // O 307 é o defeito: é ele que diz "há um serviço de login" a quem só queria descobrir.
      expect(res.headers.get("location"), `${p} não pode redirecionar`).toBeNull();
      expect(res.headers.get("cache-control")).toContain("no-store");
    }

    // O PAR que torna isto discriminante: um caminho VIZINHO, que só parece `.well-known`, tem de
    // continuar caindo no portão. Sem esta metade, `startsWith` largo demais abriria rota real.
    const vizinho = await middleware(request("/.well-knownx/segredo"));
    expect(vizinho.status, "`/.well-knownx` não herda a isenção").toBe(307);
  });

  it("rota de API sem sessão recebe 401, não a tela de login", async () => {
    const res = await middleware(request("/api/processes"));
    expect(passedThrough(res)).toBe(false);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("com sessão válida, o portão deixa passar", async () => {
    const res = await middleware(request("/board/storymap", { cookie: await validCookie() }));
    expect(passedThrough(res)).toBe(true);
    expect(res.headers.get("location")).toBeNull();
  });

  it("PREFIXO IRMÃO: `/api/authorize-tudo` NÃO herda a isenção de `/api/auth`", async () => {
    // ATAQUE clássico de isenção por path: o gate compara com `startsWith` cru e uma rota nova cujo
    // nome COMEÇA igual ao de uma pública nasce aberta em silêncio. Aqui o portão casa por SEGMENTO.
    for (const p of ["/api/authorize-tudo", "/api/auth-interno", "/api/healthz-interno"]) {
      const res = await middleware(request(p));
      expect(passedThrough(res), `${p} atravessou o portão sem sessão`).toBe(false);
      expect(res.status).toBe(401);
    }
    expect(passedThrough(await middleware(request("/logindisfarcado")))).toBe(false);
  });

  it("o login e o health continuam alcançáveis SEM sessão", async () => {
    // O outro lado da moeda: um portão que trancasse a própria tela de login viraria laço de
    // redirect, e um /api/health gateado marcaria o serviço como DOENTE no monitor de stack.
    expect(passedThrough(await middleware(request("/login")))).toBe(true);
    expect(passedThrough(await middleware(request("/api/health")))).toBe(true);
    expect(passedThrough(await middleware(request("/api/auth/login")))).toBe(true);
  });

  it("cookie FORJADO não entra — nem com um exp generoso", async () => {
    // ATAQUE: o payload é base64 legível, então esticar o `exp` é trivial. Quem não tem a chave não
    // consegue refazer a assinatura, e a verificação vem ANTES do parse.
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 9e9 })).toString("base64url");
    for (const forged of [`${payload}.assinaturaFalsa`, payload, "lixo", ""]) {
      const res = await middleware(request("/board/storymap", { cookie: forged }));
      expect(passedThrough(res), `cookie forjado (${forged.slice(0, 12)}…) atravessou`).toBe(false);
    }
  });

  it("cookie EXPIRADO não entra", async () => {
    const expired = await signSession({
      sessionSecret: SESSION_SECRET,
      operatorToken: TOKEN,
      ttlMs: 1,
      now: Date.now() - 60_000,
    });
    expect(passedThrough(await middleware(request("/board/storymap", { cookie: expired })))).toBe(false);
  });

  it("serviço SEM segredo TRANCA — não abre (fail-closed)", async () => {
    // O footgun pré-ClawJacked que este desenho recusa: interpretar "não achei segredo" como "este
    // serviço não usa autenticação" e liberar. Um boot em que `instrumentation.ts` não rodou tem de
    // ficar inacessível, não público.
    const cookie = await validCookie();
    delete process.env[TOKEN_ENV];
    delete process.env[SESSION_SECRET_ENV];
    expect(passedThrough(await middleware(request("/board/storymap", { cookie })))).toBe(false);
    expect(passedThrough(await middleware(request("/")))).toBe(false);
  });

  it("segredo FRACO tranca igual — não há autenticação contra lixo", async () => {
    const weak = "x".repeat(MIN_SESSION_SECRET_LEN - 1);
    const cookie = await validCookie();
    process.env[SESSION_SECRET_ENV] = weak;
    expect(passedThrough(await middleware(request("/board/storymap", { cookie })))).toBe(false);
    process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
    process.env[TOKEN_ENV] = weak;
    expect(passedThrough(await middleware(request("/board/storymap", { cookie })))).toBe(false);
  });

  it("o `?next=` do redirect não vira open-redirect para fora do serviço", async () => {
    // ATAQUE: `//sitedoatacante` é uma URL protocol-relative — o navegador completa o esquema e SAI
    // do site. Se ele entrasse no `?next=`, a tela de login (onde o operador acabou de digitar o
    // token) mandaria o operador para um clone pedindo "de novo".
    //
    // ⚠️ Este caso cobre SÓ o DESTINO (`?next=`). O HOST do `Location` é a outra metade do vetor e
    // tem os casos próprios abaixo — por não tê-los, este arquivo passava inteiro com o open
    // redirect ABERTO: um teste chamado "open redirect" cobrindo metade do caminho dá confiança
    // falsa justamente onde ela custa mais.
    const res = await middleware(request("//sitedoatacante"));
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("http://localhost:3008/login");
    expect(location).not.toContain("next=");
  });
});

// ── O HOST do redirect não é escolha do cliente ─────────────────────────────────────────────────
//
// O ATAQUE, inteiro: o operador clica num link LEGÍTIMO do painel dele (`https://ah.exemplo/board`)
// e o portão, sem sessão, responde `Location:` para o domínio do ATACANTE — que serve um clone da
// tela de login e colhe o token do operador. É o vetor clássico de roubo de credencial: a vítima
// chega ao clone a partir de uma URL que ela reconhece, então nada na jornada parece errado.
//
// A entrada do atacante são os headers `x-forwarded-*` (e o `Host`): num deploy sem proxy que os
// REESCREVA, é texto escolhido por quem faz o pedido. Envenenar um cache compartilhado com essa
// resposta 307 (mesmo com `no-store`, um intermediário mal configurado guarda) transforma o
// header do atacante no redirect que a VÍTIMA recebe depois — o pedido dele, o clique dela.
//
// A régua daqui: a origem do `Location` vem de CONFIGURAÇÃO do operador ou da origem do PRÓPRIO
// servidor. De header do cliente, NUNCA.
describe("o host do redirect do portão não vem do cliente", () => {
  const ORIGEM_DO_SERVICO = "http://localhost:3008";

  it("`x-forwarded-host` de atacante NÃO vira o host do Location", async () => {
    const res = await middleware(
      request("/board/storymap", {
        headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location, "o portão mandou o operador para o host do atacante").not.toContain("evil.example");
    expect(new URL(location).origin).toBe(ORIGEM_DO_SERVICO);
    // A negação e o destino continuam intactos — fechar o host não pode custar o `?next=`.
    expect(location).toContain(`next=${encodeURIComponent("/board/storymap")}`);
  });

  it("uma CADEIA de `x-forwarded-host` não cola o primeiro salto no Location", async () => {
    // Variante que passa por qualquer defesa que só olhe o header inteiro: o atacante prefixa o
    // host dele na lista, contando com um `split(",")[0]` do lado de cá.
    const res = await middleware(
      request("/board", { headers: { "x-forwarded-host": "evil.example, ah.legitimo.dev" } }),
    );
    expect(res.headers.get("location") ?? "").not.toContain("evil.example");
  });

  it("`Host` forjado também não escolhe o destino do operador", async () => {
    // O `Host` é o fallback histórico e é igualmente texto do cliente quando nenhum proxy casa por
    // domínio. Um deploy exposto direto na porta não tem quem o reescreva.
    const res = await middleware(request("/board", { headers: { host: "evil.example" } }));
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("evil.example");
    expect(new URL(location).origin).toBe(ORIGEM_DO_SERVICO);
  });

  it("`x-forwarded-proto` forjado não reescreve o esquema do Location", async () => {
    // Não é o vetor de roubo, mas é a mesma classe: o esquema do destino não se lê de header do
    // cliente. Um `https` forjado num serviço que só fala http manda o operador para uma porta
    // que não responde — negação de acesso ao próprio painel.
    const res = await middleware(request("/board", { headers: { "x-forwarded-proto": "https" } }));
    expect((res.headers.get("location") ?? "").startsWith("http://")).toBe(true);
  });

  it("a origem DECLARADA pelo operador é que manda — e o header do atacante não a move", async () => {
    // O caminho pelo qual o deploy atrás de proxy continua funcionando SEM perguntar ao cliente:
    // o operador diz o domínio público UMA vez. Com ele declarado, o header segue irrelevante.
    process.env[PUBLIC_ORIGIN_ENV] = "https://ah.legitimo.dev";
    const res = await middleware(
      request("/board/storymap", { headers: { "x-forwarded-host": "evil.example" } }),
    );
    const location = res.headers.get("location") ?? "";
    expect(new URL(location).origin).toBe("https://ah.legitimo.dev");
    expect(location).not.toContain("evil.example");
    expect(location).toContain(`next=${encodeURIComponent("/board/storymap")}`);
  });

  it("origem declarada com esquema impensável NÃO vira Location — cai no fallback seguro", async () => {
    // Um `javascript:`/`file:` colado no `.env` (ou herdado de um exemplo mal copiado) não pode
    // virar o destino de um `Location`, e a ausência de config nunca pode significar "confie no
    // header": os dois casos caem na origem do PRÓPRIO servidor.
    for (const lixo of ["javascript:alert(1)", "evil.example", "   ", "http://[::"]) {
      process.env[PUBLIC_ORIGIN_ENV] = lixo;
      const res = await middleware(request("/board", { headers: { "x-forwarded-host": "evil.example" } }));
      const location = res.headers.get("location") ?? "";
      expect(new URL(location).origin, `origem declarada inválida (${lixo}) escapou`).toBe(ORIGEM_DO_SERVICO);
    }
  });
});

// ── story-m9jflb: o portão deixa de recusar em silêncio ─────────────────────────────────────────
//
// A cegueira reproduzida ao vivo era total: recusa após recusa e `journalctl -u storymap` dizendo
// `-- No entries --`. O portão não pode participar da TRAVA do perímetro (`lib/auth/auth-audit.ts`
// importa `node:fs`, que não existe no Edge onde o Next 14 roda middleware), mas pode — e agora faz —
// produzir a fonte de log que não existia. Estes casos cravam as três propriedades que fazem esse
// rastro valer algo: ele existe, ele não vaza a credencial, e ele não é um alvo de escrita.
describe("o portão deixa rastro de quem tenta MINTAR sessão", () => {
  /** Um cookie forjado com um valor reconhecível — se algum pedaço dele aparecer no log, vazou. */
  const FORJADO = "QZ7mK4vB9pL2tR8wX3nC6yD1sF5gH0jA";

  it("cookie forjado gera UMA linha estruturada — e ela não carrega o valor do cookie", async () => {
    // ATAQUE que isto torna VISÍVEL: alguém tentando mintar sessão sem o token (forjar a assinatura,
    // ou replayar um cookie roubado depois da rotação). Antes, essa tentativa era indistinguível do
    // silêncio absoluto — e é justamente a que precisa de rastro.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await middleware(
        request("/board/storymap", { cookie: FORJADO, headers: { "x-forwarded-for": "198.51.100.10" } }),
      );
      // A NEGAÇÃO não mudou — o rastro é do lado de dentro, a resposta continua sendo a de sempre.
      expect(passedThrough(res)).toBe(false);
      expect(res.status).toBe(307);

      const linhas = warn.mock.calls.map((c) => String(c[0]));
      expect(linhas.length, "a recusa continuou invisível — sem linha não há detecção").toBe(1);
      const linha = linhas[0]!;
      expect(linha).toContain("[auth] sessão recusada");
      expect(linha).toContain("rota=/board/storymap");
      expect(linha, "sem o 'quem' o rastro não serve para forense").toContain("ip=198.51.100.10");
      expect(linha).toContain("tentativas=1");
      // Só o COMPRIMENTO do cookie sai. O valor, nunca: um log que ecoa a credencial é o defeito que
      // motivou esta onda (174 linhas do token em claro no log do Caddy), reproduzido dentro de casa.
      expect(linha).toContain(`<oculto: ${FORJADO.length} chars>`);
      for (let i = 0; i + 4 <= FORJADO.length; i += 1) {
        const janela = FORJADO.slice(i, i + 4);
        expect(linha.includes(janela), `o log vazou "${janela}" do cookie apresentado`).toBe(false);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("pedido SEM cookie não gera linha — o journal não é alvo de escrita de quem varre a porta", async () => {
    // Uma linha por pedido não autenticado entregaria ao scanner um jeito de encher o nosso disco, e
    // afogaria o sinal que importa. Sem cookie apresentado não houve tentativa de credencial.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const p of ["/", "/board/storymap", "/api/processes"]) {
        const res = await middleware(request(p, { headers: { "x-forwarded-for": "198.51.100.11" } }));
        expect(passedThrough(res), `${p} atravessou o portão`).toBe(false);
      }
      expect(warn.mock.calls.length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("uma rajada não gera uma linha por tentativa — e a linha carrega a MAGNITUDE", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 60; i += 1) {
        await middleware(
          request("/board/storymap", { cookie: FORJADO, headers: { "x-forwarded-for": "198.51.100.12" } }),
        );
      }
      const linhas = warn.mock.calls.map((c) => String(c[0]));
      expect(linhas.length, "uma linha por tentativa entrega o journal ao atacante").toBeLessThanOrEqual(3);
      expect(linhas.length, "o rastro tem de registrar que ele continuou batendo").toBeGreaterThan(0);
      expect(linhas.at(-1), "sem a contagem, o operador lê 'houve' em vez de '10'").toMatch(/tentativas=\d\d/);
    } finally {
      warn.mockRestore();
    }
  });

  it("o PATH não consegue forjar uma linha inteira no nosso journal", async () => {
    // ATAQUE de log injection: o pathname é texto do atacante. Um `%0A` (ou um CR/LF que qualquer
    // front-end normalize) escreveria linhas próprias no arquivo que serve para reconstruir o
    // incidente — inclusive linhas de "sucesso".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await middleware(
        request("/board/%0A%5Bauth%5D%20sess%C3%A3o%20aceita%20ip=1.2.3.4", {
          cookie: FORJADO,
          headers: { "x-forwarded-for": "198.51.100.13" },
        }),
      );
      const linha = String(warn.mock.calls[0]?.[0] ?? "");
      expect(linha).not.toMatch(/[\r\n]/);
      expect(linha.match(/\[auth\]/g)?.length, "o path escreveu um segundo cabeçalho de linha").toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("o IP não consegue forjar CAMPOS na linha do nosso journal", async () => {
    // ATAQUE de log injection pelo "quem": o último salto do `x-forwarded-for` é texto do CLIENTE
    // sempre que nenhum proxy reescreve o header (rate-limit.ts documenta que o Caddy reescreve —
    // proteção do deploy, não do produto). ESPAÇO é caractere legal em valor de header, então um ip
    // com ` rota=/login ip=127.0.0.1 tentativas=1` insere CAMPOS na mesma linha: o forense que ler
    // `ip=` pega o valor do atacante, e a linha deixa de ter uma leitura só.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await middleware(
        request("/board/storymap", {
          cookie: FORJADO,
          headers: {
            "x-forwarded-for": "9.9.9.9 rota=/login ip=127.0.0.1 cookie=<oculto: 0 chars> tentativas=1",
          },
        }),
      );
      const linha = String(warn.mock.calls[0]?.[0] ?? "");
      expect(linha.match(/rota=/g)?.length, "o ip forjou um segundo campo rota=").toBe(1);
      expect(linha.match(/ip=/g)?.length, "o ip forjou um segundo campo ip=").toBe(1);
      expect(linha.match(/tentativas=/g)?.length, "o ip forjou um segundo campo tentativas=").toBe(1);
      expect(linha.match(/cookie=/g)?.length, "o ip forjou um segundo campo cookie=").toBe(1);
      expect(linha).not.toMatch(/[\r\n]/);
    } finally {
      warn.mockRestore();
    }
  });

  it("o IP não consegue reescrever o TERMINAL de quem lê o journal", async () => {
    // ATAQUE menos óbvio e MEDIDO: o ESC (0x1b) é ACEITO em valor de header (CR/LF não são — ali o
    // transporte recusa antes de chegar aqui). Com ESC no ip, a sequência ANSI viaja intacta até o
    // `journalctl` do operador: `ESC[2K` apaga a linha, `ESC[1A` sobe o cursor — o atacante EDITA o
    // que o forense vê sem precisar de nenhum caractere de fim de linha.
    //
    // O payload entra como ESCAPE, nunca byte literal: caractere de controle cru no fonte quebra o
    // split do merge train (mesmo footgun do byte NUL).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await middleware(
        request("/board", { cookie: FORJADO, headers: { "x-forwarded-for": `9.9.9.9\u001b[2K\u001b[1A` } }),
      );
      const linha = String(warn.mock.calls[0]?.[0] ?? "");
      expect(linha, "sequência ANSI do atacante saiu no log").not.toContain("\u001b");
      // eslint-disable-next-line no-control-regex -- é exatamente a classe que o caso precisa provar ausente
      expect(linha, "controle C0/C1 no log é payload de terminal").not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    } finally {
      warn.mockRestore();
    }
  });

  it("um IP LEGÍTIMO continua legível — inclusive IPv6", async () => {
    // O outro lado: sanear não pode custar a identidade. Um saneador que comesse `:` transformaria
    // todo IPv6 em ruído e o rastro perderia justamente o "quem" que ele existe para registrar.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await middleware(
        request("/board", { cookie: FORJADO, headers: { "x-forwarded-for": "2001:db8::1428:57ab" } }),
      );
      expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("ip=2001:db8::1428:57ab");
    } finally {
      warn.mockRestore();
    }
  });

  it("sessão VÁLIDA não gera linha nenhuma — o rastro é de recusa, não de uso", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await middleware(
        request("/board/storymap", { cookie: await validCookie(), headers: { "x-forwarded-for": "198.51.100.14" } }),
      );
      expect(passedThrough(res)).toBe(true);
      expect(warn.mock.calls.length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
