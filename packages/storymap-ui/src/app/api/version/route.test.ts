// GET /api/version — a versão da ferramenta no ar, atrás de credencial. O que se prova: sem credencial nada da versão sai,
// a credencial na query NÃO vale (nem a certa — o vazamento em log é o ponto), o Bearer entrega o recibo do release e o
// estado do serviço, um build sem recibo diz o motivo em vez de inventar uma tag — e a versão dita é a que o PROCESSO
// carregou no boot, não o arquivo do disco de agora (revisão do WP6b: o recibo reescrito sem restart não pode «conferir»).

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { flushAuthFailures, readAuthFailures, resetPerimeterState } from "@/lib/auth/auth-audit";
import { createMcpHandle, flushHandleTouches } from "@/lib/auth/mcp-handle";
import { resetToolRootCache, TOOL_PACKAGE_NAME } from "@/lib/storymap/paths";
import { captureToolVersionAtBoot, resetToolVersionAtBoot } from "@/lib/storymap/tool-version";
import { resetQueryDeprecationNotice } from "../runner/perimeter";
import { GET } from "./route";

const TOKEN = createHash("sha256").update("version fixture").digest("base64url");
const RECIBO = { tag: "v0.9.26", sha: "a3f9c1e07b5d4c2e8f1a6b9d0c3e5f7a1b2c4d6e", at: "2026-10-02T03:10:00Z", prev: "v0.9.25", buildId: "Qx7bN2kLp0RmT4vW9sYc1" };

function req(headers?: Record<string, string>, query = ""): Request {
  return new Request(`http://localhost:3008/api/version${query}`, { headers });
}

const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];

/**
 * Um pacote da ferramenta descartável: o marcador do `package.json`, o `.next/BUILD_ID` do build que «roda» (por padrão o
 * do recibo) e, se `recibo`, o `dist/ah-version.json` do release.
 */
function pacote(recibo?: unknown, buildId = RECIBO.buildId): string {
  const dir = mkdtempSync(path.join(tmpdir(), "version-route-pkg-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: TOOL_PACKAGE_NAME }));
  mkdirSync(path.join(dir, ".next"));
  writeFileSync(path.join(dir, ".next", "BUILD_ID"), `${buildId}\n`);
  if (recibo !== undefined) {
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "ah-version.json"), JSON.stringify(recibo));
  }
  return dir;
}

beforeEach(() => {
  for (const k of ["AGILEHARNESS_MCP_TOKEN", "AGILEHARNESS_RUNNER_STATE_DIR", "AGILEHARNESS_TOOL_ROOT"]) saved[k] = process.env[k];
  process.env.AGILEHARNESS_MCP_TOKEN = TOKEN;
  const state = mkdtempSync(path.join(tmpdir(), "version-route-state-"));
  dirs.push(state);
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = state;
  process.env.AGILEHARNESS_TOOL_ROOT = pacote(RECIBO);
  resetToolRootCache();
  resetToolVersionAtBoot();
  resetPerimeterState();
  resetQueryDeprecationNotice();
});

afterEach(async () => {
  await flushAuthFailures();
  await flushHandleTouches();
  resetPerimeterState();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetToolRootCache();
  resetToolVersionAtBoot();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("GET /api/version — auth", () => {
  it("sem credencial e com credencial errada: 401, e nada da versão sai", async () => {
    const casos: Array<Record<string, string>> = [{}, { authorization: "Bearer nope" }];
    for (const [i, headers] of casos.entries()) {
      const res = await GET(req({ "x-forwarded-for": `198.51.100.${10 + i}`, ...headers }));
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("v0.9.26");
    }
  });

  it("a credencial na QUERY não vale — nem a certa (vazaria em log de acesso e de proxy)", async () => {
    const res = await GET(req({ "x-forwarded-for": "198.51.100.20" }, `?secret=${TOKEN}`));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Authorization: Bearer/);
    // …e recusar o carregador errado não é tentativa de adivinhar: não vai para o rastro de ataque.
    await flushAuthFailures();
    expect(await readAuthFailures()).toEqual([]);
  });

  it("recusa conta no rastro com a superfície /api/version, sem o segredo tentado", async () => {
    await GET(req({ "x-forwarded-for": "203.0.113.5", authorization: "Bearer chute-errado-bem-longo-123" }));
    await flushAuthFailures();
    const linhas = await readAuthFailures();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ surface: "/api/version", via: "header" });
    expect(JSON.stringify(linhas)).not.toContain("chute-errado-bem-longo-123");
  });

  it("um handle de LEITURA (`ro`) basta — é o que o release e um monitor usam, sem o token do operador", async () => {
    const { handle } = await createMcpHandle({ level: "ro", label: "release" });
    expect((await GET(req({ authorization: `Bearer ${handle}` }))).status).toBe(200);
  });
});

