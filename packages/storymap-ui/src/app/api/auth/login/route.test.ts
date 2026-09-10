// TRAVA DE REGRESSÃO do perímetro CSRF do login (story-l9y3wh).
//
// O vetor JÁ está fechado — este arquivo existe porque a proteção mora em propriedades que ninguém
// verificava: um refactor que troque `sameSite` para `'none'` (para embedar o overlay de feedback
// cross-origin, por exemplo) abre CSRF **e** clickjacking de uma vez, em silêncio, e a suíte
// continuaria verde. Cada teste abaixo nomeia o ATAQUE que a propriedade impede, não a linha que a
// implementa.
//
// O que ele NÃO faz: reduzir capacidade nenhuma. Nada aqui restringe o que o agente executa.

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_TRACKED_CLIENTS,
  PERIMETER_POLICY,
  PERIMETER_SURFACES,
  authFailuresPath,
  flushAuthFailures,
  perimeterScanCounters,
  readAuthFailures,
  recordAuthFailure,
  resetPerimeterState,
} from "@/lib/auth/auth-audit";
import { SESSION_SECRET_ENV, TOKEN_ENV, authSecretsFromEnv } from "@/lib/auth/env";
import { PUBLIC_ORIGIN_ENV, SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { POST } from "./route";

/** Token e segredo FORTES (>= 32 chars) — abaixo do piso a rota fail-closed e não testaria nada. */
const TOKEN = "T".repeat(43);
const SESSION_SECRET = "S".repeat(43);

/**
 * Cada teste usa um `x-forwarded-for` PRÓPRIO: a trava de força-bruta é um balde por origem vivo
 * enquanto o processo viver, então testes que dividissem a mesma identidade se contaminariam.
 */
function login(opts: {
  contentType?: string | null;
  body?: BodyInit;
  ip: string;
  proto?: string;
  headers?: Record<string, string>;
}): Promise<Response> {
  const headers = new Headers({ "x-forwarded-for": opts.ip, ...(opts.headers ?? {}) });
  // `undefined` = o caminho legítimo (json); `null` = pedido SEM content-type, que é um caso de teste.
  const contentType = opts.contentType === undefined ? "application/json" : opts.contentType;
  if (contentType) headers.set("content-type", contentType);
  else headers.delete("content-type");
  if (opts.proto) headers.set("x-forwarded-proto", opts.proto);
  return POST(
    new Request("http://localhost:3008/api/auth/login", {
      method: "POST",
      headers,
      body: opts.body ?? JSON.stringify({ token: TOKEN }),
      // Exigido pelo undici para corpo em STREAM (os ataques de corpo abaixo); inofensivo para string.
      duplex: "half",
    } as RequestInit),
  );
}

/**
 * Um corpo em STREAM que CONTA quantos chunks saíram.
 *
 * É o instrumento que separa "recusou" de "recusou sem bufferizar": um 413 emitido depois de puxar o
 * corpo inteiro não protege memória nenhuma, e a única forma de ver a diferença é medir o stream.
 *
 * ⚠️ MEDIDO: o `Request` do undici PRÉ-CARREGA um chunk ao ser construído com corpo em stream — antes
 * de qualquer código nosso rodar. O piso desta medida é 1, então as asserções contam CHUNKS e o que
 * elas provam é a distância até o total disponível: sem teto, a rota puxa todos.
 */
function corpoContado(
  chunkBytes: number,
  chunks: number,
): { body: ReadableStream<Uint8Array>; entregues: () => number } {
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (n >= chunks) {
        c.close();
        return;
      }
      n += 1;
      c.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return { body, entregues: () => n };
}

/** Os atributos do Set-Cookie como o NAVEGADOR os lê — chave minúscula, valor cru. */
function cookieAttrs(res: Response): Map<string, string> {
  const raw = res.headers.get("set-cookie") ?? "";
  const attrs = new Map<string, string>();
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    attrs.set(k.toLowerCase(), rest.join("="));
  }
  return attrs;
}

