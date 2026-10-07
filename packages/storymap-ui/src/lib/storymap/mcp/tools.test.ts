import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { projectCardForGet, registerStorymapTools, slim } from "./tools";

// as server actions revalidam a página do board — fora de um request do Next não há o que revalidar.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
import { cardsDir } from "../paths";
import { FIXTURE_BOARD } from "../board-fixture";
import type { Card, Finding, Task } from "../types";

function finding(severity: Finding["severity"], status: Finding["status"], id = "f1"): Finding {
  return { id, lens: "general", severity, title: `finding ${id}`, status };
}
function task(done: boolean, id = "t1"): Task {
  return { id, title: `task ${id}`, done };
}

/** A complete-enough Card for projection tests (slim only reads a subset). */
function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "ARMAZEM-1",
    type: "story",
    title: "Card de teste",
    storyType: "user",
    status: "desenvolver",
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    findings: [],
    order: 0,
    created: null,
    updated: null,
    body: "",
    ...overrides,
  } as Card;
}

describe("slim — lean card projection", () => {
  it("carrega os campos principais e o modo (default null)", () => {
    const s = slim(card({ id: "ARMAZEM-9", title: "X", status: "pronta", storyType: "technical" }));
    expect(s).toMatchObject({
      id: "ARMAZEM-9",
      title: "X",
      status: "pronta",
      storyType: "technical",
      mode: null,
      type: "story",
    });
  });

  it("mode reflete o modo de reabertura quando setado", () => {
    expect(slim(card({ mode: "refine" })).mode).toBe("refine");
  });

  it("conta tasks done/total", () => {
    const s = slim(card({ tasks: [task(true, "t1"), task(false, "t2"), task(true, "t3")] }));
    expect(s.tasks).toEqual({ done: 2, total: 3 });
  });

  it("conta acceptance", () => {
    expect(slim(card({ acceptance: ["a", "b", "c"] })).acceptance).toBe(3);
  });

  it("conta findings abertos e blockers abertos separadamente", () => {
    const s = slim(
      card({
        findings: [
          finding("blocker", "open", "f1"),
          finding("blocker", "fixed", "f2"),
          finding("medium", "open", "f3"),
        ],
      }),
    );
    expect(s.openFindings).toBe(2); // f1 + f3 (status open)
    expect(s.blockers).toBe(1); // só f1 (open + blocker)
  });

  it("não projeta mais a priorização (rice/kano/funnelStage saíram do modelo)", () => {
    const s = slim(card({}));
    expect(s).not.toHaveProperty("rice");
    expect(s).not.toHaveProperty("kano");
    expect(s).not.toHaveProperty("funnelStage");
  });
});

// --- projectCardForGet — get_card body-cost projection (story-ex0021) ------
// get_card's default no longer re-pays the token cost of the long markdown `body` on every status
// check: verbose:false (default) drops it (keeping the structured control fields) and leaves a
// bodyOmitted/bodyChars marker; verbose:true returns the card intact (the legacy shape).
describe("projectCardForGet — omite o body pesado por padrão", () => {
  const BODY = "# Contexto\n" + "linha de histórico acumulado ".repeat(200);

  it("verbose omitido (default) → sem body, com marcador bodyOmitted + bodyChars, campos estruturados preservados", () => {
    const c = card({
      body: BODY,
      title: "T",
      status: "revisar-codigo",
      acceptance: ["a", "b"],
      findings: [finding("blocker", "open")],
    });
    const p = projectCardForGet(c) as Record<string, unknown>;
    expect("body" in p).toBe(false);
    expect(p.bodyOmitted).toBe(true);
    expect(p.bodyChars).toBe(BODY.length);
    // os campos de controle estruturados continuam presentes (é para isso que se checa o card)
    expect(p.id).toBe(c.id);
    expect(p.status).toBe("revisar-codigo");
    expect(p.title).toBe("T");
    expect(p.acceptance).toEqual(["a", "b"]);
    expect(p.findings).toEqual(c.findings);
  });

  it("verbose:false com body vazio → omite a chave e bodyChars 0", () => {
    const p = projectCardForGet(card({ body: "" }), false) as Record<string, unknown>;
    expect("body" in p).toBe(false);
    expect(p.bodyOmitted).toBe(true);
    expect(p.bodyChars).toBe(0);
  });

  it("verbose:true → card INTACTO (body presente, sem marcador — shape legado)", () => {
    const c = card({ body: BODY });
    const p = projectCardForGet(c, true) as Record<string, unknown>;
    expect(p.body).toBe(BODY);
    expect("bodyOmitted" in p).toBe(false);
    expect("bodyChars" in p).toBe(false);
    expect(p).toEqual(c);
  });
});

