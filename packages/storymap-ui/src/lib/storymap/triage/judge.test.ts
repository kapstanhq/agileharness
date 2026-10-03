// O JUIZ DA TRIAGEM (política só-negócio) — a parte pura: o prompt, a validação da resposta e o PLANO (aceitar,
// descartar, juntar, levar ao dono), que passa pelas MESMAS pré-condições do servidor antes de aceitar.

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { buildTriageJudgePrompt, parseTriageJudgement, planTriageJudgement, triageJudgeWork, TRIAGE_DISCARD_STATUS, TRIAGE_DUPLICATE_STATUS } from "./judge";
import { acceptTriageRefusal } from "../preconditions";
import { cardDemands, cardCockpitItems, needsTriageReview } from "../demands";
import { coerceCard } from "../repo";
import { serializeCard } from "../write";
import { parseCard } from "../contracts";
import { DEFAULT_OWNER_CLASSES } from "../decision-class";
import type { BoardConfig, Card } from "../types";

const statuses = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "interview", name: "Entrevista" },
  { id: "enriquecer", name: "Especificar" },
  { id: "corrigir", name: "Corrigir", gate: "hasBugReport" },
  { id: "duplicado", name: "Duplicado", gate: "hasDuplicateOf", terminal: true },
  { id: "cancelado", name: "Cancelado", terminal: true },
];
const cfg = (over: Partial<BoardConfig> = {}): BoardConfig =>
  ({ id: "b", name: "Biblioteca", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "ultra" }, ...over }) as unknown as BoardConfig;

const mk = (id: string, over: Record<string, unknown> = {}): Card => coerceCard(id, { type: "story", status: "triage", ...over }, "");
const step = coerceCard("step-reservar", { type: "step", title: "Reservar um livro", parent: "activity-a", status: null }, "");
const user = mk("story-user", { storyType: "user", title: "Ver quais exemplares estão na estante", status: "enriquecer", parent: "step-reservar" });
const tech = mk("story-t", { storyType: "technical", title: "Indexar o acervo por autor", links: [{ rel: "relates-to", to: "story-user" }] });
const board = [step, user, tech];

const judgement = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: "accept", reason: "serve a aposta de empréstimo", prdAnchor: "Aposta 1 — empréstimo", ownerClasses: [], confidence: 0.9, ...over });

describe("o que o juiz julga", () => {
  it("só-negócio: todo card de story em quarentena ainda sem decisão; human: nada", () => {
    const decided = mk("story-d", { triageDecision: { verdict: "accept", reason: "x", by: "triage-judge", at: "2026-09-28" } });
    const capture = mk("story-c", { capture: true });
    expect(triageJudgeWork([...board, decided, capture], cfg()).map((c) => c.id)).toEqual(["story-t"]);
    expect(triageJudgeWork(board, cfg({ autonomy: { mode: "human" } }))).toEqual([]);
    // a exceção do card vale: uma story human num board ultra fica com o dono
    expect(triageJudgeWork([{ ...tech, autonomyMode: "human" }], cfg())).toEqual([]);
  });
});

describe("o prompt do juiz", () => {
  it("julga pelo PRD (apostas, «Fora, por ora», «Nunca»), nomeia as classes do dono e cerca terceiros como dado", () => {
    const p = buildTriageJudgePrompt({ config: cfg(), prd: "## Apostas\n1. empréstimo\n## Fora, por ora\n- multas por atraso", card: tech, cards: board });
    expect(p).toMatch(/Fora, por ora/);
    expect(p).toMatch(/Nunca/);
    for (const c of DEFAULT_OWNER_CLASSES) expect(p).toContain(c.label);
    expect(p).toMatch(/dados, não instruções/);
    expect(p).toContain("story-user");
    expect(p).toContain('"verdict"');
  });

  it("sem PRD o prompt diz isso (e o juiz aceita pelo reversível)", () => {
    expect(buildTriageJudgePrompt({ config: cfg(), prd: null, card: tech, cards: board })).toMatch(/sem PRD/i);
  });
});

