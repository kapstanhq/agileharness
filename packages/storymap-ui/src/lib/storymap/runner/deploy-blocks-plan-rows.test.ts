// O PEDIDO DO DONO QUE NENHUM CARD REGISTROU (deploy-blocks.ts `openPlanOwnerRows`). A regra: o plano de publicação que
// só lê (`deploy.planCommand`) lista um pedido de autorização do dono que nenhuma tentativa de publicar gravou num card
// (o board está pausado: ninguém tenta) — ele tem de chegar ao Inbox mesmo assim, sem rodar deploy nenhum, e sair quando o
// plano deixa de listá-lo. Fixtures INVENTADAS: o board `feira` publica o pacote `feira`; a regra `taxa-de-entrega` é do
// dono por pedido de autorização (fora do mapa de classes), `preco-final` é dinheiro pelo mapa.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, DeployCause } from "@/lib/storymap/types";
import { parseDeployExit3Report, type OwnerApprovalRequest } from "./deploy-proof";
import { deployPolicyFromSettings } from "./deploy-command-guard";
import type { ExecFn } from "./worktree";
import {
  claimDiscover,
  deployCausesOf,
  entryVerdict,
  judgePlanCauses,
  openPlanOwnerRows,
  parseDeployBlocks,
  planCausesOf,
  remeasureBoardCauses,
  resetDiscoverForTest,
  resetRemeasureForTest,
  sweepDeployBlocks,
  syncDeployBlocks,
  systemTextOf,
  upsertDeployBlock,
  type DeployBlockRow,
  type DeployBlocksSweepDeps,
  type RemeasureVerdict,
} from "./deploy-blocks";

const BOARD = "feira";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const RECORD = "./registrar-sim <approval.json>";
const hashOf = (c: string) => `sha256:${c.repeat(64)}`;
const ask = (c: string, file: string, rule: string, unit = "vitrine"): Record<string, unknown> => ({
  unit,
  file,
  rule,
  why: "muda o que o cliente paga",
  ownerApproval: { subject: { kind: "diff", hash: hashOf(c), base: "0a1b2c3", head: HEAD, files: [file] }, record: RECORD },
});
const planOut = (human: unknown[], status = "needs-human") => JSON.stringify({ package: BOARD, head: HEAD, status, plan: { head: HEAD, status, human } });
const report = (human: unknown[], status = "needs-human") => parseDeployExit3Report(planOut(human, status));

