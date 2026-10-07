// As regras puras da tela do Inbox. «Também neste card» listava as facetas pelo `ask` — várias facetas de uma causa
// dividem o mesmo ask, e a lista mostrava dois links idênticos («Liberar … sem consertar…» duas vezes).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { InboxFacet } from "@/lib/storymap/inbox/entries";
import { facetLinks } from "./inbox-ui";

const facet = (itemId: string, over: Partial<InboxFacet> = {}): InboxFacet => ({ itemId, kind: "blocker", ask: "Consertar o problema em «Lista de desejos»?", cardId: "story-ex9101", ...over });

describe("facetLinks — cada faceta diz o que a distingue", () => {
  it("facetas do mesmo card levam o tipo e o título delas, não o ask que dividem", () => {
    const links = facetLinks({
      itemId: "story-ex9101:b:f1",
      cardId: "story-ex9101",
      facets: [facet("story-ex9101:b:f2", { title: "Falta o estado vazio da lista" }), facet("story-ex9101:b:f3", { title: "O botão some no celular" })],
    });
    expect(links.map((l) => l.label)).toEqual(["Problema da revisão: Falta o estado vazio da lista", "Problema da revisão: O botão some no celular"].map((s) => expect.stringContaining(s.split(": ")[1])));
    expect(new Set(links.map((l) => l.label)).size).toBe(2);
  });

  it("a faceta de outro card leva o nome do card; a própria entrada não vira faceta dela", () => {
    const links = facetLinks({
      itemId: "story-ex9101:b:f1",
      cardId: "story-ex9101",
      facets: [facet("story-ex9101:b:f1", { title: "eu mesma" }), facet("story-ex9102:d", { kind: "deploy-failed", cardId: "story-ex9102", cardTitle: "Resenhas de leitores" })],
    });
    expect(links).toHaveLength(1);
    expect(links[0].label).toContain("Resenhas de leitores");
  });

  it("sem título que distinga, os rótulos repetidos ganham um número — nunca dois links iguais", () => {
    const links = facetLinks({ itemId: "x", cardId: "story-ex9101", facets: [facet("a"), facet("b")] });
    expect(new Set(links.map((l) => l.label)).size).toBe(2);
  });
});

// revisão da fase 3: o «aceitar» da proposta contava TODOS os itens; quem desmarcava em «Mais detalhes» mandava menos
describe("o rótulo do aceitar de uma proposta conta o que o clique manda", () => {
  it("criar, aplicar e nada marcado", async () => {
    const { proposalAcceptLabel } = await import("@/lib/storymap/inbox/decision");
    expect(proposalAcceptLabel([{}, {}, {}])).toBe("Criar os 3 cards");
    expect(proposalAcceptLabel([{}])).toBe("Criar o card");
    expect(proposalAcceptLabel([{}, { targetCardId: "story-ex9101" }])).toBe("Aplicar os 2 itens");
    expect(proposalAcceptLabel([])).toBe("Nada marcado");
  });
  it("o botão usa a seleção do corpo do item quando ela existe", () => {
    const src = readFileSync(fileURLToPath(new URL("./InboxOptions.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/o\.invoke\.kind === "accept-proposal" && payload\?\.items \? proposalAcceptLabel\(payload\.items\)/);
  });
});
