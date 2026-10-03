import { describe, expect, it } from "vitest";
import { anchoredTo, dependentsOf, dependentsSample, DISCARD_GROUP_MAX, discardGroupKey, discardGroupRefusal, discardPlan, workProductOf } from "./card-dependents";
import type { BoardConfig, Card } from "./types";

const config = { statuses: [{ id: "triagem", name: "Triagem" }, { id: "fazendo", name: "Fazendo" }, { id: "no-ar", name: "No ar", terminal: true }] } as unknown as Pick<BoardConfig, "statuses">;
const mk = (id: string, over: Partial<Card> = {}): Card => ({ id, type: "story", title: `Card ${id}`, status: "triagem", parent: null, links: [], ...over }) as Card;

describe("quem depende de um card", () => {
  it("ancora por `parent` ou por `serves`", () => {
    expect(anchoredTo({ parent: "a", serves: null }, "a")).toBe(true);
    expect(anchoredTo({ parent: null, serves: "a" }, "a")).toBe(true);
    expect(anchoredTo({ parent: "b", serves: "c" }, "a")).toBe(false);
  });

  it("transitivo, do mais perto para o mais longe; nunca o próprio; um ciclo de ancoragem não trava", () => {
    const cards = [mk("root"), mk("filho", { parent: "root" }), mk("serve", { serves: "root" }), mk("neto", { parent: "filho" }), mk("fora", { parent: "outro" })];
    expect(dependentsOf("root", cards).map((c) => c.id)).toEqual(["filho", "serve", "neto"]);
    expect(dependentsOf("fora", cards)).toEqual([]);
    const loop = [mk("a", { parent: "b" }), mk("b", { parent: "a" })];
    expect(dependentsOf("a", loop).map((c) => c.id)).toEqual(["b"]);
  });

  it("«A», «B» e mais N", () => {
    expect(dependentsSample([mk("1"), mk("2"), mk("3"), mk("4")], 2)).toBe("«Card 1», «Card 2» e mais 2");
    expect(dependentsSample([mk("1")])).toBe("«Card 1»");
  });
});

describe("o plano de descarte — o que pode ir junto", () => {
  it("o que só tem texto vai junto; o que já PRODUZIU trabalho segura, dito em palavras", () => {
    expect(workProductOf(mk("x"), config)).toBeNull();
    expect(workProductOf(mk("x", { status: "no-ar" }), config)).toBe("já chegou ao fim do fluxo");
    expect(workProductOf(mk("x", { commitRange: { base: "a", head: "b" } } as Partial<Card>), config)).toBe("já tem código feito");
    expect(workProductOf(mk("x", { tasks: [{ id: "t", title: "t", done: true }] } as Partial<Card>), config)).toBe("já tem tarefa concluída");

    const light = [mk("root"), mk("a", { parent: "root" }), mk("b", { serves: "a" })];
    const ok = discardPlan("root", light, config);
    expect(ok.dependents.map((c) => c.id)).toEqual(["a", "b"]);
    expect(ok.cascade).toEqual({ ok: true });
    expect(discardGroupRefusal(ok)).toBeNull();

    const heavy = [mk("root"), mk("a", { parent: "root" }), mk("b", { serves: "a", qaPassed: true } as Partial<Card>)];
    const no = discardPlan("root", heavy, config);
    expect(no.cascade).toMatchObject({ ok: false, why: "já passou pela verificação" });
    expect(discardGroupRefusal(no)).toBe(
      "Não dá para descartar junto: «Card b», que depende deste card, já passou pela verificação. Abra esse card e decida o que fazer com ele; depois descarte este.",
    );
  });

  it("alguém trabalhando AGORA num dependente segura (o fato que só o servidor tem)", () => {
    const cards = [mk("root"), mk("a", { parent: "root" })];
    expect(discardPlan("root", cards, config).cascade).toEqual({ ok: true });
    const busy = discardPlan("root", cards, config, new Set(["a"]));
    expect(busy.cascade).toMatchObject({ ok: false, why: "tem um agente trabalhando nele agora" });
    expect(discardGroupRefusal(busy)).toMatch(/«Card a».*tem um agente trabalhando nele agora/);
  });

  it("sem dependentes o plano é vazio e nada recusa; acima do teto é limpeza do mapa, não descarte", () => {
    const solo = discardPlan("root", [mk("root")], config);
    expect(solo.dependents).toEqual([]);
    expect(discardGroupRefusal(solo)).toBeNull();
    const many = [mk("root"), ...Array.from({ length: DISCARD_GROUP_MAX + 1 }, (_, i) => mk(`d${i}`, { parent: "root" }))];
    expect(discardGroupRefusal(discardPlan("root", many, config))).toMatch(/26 cards que dependem dele.*Adiar/);
    const atCap = [mk("root"), ...Array.from({ length: DISCARD_GROUP_MAX }, (_, i) => mk(`d${i}`, { parent: "root" }))];
    expect(discardGroupRefusal(discardPlan("root", atCap, config))).toBeNull();
  });

  it("a marca do grupo une o card descartado e o instante", () => {
    expect(discardGroupKey("story-x", "2026-03-10T12:00:00.000Z")).toBe("story-x@2026-03-10T12:00:00.000Z");
  });
});
