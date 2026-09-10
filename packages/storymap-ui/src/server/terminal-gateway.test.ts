import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PERIMETER_POLICY,
  PERIMETER_SURFACES,
  checkPerimeter,
  flushAuthFailures,
  readAuthFailures,
  recordAuthFailure,
  resetPerimeterState,
} from "@/lib/auth/auth-audit";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import {
  cookieValue,
  DEFAULT_TTYD_HOST,
  DEFAULT_TTYD_PORT,
  expectedHostOf,
  hasValidSession,
  isSameOriginRequest,
  isTerminalProxyPath,
  pathnameOf,
  proxyTerminalHttp,
  proxyTerminalUpgrade,
  ttydTargetFromEnv,
  upstreamUrlOf,
} from "@/server/terminal-gateway";

const SECRET = "s".repeat(43);
const TOKEN = "t".repeat(43);

describe("roteamento de /ttyd", () => {
  it("extrai o pathname ignorando a query", () => {
    expect(pathnameOf("/ttyd/ws?arg=claude")).toBe("/ttyd/ws");
    expect(pathnameOf("/ttyd")).toBe("/ttyd");
    expect(pathnameOf(undefined)).toBe("/");
  });

  it("casa por SEGMENTO — um vizinho de nome parecido NÃO vira proxy do ttyd", () => {
    expect(isTerminalProxyPath("/ttyd")).toBe(true);
    expect(isTerminalProxyPath("/ttyd/ws")).toBe(true);
    expect(isTerminalProxyPath("/ttyd/token")).toBe(true);
    // O bug clássico de `startsWith` cru: qualquer rota do app com este prefixo viraria um túnel
    // para um daemon que spawna shells.
    expect(isTerminalProxyPath("/ttyd-publico")).toBe(false);
    expect(isTerminalProxyPath("/terminal")).toBe(false);
    expect(isTerminalProxyPath("/")).toBe(false);
  });

  it("tira o prefixo e PRESERVA a query (é ela que escolhe a sessão tmux)", () => {
    // `--url-arg` + attach-session.sh: perder `?arg=` jogaria todo terminal na sessão default.
    expect(upstreamUrlOf("/ttyd/ws?arg=card-acme__story-x")).toBe("/ws?arg=card-acme__story-x");
    expect(upstreamUrlOf("/ttyd/token")).toBe("/token");
    expect(upstreamUrlOf("/ttyd")).toBe("/");
    expect(upstreamUrlOf("/ttyd/")).toBe("/");
  });
});

describe("alvo do ttyd", () => {
  it("default é o loopback do unit systemd", () => {
    expect(ttydTargetFromEnv({})).toEqual({ host: DEFAULT_TTYD_HOST, port: DEFAULT_TTYD_PORT });
  });

  it("respeita AGILEHARNESS_TTYD_URL", () => {
    expect(ttydTargetFromEnv({ AGILEHARNESS_TTYD_URL: "http://10.0.0.4:7000" })).toEqual({
      host: "10.0.0.4",
      port: 7000,
    });
  });

  it("URL inválida cai no default em vez de derrubar o boot", () => {
    expect(ttydTargetFromEnv({ AGILEHARNESS_TTYD_URL: "nao-e-url" })).toEqual({
      host: DEFAULT_TTYD_HOST,
      port: DEFAULT_TTYD_PORT,
    });
  });
});

