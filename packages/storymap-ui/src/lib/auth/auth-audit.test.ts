// OS ATAQUES QUE `auth-audit.ts` PRECISA IMPEDIR (story-m9jflb + story-et6a4j).
//
// O estado reproduzido ao vivo antes deste módulo: 6 GETs consecutivos a `/api/runner/pulse` com
// `secret` errado devolveram `401,401,401,401,401,401` — sem 429, sem lockout — e o
// `journalctl -u storymap` do mesmo minuto disse `-- No entries --`. Seis superfícies com o mesmo
// defeito (a rota MCP e as 4 do runner respondem 404/401 "with nothing logged", e o próprio
// comentário do `rate-limit.ts` prometia uma negação "visível" que não emitia linha nenhuma).
//
// Cada `it` abaixo descreve UMA tentativa de abuso, não uma função. O que está sob teste é a
// postura: o atacante encarece, o operador enxerga, e nada disso dá ao atacante um interruptor
// para desligar o agente.

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEDGER_MAX_LINES_PER_WINDOW,
  LEDGER_WINDOW_MS,
  MAX_TRACKED_CLIENTS,
  PERIMETER_POLICY,
  PERIMETER_SURFACES,
  AUTH_LEDGER_MAX_BYTES,
  TERMINAL_PERIMETER_SURFACES,
  authFailuresPath,
  authFailuresRotatedPath,
  canonicalSurface,
  checkPerimeter,
  escalatedLockoutMs,
  flushAuthFailures,
  guardPerimeter,
  noteBlockedAttempt,
  perimeterLockedResponse,
  perimeterScanCounters,
  readAuthFailures,
  readAuthFailureSummary,
  recordAuthFailure,
  recordAuthSuccess,
  recordPrivilegedCall,
  redactCredentialFromSurface,
  resetPerimeterState,
  stanceOfSurface,
} from "./auth-audit";
import {
  resetAgentActionSink,
  setAgentActionSink,
  flushAgentActions,
} from "@/lib/storymap/runner/agent-actions";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { proxyTerminalHttp, proxyTerminalUpgrade } from "@/server/terminal-gateway";

/** Cabeçalhos como o Caddy desta instalação os entrega: ele SUBSTITUI o XFF pelo peer real. */
function fromIp(ip: string): Headers {
  return new Headers({ "x-forwarded-for": ip });
}

let prevStateDir: string | undefined;
let stateDir = "";

beforeEach(() => {
  prevStateDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "auth-audit-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
  resetPerimeterState();
});

afterEach(async () => {
  await flushAuthFailures();
  resetPerimeterState();
  if (prevStateDir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevStateDir;
  // DEPOIS do flush: o rastro do perímetro ainda escreve neste diretório. Apagá-lo antes trocaria
  // um diretório órfão por um erro de escrita intermitente.
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ATAQUE: martelar as superfícies self-auth do perímetro", () => {
  it("a origem TRANCA ao passar do teto de falhas — e loopback não é isento (lição ClawJacked)", () => {
    // O rate-limiter do OpenClaw isentava loopback e qualquer página aberta no navegador do
    // operador virava um cliente "local confiável" com martelo livre. Aqui 127.0.0.1 conta igual.
    const headers = fromIp("127.0.0.1");
    let gate = checkPerimeter(headers, 0);
    expect(gate.allowed).toBe(true);

    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      gate = recordAuthFailure({
        headers,
        surface: PERIMETER_SURFACES.runnerPulse,
        via: "query",
        reason: "desconhecida",
        now: i,
      });
    }
    expect(gate.allowed, "a trava não engatou — o atacante segue com orçamento infinito").toBe(false);
    expect(gate.retryAfterMs).toBeGreaterThan(0);
    // E a trava CONTINUA fechada numa consulta posterior (não é só o veredito da última falha).
    expect(checkPerimeter(headers, 10).allowed).toBe(false);
  });

  it("trocar de SUPERFÍCIE a cada tentativa não multiplica o orçamento", () => {
    // 6 superfícies × 8 tentativas seriam 48 chutes de graça se cada rota tivesse seu balde.
    const headers = fromIp("203.0.113.9");
    const surfaces = Object.values(PERIMETER_SURFACES);
    let gate = checkPerimeter(headers, 0);
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      gate = recordAuthFailure({
        headers,
        surface: surfaces[i % surfaces.length]!,
        via: "path",
        reason: "desconhecida",
        now: i,
      });
    }
    expect(gate.allowed, "um balde por rota deixaria o atacante rotacionar de superfície").toBe(false);
  });

  it("forjar x-real-ip a cada tentativa não troca a chave da trava", () => {
    // MEDIDO contra o Caddy desta instalação: `x-real-ip` forjado passa INTACTO. Se a chave o
    // considerasse, bastaria rotacioná-lo a cada chute para nunca trancar.
    let gate = checkPerimeter(new Headers({ "x-forwarded-for": "198.51.100.7" }), 0);
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      gate = recordAuthFailure({
        headers: new Headers({ "x-forwarded-for": "198.51.100.7", "x-real-ip": `10.0.0.${i}` }),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: i,
      });
    }
    expect(gate.allowed).toBe(false);
  });

  it("uma enxurrada de origens distintas NÃO tranca uma origem nova (sem interruptor global)", () => {
    // A tentação é um teto GLOBAL, que um atacante distribuído não evade. Ele também seria a
    // alavanca para DESLIGAR o conector do operador — remoção de capacidade, o desfecho proibido.
    for (let ip = 0; ip < 40; ip++) {
      for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
        recordAuthFailure({
          headers: fromIp(`192.0.2.${ip}`),
          surface: PERIMETER_SURFACES.mcp,
          via: "path",
          reason: "desconhecida",
          now: i,
        });
      }
    }
    expect(checkPerimeter(fromIp("198.51.100.200"), 5).allowed).toBe(true);
    // ...mas a varredura distribuída fica CONTADA, que é o que a torna detectável.
    expect(perimeterScanCounters().distinctClients).toBeGreaterThanOrEqual(40);
  });

  it("o segundo bloqueio consecutivo da mesma origem é mais longo (backoff progressivo)", () => {
    const headers = fromIp("203.0.113.55");
    const lockOnce = (base: number): number => {
      let g = { retryAfterMs: 0 };
      for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
        g = recordAuthFailure({
          headers,
          surface: PERIMETER_SURFACES.mcp,
          via: "path",
          reason: "desconhecida",
          now: base + i,
        });
      }
      return g.retryAfterMs;
    };
    const primeiro = lockOnce(0);
    // ...o bloqueio expira, o atacante volta e martela de novo:
    const segundo = lockOnce(primeiro + 1_000);
    expect(segundo).toBeGreaterThan(primeiro);
    expect(escalatedLockoutMs(1)).toBeLessThan(escalatedLockoutMs(2));
  });

  it("um acerto perdoa a janela daquela origem (o operador que errou não fica de fora)", () => {
    const headers = fromIp("203.0.113.77");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i++) {
      recordAuthFailure({ headers, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida", now: i });
    }
    recordAuthSuccess(headers);
    expect(checkPerimeter(headers, 100).remaining).toBe(PERIMETER_POLICY.maxFailures);
  });
});