const config = {
  id: BOARD,
  name: "Feira",
  statuses: [
    { id: "release", name: "Liberar" },
    { id: "concluida", name: "No ar", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  deploy: { kind: "command", command: "./publicar feira", planCommand: "publicar feira --plano" },
  autonomy: { mode: "ultra", deployRuleClasses: { "preco-final": "money" } },
} as unknown as BoardConfig;

const ENTREGA = ask("c", "web/entrega/taxa.ts", "taxa-de-entrega");
const PRECO = ask("d", "api/preco/final.ts", "preco-final", "api");

describe("a entrada que traz o pedido de autorização do dono é do dono", () => {
  it("a regra fora do mapa de classes com `ownerApproval` legível ⇒ dono sem classe (antes: «do sistema», e o pedido nunca chegava ao Inbox)", () => {
    const [e] = report([ENTREGA]).entries;
    expect(e.asksOwnerApproval).toBe(true);
    expect(entryVerdict(e, config)).toEqual({ decider: "owner", ownerClass: null });
  });
  it("sem pedido (ou pedido que não amarra uma mudança exata) a régua é a de sempre: regra fora do mapa ⇒ sistema", () => {
    const semPedido = report([{ unit: "vitrine", file: "x.ts", rule: "taxa-de-entrega", why: null }]).entries[0];
    expect(semPedido.asksOwnerApproval).toBeUndefined();
    expect(entryVerdict(semPedido, config).decider).toBe("system");
    const torto = { ...ENTREGA, ownerApproval: { subject: { kind: "diff", hash: hashOf("c"), files: ["x.ts"] }, record: RECORD } };
    expect(report([torto]).entries[0].asksOwnerApproval).toBeUndefined();
  });
  it("o que o ALVO declara continua vencendo (sistema declarado com pedido ⇒ sistema)", () => {
    const [e] = report([{ ...ENTREGA, decider: "system" }]).entries;
    expect(entryVerdict(e, config).decider).toBe("system");
  });
});

describe("openPlanOwnerRows — a linha do pedido que nenhum card registrou", () => {
  const plan = report([ENTREGA, PRECO]);
  const causes = planCausesOf({ status: "needs-human", report: plan }, BOARD, config);
  const approvals = plan.ownerApprovals ?? [];
  const open = (rows: DeployBlockRow[], over: Partial<Parameters<typeof openPlanOwnerRows>[2]> = {}) =>
    openPlanOwnerRows(rows, BOARD, { causes, approvals, at: "2026-10-06T00:00:00Z", command: "./publicar feira", organizeOnly: false, ...over });

  it("abre uma linha por causa do dono, sem card, marcada como do plano, com os pedidos dela", () => {
    const rows = open([]);
    expect(rows.map((r) => r.causeKey).sort()).toEqual([`${BOARD}:owner:?`, `${BOARD}:owner:money`]);
    for (const r of rows) expect(r).toMatchObject({ board: BOARD, decider: "owner", phase: "needs-human", cardIds: [], planSourced: true, command: "./publicar feira" });
    expect(rows.find((r) => r.causeKey === `${BOARD}:owner:money`)?.approvals?.map((a) => a.subject.hash)).toEqual([hashOf("d")]);
    expect(rows.find((r) => r.causeKey === `${BOARD}:owner:?`)?.approvals?.map((a) => a.subject.hash)).toEqual([hashOf("c")]);
  });
  it("idempotente: a segunda leitura do mesmo plano não abre outra linha", () => {
    const once = open([]);
    expect(open(once)).toEqual(once);
  });
  it("board só de organização ⇒ nada", () => {
    expect(open([], { organizeOnly: true })).toEqual([]);
  });
  it("o pedido que o dono já autorizou (em qualquer linha do board) ou que outra linha já mostra não abre linha", () => {
    const other: DeployBlockRow = { ...open([])[0], causeKey: `${BOARD}:owner:outra`, planSourced: undefined, cardIds: ["c1"], approvals: [], granted: [hashOf("c")] };
    const showing: DeployBlockRow = { ...other, causeKey: `${BOARD}:owner:mostra`, granted: [], approvals: [approvals.find((a) => a.subject.hash === hashOf("d")) as OwnerApprovalRequest] };
    expect(open([other, showing]).filter((r) => r.planSourced)).toEqual([]);
  });
  it("a causa que já tem linha (de um card) não ganha outra — o `touch` da re-medição a atualiza", () => {
    const withCard = upsertDeployBlock([], { board: BOARD, cardId: "c1", cause: causes.find((c) => c.causeKey === `${BOARD}:owner:money`) as DeployCause, at: "t", command: null });
    expect(open(withCard).filter((r) => r.causeKey === `${BOARD}:owner:money`)).toHaveLength(1);
  });
  it("causa do sistema e plano sem pedido nenhum ⇒ nada", () => {
    const system = planCausesOf({ status: "needs-human", report: report([{ unit: "w", file: "w.ts", rule: "sem-classe", why: null }]) }, BOARD, config);
    expect(system.every((c) => c.decider === "system")).toBe(true);
    expect(open([], { causes: system })).toEqual([]);
    expect(open([], { approvals: [] })).toEqual([]);
  });
});

describe("a linha do plano vive sem card e fecha quando o plano deixa de listá-la", () => {
  const rows = () => openPlanOwnerRows([], BOARD, { causes: planCausesOf({ status: "needs-human", report: report([ENTREGA]) }, BOARD, config), approvals: report([ENTREGA]).ownerApprovals ?? [], at: "t", command: null, organizeOnly: false });

  it("a projeção dos cards não a apaga; a linha comum sem card some", () => {
    const comum: DeployBlockRow = { ...rows()[0], causeKey: `${BOARD}:system`, decider: "system", planSourced: undefined };
    const out = syncDeployBlocks([...rows(), comum], BOARD, [], { at: "t", command: null });
    expect(out.map((r) => r.causeKey)).toEqual([`${BOARD}:owner:?`]);
  });
  it("um card que entrou e saiu dela não a leva junto", () => {
    const cause = deployCausesOf(report([ENTREGA]), { pkg: BOARD, config })[0];
    const withCard = upsertDeployBlock(rows(), { board: BOARD, cardId: "c1", cause, at: "t", command: null });
    expect(withCard[0].cardIds).toEqual(["c1"]);
    const moved = upsertDeployBlock(withCard, { board: BOARD, cardId: "c1", cause: { ...cause, causeKey: `${BOARD}:owner:outra` }, at: "t", command: null });
    expect(moved.find((r) => r.causeKey === `${BOARD}:owner:?`)).toMatchObject({ cardIds: [], planSourced: true });
  });
  it("sem classe, mas comparável: o plano que lista OUTRA causa a fecha (a linha comum `owner:?` só fecha com o plano limpo)", () => {
    const outra = { status: "needs-human", report: report([PRECO]) };
    expect(judgePlanCauses(rows(), outra, config).dead).toEqual([`${BOARD}:owner:?`]);
    const comum = rows().map((r) => ({ ...r, planSourced: undefined, cardIds: ["c1"] }));
    expect(judgePlanCauses(comum, outra, config).dead).toEqual([]);
  });
  it("o livro guarda a marca (ida e volta pelo disco)", () => {
    const back = parseDeployBlocks(JSON.stringify({ version: 1, rows: rows() }));
    expect(back?.[0].planSourced).toBe(true);
    expect(parseDeployBlocks(JSON.stringify({ version: 1, rows: [{ ...rows()[0], planSourced: "sim" }] }))?.[0].planSourced).toBeUndefined();
  });
});

describe("remeasureBoardCauses — sem linha nenhuma, o plano é lido devagar para DESCOBRIR", () => {
  const policy = deployPolicyFromSettings({ launchers: ["publicar"] }, {});
  const measure = (cfg: BoardConfig, rows: DeployBlockRow[], now: number, force = false) => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(String(cmd));
      return { stdout: planOut([ENTREGA]), stderr: "" };
    };
    return remeasureBoardCauses(BOARD, cfg, rows, { exec, repoRoot: "/repo", now, policy, force }).then((v) => ({ v, calls }));
  };
  beforeEach(() => {
    resetRemeasureForTest();
    resetDiscoverForTest();
  });

  it("com o plano declarado: lê UMA vez por hora e devolve as causas e os pedidos que ele lista", async () => {
    const first = await measure(config, [], 0);
    expect(first.calls).toHaveLength(1);
    expect(first.v.planCauses?.map((c) => c.causeKey)).toEqual([`${BOARD}:owner:?`]);
    expect(first.v.approvals?.map((a) => a.subject.hash)).toEqual([hashOf("c")]);
    expect((await measure(config, [], 59 * 60_000)).calls).toEqual([]);
    expect((await measure(config, [], 60 * 60_000)).calls).toHaveLength(1);
    // o «Refazer» do operador mede na hora
    expect((await measure(config, [], 60 * 60_000 + 1, true)).calls).toHaveLength(1);
  });
  it("sem plano declarado ou board só de organização ⇒ não lê nada (descobrir nunca roda o deploy)", async () => {
    const semPlano = { ...config, deploy: { kind: "command", command: "./publicar feira" } } as unknown as BoardConfig;
    expect((await measure(semPlano, [], 0)).calls).toEqual([]);
    expect((await measure({ ...config, organizeOnly: true } as BoardConfig, [], 0)).calls).toEqual([]);
  });
  it("a janela da descoberta é por board", () => {
    expect(claimDiscover("a", 0)).toBe(true);
    expect(claimDiscover("a", 30 * 60_000)).toBe(false);
    expect(claimDiscover("b", 30 * 60_000)).toBe(true);
  });
});

