// Classes de decisão: o AH para para o dono SÓ em decisão de negócio — dinheiro, falar em
// nome da marca, PRD e metas, dados de pessoas. Estes testes fixam a régua única (`whoDecides`) em cada ponto onde
// o AH pode parar, os dois modos, e o lugar onde as quatro classes são declaradas (`_base`, sobrescrevível).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OWNER_CLASSES,
  cockpitItemDecision,
  isBusinessOnly,
  ownerClassesOf,
  whoDecides,
  type DecisionPoint,
} from "./decision-class";
import { coerceAutonomy, deriveBoardConfigForPersist, readBaseTemplateConfig, readBoardConfig, coerceCard } from "./repo";
import { serializeCard } from "./write";
import { parseBoardConfig, parseCard } from "./contracts";
import { FIXTURE_BOARD } from "./board-fixture";
import matter from "gray-matter";
import type { BoardConfig, Card, CardQuestion, DeployCause, Finding } from "./types";
import type { CockpitItem, CockpitItemKind } from "./demands";
import SANDBOX_DENIED from "./runner/__fixtures__/sandbox-denied-finaltexts.json";
import { nextRunDeathFinding } from "./runner/run-death";
import { decideItem } from "./inbox/decision";

const ultra = { autonomy: { mode: "ultra" as const } } as Pick<BoardConfig, "autonomy">;
const human = { autonomy: { mode: "human" as const } } as Pick<BoardConfig, "autonomy">;
const card = (over: Partial<Card> = {}): Card => ({ ...coerceCard("story-x", { type: "story" }, ""), ...over });
const q = (over: Partial<CardQuestion>): CardQuestion => ({ id: "q1", text: "Qual caminho?", status: "open", ...over });

const EVERY_POINT: DecisionPoint[] = [
  { kind: "question", question: q({ category: "interview" }) },
  { kind: "triage-review" },
  { kind: "gate" },
  { kind: "ui-choice" },
  { kind: "approval", riskClass: "deploy" },
  { kind: "governance" },
  { kind: "data-deletion" },
  { kind: "dilemma" },
  { kind: "recovery" },
  { kind: "capture-proposal" },
  { kind: "audit" },
];

describe("as classes do dono — declaradas, com um default no código", () => {
  it("as quatro classes padrão, nesta ordem", () => {
    expect(DEFAULT_OWNER_CLASSES.map((c) => c.id)).toEqual(["money", "brand-voice", "prd", "personal-data"]);
    for (const c of DEFAULT_OWNER_CLASSES) expect(c.label && c.description).toBeTruthy();
  });

  it("sem declaração ⇒ o default; um board pode trocar a lista, mas `money` sempre fica (o piso)", () => {
    expect(ownerClassesOf(undefined).map((c) => c.id)).toEqual(["money", "brand-voice", "prd", "personal-data"]);
    const own = ownerClassesOf({ autonomy: { mode: "ultra", ownerClasses: [{ id: "seguranca", label: "Segurança", description: "regras do banco" }] } });
    expect(own.map((c) => c.id)).toEqual(["money", "seguranca"]);
  });

  it("o `_base` declara exatamente o default do código (uma lista, dois lugares que não podem divergir)", async () => {
    const base = await readBaseTemplateConfig();
    // lote D: o default do código ficou NEUTRO e o `_base` ganhou a mesma redação — a igualdade volta a ser TOTAL
    // (ids, rótulos, ordem e texto das quatro classes).
    expect(base.autonomy?.ownerClasses).toEqual(DEFAULT_OWNER_CLASSES);
    expect(base.autonomy?.mode).toBeUndefined(); // o _base NUNCA liga o modo — só declara as classes
  });

  it("coerceAutonomy: o bloco sem modo vale pelas classes; modo desconhecido ainda derruba tudo (⇒ human)", () => {
    const cls = [{ id: "money", label: "Dinheiro", description: "gasto" }];
    expect(coerceAutonomy({ ownerClasses: cls })).toEqual({ ownerClasses: cls });
    expect(coerceAutonomy({ mode: "ultr", ownerClasses: cls })).toBeUndefined();
    expect(coerceAutonomy({ ownerClasses: [{ id: "", label: "x" }, "lixo"] })).toBeUndefined();
  });

  it("um board que herda as classes do `_base` não as grava no próprio board.yaml (só o delta persiste)", async () => {
    const cfg = await readBoardConfig(FIXTURE_BOARD);
    expect(cfg.autonomy?.ownerClasses).toEqual(DEFAULT_OWNER_CLASSES);
    const persisted = await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...cfg, autonomy: { ...cfg.autonomy, mode: "ultra" } });
    expect(persisted.autonomy).toEqual({ mode: "ultra" });
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, cfg)).autonomy).toBeUndefined();
    const own = [{ id: "money", label: "Dinheiro", description: "só gasto" }];
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...cfg, autonomy: { ownerClasses: own } })).autonomy).toEqual({ ownerClasses: own });
  });

  it("o contrato aceita o bloco com as classes e sem modo", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    expect(parseBoardConfig({ ...base, autonomy: { ownerClasses: DEFAULT_OWNER_CLASSES } }).ok).toBe(true);
  });
});