// --- cancel_run -----------------------------------------------------------
// cancel_run is the MCP surface over the engine's existing forceRelease (already covered in
// engine.test.ts). These tests pin the TOOL wiring: that it delegates to the singleton's
// forceRelease(board, cardId) and shapes the JSON the connector returns — active run, queued
// run and the idempotent no-op. We register the real tools onto a capturing fake server and
// stub the engine singleton (the globalThis Symbol getRunnerEngine reads), so no real `claude`
// process is ever spawned.

type ToolHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

const ENGINE_KEY = Symbol.for("storymap.runner.engine");
const engineStore = globalThis as unknown as { [ENGINE_KEY]?: unknown };

/** Register the real tools onto a fake McpServer and return the handler map by name. */
function captureHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerStorymapTools(server);
  return handlers;
}

/** Parse the JSON text a tool returns via the json() helper. */
function parseResult(r: CallToolResult): unknown {
  const text = (r.content[0] as { text: string }).text;
  return JSON.parse(text);
}

describe("cancel_run — MCP surface over engine.forceRelease", () => {
  const savedEngine = engineStore[ENGINE_KEY];
  let lastCall: { board: string; cardId: string } | null;

  /** Stub the engine singleton so forceRelease returns a fixed result and records its args. */
  function stubEngine(result: { released: boolean; note?: string }) {
    lastCall = null;
    engineStore[ENGINE_KEY] = {
      forceRelease: (board: string, cardId: string) => {
        lastCall = { board, cardId };
        return result;
      },
    };
  }

  beforeEach(() => {
    lastCall = null;
  });
  afterEach(() => {
    if (savedEngine === undefined) delete engineStore[ENGINE_KEY];
    else engineStore[ENGINE_KEY] = savedEngine;
  });

  it("registra a tool com input board+cardId", () => {
    const handlers = captureHandlers();
    expect(handlers.has("cancel_run")).toBe(true);
  });

  it("run ATIVO → released:true e ecoa board/cardId, delegando pra forceRelease", async () => {
    stubEngine({ released: true });
    const handler = captureHandlers().get("cancel_run")!;
    const out = parseResult(await handler({ board: "storymap", cardId: "story-1" }));
    expect(out).toEqual({ board: "storymap", cardId: "story-1", released: true });
    expect(lastCall).toEqual({ board: "storymap", cardId: "story-1" }); // delegou com os args certos
  });

  it("run NA FILA → released:true + nota", async () => {
    stubEngine({ released: true, note: "na fila — será cancelada quando chegar a vez" });
    const handler = captureHandlers().get("cancel_run")!;
    const out = parseResult(await handler({ board: "storymap", cardId: "story-2" })) as {
      released: boolean;
      note: string;
    };
    expect(out.released).toBe(true);
    expect(out.note).toMatch(/fila/);
  });

  it("card SEM run ativo → released:false + nota (idempotente, não é erro)", async () => {
    stubEngine({ released: false, note: "nenhuma run ativa para este card" });
    const handler = captureHandlers().get("cancel_run")!;
    const r = await handler({ board: "storymap", cardId: "ghost" });
    expect(r.isError).toBeUndefined(); // released:false NÃO marca a tool como erro
    const out = parseResult(r) as { released: boolean; note: string };
    expect(out.released).toBe(false);
    expect(out.note).toMatch(/nenhuma run/);
  });
});

// --- runner_status — telemetry history (story-ex9516) ----------
// runner_status reads two singletons: the registry (live runs/failures) and the telemetry store
// (durable per-card history). We stub BOTH via their globalThis Symbols so the tool's shaping is
// pinned without a real engine/disk. AC4: backward-compat without cardId; history with board+cardId.

const REGISTRY_KEY = Symbol.for("storymap.runner.registry");
const TELEMETRY_KEY = Symbol.for("storymap.runner.telemetry");
const MERGE_QUEUE_KEY = Symbol.for("storymap.runner.mergeQueue");
const singletonStore = globalThis as unknown as {
  [REGISTRY_KEY]?: unknown;
  [TELEMETRY_KEY]?: unknown;
  [MERGE_QUEUE_KEY]?: unknown;
};

