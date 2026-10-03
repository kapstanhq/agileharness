// A CAUSA de uma publicação parada (deploy-blocks.ts). A regra que este módulo garante: várias paradas de causas
// diferentes não viram um monte de alarmes no Inbox quando só uma parte é decisão de negócio. As fixtures são
// INVENTADAS para exercitar essa regra: um plano de um deploy declarado (pacote `oficina`, aparado ao que a régua lê) e
// títulos/detalhes de findings como o revert antigo os escreveria.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, DeployCause, Finding } from "@/lib/storymap/types";
import { DEPLOY_FAILURE_FINDING_ID } from "@/lib/storymap/demands";
import { parseDeployExit3Report, type DeployExit3Report, type PlanBlockEntry } from "./deploy-proof";
import { defaultExec } from "./worktree";
import {
  attributeGuardedFiles,
  attributeOwnerFiles,
  backfillDeployCause,
  carriesNoCode,
  causeKeyOf,
  claimRemeasure,
  commitRangeDiffCommand,
  deployCausesOf,
  dominantCause,
  dropDeployBlock,
  entryVerdict,
  failureCause,
  guardedOwnerFiles,
  judgePlanCauses,
  ownerTitleOf,
  unreadableDeployBlocksFile,
  parseDeployBlocks,
  mutateDeployBlocks,
  readDeployBlocks,
  resetRemeasureForTest,
  sweepDeployBlocks,
  syncDeployBlocks,
  systemTextOf,
  upsertDeployBlock,
  withBackfilledCause,
  type DeployBlockRow,
  type DeployBlocksSweepDeps,
} from "./deploy-blocks";

// O plano que o alvo imprime na saída 3 (a última linha JSON com `status`). Inventado: pacote `oficina`, a build
// compartilhada, um worker sem classe, um web que monta a fatura e uma escrita cruzada que o alvo marcou do dono.
const PLAN_HEAD = "7e1c90ab34d5f6a7b8c9d0e1f2a3b4c5d6e7f801";
const billsWhy = "bills-customer: muda o total da fatura do cliente";
const planLog = JSON.stringify({
  package: "oficina",
  head: PLAN_HEAD,
  status: "needs-human",
  plan: {
    package: "oficina",
    head: PLAN_HEAD,
    status: "needs-human",
    human: [
      { unit: "face:oficina", file: "tsconfig.base.json", rule: "build-input-shared", why: "configuração de build lida por todos os apps do monorepo" },
      { unit: "render-worker", file: "packages/oficina/workers/render-pdf.ts", rule: "no-class-declared", why: null },
      { unit: "web-app", file: "packages/oficina/web/lib/fatura.ts", rule: "bills-customer", why: billsWhy },
      { unit: "render-worker", file: "packages/oficina/workers/parcelar.ts", rule: "cross-unit-write", why: billsWhy, owner: true },
    ],
    units: [
      { id: "web-app", class: "web", files: 2 },
      { id: "render-worker", class: "human", files: 2 },
    ],
    face: { app: "oficina", affected: true, files: 0 },
    steps: [],
  },
});
const LIVE_PLAN = parseDeployExit3Report(`[deploy oficina] $ ./ship oficina --auto\n${planLog}\n[deploy oficina] finished exit 3`);

