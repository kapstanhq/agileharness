// `ah_health`: a medida de agora + o delta contra uma leitura JÁ gravada + a versão no ar — somente-leitura, com os deps
// injetados (nenhum disco, nenhum relógio).

import { describe, expect, it, vi } from "vitest";
import { computeHealth, summarizeSignals, toHealthRecord, type HealthInputs, type HealthRecord, type HealthReport } from "./ah-health";
import { ahHealth, pickBaseline, type AhHealthDeps } from "./health-tool";
import { BOARD_SCOPE_CAVEAT } from "./health-scope";

const MIN = 60_000;
const NOW = Date.parse("2026-10-02T03:30:00Z");

const green = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  now: NOW,
  inbox: [],
  demandLanes: [],
  cards: [],
  transitions: [],
  deliveredStatuses: { alfa: ["concluida"] },
  publishWaiting: [],
  publishHeld: [],
  fleetKnown: true,
  fleet: [],
  orphanTerminals: [],
  claims: [],
  conductorQueue: [],
  stall: [],
  toolFailures: [],
  attribution: { actions: 100, attributed: 100 },
  touches: { liveStories: 1, technicalTouches: 0, ownerSessionActions: 0 },
  openTechnicalQuestions: [],
  ...over,
});

/** Três falhas da mesma assinatura da ferramenta: S10 vermelho (e só ele). */
const failing = (n: number): HealthInputs =>
  green({ toolFailures: Array.from({ length: n }, (_, i) => ({ signature: "sandbox:seccomp", at: NOW - (i + 1) * MIN, board: "alfa", cardId: `story-${i}` })) });

const reportOf = (inputs: HealthInputs): HealthReport => computeHealth(inputs);

const recordAt = (offsetMin: number, inputs: HealthInputs): HealthRecord => toHealthRecord({ ...computeHealth(inputs), at: new Date(NOW + offsetMin * MIN).toISOString() });

const RODANDO = { tag: "v0.9.26", sha: "a3f9c1e07b5d", at: "2026-10-02T03:10:00Z", prev: "v0.9.25", buildId: "Qx7bN2kLp0RmT4vW9sYc1" };

function deps(opts: { report?: HealthReport; history?: HealthRecord[]; release?: AhHealthDeps["release"] } = {}) {
  const measure = vi.fn(async (_now: number, _board: string | null) => opts.report ?? reportOf(green()));
  const d: AhHealthDeps = {
    now: () => NOW,
    boards: async () => ["alfa", "beta"],
    measure,
    history: async () => opts.history ?? [],
    release: opts.release ?? (() => ({ running: { version: RODANDO, reason: null }, pending: null })),
  };
  return Object.assign(d, { measure });
}

describe("ah_health — instalação inteira", () => {
  it("devolve os 12 sinais com nível, valor, limiar, evidência e o primeiro passo, mais o pior nível e a linha-resumo", async () => {
    const out = await ahHealth({}, deps({ report: reportOf(failing(3)) }));
    if (!out.ok) throw new Error(out.error);
    const r = out.result;
    expect(r.signals).toHaveLength(12);
    expect(r.worst).toBe("red");
    const s10 = r.signals.find((s) => s.id === "S10")!;
    expect(s10).toMatchObject({ level: "red", value: 3, threshold: { amber: 0, red: 1 } });
    expect(s10.evidence.length).toBeGreaterThan(0);
    expect(s10.fixHint.length).toBeGreaterThan(0);
    expect(r.summary).toMatch(/^1 vermelho \(S10\)/);
    expect(r.scope).toEqual({ kind: "installation" });
    expect(r.at).toBe(new Date(NOW).toISOString());
  });

  it("o delta é contra a ÚLTIMA leitura gravada: o conserto aparece como «melhorou», sem remedir o passado", async () => {
    const history = [recordAt(-10, failing(3)), recordAt(-5, failing(3))];
    const out = await ahHealth({}, deps({ report: reportOf(green()), history }));
    if (!out.ok) throw new Error(out.error);
    expect(out.result.delta).toMatchObject({ against: history[1]!.at, baselineNote: null, improved: ["S10"], worsened: [], worsenedLevel: [] });
    expect(out.result.delta!.line).toMatch(/melhorou: S10 \(3→0\)/);
    expect(out.result.deltaNote).toBeNull();
  });

  it("com `since`, a base é a leitura de ANTES daquele instante — é a prova de um conserto (antes do release, não 5 min atrás)", async () => {
    const history = [recordAt(-60, failing(3)), recordAt(-30, failing(3)), recordAt(-5, failing(0))];
    const out = await ahHealth({ since: new Date(NOW - 20 * MIN).toISOString() }, deps({ report: reportOf(green()), history }));
    if (!out.ok) throw new Error(out.error);
    expect(out.result.delta!.against).toBe(history[1]!.at); // a de -30, a última até -20
    expect(out.result.delta!.improved).toEqual(["S10"]);
  });

  it("`since` anterior à primeira leitura: usa a primeira e DIZ que a base não é de antes", async () => {
    const history = [recordAt(-30, failing(3))];
    const out = await ahHealth({ since: new Date(NOW - 3_600_000).toISOString() }, deps({ report: reportOf(green()), history }));
    if (!out.ok) throw new Error(out.error);
    expect(out.result.delta!.against).toBe(history[0]!.at);
    expect(out.result.delta!.baselineNote).toMatch(/primeira leitura depois/);
  });

  it("sem nenhuma leitura gravada não inventa delta: diz que não há base", async () => {
    const out = await ahHealth({}, deps());
    if (!out.ok) throw new Error(out.error);
    expect(out.result.delta).toBeNull();
    expect(out.result.deltaNote).toMatch(/ainda não há leitura gravada/);
  });

  it("devolve a versão no ar quando o build passou pelo release; senão o motivo", async () => {
    const withRelease = await ahHealth({}, deps());
    if (!withRelease.ok) throw new Error(withRelease.error);
    expect(withRelease.result.release).toMatchObject({ tag: "v0.9.26", prev: "v0.9.25" });
    expect(withRelease.result.releaseNote).toBeNull();

    const dev = await ahHealth({}, deps({ release: () => ({ running: { version: null, reason: "dist/ah-version.json ausente — este build não passou por contrib/ah-release" }, pending: null }) }));
    if (!dev.ok) throw new Error(dev.error);
    expect(dev.result.release).toBeNull();
    expect(dev.result.releaseNote).toMatch(/não passou por contrib\/ah-release/);
  });

  it("release gravado no disco sem restart: `release` é a versão que RODA e a nota diz o restart pendente (a confirmação da saída 6 pode falhar)", async () => {
    const novo = { ...RODANDO, tag: "v0.9.27", at: "2026-10-02T04:00:00Z", prev: "v0.9.26", buildId: "Zz9aA8bB7cC6dD5eE4fF3" };
    const out = await ahHealth({}, deps({ release: () => ({ running: { version: RODANDO, reason: null }, pending: novo }) }));
    if (!out.ok) throw new Error(out.error);
    expect(out.result.release?.tag).toBe("v0.9.26");
    expect(out.result.releaseNote).toMatch(/v0\.9\.27.*restart pendente/);
  });
});

