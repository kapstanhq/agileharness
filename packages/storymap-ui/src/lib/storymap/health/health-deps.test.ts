// O tick de saúde: vermelho em DUAS leituras seguidas abre UM card `[saude:<id>]` no board da ferramenta, o terceiro tick
// não duplica, e sem board da ferramenta nada é criado — com o porquê escrito. A escrita do card roda de verdade, mas
// num repositório descartável (tmpdir): nunca no checkout de runtime.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dump } from "js-yaml";
import { findRepoRoot, resetRepoRootCache } from "../paths";
import { readCards } from "../repo";
import { updateCardOnDisk } from "../write";
import {
  computeHealth,
  DEFAULT_HEALTH_SETTINGS,
  toHealthRecord,
  type HealthCardOutcome,
  type HealthInputs,
  type HealthRecord,
  type HealthReport,
  type HealthSettings,
  type HealthSignal,
} from "./ah-health";
import {
  diskHealthLedger,
  healthCardBody,
  healthTickIntervalMs,
  readHealthSettings,
  readLastHealthRecord,
  runHealthTick,
  upsertHealthCard,
  type HealthLedger,
  type HealthTickDeps,
} from "./health-deps";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T21:00:00Z");

const green = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  now: T0,
  inbox: [],
  demandLanes: [],
  cards: [],
  transitions: [],
  deliveredStatuses: { b: ["concluida"] },
  publishWaiting: [],
  publishHeld: [],
  fleetKnown: true,
  fleet: [],
  orphanTerminals: [],
  claims: [],
  conductorQueue: [],
  stall: [],
  toolFailures: [],
  attribution: { actions: 10, attributed: 10 },
  touches: { liveStories: 1, technicalTouches: 0, ownerSessionActions: 0 },
  openTechnicalQuestions: [],
  ...over,
});

/** O estado de «Liberar» parado: 10 cards esperando, nada no ar há 6 h, 7 pela mesma causa (S6 vermelho). */
const stuckPublishing = (now: number): HealthInputs => {
  const ids = Array.from({ length: 10 }, (_, i) => `story-p${i}`);
  return green({
    now,
    publishWaiting: ids.map((cardId) => ({ board: "b", cardId })),
    publishHeld: ids.slice(0, 7).map((cardId) => ({ board: "b", cardId, phase: "needs-human", exitCode: 3 })),
    transitions: [{ board: "b", cardId: "story-old", to: "concluida", at: now - 6 * 3_600_000, actor: "system" }],
  });
};

const memoryLedger = (seed: HealthRecord[] = []): HealthLedger & { rows: HealthRecord[] } => {
  const rows = [...seed];
  return { rows, read: async () => [...rows], append: async (r) => void rows.push(r), prune: async () => {} };
};

/** Os deps de um tick com o relógio sob controle. `upsertCard` simula o board: o 1º `created`, depois `exists`. */
function harness(over: Partial<HealthTickDeps> = {}, settings: HealthSettings = DEFAULT_HEALTH_SETTINGS) {
  const ledger = memoryLedger();
  const created: Array<{ board: string; id: string }> = [];
  const logs: string[] = [];
  let now = T0;
  let state: (now: number) => HealthInputs = stuckPublishing;
  const deps: HealthTickDeps = {
    settings: () => settings,
    measure: async (n, s) => computeHealth(state(n), s.thresholds),
    ledger,
    selfBoard: () => "tool",
    upsertCard: async (board, signal): Promise<HealthCardOutcome> => {
      const open = created.find((c) => c.id === `card-${signal.id}`);
      if (open) return { outcome: "exists", cardId: open.id };
      created.push({ board, id: `card-${signal.id}` });
      return { outcome: "created", cardId: `card-${signal.id}` };
    },
    log: (l) => logs.push(l),
    ...over,
  };
  return {
    deps,
    ledger,
    created,
    logs,
    tick: async () => {
      const r = await runHealthTick(deps, now);
      now += 5 * MIN;
      return r;
    },
    setState: (fn: (now: number) => HealthInputs) => (state = fn),
  };
}

