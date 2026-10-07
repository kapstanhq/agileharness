// O board «só organização» (organize-only.ts): o portão o vê com e sem a configuração em mãos, a configuração o lê e o
// grava, cada ator automático o respeita, e uma CATRACA prova que todo ator que percorre os boards consulta o modo —
// direto ou pelo portão — para um ator novo não nascer agindo num board desses.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dump } from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORGANIZE_ONLY_WHY, isOrganizeOnly, organizeOnlyNow, organizeOnlyOf } from "./organize-only";
import { configOnlyGate, resolveBoardGate } from "./runner/board-pace";
import { boardGateNow, paceAllowsBackground } from "./runner/board-pace-store";
import { paceRunningFace, paceStatusLine, ORGANIZE_ONLY_SEAL } from "./board-pace-words";
import { deriveBoardConfigForPersist, readBaseTemplateConfig, readBoardConfig } from "./repo";
import { findRepoRoot, resetRepoRootCache } from "./paths";
import { decideRecovery, RECOVERY_ORGANIZE_ONLY_DROP_REASON } from "./runner/recovery";
import { sweepOrganizeOnlyInFlight } from "./runner/organize-only-sweep";
import { settleReleasedLiveCards } from "./runner/deploy-reconcile";
import { auditDeliveryArrival } from "@/lib/notifications/server/channels/delivery-audit-channel";
import { wakeConductor } from "./runner/conductor-pause";
import type { BoardConfig, Card } from "./types";

const NOW = Date.parse("2026-04-02T10:00:00.000Z");

describe("o predicado e o portão", () => {
  it("isOrganizeOnly só com `true` literal", () => {
    expect(isOrganizeOnly({ organizeOnly: true })).toBe(true);
    expect(isOrganizeOnly({ organizeOnly: false })).toBe(false);
    expect(isOrganizeOnly({})).toBe(false);
    expect(isOrganizeOnly(null)).toBe(false);
  });

  it("o portão segura com a fonte própria, antes do desarmado e de qualquer ritmo", () => {
    const g = resolveBoardGate({ organizeOnly: true, autorunDisabled: true }, null, NOW);
    expect(g).toMatchObject({ level: "paused", held: true, background: false, source: "organize-only", why: ORGANIZE_ONLY_WHY });
    expect(configOnlyGate({ organizeOnly: true })).toMatchObject({ held: true, source: "organize-only" });
    expect(configOnlyGate({ autorunDisabled: true }).source).toBe("disarmed");
  });

  it("as palavras do selo e do painel", () => {
    // a pílula de ritmo do Kanban (era o chip do cabeçalho, que saiu na fase 1) diz o selo, não «Pausado»
    expect(paceRunningFace({ level: "paused", source: "organize-only" }, false)).toBe("Só organização");
    const line = paceStatusLine({ level: "paused", label: "Pausado", source: "organize-only", why: ORGANIZE_ONLY_WHY, by: null, since: null, until: null }, NOW);
    expect(line.startsWith(ORGANIZE_ONLY_SEAL)).toBe(true);
    expect(ORGANIZE_ONLY_SEAL).toBe("Só organização — nada roda sozinho");
  });
});

