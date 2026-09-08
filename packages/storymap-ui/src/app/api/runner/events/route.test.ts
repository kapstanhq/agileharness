// O QUE ESTA ROTA NÃO PODE DEIXAR ACONTECER (auth de `/api/runner/events`).
//
// Antes de story-h8tmzh/story-m9jflb: a credencial só entrava por `?secret=<token>` (query string —
// que vaza em log de acesso, em `Referer` e em histórico de proxy: 174 gravações medidas em
// story-u4yf1i) e TODA recusa era 401 sem uma linha de log em nenhum lugar.
//
// Cada `it` abaixo descreve um ATAQUE ou uma CAPACIDADE que não pode regredir, nunca a implementação.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authFailuresPath,
  flushAuthFailures,
  readAuthFailures,
  resetPerimeterState,
} from "@/lib/auth/auth-audit";
import { createMcpHandle, flushHandleTouches } from "@/lib/auth/mcp-handle";
import { isStrongSecret } from "@/lib/storymap/mcp/auth";
import { resetQueryDeprecationNotice } from "../perimeter";
import { GET } from "./route";

// Fixture derivado por hash: determinístico, sem literal de credencial no repo, e conferido pela
// MESMA régua da rota (o piso de `isMcpTokenValid` é 32 chars + variedade + entropia — um fixture
// fraco viraria 401 em TODO caso e esconderia o que a rota faz).
const TOKEN = createHash("sha256").update("events fixture").digest("base64url");

function req(query = "", headers?: Record<string, string>): Request {
  return new Request(`http://localhost:3008/api/runner/events${query}`, { headers });
}

let prevToken: string | undefined;
let prevStateDir: string | undefined;
let stateDir = "";

beforeEach(() => {
  prevToken = process.env.STORYMAP_MCP_TOKEN;
  process.env.STORYMAP_MCP_TOKEN = TOKEN;
  // O rastro e o registro de handles vão para um dir de teste: o forense do serviço vivo não é
  // lugar de linha de teste.
  prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "events-auth-"));
  process.env.STORYMAP_RUNNER_STATE_DIR = stateDir;
  resetPerimeterState();
  resetQueryDeprecationNotice();
});