describe("runner_status — live snapshot + telemetry history", () => {
  const savedRegistry = singletonStore[REGISTRY_KEY];
  const savedTelemetry = singletonStore[TELEMETRY_KEY];
  const savedMergeQueue = singletonStore[MERGE_QUEUE_KEY];
  let telemetryCall: { board: string; cardId: string; limit?: number } | null;

  function stubSingletons(history: unknown[]) {
    telemetryCall = null;
    singletonStore[REGISTRY_KEY] = {
      snapshot: () => ({ running: [], failures: [] }),
    };
    singletonStore[TELEMETRY_KEY] = {
      listByCard: async (board: string, cardId: string, limit?: number) => {
        telemetryCall = { board, cardId, limit };
        return history;
      },
    };
    // Front 4: runner_status now also reads the merge queue — stub it empty so the shape is pinned.
    singletonStore[MERGE_QUEUE_KEY] = {
      liveRunIds: async () => [],
      getSnapshot: () => ({ entries: [], processing: false }),
    };
  }

  afterEach(() => {
    if (savedRegistry === undefined) delete singletonStore[REGISTRY_KEY];
    else singletonStore[REGISTRY_KEY] = savedRegistry;
    if (savedTelemetry === undefined) delete singletonStore[TELEMETRY_KEY];
    else singletonStore[TELEMETRY_KEY] = savedTelemetry;
    if (savedMergeQueue === undefined) delete singletonStore[MERGE_QUEUE_KEY];
    else singletonStore[MERGE_QUEUE_KEY] = savedMergeQueue;
  });

  it("registra a tool com board/cardId/limit opcionais", () => {
    expect(captureHandlers().has("runner_status")).toBe(true);
  });

  it("SEM cardId → só running+failures (backward-compat, nenhum history)", async () => {
    stubSingletons([{ id: "r1" }]);
    const handler = captureHandlers().get("runner_status")!;
    const out = parseResult(await handler({})) as Record<string, unknown>;
    // `mainRed: null` = a main está VERDE. O campo é sempre projetado (P-8): a saúde da main deixou de
    // ser algo que só o gate sabia e ninguém reportava — e um campo que só aparece quando há problema
    // ensina o leitor a não procurá-lo.
    // `pushHold: null` / `pushScanNote: null` = nada retido e a varredura pré-push completa — sempre projetados, pela
    // mesma razão do `mainRed`.
    expect(out).toEqual({ running: [], failures: [], mergeQueue: [], mainRed: null, pushHold: null, pushScanNote: null });
    expect(out.history).toBeUndefined();
    expect(telemetryCall).toBeNull(); // telemetria nem é consultada sem cardId
  });

  it("COM board+cardId → anexa history da telemetria (limit padrão 20)", async () => {
    const runs = [{ id: "s2", costUSD: 0.1, status: "ok" }];
    stubSingletons(runs);
    const handler = captureHandlers().get("runner_status")!;
    const out = parseResult(await handler({ board: "storymap", cardId: "story-x" })) as Record<string, unknown>;
    expect(out.history).toEqual(runs);
    expect(out.running).toEqual([]);
    expect(telemetryCall).toEqual({ board: "storymap", cardId: "story-x", limit: 20 });
  });

  it("propaga o limit informado", async () => {
    stubSingletons([]);
    const handler = captureHandlers().get("runner_status")!;
    await handler({ board: "storymap", cardId: "story-x", limit: 5 });
    expect(telemetryCall).toEqual({ board: "storymap", cardId: "story-x", limit: 5 });
  });

  it("expõe a fila de merge — só entries LIVE, parked sinalizado (Front 4 observabilidade)", async () => {
    telemetryCall = null;
    singletonStore[REGISTRY_KEY] = { snapshot: () => ({ running: [], failures: [] }) };
    singletonStore[TELEMETRY_KEY] = { listByCard: async () => [] };
    singletonStore[MERGE_QUEUE_KEY] = {
      liveRunIds: async () => ["a"],
      getSnapshot: () => ({
        entries: [
          { runId: "a", board: "storymap", cardId: "story-x", branch: "run/a", status: "gate-failed", enqueuedAt: 1 },
          { runId: "b", board: "storymap", cardId: "story-y", branch: "run/b", status: "done", enqueuedAt: 2 },
        ],
        processing: false,
      }),
    };
    const handler = captureHandlers().get("runner_status")!;
    const out = parseResult(await handler({})) as { mergeQueue: Array<Record<string, unknown>> };
    // the terminal `done` entry is filtered out; the live `gate-failed` is surfaced + flagged parked
    expect(out.mergeQueue).toEqual([
      { runId: "a", board: "storymap", cardId: "story-x", branch: "run/a", status: "gate-failed", parked: true },
    ]);
  });
});

