import { describe, expect, it } from "vitest";
import { kanbanBoard, kanbanCard } from "./kanban-payload";
import type { Board, Card } from "./types";

// O Kanban recebe só o que lê. O que sai (corpo, histórico, avisos e perguntas já resolvidos) não é mostrado no quadro
// nem lido pelos gates; o que fica é o que o arraste e o selo usam.

const card = (over: Partial<Card> = {}): Card =>
  ({
    id: "story-ex9701",
    type: "story",
    title: "Reservar uma bancada",
    status: "desenvolver",
    body: "## Investigação\n\ntexto longo…",
    findings: [
      { id: "a", lens: "general", severity: "blocker", status: "open", title: "aberto" },
      { id: "b", lens: "general", severity: "high", status: "fixed", title: "resolvido" },
    ],
    questions: [
      { id: "q1", text: "aberta?", status: "open" },
      { id: "q2", text: "respondida", status: "answered" },
    ],
    decisions: [{ at: "2026-01-01", what: "x" }],
    triageDecision: { verdict: "accept" },
    criteriaSpecs: [{ criterion: 0, specPath: "e2e/a.spec.ts" }],
    tasks: [{ id: "t1", title: "um", done: true }],
    ...over,
  }) as unknown as Card;

describe("kanbanCard", () => {
  it("tira o corpo, o histórico e o que já foi resolvido; mantém o que gates e selos leem", () => {
    const k = kanbanCard(card(), false);
    expect(k.body).toBe("");
    expect(k.findings.map((f) => f.id)).toEqual(["a"]);
    expect(k.questions?.map((q) => q.id)).toEqual(["q1"]);
    expect("decisions" in k).toBe(false);
    expect("triageDecision" in k).toBe(false);
    expect(k.criteriaSpecs).toHaveLength(1);
    expect(k.tasks).toHaveLength(1);
    expect(k.title).toBe("Reservar uma bancada");
  });

  it("card no fim do fluxo também perde o mapa critério→spec (nenhum gate de QA o lê mais)", () => {
    expect("criteriaSpecs" in kanbanCard(card({ status: "concluida" }), true)).toBe(false);
  });

  it("não muta o card de origem", () => {
    const src = card();
    kanbanCard(src, true);
    expect(src.body).toContain("Investigação");
    expect(src.findings).toHaveLength(2);
  });
});

describe("kanbanBoard", () => {
  it("usa o terminal da config do board", () => {
    const board = {
      config: { id: "b", statuses: [{ id: "desenvolver", name: "Desenvolver" }, { id: "concluida", name: "No ar", terminal: true }] },
      cards: [card(), card({ id: "story-ex9702", status: "concluida" })],
    } as unknown as Board;
    const out = kanbanBoard(board);
    expect(out.cards.map((c) => "criteriaSpecs" in c)).toEqual([true, false]);
    expect(out.config).toBe(board.config);
  });
});