describe("a marca de classe do dono num card (businessClasses) — type · coerce · contract · serializer", () => {
  it("round-trip pelo serializer real; marca sem ids cai", () => {
    const mark = { ids: ["money"], reason: "propõe uma API paga", by: "triage-judge", at: "2026-09-28" };
    const c = coerceCard("story-x", { type: "story", businessClasses: mark }, "");
    expect(c.businessClasses).toEqual(mark);
    expect(parseCard(c).ok).toBe(true);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-x", back.data, back.content).businessClasses).toEqual(mark);
    expect(coerceCard("story-x", { type: "story", businessClasses: { ids: [], reason: "x" } }, "").businessClasses).toBeUndefined();
  });

  it("a classe que o proxy apontou ao devolver a pergunta (proxy.ownerClass) — round-trip pelo serializer real", () => {
    const question = { id: "q1", text: "Trocar de fornecedor?", status: "open", category: "interview", proxy: { assumptions: "o proxy recusou: fornecedor", confidence: 0, declined: true, ownerClass: "money" } };
    const c = coerceCard("story-x", { type: "story", questions: [question] }, "");
    expect(c.questions?.[0].proxy).toMatchObject({ declined: true, ownerClass: "money" });
    expect(parseCard(c).ok).toBe(true);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-x", back.data, back.content).questions?.[0].proxy).toMatchObject({ declined: true, ownerClass: "money" });
    // em branco não vira classe
    const blank = coerceCard("story-x", { type: "story", questions: [{ ...question, proxy: { ...question.proxy, ownerClass: "  " } }] }, "");
    expect(blank.questions?.[0].proxy?.ownerClass).toBeUndefined();
  });
});

describe("whoDecides — modo human (legado): todo ponto de parada é do dono", () => {
  it.each(EVERY_POINT.map((p) => [p.kind, p] as const))("%s ⇒ dono", (_k, point) => {
    expect(whoDecides(point, card(), human).decider).toBe("owner");
    expect(whoDecides(point, card(), {}).decider).toBe("owner"); // board sem o bloco = human
  });
});