describe("sweepDeployBlocks — o pedido do plano chega ao livro sem card, e sai com o plano", () => {
  let blocks: DeployBlockRow[];
  const released = vi.fn(async (): Promise<string[] | null> => []);
  const plan = report([ENTREGA]);
  const listed: RemeasureVerdict = { dead: [], present: [], approvals: plan.ownerApprovals, planCauses: planCausesOf({ status: "needs-human", report: plan }, BOARD, config) };
  const remeasure = vi.fn(async (): Promise<RemeasureVerdict> => listed);
  const deps = (over: Partial<DeployBlocksSweepDeps> = {}): DeployBlocksSweepDeps => ({
    readConfig: async () => config,
    readCards: async () => [] as Card[],
    write: async () => {},
    lastPlan: async () => null,
    breaker: { adoptCard: async () => ({}), forget: async () => {}, releaseCause: released },
    codeLanded: async () => new Set<string>(),
    mutateBlocks: async (fn) => (blocks = fn(blocks)),
    remeasure,
    reevaluate: async () => {},
    attribute: async () => [],
    systemText: systemTextOf,
    now: () => Date.UTC(2026, 9, 6, 1, 0),
    ...over,
  });
  beforeEach(() => {
    blocks = [];
    vi.clearAllMocks();
  });
  afterEach(() => resetRemeasureForTest());

  it("board sem card nenhum e sem linha: a re-medição descobre o pedido e a linha do plano nasce; a próxima passada a mantém", async () => {
    await sweepDeployBlocks(BOARD, deps());
    expect(remeasure).toHaveBeenCalledTimes(1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ causeKey: `${BOARD}:owner:?`, planSourced: true, cardIds: [], command: "./publicar feira" });
    await sweepDeployBlocks(BOARD, deps());
    expect(blocks).toHaveLength(1);
  });
  it("o plano deixou de listá-la ⇒ a linha fecha, mesmo se o disjuntor recusar soltar (ela não segura card)", async () => {
    await sweepDeployBlocks(BOARD, deps());
    remeasure.mockResolvedValueOnce({ dead: [`${BOARD}:owner:?`], present: [] });
    released.mockResolvedValueOnce(null);
    const r = await sweepDeployBlocks(BOARD, deps());
    expect(r.closedCauses).toEqual([`${BOARD}:owner:?`]);
    expect(blocks).toEqual([]);
  });
  it("board sem plano declarado e sem linha: nem chama a re-medição", async () => {
    const semPlano = { ...config, deploy: { kind: "command", command: "./publicar feira" } } as unknown as BoardConfig;
    await sweepDeployBlocks(BOARD, deps({ readConfig: async () => semPlano }));
    expect(remeasure).not.toHaveBeenCalled();
    expect(blocks).toEqual([]);
  });
  it("board só de organização: a re-medição pode até responder, a linha não nasce", async () => {
    await sweepDeployBlocks(BOARD, deps({ readConfig: async () => ({ ...config, organizeOnly: true }) as BoardConfig }));
    expect(blocks).toEqual([]);
  });
});