describe("runHealthTick — vermelho em 2 leituras seguidas vira UM card", () => {
  it("o 1º tick só registra; o 2º cria o card [saude:S6] no board da ferramenta; o 3º não duplica", async () => {
    const h = harness();
    const first = await h.tick();
    expect(first.report.signals.find((s) => s.id === "S6")!.level).toBe("red");
    expect(first.due).toEqual([]);
    expect(h.created).toEqual([]);

    const second = await h.tick();
    expect(second.due).toContain("S6");
    expect(second.cards.S6).toEqual({ outcome: "created", cardId: "card-S6" });
    expect(h.created).toEqual([{ board: "tool", id: "card-S6" }]);

    const third = await h.tick();
    expect(third.cards.S6).toEqual({ outcome: "exists", cardId: "card-S6" });
    expect(h.created).toHaveLength(1);
  });

  it("cada leitura é anexada ao ledger, com o que o tick fez por cada sinal", async () => {
    const h = harness();
    await h.tick();
    await h.tick();
    expect(h.ledger.rows).toHaveLength(2);
    expect(h.ledger.rows[0].cards).toBeUndefined();
    expect(h.ledger.rows[1].cards).toEqual({ S6: { outcome: "created", cardId: "card-S6" } });
    expect(h.ledger.rows[1].signals.S6).toMatchObject({ level: "red" });
  });

  it("sinal que piscou verde no meio quebra a sequência: nenhum card", async () => {
    const h = harness();
    await h.tick(); // vermelho
    h.setState((n) => green({ now: n })); // melhora
    await h.tick();
    h.setState(stuckPublishing); // vermelho de novo — mas a anterior foi verde
    const third = await h.tick();
    expect(third.due).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("âmbar nunca abre card, por mais que dure", async () => {
    const h = harness();
    h.setState((n) => green({ now: n, orphanTerminals: ["agent-conductor-story-a-ab12"] })); // S4 âmbar
    for (let i = 0; i < 4; i++) expect((await h.tick()).due).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("sem board da ferramenta: não cria NADA e diz por quê (no resultado, no ledger e uma vez no log)", async () => {
    const upsert = vi.fn();
    const h = harness({ selfBoard: () => null, upsertCard: upsert });
    await h.tick();
    const second = await h.tick();
    expect(upsert).not.toHaveBeenCalled();
    expect(second.cards.S6).toMatchObject({ outcome: "skipped" });
    expect((second.cards.S6 as { reason: string }).reason).toContain("AGILEHARNESS_SELF_BOARD");
    expect(h.ledger.rows[1].cards!.S6).toMatchObject({ outcome: "skipped" });
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toContain("não criado");
    await h.tick();
    await h.tick();
    expect(h.logs).toHaveLength(1); // a mesma recusa a cada 5 min seria ruído
  });

  it("uma escrita que falha não derruba o tick: vira «não criado» com o motivo", async () => {
    const h = harness({ upsertCard: async () => { throw new Error("disco cheio"); } });
    await h.tick();
    const second = await h.tick();
    expect(second.cards.S6).toEqual({ outcome: "skipped", reason: "falha ao gravar o card: disco cheio" });
    expect(h.ledger.rows).toHaveLength(2);
  });

  it("o ledger que não grava não derruba o tick (loga e segue)", async () => {
    const h = harness({ ledger: { ...memoryLedger(), append: async () => { throw new Error("somente leitura"); } } });
    const r = await h.tick();
    expect(r.report.worst).toBe("red");
    expect(h.logs.join("\n")).toContain("somente leitura");
  });

  it("um serviço parado por horas não faz «duas leituras seguidas» de um vermelho antigo e um de agora", async () => {
    const old = toHealthRecord({ ...computeHealth(stuckPublishing(T0 - 6 * 3_600_000)), at: new Date(T0 - 6 * 3_600_000).toISOString() });
    const h = harness();
    h.ledger.rows.push(old);
    const r = await h.tick();
    expect(r.due).toEqual([]);
    expect(h.created).toEqual([]);
  });

  it("os limiares do settings valem no tick", async () => {
    const lenient: HealthSettings = { ...DEFAULT_HEALTH_SETTINGS, thresholds: { ...DEFAULT_HEALTH_SETTINGS.thresholds, s6: { amber: 50, red: 80, redGroup: 50 } } };
    const h = harness({}, lenient);
    await h.tick();
    expect((await h.tick()).due).toEqual([]);
  });
});

// ── o ledger ─────────────────────────────────────────────────────────────────────────────────────────

describe("diskHealthLedger — anexar-apenas, retenção de 7 dias", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const ledger = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ah-health-"));
    dirs.push(dir);
    const file = path.join(dir, "nested", "health.jsonl");
    return { file, l: diskHealthLedger(file) };
  };
  const rec = (at: number): HealthRecord => ({ v: 1, at: new Date(at).toISOString(), signals: { S1: { value: 0, level: "ok" } } });

  it("lê de volta o que anexou (cria o diretório) e pula a linha quebrada", async () => {
    const { file, l } = ledger();
    expect(await l.read()).toEqual([]);
    await l.append(rec(T0));
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"at":"2026\n{"v":2,"at":"x"}\n`);
    await l.append(rec(T0 + 5 * MIN));
    expect((await l.read()).map((r) => r.at)).toEqual([new Date(T0).toISOString(), new Date(T0 + 5 * MIN).toISOString()]);
  });

  it("prune não reescreve enquanto o mais antigo está dentro da retenção + 1 dia", async () => {
    const { file, l } = ledger();
    await l.append(rec(T0 - 7.5 * DAY));
    await l.append(rec(T0));
    const before = readFileSync(file, "utf8");
    await l.prune(T0, 7);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("passada a folga, descarta o que tem mais de 7 dias e mantém o resto", async () => {
    const { l } = ledger();
    await l.append(rec(T0 - 9 * DAY));
    await l.append(rec(T0 - 7.2 * DAY));
    await l.append(rec(T0 - 6 * DAY));
    await l.append(rec(T0));
    await l.prune(T0, 7);
    expect((await l.read()).map((r) => r.at)).toEqual([new Date(T0 - 6 * DAY).toISOString(), new Date(T0).toISOString()]);
  });
});

describe("readLastHealthRecord — a última leitura, lida só do fim do arquivo (a tela de /processes a pede a cada visita)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const file = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ah-health-last-"));
    dirs.push(dir);
    return path.join(dir, "health.jsonl");
  };
  const rec = (at: number, detail = "ok"): HealthRecord => ({ v: 1, at: new Date(at).toISOString(), signals: { S1: { value: 0, level: "ok", detail } } });

  it("arquivo ausente ou vazio ⇒ null (a tela diz «sem leitura ainda»)", async () => {
    expect(await readLastHealthRecord(file())).toBeNull();
    const f = file();
    writeFileSync(f, "");
    expect(await readLastHealthRecord(f)).toBeNull();
  });

  it("devolve a ÚLTIMA linha válida e pula a linha parcial que uma escrita interrompida deixou no fim", async () => {
    const f = file();
    writeFileSync(f, `${JSON.stringify(rec(T0))}\n${JSON.stringify(rec(T0 + 5 * MIN))}\n{"v":1,"at":"2026-10-01T21:1`);
    expect((await readLastHealthRecord(f))!.at).toBe(new Date(T0 + 5 * MIN).toISOString());
  });

  it("num ledger bem maior que o trecho lido, acha a última sem parsear o arquivo todo (o corte no meio de uma linha é pulado)", async () => {
    const f = file();
    const big = "x".repeat(2_000);
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify(rec(T0 + i * MIN, big))); // ~400 KB
    writeFileSync(f, `${lines.join("\n")}\n`);
    expect((await readLastHealthRecord(f))!.at).toBe(new Date(T0 + 199 * MIN).toISOString());
  });
});