describe("whoDecides — só-negócio (ultra): o dono só nas quatro classes", () => {
  it("o modo efetivo: a exceção do card vence o board", () => {
    expect(isBusinessOnly(card(), ultra)).toBe(true);
    expect(isBusinessOnly(card({ autonomyMode: "human" }), ultra)).toBe(false);
    expect(whoDecides({ kind: "gate" }, card({ autonomyMode: "human" }), ultra).decider).toBe("owner");
    expect(isBusinessOnly(card({ autonomyMode: "ultra" }), human)).toBe(true);
  });

  it("perguntas: entrevista, tela e entrega são do sistema; dinheiro, [humano] e sem categoria são do dono", () => {
    expect(whoDecides({ kind: "question", question: q({ category: "interview" }) }, card(), ultra)).toMatchObject({ decider: "system", ownerClass: null });
    expect(whoDecides({ kind: "question", question: q({ category: "ui-choice" }) }, card(), ultra).decider).toBe("system");
    expect(whoDecides({ kind: "question", question: q({ category: "delivery" }) }, card(), ultra).decider).toBe("system");
    expect(whoDecides({ kind: "question", question: q({ category: "money" }) }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: "money" });
    // o piso de palavras de dinheiro só deixa MAIS humano
    expect(whoDecides({ kind: "question", question: q({ category: "interview", text: "Qual fornecedor de SMS usar?" }) }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: "money" });
    expect(whoDecides({ kind: "question", question: q({ category: "interview", context: "[humano] decisão do operador" }) }, card(), ultra).decider).toBe("owner");
    expect(whoDecides({ kind: "question", question: q({}) }, card(), ultra).decider).toBe("owner");
    // devolvida pelo proxy / reaberta na auditoria ⇒ do dono para sempre
    expect(whoDecides({ kind: "question", question: q({ category: "interview", proxy: { assumptions: "x", confidence: 0, declined: true } }) }, card(), ultra).decider).toBe("owner");
    // a pergunta devolvida diz a CLASSE: a que o proxy apontou; sem ela, a que a pergunta já carregava; sem nenhuma, null
    const declined = (over: Partial<CardQuestion>, proxyClass?: string) =>
      whoDecides({ kind: "question", question: q({ category: "interview", ...over, proxy: { assumptions: "x", confidence: 0, declined: true, ...(proxyClass ? { ownerClass: proxyClass } : {}) } }) }, card(), ultra);
    expect(declined({}, "money")).toMatchObject({ decider: "owner", ownerClass: "money", reason: "o proxy devolveu esta pergunta a você: toca «Dinheiro e preço»" });
    expect(declined({ ownerClass: "prd" })).toMatchObject({ decider: "owner", ownerClass: "prd" });
    expect(declined({ ownerClass: "prd" }, "personal-data")).toMatchObject({ ownerClass: "personal-data" }); // a do proxy vence
    expect(declined({})).toMatchObject({ decider: "owner", ownerClass: null, reason: "o proxy devolveu esta pergunta a você" });
    expect(whoDecides({ kind: "question", question: q({ category: "interview", proxy: { assumptions: "x", confidence: 0.9, auditOutcome: "reopened" } }) }, card(), ultra).decider).toBe("owner");
  });

  it("triagem, gate e pedido de aprovação: do sistema — salvo quando o card toca uma classe do dono", () => {
    const money = card({ businessClasses: { ids: ["money"], reason: "API paga", by: "triage-judge", at: "2026-09-28" } });
    for (const point of [{ kind: "triage-review" }, { kind: "gate" }, { kind: "approval", riskClass: "deploy" }] as DecisionPoint[]) {
      expect(whoDecides(point, card(), ultra).decider).toBe("system");
      expect(whoDecides(point, money, ultra)).toMatchObject({ decider: "owner", ownerClass: "money" });
    }
  });

  it("aprovação de shell/irreversível segue do dono em todo modo (a trava do núcleo não é classe de negócio)", () => {
    expect(whoDecides({ kind: "approval", riskClass: "run-free" }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: null });
    expect(whoDecides({ kind: "approval", riskClass: "destructive" }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: null });
  });

  it("governança é PRD e metas; exclusão de dados é dado de pessoas — sempre do dono", () => {
    expect(whoDecides({ kind: "governance" }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: "prd" });
    expect(whoDecides({ kind: "data-deletion" }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: "personal-data" });
  });

  it("tela, dilema e travamento: do sistema; um dilema que toca uma classe do dono é do dono", () => {
    expect(whoDecides({ kind: "ui-choice" }, card(), ultra).decider).toBe("system");
    expect(whoDecides({ kind: "dilemma" }, card(), ultra).decider).toBe("system");
    expect(whoDecides({ kind: "dilemma", ownerClass: "prd" }, card(), ultra)).toMatchObject({ decider: "owner", ownerClass: "prd" });
    expect(whoDecides({ kind: "recovery" }, card(), ultra).decider).toBe("system");
  });

  it("a captura (o texto do dono) e as amostras de auditoria seguem com ele", () => {
    expect(whoDecides({ kind: "capture-proposal" }, card(), ultra).decider).toBe("owner");
    expect(whoDecides({ kind: "audit" }, card(), ultra).decider).toBe("owner");
  });

  it("todo veredito traz o porquê em português", () => {
    for (const point of EVERY_POINT) {
      expect(whoDecides(point, card(), ultra).reason.length).toBeGreaterThan(10);
      expect(whoDecides(point, card(), human).reason.length).toBeGreaterThan(10);
    }
  });
});