describe("do disco: a configuração lê e grava; o portão vê o modo mesmo sem a configuração em mãos", () => {
  const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
  const tmp: string[] = [];
  let prevState: string | undefined;
  afterEach(() => {
    delete process.env.AGILEHARNESS_TARGET;
    if (prevState === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevState;
    resetRepoRootCache();
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
  });

  const target = (boards: Record<string, Record<string, unknown>>): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ah-organize-"));
    tmp.push(root);
    writeFileSync(path.join(root, "turbo.json"), "{}\n");
    cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
    for (const [id, raw] of Object.entries(boards)) {
      mkdirSync(path.join(root, "storymap", "boards", id, "cards"), { recursive: true });
      writeFileSync(path.join(root, "storymap", "boards", id, "board.yaml"), dump({ id, name: id, ...raw }));
    }
    const state = mkdtempSync(path.join(os.tmpdir(), "ah-organize-state-"));
    tmp.push(state);
    prevState = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = state;
    process.env.AGILEHARNESS_TARGET = root;
    resetRepoRootCache();
    return root;
  };

  it("readBoardConfig carrega a chave; a gravação a preserva; sem ela, nenhuma chave fantasma", async () => {
    target({ caderno: { organizeOnly: true }, oficina: {} });
    const cfg = await readBoardConfig("caderno");
    expect(cfg.organizeOnly).toBe(true);
    expect("organizeOnly" in (await readBoardConfig("oficina"))).toBe(false);
    expect((await deriveBoardConfigForPersist("caderno", cfg)).organizeOnly).toBe(true);
    expect("organizeOnly" in (await deriveBoardConfigForPersist("oficina", await readBoardConfig("oficina")))).toBe(false);
  });

  it("o portão com `{}` (copiloto, pump) e paceAllowsBackground leem o modo do disco; o cache segue o arquivo", () => {
    const root = target({ caderno: { organizeOnly: true }, oficina: {} });
    expect(organizeOnlyNow("caderno")).toBe(true);
    expect(organizeOnlyNow("oficina")).toBe(false);
    expect(organizeOnlyNow("../fora")).toBe(false);
    expect(boardGateNow("caderno", {}, NOW)).toMatchObject({ held: true, source: "organize-only" });
    expect(paceAllowsBackground("caderno", NOW)).toBe(false);
    expect(paceAllowsBackground("oficina", NOW)).toBe(true);
    // a configuração ilegível continua «ilegível» (o portão não a troca pelo disco)
    expect(boardGateNow("caderno", null, NOW).source).toBe("unreadable");
    expect(organizeOnlyOf("oficina", { organizeOnly: true })).toBe(true);
    // desligar no arquivo: o cache cai pela assinatura (mtime/tamanho)
    const file = path.join(root, "storymap", "boards", "caderno", "board.yaml");
    writeFileSync(file, dump({ id: "caderno", name: "caderno" }));
    const t = new Date(statSync(file).mtimeMs + 5000);
    utimesSync(file, t, t);
    expect(organizeOnlyNow("caderno")).toBe(false);
    expect(paceAllowsBackground("caderno", NOW)).toBe(true);
  });

  it("lê o modo como o PARSER do board: as grafias que o YAML aceita ligam; o arquivo que não se parseia segura", async () => {
    const root = target({ oficina: {} });
    const put = (id: string, text: string) => {
      mkdirSync(path.join(root, "storymap", "boards", id, "cards"), { recursive: true });
      writeFileSync(path.join(root, "storymap", "boards", id, "board.yaml"), text);
    };
    put("b-true", "id: b-true\nname: B\norganizeOnly: True\n");
    put("b-upper", "id: b-upper\nname: B\norganizeOnly: TRUE\n");
    put("b-quoted", 'id: b-quoted\nname: B\n"organizeOnly": true\n');
    put("b-tag", "id: b-tag\nname: B\norganizeOnly: !!bool true\n");
    put("b-false", "id: b-false\nname: B\norganizeOnly: false\n");
    put("b-string", 'id: b-string\nname: B\norganizeOnly: "true"\n');
    put("b-broken", "id: b-broken\nname: [B\n  organizeOnly: : :\n");
    for (const id of ["b-true", "b-upper", "b-quoted", "b-tag"]) {
      expect(organizeOnlyNow(id), id).toBe(true);
      // e concorda com o que readBoardConfig carrega
      expect((await readBoardConfig(id)).organizeOnly, id).toBe(true);
    }
    expect(organizeOnlyNow("b-false")).toBe(false);
    expect(organizeOnlyNow("b-string")).toBe(false); // string não é o booleano (o parser do board também não liga)
    expect(organizeOnlyNow("b-broken")).toBe(true); // existe e não se parseia ⇒ fail-closed
    expect(organizeOnlyNow("nao-existe")).toBe(false); // sem board.yaml: o board não existe
  });
});

