import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dump } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throwForMissingRequestStore } from "next/dist/server/app-render/work-unit-async-storage.external.js";

// A AUTONOMIA DO BOARD tem UM escritor: setBoardAutonomyAction, só com a sessão do OPERADOR no navegador. Grava numa só
// escrita o perfil (`autonomy.agentDecides`) e as chaves que os leitores de antes consultam, coerentes; é idempotente;
// a matriz passa pelo lint. Um agente pelo MCP (mesmo com o token `full`) é recusado, e nenhuma tool MCP chama a action
// (a tool `board_autonomy` só lê). Alvo temporário real, com o `_base` da ferramenta; fixtures da livraria de demonstração.

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
const tick = vi.fn(async () => undefined);
vi.mock("@/lib/storymap/runner/orchestrator-run", () => ({ runBoardTickNow: (...a: unknown[]) => tick(...(a as [])) }));

import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { SESSION_SECRET_ENV, TOKEN_ENV } from "@/lib/auth/env";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";
import { readBoardConfig } from "@/lib/storymap/repo";
import { findRepoRoot, resetRepoRootCache } from "@/lib/storymap/paths";
import { parseSystemDecisionLines, resetSystemDecisionSink, setSystemDecisionSink } from "@/lib/storymap/runner/decision-log";
import { MAXIMA_PROFILE, MINIMA_PROFILE } from "@/lib/storymap/autonomy-profile";
import { getBoardAutonomyAction, setBoardAutonomyAction } from "@/app/board-autonomy-actions";
import { updateBoardConfigAction } from "@/app/actions";

const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
let root: string;
let state: string;
let prevTarget: string | undefined;
let prevState: string | undefined;
let decisionLines: string[] = [];
const yamlPath = () => path.join(root, "storymap", "boards", "livraria", "board.yaml");

