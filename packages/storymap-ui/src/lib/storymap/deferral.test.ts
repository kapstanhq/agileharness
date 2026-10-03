import { describe, expect, it } from "vitest";
import { deferTargets, deferralFor, deferralText, deferredAnchor, isDeferred, liftTargets, reviewDue } from "./deferral";
import { dependentsOf, discardPlan, dependentsSample } from "./card-dependents";
import type { BoardConfig, Card } from "./types";

const config = { statuses: [{ id: "triage" }, { id: "enriquecer" }, { id: "desenvolver" }, { id: "concluida", terminal: true }] } as unknown as BoardConfig;
const card = (id: string, over: Partial<Card> = {}): Card =>
  ({ id, type: "story", title: id, status: "enriquecer", parent: null, serves: null, tasks: [], ...over }) as unknown as Card;

describe("o adiamento «não agora»", () => {
  const cards = [
    card("step", { type: "step" as Card["type"], parent: "act" }),
    card("raiz", { parent: "step" }),
    card("filho", { serves: "raiz" }),
    card("neto", { parent: "filho" }),
    card("pronto", { serves: "raiz", status: "concluida" }),
    card("outro", { parent: "step" }),
  ];

  it("adiar um card estampa ele e tudo que depende dele — o que já terminou fica como está", () => {
    expect(deferTargets("raiz", cards, config).map((c) => c.id)).toEqual(["raiz", "filho", "neto"]);
  });

  it("um card já adiado à parte não é re-estampado", () => {
    const withOne = cards.map((c) => (c.id === "filho" ? { ...c, deferred: { reason: "x", since: "2026-10-01", by: "human" } } : c)) as Card[];
    expect(deferTargets("raiz", withOne, config).map((c) => c.id)).toEqual(["raiz", "neto"]);
  });

  it("a marca diz quem foi adiado direto e quem foi POR depender dele", () => {
    const d = deferralFor({ reason: " fora do ciclo ", today: "2026-10-02", by: "human", rootId: "raiz", cardId: "raiz", reviewOn: "2026-10-25" });
    expect(d).toEqual({ reason: "fora do ciclo", since: "2026-10-02", reviewOn: "2026-10-25", by: "human" });
    expect(deferralFor({ reason: "r", today: "2026-10-02", by: "human", rootId: "raiz", cardId: "filho" }).root).toBe("raiz");
  });

  it("o card que nasce DEPOIS de um adiado o encontra pelo ancestral (parent/serves, transitivo, sem laço)", () => {
    const adiada = cards.map((c) => (c.id === "raiz" ? { ...c, deferred: { reason: "x", since: "2026-10-02", by: "human" } } : c)) as Card[];
    const byId = new Map(adiada.map((c) => [c.id, c]));
    expect(deferredAnchor(card("novo", { serves: "filho" }), byId)?.id).toBe("raiz");
    expect(deferredAnchor(card("novo2", { parent: "outro" }), byId)).toBeNull();
    const ciclo = new Map([["a", card("a", { parent: "b" })], ["b", card("b", { parent: "a" })]]);
    expect(deferredAnchor(card("c", { parent: "a" }), ciclo)).toBeNull();
  });

  it("trazer de volta devolve o que foi adiado POR causa do card — não o que o dono adiou à parte", () => {
    const marked = cards.map((c) => {
      if (c.id === "raiz") return { ...c, deferred: { reason: "x", since: "2026-10-02", by: "human" } };
      if (c.id === "filho") return { ...c, deferred: { reason: "x", since: "2026-10-02", by: "human", root: "raiz" } };
      if (c.id === "outro") return { ...c, deferred: { reason: "à parte", since: "2026-10-02", by: "human" } };
      return c;
    }) as Card[];
    expect(liftTargets("raiz", marked).map((c) => c.id).sort()).toEqual(["filho", "raiz"]);
  });

  it("isDeferred, reviewDue e o texto", () => {
    expect(isDeferred(card("a"))).toBe(false);
    const d = { reason: "o módulo de relatórios espera o próximo trimestre", since: "2026-03-14", reviewOn: "2026-05-02", by: "human" };
    expect(isDeferred(card("a", { deferred: d }))).toBe(true);
    expect(reviewDue({ deferred: d }, "2026-05-01")).toBe(false);
    expect(reviewDue({ deferred: d }, "2026-05-02")).toBe(true);
    expect(deferralText(d)).toBe("Adiado desde 14/03 — o módulo de relatórios espera o próximo trimestre (rever em 02/05)");
  });
});

describe("quem depende de um card (descartar com dependentes)", () => {
  const cards = [card("a"), card("b", { serves: "a" }), card("c", { parent: "b" }), card("d", { serves: "a", status: "concluida" })];
  it("dependentsOf é transitivo, em largura, sem repetir", () => {
    expect(dependentsOf("a", cards).map((c) => c.id)).toEqual(["b", "d", "c"]);
  });
  it("só dá para levar junto o que NÃO produziu trabalho", () => {
    expect(discardPlan("a", cards, config).cascade).toMatchObject({ ok: false, why: expect.stringMatching(/fim do fluxo/) });
    const limpos = cards.filter((c) => c.id !== "d");
    expect(discardPlan("a", limpos, config).cascade).toEqual({ ok: true });
    expect(discardPlan("a", limpos, config, new Set(["c"])).cascade).toMatchObject({ ok: false, why: expect.stringMatching(/agente trabalhando/) });
    expect(discardPlan("a", [card("a"), card("b", { serves: "a", tasks: [{ id: "t", title: "x", done: true }] as Card["tasks"] })], config).cascade).toMatchObject({ ok: false, why: expect.stringMatching(/tarefa concluída/) });
  });
  it("dependentsSample cita no máximo 3 nomes", () => {
    expect(dependentsSample(Array.from({ length: 5 }, (_, i) => ({ title: `T${i}` })))).toBe("«T0», «T1», «T2» e mais 2");
  });
});