// --- enqueue / enqueue_batch ---------------------------------------------
// The enqueue tools delegate dependency-aware enqueueing to the engine (enqueueWithDeps + the
// DependencyGraph, both covered in engine.test.ts / dep-graph.test.ts). These tests pin the TOOL
// surface: registration + the request-shape VALIDATION (dup / out-of-batch dep / cycle), which the
// tool rejects BEFORE touching the engine or the board files — so they need no live card and never
// spawn a `claude`. The runner-enabled gate reads the real settings.yaml (enabled: true).

describe("enqueue / enqueue_batch — MCP enqueue surface", () => {
  it("registra ambas as tools", () => {
    const handlers = captureHandlers();
    expect(handlers.has("enqueue")).toBe(true);
    expect(handlers.has("enqueue_batch")).toBe(true);
  });

  it("enqueue_batch rejeita lista com card duplicado (sem tocar no engine)", async () => {
    const handler = captureHandlers().get("enqueue_batch")!;
    const out = await handler({ cards: [{ board: "sm", cardId: "a" }, { board: "sm", cardId: "a" }] });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/duplicado/i);
  });

  it("enqueue_batch rejeita dependência que referencia card fora do lote", async () => {
    const handler = captureHandlers().get("enqueue_batch")!;
    const out = await handler({
      cards: [{ board: "sm", cardId: "a" }, { board: "sm", cardId: "b" }],
      deps: [{ from: "sm/ghost", to: "sm/a" }],
    });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/fora do lote/i);
  });

  it("enqueue_batch rejeita um ciclo no grafo (A→B→A) com erro descritivo", async () => {
    const handler = captureHandlers().get("enqueue_batch")!;
    const out = await handler({
      cards: [{ board: "sm", cardId: "a" }, { board: "sm", cardId: "b" }],
      deps: [{ from: "sm/a", to: "sm/b" }, { from: "sm/b", to: "sm/a" }],
    });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/[Cc]iclo/);
  });
});

// --- get_card handler — verbose wiring against a REAL on-disk card (story-ex0021) ---
// Proves the handler threads `verbose` into projectCardForGet on the non-in-flight path, using the
// real readCard against a real board card (picked dynamically so the test isn't tied to one id).
// Only the engine singleton is stubbed (isInFlight:false) — the established pattern — so no real run
// machinery runs and the simple return path is taken; the projection logic under test is NOT mocked.
describe("get_card — wiring do verbose com readCard real", () => {
  const savedEngine = engineStore[ENGINE_KEY];
  afterEach(() => {
    if (savedEngine === undefined) delete engineStore[ENGINE_KEY];
    else engineStore[ENGINE_KEY] = savedEngine;
  });

  async function anyFixtureCardId(): Promise<string | null> {
    const files = await fs.readdir(cardsDir(FIXTURE_BOARD)).catch(() => [] as string[]);
    const md = files.find((f) => f.endsWith(".md"));
    return md ? md.replace(/\.md$/, "") : null;
  }

  it("verbose omitido → body ausente + bodyOmitted; verbose:true → body presente", async () => {
    const cardId = await anyFixtureCardId();
    expect(cardId, `esperava ao menos um card no board ${FIXTURE_BOARD}`).toBeTruthy();
    engineStore[ENGINE_KEY] = { isInFlight: () => false };
    const handler = captureHandlers().get("get_card")!;

    const lean = parseResult(await handler({ board: FIXTURE_BOARD, cardId: cardId! })) as Record<string, unknown>;
    expect("body" in lean).toBe(false);
    expect(lean.bodyOmitted).toBe(true);
    expect(typeof lean.bodyChars).toBe("number");
    expect(lean.id).toBe(cardId);

    const full = parseResult(
      await handler({ board: FIXTURE_BOARD, cardId: cardId!, verbose: true }),
    ) as Record<string, unknown>;
    expect(typeof full.body).toBe("string");
    expect("bodyOmitted" in full).toBe(false);
    expect(full.id).toBe(cardId);
  });
});