// ── o settings ───────────────────────────────────────────────────────────────────────────────────────

describe("readHealthSettings — o bloco health: do settings.yaml", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const settingsFile = (text: string | null) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ah-health-settings-"));
    dirs.push(dir);
    const file = path.join(dir, "settings.yaml");
    if (text != null) writeFileSync(file, text);
    return file;
  };

  it("arquivo ausente, ilegível ou sem o bloco ⇒ os defaults do código", () => {
    expect(readHealthSettings(settingsFile(null))).toEqual(DEFAULT_HEALTH_SETTINGS);
    expect(readHealthSettings(settingsFile("autorun:\n  enabled: true\n"))).toEqual(DEFAULT_HEALTH_SETTINGS);
    expect(readHealthSettings(settingsFile("health: [oops\n  :::"))).toEqual(DEFAULT_HEALTH_SETTINGS);
  });

  it("lê knobs e limiares do bloco, campo a campo", () => {
    const s = readHealthSettings(settingsFile("# comentário\nautorun:\n  enabled: true\nhealth:\n  tickMinutes: 10\n  redTicks: 3\n  s6: { amber: 1, red: 3 }\n"));
    expect(s.tickMinutes).toBe(10);
    expect(s.redTicks).toBe(3);
    expect(s.thresholds.s6).toEqual({ amber: 1, red: 3, redGroup: 2 });
    expect(s.thresholds.s2).toEqual(DEFAULT_HEALTH_SETTINGS.thresholds.s2);
  });

  it("o intervalo do timer sai dos minutos; 0 desliga", () => {
    expect(healthTickIntervalMs(DEFAULT_HEALTH_SETTINGS)).toBe(5 * MIN);
    expect(healthTickIntervalMs({ ...DEFAULT_HEALTH_SETTINGS, tickMinutes: 0 })).toBe(0);
  });
});

