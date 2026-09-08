import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST } from "./route";
import { isStrongSecret } from "@/lib/storymap/mcp/auth";
import {
  authFailuresPath,
  flushAuthFailures,
  readAuthFailures,
  resetPerimeterState,
} from "@/lib/auth/auth-audit";
import { createMcpHandle, flushHandleTouches } from "@/lib/auth/mcp-handle";
import { resetQueryDeprecationNotice } from "../perimeter";

// O fixture tem de ser um segredo que o PISO de produção ACEITA. story-7q83gx elevou
// `isMcpTokenValid` a 32 chars + variedade + entropia e fez ele recusar um `expected` FRACO
// (defesa em profundidade: um processo subido por outro entrypoint não vira porta aberta) — o
// antigo `"x".repeat(24)` passou a ser recusado como "curto", e TODA esta suíte virou 401,
// escondendo o que a rota realmente faz com o payload. Derivado por hash: determinístico (sem
// flake), sem literal de credencial no repo (o varredor de segredos não tem o que marcar) e
// conferido pela MESMA régua da rota, para o fixture não apodrecer em silêncio se o piso subir.
const TOKEN = createHash("sha256").update("test-webhook fixture").digest("base64url");

function req(secret: string, body: unknown): Request {
  return new Request(`http://localhost/api/runner/test-webhook?secret=${secret}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
/** O caminho PREFERIDO: a credencial no header, fora da URL (e fora de todo log de proxy). */
function reqBearer(token: string, body: unknown, extra?: Record<string, string>): Request {
  return new Request(`http://localhost/api/runner/test-webhook`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra },
  });
}

const DONE = { board: "nao-existe-xyz-test", cardId: "card-z", trigger: "harness-qa", passed: true } as const;

