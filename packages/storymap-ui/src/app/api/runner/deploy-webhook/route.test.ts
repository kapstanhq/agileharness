import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST } from "./route";
import { isStrongSecret } from "@/lib/storymap/mcp/auth";
import {
  PERIMETER_POLICY,
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
const TOKEN = createHash("sha256").update("deploy-webhook fixture").digest("base64url");

function req(secret: string, body: unknown): Request {
  return new Request(`http://localhost/api/runner/deploy-webhook?secret=${secret}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
/** O caminho PREFERIDO: a credencial no header, fora da URL (e fora de todo log de proxy). */
function reqBearer(token: string, body: unknown, extra?: Record<string, string>): Request {
  return new Request(`http://localhost/api/runner/deploy-webhook`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra },
  });
}

const SETTLE = { v: 1, board: "acme", cardId: "c1", status: "ok" } as const;

describe("POST /api/runner/deploy-webhook (G1 — durable deploy callback)", () => {
  let prev: string | undefined;
  let prevStateDir: string | undefined;
  let stateDir = "";
  beforeEach(() => {
    prev = process.env.STORYMAP_MCP_TOKEN;
    process.env.STORYMAP_MCP_TOKEN = TOKEN;
    // Rastro de auth + registro de handles em dir de teste: o forense do serviço vivo não é lugar de
    // linha de teste.
    prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
    stateDir = mkdtempSync(path.join(tmpdir(), "deploy-webhook-auth-"));
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
    // DEPOIS dos flushes: rastro de auth e registro de handles ainda escrevem aqui.
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("o fixture atende o piso de força do validador (senão a suíte inteira viraria 401 muda)", () => {
    // Âncora anti-cegueira: com um `expected` fraco a rota fail-closed devolve 401 em TODOS os
    // casos e os asserts de 400/200/202 abaixo deixariam de exercitar a rota sem ninguém notar.
    expect(isStrongSecret(TOKEN)).toBe(true);
  });

  it("401 on a wrong or absent secret (fail-closed)", async () => {
    expect((await POST(req("wrong", { board: "acme", cardId: "c1", status: "failed" }))).status).toBe(401);
    expect((await POST(req("", { board: "acme", cardId: "c1", status: "failed" }))).status).toBe(401);
  });

  it("400 when required fields (board/cardId/status) are missing", async () => {
    expect((await POST(req(TOKEN, { board: "acme" }))).status).toBe(400);
    expect((await POST(req(TOKEN, { board: "acme", cardId: "c1", status: "weird" }))).status).toBe(400);
  });

  it("400 on an invalid JSON body", async () => {
    const bad = new Request(`http://localhost/api/runner/deploy-webhook?secret=${TOKEN}`, { method: "POST", body: "{not json" });
    expect((await POST(bad)).status).toBe(400);
  });

  it("status=ok roda o settle de sucesso (prova → carimbo → terminal) e acka; card inexistente é no-op seguro", async () => {
    // deploy-truth WS-3: o ramo ok virou settleDeploySuccess (mede prova, resolve finding, avança gatado).
    // best-effort: card inexistente → o settle loga e não toca nada; o ACK segue 200.
    const res = await POST(req(TOKEN, { board: "acme", cardId: "c1", status: "ok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "settled" });
  });

  it("status=failed acks with action:reverted (revert is best-effort; an absent board is a safe no-op)", async () => {
    // A board that doesn't exist on disk → revertCardOnDeployFailure logs + returns WITHOUT touching any
    // real card (readBoardConfig throws → null → skipped). The route ACKs regardless.
    const res = await POST(req(TOKEN, { board: "nao-existe-xyz-test", cardId: "card-x", status: "failed", pkg: "acmeapp", exitCode: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "reverted" });
  });

  it("WS1.1 — ignora payload de versão desconhecida (v!=1) com 202 (drift-guard script-velho↔route-nova)", async () => {
    const res = await POST(req(TOKEN, { v: 2, board: "acme", cardId: "c1", status: "ok" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, action: "ignored-unknown-version" });
  });

  it("WS1.1 — failed self-deploy com logTailB64 → 200 reverted (o decode não quebra; board inexistente = no-op seguro)", async () => {
    const logTailB64 = Buffer.from('erro: build falhou\n"aspas" e \\barras\\').toString("base64");
    const res = await POST(req(TOKEN, { v: 1, board: "nao-existe-xyz", cardId: "c-x", status: "failed", phase: "self-deploy", logTailB64 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "reverted" });
  });

  it("WS1.1 — payload SEM v (caller legado/in-process) é tratado como v1 (não é ignorado)", async () => {
    const res = await POST(req(TOKEN, { board: "acme", cardId: "c1", status: "ok" }));
    expect(res.status).toBe(200); // não 202
    expect(await res.json()).toEqual({ ok: true, action: "settled" });
  });

  // ── story-h8tmzh / story-m9jflb: a credencial sai da URL, e a recusa deixa de ser cega ──────────

  it("CAPACIDADE NOVA: `Authorization: Bearer` autentica o settle — a credencial sai da URL", async () => {
    // O que isto fecha: o `curl` do self-deploy POSTa aqui com o token na QUERY, e query string é
    // gravada por todo intermediário (medido: 174 gravações do token pelo logger de erro default do
    // Caddy). Com o header, o que o proxy registra não contém credencial.
    const res = await POST(reqBearer(TOKEN, SETTLE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "settled" });
  });

  it("COMPATIBILIDADE: `?secret=` continua funcionando e ANUNCIA a depreciação uma vez, sem o valor", async () => {
    // Quebrar a query pararia o settle do self-deploy que está no ar hoje — remoção de capacidade.
    // O aviso é o que deixa a migração ser decisão do dono, no tempo dele.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await POST(req(TOKEN, SETTLE))).status).toBe(200);
      expect((await POST(req(TOKEN, SETTLE))).status).toBe(200);
      const depreciacao = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("DEPRECADO"));
      expect(depreciacao).toHaveLength(1);
      expect(depreciacao[0]).not.toContain(TOKEN);
    } finally {
      warn.mockRestore();
    }
  });

  it("ESCALADA: um handle `ro`/`write` NÃO dirige o deploy — só `orch` ou mais entra aqui", async () => {
    // O ataque concreto: o dono emite um handle `ro` para um monitor pollar `/pulse`; esse valor
    // aparece no log de um proxy. Se ele também abrisse ESTA rota, quem o lesse poderia reverter card
    // e mentir sobre o deploy — a rota MUTA (revert / avanço para terminal). O nível é a fronteira.
    const leitura = await createMcpHandle({ level: "ro", label: "monitor de leitura" });
    const escrita = await createMcpHandle({ level: "write", label: "escritor de board" });
    expect((await POST(reqBearer(leitura.handle, SETTLE))).status).toBe(401);
    expect((await POST(reqBearer(escrita.handle, SETTLE))).status).toBe(401);

    const orquestrador = await createMcpHandle({ level: "orch", label: "CI do deploy" });
    expect((await POST(reqBearer(orquestrador.handle, SETTLE))).status).toBe(200);
    await flushAuthFailures();

    // E o rastro NOMEIA o handle recusado + o nível exigido: sem isso o operador não sabe qual
    // credencial pediu o que não tem.
    const linhas = await readAuthFailures();
    expect(linhas.map((l) => l.handleId)).toEqual([leitura.record.id, escrita.record.id]);
    expect(linhas.every((l) => l.levelWanted === "orch")).toBe(true);
  });

  it("RASTRO + TRAVA: martelar o webhook tranca a origem (429) e nunca grava o segredo tentado", async () => {
    const atacante = { "x-forwarded-for": "198.51.100.44" };
    const tentado = "credencial-de-ataque-no-webhook-1234";
    let ultimo = 0;
    for (let i = 0; i < PERIMETER_POLICY.maxFailures; i++) {
      ultimo = (await POST(reqBearer(`${tentado}-${i}`, SETTLE, atacante))).status;
    }
    expect(ultimo).toBe(429);
    await flushAuthFailures();

    const linhas = await readAuthFailures();
    expect(linhas).toHaveLength(PERIMETER_POLICY.maxFailures);
    expect(linhas.every((l) => l.surface === "/api/runner/deploy-webhook" && l.via === "header")).toBe(true);
    expect(linhas[linhas.length - 1]!.locked).toBe(true);
    expect(await readFile(authFailuresPath(), "utf8")).not.toContain(tentado);
  });
});