let prevToken: string | undefined;
let prevSecret: string | undefined;
let prevStateDir: string | undefined;
let stateDir = "";
let prevPublicUrl: string | undefined;

beforeEach(() => {
  prevToken = process.env[TOKEN_ENV];
  prevSecret = process.env[SESSION_SECRET_ENV];
  process.env[TOKEN_ENV] = TOKEN;
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  // O rastro do perímetro é um arquivo — cada teste ganha o seu, para nenhum ler a linha do vizinho
  // (e para nenhum escrever no estado do serviço vivo).
  prevStateDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "login-route-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
  // A ORIGEM DECLARADA é o primeiro degrau de `sessionCookieSecure` — declarada `https:`, o cookie sai
  // Secure SEMPRE, e é isso que se quer em produção. Aqui ela é ZERADA por padrão para que cada teste
  // estabeleça a própria precondição.
  //
  // Por que isto não estava aqui e custou um dia de main VERMELHA (2026-07-30 → 07-31): o `.env.local`
  // do pacote declara `AGILEHARNESS_PUBLIC_URL=https://…`, o Next o carrega no `process.env` do SERVIÇO,
  // e o gate roda como FILHO do serviço — herdando a variável. Rodando de um shell limpo o teste passava;
  // rodando pelo gate ele reprovava, sempre, e ninguém conseguia reproduzir. Um teste que lê env AMBIENTE
  // não afirma o que ele diz afirmar: ele afirma "aqui, hoje".
  prevPublicUrl = process.env[PUBLIC_ORIGIN_ENV];
  delete process.env[PUBLIC_ORIGIN_ENV];
  resetPerimeterState();
});