describe("GET /api/version — o que entrega", () => {
  it("com Bearer: o recibo do release ({tag, sha, at, prev}) e o estado do serviço", async () => {
    const res = await GET(req({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: boolean; tag: string; sha: string; at: string; prev: string; reason: string | null; service: { startedAt: string; uptimeSec: number; health: unknown } };
    expect(body).toMatchObject({ ok: true, ...RECIBO, reason: null, pendingRestart: null });
    expect(Number.isFinite(Date.parse(body.service.startedAt))).toBe(true);
    expect(body.service.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(body.service.health).toBeNull(); // nenhuma leitura gravada ainda neste estado descartável
  });

  it("traz o resumo da ÚLTIMA leitura de saúde gravada (lida do fim do ledger, sem medir)", async () => {
    const rec = { v: 1, at: "2026-10-02T03:25:00.000Z", signals: { S1: { value: 2, level: "amber" }, S6: { value: 5, level: "red" }, S3: { value: 0, level: "ok" } } };
    writeFileSync(path.join(process.env.AGILEHARNESS_RUNNER_STATE_DIR!, "health.jsonl"), `${JSON.stringify(rec)}\n`);
    const body = (await (await GET(req({ authorization: `Bearer ${TOKEN}` }))).json()) as { service: { health: unknown } };
    expect(body.service.health).toEqual({ at: rec.at, worst: "red", red: ["S6"], amber: ["S1"] });
  });

  it("build SEM recibo (dev, manual): tag nula e o motivo — nunca um número inventado", async () => {
    process.env.AGILEHARNESS_TOOL_ROOT = pacote(); // sem dist/ah-version.json
    resetToolRootCache();
    const body = (await (await GET(req({ authorization: `Bearer ${TOKEN}` }))).json()) as { ok: boolean; tag: string | null; reason: string };
    expect(body).toMatchObject({ ok: true, tag: null });
    expect(body.reason).toMatch(/não passou por contrib\/ah-release/);
  });
});

describe("GET /api/version — a versão do PROCESSO, não a do disco (defeito 1 da revisão do WP6b)", () => {
  const NOVO = { tag: "v0.9.27", sha: "b4e0d2f18c6e5d3f9a2b7c0e1d4f6a8b2c3d5e7f", at: "2026-10-02T04:00:00Z", prev: "v0.9.26", buildId: "Zz9aA8bB7cC6dD5eE4fF3" };

  it("o recibo reescrito DEPOIS do boot (swap sem restart) não muda a tag: a do boot segue, e a nova vem como restart pendente", async () => {
    // O release grava v0.9.27 no swap e é morto antes do restart: o processo v0.9.26 segue no ar. A rota tem de dizer
    // v0.9.26 — é isso que faz a reexecução do ah-release sair 7 («restart pendente») em vez de 0 «conferido».
    const dir = process.env.AGILEHARNESS_TOOL_ROOT!;
    captureToolVersionAtBoot(); // o que o register() faz no boot
    writeFileSync(path.join(dir, "dist", "ah-version.json"), JSON.stringify(NOVO));
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), `${NOVO.buildId}\n`);

    const body = (await (await GET(req({ authorization: `Bearer ${TOKEN}` }))).json()) as { tag: string; sha: string; reason: string | null; pendingRestart: unknown };
    expect(body).toMatchObject({ tag: "v0.9.26", sha: RECIBO.sha, reason: null });
    expect(body.pendingRestart).toEqual({ tag: "v0.9.27", sha: NOVO.sha, at: NOVO.at });
  });

  it("build trocado fora do release (self-deploy, swap manual): o recibo ficou mas não é o do build — tag nula e o motivo", async () => {
    process.env.AGILEHARNESS_TOOL_ROOT = pacote(RECIBO, "BuildDoSelfDeploy");
    resetToolRootCache();
    const body = (await (await GET(req({ authorization: `Bearer ${TOKEN}` }))).json()) as { tag: string | null; reason: string };
    expect(body.tag).toBeNull();
    expect(body.reason).toMatch(/não é o do recibo v0\.9\.26/);
  });
});