const config = {
  id: "armazem",
  name: "Armazém",
  statuses: [
    { id: "desenvolver", name: "Dev" },
    { id: "revisao", name: "Aprovar entrega" },
    { id: "release", name: "Liberar", autorun: true },
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  deploy: { kind: "command", command: "./ship oficina --auto", planCommand: "./ship oficina --plan" },
  autonomy: { mode: "ultra", deployRuleClasses: { "bills-customer": "money", "paid-vendor-call": "money" } },
} as unknown as BoardConfig;

const entry = (o: Partial<PlanBlockEntry>): PlanBlockEntry => ({ unit: "u", file: null, rule: null, why: null, owner: false, decider: null, ...o });

describe("entryVerdict — a régua ÚNICA de quem decide uma entrada do plano", () => {
  it.each([
    ["regra mapeada para classe do dono ⇒ dono, com a classe", entry({ rule: "bills-customer" }), { decider: "owner", ownerClass: "money" }],
    ["regra NÃO mapeada (unidade sem classe) ⇒ sistema", entry({ rule: "no-class-declared" }), { decider: "system", ownerClass: null }],
    ["rosto compartilhado ⇒ sistema", entry({ rule: "build-input-shared" }), { decider: "system", ownerClass: null }],
    ["leitura que falhou (diff-unreadable) ⇒ sistema", entry({ rule: "diff-unreadable" }), { decider: "system", ownerClass: null }],
    ["regra ILEGÍVEL ⇒ dono (fail-closed)", entry({ rule: null }), { decider: "owner", ownerClass: null }],
    ["entrada que o alvo marcou do dono: a classe do guard nomeado no `why`", entry({ rule: "cross-unit-write", owner: true, why: "bills-customer: muda o total da fatura" }), { decider: "owner", ownerClass: "money" }],
    ["entrada marcada do dono com guard sem classe ⇒ dono sem classe", entry({ rule: "cross-unit-write", owner: true, why: "outro: x" }), { decider: "owner", ownerClass: null }],
    ["escrita cruzada SEM dinheiro nem marca do dono ⇒ sistema", entry({ rule: "cross-unit-write", why: null }), { decider: "system", ownerClass: null }],
    ["o ALVO declara sistema: respeitado mesmo com regra de dinheiro", entry({ rule: "bills-customer", decider: "system" }), { decider: "system", ownerClass: null }],
    ["o ALVO declara dono: respeitado mesmo com regra sem classe", entry({ rule: "no-class-declared", decider: "owner" }), { decider: "owner", ownerClass: null }],
  ] as const)("%s", (_t, e, want) => {
    expect(entryVerdict(e, config)).toEqual(want);
  });

  // Reescrito de propósito: o teste antigo travava `{ autonomy: {} }` ⇒ «bills-customer é do sistema». Esse
  // board está em modo HUMANO, onde ninguém age sozinho (a recuperação do sistema só roda no só-negócio): o revert dizia
  // «nada a fazer da sua parte», o disjuntor esgotava e o card ficava parado em Liberar sem dono.
  it("board em modo HUMANO (sem bloco autonomy): ninguém age sozinho — toda entrada é do dono, como antes", () => {
    const human = { ...config, autonomy: undefined } as unknown as BoardConfig;
    expect(entryVerdict(entry({ rule: "bills-customer" }), human)).toEqual({ decider: "owner", ownerClass: null });
    expect(entryVerdict(entry({ rule: "no-class-declared" }), { autonomy: {} } as BoardConfig).decider).toBe("owner");
    // nem o «sistema» declarado pelo alvo vale: não há sistema que aja no modo humano
    expect(entryVerdict(entry({ rule: "no-class-declared", decider: "system" }), human).decider).toBe("owner");
    // com o mapa declarado, o pedido nomeia a classe
    const humanWithMap = { autonomy: { mode: "human", deployRuleClasses: { "bills-customer": "money" } } } as unknown as BoardConfig;
    expect(entryVerdict(entry({ rule: "bills-customer" }), humanWithMap)).toEqual({ decider: "owner", ownerClass: "money" });
    // a mesma régua chega à causa: a saída 3 do modo humano é needs-human, nunca «trabalho do sistema»
    expect(failureCause({ phase: "needs-human", pkg: "acme", humanRules: ["bills-customer"] }, { board: "acme", cardId: "c", config: human })).toMatchObject({ decider: "owner", phase: "needs-human" });
    expect(deployCausesOf({ ...parseDeployExit3Report(""), status: "needs-units" }, { pkg: "p", config: human })[0]).toMatchObject({ decider: "owner", phase: "needs-human" });
  });

  it("board só-negócio SEM o mapa de regras: não se sabe se a regra é de dinheiro ⇒ dono (fail-closed); o declarado pelo alvo vale", () => {
    const ultraNoMap = { autonomy: { mode: "ultra" } } as unknown as BoardConfig;
    expect(entryVerdict(entry({ rule: "bills-customer" }), ultraNoMap)).toEqual({ decider: "owner", ownerClass: null });
    expect(entryVerdict(entry({ rule: "no-class-declared", decider: "system" }), ultraNoMap).decider).toBe("system");
    expect(entryVerdict(entry({ rule: "x", owner: true }), null).decider).toBe("owner");
  });
});

describe("deployCausesOf — as causas de uma saída 3", () => {
  it("o plano de exemplo: UMA causa do dono (dinheiro: o arquivo da fatura + a escrita cruzada que o alvo marcou) e UMA do sistema", () => {
    const causes = deployCausesOf(LIVE_PLAN, { pkg: "armazem", config });
    expect(causes.map((c) => [c.causeKey, c.decider, c.phase])).toEqual([
      ["armazem:owner:money", "owner", "needs-human"],
      ["armazem:system", "system", "needs-units"],
    ]);
    const [money, system] = causes;
    expect(money).toMatchObject({ ownerClass: "money", units: ["web-app", "render-worker"], rules: ["bills-customer", "cross-unit-write"], headSha: LIVE_PLAN.head });
    expect(system.units.sort()).toEqual(["face:oficina", "render-worker"]);
    expect(system.rules.sort()).toEqual(["build-input-shared", "no-class-declared"]);
    // o rosto também tinha mudança: a prova por unidade não vale como superconjunto (fail-closed)
    expect(money.driftUnits).toBeUndefined();
    expect(dominantCause(causes)).toBe(money);
    expect(guardedOwnerFiles(LIVE_PLAN, config)).toContain("packages/oficina/workers/parcelar.ts");
  });

  it("só lacunas do sistema ⇒ só a causa do sistema (needs-units); a chave não depende do HEAD", () => {
    const r: DeployExit3Report = { ...LIVE_PLAN, head: "abc", entries: LIVE_PLAN.entries.filter((e) => e.rule === "no-class-declared") };
    expect(deployCausesOf(r, { pkg: "armazem", config })).toEqual([expect.objectContaining({ causeKey: "armazem:system", decider: "system", phase: "needs-units", headSha: "abc" })]);
  });

  it("saída 3 sem nada legível ⇒ UMA causa do dono sem classe; o alvo que já declara needs-units ⇒ do sistema", () => {
    const empty = parseDeployExit3Report("");
    expect(deployCausesOf({ ...empty, status: "needs-human" }, { pkg: "p", config })[0]).toMatchObject({ decider: "owner", ownerClass: null, causeKey: "p:owner:?" });
    expect(deployCausesOf({ ...empty, status: "needs-units" }, { pkg: "p", config })[0]).toMatchObject({ decider: "system", causeKey: "p:system" });
  });

  it("needs-proof é uma causa do sistema (o produtor providencia a prova)", () => {
    const r = { ...parseDeployExit3Report(""), status: "needs-proof" as const };
    expect(deployCausesOf(r, { pkg: "p", config })).toEqual([expect.objectContaining({ causeKey: "p:proof", decider: "system", phase: "needs-proof" })]);
  });

  it("o plano sem rosto afetado dá as unidades com mudança (superconjunto para a prova por unidade)", () => {
    const log = JSON.stringify({ status: "needs-human", head: "h1", plan: { human: [{ unit: "batch-x", rule: "no-class-declared" }], units: [{ id: "web-app" }, { id: "batch-x" }], face: { affected: false } } });
    expect(deployCausesOf(parseDeployExit3Report(log), { pkg: "p", config })[0].driftUnits).toEqual(["web-app", "batch-x"]);
  });
});

describe("failureCause — toda fase vira causa (o Inbox e o disjuntor contam por causa)", () => {
  const ctx = { board: "armazem", cardId: "story-a", config };
  it("transitórias: uma por pacote; a promoção é do diff do card", () => {
    expect(failureCause({ phase: "freshness" }, ctx)).toMatchObject({ causeKey: "armazem:freshness", decider: "system" });
    expect(failureCause({ phase: "deploy", pkg: "armazem" }, ctx).causeKey).toBe("armazem:deploy");
    expect(failureCause({ phase: "release" }, ctx).causeKey).toBe("armazem:release:story-a");
    expect(failureCause({}, ctx).causeKey).toBe("armazem:deploy");
  });
  it("saída 3 sem o relatório inteiro (legado): as regras decidem do mesmo jeito", () => {
    expect(failureCause({ phase: "needs-human", humanRules: ["paid-vendor-call"] }, ctx)).toMatchObject({ decider: "owner", ownerClass: "money" });
    expect(failureCause({ phase: "needs-human", humanRules: ["no-class-declared"] }, ctx)).toMatchObject({ decider: "system", phase: "needs-units" });
    expect(failureCause({ phase: "needs-human" }, ctx)).toMatchObject({ decider: "owner", ownerClass: null }); // ilegível
  });
});

// ── um estado com vários cards parados ─────────────────────────────────────────────────────────────────────────

const legacyNeedsHuman = (cls: string | null, units: string[]): Finding => ({
  id: DEPLOY_FAILURE_FINDING_ID,
  lens: "general",
  severity: "high",
  status: "open",
  deployPhase: "needs-human",
  title: cls ? `Precisa de você — ${cls}: há unidade que só você publica` : "Precisa de você: há unidade que só você publica",
  detail:
    `A publicação de armazem não aconteceu (saída 3): produção segue como estava. ` +
    `Unidade(s) que só você publica: ${units.join(", ")}. O comando disse:\n✋ …`,
  suggestion: "✋ deploy-auto … há mudança que só você publica",
});
const legacyPhase = (phase: "freshness" | "release"): Finding => ({ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", deployPhase: phase, title: phase, detail: phase });
const code = { commitRange: { base: "b0", head: "h0" }, stagedAt: "2026-05-14", deployTargets: ["armazem"] };
const liveCard = (id: string, f: Finding, extra: Partial<Card> = {}): Card => ({ id, type: "story", title: id, status: "release", findings: [f], ...extra }) as unknown as Card;

/** Os 5 cards de «Liberar» com finding de publicação aberto no mesmo momento (um instantâneo inventado). */
const LIVE_CARDS: Card[] = [
  liveCard("story-ex9652", legacyPhase("freshness"), { stagedAt: "2026-05-14" }),
  liveCard("story-ex9657", legacyNeedsHuman(null, ["face:oficina"]), code),
  liveCard("story-ex9661", legacyNeedsHuman(null, ["face:oficina"]), { deployTargets: ["armazem"] }), // sem código
  liveCard("story-ex9668", legacyNeedsHuman("Dinheiro e preço", ["web-app", "render-worker"]), { commitRange: { base: "b1", head: "h1" }, deployTargets: ["armazem"] }),
  liveCard("story-ex9674", legacyPhase("release"), code),
];

describe("backfill — os findings anteriores às causas", () => {
  it("as unidades do finding cruzadas com o último plano: as lacunas viram do SISTEMA, o dinheiro segue do dono", () => {
    const cause = (id: string) => {
      const c = LIVE_CARDS.find((x) => x.id === id)!;
      return backfillDeployCause(c.findings[0], { board: "armazem", cardId: id, deployTargets: c.deployTargets, config, lastPlan: LIVE_PLAN });
    };
    expect(cause("story-ex9657")).toMatchObject({ causeKey: "armazem:system", decider: "system", phase: "needs-units", rules: ["build-input-shared"] });
    expect(cause("story-ex9668")).toMatchObject({ causeKey: "armazem:owner:money", decider: "owner", ownerClass: "money" });
    expect(cause("story-ex9652")).toMatchObject({ causeKey: "armazem:freshness", decider: "system" });
    expect(cause("story-ex9674")).toMatchObject({ causeKey: "armazem:release:story-ex9674" });
  });

  it("sem plano que cubra as unidades: a classe do título ⇒ dono com ela; nada ⇒ dono sem classe (fail-closed)", () => {
    const f = legacyNeedsHuman(null, ["batch-y"]);
    expect(backfillDeployCause(f, { board: "armazem", cardId: "a", config, lastPlan: LIVE_PLAN })).toMatchObject({ decider: "owner", ownerClass: null });
    expect(backfillDeployCause(legacyNeedsHuman("Dinheiro e preço", ["batch-y"]), { board: "armazem", cardId: "a", config, lastPlan: null })).toMatchObject({ decider: "owner", ownerClass: "money", causeKey: "armazem:owner:money" });
  });

  it("o finding cuja causa é do sistema deixa de dizer «Precisa de você» e perde a receita «só você publica»", () => {
    const f = legacyNeedsHuman(null, ["render-worker"]);
    const cause: DeployCause = { pkg: "armazem", phase: "needs-units", units: ["render-worker"], rules: ["no-class-declared"], ownerClass: null, decider: "system", causeKey: "armazem:system" };
    const next = withBackfilledCause(f, cause, (c) => systemTextOf(c, "2026-05-14"));
    expect(next).toMatchObject({ deployPhase: "needs-units", deployCause: cause, status: "open", id: DEPLOY_FAILURE_FINDING_ID });
    expect(`${next.title} ${next.detail}`).not.toMatch(/Precisa de você|só você/);
    expect(next.suggestion).toBeUndefined();
    // a do dono ganha a causa e o título passa a nomear a DECISÃO (não «só você publica»)
    const owner: DeployCause = { ...cause, decider: "owner", ownerClass: "money", phase: "needs-human", causeKey: "armazem:owner:money" };
    const o = withBackfilledCause(legacyNeedsHuman("Dinheiro e preço", ["web-app"]), owner, () => ({ title: "x" }), ownerTitleOf("Dinheiro e preço"));
    expect(o).toMatchObject({ deployPhase: "needs-human", deployCause: owner, title: "Precisa de você — Dinheiro e preço: a publicação espera a sua decisão" });
  });
});

describe("o livro (deploy-blocks.json)", () => {
  const at = "2026-05-14T20:00:00Z";
  const money = deployCausesOf(LIVE_PLAN, { pkg: "armazem", config })[0];

  it("3 reverts da MESMA causa ⇒ 1 linha, com os 3 cards", () => {
    let rows: DeployBlockRow[] = [];
    for (let i = 1; i <= 3; i++) rows = upsertDeployBlock(rows, { board: "armazem", cardId: `story-${i}`, cause: money, at, command: "just deploy-auto-x" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ causeKey: "armazem:owner:money", decider: "owner", ownerClass: "money", cardIds: ["story-1", "story-2", "story-3"], firstAt: at, planHead: LIVE_PLAN.head });
  });

  it("o card que muda de causa sai da linha antiga (linha vazia some); outros boards intocados", () => {
    const sys = deployCausesOf(LIVE_PLAN, { pkg: "armazem", config })[1];
    let rows = upsertDeployBlock([], { board: "armazem", cardId: "a", cause: money, at, command: null });
    rows = upsertDeployBlock(rows, { board: "outro", cardId: "a", cause: money, at, command: null });
    rows = upsertDeployBlock(rows, { board: "armazem", cardId: "a", cause: sys, at, command: null });
    expect(rows.map((r) => `${r.board}/${r.causeKey}`).sort()).toEqual(["armazem/armazem:system", "outro/armazem:owner:money"]);
    expect(dropDeployBlock(rows, "armazem", "armazem:system").map((r) => r.board)).toEqual(["outro"]);
  });

  it("FIXTURE DO ESTADO com 5 cards parados: os 5 findings viram 4 linhas, e só a causa da fatura é do dono", () => {
    const open = LIVE_CARDS.map((c) => ({
      cardId: c.id,
      cause: backfillDeployCause(c.findings[0], { board: "armazem", cardId: c.id, deployTargets: c.deployTargets, config, lastPlan: LIVE_PLAN }),
    }));
    const rows = syncDeployBlocks([], "armazem", open, { at, command: "just deploy-auto-x" });
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.decider === "owner")).toEqual([expect.objectContaining({ causeKey: "armazem:owner:money", rules: expect.arrayContaining(["bills-customer"]) })]);
    expect(rows.find((r) => r.causeKey === "armazem:system")?.cardIds).toEqual(["story-ex9657", "story-ex9661"]);
  });

  it("a projeção cura o livro: card resolvido por qualquer caminho sai; firstAt da causa que segue é preservado", () => {
    const first = syncDeployBlocks([], "armazem", [{ cardId: "a", cause: money }, { cardId: "b", cause: money }], { at: "t1", command: null });
    const later = syncDeployBlocks(first, "armazem", [{ cardId: "b", cause: money }], { at: "t2", command: null });
    expect(later).toEqual([expect.objectContaining({ cardIds: ["b"], firstAt: "t1" })]);
    expect(syncDeployBlocks(later, "armazem", [], { at: "t3", command: null })).toEqual([]);
  });

  it("gravado em disco, atômico e serializado (duas escritas simultâneas não perdem linha)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deploy-blocks-"));
    try {
      const file = path.join(dir, "deploy-blocks.json");
      await Promise.all([
        mutateDeployBlocks((r) => upsertDeployBlock(r, { board: "armazem", cardId: "a", cause: money, at, command: null }), file),
        mutateDeployBlocks((r) => upsertDeployBlock(r, { board: "armazem", cardId: "b", cause: money, at, command: null }), file),
      ]);
      expect((await readDeployBlocks(file))[0].cardIds).toEqual(["a", "b"]);
      expect(await readDeployBlocks(path.join(dir, "nada.json"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ILEGÍVEL NÃO É VAZIO, também para quem ESCREVE: o escritor lia o que não se lê como `[]` e gravava por cima.
  describe("o livro que não se lê não é apagado em silêncio", () => {
    const withDir = async (run: (file: string) => Promise<void>) => {
      const dir = mkdtempSync(path.join(tmpdir(), "deploy-blocks-"));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await run(path.join(dir, "deploy-blocks.json"));
      } finally {
        err.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const add = (cardId: string, board = "armazem") => (r: DeployBlockRow[]) => upsertDeployBlock(r, { board, cardId, cause: money, at, command: null });

    it("arquivo de versão mais nova (a ferramenta voltou de versão): fica guardado ao lado, e o livro recomeça EM RECUPERAÇÃO", async () => {
      await withDir(async (file) => {
        const newer = JSON.stringify({ version: 2, rows: [{ board: "armazem", key: "formato-novo", granted: ["sha256:abc"] }] });
        writeFileSync(file, newer, "utf8");
        await mutateDeployBlocks(add("a"), file);
        expect(readFileSync(unreadableDeployBlocksFile(file), "utf8")).toBe(newer); // nada foi perdido
        const raw = readFileSync(file, "utf8");
        expect(JSON.parse(raw)).toMatchObject({ version: 1, recovering: [] });
        // em recuperação o livro não fala por board nenhum: «a causa não está no livro» ainda não prova nada
        expect(parseDeployBlocks(raw)).toBeNull();
        expect(parseDeployBlocks(raw, "armazem")).toBeNull();
      });
    });

    it("a varredura re-sincroniza o board ⇒ o livro volta a falar por ELE, e só por ele", async () => {
      await withDir(async (file) => {
        writeFileSync(file, "{ json cortado", "utf8");
        await mutateDeployBlocks(add("a"), file);
        await mutateDeployBlocks((r) => r, file, { swept: "armazem" });
        const raw = readFileSync(file, "utf8");
        expect(parseDeployBlocks(raw, "armazem")?.map((r) => r.causeKey)).toEqual(["armazem:owner:money"]);
        expect(parseDeployBlocks(raw, "outro")).toBeNull();
        expect(parseDeployBlocks(raw)).toBeNull();
        // repetir a marca não duplica; o segundo board entra quando a varredura passa por ele
        await mutateDeployBlocks((r) => r, file, { swept: "armazem" });
        await mutateDeployBlocks((r) => r, file, { swept: "outro" });
        expect(JSON.parse(readFileSync(file, "utf8")).recovering).toEqual(["armazem", "outro"]);
        expect(parseDeployBlocks(readFileSync(file, "utf8"), "outro")).not.toBeNull();
      });
    });

    it("UMA linha que não se lê: as outras seguem, a ruim fica guardada ao lado e o livro entra em recuperação", async () => {
      await withDir(async (file) => {
        await mutateDeployBlocks(add("a"), file);
        const good = JSON.parse(readFileSync(file, "utf8"));
        const broken = JSON.stringify({ version: 1, rows: [...good.rows, { board: "armazem", causeKey: 42 }] });
        writeFileSync(file, broken, "utf8");
        const rows = await mutateDeployBlocks(add("b"), file);
        expect(rows.map((r) => r.cardIds)).toEqual([["a", "b"]]);
        expect(readFileSync(unreadableDeployBlocksFile(file), "utf8")).toBe(broken);
        expect(JSON.parse(readFileSync(file, "utf8")).recovering).toEqual([]);
      });
    });

    it("livro novo (arquivo ausente) e livro são NÃO entram em recuperação; `swept` neles não grava a marca", async () => {
      await withDir(async (file) => {
        await mutateDeployBlocks(add("a"), file, { swept: "armazem" });
        const raw = readFileSync(file, "utf8");
        expect(JSON.parse(raw).recovering).toBeUndefined();
        expect(existsSync(unreadableDeployBlocksFile(file))).toBe(false);
        expect(parseDeployBlocks(raw)?.length).toBe(1); // julgável por inteiro, com ou sem board
        expect(parseDeployBlocks(raw, "qualquer")?.length).toBe(1);
      });
    });
  });
});

describe("atribuição — o item do dono aponta o card que CARREGA o arquivo guardado", () => {
  it("só os cards cujo diff toca um arquivo guardado", () => {
    const files = new Map([
      ["story-ex9679", ["packages/x/parcelar.ts", "a.ts"]],
      ["story-ex9683", []],
      ["story-z", ["b.ts"]],
    ]);
    expect(attributeGuardedFiles(["packages/x/parcelar.ts"], files)).toEqual(["story-ex9679"]);
    expect(attributeGuardedFiles([], files)).toEqual([]);
  });
  it("o card que carrega MAIS arquivos guardados vem primeiro (é para ele que o item do dono aponta)", () => {
    const files = new Map([
      ["story-ex9690", ["shared/desconto.ts"]],
      ["story-ex9683", ["web/fatura.ts", "shared/juros.ts"]],
      ["story-ex9679", ["web/fatura.ts", "shared/juros.ts", "shared/desconto.ts"]],
      ["story-ex9652", ["shared/juros.ts", "shared/desconto.ts"]],
    ]);
    // 3 arquivos guardados primeiro, depois 2; no empate (2 cada) vale a ordem em que os cards chegaram; 1 fica por último
    expect(attributeGuardedFiles(["web/fatura.ts", "shared/juros.ts", "shared/desconto.ts", "jobs/cobrar.ts"], files)).toEqual(["story-ex9679", "story-ex9683", "story-ex9652", "story-ex9690"]);
  });
});

// O `commitRange` é board-data (um agente o escreve no worktree, o train o integra) e vira um `git diff` num shell, sem
// clique, no processo do serviço. Só um sha chega lá; o resto deixa o card de fora.
describe("o intervalo do card vira execução — só sha chega ao shell", () => {
  it("commitRangeDiffCommand: dois shas ⇒ o comando; qualquer outra coisa ⇒ null", () => {
    expect(commitRangeDiffCommand({ base: "9d4f21a6", head: "C07AB3E9f1" })).toBe("git diff --name-only 9d4f21a6 C07AB3E9f1");
    for (const bad of ["$(touch /tmp/x)", "`id`", "HEAD", "--output=/tmp/x", "abc", "a".repeat(65), "5a1c 90e2", ""]) {
      expect(commitRangeDiffCommand({ base: bad, head: "c07ab3e9" }), bad).toBeNull();
      expect(commitRangeDiffCommand({ base: "c07ab3e9", head: bad }), bad).toBeNull();
    }
  });

  it("attributeOwnerFiles com $(…) no intervalo: nada executa (o marcador não nasce) e o card fica de fora", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "deploy-blocks-inj-"));
    try {
      const marker = path.join(dir, "pwned");
      const evil = { id: "evil", type: "story", status: "release", commitRange: { base: `$(touch ${marker})`, head: "HEAD" } } as unknown as Card;
      const out = await attributeOwnerFiles(["x"], [evil], config, { exec: defaultExec, repoRoot: dir });
      expect(out).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("intervalo de shas: o diff roda e o card que toca o arquivo guardado é atribuído", async () => {
    const calls: string[] = [];
    const exec = (async (cmd: string) => {
      calls.push(cmd);
      return { stdout: "packages/x/parcelar.ts\n", stderr: "" };
    }) as never;
    const ok = { id: "story-ex9679", type: "story", status: "revisao", commitRange: { base: "b0b0b0b", head: "c1c1c1c" } } as unknown as Card;
    const evil = { id: "evil", type: "story", status: "release", commitRange: { base: "`id`", head: "c1c1c1c" } } as unknown as Card;
    expect(await attributeOwnerFiles(["packages/x/parcelar.ts"], [evil, ok], config, { exec, repoRoot: "/r" })).toEqual(["story-ex9679"]);
    expect(calls).toEqual(["git diff --name-only b0b0b0b c1c1c1c"]);
  });
});

describe("judgePlanCauses — o plano lido agora fecha as causas que não lista mais", () => {
  const rows = syncDeployBlocks(
    [],
    "armazem",
    [
      { cardId: "a", cause: deployCausesOf(LIVE_PLAN, { pkg: "armazem", config })[0] },
      { cardId: "b", cause: deployCausesOf(LIVE_PLAN, { pkg: "armazem", config })[1] },
      { cardId: "c", cause: failureCause({ phase: "freshness", pkg: "armazem" }, { board: "armazem", cardId: "c", config }) },
    ],
    { at: "t", command: null },
  );
  it("plano que não recusa nada (nothing/ready) ⇒ todas as causas da saída 3 morrem; a de frescor não é dele", () => {
    expect(judgePlanCauses(rows, { status: "nothing", report: parseDeployExit3Report("") }, config).dead.sort()).toEqual(["armazem:owner:money", "armazem:system"]);
  });
  it("plano que só tem a lacuna do sistema ⇒ a do dinheiro morreu (o dono liberou), a do sistema segue", () => {
    const onlySystem = { ...LIVE_PLAN, entries: LIVE_PLAN.entries.filter((e) => e.rule === "no-class-declared") };
    const v = judgePlanCauses(rows, { status: "needs-human", report: onlySystem }, config);
    expect(v.dead).toEqual(["armazem:owner:money"]);
    expect(v.present.map((c) => c.causeKey)).toEqual(["armazem:system"]);
  });
  it("plano ilegível ou inconclusivo (refused) ⇒ nada morre (fail-closed)", () => {
    expect(judgePlanCauses(rows, null, config).dead).toEqual([]);
    expect(judgePlanCauses(rows, { status: "refused", report: parseDeployExit3Report("") }, config).dead).toEqual([]);
  });
  // A prova que falta não é medida pelo plano em modo leitura (o dry-run diz que a PRODUZIRIA e devolve ready): a linha
  // dela pertence ao produtor da prova, cujo único âncora é o finding needs-proof aberto (deploy-proof-producer.ts).
  it("a linha da PROVA (needs-proof) nunca morre pelo plano — nem com dinheiro de outro card (needs-human), nem com ready", () => {
    const proof = failureCause({ phase: "needs-proof", pkg: "armazem" }, { board: "armazem", cardId: "p1", config });
    expect(proof).toMatchObject({ causeKey: "armazem:proof", phase: "needs-proof" });
    const withProof = [...rows, ...syncDeployBlocks([], "armazem", [{ cardId: "p1", cause: proof }], { at: "t", command: null })];
    const moneyOnly = { ...LIVE_PLAN, entries: LIVE_PLAN.entries.filter((e) => e.rule === "bills-customer") };
    expect(judgePlanCauses(withProof, { status: "needs-human", report: moneyOnly }, config).dead).toEqual(["armazem:system"]);
    expect(judgePlanCauses(withProof, { status: "ready", report: parseDeployExit3Report("") }, config).dead.sort()).toEqual(["armazem:owner:money", "armazem:system"]);
  });
  // A chave do dono SEM classe nasce de um revert cujo log não trouxe o plano legível: o plano que lista outra causa não
  // a representa (não sabe dizer que «o que não se leu» sumiu) — só o plano limpo a fecha. Sem isso a borda soltava a
  // causa a cada janela e o deploy se repetia sem fim (a chave do revert e a do plano nunca concordavam).
  it("a causa do dono SEM classe (`owner:?`) só morre com o plano limpo (nothing/ready)", () => {
    const unknown = failureCause({ phase: "needs-human", pkg: "armazem" }, { board: "armazem", cardId: "u", config });
    expect(unknown.causeKey).toBe("armazem:owner:?");
    const only = syncDeployBlocks([], "armazem", [{ cardId: "u", cause: unknown }], { at: "t", command: null });
    expect(judgePlanCauses(only, { status: "needs-human", report: LIVE_PLAN }, config).dead).toEqual([]);
    expect(judgePlanCauses(only, { status: "needs-units", report: { ...LIVE_PLAN, entries: [] } }, config).dead).toEqual([]);
    expect(judgePlanCauses(only, { status: "nothing", report: parseDeployExit3Report("") }, config).dead).toEqual(["armazem:owner:?"]);
  });
  it("no máximo uma re-medição por board a cada 15 min", () => {
    resetRemeasureForTest();
    expect(claimRemeasure("armazem", 0)).toBe(true);
    expect(claimRemeasure("armazem", 14 * 60_000)).toBe(false);
    expect(claimRemeasure("outro", 60_000)).toBe(true);
    expect(claimRemeasure("armazem", 15 * 60_000)).toBe(true);
  });
});

describe("sweepDeployBlocks — a varredura", () => {
  let cards: Card[];
  let blocks: DeployBlockRow[];
  /** os boards que a varredura declarou re-sincronizados (a projeção inteira gravada). */
  const swept: string[] = [];
  const breaker = { adoptCard: vi.fn(async () => ({})), forget: vi.fn(async () => {}), releaseCause: vi.fn(async (): Promise<string[] | null> => []) };
  const reevaluate = vi.fn(async (_b: string, _c: string) => {});
  const remeasure = vi.fn(async () => ({ dead: [] as string[], present: [] as DeployCause[] }));
  const deps = (): DeployBlocksSweepDeps => ({
    readConfig: async () => config,
    readCards: async () => cards,
    write: async (_b, id, fn) => {
      const i = cards.findIndex((c) => c.id === id);
      const next = fn(cards[i]);
      if (next) cards[i] = next;
    },
    lastPlan: async () => LIVE_PLAN,
    breaker,
    codeLanded: async () => new Set<string>(),
    mutateBlocks: async (fn, opts) => {
      if (opts?.swept) swept.push(opts.swept);
      return (blocks = fn(blocks));
    },
    remeasure,
    reevaluate,
    attribute: async (guarded) => (guarded.some((f) => f.includes("parcelar")) ? ["story-ex9679"] : []),
    systemText: systemTextOf,
    now: () => Date.UTC(2026, 4, 14, 22, 45),
  });
  beforeEach(() => {
    cards = structuredClone(LIVE_CARDS);
    blocks = [];
    swept.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => resetRemeasureForTest());

  const open = (id: string) => cards.find((c) => c.id === id)!.findings.find((f) => f.id === DEPLOY_FAILURE_FINDING_ID)!;

  it("o estado com 5 cards parados em UMA passada: todo finding aberto ganha causa, os sem código saem, o livro tem 4 causas e só uma do dono", async () => {
    const r = await sweepDeployBlocks("armazem", deps());
    expect(r.noCode).toEqual(["story-ex9661"]);
    expect(open("story-ex9661").status).toBe("fixed");
    expect(open("story-ex9661").detail).toContain("não declara código");
    expect(breaker.forget).toHaveBeenCalledWith("armazem", "story-ex9661");
    expect(reevaluate.mock.calls.map((c) => c[1]).sort()).toEqual(["story-ex9661"]); // a cascata os leva; o passo de publicar os assenta
    for (const c of cards) {
      const f = open(c.id);
      if (f.status === "open") expect(f.deployCause, c.id).toBeDefined();
    }
    expect(open("story-ex9657")).toMatchObject({ deployPhase: "needs-units", deployCause: { causeKey: "armazem:system" } });
    expect(open("story-ex9668")).toMatchObject({ deployPhase: "needs-human", deployCause: { causeKey: "armazem:owner:money", ownerClass: "money" } });
    for (const c of cards) if (open(c.id).status === "open") expect(`${open(c.id).title}`, c.id).not.toMatch(/só você publica/);
    expect(blocks).toHaveLength(4);
    // a projeção inteira do board foi gravada: num livro em recuperação é o que o torna julgável para ele de novo
    expect(swept).toEqual(["armazem"]);
    expect(blocks.filter((b) => b.decider === "owner").map((b) => b.causeKey)).toEqual(["armazem:owner:money"]);
    // o item do dono aponta o card que CARREGA o código de pagamento (não os cards parados por ele)
    expect(blocks.find((b) => b.decider === "owner")?.attributedCard).toBe("story-ex9679");
    expect(open("story-ex9668").deployCause?.attributedCardIds).toEqual(["story-ex9679"]);
    expect(breaker.adoptCard).toHaveBeenCalledWith("armazem", "story-ex9657", "armazem:system", "needs-units");
    // segunda passada: nada a completar (idempotente), o livro igual
    const before = structuredClone(blocks);
    const again = await sweepDeployBlocks("armazem", deps());
    expect(again.backfilled).toEqual([]);
    expect(blocks).toEqual(before);
  });

  it("causa MORTA na re-medição ⇒ os findings dela fecham sem clique, a linha do disjuntor vence agora e a do livro some", async () => {
    remeasure.mockResolvedValueOnce({ dead: ["armazem:freshness"], present: [] });
    const r = await sweepDeployBlocks("armazem", deps());
    expect(r.closedCauses).toEqual(["armazem:freshness"]);
    expect(open("story-ex9652")).toMatchObject({ status: "fixed", statusBy: "system:causa-encerrada" });
    expect(open("story-ex9652").detail).toContain("preflight de frescor passou");
    expect(breaker.releaseCause).toHaveBeenCalledWith("armazem", "armazem:freshness");
    expect(blocks.some((b) => b.causeKey === "armazem:freshness")).toBe(false);
    expect(open("story-ex9657").status).toBe("open"); // a causa do sistema segue
  });

  it("causa «morta» que o disjuntor RECUSA soltar (já passou do teto depois da chance da borda) ⇒ o finding segue aberto e a linha do livro fica", async () => {
    await sweepDeployBlocks("armazem", deps()); // 1ª passada: backfill (a causa entra nos findings)
    breaker.releaseCause.mockResolvedValueOnce(null);
    remeasure.mockResolvedValueOnce({ dead: ["armazem:system"], present: [] });
    const r = await sweepDeployBlocks("armazem", deps());
    expect(breaker.releaseCause).toHaveBeenCalledWith("armazem", "armazem:system");
    expect(r.closedCauses).toEqual([]);
    expect(r.resolved).toEqual([]);
    expect(open("story-ex9657").status).toBe("open"); // não diz «o sistema tenta de novo» a um card que segue segurado
    expect(blocks.some((b) => b.causeKey === "armazem:system")).toBe(true);
  });

  it("o finding de PROVA (needs-proof) nunca é fechado pela varredura — nem se a re-medição o der por morto", async () => {
    const proof = failureCause({ phase: "needs-proof", pkg: "armazem" }, { board: "armazem", cardId: "story-p1", config });
    const f: Finding = { id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "medium", status: "open", deployPhase: "needs-proof", deployCause: proof, title: "prova", detail: "prova" };
    cards.push(liveCard("story-p1", f, { ...code, status: "deploy" } as Partial<Card>));
    remeasure.mockResolvedValueOnce({ dead: ["armazem:proof"], present: [] });
    const r = await sweepDeployBlocks("armazem", deps());
    expect(r.resolved).not.toContain("story-p1");
    expect(r.closedCauses).not.toContain("armazem:proof");
    expect(open("story-p1").status).toBe("open"); // o produtor da prova segue vendo o card
    expect(breaker.releaseCause).not.toHaveBeenCalledWith("armazem", "armazem:proof");
    expect(blocks.find((b) => b.causeKey === "armazem:proof")?.cardIds).toEqual(["story-p1"]);
  });

  it("board sem config ⇒ nada; uma escrita que lança não derruba a varredura", async () => {
    expect(await sweepDeployBlocks("x", { ...deps(), readConfig: async () => null })).toEqual({ backfilled: [], noCode: [], closedCauses: [], resolved: [] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sweepDeployBlocks("armazem", { ...deps(), readCards: async () => { throw new Error("disco"); } })).resolves.toBeDefined();
    err.mockRestore();
  });
});

describe("carriesNoCode — o card que nunca espera o deploy do pacote", () => {
  const story = (o: Partial<Card>) => ({ id: "s", type: "story", ...o }) as Card;
  it("sem intervalo, sem staged, sem release e sem recibo de código ⇒ sem código", () => {
    expect(carriesNoCode(story({}))).toBe(true);
  });
  it("qualquer prova de código ⇒ tem código (fail-closed): intervalo, staged, release, recibo do train", () => {
    expect(carriesNoCode(story({ commitRange: { base: "a", head: "b" } }))).toBe(false);
    expect(carriesNoCode(story({ stagedAt: "2026-05-14" }))).toBe(false);
    expect(carriesNoCode(story({ releasedSha: "abc1234" }))).toBe(false);
    expect(carriesNoCode(story({ releasedAt: "2026-05-14" }))).toBe(false);
    expect(carriesNoCode(story({}), new Set(["s"]))).toBe(false);
    expect(carriesNoCode({ id: "e", type: "epic" } as unknown as Card)).toBe(false);
  });
});

describe("causeKeyOf", () => {
  it("é estável e não carrega HEAD nem card (só a promoção, que é do diff do card, leva o card)", () => {
    expect(causeKeyOf("armazem", "owner", "money")).toBe("armazem:owner:money");
    expect(causeKeyOf("armazem", "system")).toBe("armazem:system");
  });
});
