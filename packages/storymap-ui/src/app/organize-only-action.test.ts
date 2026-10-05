import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dump } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// O modo «só organização» é chave de GOVERNANÇA: só o OPERADOR, com a sessão no navegador, liga e desliga — pelo botão
// do painel do ritmo (setOrganizeOnlyAction). Um agente pelo MCP (mesmo com o token `full`) e o próprio serviço fora de
// request são recusados; sem sessão o guard recusa antes de tudo. E, por construção: nenhuma tool MCP chama a action.

const SESSION_SECRET = "sessao-secreta-de-teste-com-mais-de-32-chars";
const OPERATOR_TOKEN = "token-do-operador-de-teste-com-mais-de-32-chars";
let cookieJar: Record<string, string> | null = null;

vi.mock("next/headers", () => ({
  cookies: () => {
    if (!cookieJar) throwForMissingRequestStore("cookies");
    const jar = cookieJar!;
    return { get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined) };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// a varredura do clique é do tick de recuperação (testada em organize-only.test.ts): aqui só conta que foi disparada
const sweep = vi.fn(async () => []);
vi.mock("@/lib/storymap/runner/organize-only-sweep", () => ({
  sweepOrganizeOnlyInFlight: (...a: unknown[]) => sweep(...(a as [])),
  defaultOrganizeOnlySweepDeps: async () => ({}),
}));

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { readBoardConfig } from "@/lib/storymap/repo";
import { findRepoRoot, resetRepoRootCache } from "@/lib/storymap/paths";
import { parseSystemDecisionLines, resetSystemDecisionSink, setSystemDecisionSink } from "@/lib/storymap/runner/decision-log";
import { setOrganizeOnlyAction } from "@/app/board-pace-actions";

const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
let root: string;
let state: string;
let prevTarget: string | undefined;
let prevState: string | undefined;
let decisionLines: string[] = [];

beforeEach(() => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  root = mkdtempSync(path.join(os.tmpdir(), "ah-organize-action-"));
  writeFileSync(path.join(root, "turbo.json"), "{}\n");
  cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
  mkdirSync(path.join(root, "storymap", "boards", "caderno", "cards"), { recursive: true });
  writeFileSync(path.join(root, "storymap", "boards", "caderno", "board.yaml"), dump({ id: "caderno", name: "Caderno", brandbook: "docs/marca.md" }));
  state = mkdtempSync(path.join(os.tmpdir(), "ah-organize-action-state-"));
  prevTarget = process.env.AGILEHARNESS_TARGET;
  prevState = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  process.env.AGILEHARNESS_TARGET = root;
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = state;
  resetRepoRootCache();
  sweep.mockClear();
  cookieJar = null;
  decisionLines = [];
  setSystemDecisionSink({ append: async (line) => void decisionLines.push(line) });
});
afterEach(() => {
  resetSystemDecisionSink();
  if (prevTarget === undefined) delete process.env.AGILEHARNESS_TARGET;
  else process.env.AGILEHARNESS_TARGET = prevTarget;
  if (prevState === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevState;
  resetRepoRootCache();
  rmSync(root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

async function operatorCookie(): Promise<void> {
  cookieJar = { [SESSION_COOKIE]: await signSession({ sessionSecret: SESSION_SECRET, operatorToken: OPERATOR_TOKEN }) };
}
const boardYaml = () => readFileSync(path.join(root, "storymap", "boards", "caderno", "board.yaml"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("setOrganizeOnlyAction — só o operador liga e desliga o modo «só organização»", () => {
  it("o OPERADOR liga: grava no board.yaml (o resto fica), lê de volta, dispara a varredura e registra no Acompanhar", async () => {
    await operatorCookie();
    const r = await setOrganizeOnlyAction({ boardId: "caderno", on: true });
    expect(r).toMatchObject({ ok: true });
    expect((await readBoardConfig("caderno")).organizeOnly).toBe(true);
    expect(boardYaml()).toContain("brandbook: docs/marca.md");
    if (r.ok) expect(r.data.pace.source).toBe("organize-only");
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);
    const decisions = parseSystemDecisionLines(decisionLines.join(""), { board: "caderno" });
    expect(decisions.some((d) => d.kind === "board-mode" && d.agent === "human" && /só de organização/.test(d.what))).toBe(true);
  });

  it("o OPERADOR desliga: a chave sai do arquivo (sem chave fantasma) e a varredura devolve o retido", async () => {
    await operatorCookie();
    await setOrganizeOnlyAction({ boardId: "caderno", on: true });
    await flush();
    sweep.mockClear();
    const r = await setOrganizeOnlyAction({ boardId: "caderno", on: false });
    expect(r).toMatchObject({ ok: true });
    expect("organizeOnly" in (await readBoardConfig("caderno"))).toBe(false);
    expect(boardYaml()).not.toContain("organizeOnly");
    await flush();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("pedir o estado em que o board já está não regrava nem dispara nada", async () => {
    await operatorCookie();
    const before = statSync(path.join(root, "storymap", "boards", "caderno", "board.yaml")).mtimeMs;
    const r = await setOrganizeOnlyAction({ boardId: "caderno", on: false });
    expect(r).toMatchObject({ ok: true, data: { message: expect.stringContaining("já") } });
    expect(statSync(path.join(root, "storymap", "boards", "caderno", "board.yaml")).mtimeMs).toBe(before);
    await flush();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("um agente pelo MCP — mesmo com o token FULL — é recusado e o arquivo não muda", async () => {
    cookieJar = {}; // request MCP: sem cookie
    const r = await runWithMcpActor({ level: "full" }, () => setOrganizeOnlyAction({ boardId: "caderno", on: true }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("operador") });
    expect("organizeOnly" in (await readBoardConfig("caderno"))).toBe(false);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("o próprio serviço, fora de request, é recusado", async () => {
    cookieJar = null; // sem request: o guard só deixa passar o processo interno, e a action o recusa
    const r = await setOrganizeOnlyAction({ boardId: "caderno", on: true }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    expect(r.ok).toBe(false);
    expect("organizeOnly" in (await readBoardConfig("caderno"))).toBe(false);
  });

  it("sem sessão (request de navegador sem cookie) o guard recusa antes de tudo", async () => {
    cookieJar = {};
    await expect(setOrganizeOnlyAction({ boardId: "caderno", on: true })).rejects.toThrow();
    expect("organizeOnly" in (await readBoardConfig("caderno"))).toBe(false);
  });
});

describe("por construção: a única porta é a action do operador", () => {
  it("nenhum arquivo das tools MCP chama setOrganizeOnlyAction", () => {
    const mcpDir = path.join(__dirname, "..", "lib", "storymap", "mcp");
    const files = readdirSync(mcpDir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    const hits = files.filter((f) => readFileSync(path.join(mcpDir, f), "utf8").includes("setOrganizeOnlyAction"));
    expect(hits).toEqual([]);
  });

  it("o painel do ritmo oferece o botão nos dois sentidos, com confirmação, e chama a action do operador", () => {
    const src = readFileSync(path.join(__dirname, "..", "components", "nav", "BoardPaceChip.tsx"), "utf8");
    expect(src).toContain("setOrganizeOnlyAction({ boardId, on })");
    expect(src).toMatch(/window\.confirm\(on \? ORGANIZE_ONLY_CONFIRM_ON : ORGANIZE_ONLY_CONFIRM_OFF\)/);
    expect(src).toMatch(/organize \? ORGANIZE_ONLY_TURN_OFF : ORGANIZE_ONLY_TURN_ON/);
  });
});
