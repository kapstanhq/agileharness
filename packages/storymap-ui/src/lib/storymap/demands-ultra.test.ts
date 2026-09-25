// lanes-ultra — the Inbox demand model under the AUTONOMY KEY. The owner's queue must be exactly right:
//   • a question the proxy is taking does not wait on the owner (no demand) — until the proxy hands it back;
//   • money is flagged as the owner's, and neither it nor a proxied question ever wakes the copiloto tick;
//   • a sampled proxy answer is an audit item for the owner (never the copiloto's), even after the card shipped;
//   • a board WITHOUT the autonomy block sees byte-identical items (no new keys on a legacy question).

import { describe, expect, it } from "vitest";
import { cardCockpitItems, cardDemands, isCopilotActionable, type CockpitItem } from "./demands";
import type { BoardConfig, Card, CardQuestion } from "./types";

const cfg = (autonomy?: BoardConfig["autonomy"]): BoardConfig => ({
  id: "b",
  name: "B",
  statuses: [
    { id: "grill", name: "Dúvidas", trigger: "harness-grill", autorun: false },
    { id: "concluida", name: "No ar", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  ...(autonomy ? { autonomy } : {}),
});

const card = (questions: CardQuestion[], over: Partial<Card> = {}): Card =>
  ({ id: "c", type: "story", title: "C", storyType: "user", status: "grill", questions, findings: [], tasks: [], ...over }) as unknown as Card;
const q = (id: string, extra: Partial<CardQuestion> = {}): CardQuestion => ({ id, text: `pergunta ${id}`, status: "open", ...extra });

const questionItems = (items: CockpitItem[]) => items.filter((i) => i.kind === "question") as Extract<CockpitItem, { kind: "question" }>[];

describe("a pergunta que o PROXY está respondendo não espera o dono", () => {
  it("ultra: a interview some da demanda; a de dinheiro e a sem categoria ficam", () => {
    const c = card([q("q1", { category: "interview" }), q("q2", { category: "money" }), q("q3")]);
    const d = cardDemands(c, cfg({ mode: "ultra" }), "b").find((x) => x.type === "question");
    expect(d?.count).toBe(2);
  });

  it("só pergunta proxiável ⇒ nenhuma demanda de pergunta (o card não é puxado para 'Precisa de você')", () => {
    expect(cardDemands(card([q("q1", { category: "interview" })]), cfg({ mode: "ultra" }), "b").some((x) => x.type === "question")).toBe(false);
  });

  it("o proxy DEVOLVEU (declined no card) ⇒ volta a ser demanda do dono", () => {
    const back = q("q1", { category: "interview", proxy: { assumptions: "o proxy recusou: depende de preço", confidence: 0, declined: true } });
    expect(cardDemands(card([back]), cfg({ mode: "ultra" }), "b").find((x) => x.type === "question")?.count).toBe(1);
  });

  it("human (ou sem bloco) ⇒ a contagem legada, intocada", () => {
    const c = card([q("q1", { category: "interview" }), q("q2")]);
    expect(cardDemands(c, cfg(), "b").find((x) => x.type === "question")?.count).toBe(2);
    expect(cardDemands(c, cfg({ mode: "human" }), "b").find((x) => x.type === "question")?.count).toBe(2);
  });
});

describe("os itens de pergunta carregam a chave de autonomia — e o tick não acorda por eles", () => {
  it("ultra: interview ⇒ awaitingProxy; money ⇒ ownerOnly; nenhum dos dois é acionável pelo copiloto (em tier nenhum)", () => {
    const items = questionItems(cardCockpitItems(card([q("q1", { category: "interview" }), q("q2", { category: "money" }), q("q3")]), cfg({ mode: "ultra" }), "b"));
    const byQ = new Map(items.map((i) => [i.questionId, i]));
    expect(byQ.get("q1")).toMatchObject({ category: "interview", awaitingProxy: true });
    expect(byQ.get("q1")).not.toHaveProperty("ownerOnly");
    expect(byQ.get("q2")).toMatchObject({ category: "money", ownerOnly: true });
    expect(byQ.get("q2")).not.toHaveProperty("awaitingProxy");
    for (const tier of ["copiloto", "autonomo"] as const) {
      expect(isCopilotActionable(byQ.get("q1")!, tier)).toBe(false);
      expect(isCopilotActionable(byQ.get("q2")!, tier)).toBe(false);
      expect(isCopilotActionable(byQ.get("q3")!, tier)).toBe(true); // uma pergunta comum segue como antes
    }
  });

  it("board SEM o bloco: o item de pergunta é byte-idêntico ao legado (nenhuma chave nova)", () => {
    const [item] = questionItems(cardCockpitItems(card([q("q1")]), cfg(), "b"));
    expect(Object.keys(item).sort()).toEqual(
      ["askedBy", "boardId", "cardId", "cardTitle", "context", "id", "kind", "lane", "mode", "options", "prompt", "questionId", "recommendation", "severity", "since", "status"].sort(),
    );
  });
});

describe("a AUDITORIA do proxy é item do dono", () => {
  const audited = q("q1", {
    status: "answered",
    answer: "Leitoras",
    answeredAt: "2026-09-25",
    answeredBy: "proxy",
    category: "interview",
    selectedOptionIds: ["o2"],
    options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }],
    proxy: { assumptions: "PRD §público", confidence: 0.4, audit: true },
  });

  it("vira item `proxy-audit` com a resposta, as premissas e a confiança — e nunca é acionável pelo copiloto", () => {
    const items = cardCockpitItems(card([audited]), cfg({ mode: "ultra" }), "b");
    const pa = items.find((i) => i.kind === "proxy-audit");
    expect(pa).toMatchObject({ id: "c:pa:q1", lane: "aprovar", severity: "medium", answer: "B — Leitoras", assumptions: "PRD §público", confidence: 0.4 });
    expect(isCopilotActionable(pa!, "autonomo")).toBe(false);
  });

  it("sobrevive ao card ter ido para o ar (a decisão tomada em nome do dono segue auditável)", () => {
    const items = cardCockpitItems(card([audited], { status: "concluida" }), cfg({ mode: "ultra" }), "b");
    expect(items.map((i) => i.kind)).toEqual(["proxy-audit"]);
  });

  it("auditada (auditedAt) ou fora da amostra ⇒ nenhum item", () => {
    const done = { ...audited, proxy: { ...audited.proxy!, auditedAt: "2026-09-26", auditOutcome: "confirmed" as const } };
    const unsampled = { ...audited, proxy: { ...audited.proxy!, audit: undefined } };
    expect(cardCockpitItems(card([done]), cfg({ mode: "ultra" }), "b").some((i) => i.kind === "proxy-audit")).toBe(false);
    expect(cardCockpitItems(card([unsampled]), cfg({ mode: "ultra" }), "b").some((i) => i.kind === "proxy-audit")).toBe(false);
  });
});

