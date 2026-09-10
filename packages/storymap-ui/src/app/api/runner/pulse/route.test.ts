// A SUPERFÍCIE ONDE A CEGUEIRA FOI REPRODUZIDA AO VIVO (auth de `/api/runner/pulse`).
//
// story-m9jflb, medido: 6 GETs consecutivos a `/api/runner/pulse` com `secret` errado devolveram
// `401,401,401,401,401,401` — sem 429, sem `Retry-After`, sem lockout — e o `journalctl -u storymap`
// do mesmo minuto disse `-- No entries --`. O dano NÃO é "chuta e ganha autonomia" (o token vivo tem
// 256 bits): é que uma invasão em curso era 100% invisível, e por isso nenhuma detecção de
// brute-force/password-spray era executável.
//
// Cada `it` descreve o ATAQUE, não a implementação. `?board=` aponta para um board inexistente de
// propósito: a rota agrega demandas por board, e o filtro mantém o teste em UMA leitura tolerante a
// falta em vez de varrer o disco do repositório.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PERIMETER_POLICY,
  authFailuresPath,
  flushAuthFailures,
  readAuthFailures,
  resetPerimeterState,
} from "@/lib/auth/auth-audit";
import { createMcpHandle, flushHandleTouches, revokeMcpHandle } from "@/lib/auth/mcp-handle";
import { isStrongSecret } from "@/lib/storymap/mcp/auth";
import { resetQueryDeprecationNotice } from "../perimeter";
import { GET } from "./route";

const TOKEN = createHash("sha256").update("pulse fixture").digest("base64url");
const BOARD = "?board=nao-existe-xyz-pulse";