afterEach(async () => {
  await flushAuthFailures();
  resetPerimeterState();
  if (prevToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = prevToken;
  if (prevSecret === undefined) delete process.env[SESSION_SECRET_ENV];
  else process.env[SESSION_SECRET_ENV] = prevSecret;
  if (prevStateDir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevStateDir;
  if (prevPublicUrl === undefined) delete process.env[PUBLIC_ORIGIN_ENV];
  else process.env[PUBLIC_ORIGIN_ENV] = prevPublicUrl;
  // DEPOIS do flush: o rastro do perímetro ainda escreve neste diretório. Apagá-lo antes trocaria
  // um diretório órfão por um erro de escrita intermitente.
  rmSync(stateDir, { recursive: true, force: true });
});

describe("POST /api/auth/login — perímetro", () => {
  it("CSRF de login: um <form> hospedado em outro site não consegue postar aqui", async () => {
    // ATAQUE: página maliciosa com `<form action="https://board/api/auth/login" method="POST">`.
    // Um form cross-site sabe emitir EXATAMENTE três content-types, todos sem preflight — e
    // nenhum deles é `application/json`. Exigir o content-type real é o que fecha esse caminho.
    for (const [i, ct] of ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].entries()) {
      const res = await login({ contentType: ct, ip: `203.0.113.${i + 1}` });
      expect(res.status, `content-type ${ct} deveria ser recusado`).toBe(415);
      expect(res.headers.get("set-cookie"), "nenhuma sessão pode nascer de um POST de form").toBeNull();
    }
  });

  it("CSRF de login: sem content-type nenhum também não passa", async () => {
    // `fetch` sem body/headers e alguns clientes exóticos não mandam content-type. Fail-closed:
    // ausência não pode valer como "provavelmente json".
    const res = await login({ contentType: null, ip: "203.0.113.20" });
    expect(res.status).toBe(415);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("o cookie de sessão nasce SameSite=Lax — não viaja em POST cross-site", async () => {
    // ATAQUE que o Lax impede: qualquer POST/iframe/fetch disparado por OUTRO site não leva o
    // cookie, então uma ação mutante do board não pode ser executada em nome do operador. Trocar
    // para `none` (embed cross-origin) reabre CSRF e clickjacking de uma vez.
    const res = await login({ ip: "203.0.113.30" });
    expect(res.status).toBe(200);

    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toContain(`${SESSION_COOKIE}=`);
    expect(raw.toLowerCase()).toMatch(/;\s*samesite=lax\b/);
    expect(raw.toLowerCase()).not.toContain("samesite=none");

    const attrs = cookieAttrs(res);
    // HttpOnly: sem ele um XSS no board lê a sessão do operador com uma linha de JS.
    expect(attrs.has("httponly")).toBe(true);
    // Path=/: o portão cobre TODA superfície do serviço, então o cookie tem de cobrir também.
    expect(attrs.get("path")).toBe("/");
  });

  it("atrás de HTTPS o cookie sai Secure — não vaza em texto claro", async () => {
    // ATAQUE: downgrade para http:// (link, redirect, rede hostil) fazendo o navegador mandar a
    // sessão em claro. Sob `x-forwarded-proto: https` o Secure é obrigatório; em http:// local ele
    // NÃO pode existir, senão o navegador descarta o cookie e o self-host entra em laço de login.
    //
    // PRECONDIÇÃO (o beforeEach zera): sem origem declarada. Sem ela, este par de asserções é sobre o
    // PEDIDO — e é só aí que "http ⇒ sem Secure" é a resposta certa.
    const secure = await login({ ip: "203.0.113.31", proto: "https" });
    expect(cookieAttrs(secure).has("secure")).toBe(true);

    const plain = await login({ ip: "203.0.113.32" });
    expect(cookieAttrs(plain).has("secure")).toBe(false);
  });

  it("origem declarada https VENCE o pedido: nem um http:// local emite sessão em claro", async () => {
    // O degrau que faltava — e que derrubou a main por um dia, porque o teste acima o herdava do
    // ambiente em vez de o afirmar.
    //
    // ATAQUE que ele fecha: o operador publica o board atrás de TLS, mas um salto interno chega como
    // http (proxy que não reescreve, health-check, loopback). Decidir pelo PEDIDO ali emitiria a sessão
    // sem Secure num deploy HTTPS. A CONFIG do operador é a verdade sobre onde o board vive, e ela vence.
    process.env[PUBLIC_ORIGIN_ENV] = "https://board.exemplo.dev";
    const plainSobTls = await login({ ip: "203.0.113.33" });
    expect(cookieAttrs(plainSobTls).has("secure")).toBe(true);

    // E a recíproca: declarada http (self-host em rede local), o Secure NÃO pode aparecer — senão o
    // navegador descarta o cookie e o operador entra em laço de login sem nenhuma mensagem.
    process.env[PUBLIC_ORIGIN_ENV] = "http://board.local:3008";
    const declaradaHttp = await login({ ip: "203.0.113.34", proto: "https" });
    expect(cookieAttrs(declaradaHttp).has("secure")).toBe(false);
  });

  it("token errado NÃO emite cookie — 401 nunca mina sessão", async () => {
    const res = await login({ body: JSON.stringify({ token: "x".repeat(43) }), ip: "203.0.113.40" });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("força-bruta do token: a trava NÃO isenta loopback (a lição do ClawJacked)", async () => {
    // ATAQUE do CVE do ClawJacked: o rate-limiter do OpenClaw isentava 127.0.0.1, então qualquer
    // página aberta no navegador do operador — que sai de loopback quando há proxy na frente —
    // martelava o endpoint à vontade. Aqui loopback conta como qualquer IP da internet.
    //
    // O teto é o do PERÍMETRO (o mesmo 8/15min de antes, agora num balde só para as 6 superfícies).
    const wrong = JSON.stringify({ token: "y".repeat(43) });
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i += 1) {
      const res = await login({ body: wrong, ip: "127.0.0.1" });
      expect(res.status, `tentativa ${i + 1} deveria ser 401, não 429 antes da hora`).toBe(401);
    }

    // A tentativa que ESTOURA o teto já responde 429 com `Retry-After`, em vez de o cliente descobrir
    // no request seguinte — a mesma régua das outras superfícies `declarada` do perímetro (as 4 rotas do
    // runner e o gateway do terminal). O corpo continua sendo o JSON que a tela do operador lê: sem
    // `locked`/`retryAfterMs` ela não sabe desenhar o contador, e "endurecer" o login teria custado UX.
    const locked = await login({ body: wrong, ip: "127.0.0.1" });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    const corpo = (await locked.json()) as { locked?: boolean; retryAfterMs?: number };
    expect(corpo.locked).toBe(true);
    expect(corpo.retryAfterMs).toBeGreaterThan(0);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("ATAQUE (DoS contra o dono): trancar a origem NÃO tranca quem tem o token CERTO", async () => {
    // ESTE é o desfecho que a onda declarou PROIBIDO, e a asserção antiga o fixava como esperado.
    //
    // O ATAQUE: a chave da trava é a origem, e há três topologias REAIS em que o atacante e o dono
    // dividem a MESMA — self-host sem proxy (todo mundo cai em `sem-proxy`), NAT compartilhado
    // (escritório, celular), CDN na frente do Caddy (o último salto passa a ser o proxy). Com a trava
    // consultada ANTES da comparação, bastava um anônimo martelar 8 vezes para o dono levar 429 no
    // `/login` com o token certo na mão: qualquer pessoa na internet desligava o painel por até 60
    // minutos, de graça e sem nunca adivinhar nada. Remoção de capacidade contra o próprio operador.
    //
    // O que isto NÃO é: bypass da trava. Um chute CERTO durante o bloqueio entra por desenho — a
    // barreira contra adivinhação é o segredo de 32 bytes, não o contador. A trava encarece, nega
    // serviço a quem martela e produz o rastro; ela nunca decide sozinha quem é o dono.
    const ip = "203.0.113.99";
    const wrong = JSON.stringify({ token: "y".repeat(43) });
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) await login({ body: wrong, ip });

    const dono = await login({ ip });
    expect(dono.status, "a trava recusou o token válido do dono — DoS contra o próprio operador").toBe(200);
    const cookie = cookieAttrs(dono).get(SESSION_COOKIE) ?? "";
    expect(cookie, "entrou sem sessão — o 200 seria decorativo").not.toBe("");
    expect(await verifySession({ token: cookie, ...authSecretsFromEnv() })).toBe(true);
  });

  it("origem trancada + token ERRADO segue recusado, contado e nomeado no rastro", async () => {
    // O outro lado: comparar primeiro não pode virar "a trava deixou de existir". Quem não apresenta a
    // credencial continua barrado, a insistência CONTA (o orçamento da janela não renasce a cada rajada)
    // e ela deixa linha — que é o que faz uma invasão em curso ser reconstruível depois do restart.
    const ip = "203.0.113.98";
    const wrong = JSON.stringify({ token: "y".repeat(43) });
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) await login({ body: wrong, ip });

    const insistiu = await login({ body: wrong, ip });
    expect(insistiu.status).toBe(429);
    expect(insistiu.headers.get("set-cookie")).toBeNull();

    await flushAuthFailures();
    const linhas = (await readAuthFailures()).filter((l) => l.client === ip);
    expect(linhas.some((l) => l.surface === PERIMETER_SURFACES.login && l.locked)).toBe(true);
    expect(linhas.some((l) => l.reason === "trancado"), "a insistência sob trava não foi registrada").toBe(true);
  });

  it("ROTACIONAR o token do operador revoga o cookie que ESTA rota emitiu", async () => {
    // O controle mais forte do desenho e o menos visível: a chave de assinatura é
    // `sessionSecret + "\n" + operatorToken`, então trocar o token — o que se faz JUSTAMENTE quando
    // ele vaza — derruba toda cookie em circulação, sem estado no servidor. ATAQUE que isso fecha:
    // token vazado ⇒ o atacante loga, guarda o cookie, e continua dentro por 30 dias mesmo depois de
    // o operador "revogar" o acesso trocando o token.
    //
    // `session.test.ts` já prova isso em signSession/verifySession. O que ESTE teste acrescenta é a
    // FIAÇÃO: que o cookie realmente emitido pela rota depende dos dois segredos. Assinar com um
    // token fixo (ou só com o session-secret) passaria intacto pelo teste unitário e mataria a
    // revogação em silêncio.
    const res = await login({ ip: "203.0.113.60" });
    const cookie = cookieAttrs(res).get(SESSION_COOKIE) ?? "";
    expect(cookie).not.toBe("");

    // Exatamente como o middleware valida: cookie + os dois segredos lidos da env.
    expect(await verifySession({ token: cookie, ...authSecretsFromEnv() })).toBe(true);

    process.env[TOKEN_ENV] = "R".repeat(43);
    expect(
      await verifySession({ token: cookie, ...authSecretsFromEnv() }),
      "cookie sobreviveu à rotação do token — a revogação do operador virou decorativa",
    ).toBe(false);

    process.env[TOKEN_ENV] = TOKEN;
    process.env[SESSION_SECRET_ENV] = "R".repeat(43);
    expect(await verifySession({ token: cookie, ...authSecretsFromEnv() })).toBe(false);
  });

  it("resposta com Set-Cookie é no-store — nenhum intermediário guarda a sessão do operador", async () => {
    // ATAQUE: um cache (CDN, proxy do escritório) guarda a resposta do login COM o Set-Cookie e a
    // entrega para o próximo que pedir — que entra como o operador.
    const res = await login({ ip: "203.0.113.50" });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

describe("story-mkk680 — teto de corpo no único POST público do serviço", () => {
  it("ATAQUE: corpo de 64 MiB declarado — recusa 413 SEM puxar um único byte", async () => {
    // ATAQUE: um não-autenticado empurra corpos arbitrariamente grandes para a única rota POST fora
    // do portão. O processo roda como root com `Restart=always`, então o desfecho é OOM → restart →
    // runs em voo, merge train e fila de publicação perdidos. Nem o `bodySizeLimit` do next.config
    // (Server Actions) nem o bodyParser do Pages Router cobrem um Route Handler: `req.json()`
    // bufferizava o que viesse.
    //
    // A prova de que a recusa é BARATA está no stream: o 413 sai julgando só os headers, então dos 64
    // chunks disponíveis a rota não pede NENHUM (o único que sai é o que o undici pré-carrega ao
    // construir o Request — ver `corpoContado`). Sem o teto, ela puxa os 64.
    const { body, entregues } = corpoContado(1024 * 1024, 64);
    const res = await login({
      ip: "203.0.113.70",
      body,
      headers: { "content-length": String(64 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(entregues(), "o corpo foi bufferizado antes da recusa — o teto não protege memória").toBeLessThanOrEqual(
      1,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("ATAQUE: corpo SEM content-length (chunked) não escolhe quanta memória alocamos", async () => {
    // Sem tamanho declarado não há header para julgar — e a decisão de framing é de quem está na
    // frente do serviço, não nossa. O teto então age DURANTE a leitura: passou do limite, o reader é
    // cancelado. O que a rota materializa fica em "teto + um chunk", não "40 MiB porque ele quis".
    const { body, entregues } = corpoContado(64 * 1024, 640); // 40 MiB em chunks de 64 KiB
    const res = await login({ ip: "203.0.113.71", body, headers: { "transfer-encoding": "chunked" } });
    expect(res.status).toBe(413);
    // 2 chunks: o pré-carregado pelo undici + a única leitura que estoura o teto e cancela o reader.
    // Sem o teto, os 640 chunks (40 MiB) viram heap deste processo.
    expect(entregues(), "a rota leu o corpo inteiro sem tamanho declarado").toBeLessThanOrEqual(2);
  });

  it("um content-length duplicado/mal-formado é recusado em vez de normalizado", async () => {
    // ATAQUE (desync/smuggling): dois `content-length` fazem o front-end e o app lerem tamanhos
    // DIFERENTES do mesmo corpo. `Headers.get` entrega `"10, 4000"`; qualquer normalização nossa
    // escolheria um dos dois e passaria a divergir de quem está na frente.
    for (const cl of ["10, 4000", "+4000", "0x10", "4 000"]) {
      const res = await login({ ip: "203.0.113.72", headers: { "content-length": cl } });
      expect(res.status, `content-length ${cl} deveria ser recusado`).toBe(413);
    }
  });

  it("o login legítimo continua entrando — o teto não custa capacidade", async () => {
    // A trava só vale se o dono continua entrando: mesmo corpo de sempre, com e sem content-length
    // declarado (o navegador manda; um Request sintético não).
    const corpo = JSON.stringify({ token: TOKEN });
    const comCl = await login({
      ip: "203.0.113.73",
      body: corpo,
      headers: { "content-length": String(Buffer.byteLength(corpo)) },
    });
    expect(comCl.status).toBe(200);
    expect(comCl.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);

    const semCl = await login({ ip: "203.0.113.74", body: corpo });
    expect(semCl.status).toBe(200);
  });
});

describe("story-m9jflb — a recusa do login deixa de ser invisível", () => {
  it("ATAQUE: chutar o token do operador — cada recusa deixa linha, e ela NÃO carrega o chute", async () => {
    // O estado reproduzido ao vivo antes disto: recusa após recusa, e `journalctl -u storymap` no
    // mesmo minuto dizia `-- No entries --`. Sem fonte de log, uma invasão EM CURSO é invisível e a
    // pergunta "alguém usou essa credencial na janela?" não tem resposta.
    //
    // E o rastro não pode repetir o defeito que ele investiga: o valor tentado NUNCA vai para o
    // disco — só o comprimento, que o atacante já conhece.
    const CHUTE = "XQ9vK2mZ7pR4tL8wB3nC6yD1sF5gH0jA2kE";
    const res = await login({ ip: "198.51.100.40", body: JSON.stringify({ token: CHUTE }) });
    expect(res.status).toBe(401);
    await flushAuthFailures();

    const bruto = await readFile(authFailuresPath(), "utf8");
    for (let i = 0; i + 4 <= CHUTE.length; i += 1) {
      const janela = CHUTE.slice(i, i + 4);
      expect(bruto.includes(janela), `o rastro do login vazou "${janela}" do token tentado`).toBe(false);
    }

    const linhas = await readAuthFailures();
    expect(linhas.length).toBe(1);
    expect(linhas[0]?.surface, "a linha tem de nomear a superfície pelo path canônico").toBe(
      PERIMETER_SURFACES.login,
    );
    expect(linhas[0]?.client, "sem o 'quem' não há forense").toBe("198.51.100.40");
    expect(linhas[0]?.reason).toBe("desconhecida");
    expect(linhas[0]?.via).toBe("body");
    expect(linhas[0]?.presented).toContain(`${CHUTE.length} chars`);
  });

  it("pedido SEM token é registrado como `ausente`, não como chute de credencial", async () => {
    // Distinguir os dois é o que faz o resumo por motivo servir para algo: um cliente quebrado
    // batendo sem corpo não pode parecer uma campanha de adivinhação.
    const res = await login({ ip: "198.51.100.41", body: JSON.stringify({ remember: true }) });
    expect(res.status).toBe(401);
    await flushAuthFailures();
    const linhas = await readAuthFailures();
    expect(linhas[0]?.reason).toBe("ausente");
  });

  it("ATAQUE: gastar as tentativas em OUTRA superfície e chegar ao login como cliente novo", async () => {
    // Este é o buraco que três réguas separadas deixavam abertas: com um balde por rota, 6 superfícies
    // × 8 tentativas = 48 chutes de graça, bastando alternar. A contagem é UMA por origem no serviço
    // inteiro — então quem esgotou o orçamento no `/api/runner/pulse` chega aqui já trancado.
    const ip = "198.51.100.42";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i += 1) {
      recordAuthFailure({
        headers: new Headers({ "x-forwarded-for": ip }),
        surface: PERIMETER_SURFACES.runnerPulse,
        via: "query",
        reason: "desconhecida",
      });
    }

    const res = await login({ ip, body: JSON.stringify({ token: "z".repeat(43) }) });
    expect(res.status, "o login deu orçamento novo a quem já tinha estourado o do perímetro").toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    // A tela do operador desenha o contador com estes campos — o corpo JSON é contrato de UI.
    const data = (await res.json()) as { locked?: boolean; retryAfterMs?: number };
    expect(data.locked).toBe(true);
    expect(data.retryAfterMs).toBeGreaterThan(0);
  });

  it("uma varredura com IP sempre novo não vira memória sem fim (o teto que o limiter público não tinha)", async () => {
    // story-mkk680, aceite 3: o limiter PÚBLICO do login mantinha um `Map` de tentativas SEM teto de
    // chaves, varrido a cada request, enquanto o limiter interno (`lib/feedback/rate-limit.ts`) já
    // tinha o seu. Um scanner com IP sempre novo escolhia quanta memória o processo guardava.
    //
    // O conserto não foi "portar maxKeys": foi o Map local DEIXAR DE EXISTIR. A contagem do login
    // agora é o balde do perímetro, que tem teto (`MAX_TRACKED_CLIENTS`) e limpa ao encostar nele. A
    // asserção é dupla de propósito — só o par prova o conserto: (1) as falhas do login realmente
    // entram no balde contado, e (2) o balde não passa do teto.
    const errado = JSON.stringify({ token: "q".repeat(43) });
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 5; i += 1) {
      // Origens todas distintas: nenhuma tranca, então o que cresce é só o número de chaves.
      await login({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, body: errado });
    }
    const { distinctClients } = perimeterScanCounters();
    expect(distinctClients, "as falhas do login não estão sendo contadas no balde do perímetro").toBeGreaterThan(0);
    expect(distinctClients, "o balde cresceu sem teto — é o buraco de memória do story-mkk680").toBeLessThanOrEqual(
      MAX_TRACKED_CLIENTS,
    );
  });

  it("um acerto perdoa a janela: o operador que errou duas vezes não fica de fora", async () => {
    // O outro lado da trava. Sem isto, "endurecer" o login viraria negação de serviço contra o dono —
    // o desfecho proibido deste trabalho.
    const ip = "198.51.100.43";
    for (let i = 0; i < 3; i += 1) {
      const errado = await login({ ip, body: JSON.stringify({ token: "w".repeat(43) }) });
      expect(errado.status).toBe(401);
    }
    const ok = await login({ ip });
    expect(ok.status).toBe(200);

    // ...e a conta zerou DE VERDADE: o orçamento inteiro voltou, nem um a menos. A asserção pina o
    // limite exato — as `maxFailures - 1` primeiras são recusa por CREDENCIAL (401) e só a que encosta no
    // teto tranca (429). Se o acerto não tivesse perdoado nada, a PRIMEIRA aqui já sairia 429.
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i += 1) {
      const errado = await login({ ip, body: JSON.stringify({ token: "w".repeat(43) }) });
      expect(errado.status, `tentativa ${i + 1} depois do acerto deveria ser 401`).toBe(401);
    }
    const teto = await login({ ip, body: JSON.stringify({ token: "w".repeat(43) }) });
    expect(teto.status, "o orçamento não voltou inteiro depois do acerto").toBe(429);
  });
});