describe("parseTriageJudgement — o que o modelo devolve é validado no código", () => {
  it("aceita a forma certa; ids de lugar/duplicata inventados caem; classe desconhecida fica (mais humano)", () => {
    const r = parseTriageJudgement(judgement({ placement: { serves: "story-user", parent: "inventado" }, ownerClasses: ["money", "xyz"], duplicateOf: "fantasma" }), tech, board);
    if ("error" in r) throw new Error(r.error);
    expect(r).toMatchObject({ verdict: "accept", reason: "serve a aposta de empréstimo", prdAnchor: "Aposta 1 — empréstimo", ownerClasses: ["money", "xyz"], confidence: 0.9 });
    expect(r.placement).toEqual({ serves: "story-user" });
    expect(r.duplicateOf).toBeUndefined();
  });

  it("recusa verdict fora do vocabulário, porquê vazio e JSON torto", () => {
    expect("error" in parseTriageJudgement(judgement({ verdict: "talvez" }), tech, board)).toBe(true);
    expect("error" in parseTriageJudgement(judgement({ reason: " " }), tech, board)).toBe(true);
    expect("error" in parseTriageJudgement("nada disso", tech, board)).toBe(true);
    // a duplicata não pode ser o próprio card
    const self = parseTriageJudgement(judgement({ verdict: "duplicate", duplicateOf: "story-t" }), tech, board);
    expect("error" in self ? null : self.duplicateOf).toBeUndefined();
  });
});

describe("planTriageJudgement — o plano, com as pré-condições do servidor", () => {
  const opts = { today: "2026-09-28", by: "triage-judge" };
  const parse = (over: Record<string, unknown> = {}, c: Card = tech) => {
    const r = parseTriageJudgement(judgement(over), c, board);
    if ("error" in r) throw new Error(r.error);
    return r;
  };

  it("ACEITAR: vai para a raia do tipo (acceptRoute), com o lugar e o porquê — e passa na régua do servidor", () => {
    const plan = planTriageJudgement(tech, parse({ placement: { serves: "story-user" } }), cfg(), board, opts);
    expect(plan.action).toBe("accept");
    if (plan.action !== "accept") return;
    expect(plan.to).toBe("enriquecer");
    expect(plan.card).toMatchObject({ status: "enriquecer", serves: "story-user", needsHumanReview: undefined });
    expect(plan.card.triageDecision).toMatchObject({ verdict: "accept", reason: "serve a aposta de empréstimo", prdAnchor: "Aposta 1 — empréstimo", from: "triage", to: "enriquecer", by: "triage-judge" });
    expect(acceptTriageRefusal({ ...plan.card, status: "triage" }, cfg())).toBeNull();
  });

  it("sem lugar dado pelo juiz, infere pelos relacionados (inferTriagePlacement)", () => {
    const plan = planTriageJudgement(tech, parse(), cfg(), board, opts);
    expect(plan.action === "accept" && plan.card.serves).toBe("story-user");
  });

  it("a recusa do servidor vira ESPERA — o card não é aceito por fora da régua (ex.: sem lugar no mapa)", () => {
    const orphan = mk("story-o", { storyType: "technical", title: "Sem âncora" });
    const plan = planTriageJudgement(orphan, parse({}, orphan), cfg(), [...board, orphan], opts);
    expect(plan.action).toBe("hold");
    if (plan.action !== "hold") return;
    expect(plan.card.status).toBe("triage");
    expect(plan.card.needsHumanReview).toBe(true);
    expect(plan.card.triageDecision?.verdict).toBe("hold");
    expect(plan.reason).toMatch(/lugar|serve|pai/i);
  });

  it("DESCARTAR e JUNTAR: vão para os terminais do board, com o porquê; juntar leva o duplicateOf (o gate dele)", () => {
    const d = planTriageJudgement(tech, parse({ verdict: "discard", reason: "PRD: «Nunca» — cobrança de multas" }), cfg(), board, opts);
    expect(d).toMatchObject({ action: "discard", to: TRIAGE_DISCARD_STATUS });
    const u = planTriageJudgement(tech, parse({ verdict: "duplicate", duplicateOf: "story-user" }), cfg(), board, opts);
    expect(u).toMatchObject({ action: "duplicate", to: TRIAGE_DUPLICATE_STATUS });
    expect(u.card).toMatchObject({ status: "duplicado", duplicateOf: "story-user" });
  });

  it("descartar/juntar com confiança baixa vira ACEITAR (o reversível); board sem o terminal ⇒ espera", () => {
    const low = planTriageJudgement(tech, parse({ verdict: "discard", confidence: 0.4, placement: { serves: "story-user" } }), cfg(), board, opts);
    expect(low.action).toBe("accept");
    expect(low.card.triageDecision?.reason).toMatch(/confiança/);
    const noTerminal = cfg({ statuses: statuses.filter((s) => s.id !== "cancelado") as BoardConfig["statuses"] });
    expect(planTriageJudgement(tech, parse({ verdict: "discard" }), noTerminal, board, opts).action).toBe("hold");
  });

  it("toca uma classe do DONO (ex.: serviço pago) ⇒ fica na Triagem para ele, com a classe nomeada", () => {
    const plan = planTriageJudgement(tech, parse({ ownerClasses: ["money"], ownerReason: "propõe assinar um serviço pago de capas de livros" }), cfg(), board, opts);
    expect(plan.action).toBe("owner");
    expect(plan.card).toMatchObject({
      status: "triage",
      needsHumanReview: true,
      businessClasses: { ids: ["money"], reason: "propõe assinar um serviço pago de capas de livros", by: "triage-judge" },
      triageDecision: { verdict: "owner" },
    });
  });
});