describe("cockpitItemDecision — todo item do Inbox tem uma classe", () => {
  const base = { boardId: "b", cardId: "story-x", cardTitle: "X", status: "revisao", lane: "aprovar" as const, severity: "medium" as const };
  const item = (kind: CockpitItemKind, extra: Record<string, unknown> = {}) => ({ id: `story-x:${kind}`, kind, ...base, ...extra }) as unknown as CockpitItem;

  it("o gate genérico, o travamento e o design são do sistema em só-negócio", () => {
    expect(cockpitItemDecision(item("gate", { gateLabel: "Aprovar entrega" }), card(), ultra as BoardConfig).decider).toBe("system");
    expect(cockpitItemDecision(item("stuck"), card(), ultra as BoardConfig).decider).toBe("system");
    expect(cockpitItemDecision(item("design"), card(), ultra as BoardConfig).decider).toBe("system");
    expect(cockpitItemDecision(item("governance"), undefined, ultra as BoardConfig)).toMatchObject({ decider: "owner", ownerClass: "prd" });
    expect(cockpitItemDecision(item("data-deletion"), card(), ultra as BoardConfig)).toMatchObject({ decider: "owner", ownerClass: "personal-data" });
  });

  it("o card parado sem ninguém cuidando é travamento técnico: do sistema em só-negócio", () => {
    expect(cockpitItemDecision(item("stalled"), card(), ultra as BoardConfig)).toMatchObject({ decider: "system", reason: expect.stringMatching(/travamento técnico/) });
  });

  it("a pergunta do item é julgada pela pergunta do card (dinheiro ⇒ dono)", () => {
    const c = card({ questions: [q({ id: "q7", category: "money" })] });
    expect(cockpitItemDecision(item("question", { questionId: "q7" }), c, ultra as BoardConfig)).toMatchObject({ decider: "owner", ownerClass: "money" });
  });
});

// ── o ciclo de conserto: a régua única, sem atalho por kind ──────────────────────────────────────────────

const itemBase = { boardId: "b", cardId: "story-x", cardTitle: "X", status: "revisao", lane: "travado" as const, severity: "high" as const };
const mk = (kind: CockpitItemKind, extra: Record<string, unknown> = {}) => ({ id: `story-x:${kind}`, kind, ...itemBase, ...extra }) as unknown as CockpitItem;
const DEPLOY_FINDING = "deploy-failure";
const cause = (over: Partial<DeployCause> = {}): DeployCause => ({
  pkg: "armazemweb",
  phase: "needs-human",
  units: ["batch-reports"],
  rules: ["unclassified-unit"],
  ownerClass: null,
  decider: "system",
  causeKey: "armazemweb:unclassified-unit:batch-reports",
  ...over,
});
const deployCard = (deployCause?: DeployCause): Card =>
  card({
    findings: [
      { id: DEPLOY_FINDING, lens: "general", severity: "high", status: "open", title: "Precisa de você", deployPhase: "needs-human", ...(deployCause ? { deployCause } : {}) } as Finding,
    ],
  });
const needsHuman = mk("deploy-failed", { findingId: DEPLOY_FINDING, title: "Precisa de você", needsHuman: true });

describe("deploy-failed que pediu alguém (needs-human): quem decide é a CLASSE da causa, não o kind", () => {
  it("causa sem classe (unclassified-unit do batch-reports) ⇒ sistema, como lacuna de ferramenta/config", () => {
    expect(cockpitItemDecision(needsHuman, deployCard(cause()), ultra as BoardConfig)).toMatchObject({
      decider: "system",
      ownerClass: null,
      reason: expect.stringMatching(/lacuna de ferramenta\/config.*batch-reports/),
    });
  });

  it("causa de dinheiro (a regra billing mapeada em deployRuleClasses) ⇒ dono, com a classe", () => {
    const money = cause({ rules: ["billing"], units: ["api-gateway"], ownerClass: "money", decider: "owner" });
    expect(cockpitItemDecision(needsHuman, deployCard(money), ultra as BoardConfig)).toMatchObject({ decider: "owner", ownerClass: "money" });
  });

  it("finding anterior à causa estruturada (legado, sem deployCause) ⇒ dono: fail-closed até o backfill", () => {
    expect(cockpitItemDecision(needsHuman, deployCard(), ultra as BoardConfig)).toMatchObject({ decider: "owner", ownerClass: null });
    expect(cockpitItemDecision(needsHuman, undefined, ultra as BoardConfig).decider).toBe("owner");
  });

  it("o plano declarou o dono mas sem classe nomeada (regra ilegível / owner:true) ⇒ dono, fail-closed", () => {
    expect(cockpitItemDecision(needsHuman, deployCard(cause({ decider: "owner" })), ultra as BoardConfig)).toMatchObject({ decider: "owner", ownerClass: null });
  });

  it("uma classe que NÃO é do dono deste board não basta para ir ao dono", () => {
    const own = { autonomy: { mode: "ultra" as const, ownerClasses: [{ id: "money", label: "Dinheiro", description: "x" }] } } as BoardConfig;
    expect(cockpitItemDecision(needsHuman, deployCard(cause({ ownerClass: "prd" })), own).decider).toBe("system");
  });

  it("a falha de publicação comum (não pediu ninguém) segue travamento técnico; em modo humano tudo é do dono", () => {
    expect(cockpitItemDecision(mk("deploy-failed", { findingId: DEPLOY_FINDING }), deployCard(), ultra as BoardConfig).decider).toBe("system");
    expect(cockpitItemDecision(needsHuman, deployCard(cause()), human as BoardConfig).decider).toBe("owner");
  });
});