describe("ATAQUE: transformar o rastro numa fonte de vazamento ou num enchimento de disco", () => {
  // Um valor FIXO de alta variedade: o teste varre TODAS as janelas de 4 chars dele contra a linha
  // gravada, então um valor aleatório poderia colidir por sorte com uma palavra do JSON e piscar.
  const TENTADO = "XQ9vK2mZ7pR4tL8wB3nC6yD1sF5gH0jA2kE";

  it("nenhuma linha do rastro carrega o valor tentado — nem um prefixo dele", async () => {
    recordAuthFailure({
      headers: fromIp("192.0.2.10"),
      surface: PERIMETER_SURFACES.mcp,
      via: "path",
      reason: "desconhecida",
      presented: TENTADO,
      now: 1,
    });
    await flushAuthFailures();
    const bruto = await readFile(authFailuresPath(), "utf8");
    for (let i = 0; i + 4 <= TENTADO.length; i++) {
      const janela = TENTADO.slice(i, i + 4);
      expect(bruto.includes(janela), `o rastro vazou "${janela}" do segredo tentado`).toBe(false);
    }
    // O que PODE sair é o comprimento (o atacante já sabe o que mandou, e isso não estreita o
    // segredo real) — é o que distingue "mandou vazio" de "mandou algo do nosso formato".
    expect(bruto).toContain(`${TENTADO.length} chars`);
  });

  it("a URL inteira passada como superfície tem a credencial REDIGIDA antes de tocar o disco", async () => {
    // A armadilha real: a URL É a credencial hoje. Um chamador que passe `req.url` gravaria o
    // token no NOSSO ledger forense — o mesmo defeito do log de erro do Caddy, dentro de casa.
    const url = `https://ah.example/api/usm/${TENTADO}/mcp?secret=${TENTADO}`;
    recordAuthFailure({
      headers: fromIp("192.0.2.11"),
      surface: url,
      via: "path",
      reason: "desconhecida",
      now: 1,
    });
    await flushAuthFailures();
    const bruto = await readFile(authFailuresPath(), "utf8");
    for (let i = 0; i + 4 <= TENTADO.length; i++) {
      expect(bruto.includes(TENTADO.slice(i, i + 4))).toBe(false);
    }
    expect(redactCredentialFromSurface(url)).toBe("/api/usm/<redigido>/mcp");
  });

  it("um atacante trancado não gera uma linha por tentativa (rastro estrangulado, com contagem)", async () => {
    const headers = fromIp("192.0.2.12");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      recordAuthFailure({ headers, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida", now: i });
    }
    // 500 tentativas DEPOIS de trancado, todas dentro do mesmo meio segundo.
    for (let i = 0; i < 500; i++) {
      noteBlockedAttempt({ headers, surface: PERIMETER_SURFACES.mcp, via: "path", now: 1_000 + i });
    }
    await flushAuthFailures();
    const linhas = await readAuthFailures();
    const trancadas = linhas.filter((l) => l.reason === "trancado");
    expect(trancadas.length, "uma linha por tentativa entrega o disco ao atacante").toBeLessThanOrEqual(5);
    expect(trancadas.length, "o rastro tem de registrar que ele continuou batendo").toBeGreaterThan(0);
    expect(
      trancadas.at(-1)?.blocked,
      "a linha estrangulada precisa carregar a MAGNITUDE real da rajada",
    ).toBeGreaterThanOrEqual(100);
  });

  it("o rastro é DURÁVEL: sobrevive à perda do estado in-process, onde a trava mora", async () => {
    const headers = fromIp("192.0.2.13");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      recordAuthFailure({ headers, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida", now: i });
    }
    await flushAuthFailures();
    resetPerimeterState(); // = o restart do serviço
    expect(checkPerimeter(headers, 0).allowed, "a trava é in-process e recomeça — declarado, não escondido").toBe(true);
    const linhas = await readAuthFailures();
    expect(linhas.length, "o rastro em memória não serve para forense; este tem de sobreviver").toBe(
      PERIMETER_POLICY.maxFailures,
    );
  });

  it("o rastro rotaciona no teto de bytes em vez de crescer sem fim", async () => {
    writeFileSync(authFailuresPath(), "x".repeat(AUTH_LEDGER_MAX_BYTES + 1), "utf8");
    recordAuthFailure({
      headers: fromIp("192.0.2.14"),
      surface: PERIMETER_SURFACES.mcp,
      via: "path",
      reason: "desconhecida",
      now: 1,
    });
    await flushAuthFailures();
    expect(statSync(authFailuresRotatedPath()).size).toBeGreaterThan(AUTH_LEDGER_MAX_BYTES);
    expect(statSync(authFailuresPath()).size).toBeLessThan(2_000);
  });
});

describe("ATAQUE: trocar de CHAVE para recuperar o orçamento de escrita do rastro", () => {
  // O estrangulamento de rajada é por CHAVE DE TRAVA, e a chave é o último salto do `x-forwarded-for`.
  // Na topologia que a própria onda cita como motivação — self-host exposto DIRETO, sem proxy
  // reescrevendo o header — quem escolhe a chave é o CLIENTE. Então bastava um XFF novo por tentativa:
  // balde novo, estrangulamento zerado, uma linha por tentativa. O dano não é o disco (a rotação já
  // limita o arquivo a 2 gerações) — é a I/O amplificada e, sobretudo, a EVICÇÃO da prova: quem escreve
  // à vontade rotaciona o forense e empurra a invasão real para fora do arquivo. O teto tem de ser um que
  // o atacante NÃO escolhe.

  /** Um XFF diferente por tentativa: 1024 chaves distintas, todas escolhidas pelo cliente. */
  const chaveRotativa = (i: number): Headers => fromIp(`10.${(i >> 8) & 255}.${i & 255}.7`);

  it("mil tentativas com mil chaves NÃO rendem mil linhas no rastro", async () => {
    const tentativas = 1_000;
    for (let i = 0; i < tentativas; i++) {
      recordAuthFailure({
        headers: chaveRotativa(i),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: 1,
      });
    }
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    expect(
      linhas.length,
      "trocar de chave devolvia o orçamento de escrita: uma linha por tentativa, escolhida pelo atacante",
    ).toBeLessThan(tentativas);
    // O teto real é o teto da janela + as poucas linhas de magnitude (potências de 10).
    expect(linhas.length).toBeLessThanOrEqual(LEDGER_MAX_LINES_PER_WINDOW + 10);
  });

  it("o que foi suprimido aparece como MAGNITUDE — coalescer não pode virar esconder", async () => {
    for (let i = 0; i < 1_000; i++) {
      recordAuthFailure({
        headers: chaveRotativa(i),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: 1,
      });
    }
    await flushAuthFailures();

    const comMagnitude = (await readAuthFailures()).filter((l) => typeof l.suppressed === "number");
    expect(comMagnitude.length, "o rastro tem de dizer que passou do teto").toBeGreaterThan(0);
    expect(
      comMagnitude.at(-1)?.suppressed,
      "a última linha tem de carregar a ORDEM DE GRANDEZA do que ficou de fora",
    ).toBeGreaterThanOrEqual(100);
  });

  it("o teto é do RASTRO, nunca da DECISÃO: a trava e os contadores seguem contando tudo", async () => {
    // O desfecho PROIBIDO seria o teto de escrita virar teto de detecção — aí o atacante escolheria
    // ficar invisível enchendo o arquivo. A trava por origem e os contadores não passam pelo teto.
    const tentativas = 400;
    for (let i = 0; i < tentativas; i++) {
      recordAuthFailure({
        headers: chaveRotativa(i),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: 1,
      });
    }
    const alvo = fromIp("203.0.113.44");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      recordAuthFailure({ headers: alvo, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida", now: 1 });
    }
    await flushAuthFailures();

    expect(checkPerimeter(alvo, 2).allowed, "a origem tem de trancar mesmo com o rastro no teto").toBe(false);
    const contadores = perimeterScanCounters();
    expect(contadores.failures).toBe(tentativas + PERIMETER_POLICY.maxFailures);
    expect(contadores.ledgerSuppressed, "o operador precisa saber o tamanho do que o teto engoliu").toBeGreaterThan(0);
  });

  it("o teto é por JANELA — passada a janela, o rastro volta a publicar (não é um mudo permanente)", async () => {
    for (let i = 0; i < LEDGER_MAX_LINES_PER_WINDOW + 50; i++) {
      recordAuthFailure({
        headers: chaveRotativa(i),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: 1,
      });
    }
    await flushAuthFailures();
    const antes = (await readAuthFailures()).length;

    recordAuthFailure({
      headers: fromIp("203.0.113.45"),
      surface: PERIMETER_SURFACES.runnerPulse,
      via: "query",
      reason: "desconhecida",
      now: 1 + LEDGER_WINDOW_MS,
    });
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    expect(linhas.length, "uma rajada não pode calar o rastro para sempre").toBe(antes + 1);
    expect(linhas.at(-1)?.client).toBe("203.0.113.45");
  });
});

describe("a resposta de uma superfície trancada não pode contar nada nova ao atacante", () => {
  it("a superfície MUDA continua 404 quando trancada — a trava não confirma o endpoint", () => {
    const res = perimeterLockedResponse("muda", { allowed: false, retryAfterMs: 60_000, remaining: 0, strikes: 1 });
    expect(res.status).toBe(404);
    expect(res.headers.get("retry-after"), "um retry-after no 404 já confirmaria que há algo aqui").toBeNull();
  });

  it("a superfície DECLARADA (que já responde 401) passa a 429 com retry-after", () => {
    const res = perimeterLockedResponse("declarada", { allowed: false, retryAfterMs: 90_000, remaining: 0, strikes: 1 });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("90");
  });
});

describe("contadores que a UI/ops consegue ler", () => {
  it("resume por motivo, por superfície, quem mais falhou e quem está trancado agora", async () => {
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      recordAuthFailure({
        headers: fromIp("192.0.2.20"),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "handle-revogado",
        handleId: "0123456789ab",
        now: i,
      });
    }
    recordAuthFailure({
      headers: fromIp("192.0.2.21"),
      surface: PERIMETER_SURFACES.runnerEvents,
      via: "query",
      reason: "desconhecida",
      now: 1,
    });
    await flushAuthFailures();

    const s = await readAuthFailureSummary({ now: 10 });
    expect(s.total).toBe(PERIMETER_POLICY.maxFailures + 1);
    expect(s.byReason["handle-revogado"]).toBe(PERIMETER_POLICY.maxFailures);
    expect(s.byReason["desconhecida"]).toBe(1);
    expect(s.bySurface[PERIMETER_SURFACES.runnerEvents]).toBe(1);
    expect(s.topClients[0]?.client).toBe("192.0.2.20");
    expect(s.lockedNow.map((l) => l.client)).toEqual(["192.0.2.20"]);
  });
});

describe("story-et6a4j — o token `full` deixa de escapar do ledger de auditoria", () => {
  const linhas: string[] = [];
  beforeEach(() => {
    linhas.length = 0;
    setAgentActionSink({
      append: async (line: string) => {
        linhas.push(line);
      },
    });
  });
  afterEach(() => resetAgentActionSink());

  it("uma ação MUTANTE conduzida pelo token full aparece no ledger", async () => {
    // O guard curto-circuita `full` antes de qualquer escrita — então um incidente conduzido pela
    // credencial MAIS poderosa era o único 100% irreconstruível.
    recordPrivilegedCall({ actor: "handle:0123456789ab", tool: "deploy", cls: "deploy", cardId: "story-x" });
    await flushAgentActions();
    expect(linhas.length).toBe(1);
    const rec = JSON.parse(linhas[0]!) as Record<string, unknown>;
    expect(rec.tool).toBe("deploy");
    expect(rec.actor).toBe("handle:0123456789ab");
    expect(rec.cardId).toBe("story-x");
    expect(rec.outcome).toBe("executed");
  });

  it("uma LEITURA não engorda o ledger (mesma régua do ator escopado)", async () => {
    recordPrivilegedCall({ actor: "env:AGILEHARNESS_MCP_TOKEN", tool: "get_card", cls: "read" });
    await flushAgentActions();
    expect(linhas.length, "o ledger registra MUTAÇÃO; uma linha por leitura o afogaria").toBe(0);
  });
});

describe("ATAQUE: usar a TRAVA como arma para desligar o painel do dono", () => {
  // O desfecho PROIBIDO desta onda. O balde é UM por origem, e há três instalações em que o
  // atacante e o dono dividem a MESMA chave: self-host sem proxy (todo mundo cai em `sem-proxy`),
  // NAT compartilhado (escritório/celular), e CDN na frente do Caddy (o último salto passa a ser o
  // proxy). Nessas, martelar uma superfície de MÁQUINA — que não exige credencial nenhuma para ser
  // TENTADA — trancava o dono fora do `/login`, a única porta da UI, por até 60 minutos. De graça.

  const invalida = () => ({ valid: false, reason: "desconhecida" }) as const;

  it("o dono entra com a credencial CERTA mesmo com a origem trancada por um anônimo", async () => {
    const ip = "203.0.113.99";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      const r = await guardPerimeter({
        headers: fromIp(ip),
        surface: PERIMETER_SURFACES.runnerPulse,
        via: "query",
        stance: "declarada",
        validate: invalida,
        now: i,
      });
      expect(r.ok).toBe(false);
    }
    expect(checkPerimeter(fromIp(ip), 10).allowed, "o cenário não montou: a origem tinha de estar trancada").toBe(
      false,
    );

    const dono = await guardPerimeter({
      headers: fromIp(ip),
      surface: PERIMETER_SURFACES.login,
      via: "body",
      stance: "declarada",
      validate: () => ({ valid: true, value: "sessão-do-dono" }) as const,
      now: 20,
    });
    expect(
      dono.ok,
      "a trava recusou uma credencial VÁLIDA — qualquer anônimo desliga o painel do dono por 60 min",
    ).toBe(true);
    // ...e a origem foi PERDOADA: o dono não herda o backoff que o atacante acumulou.
    expect(checkPerimeter(fromIp(ip), 21).remaining).toBe(PERIMETER_POLICY.maxFailures);
    expect(checkPerimeter(fromIp(ip), 21).strikes).toBe(0);
  });

  it("o chute do atacante segue encarecido: recusado E contado, e sem oráculo na superfície muda", async () => {
    // O outro lado da inversão: deixar a credencial válida passar não pode dar de graça ao atacante
    // um 200, nem uma resposta que diferencie "trancado" de "chute errado" na superfície muda.
    const ip = "203.0.113.98";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      await guardPerimeter({
        headers: fromIp(ip),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        stance: "muda",
        validate: invalida,
        now: i,
      });
    }
    const depois = await guardPerimeter({
      headers: fromIp(ip),
      surface: PERIMETER_SURFACES.mcp,
      via: "path",
      stance: "muda",
      validate: invalida,
      now: 30,
    });
    expect(depois.ok).toBe(false);
    if (depois.ok) return;
    expect(depois.gate.allowed, "a tentativa inválida de uma origem trancada tem de ser RECUSADA").toBe(false);
    expect(depois.response.status, "404 nu — igual a uma rota inexistente e igual a um chute errado").toBe(404);
    expect(depois.response.headers.get("retry-after"), "o header confirmaria que existe algo aqui").toBeNull();
  });

  it("a recusa da superfície pode manter o corpo próprio — a tela do dono não perde o contador", async () => {
    // CUSTO DE AUTONOMIA: a tela de login desenha o contador com `remaining`/`locked`/`retryAfterMs`.
    // Um portão que só soubesse devolver texto puro obrigaria o `/api/auth/login` a escolher entre a
    // ordem correta e a UI do dono — e trocar a UI dele por hardening é remoção de capacidade.
    const r = await guardPerimeter({
      headers: fromIp("203.0.113.97"),
      surface: PERIMETER_SURFACES.login,
      via: "body",
      stance: "declarada",
      validate: () => ({ valid: false, reason: "ausente" }) as const,
      deny: (gate) =>
        new Response(JSON.stringify({ ok: false, error: "token inválido", remaining: gate.remaining }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      now: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toMatchObject({ remaining: PERIMETER_POLICY.maxFailures - 1 });
  });
});

describe("ATAQUE: contornar a trava por CONCORRÊNCIA (TOCTOU)", () => {
  it("64 tentativas seguidas não rendem 56 chutes aceitos sob um teto de 8", () => {
    // A checagem que só LÊ não decide nada: quem contava era o registro DEPOIS do `await` da
    // comparação, e ele nem olhava o bloqueio vigente — a lista de falhas é zerada no lockout, então
    // a 9ª falha voltava a dizer "pode tentar" e o orçamento renascia a cada 8. Efeito: o teto real
    // por rajada era o número de pedidos EM VOO, não o configurado.
    const headers = fromIp("198.51.100.64");
    let aceitas = 0;
    for (let i = 0; i < 64; i++) {
      const gate = recordAuthFailure({
        headers,
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: 0,
      });
      if (gate.allowed) aceitas += 1;
    }
    expect(aceitas, "o orçamento da janela virou 'quantos requests o atacante tem em voo'").toBeLessThan(
      PERIMETER_POLICY.maxFailures,
    );
  });

  it("64 pedidos EM VOO ao mesmo tempo respeitam o teto (decisão e incremento no mesmo passo)", async () => {
    // A forma real do ataque: 64 requests concorrentes, cada um parando no `await` da comparação (a
    // resolução do handle lê o registro do disco). Todos passariam por uma checagem que só lê.
    const emVoo = Array.from({ length: 64 }, (_, i) =>
      guardPerimeter({
        headers: fromIp("198.51.100.65"),
        surface: PERIMETER_SURFACES.runnerEvents,
        via: "header",
        stance: "declarada",
        validate: async () => {
          await Promise.resolve();
          return { valid: false, reason: "desconhecida" } as const;
        },
        now: i,
      }),
    );
    const rs = await Promise.all(emVoo);
    const aceitas = rs.filter((r) => !r.ok && r.gate.allowed).length;
    expect(aceitas, "a rajada concorrente passou do teto configurado").toBeLessThan(PERIMETER_POLICY.maxFailures);
    const recusadas = rs.filter((r) => !r.ok && !r.gate.allowed);
    expect(recusadas.length, "passou do teto e ninguém foi recusado").toBeGreaterThan(0);
    const ultima = recusadas.at(-1);
    expect(ultima?.ok).toBe(false);
    if (!ultima || ultima.ok) return;
    expect(ultima.response.status, "a superfície declarada recusa com 429 + Retry-After").toBe(429);
    expect(ultima.response.headers.get("retry-after")).toBeTruthy();
  });
});

describe("ATAQUE: encher o mapa de origens para SOLTAR o próprio bloqueio", () => {
  it("um bloqueio ATIVO sobrevive ao teto de origens rastreadas", () => {
    // Quem controla o XFF (self-host sem proxy na frente) escolhia quando destravar: o teto de
    // memória LIMPAVA o mapa inteiro, e limpar o mapa é soltar todo bloqueio vigente. O teto tem de
    // descartar por POLÍTICA — o ocioso primeiro —, nunca varrendo uma trava viva.
    const alvo = fromIp("203.0.113.7");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      recordAuthFailure({ headers: alvo, surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida", now: 1_000 + i });
    }
    expect(checkPerimeter(alvo, 1_010).allowed, "o cenário não montou").toBe(false);

    for (let i = 0; i < MAX_TRACKED_CLIENTS + 50; i++) {
      recordAuthFailure({
        headers: fromIp(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        reason: "desconhecida",
        now: 1_010,
      });
    }

    expect(checkPerimeter(alvo, 1_011).allowed, "o teto de memória virou o botão de destravar do atacante").toBe(
      false,
    );
    expect(
      perimeterScanCounters().distinctClients,
      "o teto de memória tem de continuar valendo — senão o conserto virou um vazamento",
    ).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
  });
});

describe("ATAQUE: fazer o COMPARADOR lançar para ganhar tentativas de graça e sem rastro", () => {
  // O canal de sondagem INVISÍVEL. `guardPerimeter` chamava `validate()` fora de qualquer proteção, e
  // uma exceção ESCAPAVA do portão: a tentativa não era contada na trava, não gerava linha no rastro
  // durável, e a resposta deixava de ser a mudez para virar o erro que a rota fizesse do throw. Logo,
  // QUALQUER classe de entrada que fizesse o comparador lançar (corpo malformado, registro de handle
  // ilegível, segredo com forma inesperada) rendia tentativas ILIMITADAS e invisíveis — e de brinde um
  // oráculo, porque "entrada que quebra o validador" respondia diferente de "chute errado".
  //
  // Um valor de alta variedade: o teste varre TODAS as janelas de 4 chars dele contra o arquivo.
  const SEGREDO = "Zt7Qx1LmVb4Ns9Rd2Fk6Wp0Yc3Hg5Ju8Ae";

  /** O que um `JSON.parse`/Zod real faz: a mensagem EMBUTE a entrada que quebrou. */
  const lanca = (): never => {
    throw new Error(`falhou ao comparar ${SEGREDO}`);
  };

  it("a exceção do comparador CONTA na trava — não são tentativas de graça", async () => {
    const ip = "198.51.100.31";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      const r = await guardPerimeter({
        headers: fromIp(ip),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        stance: "muda",
        validate: lanca,
        now: i,
      });
      expect(r.ok).toBe(false);
    }
    expect(
      checkPerimeter(fromIp(ip), 10).allowed,
      "quebrar o validador dava orçamento infinito: a tentativa não era contada",
    ).toBe(false);
  });

  it("a exceção NÃO escapa do portão: a resposta segue MUDA (nem 500, nem oráculo)", async () => {
    const r = await guardPerimeter({
      headers: fromIp("198.51.100.32"),
      surface: PERIMETER_SURFACES.mcp,
      via: "path",
      stance: "muda",
      validate: lanca,
      now: 1,
    });
    expect(r.ok, "o portão precisa RESOLVER com recusa — uma rejeição deixa a rota inventar a resposta").toBe(false);
    if (r.ok) return;
    expect(r.response.status, "404 nu — igual a rota inexistente e igual a um chute errado").toBe(404);
    expect(r.response.headers.get("retry-after")).toBeNull();
  });

  it("a exceção deixa linha no rastro — com o MOTIVO, e sem a mensagem que embute o valor tentado", async () => {
    await guardPerimeter({
      headers: fromIp("198.51.100.33"),
      surface: PERIMETER_SURFACES.mcp,
      via: "path",
      stance: "muda",
      presented: SEGREDO,
      validate: lanca,
      now: 1,
    });
    await flushAuthFailures();

    const bruto = await readFile(authFailuresPath(), "utf8");
    for (let i = 0; i + 4 <= SEGREDO.length; i++) {
      const janela = SEGREDO.slice(i, i + 4);
      expect(bruto.includes(janela), `a mensagem do erro vazou "${janela}" para o arquivo forense`).toBe(false);
    }
    const linha = (await readAuthFailures()).at(-1);
    expect(linha?.reason, "uma invasão que quebra o validador tem de ter NOME no forense").toBe("erro-na-comparacao");
    expect(linha?.errorKind, "o motivo é a CLASSE do erro — nunca a mensagem, que embute a entrada").toBe("Error");
    // O comprimento PODE sair (o atacante já sabe o que mandou) — é o que distingue "mandou vazio" de
    // "mandou algo do nosso formato" e por isso é a única coisa do valor que o rastro carrega.
    expect(bruto).toContain(`${SEGREDO.length} chars`);
  });

  it("esconder o valor tentado DENTRO do erro não o faz chegar ao forense", async () => {
    // As outras duas vias indiretas além da mensagem: o valor LANÇADO cru (`throw <segredo>`, que um
    // `String(err)` gravaria inteiro) e o `name`/`code` da classe. O rótulo é derivado só de campos com
    // FORMA de identificador e comprimento abaixo do piso de credencial — nada aqui passa.
    const lancaCru = (): never => {
      throw SEGREDO;
    };
    const disfarcado = new Error("x");
    disfarcado.name = SEGREDO;
    (disfarcado as { code?: unknown }).code = SEGREDO;
    const lancaDisfarcado = (): never => {
      throw disfarcado;
    };

    for (const validate of [lancaCru, lancaDisfarcado]) {
      await guardPerimeter({
        headers: fromIp("198.51.100.36"),
        surface: PERIMETER_SURFACES.runnerPulse,
        via: "query",
        stance: "declarada",
        validate,
        now: 1,
      });
    }
    await flushAuthFailures();

    const bruto = await readFile(authFailuresPath(), "utf8");
    for (let i = 0; i + 4 <= SEGREDO.length; i++) {
      const janela = SEGREDO.slice(i, i + 4);
      expect(bruto.includes(janela), `o erro contrabandeou "${janela}" para o arquivo forense`).toBe(false);
    }
    expect((await readAuthFailures()).map((l) => l.errorKind)).toEqual(["nao-erro:string", "Error"]);
  });

  it("trancar a origem por exceção NÃO tranca o DONO: a credencial válida atravessa", async () => {
    // O desfecho PROIBIDO: se contar a exceção virasse um jeito de o anônimo desligar o painel, o
    // conserto teria comprado zero segurança pagando com capacidade do dono.
    const ip = "198.51.100.34";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      await guardPerimeter({
        headers: fromIp(ip),
        surface: PERIMETER_SURFACES.mcp,
        via: "path",
        stance: "muda",
        validate: lanca,
        now: i,
      });
    }
    expect(checkPerimeter(fromIp(ip), 10).allowed, "o cenário não montou: a origem tinha de estar trancada").toBe(
      false,
    );

    const dono = await guardPerimeter({
      headers: fromIp(ip),
      surface: PERIMETER_SURFACES.login,
      via: "body",
      stance: "declarada",
      validate: () => ({ valid: true, value: "sessão-do-dono" }) as const,
      now: 20,
    });
    expect(dono.ok, "a trava recusou credencial VÁLIDA — quebrar o validador desligaria o painel do dono").toBe(true);
  });

  it("insistir com o validador quebrado depois de trancado não enche o disco nem o journal", async () => {
    // Depois da trava quem controla o VOLUME é o atacante. Vale para as duas superfícies de escrita: o
    // rastro durável (arquivo) e o `console.warn` (journald) — um log por insistência transforma o
    // registro da invasão no vetor dela.
    const headers = fromIp("198.51.100.35");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A contagem é lida ANTES de restaurar: `mockRestore` também RESETA o registro de chamadas, e ler
    // depois dele mediria zero — a asserção passaria sem provar nada.
    let linhasDeJournal = -1;
    try {
      for (let i = 0; i < PERIMETER_POLICY.maxFailures + 300; i++) {
        await guardPerimeter({
          headers,
          surface: PERIMETER_SURFACES.mcp,
          via: "path",
          stance: "muda",
          validate: lanca,
          now: i,
        });
      }
      linhasDeJournal = warn.mock.calls.length;
    } finally {
      warn.mockRestore();
    }
    await flushAuthFailures();

    expect(
      (await readAuthFailures()).length,
      "uma linha por tentativa entrega o disco a quem descobriu como quebrar o validador",
    ).toBeLessThanOrEqual(PERIMETER_POLICY.maxFailures + 5);
    expect(linhasDeJournal, "uma linha de journal por tentativa entrega o journal ao atacante").toBeLessThanOrEqual(
      PERIMETER_POLICY.maxFailures,
    );
    expect(linhasDeJournal, "o comparador quebrado tem de gritar ao menos uma vez").toBeGreaterThan(0);
  });
});

describe("ATAQUE: inventar uma superfície nova a cada tentativa para afogar o forense", () => {
  // O resumo agrega por superfície (`bySurface`), e o path abaixo de uma superfície é texto do CLIENTE.
  // Se cada tentativa puder escrever uma chave nova, o resumo explode em milhares de linhas e o forense
  // vira ruído exatamente quando for preciso lê-lo. A canonicalização vive no chokepoint, não no
  // chamador: controle que depende de disciplina alheia não é controle.

  it("o path abaixo de uma superfície DECLARADA colapsa nela — o cliente não cria chave no resumo", async () => {
    const headers = fromIp("198.51.100.41");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      recordAuthFailure({
        headers,
        surface: `${PERIMETER_SURFACES.terminalHttp}/a${i}`,
        via: "cookie",
        reason: "desconhecida",
        now: i,
      });
    }
    await flushAuthFailures();
    const s = await readAuthFailureSummary({ now: 10 });
    expect(Object.keys(s.bySurface), "cada tentativa virou uma chave — o resumo forense virou ruído").toEqual([
      PERIMETER_SURFACES.terminalHttp,
    ]);
  });

  it("um segredo CURTO carregado no path NÃO chega ao forense", async () => {
    // A redação por FORMA só apaga segmento LONGO (> 24 chars): um segredo curto — o token fraco que
    // um self-host configurou à mão, ou o chute do atacante — passava inteiro para o arquivo.
    recordAuthFailure({
      headers: fromIp("198.51.100.42"),
      surface: "/api/usm/hunter2/mcp",
      via: "path",
      reason: "desconhecida",
      now: 1,
    });
    await flushAuthFailures();
    const bruto = await readFile(authFailuresPath(), "utf8");
    expect(bruto.includes("hunter2"), "um segredo curto no path vazou para o arquivo forense").toBe(false);
    expect((await readAuthFailures()).at(-1)?.surface).toBe(PERIMETER_SURFACES.mcp);
  });

  it("a superfície MAIS específica ganha: o shell não se esconde no balde do HTTP", () => {
    expect(canonicalSurface(`${PERIMETER_SURFACES.terminalUpgrade}?arg=minha-sessao`)).toBe(
      PERIMETER_SURFACES.terminalUpgrade,
    );
    expect(canonicalSurface(`${PERIMETER_SURFACES.terminalHttp}/token`)).toBe(PERIMETER_SURFACES.terminalHttp);
  });

  it("uma superfície NÃO declarada continua redigida, nunca colapsada num balde alheio", () => {
    // O colapso é por SEGMENTO: `startsWith` cru jogaria `/ttyd-publico` no balde do terminal e faria o
    // forense acusar a superfície errada.
    expect(canonicalSurface("/ttyd-publico/x")).toBe("/ttyd-publico/x");
    expect(canonicalSurface("/api/outra/coisa")).toBe("/api/outra/coisa");
  });
});

describe("as duas superfícies do TERMINAL vivem no MESMO vocabulário do perímetro", () => {
  // O balde é UM por origem para o perímetro inteiro — é isso que impede o atacante de rotacionar de
  // superfície e multiplicar o orçamento. Dois vocabulários (um em `auth-audit`, outro em
  // `terminal-gateway`) recriam a rotação na fronteira entre eles: nada garante estruturalmente que a
  // superfície declarada só num deles compartilhe o balde e apareça no resumo.
  //
  // ⚠️ O QUE ESTE BLOCO DEIXOU DE SER: um teste que só afirmava, sobre a constante DESTE arquivo, que
  // ela está contida na constante vizinha — verdade por construção, e cego para a divergência que ele
  // dizia fechar (o gateway continuava com uma lista LOCAL e o teste jamais acusaria). Agora quem é
  // medido é o GATEWAY: o rastro que ele produz de verdade é que tem de nomear superfície DECLARADA e
  // gastar o MESMO balde.

  const OUTRO_SEGREDO = "x".repeat(43);
  const SEGREDO = "s".repeat(43);
  const TOKEN_OPERADOR = "t".repeat(43);
  /** O ttyd nunca é alcançado nestes casos: toda tentativa é RECUSADA antes de qualquer conexão. */
  const ALVO_INALCANCADO = { host: "127.0.0.1", port: 1 };

  let prevSecret: string | undefined;
  let prevToken: string | undefined;

  beforeEach(() => {
    prevSecret = process.env[SESSION_SECRET_ENV];
    prevToken = process.env[TOKEN_ENV];
    process.env[SESSION_SECRET_ENV] = SEGREDO;
    process.env[TOKEN_ENV] = TOKEN_OPERADOR;
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env[SESSION_SECRET_ENV];
    else process.env[SESSION_SECRET_ENV] = prevSecret;
    if (prevToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = prevToken;
  });

  /** Um cookie ASSINADO com outro segredo — o que um forjador produz, e a classe que a trava cobra. */
  function cookieForjado(): Promise<string> {
    return signSession({ sessionSecret: OUTRO_SEGREDO, operatorToken: OUTRO_SEGREDO });
  }

  function headersDoGateway(cookie: string, ip: string): Record<string, string> {
    return {
      host: "board.exemplo.com",
      origin: "https://board.exemplo.com",
      "x-forwarded-for": ip,
      cookie: `${SESSION_COOKIE}=${cookie}`,
    };
  }

  function reqFalso(headers: Record<string, string>, url: string): IncomingMessage {
    const rawHeaders: string[] = [];
    for (const [k, v] of Object.entries(headers)) rawHeaders.push(k, v);
    return { headers, rawHeaders, url, method: "GET" } as unknown as IncomingMessage;
  }

  /** Uma tentativa pelo caminho HTTP (`GET /ttyd/token`), devolvendo o status que o cliente leu. */
  async function tentarHttp(cookie: string, ip: string): Promise<number> {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(s: number) {
        status = s;
        return res;
      },
      end() {},
      destroy() {},
    };
    await proxyTerminalHttp(
      reqFalso(headersDoGateway(cookie, ip), "/ttyd/token"),
      res as unknown as ServerResponse,
      ALVO_INALCANCADO,
    );
    return status;
  }

  /** Uma tentativa pelo handshake que vira SHELL, devolvendo a linha de status escrita no socket. */
  async function tentarUpgrade(cookie: string, ip: string): Promise<string> {
    let escrito = "";
    const socket = {
      writable: true,
      write(chunk: string) {
        escrito += chunk;
        return true;
      },
      destroy() {},
      on() {
        return socket;
      },
      setNoDelay() {},
      setTimeout() {},
      pipe<T>(d: T): T {
        return d;
      },
    };
    await proxyTerminalUpgrade(
      reqFalso(headersDoGateway(cookie, ip), "/ttyd/ws?arg=claude"),
      socket as unknown as Socket,
      Buffer.alloc(0),
      ALVO_INALCANCADO,
    );
    return escrito.split("\r\n")[0] ?? "";
  }

  it("o GATEWAY grava superfície DECLARADA do perímetro — medido pelo rastro que ele produz", async () => {
    // Se o gateway voltar a ter vocabulário próprio (um rótulo que não está no mapa canônico), a linha
    // que ELE grava passa a nomear um balde à parte: fora do resumo forense e fora do colapso de
    // `canonicalSurface`. É isso que se mede aqui, e não a forma de uma constante.
    const forjado = await cookieForjado();
    await tentarHttp(forjado, "198.51.100.61");
    await tentarUpgrade(forjado, "198.51.100.61");
    await flushAuthFailures();

    const doGateway = (await readAuthFailures()).filter((l) => l.via === "cookie");
    expect(doGateway.length, "o gateway tem de deixar rastro nas DUAS superfícies").toBe(2);
    const declaradas = Object.values(PERIMETER_SURFACES) as string[];
    for (const l of doGateway) {
      expect(declaradas, `superfície "${l.surface}" fora do vocabulário canônico é um balde à parte`).toContain(
        l.surface,
      );
    }
    expect(doGateway.map((l) => l.surface)).toEqual([
      TERMINAL_PERIMETER_SURFACES.http,
      TERMINAL_PERIMETER_SURFACES.upgrade,
    ]);
  });

  it("o terminal compartilha o balde: trancado nas outras seis, o SHELL não dá tentativa extra", async () => {
    // A rotação de superfície, medida ponta a ponta. Sete falhas em `/api/usm`; a oitava vai pelo
    // GATEWAY. Com balde próprio ela seria a primeira dele — 401, mais uma tentativa de graça contra a
    // superfície que entrega SHELL. Compartilhando o balde ela ESTOURA o teto e sai 429.
    const ip = "198.51.100.62";
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i++) {
      recordAuthFailure({ headers: fromIp(ip), surface: PERIMETER_SURFACES.mcp, via: "path", reason: "desconhecida" });
    }
    const forjado = await cookieForjado();
    expect(await tentarHttp(forjado, ip), "a tentativa no terminal gastou o orçamento das outras").toBe(429);
    expect(await tentarUpgrade(forjado, ip)).toMatch(/^HTTP\/1\.1 429\b/);
  });

  it("a postura de divulgação de cada superfície é DECLARADA, não literal no chamador", () => {
    expect(stanceOfSurface(PERIMETER_SURFACES.mcp), "a rota MCP não pode admitir que existe").toBe("muda");
    expect(stanceOfSurface(TERMINAL_PERIMETER_SURFACES.upgrade)).toBe("declarada");
    expect(stanceOfSurface(`${TERMINAL_PERIMETER_SURFACES.http}/token`)).toBe("declarada");
    expect(stanceOfSurface("/api/nao-declarada"), "superfície não declarada não pode admitir que existe").toBe("muda");
  });
});

describe("ATAQUE: ler o rastro forense de outra conta local", () => {
  it("um rastro PRÉ-EXISTENTE com modo folgado é corrigido para 0600", async () => {
    // `appendFile(..., {mode})` só vale na CRIAÇÃO: um arquivo herdado de uma edição manual, de um
    // backup ou de uma versão anterior do serviço fica 0644 para sempre. E este arquivo nomeia as
    // origens e as superfícies de uma invasão EM CURSO — entregá-lo a qualquer conta local do host é
    // dizer ao atacante quanto do rastro dele já apareceu.
    writeFileSync(authFailuresPath(), "", "utf8");
    chmodSync(authFailuresPath(), 0o644);

    recordAuthFailure({
      headers: fromIp("192.0.2.30"),
      surface: PERIMETER_SURFACES.mcp,
      via: "path",
      reason: "desconhecida",
      now: 1,
    });
    await flushAuthFailures();

    // eslint-disable-next-line no-bitwise -- modo de arquivo é máscara de bits por definição
    expect(statSync(authFailuresPath()).mode & 0o777).toBe(0o600);
  });
});