afterEach(async () => {
  await flushAuthFailures();
  await flushHandleTouches();
  resetPerimeterState();
  resetQueryDeprecationNotice();
  if (prevToken === undefined) delete process.env.STORYMAP_MCP_TOKEN;
  else process.env.STORYMAP_MCP_TOKEN = prevToken;
  if (prevStateDir === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
  else process.env.STORYMAP_RUNNER_STATE_DIR = prevStateDir;
  // DEPOIS dos flushes: rastro de auth e registro de handles ainda escrevem aqui.
  rmSync(stateDir, { recursive: true, force: true });
});

describe("GET /api/runner/events — auth", () => {
  it("o fixture atende o piso de força do validador (senão a suíte inteira viraria 401 muda)", () => {
    expect(isStrongSecret(TOKEN)).toBe(true);
  });

  it("401 quando nenhuma credencial é apresentada", async () => {
    expect((await GET(req())).status).toBe(401);
  });

  it("401 quando o secret está errado", async () => {
    expect((await GET(req("?secret=nope"))).status).toBe(401);
  });

  it("401 mesmo com um secret de forma correta quando a env não está definida (fail-closed)", async () => {
    delete process.env.STORYMAP_MCP_TOKEN;
    expect((await GET(req(`?secret=${TOKEN}`))).status).toBe(401);
  });

  it("CAPACIDADE NOVA: `Authorization: Bearer` autentica — a credencial sai da URL", async () => {
    // O ataque que isto fecha não é de rede, é de RETENÇÃO: com o token na query, todo intermediário
    // tem a oportunidade de gravá-lo (o logger de erro DEFAULT do Caddy gravou 174 vezes). Com o
    // header, a URL registrada em log não contém credencial nenhuma.
    const res = await GET(req("", { authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    await res.body?.cancel();
  });

  it("COMPATIBILIDADE: `?secret=` continua autenticando (há automação viva usando isso)", async () => {
    // Quebrar a query seria REMOÇÃO DE CAPACIDADE: o dono tem automação batendo nestas rotas hoje.
    const res = await GET(req(`?secret=${TOKEN}`));
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("a query autenticada é ANUNCIADA como deprecada — uma vez por processo, e sem o valor", async () => {
    // Uma linha por request afogaria o journal (o monitor polla continuamente) e o operador pararia
    // de ler; e o aviso NUNCA pode ecoar o segredo, senão a depreciação repete o defeito que ela
    // existe para acabar.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const res of [await GET(req(`?secret=${TOKEN}`)), await GET(req(`?secret=${TOKEN}`))]) {
        await res.body?.cancel();
      }
      const linhas = warn.mock.calls.map((c) => String(c[0]));
      const depreciacao = linhas.filter((l) => l.includes("DEPRECADO"));
      expect(depreciacao).toHaveLength(1);
      expect(depreciacao[0]).toContain("Authorization: Bearer");
      expect(depreciacao[0]).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it("o header AUTENTICADO não dispara aviso de depreciação (não há o que migrar)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await GET(req("", { authorization: `Bearer ${TOKEN}` }));
      await res.body?.cancel();
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("DEPRECADO"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("um Bearer ERRADO é recusado igual à query errada — e nenhum carregador é privilegiado", async () => {
    expect((await GET(req("", { authorization: "Bearer nao-e-o-token" }))).status).toBe(401);
    // `Basic` (scanner típico) não é interpretado como credencial de outro protocolo: é ausência.
    expect((await GET(req("", { authorization: "Basic YWRtaW46YWRtaW4=" }))).status).toBe(401);
  });

  it("um `Authorization` de OUTRO esquema não pode CEGAR a query — a automação do dono não para", async () => {
    // Regressão que isto impede: um proxy de autenticação posto na frente injeta `Basic …`, e o
    // cliente que autenticava por `?secret=` passaria a levar 401 sem nada do lado dele ter mudado.
    // Perder capacidade por header de terceiro é exatamente o desfecho proibido.
    const res = await GET(req(`?secret=${TOKEN}`, { authorization: "Basic YWRtaW46YWRtaW4=" }));
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("RASTRO: a recusa deixa uma linha durável — e ela NÃO contém o segredo tentado", async () => {
    // O defeito original: `journalctl -u storymap` dizia `-- No entries --` no mesmo minuto de 6
    // recusas. Sem fonte de log, uma invasão em curso é 100% irreconstruível.
    const tentado = "credencial-de-ataque-com-32-caracteres";
    const res = await GET(req(`?secret=${tentado}`, { "x-forwarded-for": "203.0.113.9" }));
    expect(res.status).toBe(401);
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]!.surface).toBe("/api/runner/events");
    expect(linhas[0]!.via).toBe("query");
    expect(linhas[0]!.reason).toBe("desconhecida");
    expect(linhas[0]!.client).toBe("203.0.113.9");
    // Só o COMPRIMENTO do valor tentado sai — nem prefixo, nem sufixo.
    expect(linhas[0]!.presented).toContain(String(tentado.length));
    const bruto = await readFile(authFailuresPath(), "utf8");
    expect(bruto).not.toContain(tentado);
  });

  it("um HANDLE `ro` abre esta rota de LEITURA — credencial revogável sem restart", async () => {
    // Por que isto importa: trocar `STORYMAP_MCP_TOKEN` exige reiniciar o serviço (o guardrail do
    // projeto proíbe reiniciá-lo à vontade), então a rotação está na prática TRAVADA. Um handle é
    // revogável no request seguinte — e um `ro` é o que o dono pode dar a um monitor sem entregar o
    // resto do sistema.
    const { handle } = await createMcpHandle({ level: "ro", label: "monitor de leitura" });
    const res = await GET(req("", { authorization: `Bearer ${handle}` }));
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });
});