describe("cada ator respeita o modo", () => {
  const config = (extra: Partial<BoardConfig> = {}): BoardConfig =>
    ({ id: "caderno", name: "Caderno", statuses: [{ id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: true }, { id: "no-ar", name: "No ar", delivered: true, terminal: true }], ...extra }) as unknown as BoardConfig;
  const card = (over: Partial<Card> = {}): Card => ({ id: "story-ex9701", type: "story", title: "Anotar a ideia", status: "desenvolver", ...over }) as Card;

  it("recovery: nada renasce num board só de organização", () => {
    const entry = { board: "caderno", cardId: "story-ex9701", trigger: "harness-do", origin: "autorun" } as never;
    expect(decideRecovery(entry, card(), config({ organizeOnly: true }))).toEqual({ action: "drop", reason: RECOVERY_ORGANIZE_ONLY_DROP_REASON });
    expect(decideRecovery(entry, card(), config()).action).toBe("respawn");
  });

  it("a varredura desliga runs e condutores em voo só nos boards do modo, e cala sem nada em voo", async () => {
    const stopRuns = vi.fn(async (b: string) => (b === "caderno" ? [{ cardId: "story-ex9701" }] : []));
    const parkConductors = vi.fn(async (b: string) => (b === "caderno" ? [{ cardId: "story-ex9702" }] : []));
    const log = vi.fn();
    const rows = await sweepOrganizeOnlyInFlight({
      boards: async () => ["caderno", "oficina"],
      readConfig: async (b) => (b === "caderno" ? { organizeOnly: true } : {}),
      stopRuns,
      parkConductors,
      log,
    });
    expect(rows).toEqual([{ board: "caderno", stopped: ["story-ex9701"], parked: ["story-ex9702"] }]);
    expect(stopRuns).toHaveBeenCalledTimes(1);
    expect(stopRuns).toHaveBeenCalledWith("caderno", ORGANIZE_ONLY_WHY);
    expect(log).toHaveBeenCalledTimes(1);
    const quiet = await sweepOrganizeOnlyInFlight({ boards: async () => ["caderno"], readConfig: async () => ({ organizeOnly: true }), stopRuns: async () => [], parkConductors: async () => [], log });
    expect(quiet).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("os runs tirados ficam RETIDOS e voltam ao pipeline quando o modo é desligado (como a pausa)", async () => {
    let held: Record<string, Array<{ cardId: string; at: string }>> = {};
    const store = { load: async () => structuredClone(held), save: async (next: typeof held) => void (held = structuredClone(next)) };
    const rearm = vi.fn(async () => {});
    let on = true;
    const deps = {
      boards: async () => ["caderno"],
      readConfig: async () => (on ? { organizeOnly: true } : {}),
      stopRuns: vi.fn(async () => (on ? [{ cardId: "story-ex9703" }] : [])),
      parkConductors: async () => [],
      held: store,
      rearm,
      now: () => NOW,
      log: () => {},
    };
    await sweepOrganizeOnlyInFlight(deps);
    expect(held.caderno?.map((e) => e.cardId)).toEqual(["story-ex9703"]);
    expect(rearm).not.toHaveBeenCalled();
    // o modo desligado (pela tela do operador): o retido volta, uma vez
    on = false;
    const rows = await sweepOrganizeOnlyInFlight(deps);
    expect(rearm).toHaveBeenCalledWith("caderno", "story-ex9703");
    expect(rows).toEqual([{ board: "caderno", stopped: [], parked: [], released: ["story-ex9703"] }]);
    expect(held.caderno).toBeUndefined();
    await sweepOrganizeOnlyInFlight(deps);
    expect(rearm).toHaveBeenCalledTimes(1);
  });

  it("config ilegível NÃO devolve o retido (na dúvida, nada roda sozinho); devolver que falha fica para a próxima", async () => {
    let held: Record<string, Array<{ cardId: string; at: string }>> = { caderno: [{ cardId: "story-ex9704", at: "x" }] };
    const store = { load: async () => structuredClone(held), save: async (next: typeof held) => void (held = structuredClone(next)) };
    const rearm = vi.fn(async () => {
      throw new Error("sem engine");
    });
    const deps = { boards: async () => ["caderno"], readConfig: async () => null, stopRuns: async () => [], parkConductors: async () => [], held: store, rearm, log: () => {} };
    await sweepOrganizeOnlyInFlight(deps);
    expect(rearm).not.toHaveBeenCalled();
    await sweepOrganizeOnlyInFlight({ ...deps, readConfig: async () => ({}) });
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(held.caderno?.map((e) => e.cardId)).toEqual(["story-ex9704"]);
  });

  it("a varredura de «Liberar» não leva card adiante", async () => {
    const write = vi.fn();
    const moved = await settleReleasedLiveCards("caderno", config({ organizeOnly: true }), [card({ status: "release" })], { write } as never);
    expect(moved).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  it("a auditoria de entrega não carimba", async () => {
    const readCard = vi.fn(async () => card({ status: "no-ar" }));
    const stamped = await auditDeliveryArrival(
      { readBoardConfig: async () => config({ organizeOnly: true }), readCard, readTransitions: async () => [], updateCardOnDisk: vi.fn() } as never,
      { type: "card.moved", boardId: "caderno", cardId: "story-ex9701", toStatus: "no-ar" } as never,
    );
    expect(stamped).toBe(false);
    expect(readCard).not.toHaveBeenCalled();
  });

  it("o condutor não é acordado nem retomado", async () => {
    const liveTmux = vi.fn(async () => new Set<string>());
    const outcome = await wakeConductor(
      { readCard: async () => card({ routing: { driver: "conductor" } } as Partial<Card>), readBoardConfig: async () => config({ organizeOnly: true }), liveTmux } as never,
      { board: "caderno", cardId: "story-ex9701", questionIds: ["q1"], by: "owner" as never },
    );
    expect(outcome).toBe("not-conducted");
    expect(liveTmux).not.toHaveBeenCalled();
  });
});

// ── a CATRACA ──────────────────────────────────────────────────────────────────────────────────────
// Todo arquivo que PERCORRE os boards (a forma de um ator automático) consulta o modo — direto (`isOrganizeOnly`,
// `organizeOnlyNow`, `organizeOnlyOf`) ou pelo portão (`gateOf`, `boardGateNow`, `paceAllowsBackground`, que o leem) —
// ou está na lista de exceções com o porquê. E os pontos únicos de agir (criar card, rodar skill, efeito de entrada,
// promover+publicar, re-drive, abrir sessão) carregam a guarda.
describe("catraca: nenhum ator automático ignora o modo", () => {
  const SRC = path.resolve(__dirname, "..", "..");
  const GUARD = /isOrganizeOnly|organizeOnlyNow|organizeOnlyOf|gateOf\(|boardGateNow\(|paceAllowsBackground\(/;
  /** Arquivos que percorrem os boards sem agir sozinhos neles — cada um com o porquê. */
  const EXCECOES: Record<string, string> = {
    "lib/storymap/runner/board-data-flush.ts": "só versiona no git o que alguém já escreveu nos cards (é a persistência da organização)",
    "lib/storymap/runner/card-intake-deps.ts": "só lê o que cada board possui para decidir a entrada; criar continua barrado no createCardAction",
    "lib/storymap/runner/proxy-deps.ts": "portas do procurador, que pergunta ao portão em proxy.ts",
    "lib/storymap/runner/review-rounds-deps.ts": "só conta a cadeia de rodadas (leitura)",
    "lib/storymap/health/health-collect.ts": "só mede; quem cria o card de saúde (health-deps.ts) pergunta ao modo",
    "lib/storymap/health/health-tool.ts": "tool de leitura",
    "lib/notifications/server/channels/trigger-runner-channel.ts": "chama a reconciliação de deploy, que pergunta ao modo dentro dela",
    "lib/storymap/runner/deploy-blocks.ts": "só lê o deploy declarado de cada board para saber qual publica cada pacote (onde mora a linha do livro); quem age é a varredura, que pergunta ao modo na reconciliação de deploy",
  };
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
  const actorFiles = [
    ...files(path.join(SRC, "lib", "storymap", "runner")),
    ...files(path.join(SRC, "lib", "storymap", "health")),
    ...files(path.join(SRC, "lib", "notifications", "server")),
    path.join(SRC, "instrumentation.ts"),
  ].filter((f) => readFileSync(f, "utf8").includes("listBoards("));

  it("a varredura não é vácua", () => {
    expect(actorFiles.length).toBeGreaterThan(15);
  });

  it("todo arquivo que percorre os boards consulta o modo (ou está nas exceções, com o porquê)", () => {
    const sem = actorFiles.map(rel).filter((r) => !EXCECOES[r] && !GUARD.test(readFileSync(path.join(SRC, r), "utf8")));
    expect(sem, "um ator novo percorre os boards sem perguntar ao portão nem ao modo — veja organize-only.ts").toEqual([]);
    // uma exceção que deixou de existir sai da lista
    for (const r of Object.keys(EXCECOES)) expect(actorFiles.map(rel), `exceção sem arquivo: ${r}`).toContain(r);
  });

  const CHOKEPOINTS: Array<[string, RegExp]> = [
    ["lib/storymap/runner/entry-effects.ts", /export async function runEntryEffect[\s\S]{0,400}organizeOnlyNow\(boardId\)/],
    ["lib/storymap/runner/entry-effects.ts", /export async function firePromoteAndDeploy[\s\S]{0,500}organizeOnlyNow\(boardId\)/],
    ["lib/storymap/runner/engine.ts", /\n {2}runSkill\([\s\S]{0,12000}organizeOnlyNow\(board\)/],
    ["lib/storymap/runner/engine.ts", /private async redrive[\s\S]{0,900}isOrganizeOnly\(config\)/],
    ["app/actions.ts", /export async function createCardAction[\s\S]{0,1600}\(input\.system \|\| caller === "in-process"\) && organizeOnlyNow\(input\.boardId\)/],
    ["app/actions.ts", /export async function commitProposalAction[\s\S]{0,5400}\(input\.system \|\| caller === "in-process"\) && organizeOnlyNow\(input\.boardId\)/],
    ["lib/storymap/mcp/dev-tools.ts", /"claude_new"[\s\S]{0,4000}organizeOnlyNow\(board\)/],
    ["lib/storymap/runner/triage-judge-deps.ts", /otherBoards:[\s\S]{0,400}isOrganizeOnly\(cfg\)/],
    ["lib/storymap/runner/fix-card-board.ts", /!isOrganizeOnly\(cfg\)/],
    ["lib/storymap/runner/deploy-reconcile.ts", /export async function reconcileBoardDeployFailures[\s\S]{0,300}organizeOnlyNow\(board\)/],
    ["lib/storymap/runner/recovery.ts", /isOrganizeOnly\(config\)/],
    ["lib/storymap/runner/deploy-reconcile.ts", /export async function settleReleasedLiveCards[^\n]*\n\s+if \(isOrganizeOnly\(config\)\) return \[\];/],
    ["lib/storymap/runner/deploy-reconcile.ts", /export async function settleDeploySuccess[\s\S]{0,1200}if \(isOrganizeOnly\(config\)\) return null;/],
  ];
  it.each(CHOKEPOINTS)("o ponto único %s carrega a guarda", (file, re) => {
    expect(readFileSync(path.join(SRC, file), "utf8")).toMatch(re);
  });
});
