// A DOBRA POR CAUSA (entries.ts `foldByCause`) — dois casos de um Inbox vivo que ela fecha:
//   • a mesma causa de publicação em 6 cards virava 6 itens, cada um com o nome de um card-vítima;
//   • o passo travado de um card e o pedido do agente para re-rodá-lo eram duas entradas em Decidir.

import { describe, expect, it } from "vitest";
import type { Card, DeployCause } from "../types";
import type { CockpitItem } from "../demands";
import { emptyFacts } from "./contract";
import { foldByCause, inboxSections, inboxSummary, settleItems } from "./entries";
import { FIXTURES, HUMAN, NOW, mkCard } from "./items.fixture";

const FRESH: DeployCause = { pkg: "app", phase: "freshness", units: [], rules: [], ownerClass: null, decider: "system", causeKey: "app:freshness" };
const ids = ["d1", "d2", "d3", "d4", "d5", "d6"];
const cards: Card[] = ids.map((id) => mkCard({ id, title: `Card ${id}`, status: "release" }));
const deployItem = (cardId: string): CockpitItem =>
  ({ ...FIXTURES["deploy-failed"].item, id: `${cardId}:deploy-failed`, cardId, cardTitle: `Card ${cardId}` }) as CockpitItem;

describe("foldByCause", () => {
  it("6 publicações paradas pela MESMA causa ⇒ 1 entrada, com as outras 5 como facetas (os cards pelo nome)", () => {
    const facts = { ...emptyFacts(cards), deployCauseOf: new Map(ids.map((id) => [id, FRESH])) };
    const { entries } = settleItems(ids.map(deployItem), { boardId: "b1", boardName: "B", config: HUMAN, cardsById: facts.cardsById, now: NOW, facts });
    const folded = foldByCause(entries);
    expect(folded).toHaveLength(1);
    expect(folded[0].causeKey).toBe("deploy:app:freshness");
    expect(folded[0].facets).toHaveLength(5);
    expect(folded[0].facets.map((f) => f.cardTitle)).toEqual(["Card d2", "Card d3", "Card d4", "Card d5", "Card d6"]);
    expect(folded[0].decision.ask).toMatch(/afeta 6 cards/);
    expect(inboxSummary(folded).decidir).toBe(1);
  });

  it("causas diferentes não se dobram", () => {
    const other: DeployCause = { ...FRESH, phase: "release", causeKey: "app:release:d2" };
    const facts = { ...emptyFacts(cards), deployCauseOf: new Map([["d1", FRESH], ["d2", other]]) };
    const { entries } = settleItems([deployItem("d1"), deployItem("d2")], { boardId: "b1", boardName: "B", config: HUMAN, cardsById: facts.cardsById, now: NOW, facts });
    expect(foldByCause(entries)).toHaveLength(2);
  });

  it("o passo travado e o pedido do agente para re-rodá-lo, no MESMO card ⇒ 1 entrada (o pedido vira faceta)", () => {
    const card = FIXTURES.stuck.card;
    const approval = { ...FIXTURES.approval.item, tool: "run_skill", args: JSON.stringify({ cardId: "c1" }), riskClass: "run" } as CockpitItem;
    const { entries } = settleItems([FIXTURES.stuck.item, approval], { boardId: "b1", boardName: "B", config: HUMAN, cardsById: new Map([["c1", card]]), now: NOW });
    const { decidir } = inboxSections(foldByCause(entries));
    expect(decidir).toHaveLength(1);
    expect(decidir[0].kind).toBe("stuck");
    expect(decidir[0].facets.map((f) => f.kind)).toEqual(["approval"]);
  });

  it("uma decisão do sistema nunca dobra (a causa dela é ela mesma)", () => {
    const sd = { key: "b1/sd:1", boardId: "b1", boardName: "B", itemId: "sd:1", cardId: "c1", cardTitle: "", kind: "system-decision", causeKey: "sd:1", facets: [], decision: { bucket: "acompanhar" } } as never;
    const sd2 = { ...(sd as object), key: "b1/sd:2", itemId: "sd:2", causeKey: "sd:2" } as never;
    expect(foldByCause([sd, sd2])).toHaveLength(2);
  });
});