// v0.9 — a ENTREGA autônoma amostrada vira item do Inbox do dono, JÁ NO AR (o status de entrega é terminal): Confirmar /
// Reabrir, com a Prova da entrega à vista. Nunca é do copiloto, em tier nenhum.
describe("a auditoria de uma entrega autônoma é item do dono — mesmo com o card em 'No ar'", () => {
  const delivered = (over: Partial<Card> = {}) => card([], { status: "concluida", ...over });

  it("auditoria pendente ⇒ item `delivery-audit` na lane aprovar, com a Prova da entrega", () => {
    const c = delivered({ deliveryAudit: { sampledAt: "2026-09-25", deliveredIn: "concluida" }, body: "## Prova da entrega\n- filtro novo\n" });
    const items = cardCockpitItems(c, cfg({ mode: "ultra" }), "b");
    expect(items.map((i) => i.kind)).toEqual(["delivery-audit"]);
    expect(items[0]).toMatchObject({ id: "c:da", lane: "aprovar", sampledAt: "2026-09-25", proof: "- filtro novo" });
  });

  it("nunca acionável pelo copiloto — nem no Autônomo", () => {
    const [item] = cardCockpitItems(delivered({ deliveryAudit: { sampledAt: "2026-09-25" } }), cfg({ mode: "ultra" }), "b");
    for (const tier of ["chat", "copiloto", "autonomo"] as const) expect(isCopilotActionable(item, tier)).toBe(false);
  });

  it("fechada (confirmada/reaberta) ou ausente ⇒ nenhum item; o card legado segue byte-idêntico", () => {
    const closed = delivered({ deliveryAudit: { sampledAt: "2026-09-25", auditedAt: "2026-09-26", outcome: "confirmed" } });
    expect(cardCockpitItems(closed, cfg({ mode: "ultra" }), "b")).toEqual([]);
    expect(cardCockpitItems(delivered(), cfg(), "b")).toEqual([]);
  });
});