describe("ah_health — um board", () => {
  it("mede o recorte (o `measure` recebe o board), diz o que o recorte não divide e NÃO compara com a instalação gravada", async () => {
    const d = deps({ history: [recordAt(-5, failing(3))] });
    const out = await ahHealth({ board: "alfa" }, d);
    if (!out.ok) throw new Error(out.error);
    expect(d.measure).toHaveBeenCalledWith(NOW, "alfa");
    expect(out.result.scope).toEqual({ kind: "board", board: "alfa", caveat: BOARD_SCOPE_CAVEAT });
    expect(out.result.delta).toBeNull();
    expect(out.result.deltaNote).toMatch(/instalação inteira/);
  });

  it("sem `board`, o measure recebe null (a instalação)", async () => {
    const d = deps();
    await ahHealth({}, d);
    expect(d.measure).toHaveBeenCalledWith(NOW, null);
  });

  it("board que não existe volta como erro com a lista dos que existem — e não mede nada", async () => {
    const d = deps();
    const out = await ahHealth({ board: "nao-existe" }, d);
    expect(out).toEqual({ ok: false, error: "o board «nao-existe» não existe. Boards: alfa, beta" });
    expect(d.measure).not.toHaveBeenCalled();
  });
});

describe("ah_health — argumentos inválidos", () => {
  it("`since` que não é um instante ISO é recusado antes de medir", async () => {
    const d = deps();
    const out = await ahHealth({ since: "ontem à noite" }, d);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/instante ISO/);
    expect(d.measure).not.toHaveBeenCalled();
  });
});

describe("pickBaseline e summarizeSignals — as peças puras", () => {
  it("pickBaseline ordena sozinho: ledger fora de ordem não troca a «última»", () => {
    const [a, b, c] = [recordAt(-30, green()), recordAt(-20, green()), recordAt(-10, green())];
    expect(pickBaseline([c, a, b], null)!.record).toBe(c);
    expect(pickBaseline([c, a, b], NOW - 25 * MIN)!.record).toBe(a);
    expect(pickBaseline([], null)).toBeNull();
  });

  it("summarizeSignals: vermelhos e atenção com os ids, ok só contado, não medíveis com os ids", () => {
    const line = summarizeSignals([
      { id: "S1", level: "red" },
      { id: "S2", level: "red" },
      { id: "S3", level: "amber" },
      { id: "S4", level: "ok" },
      { id: "S5", level: "ok" },
      { id: "S11", level: "unknown" },
    ]);
    expect(line).toBe("2 vermelhos (S1, S2) · 1 em atenção (S3) · 2 ok · 1 não medível (S11)");
    expect(summarizeSignals([{ id: "S1", level: "ok" }])).toBe("1 ok");
  });
});