describe("POST /api/runner/test-webhook (ADR-063 3b — durable async-test callback)", () => {
  let prev: string | undefined;
  let prevStateDir: string | undefined;
  let stateDir = "";
  // A fila de testes é um SINGLETON pinado em globalThis: ela resolve `runnerStateDir()` UMA vez, na
  // primeira chamada, e todo persist seguinte faz `mkdir` naquele primeiro dir — inclusive DEPOIS do
  // rmSync do afterEach dele. Por isso os dirs também são varridos no fim do arquivo, quando a cadeia
  // de persists já drenou: sem essa segunda passada sobra exatamente um órfão por execução.
  const dirsDoArquivo: string[] = [];
  beforeEach(() => {
    prev = process.env.STORYMAP_MCP_TOKEN;
    process.env.STORYMAP_MCP_TOKEN = TOKEN;
    // Rastro de auth, registro de handles e ledger da fila em dir de teste — o estado do serviço
    // vivo não é lugar de escrita de teste.
    prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
    stateDir = mkdtempSync(path.join(tmpdir(), "test-webhook-auth-"));
    dirsDoArquivo.push(stateDir);
    process.env.STORYMAP_RUNNER_STATE_DIR = stateDir;
    resetPerimeterState();
    resetQueryDeprecationNotice();
  });
  afterEach(async () => {
    await flushAuthFailures();
    await flushHandleTouches();
    resetPerimeterState();
    resetQueryDeprecationNotice();
    if (prev === undefined) delete process.env.STORYMAP_MCP_TOKEN;
    else process.env.STORYMAP_MCP_TOKEN = prev;
    if (prevStateDir === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
    else process.env.STORYMAP_RUNNER_STATE_DIR = prevStateDir;
    // DEPOIS dos flushes: rastro de auth, registro de handles e ledger da fila ainda escrevem aqui.
    rmSync(stateDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    // Deixa a cadeia de persists da fila drenar antes da varredura final.
    await new Promise((r) => setTimeout(r, 0));
    for (const d of dirsDoArquivo.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("o fixture atende o piso de força do validador (senão a suíte inteira viraria 401 muda)", () => {
    // Âncora anti-cegueira: com um `expected` fraco a rota fail-closed devolve 401 em TODOS os
    // casos e os asserts de 400/200 abaixo deixariam de exercitar a rota sem ninguém notar.
    expect(isStrongSecret(TOKEN)).toBe(true);
  });

  it("401 on a wrong or absent secret (fail-closed)", async () => {
    expect((await POST(req("wrong", { board: "acme", cardId: "c1", trigger: "harness-qa", passed: true }))).status).toBe(401);
    expect((await POST(req("", { board: "acme", cardId: "c1", trigger: "harness-qa", passed: true }))).status).toBe(401);
  });

  it("400 when required fields are missing / invalid", async () => {
    expect((await POST(req(TOKEN, { board: "acme", cardId: "c1" }))).status).toBe(400); // no trigger/passed
    expect((await POST(req(TOKEN, { board: "acme", cardId: "c1", trigger: "harness-qa" }))).status).toBe(400); // no passed
    expect((await POST(req(TOKEN, { board: "acme", cardId: "c1", trigger: "harness-qa", status: "weird" }))).status).toBe(400);
  });

  it("400 on an invalid JSON body", async () => {
    const bad = new Request(`http://localhost/api/runner/test-webhook?secret=${TOKEN}`, { method: "POST", body: "{not json" });
    expect((await POST(bad)).status).toBe(400);
  });

  it("400 when a field is not a slug (never reaches the cascade / a shell)", async () => {
    const res = await POST(req(TOKEN, { board: "acme", cardId: "../../evil", trigger: "harness-qa", passed: true }));
    expect(res.status).toBe(400);
  });

  it("passed=true acks with action:resumed-pass", async () => {
    const res = await POST(req(TOKEN, { board: "nao-existe-xyz-test", cardId: "card-x", trigger: "harness-qa", passed: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "resumed-pass" });
  });

  it("accepts status:failed as the string form and acks resumed-fail", async () => {
    const res = await POST(req(TOKEN, { board: "nao-existe-xyz-test", cardId: "card-y", trigger: "harness-qa", status: "failed" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "resumed-fail" });
  });

  // ── story-h8tmzh / story-m9jflb: a credencial sai da URL, e a recusa deixa de ser cega ──────────

  it("CAPACIDADE NOVA: `Authorization: Bearer` retoma a cascata — a credencial sai da URL", async () => {
    const res = await POST(reqBearer(TOKEN, DONE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "resumed-pass" });
  });

  it("COMPATIBILIDADE: `?secret=` continua funcionando e ANUNCIA a depreciação uma vez, sem o valor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await POST(req(TOKEN, DONE))).status).toBe(200);
      expect((await POST(req(TOKEN, DONE))).status).toBe(200);
      const depreciacao = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("DEPRECADO"));
      expect(depreciacao).toHaveLength(1);
      expect(depreciacao[0]).toContain("/api/runner/test-webhook");
      expect(depreciacao[0]).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it("ESCALADA: um handle `ro` não retoma a cascata — esta rota MUTA, então exige `orch`", async () => {
    // Retomar a cascata dispara o próximo passo do pipeline (spawn de agente, deploy). Um handle de
    // LEITURA vazado num log de proxy não pode virar controle disso.
    const leitura = await createMcpHandle({ level: "ro", label: "monitor" });
    expect((await POST(reqBearer(leitura.handle, DONE))).status).toBe(401);

    const ci = await createMcpHandle({ level: "orch", label: "CI de testes" });
    expect((await POST(reqBearer(ci.handle, DONE))).status).toBe(200);
  });

  it("RASTRO: a recusa nos DOIS carregadores deixa linha durável, e nenhuma delas traz o segredo", async () => {
    // O defeito original: 401 mudo com `journalctl` dizendo `-- No entries --` no mesmo minuto.
    const tentado = "credencial-de-ataque-no-test-webhook";
    expect((await POST(req(tentado, DONE))).status).toBe(401);
    expect((await POST(reqBearer(tentado, DONE))).status).toBe(401);
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    expect(linhas.map((l) => l.via)).toEqual(["query", "header"]);
    expect(linhas.every((l) => l.surface === "/api/runner/test-webhook")).toBe(true);
    expect(linhas.every((l) => l.reason === "desconhecida")).toBe(true);
    expect(await readFile(authFailuresPath(), "utf8")).not.toContain(tentado);
  });
});