// --- update_card — recusa mudança de status (story-ex0056) ------------------
// update_card gravava `status` via updateCardAction, que valida o gate e dispara o autorun mas NÃO
// dispara os efeitos onEnter (promote-stage/deploy-board) que o move_card dispara — divergindo o card
// da realidade do código (card 'No ar' sem deploy real). update_card agora RECUSA status e aponta o
// move_card; os demais campos autorais seguem funcionando. A rejeição acontece ANTES de qualquer I/O,
// então o teste é real (sem mock, sem escrita em disco).
describe("update_card — recusa status, aponta move_card", () => {
  it("status no payload → erro claro citando move_card (não grava)", async () => {
    const handler = captureHandlers().get("update_card")!;
    const r = await handler({ board: "storymap", cardId: "story-x", status: "pronta" });
    expect(r.isError).toBe(true);
    const msg = (r.content[0] as { text: string }).text;
    expect(msg).toMatch(/move_card/);
  });

  it("status pega mesmo combinado com um campo autoral (fail-fast, não grava o title)", async () => {
    const handler = captureHandlers().get("update_card")!;
    const r = await handler({ board: "storymap", cardId: "story-x", status: "pronta", title: "Novo" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/move_card/);
  });

  it("campo autoral SEM status passa pelo guard (falha só por card inexistente, não por status)", async () => {
    const handler = captureHandlers().get("update_card")!;
    const r = await handler({ board: "storymap", cardId: "__ghost_inexistente__", title: "Novo" });
    expect(r.isError).toBe(true);
    const msg = (r.content[0] as { text: string }).text;
    expect(msg).toMatch(/não encontrado/); // provou que title não é barrado pelo guard de status
    expect(msg).not.toMatch(/move_card/);
  });
});

// story-ex9528 M4 — mark_tasks_done APOSENTADO. O carimbo manual de tasks foi removido
// para humano E agente: a evidência do gate C2 (hasBuildEvidence) agora é a conclusão real das tasks (harness-do) OU a
// convergência de conteúdo (buildEvidence: already-landed). Prova por AUSÊNCIA — o padrão WS-5: a tool não existe
// mais em nenhuma superfície. (A régua de que o gate segue satisfazível pelos dois caminhos vive em
// build-evidence-gate.test.ts / gate-core.)
describe("mark_tasks_done — APOSENTADO (M4): nenhuma superfície o expõe", () => {
  it("não é mais uma tool registrada (removido, não só rebaixado)", () => {
    expect(captureHandlers().has("mark_tasks_done")).toBe(false);
  });
});

// --- fase 7: a FUNCIONALIDADE do PRD nos cards (update_card/create_card/list_cards/get_vocabulary) ------------------
// Board de verdade numa raiz temporária (o `_base` copiado): o PRD tem dois `###` em «Funcionalidades» e um balde de
// escopo da ferramenta, que não é funcionalidade. O handle da ÂNCORA (credencial `anchor:<board>`) só liga card a
// funcionalidade — decidido pela credencial que autenticou, não pelo nome que o agente declara.
describe("fase 7 — `feature` nos cards pelo MCP", () => {
  const BOARD = "horta";
  let root = "";
  let state = "";
  let prevTarget: string | undefined;
  let prevState: string | undefined;
  const savedEngine = engineStore[ENGINE_KEY];

  const card = (id: string, fm: string[], body = "Dado sintético.") => ["---", `id: ${id}`, ...fm, "---", "", body, ""].join("\n");

  beforeEach(async () => {
    const { cpSync, mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { findRepoRoot, resetRepoRootCache } = await import("../paths");
    const base = path.join(findRepoRoot(), "storymap", "boards", "_base");
    root = mkdtempSync(path.join(os.tmpdir(), "ah-feature-mcp-"));
    state = mkdtempSync(path.join(os.tmpdir(), "ah-feature-mcp-state-"));
    writeFileSync(path.join(root, "turbo.json"), "{}\n");
    cpSync(base, path.join(root, "storymap", "boards", "_base"), { recursive: true });
    const dir = path.join(root, "storymap", "boards", BOARD);
    mkdirSync(path.join(dir, "cards"), { recursive: true });
    mkdirSync(path.join(dir, "docs"), { recursive: true });
    // a matriz do board deixa a escrita de card automática: o teste mede a cerca do HANDLE, não a aprovação da matriz.
    writeFileSync(path.join(dir, "board.yaml"), `id: ${BOARD}\nname: Horta\norchestrator:\n  mode: autonomous\n  riskMatrix:\n    write-board: auto\n`);
    writeFileSync(
      path.join(dir, "docs", "prd.md"),
      ["---", "doc: prd", "format: 2", "---", "", "# PRD", "", "## Funcionalidades", "", "### Nesta versão", "", "- tudo", "",
        "### Regar junto", "", "Escala de rega da semana.", "", "### Trocar mudas", "", "Anuncia a muda que sobrou.", ""].join("\n"),
    );
    writeFileSync(path.join(dir, "cards", "step-ex1.md"), card("step-ex1", ["type: step", "title: Cuidar do canteiro", "status: null", "parent: null"]));
    writeFileSync(
      path.join(dir, "cards", "story-ex9301.md"),
      card("story-ex9301", ["type: story", "title: Lembrete de rega", "storyType: user", "status: triage", "parent: step-ex1"]),
    );
    writeFileSync(
      path.join(dir, "cards", "story-ex9302.md"),
      card("story-ex9302", ["type: story", "title: Muda reservada", "storyType: user", "status: triage", "parent: step-ex1", "feature: trocar-mudas"]),
    );
    prevTarget = process.env.AGILEHARNESS_TARGET;
    prevState = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    process.env.AGILEHARNESS_TARGET = root;
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = state;
    resetRepoRootCache();
    engineStore[ENGINE_KEY] = { isInFlight: () => false };
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    const { resetRepoRootCache } = await import("../paths");
    if (prevTarget === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = prevTarget;
    if (prevState === undefined) delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    else process.env.AGILEHARNESS_RUNNER_STATE_DIR = prevState;
    resetRepoRootCache();
    if (savedEngine === undefined) delete engineStore[ENGINE_KEY];
    else engineStore[ENGINE_KEY] = savedEngine;
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
  const onDisk = async (id: string) => (await import("../repo")).readCard(BOARD, id);
  const asAnchor = async <T,>(fn: () => Promise<T>) => {
    const { runWithMcpActor } = await import("./actor");
    const { anchorHandleLabel } = await import("./handle-scope");
    return runWithMcpActor({ level: "orch", tokenEnv: "AGILEHARNESS_TEST_ANCHOR", credentialLabel: anchorHandleLabel(BOARD) }, fn);
  };

  it("get_vocabulary devolve as funcionalidades do PRD (sem o balde de escopo) e o modo", async () => {
    const out = parseResult(await captureHandlers().get("get_vocabulary")!({ board: BOARD })) as Record<string, unknown>;
    expect(out.features).toEqual([
      { id: "regar-junto", name: "Regar junto" },
      { id: "trocar-mudas", name: "Trocar mudas" },
    ]);
    expect(out.featureMode).toBe("prd");
  });

  it("board sem funcionalidades no PRD ⇒ featureMode map, features []", async () => {
    const { writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    writeFileSync(path.join(root, "storymap", "boards", BOARD, "docs", "prd.md"), "---\ndoc: prd\nformat: 2\n---\n\n# PRD\n\n## Problema\n\nRegar esquecido.\n");
    const out = parseResult(await captureHandlers().get("get_vocabulary")!({ board: BOARD })) as Record<string, unknown>;
    expect(out.features).toEqual([]);
    expect(out.featureMode).toBe("map");
  });

  it("update_card: feature válida grava; desconhecida recusa com a lista; null limpa", async () => {
    const h = captureHandlers().get("update_card")!;
    const ok = await h({ board: BOARD, cardId: "story-ex9301", feature: "regar-junto" });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect((await onDisk("story-ex9301"))?.feature).toBe("regar-junto");
    expect((parseResult(ok) as { card: { feature?: string } }).card.feature).toBe("regar-junto");

    const bad = await h({ board: BOARD, cardId: "story-ex9301", feature: "inventada" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/regar-junto/);
    expect(text(bad)).toMatch(/trocar-mudas/);
    expect((await onDisk("story-ex9301"))?.feature, "a recusa não grava").toBe("regar-junto");

    const cleared = await h({ board: BOARD, cardId: "story-ex9301", feature: null });
    expect(cleared.isError, text(cleared)).toBeFalsy();
    expect((await onDisk("story-ex9301"))?.feature).toBeUndefined();
  });

  it("update_card recusa `batch` (campo do pipeline)", async () => {
    const r = await captureHandlers().get("update_card")!({ board: BOARD, cardId: "story-ex9301", batch: { id: "x", lead: "y", sessionId: "z", at: "w" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/batch/);
  });

  it("handle da âncora: `feature` passa; qualquer outro campo recusa", async () => {
    const h = captureHandlers().get("update_card")!;
    const refused = await asAnchor(() => Promise.resolve(h({ board: BOARD, cardId: "story-ex9301", feature: "regar-junto", title: "Outro título" })));
    expect(refused.isError, text(refused)).toBe(true);
    expect(text(refused)).toMatch(/title/);
    expect((await onDisk("story-ex9301"))?.title).toBe("Lembrete de rega");

    const ok = await asAnchor(() => Promise.resolve(h({ board: BOARD, cardId: "story-ex9301", feature: "regar-junto" })));
    expect(ok.isError, text(ok)).toBeFalsy();
    expect((await onDisk("story-ex9301"))?.feature).toBe("regar-junto");
  });

  it("handle da âncora vale só para o board dele", async () => {
    const h = captureHandlers().get("update_card")!;
    const other = await asAnchor(() => Promise.resolve(h({ board: "outro-board-ex", cardId: "story-ex9301", feature: "regar-junto" })));
    expect(other.isError, text(other)).toBe(true);
    expect(text(other)).toMatch(new RegExp(`só vale para o board ${BOARD}`));
    const { featureOnlyToolRefusal, anchorHandleLabel } = await import("./handle-scope");
    const actor = { credentialLabel: anchorHandleLabel(BOARD) };
    expect(featureOnlyToolRefusal("list_cards", "read", actor, "outro-board-ex")).toMatch(/só vale para o board/);
    expect(featureOnlyToolRefusal("list_cards", "read", actor, BOARD)).toBeNull();
    expect(featureOnlyToolRefusal("ask_question", "write-board", actor, BOARD)).toBeNull();
    expect(featureOnlyToolRefusal("list_cards", "read", { credentialLabel: "outra-coisa" }, "outro-board-ex")).toBeNull();
  });

  it("handle da âncora: create_card e move_card recusam", async () => {
    const handlers = captureHandlers();
    const c = await asAnchor(() => Promise.resolve(handlers.get("create_card")!({ board: BOARD, title: "Item novo", parent: "step-ex1" })));
    expect(c.isError, text(c)).toBe(true);
    expect(text(c)).toMatch(/só liga cards às funcionalidades/);
    const m = await asAnchor(() => Promise.resolve(handlers.get("move_card")!({ board: BOARD, cardId: "story-ex9301", status: "enriquecer" })));
    expect(m.isError).toBe(true);
    expect(text(m)).toMatch(/só liga cards às funcionalidades/);
  });

  it("create_card: funcionalidade inventada recusa ANTES de criar", async () => {
    const { readdirSync } = await import("node:fs");
    const { cardsDir } = await import("../paths");
    const before = readdirSync(cardsDir(BOARD)).length;
    const r = await captureHandlers().get("create_card")!({ board: BOARD, title: "Avisar quando chover", parent: "step-ex1", feature: "inventada" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/regar-junto/);
    expect(readdirSync(cardsDir(BOARD)).length).toBe(before);
  });

  it("create_card: a funcionalidade válida nasce no card", async () => {
    const r = await captureHandlers().get("create_card")!({ board: BOARD, title: "Avisar quando chover", parent: "step-ex1", feature: "regar-junto" });
    expect(r.isError, text(r)).toBeFalsy();
    const created = (parseResult(r) as { created: { id: string; feature?: string }[] }).created;
    expect(created).toHaveLength(1);
    expect(created[0].feature).toBe("regar-junto");
    expect((await onDisk(created[0].id))?.feature).toBe("regar-junto");
  });

  it("list_cards filtra pela funcionalidade (a chave do Kanban)", async () => {
    const h = captureHandlers().get("list_cards")!;
    const out = parseResult(await h({ board: BOARD, feature: "trocar-mudas" })) as { cards: { id: string; feature?: string }[] };
    expect(out.cards.map((c) => c.id)).toEqual(["story-ex9302"]);
    expect(out.cards[0].feature).toBe("trocar-mudas");
  });
});