function req(query: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost:3008/api/runner/pulse${query}`, { headers });
}
/** Uma origem por caso: a trava é UM balde por origem para o perímetro inteiro. */
function fromIp(ip: string): Record<string, string> {
  return { "x-forwarded-for": ip };
}

let prevToken: string | undefined;
let prevStateDir: string | undefined;
let stateDir = "";
/** Dirs criados DENTRO do corpo de um caso — o afterEach abaixo os apaga junto com o do teste. */
const dirsAvulsos: string[] = [];

beforeEach(() => {
  prevToken = process.env.AGILEHARNESS_MCP_TOKEN;
  process.env.AGILEHARNESS_MCP_TOKEN = TOKEN;
  prevStateDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "pulse-auth-"));
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
  resetPerimeterState();
  resetQueryDeprecationNotice();
});

afterEach(async () => {
  await flushAuthFailures();
  await flushHandleTouches();
  resetPerimeterState();
  resetQueryDeprecationNotice();
  if (prevToken === undefined) delete process.env.AGILEHARNESS_MCP_TOKEN;
  else process.env.AGILEHARNESS_MCP_TOKEN = prevToken;
  if (prevStateDir === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevStateDir;
  // Só DEPOIS dos flushes acima: apagar antes trocaria o diretório órfão por um erro de escrita.
  rmSync(stateDir, { recursive: true, force: true });
  for (const d of dirsAvulsos.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("GET /api/runner/pulse — auth", () => {
  it("o fixture atende o piso de força do validador (senão a suíte inteira viraria 401 muda)", () => {
    expect(isStrongSecret(TOKEN)).toBe(true);
  });

  it("401 sem credencial e 401 com credencial errada (fail-closed, resposta muda)", async () => {
    expect((await GET(req(BOARD, fromIp("198.51.100.1")))).status).toBe(401);
    expect((await GET(req(`${BOARD}&secret=nope`, fromIp("198.51.100.2")))).status).toBe(401);
  });

  it("CAPACIDADE NOVA: `Authorization: Bearer` autentica e devolve o snapshot", async () => {
    const res = await GET(req(BOARD, { authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: unknown[]; demands: unknown[] };
    expect(Array.isArray(body.running)).toBe(true);
    expect(Array.isArray(body.demands)).toBe(true);
  });

  it("COMPATIBILIDADE: o monitor autônomo que polla com `?secret=` continua funcionando", async () => {
    const res = await GET(req(`${BOARD}&secret=${TOKEN}`));
    expect(res.status).toBe(200);
  });

  it("ATAQUE: martelar a rota TRANCA a origem — 429 com Retry-After, e loopback não é isento", async () => {
    // A lição ClawJacked: o limiter do OpenClaw isentava loopback e qualquer página aberta no
    // navegador do operador virava cliente "local confiável" com martelo livre. Aqui 127.0.0.1
    // conta igual a um IP da internet.
    const atacante = fromIp("127.0.0.1");
    const status: number[] = [];
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      status.push((await GET(req(`${BOARD}&secret=errado-${i}`, atacante))).status);
    }
    // O estado ANTIGO era exatamente esta lista toda em 401 — sem trava, sem teto.
    expect(status.slice(0, PERIMETER_POLICY.maxFailures - 1).every((s) => s === 401)).toBe(true);
    const ultima = status[status.length - 1]!;
    expect(ultima).toBe(429);

    // Trancado: quem CONTINUA sem credencial leva 429, e ele diz quanto esperar.
    const insistindo = await GET(req(`${BOARD}&secret=errado-de-novo`, atacante));
    expect(insistindo.status).toBe(429);
    expect(Number(insistindo.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("ATAQUE (DoS contra o dono): a origem trancada NÃO barra quem tem o token certo", async () => {
    // A asserção que existia aqui era o desfecho PROIBIDO: ela fixava "token CERTO durante o bloqueio ⇒
    // 429" como esperado, e um teste que fixa a vulnerabilidade impede o conserto.
    //
    // O ATAQUE: `127.0.0.1` é a chave de trava REAL do monitor do dono nesta instalação (o Caddy
    // substitui o XFF pelo peer, e o monitor roda na própria VPS). Com a trava consultada antes da
    // comparação, qualquer coisa que gastasse o orçamento dessa origem — inclusive um chute anônimo que
    // chegue como loopback — desligava o poll do dono por até 60 minutos, sem nada do lado dele mudar.
    // Hoje a credencial é comparada PRIMEIRO: quem tem o token entra mesmo com a origem trancada.
    const atacante = fromIp("127.0.0.1");
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      await GET(req(`${BOARD}&secret=errado-${i}`, atacante));
    }

    const dono = await GET(req(`${BOARD}&secret=${TOKEN}`, atacante));
    expect(dono.status, "a trava recusou o token válido — DoS contra o monitor do próprio dono").toBe(200);
    // E o acerto perdoa a janela: o poll seguinte não herda o backoff que o atacante criou.
    expect((await GET(req(BOARD, { ...atacante, authorization: `Bearer ${TOKEN}` }))).status).toBe(200);
  });

  it("a TRAVA não pode virar interruptor de desligar o dono: outra origem segue entrando", async () => {
    // O teto GLOBAL foi deliberadamente rejeitado: ele fecharia o caso do atacante distribuído mas
    // entregaria a ele uma negação de serviço contra o conector do próprio operador.
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      await GET(req(`${BOARD}&secret=errado-${i}`, fromIp("203.0.113.66")));
    }
    const dono = await GET(req(BOARD, { ...fromIp("192.0.2.7"), authorization: `Bearer ${TOKEN}` }));
    expect(dono.status).toBe(200);
  });

  it("credencial VÁLIDA perdoa a janela: um token velho colado 3× não custa backoff depois do acerto", async () => {
    const operador = fromIp("192.0.2.50");
    for (let i = 0; i < 3; i++) expect((await GET(req(`${BOARD}&secret=velho-${i}`, operador))).status).toBe(401);
    expect((await GET(req(BOARD, { ...operador, authorization: `Bearer ${TOKEN}` }))).status).toBe(200);
    for (let i = 0; i < PERIMETER_POLICY.maxFailures - 1; i++) {
      expect((await GET(req(`${BOARD}&secret=de-novo-${i}`, operador))).status).toBe(401);
    }
  });

  it("RASTRO: cada recusa grava uma linha com origem + superfície, e nunca o segredo tentado", async () => {
    const tentado = "outra-credencial-de-ataque-bem-longa";
    await GET(req(`${BOARD}&secret=${tentado}`, fromIp("203.0.113.77")));
    await GET(req(BOARD, { ...fromIp("203.0.113.77"), authorization: `Bearer ${tentado}` }));
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    expect(linhas).toHaveLength(2);
    expect(linhas.map((l) => l.via)).toEqual(["query", "header"]);
    expect(linhas.every((l) => l.surface === "/api/runner/pulse")).toBe(true);
    expect(linhas.every((l) => l.client === "203.0.113.77")).toBe(true);
    expect(await readFile(authFailuresPath(), "utf8")).not.toContain(tentado);
  });

  it("um HANDLE REVOGADO deixa de entrar no request seguinte — sem restart do serviço", async () => {
    // É a propriedade que o token do env NÃO tem: rotacionar `AGILEHARNESS_MCP_TOKEN` exige reiniciar o
    // serviço, e é por isso que o token vazado ficou vivo 54 dias. Aqui o corte é imediato.
    const { handle, record } = await createMcpHandle({ level: "ro", label: "monitor" });
    expect((await GET(req(BOARD, { authorization: `Bearer ${handle}` }))).status).toBe(200);

    expect(await revokeMcpHandle(record.id)).toBe("revogado");
    expect((await GET(req(BOARD, { authorization: `Bearer ${handle}` }))).status).toBe(401);
    await flushAuthFailures();

    // E o rastro NOMEIA o handle: um revogado reapresentado é sinal de vazamento EM USO, não erro
    // de digitação — e sem o id o operador não saberia qual credencial queimar.
    const revogado = (await readAuthFailures()).find((l) => l.reason === "handle-revogado");
    expect(revogado?.handleId).toBe(record.id);
  });

  it("rastro que não consegue gravar NÃO derruba a rota — a recusa segue sendo 401, nunca 500", async () => {
    // Um rastro que quebra a rota de autenticação seria negação de serviço auto-infligida: o pior
    // desfecho possível aqui é o serviço parar de responder ao dono. Então a gravação falha ABERTO —
    // avisa e segue —, e a recusa continua sendo a de sempre.
    // Erro de disco REAL, não simulado: um ARQUIVO onde o rastro espera um diretório ⇒ ENOTDIR no
    // `mkdir`. (Um NUL no path não serve — `process.env` trunca o valor e o dir volta a ser válido.)
    const raizEnotdir = mkdtempSync(path.join(tmpdir(), "pulse-auth-enotdir-"));
    dirsAvulsos.push(raizEnotdir);
    const arquivo = path.join(raizEnotdir, "sou-um-arquivo");
    writeFileSync(arquivo, "x");
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = path.join(arquivo, "estado");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await GET(req(`${BOARD}&secret=nope`, fromIp("203.0.113.90")))).status).toBe(401);
      await flushAuthFailures();
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("[auth-audit]"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