describe("cookie", () => {
  it("acha o valor entre vizinhos", () => {
    expect(cookieValue("a=1; ah_session=abc.def; z=9", SESSION_COOKIE)).toBe("abc.def");
    expect(cookieValue("ah_session=solo", SESSION_COOKIE)).toBe("solo");
    expect(cookieValue("outro=1", SESSION_COOKIE)).toBeUndefined();
    expect(cookieValue(undefined, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("origem do handshake (defesa contra sequestro de WebSocket)", () => {
  it("x-forwarded-host tem precedência sobre Host", () => {
    expect(expectedHostOf({ host: "127.0.0.1:3008", "x-forwarded-host": "board.exemplo.com" })).toBe(
      "board.exemplo.com",
    );
    expect(expectedHostOf({ host: "127.0.0.1:3008" })).toBe("127.0.0.1:3008");
    expect(expectedHostOf({ "x-forwarded-host": "a.com, b.com" })).toBe("a.com");
  });

  it("aceita o handshake da PRÓPRIA origem, com e sem proxy", () => {
    expect(
      isSameOriginRequest({ origin: "https://board.exemplo.com", "x-forwarded-host": "board.exemplo.com" }),
    ).toBe(true);
    // Sem proxy (acesso direto no loopback): sobra o Host.
    expect(isSameOriginRequest({ origin: "http://127.0.0.1:3008", host: "127.0.0.1:3008" })).toBe(true);
  });

  it("ignora o ESQUEMA — o proxy termina TLS e nem todo proxy manda x-forwarded-proto", () => {
    expect(
      isSameOriginRequest({ origin: "https://board.exemplo.com", host: "board.exemplo.com" }),
    ).toBe(true);
  });

  it("RECUSA origem de terceiro — é a CVE ClawJacked (CORS não protege WebSocket)", () => {
    expect(
      isSameOriginRequest({ origin: "https://site-malicioso.com", "x-forwarded-host": "board.exemplo.com" }),
    ).toBe(false);
    // Sufixo não basta: `board.exemplo.com.evil.com` é outra origem.
    expect(
      isSameOriginRequest({ origin: "https://board.exemplo.com.evil.com", host: "board.exemplo.com" }),
    ).toBe(false);
  });

  it("fail-closed: sem Origin, sem Host ou com Origin malformado, nega", () => {
    expect(isSameOriginRequest({ host: "board.exemplo.com" })).toBe(false);
    expect(isSameOriginRequest({ origin: "https://board.exemplo.com" })).toBe(false);
    expect(isSameOriginRequest({ origin: "lixo", host: "board.exemplo.com" })).toBe(false);
  });
});

describe("sessão no upgrade — a MESMA régua do middleware", () => {
  let prevSecret: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevSecret = process.env[SESSION_SECRET_ENV];
    prevToken = process.env[TOKEN_ENV];
    process.env[SESSION_SECRET_ENV] = SECRET;
    process.env[TOKEN_ENV] = TOKEN;
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env[SESSION_SECRET_ENV];
    else process.env[SESSION_SECRET_ENV] = prevSecret;
    if (prevToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = prevToken;
  });

  it("aceita um cookie assinado por este serviço", async () => {
    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    expect(await hasValidSession({ cookie: `${SESSION_COOKIE}=${cookie}` })).toBe(true);
  });

  it("recusa sem cookie, com cookie adulterado e com sessão expirada", async () => {
    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    expect(await hasValidSession({})).toBe(false);
    expect(await hasValidSession({ cookie: `${SESSION_COOKIE}=${cookie}x` })).toBe(false);
    const expired = await signSession({
      sessionSecret: SECRET,
      operatorToken: TOKEN,
      ttlMs: 1,
      now: Date.now() - 60_000,
    });
    expect(await hasValidSession({ cookie: `${SESSION_COOKIE}=${expired}` })).toBe(false);
  });

  it("rotacionar o TOKEN do operador derruba a sessão do terminal também", async () => {
    // O token entra no material de chave (lib/auth/session.ts). Se o terminal não respeitasse
    // isso, "troquei o token porque vazou" deixaria o WebSocket do vazamento vivo.
    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    process.env[TOKEN_ENV] = "n".repeat(43);
    expect(await hasValidSession({ cookie: `${SESSION_COOKIE}=${cookie}` })).toBe(false);
  });

  it("serviço sem segredo NÃO autentica ninguém (fail-closed)", async () => {
    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    delete process.env[SESSION_SECRET_ENV];
    expect(await hasValidSession({ cookie: `${SESSION_COOKIE}=${cookie}` })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// O PERÍMETRO DA SUPERFÍCIE QUE ENTREGA SHELL (story-m9jflb, achado da lente adversarial)
//
// A onda que criou `lib/auth/auth-audit.ts` instrumentou SEIS superfícies self-auth e deixou de fora
// justamente esta: `/ttyd/*` e o `upgrade` autenticam FORA do Next (aqui, no `http.Server` próprio),
// não estavam em `PERIMETER_SURFACES`, não consultavam `checkPerimeter` e não gravavam uma linha no
// rastro durável. Ou seja: um atacante martelando cookie forjado contra a rota que dá um SHELL não
// era contado, não era trancado e não aparecia no forense.
//
// Cada `it` abaixo descreve UMA tentativa de abuso — ou UMA capacidade do dono que não pode ser
// removida em nome dela (o terminal é como ele opera a máquina pelo celular).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Um ttyd de mentira: aceita conexão e guarda o PRIMEIRO pacote (o handshake repassado). */
interface TtydFalso {
  target: { host: string; port: number };
  readonly conexoes: number;
  primeiroPacote: Promise<string>;
  fechar(): Promise<void>;
}

function abrirTtydFalso(): Promise<TtydFalso> {
  return new Promise((resolve) => {
    let entregarPacote: (s: string) => void = () => {};
    const primeiroPacote = new Promise<string>((r) => (entregarPacote = r));
    const estado = { conexoes: 0 };
    const srv = createServer((sock) => {
      estado.conexoes += 1;
      sock.once("data", (b: Buffer) => entregarPacote(b.toString("utf8")));
    });
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      resolve({
        target: { host: "127.0.0.1", port },
        get conexoes() {
          return estado.conexoes;
        },
        primeiroPacote,
        fechar: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

/**
 * Um par de sockets REAIS: `gateway` é o socket sequestrado que o gateway recebe, `resposta` é o que
 * o navegador do outro lado leu. Socket de verdade porque o caminho de recusa fala HTTP na mão
 * (`socket.write` + `destroy`) — um duplo falso testaria o duplo, não o protocolo.
 */
interface ParDeSockets {
  gateway: Socket;
  resposta: Promise<string>;
  fechar(): Promise<void>;
}

function abrirParDeSockets(): Promise<ParDeSockets> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      const navegador = netConnect(port, "127.0.0.1");
      srv.once("connection", (gateway: Socket) => {
        const resposta = new Promise<string>((r) => {
          navegador.once("data", (b: Buffer) => r(b.toString("utf8")));
          navegador.once("close", () => r(""));
        });
        resolve({
          gateway,
          resposta,
          fechar: async () => {
            navegador.destroy();
            gateway.destroy();
            await new Promise<void>((r) => srv.close(() => r()));
          },
        });
      });
    });
  });
}

function reqFalso(headers: Record<string, string>, url = "/ttyd/ws?arg=claude"): IncomingMessage {
  const rawHeaders: string[] = [];
  for (const [k, v] of Object.entries(headers)) rawHeaders.push(k, v);
  // `pipe` porque um `IncomingMessage` É um Readable e o caminho de SUCESSO do proxy HTTP encaminha o
  // corpo (`req.pipe(upstream)`). Sem ele só os caminhos de RECUSA seriam testáveis — e é justamente o
  // caminho de sucesso que prova que a trava não barrou o dono. GET sem corpo ⇒ só fecha o upstream.
  const pipe = <T extends { end?: () => void }>(dest: T): T => {
    dest.end?.();
    return dest;
  };
  return { headers, rawHeaders, url, method: "GET", pipe } as unknown as IncomingMessage;
}

interface RespostaGravada {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function resFalso(): { res: ServerResponse; gravado: RespostaGravada } {
  const gravado = { status: 0, headers: {} as Record<string, string>, body: "", enviado: false };
  const res = {
    get headersSent() {
      return gravado.enviado;
    },
    writeHead(status: number, headers: Record<string, string>) {
      gravado.status = status;
      gravado.headers = headers;
      gravado.enviado = true;
      return res;
    },
    end(body?: string) {
      if (body) gravado.body = body;
    },
    destroy() {},
  };
  return { res: res as unknown as ServerResponse, gravado };
}

describe("perímetro do terminal — a superfície que entrega SHELL", () => {
  const OUTRO_SEGREDO = "x".repeat(43);
  let prevSecret: string | undefined;
  let prevToken: string | undefined;
  let prevStateDir: string | undefined;
  /** O diretório que ESTE teste criou — guardado para que o afterEach o remova (senão /tmp incha). */
  let stateDir: string | undefined;
  let ttyd: TtydFalso;

  beforeEach(async () => {
    prevSecret = process.env[SESSION_SECRET_ENV];
    prevToken = process.env[TOKEN_ENV];
    prevStateDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    process.env[SESSION_SECRET_ENV] = SECRET;
    process.env[TOKEN_ENV] = TOKEN;
    stateDir = mkdtempSync(path.join(tmpdir(), "terminal-perimetro-"));
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
    resetPerimeterState();
    ttyd = await abrirTtydFalso();
  });

  afterEach(async () => {
    await flushAuthFailures();
    resetPerimeterState();
    await ttyd.fechar();
    if (prevSecret === undefined) delete process.env[SESSION_SECRET_ENV];
    else process.env[SESSION_SECRET_ENV] = prevSecret;
    if (prevToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = prevToken;
    if (prevStateDir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevStateDir;
    // DEPOIS do flush acima — apagar antes trocaria lixo em /tmp por erro de escrita intermitente.
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  });

  /** Headers de um handshake legítimo do navegador, com o cookie que se quiser testar. */
  function handshake(cookie: string | undefined, ip = "203.0.113.9"): Record<string, string> {
    return {
      host: "board.exemplo.com",
      origin: "https://board.exemplo.com",
      "x-forwarded-for": ip,
      ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` }),
    };
  }

  async function tentarUpgrade(headers: Record<string, string>): Promise<string> {
    const par = await abrirParDeSockets();
    try {
      await proxyTerminalUpgrade(reqFalso(headers), par.gateway, Buffer.alloc(0), ttyd.target);
      return await par.resposta;
    } finally {
      await par.fechar();
    }
  }

  it("ATAQUE: martelar cookie FORJADO contra o WebSocket tranca a origem (antes: 401 infinito)", async () => {
    // Um cookie assinado com OUTRO segredo é o que um forjador produz. Nenhum navegador de terceiro
    // consegue fazer isso (`Cookie` é forbidden header name), então quem chega aqui é deliberado.
    const forjado = await signSession({ sessionSecret: OUTRO_SEGREDO, operatorToken: OUTRO_SEGREDO });
    const headers = handshake(forjado);

    const respostas: string[] = [];
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) respostas.push(await tentarUpgrade(headers));

    // As primeiras seguem 401 mudo; a que ESTOURA o teto já sai 429 — o cliente aprende o
    // `Retry-After` na hora em vez de descobrir no request seguinte (mesma postura das 4 rotas do
    // runner, que também já admitem existir).
    expect(respostas[0]).toMatch(/^HTTP\/1\.1 401\b/);
    expect(respostas[PERIMETER_POLICY.maxFailures - 1]).toMatch(/^HTTP\/1\.1 429\b/);
    expect(respostas[PERIMETER_POLICY.maxFailures - 1]).toMatch(/retry-after: \d+/i);

    // E a insistência DEPOIS de trancado nem chega a comparar credencial.
    expect(await tentarUpgrade(headers)).toMatch(/^HTTP\/1\.1 429\b/);
    expect(checkPerimeter(new Headers({ "x-forwarded-for": "203.0.113.9" })).allowed).toBe(false);

    // Nenhuma tentativa alcançou o daemon que spawna shells.
    expect(ttyd.conexoes).toBe(0);
  });

  it("ATAQUE: a invasão em curso deixa RASTRO durável — e ele nunca carrega o cookie tentado", async () => {
    const forjado = await signSession({ sessionSecret: OUTRO_SEGREDO, operatorToken: OUTRO_SEGREDO });
    await tentarUpgrade(handshake(forjado, "198.51.100.7"));
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    const doTerminal = linhas.filter((l) => l.surface === "/ttyd/ws");
    expect(doTerminal.length).toBe(1);
    expect(doTerminal[0]!.client).toBe("198.51.100.7");
    expect(doTerminal[0]!.via).toBe("cookie");
    expect(doTerminal[0]!.reason).toBe("desconhecida");
    // O valor tentado só existe como COMPRIMENTO. Gravar o cookie seria repetir dentro de casa o
    // defeito do logger default do Caddy (174 gravações do token em texto claro, story-u4yf1i).
    expect(doTerminal[0]!.presented).toBe(`<oculto: ${forjado.length} chars>`);
    expect(JSON.stringify(linhas)).not.toContain(forjado.slice(0, 24));
  });

  it("ATAQUE: origem já trancada por martelar /api/usm NÃO pivota para o shell", async () => {
    // O balde é UM por origem para o perímetro INTEIRO justamente para o atacante não rotacionar de
    // superfície e multiplicar o orçamento. Enquanto o terminal ficou fora dele, a superfície mais
    // valiosa do sistema era o refúgio de quem já estava trancado nas outras seis.
    //
    // A credencial do ATACANTE é um cookie forjado — é o que ele tem. Trancado nas outras superfícies,
    // ele não ganha nem uma tentativa a mais aqui: cada insistência é recusada (429) e nenhuma alcança
    // o daemon que spawna shells.
    const headers = new Headers({ "x-forwarded-for": "192.0.2.55" });
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) {
      recordAuthFailure({ headers, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida" });
    }
    expect(checkPerimeter(headers).allowed).toBe(false);

    const forjado = await signSession({ sessionSecret: OUTRO_SEGREDO, operatorToken: OUTRO_SEGREDO });
    expect(await tentarUpgrade(handshake(forjado, "192.0.2.55"))).toMatch(/^HTTP\/1\.1 429\b/);
    expect(await tentarUpgrade(handshake(forjado, "192.0.2.55"))).toMatch(/^HTTP\/1\.1 429\b/);
    expect(ttyd.conexoes).toBe(0);

    // E a insistência contra o SHELL entra no rastro durável, ESTRANGULADA (uma linha por tentativa
    // entregaria o disco a quem controla o volume). Quem grava é `recordAuthFailure` ao ver o bloqueio
    // vigente — se um refactor mover a ordem das checagens, esta linha é a que desaparece primeiro.
    await flushAuthFailures();
    const rajada = (await readAuthFailures()).filter((l) => l.surface === "/ttyd/ws" && l.reason === "trancado");
    expect(rajada.length, "a rajada contra o shell de uma origem trancada não deixou rastro").toBeGreaterThan(0);
    expect(rajada.at(-1)!.client).toBe("192.0.2.55");
  });

  it("ATAQUE: usar a TRAVA como ARMA — um anônimo NÃO desliga o terminal do dono", async () => {
    // O desfecho PROIBIDO, declarado em letras no topo de `lib/auth/auth-audit.ts` (seção ORDEM): o
    // balde é UM por origem, e há três instalações em que o atacante e o dono dividem a MESMA chave —
    // self-host sem proxy (todo mundo cai em `sem-proxy`), NAT compartilhado (escritório, celular) e
    // CDN na frente do Caddy. Nessas, `/api/usm` é uma superfície de MÁQUINA: qualquer anônimo a
    // martela SEM credencial nenhuma e tranca a chave compartilhada por até 60 minutos.
    //
    // Se a trava for consultada ANTES de comparar o cookie, esse anônimo DESLIGA o terminal do dono —
    // que é como ele opera a máquina pelo celular. Hardening que tira capacidade do dono está errado:
    // a credencial é comparada PRIMEIRO e uma sessão VÁLIDA nunca é recusada pela trava.
    const anonimo = new Headers({ "x-forwarded-for": "198.51.100.222" });
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) {
      recordAuthFailure({ headers: anonimo, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida" });
    }
    expect(checkPerimeter(anonimo).allowed, "o cenário não montou: a origem tinha de estar trancada").toBe(false);

    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });

    // 1. O handshake que vira SHELL: chega ao ttyd, como chegaria sem trava nenhuma.
    const par = await abrirParDeSockets();
    try {
      await proxyTerminalUpgrade(
        reqFalso(handshake(cookie, "198.51.100.222")),
        par.gateway,
        Buffer.alloc(0),
        ttyd.target,
      );
      // Com teto: uma recusa não escreve nada no ttyd, e esperar para sempre transformaria o achado
      // num timeout ilegível em vez de uma asserção que nomeia o que quebrou.
      const chegou = await Promise.race([
        ttyd.primeiroPacote,
        new Promise<string>((r) => setTimeout(() => r("<nada chegou ao ttyd>"), 2_000)),
      ]);
      expect(chegou, "a trava recusou a sessão VÁLIDA do dono — um anônimo desligou o terminal dele").toMatch(
        /^GET \/ws\?arg=claude HTTP\/1\.1/,
      );
    } finally {
      await par.fechar();
    }

    // 2. E o `fetch` do token, que a página do terminal faz antes de abrir o socket. O alvo aqui é uma
    //    porta MORTA de propósito: assim o desfecho distingue as três coisas sem deixar socket pendurado
    //    — 429 = barrado na porta pela trava (o bug), 401 = credencial recusada, 502 = ATRAVESSOU o
    //    portão e só o ttyd não respondeu, que é o que o dono precisa que aconteça.
    const { res, gravado } = resFalso();
    await proxyTerminalHttp(
      reqFalso(
        { host: "board.exemplo.com", "x-forwarded-for": "198.51.100.222", cookie: `${SESSION_COOKIE}=${cookie}` },
        "/ttyd/token",
      ),
      res,
      { host: "127.0.0.1", port: 1 },
    );
    for (let i = 0; i < 200 && gravado.status === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(gravado.status, "o `/ttyd/token` do dono foi barrado por causa da rajada de um anônimo").toBe(502);

    // E o acerto do dono PERDOA a janela: ele não herda o backoff que o atacante acumulou.
    expect(checkPerimeter(anonimo).remaining).toBe(PERIMETER_POLICY.maxFailures);
  });

  it("ATAQUE: `/ttyd/token` responde 429 com Retry-After em JSON quando a origem está trancada", async () => {
    // JSON e não texto: quem chama é o `fetch` dentro da página do terminal, e um corpo opaco cairia
    // no `catch` do cliente sem diagnóstico.
    const headers = new Headers({ "x-forwarded-for": "192.0.2.77" });
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) {
      recordAuthFailure({ headers, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida" });
    }

    const { res, gravado } = resFalso();
    await proxyTerminalHttp(
      reqFalso({ host: "board.exemplo.com", "x-forwarded-for": "192.0.2.77" }, "/ttyd/token"),
      res,
      ttyd.target,
    );
    expect(gravado.status).toBe(429);
    expect(Number(gravado.headers["retry-after"])).toBeGreaterThan(0);
    expect(gravado.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(gravado.body).ok).toBe(false);
    expect(ttyd.conexoes).toBe(0);
  });

  it("REGRESSÃO: sessão VÁLIDA continua abrindo o WebSocket — e o cookie não vaza para o ttyd", async () => {
    // O terminal é como o dono opera a máquina pelo celular. Se este teste ficar vermelho, o
    // hardening virou perda de capacidade — o desfecho proibido deste trabalho.
    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    const par = await abrirParDeSockets();
    try {
      await proxyTerminalUpgrade(reqFalso(handshake(cookie)), par.gateway, Buffer.alloc(0), ttyd.target);
      const repassado = await ttyd.primeiroPacote;
      expect(repassado).toMatch(/^GET \/ws\?arg=claude HTTP\/1\.1/);
      expect(ttyd.conexoes).toBe(1);
      expect(repassado.toLowerCase()).not.toContain("cookie:");
      // E o acerto PERDOA a janela da origem (o operador que colou cookie velho antes não carrega
      // backoff depois de entrar).
      expect(checkPerimeter(new Headers({ "x-forwarded-for": "203.0.113.9" })).remaining).toBe(
        PERIMETER_POLICY.maxFailures,
      );
    } finally {
      await par.fechar();
    }
  });

  it("REGRESSÃO: o laço de reconexão do PRÓPRIO operador (sessão expirada) não tranca o dono", async () => {
    // `public/terminal/index.html` reconecta sozinho (scheduleReconnect, backoff ≤ 8s, até 4 painéis).
    // O balde do perímetro é COMPARTILHADO com `/api/auth/login`: se a sessão vencida do dono contasse
    // como tentativa, a aba aberta no celular dele trancaria a PRÓPRIA tela de login por até 1h.
    const vencido = await signSession({
      sessionSecret: SECRET,
      operatorToken: TOKEN,
      ttlMs: 1,
      now: Date.now() - 60_000,
    });
    const headers = handshake(vencido, "203.0.113.41");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures * 2; i += 1) {
      expect(await tentarUpgrade(headers)).toMatch(/^HTTP\/1\.1 401\b/);
    }
    const trava = checkPerimeter(new Headers({ "x-forwarded-for": "203.0.113.41" }));
    expect(trava.allowed).toBe(true);
    expect(trava.remaining).toBe(PERIMETER_POLICY.maxFailures);
    expect(ttyd.conexoes).toBe(0);
  });

  it("REGRESSÃO: pedido SEM cookie não é lever para trancar a origem do dono", async () => {
    // Uma página de terceiro consegue `fetch('/ttyd/token', {credentials:'omit'})` do navegador do
    // operador. Contar isso daria a ela um jeito de trancar a origem dele SEM nunca chutar um
    // segredo — o mesmo raciocínio que o teto de corpo do login já registrou.
    for (let i = 0; i < PERIMETER_POLICY.maxFailures * 2; i += 1) {
      expect(await tentarUpgrade(handshake(undefined, "203.0.113.88"))).toMatch(/^HTTP\/1\.1 401\b/);
    }
    expect(checkPerimeter(new Headers({ "x-forwarded-for": "203.0.113.88" })).allowed).toBe(true);
  });

  it("REGRESSÃO: sequestro de origem (ClawJacked) segue recusado — e não gasta orçamento do dono", async () => {
    // A sessão é a do operador e é VÁLIDA: quem está errado é a página que abriu o socket. Contar
    // isso na trava entregaria a um site qualquer o poder de trancar o dono usando o navegador dele.
    const cookie = await signSession({ sessionSecret: SECRET, operatorToken: TOKEN });
    const resposta = await tentarUpgrade({
      host: "board.exemplo.com",
      origin: "https://site-malicioso.com",
      "x-forwarded-for": "203.0.113.150",
      cookie: `${SESSION_COOKIE}=${cookie}`,
    });
    expect(resposta).toMatch(/^HTTP\/1\.1 403\b/);
    expect(ttyd.conexoes).toBe(0);
    expect(checkPerimeter(new Headers({ "x-forwarded-for": "203.0.113.150" })).remaining).toBe(
      PERIMETER_POLICY.maxFailures,
    );
  });
});
