import { describe, expect, it } from "vitest";
import { groupDeployStops, type CockpitItem } from "./demands";

// N cards do mesmo lote parados pela MESMA causa de publicação viram UM item no Inbox (que fala por todos); uma falha
// de verdade (sem fase) e causas diferentes seguem separadas.

const stop = (cardId: string, over: Partial<CockpitItem> = {}): CockpitItem =>
  ({
    id: `${cardId}:deploy-failed`,
    kind: "deploy-failed",
    boardId: "estufa",
    cardId,
    cardTitle: `Card ${cardId}`,
    status: "release",
    lane: "travado",
    severity: "critical",
    since: null,
    findingId: "deploy-failure",
    title: "A publicação do lote espera alguém",
    needsHuman: true,
    causeKey: "estufa-app:owner:money",
    ...over,
  }) as CockpitItem;

describe("groupDeployStops", () => {
  it("três cards com a mesma causa ⇒ um item que lista os outros dois", () => {
    const out = groupDeployStops([stop("story-ex0001"), stop("story-ex0002"), stop("story-ex0003")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cardId: "story-ex0001", alsoCards: [{ cardId: "story-ex0002" }, { cardId: "story-ex0003" }] });
    expect((out[0] as { title: string }).title).toMatch(/este e mais 2 cards do mesmo lote$/);
  });
  it("causas diferentes, falha de verdade (sem fase) e item sem causa seguem por card; a ordem se mantém", () => {
    const items = [
      stop("story-ex0001"),
      stop("story-ex0002", { causeKey: "estufa-app:owner:brand" }),
      stop("story-ex0003", { needsHuman: undefined }),
      stop("story-ex0004", { causeKey: undefined }),
      stop("story-ex0005"),
    ];
    const out = groupDeployStops(items);
    expect(out.map((i) => i.cardId)).toEqual(["story-ex0001", "story-ex0002", "story-ex0003", "story-ex0004"]);
    expect(out[0]).toMatchObject({ alsoCards: [{ cardId: "story-ex0005" }] });
    expect(out[1]).not.toHaveProperty("alsoCards");
  });
  it("não muta os itens de entrada", () => {
    const a = stop("story-ex0001");
    groupDeployStops([a, stop("story-ex0002")]);
    expect(a).not.toHaveProperty("alsoCards");
  });
});