describe("travado cuja origem é a FERRAMENTA, ou o mesmo no-op de novo ⇒ sistema em QUALQUER modo", () => {
  const NOOP = "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)";
  const deathCard = (finalTexts: string[]): Card => {
    let c = card({ status: "enriquecer" });
    for (const t of finalTexts) {
      const f = nextRunDeathFinding(c, { reason: "no-op", detail: NOOP, finalText: t, today: "2026-10-01" });
      c = { ...c, findings: [...(c.findings ?? []).filter((x) => x.id !== f.id), f] };
    }
    return c;
  };
  const stuck = (c: Card, withEvidence: boolean) => {
    const death = c.findings!.find((f) => f.id === "run-death")!;
    return mk("stuck", {
      reason: "no-op",
      outcome: "no-op",
      ...(withEvidence ? { evidence: { findingId: death.id, title: death.title, detail: death.detail, failureClass: death.failureClass } } : {}),
    });
  };

  it("board em modo humano: o sandbox recusou todo Bash ⇒ sistema, «falha da ferramenta»", () => {
    const c = deathCard([SANDBOX_DENIED[0].finalText]);
    for (const config of [human, {}, ultra]) {
      for (const withEvidence of [true, false]) {
        expect(cockpitItemDecision(stuck(c, withEvidence), c, config as BoardConfig)).toMatchObject({ decider: "system", reason: expect.stringMatching(/falha da ferramenta/) });
      }
    }
  });

  it("o mesmo no-op de PRODUTO pela 2ª vez seguida ⇒ sistema em modo humano; a 1ª ainda é do dono em modo humano", () => {
    const once = deathCard(["O card já estava enriquecido; nada a fazer."]);
    expect(cockpitItemDecision(stuck(once, true), once, human as BoardConfig).decider).toBe("owner");
    const twice = deathCard(["O card já estava enriquecido; nada a fazer.", "Nada a fazer de novo."]);
    expect(cockpitItemDecision(stuck(twice, true), twice, human as BoardConfig)).toMatchObject({ decider: "system", reason: expect.stringMatching(/não há trabalho/) });
  });

  it("uma morte de produto (exit sem sinal de ambiente) em modo humano segue do dono", () => {
    const c = card({ findings: [{ id: "run-death", lens: "general", severity: "high", status: "open", title: "run morreu: exit", detail: "exit 1" }] });
    expect(cockpitItemDecision(mk("stuck", { reason: "exit", outcome: "exit" }), c, human as BoardConfig).decider).toBe("owner");
  });
});