// ── o card, de verdade, num repositório descartável ──────────────────────────────────────────────────

describe("upsertHealthCard — a mesma porta de criação do vigia de parados, sem tocar o checkout de runtime", () => {
  const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
  const tmp: string[] = [];
  afterEach(() => {
    delete process.env.AGILEHARNESS_TARGET;
    resetRepoRootCache();
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
  });

  /** Um repositório mínimo com o `_base` e um board `tool` que herda a pipeline (ou não, com `raw`). */
  const repoWithBoard = (raw: Record<string, unknown> = {}): { root: string; cardsDir: string } => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ah-health-repo-"));
    tmp.push(root);
    writeFileSync(path.join(root, "turbo.json"), "{}\n");
    mkdirSync(path.join(root, "storymap", "boards", "tool", "cards"), { recursive: true });
    cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
    writeFileSync(path.join(root, "storymap", "boards", "tool", "board.yaml"), dump({ id: "tool", name: "Ferramenta", ...raw }));
    process.env.AGILEHARNESS_TARGET = root;
    resetRepoRootCache();
    return { root, cardsDir: path.join(root, "storymap", "boards", "tool", "cards") };
  };

  const report: HealthReport = computeHealth(stuckPublishing(T0));
  const s6 = report.signals.find((s) => s.id === "S6") as HealthSignal;

  it("cria UM card na Triagem, técnico, com o prefixo [saude:S6], a evidência e o primeiro passo no corpo", async () => {
    const { cardsDir } = repoWithBoard();
    const out = await upsertHealthCard("tool", s6, report);
    expect(out.outcome).toBe("created");
    const cards = await readCards("tool");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: (out as { cardId: string }).cardId, status: "triage", storyType: "technical", via: "triage", labels: ["saude", "saude:S6"] });
    expect(cards[0].title).toBe("[saude:S6] Vazão até o ar");
    expect(cards[0].body).toContain("story-p0");
    expect(cards[0].body).toContain("## Prova esperada");
    expect(readdirSync(cardsDir)).toHaveLength(1);
  });

  it("a 2ª chamada com o card ABERTO não duplica", async () => {
    repoWithBoard();
    const first = await upsertHealthCard("tool", s6, report);
    const second = await upsertHealthCard("tool", s6, report);
    expect(second).toEqual({ outcome: "exists", cardId: (first as { cardId: string }).cardId });
    expect(await readCards("tool")).toHaveLength(1);
  });

  it("duas chamadas SIMULTÂNEAS (dois ticks, ou o tick e outro escritor) criam um card só", async () => {
    repoWithBoard();
    const [a, b] = await Promise.all([upsertHealthCard("tool", s6, report), upsertHealthCard("tool", s6, report)]);
    expect([a.outcome, b.outcome].sort()).toEqual(["created", "exists"]);
    expect(await readCards("tool")).toHaveLength(1);
  });

  it("sinais diferentes têm cards diferentes", async () => {
    repoWithBoard();
    const s1 = report.signals.find((s) => s.id === "S1") as HealthSignal;
    await upsertHealthCard("tool", s6, report);
    expect((await upsertHealthCard("tool", { ...s1, level: "red" }, report)).outcome).toBe("created");
    expect((await readCards("tool")).map((c) => c.title).sort()).toEqual(["[saude:S1] Decidir sem negócio", "[saude:S6] Vazão até o ar"]);
  });

  // Reescrito de propósito (revisão do WP6a): o teste antigo travava «card FECHADO + sinal vermelho ⇒ card NOVO», que
  // fazia nascer uma duplicata no tick seguinte ao release (e outra a cada vez que o dono descartava).
  it("card FECHADO com o episódio vermelho ainda em curso ⇒ `covered`, nenhum card novo", async () => {
    repoWithBoard();
    const first = (await upsertHealthCard("tool", s6, report)) as { cardId: string };
    await updateCardOnDisk("tool", first.cardId, (c) => ({ ...c, status: "concluida" }));
    expect(await upsertHealthCard("tool", s6, report, { coveredBy: first.cardId })).toEqual({ outcome: "covered", cardId: first.cardId });
    expect(await readCards("tool")).toHaveLength(1);
  });

  it("card FECHADO num episódio que já acabou (o sinal saiu do vermelho) ⇒ o vermelho novo abre outro", async () => {
    repoWithBoard();
    const first = (await upsertHealthCard("tool", s6, report)) as { cardId: string };
    await updateCardOnDisk("tool", first.cardId, (c) => ({ ...c, status: "concluida" }));
    const again = await upsertHealthCard("tool", s6, report, { coveredBy: null });
    expect(again.outcome).toBe("created");
    expect((again as { cardId: string }).cardId).not.toBe(first.cardId);
  });

  it("o card ABERTO vence o episódio: reaberto pela validação do release, ele é o `exists`", async () => {
    repoWithBoard();
    const first = (await upsertHealthCard("tool", s6, report)) as { cardId: string };
    expect(await upsertHealthCard("tool", s6, report, { coveredBy: "story-outro" })).toEqual({ outcome: "exists", cardId: first.cardId });
  });

  it("o título reescrito (enriquecer, condutor, o dono) não desfaz o dedup: a chave é o rótulo `saude:<id>`", async () => {
    repoWithBoard();
    const first = (await upsertHealthCard("tool", s6, report)) as { cardId: string };
    await updateCardOnDisk("tool", first.cardId, (c) => ({ ...c, title: "Publicações presas pela mesma causa viram um conserto só" }));
    expect(await upsertHealthCard("tool", s6, report)).toEqual({ outcome: "exists", cardId: first.cardId });
    expect(await readCards("tool")).toHaveLength(1);
  });

  it("card antigo sem o rótulo ainda é achado pelo prefixo do título; `[saude:S1]` não confunde `[saude:S10]`", async () => {
    repoWithBoard();
    const first = (await upsertHealthCard("tool", s6, report)) as { cardId: string };
    await updateCardOnDisk("tool", first.cardId, (c) => ({ ...c, labels: [] }));
    expect(await upsertHealthCard("tool", s6, report)).toEqual({ outcome: "exists", cardId: first.cardId });
    const s10 = { ...(report.signals.find((s) => s.id === "S10") as HealthSignal), level: "red" as const };
    const s1 = { ...(report.signals.find((s) => s.id === "S1") as HealthSignal), level: "red" as const };
    const ten = (await upsertHealthCard("tool", s10, report)) as { cardId: string };
    await updateCardOnDisk("tool", ten.cardId, (c) => ({ ...c, labels: [] }));
    expect((await upsertHealthCard("tool", s1, report)).outcome).toBe("created");
  });

  it("o tick de ponta a ponta: release fecha o card com o sinal vermelho ⇒ nada novo; o dono descarta ⇒ nada novo; o sinal sai do vermelho e volta 2 ticks ⇒ UM card novo", async () => {
    repoWithBoard();
    const rows: HealthRecord[] = [];
    let state: (now: number) => HealthInputs = stuckPublishing;
    const deps: HealthTickDeps = {
      settings: () => DEFAULT_HEALTH_SETTINGS,
      measure: async (n, s) => computeHealth(state(n), s.thresholds),
      ledger: { read: async () => [...rows], append: async (r) => void rows.push(r), prune: async () => {} },
      selfBoard: () => "tool",
      upsertCard: upsertHealthCard,
      log: () => {},
    };
    const saude6 = async () => (await readCards("tool")).filter((c) => c.labels?.includes("saude:S6"));

    await runHealthTick(deps, T0);
    const created = (await runHealthTick(deps, T0 + 5 * MIN)).cards.S6 as { outcome: string; cardId: string };
    expect(created.outcome).toBe("created");
    // record_tool_release leva o card a `concluida`; o S6 mede horas sem entrega, então segue vermelho
    await updateCardOnDisk("tool", created.cardId, (c) => ({ ...c, status: "concluida" }));
    expect((await runHealthTick(deps, T0 + 10 * MIN)).cards.S6).toEqual({ outcome: "covered", cardId: created.cardId });
    // o dono «descarta» na Triagem (cancelado) — também não renasce
    await updateCardOnDisk("tool", created.cardId, (c) => ({ ...c, status: "cancelado" }));
    expect((await runHealthTick(deps, T0 + 15 * MIN)).cards.S6).toEqual({ outcome: "covered", cardId: created.cardId });
    expect(await saude6()).toHaveLength(1);

    state = (n) => green({ now: n }); // o conserto funcionou: uma leitura verde fecha o episódio
    await runHealthTick(deps, T0 + 20 * MIN);
    state = stuckPublishing; // e o sinal volta: o 1º vermelho só registra, o 2º abre UM card novo
    expect((await runHealthTick(deps, T0 + 25 * MIN)).cards.S6).toBeUndefined();
    const reborn = (await runHealthTick(deps, T0 + 30 * MIN)).cards.S6 as { outcome: string; cardId: string };
    expect(reborn.outcome).toBe("created");
    expect(reborn.cardId).not.toBe(created.cardId);
    expect((await runHealthTick(deps, T0 + 35 * MIN)).cards.S6).toEqual({ outcome: "exists", cardId: reborn.cardId });
    expect((await saude6()).map((c) => c.status).sort()).toEqual(["cancelado", "triage"]);
  });

  it("board sem coluna de entrada (Triagem) não recebe nada e diz por quê", async () => {
    repoWithBoard({ inheritPipeline: false, statuses: [{ id: "todo", name: "A fazer" }, { id: "done", name: "Feito", terminal: true }] });
    const out = await upsertHealthCard("tool", s6, report);
    expect(out).toMatchObject({ outcome: "skipped" });
    expect((out as { reason: string }).reason).toContain("Triagem");
    expect(await readCards("tool")).toHaveLength(0);
  });

  it("o corpo diz o número, a regra e que o dono não foi chamado", () => {
    const body = healthCardBody(s6, report);
    expect(body).toContain("Sinal: S6 (Vazão até o ar)");
    expect(body).toContain(s6.rule);
    expect(body).toContain(s6.fixHint);
    expect(body).toContain("O dono não foi chamado");
  });
});