beforeEach(() => {
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  process.env[TOKEN_ENV] = OPERATOR_TOKEN;
  root = mkdtempSync(path.join(os.tmpdir(), "ah-autonomy-action-"));
  writeFileSync(path.join(root, "turbo.json"), "{}\n");
  cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
  mkdirSync(path.join(root, "storymap", "boards", "livraria", "cards"), { recursive: true });
  writeFileSync(yamlPath(), dump({ id: "livraria", name: "Livraria", brandbook: "docs/marca.md", autonomy: { mode: "ultra" } }));
  state = mkdtempSync(path.join(os.tmpdir(), "ah-autonomy-action-state-"));
  prevTarget = process.env.AGILEHARNESS_TARGET;
  prevState = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
  process.env.AGILEHARNESS_TARGET = root;
  process.env.AGILEHARNESS_RUNNER_STATE_DIR = state;
  resetRepoRootCache();
  tick.mockClear();
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
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("setBoardAutonomyAction — o escritor único da autonomia", () => {
  it("lê o legado antes da primeira escrita: o board `ultra` é Personalizada, com o perfil derivado", async () => {
    await operatorCookie();
    const r = await getBoardAutonomyAction("livraria");
    expect(r).toMatchObject({ ok: true, data: { explicit: false, preset: "personalizada", profile: { spec: true, design: true, delivery: true, publish: false } } });
    if (r.ok) {
      expect(r.data.boxes.find((b) => b.key === "deploy")?.blockedBy).toMatch(/Publicar/);
      expect(r.data.alwaysOwner.map((p) => p.id)).toEqual(expect.arrayContaining(["money", "locked-exec"]));
    }
  });

  it("Máxima grava o perfil E as chaves coerentes numa escrita (o resto do board.yaml fica), registra e acorda o Jido", async () => {
    await operatorCookie();
    const r = await setBoardAutonomyAction({ boardId: "livraria", preset: "maxima" });
    expect(r).toMatchObject({ ok: true, data: { preset: "maxima", changed: true, receipt: expect.stringContaining("Autonomia: Máxima") } });
    const cfg = await readBoardConfig("livraria");
    expect(cfg.autonomy?.agentDecides).toEqual({ ...MAXIMA_PROFILE });
    expect(cfg.autonomy?.mode).toBe("ultra");
    expect(cfg.release?.mode).toBe("auto");
    expect(cfg.orchestrator?.mode).toBe("autonomous");
    expect(cfg.orchestrator?.riskMatrix?.deploy).toBe("auto");
    expect(cfg.orchestrator?.riskMatrix?.["run-free"]).not.toBe("auto"); // a trava do núcleo não se mexe
    expect(readFileSync(yamlPath(), "utf8")).toContain("brandbook: docs/marca.md");
    await flush();
    expect(tick).toHaveBeenCalledTimes(1);
    const decisions = parseSystemDecisionLines(decisionLines.join(""), { board: "livraria" });
    expect(decisions.some((d) => d.kind === "board-mode" && d.agent === "human" && /Autonomia: Máxima/.test(d.what))).toBe(true);
  });

  it("uma caixa: liga as pré-requisito, devolve a foto de antes (desfazer) e o recibo diz o efeito", async () => {
    await operatorCookie();
    await setBoardAutonomyAction({ boardId: "livraria", preset: "minima" });
    const before = readFileSync(yamlPath(), "utf8");
    const r = await setBoardAutonomyAction({ boardId: "livraria", patch: { publish: true } });
    expect(r).toMatchObject({ ok: true, data: { preset: "personalizada", previous: { ...MINIMA_PROFILE } } });
    if (!r.ok || !r.data.undo) throw new Error("sem desfazer");
    expect(r.data.receipt).toMatch(/agora os agentes publicam sozinhos/);
    expect((await readBoardConfig("livraria")).autonomy?.agentDecides).toMatchObject({ delivery: true, publish: true, deploy: false });
    // desfazer = devolver a foto: o arquivo volta byte a byte
    const undo = await setBoardAutonomyAction({ boardId: "livraria", restore: r.data.undo });
    expect(undo).toMatchObject({ ok: true, data: { preset: "minima", changed: true } });
    expect(readFileSync(yamlPath(), "utf8")).toBe(before);
  });

  it("DESFAZER num board legado incoerente nunca dá MAIS autonomia: publicar sem entrega, liga o Jido, desfaz ⇒ igual a antes", async () => {
    await operatorCookie();
    writeFileSync(yamlPath(), dump({ id: "livraria", name: "Livraria", autonomy: { mode: "human" }, release: { mode: "auto" } }));
    const before = await readBoardConfig("livraria");
    const tickOn = await setBoardAutonomyAction({ boardId: "livraria", patch: { copilot: true } });
    if (!tickOn.ok || !tickOn.data.undo) throw new Error("sem desfazer");
    // a caixa mexida e SÓ ela: publicar segue ligado, a entrega segue desligada (o conflito é mostrado, não corrigido)
    expect(tickOn.data.profile).toMatchObject({ copilot: true, publish: true, delivery: false, deploy: false });
    expect(tickOn.data.conflicts).toEqual([expect.stringMatching(/Publicar/)]);
    expect(tickOn.data.receipt).toBe("Autonomia: Personalizada — agora o Jido destrava o board sozinho");
    const mid = await readBoardConfig("livraria");
    expect(mid.release?.mode).toBe("auto");
    expect(mid.autonomy?.mode).toBe("human");
    const undone = await setBoardAutonomyAction({ boardId: "livraria", restore: tickOn.data.undo });
    expect(undone).toMatchObject({ ok: true, data: { profile: { delivery: false, publish: true, copilot: false } } });
    const after = await readBoardConfig("livraria");
    expect({ autonomy: after.autonomy, release: after.release, orchestrator: after.orchestrator }).toEqual({
      autonomy: before.autonomy,
      release: before.release,
      orchestrator: before.orchestrator,
    });
  });

  it("o desfazer recusa quando a autonomia mudou de novo depois (não apaga a outra mudança)", async () => {
    await operatorCookie();
    const first = await setBoardAutonomyAction({ boardId: "livraria", patch: { design: false } });
    if (!first.ok || !first.data.undo) throw new Error("sem desfazer");
    await setBoardAutonomyAction({ boardId: "livraria", patch: { spendRaise: false } });
    const r = await setBoardAutonomyAction({ boardId: "livraria", restore: first.data.undo });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("mudou depois") });
    expect((await readBoardConfig("livraria")).autonomy?.agentDecides).toMatchObject({ design: false, spendRaise: false });
  });

  it("a matriz de risco do board sobrevive a uma caixa alheia", async () => {
    await operatorCookie();
    writeFileSync(yamlPath(), dump({ id: "livraria", name: "Livraria", orchestrator: { mode: "autonomous", riskMatrix: { "write-board": "ask", run: "never" } } }));
    const r = await setBoardAutonomyAction({ boardId: "livraria", patch: { spendRaise: false } });
    expect(r).toMatchObject({ ok: true });
    expect((await readBoardConfig("livraria")).orchestrator?.riskMatrix).toMatchObject({ "write-board": "ask", run: "never" });
  });

  it("idempotente: a mesma mudança de novo não regrava o board.yaml", async () => {
    await operatorCookie();
    await setBoardAutonomyAction({ boardId: "livraria", preset: "minima" });
    const before = statSync(yamlPath()).mtimeMs;
    const again = readFileSync(yamlPath(), "utf8");
    const r = await setBoardAutonomyAction({ boardId: "livraria", preset: "minima" });
    expect(r).toMatchObject({ ok: true, data: { changed: false, receipt: expect.stringContaining("nada mudou") } });
    expect(statSync(yamlPath()).mtimeMs).toBe(before);
    expect(readFileSync(yamlPath(), "utf8")).toBe(again);
  });

  it("uma matriz que reprova no lint não é gravada (a escrita nunca é mais frouxa que o lint)", async () => {
    await operatorCookie();
    writeFileSync(yamlPath(), dump({ id: "livraria", name: "Livraria", orchestrator: { mode: "off", riskMatrix: { destructive: "auto" } } }));
    // Mínima mantém a matriz do board (o copiloto desligado não a reescreve) — e ela reprova
    const r = await setBoardAutonomyAction({ boardId: "livraria", preset: "minima" });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("destructive") });
    expect((await readBoardConfig("livraria")).autonomy?.agentDecides).toBeUndefined();
  });

  it("um agente pelo MCP — mesmo com o token FULL — é recusado e o arquivo não muda", async () => {
    cookieJar = {};
    const before = readFileSync(yamlPath(), "utf8");
    const r = await runWithMcpActor({ level: "full" }, () => setBoardAutonomyAction({ boardId: "livraria", preset: "maxima" }));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("operador") });
    expect(readFileSync(yamlPath(), "utf8")).toBe(before);
  });

  it("a porta genérica de salvar a config também recusa um agente que muda a autonomia", async () => {
    cookieJar = {};
    const cfg = await readBoardConfig("livraria");
    const r = await runWithMcpActor({ level: "full" }, () =>
      updateBoardConfigAction({ boardId: "livraria", config: { ...cfg, autonomy: { ...cfg.autonomy, agentDecides: { deploy: true, publish: true, delivery: true } } } }),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Autonomia") });
    expect((await readBoardConfig("livraria")).autonomy?.agentDecides).toBeUndefined();
  });

  it("sem sessão o guard recusa antes de tudo", async () => {
    cookieJar = {};
    await expect(setBoardAutonomyAction({ boardId: "livraria", preset: "maxima" })).rejects.toThrow();
  });
});

describe("por construção: nenhuma tool MCP escreve a autonomia", () => {
  it("nenhum arquivo das tools MCP chama setBoardAutonomyAction; a tool `board_autonomy` é só leitura", () => {
    const mcpDir = path.join(__dirname, "..", "lib", "storymap", "mcp");
    const files = readdirSync(mcpDir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.filter((f) => readFileSync(path.join(mcpDir, f), "utf8").includes("setBoardAutonomyAction"))).toEqual([]);
    expect(readFileSync(path.join(mcpDir, "register.ts"), "utf8")).toMatch(/board_autonomy: RO,/);
  });
});