// Revisão do WP1. (1) `tool` passava por cima do modo para QUALQUER `infra` — e o carimbo põe `infra` em todo
// `error`/`oom-killed`: o teto de max-turns, a OOM, o «API Error 529», o lock do worktree. Na base anterior todos iam ao
// dono num board humano, e é lá que ficam: só uma ASSINATURA conhecida da ferramenta tira a decisão da alçada do dono. (3) A
// repetição do no-op contava mortes de passos diferentes. (4) Os vereditos prometiam um ator que não existe («o sistema
// cuida», «reencaminha», «publica por unidade») e o Inbox dizia «O Jido está cuidando» num board com o Jido desligado.
describe("revisão do WP1 — só a assinatura da ferramenta passa por cima do modo, e nenhum veredito promete ator", () => {
  const death = (reason: "error" | "oom-killed" | "no-op", detail: string, opts: { finalText?: string; step?: string; postureWarn?: string; prior?: Card } = {}) => {
    const c0 = opts.prior ?? card({ status: "desenvolver" });
    const f = nextRunDeathFinding(c0, { reason, detail, finalText: opts.finalText, step: opts.step, postureWarn: opts.postureWarn, today: "2026-10-02" });
    const c = { ...c0, findings: [...(c0.findings ?? []).filter((x) => x.id !== f.id), f] };
    const item = mk("stuck", { reason, outcome: detail, evidence: { findingId: f.id, title: f.title, detail: f.detail, ...(f.failureClass ? { failureClass: f.failureClass } : {}) } });
    return { c, item };
  };
  const PROMISES_ACTOR = /o sistema (cuida|reencaminha|publica)|Jido|abre o card/i;

  it.each([
    ["o teto de max-turns (o engine assenta 'error')", "error", "max-turns atingido 3× (teto 3) — card travado, escalando p/ o operador"],
    ["OOM por contenção", "oom-killed", "OOM kill no scope — MemoryMax excedido (SIGKILL)"],
    ["API sobrecarregada", "error", "API Error: 529 Overloaded"],
    ["o lock do worktree ao lançar", "error", "fatal: could not lock config file .git/config"],
  ] as const)("%s, num board HUMANO ⇒ do dono (como na base); em ultra, a régua normal do travamento", (_l, reason, detail) => {
    const { c, item } = death(reason, detail);
    expect(cockpitItemDecision(item, c, human as BoardConfig).decider).toBe("owner");
    const v = cockpitItemDecision(item, c, ultra as BoardConfig);
    expect(v.decider).toBe("system");
    expect(v.reason).not.toMatch(/falha da ferramenta/);
  });

  it("no-op em passos diferentes (o dono moveu o card à mão entre eles) ⇒ não é «o mesmo no-op de novo»: do dono no modo humano", () => {
    const first = death("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", { finalText: "o advance falhou", step: "Especificar" });
    const second = death("no-op", "o run terminou sem nenhum commit e não produziu NENHUM artefato de código no pacote", {
      finalText: "esqueci de commitar",
      step: "Desenvolver",
      prior: first.c,
    });
    expect(cockpitItemDecision(second.item, second.c, human as BoardConfig).decider).toBe("owner");
  });

  it("o passo rodou com a postura REBAIXADA (sem shell) ⇒ falha da ferramenta, do sistema mesmo no modo humano", () => {
    const warn = "REBAIXADO full → write: o bubblewrap sobe, mas o Bash do agente não roda dentro dele (sh: 1: cannot create /proc/self/setgroups: Permission denied).";
    const { c, item } = death("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", { finalText: "Não tenho Bash aqui.", step: "Especificar", postureWarn: warn });
    expect(cockpitItemDecision(item, c, human as BoardConfig)).toMatchObject({ decider: "system", reason: expect.stringMatching(/falha da ferramenta/) });
  });

  it("os vereditos do sistema sem dono (ferramenta, no-op repetido, publicação sem classe) não prometem um ator que não existe", () => {
    const tool = death("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", { finalText: SANDBOX_DENIED[0].finalText, step: "Especificar" });
    const once = death("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", { finalText: "nada a fazer", step: "Especificar" });
    const twice = death("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", { finalText: "nada a fazer", step: "Especificar", prior: once.c });
    const verdicts = [
      cockpitItemDecision(tool.item, tool.c, human as BoardConfig),
      cockpitItemDecision(twice.item, twice.c, human as BoardConfig),
      cockpitItemDecision(needsHuman, deployCard(cause()), ultra as BoardConfig),
    ];
    for (const v of verdicts) {
      expect(v.decider).toBe("system");
      expect(v.reason).not.toMatch(PROMISES_ACTOR);
    }
  });

  it("no Inbox, num board humano: o travado da ferramenta sai de Decidir SEM dizer que alguém cuida (nem com o Jido desligado)", () => {
    const { c, item } = death("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", { finalText: SANDBOX_DENIED[0].finalText, step: "Especificar" });
    const config = {
      autonomy: { mode: "human" as const },
      statuses: [
        { id: "enriquecer", name: "Especificar", trigger: "harness-enrich" },
        { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
      ],
    } as unknown as BoardConfig;
    for (const tier of ["chat", "copiloto", "autonomo"] as const) {
      const d = decideItem({ ...item, trigger: "harness-enrich" } as CockpitItem, { config, card: c, now: Date.parse("2026-10-02T12:00:00Z"), tier });
      expect(d.bucket, tier).toBe("acompanhar");
      expect(d.next, tier).toMatchObject({ who: "ninguem", stalled: true });
      expect(d.ifIgnored, tier).not.toMatch(/Jido/);
    }
  });
});

/**
 * A MATRIZ exaustiva kind × modo — `Record<CockpitItemKind, …>`: um kind novo não compila sem a linha dele. `ultra` é o
 * veredito esperado num card sem classe do dono; `structural` nomeia por que um `owner` sem classe é legítimo ali.
 */
type Row = { item: CockpitItem; card?: Card; ultra: { decider: "owner" | "system"; ownerClass?: string | null }; structural?: string };
const MATRIX: Record<CockpitItemKind, Row> = {
  question: { item: mk("question", { questionId: "q1", category: "technical" }), card: card({ questions: [q({ id: "q1", category: "technical" })] }), ultra: { decider: "system" } },
  blocker: { item: mk("blocker", { findingId: "f" }), ultra: { decider: "system" } },
  finding: { item: mk("finding", { findingId: "f" }), ultra: { decider: "system" } },
  "deploy-failed": { item: needsHuman, card: deployCard(cause()), ultra: { decider: "system" } },
  gate: { item: mk("gate", { gateLabel: "Aprovar entrega" }), ultra: { decider: "system" } },
  approval: { item: mk("approval", { riskClass: "write-board" }), ultra: { decider: "system" } },
  review: { item: mk("review"), ultra: { decider: "system" } },
  stuck: { item: mk("stuck", { reason: "exit" }), ultra: { decider: "system" } },
  conflict: { item: mk("conflict"), ultra: { decider: "system" } },
  proposal: { item: mk("proposal"), ultra: { decider: "owner", ownerClass: null }, structural: "a captura é o texto do próprio dono" },
  design: { item: mk("design"), ultra: { decider: "system" } },
  governance: { item: mk("governance"), ultra: { decider: "owner", ownerClass: "prd" } },
  "deploy-unsettled": { item: mk("deploy-unsettled"), ultra: { decider: "system" } },
  "release-aging": { item: mk("release-aging"), ultra: { decider: "system" } },
  "merge-failed": { item: mk("merge-failed"), ultra: { decider: "system" } },
  "proxy-audit": { item: mk("proxy-audit"), ultra: { decider: "owner", ownerClass: null }, structural: "a amostra do que o sistema decidiu em nome do dono" },
  "delivery-audit": { item: mk("delivery-audit"), ultra: { decider: "owner", ownerClass: null }, structural: "a amostra do que o sistema decidiu em nome do dono" },
  "meter-stalled": { item: mk("meter-stalled"), ultra: { decider: "system" } },
  "data-deletion": { item: mk("data-deletion"), ultra: { decider: "owner", ownerClass: "personal-data" } },
  "effect-failed": { item: mk("effect-failed"), ultra: { decider: "system" } },
  stalled: { item: mk("stalled"), ultra: { decider: "system" } },
};

describe("a matriz kind × modo (exaustiva) e o invariante do só-negócio", () => {
  const rows = Object.entries(MATRIX) as Array<[CockpitItemKind, Row]>;

  it.each(rows)("%s: ultra como a matriz diz; modo humano ⇒ dono", (_kind, row) => {
    const c = row.card ?? card();
    expect(cockpitItemDecision(row.item, c, ultra as BoardConfig)).toMatchObject(row.ultra);
    expect(cockpitItemDecision(row.item, c, human as BoardConfig).decider).toBe("owner");
  });

  it("propriedade: em ultra, decider owner ⇒ ownerClass é classe do dono OU o ponto é estrutural (nomeado)", () => {
    const classes = new Set(ownerClassesOf(ultra).map((c) => c.id));
    const money = card({ businessClasses: { ids: ["money"], reason: "API paga", by: "triage-judge", at: "2026-09-28" } });
    for (const [kind, row] of rows) {
      for (const c of [row.card ?? card(), { ...(row.card ?? card()), businessClasses: money.businessClasses }]) {
        const v = cockpitItemDecision(row.item, c, ultra as BoardConfig);
        if (v.decider !== "owner") continue;
        const ok = (v.ownerClass != null && classes.has(v.ownerClass)) || !!row.structural;
        expect(ok, `${kind}: ${v.reason}`).toBe(true);
      }
    }
  });
});