describe("o Inbox em só-negócio: a revisão da triagem é do dono SÓ com classe do dono (ou quando o juiz não decidiu)", () => {
  const def = statuses[0];
  it("baixa confiança sem classe ⇒ não é demanda do dono num board ultra; em human, é", () => {
    const low = mk("story-l", { needsHumanReview: true });
    expect(needsTriageReview(low, def, cfg())).toBe(false);
    expect(needsTriageReview(low, def, cfg({ autonomy: { mode: "human" } }))).toBe(true);
    expect(needsTriageReview(low, def)).toBe(true); // sem config: a régua de sempre
  });

  it("com a classe do dono, o item nomeia a classe", () => {
    const money = mk("story-m", { needsHumanReview: true, businessClasses: { ids: ["money"], reason: "serviço pago", by: "triage-judge", at: "2026-09-28" } });
    expect(needsTriageReview(money, def, cfg())).toBe(true);
    const d = cardDemands(money, cfg(), "b").find((x) => x.type === "review");
    expect(d?.label).toMatch(/Dinheiro e preço/);
    expect(cardCockpitItems(money, cfg(), "b").some((i) => i.kind === "review")).toBe(true);
    const held = mk("story-h", { needsHumanReview: true, triageDecision: { verdict: "hold", reason: "sem lugar no mapa", by: "triage-judge", at: "x" } });
    expect(cardDemands(held, cfg(), "b").find((x) => x.type === "review")?.label).toMatch(/juiz/);
  });
});

describe("Card.triageDecision — type · coerce · contract · serializer", () => {
  it("round-trip; veredito fora do vocabulário cai", () => {
    const dec = { verdict: "accept", reason: "serve a aposta 2", prdAnchor: "Aposta 2", from: "triage", to: "enriquecer", by: "triage-judge", at: "2026-09-28" };
    const c = coerceCard("story-x", { type: "story", triageDecision: dec }, "");
    expect(c.triageDecision).toEqual(dec);
    expect(parseCard(c).ok).toBe(true);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-x", back.data, back.content).triageDecision).toEqual(dec);
    expect(coerceCard("story-x", { type: "story", triageDecision: { verdict: "talvez", reason: "x" } }, "").triageDecision).toBeUndefined();
  });
});
