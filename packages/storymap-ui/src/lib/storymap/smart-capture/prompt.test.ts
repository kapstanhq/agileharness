import { describe, it, expect } from "vitest";
import { buildProposalPrompt } from "./prompt";
import type { BoardConfig, Card } from "../types";

// The capturer over-fragmented a coherent feature into 15 task-level cards because the
// prompt's granularity rule was a single vague line ("não sobre-fragmente"). These tests
// pin the strengthened rubric so a future edit can't silently drop it — the capturer must
// keep being told that a story is a unit of VALUE, that technical sub-tasks become tasks[]
// (via /harness-tasks), and that same-surface work is grouped (else N pipelines repeat context
// and conflict on the same file in the autorun).

function config(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: "storymap",
    name: "AgileHarness",
    statuses: [],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
    ...overrides,
  };
}

describe("buildProposalPrompt — granularity rubric (story ≠ task)", () => {
  const prompt = buildProposalPrompt({ config: config(), cards: [], strategy: "", text: "qualquer plano" });

  it("has a dedicated Granularidade section flagged as the most important rule", () => {
    expect(prompt).toMatch(/# Granularidade/);
    expect(prompt).toMatch(/story ≠ task/i);
  });

  it("defines a story as a unit of observable VALUE, not a technical step", () => {
    expect(prompt).toMatch(/incremento de VALOR/i);
    expect(prompt).toMatch(/NÃO é um passo técnico/i);
  });

  it("tells the capturer technical sub-tasks become tasks[] via /harness-tasks, not cards", () => {
    expect(prompt).toMatch(/\/harness-tasks/);
    expect(prompt).toMatch(/TASK/);
    // explicit "don't make a card for a sub-task" steer
    expect(prompt).toMatch(/NÃO crie card para sub-tarefa/i);
  });

  it("steers toward grouping same-surface / coupled work into one story (1 PR)", () => {
    expect(prompt).toMatch(/MESMA superfície/i);
    expect(prompt).toMatch(/1 PR coeso/);
  });

  it("tells it to ignore a pre-fragmented input list and consolidate (not mirror 1:1)", () => {
    expect(prompt).toMatch(/IGNORE a forma do texto de entrada/i);
    expect(prompt).toMatch(/não espelhe a lista 1:1/i);
  });

  it("gives a sanity bound (most captures are 1–4 stories)", () => {
    expect(prompt).toMatch(/1[–-]4 stories/);
  });

  it("carries worked examples that collapse task-level items into one story", () => {
    expect(prompt).toMatch(/Perguntas do agente para destravar o run/);
    expect(prompt).toMatch(/Ler o card do Kanban sem ruído/);
  });
});

// WS-9 (D15): the structured capture no longer classifies pains as type:"idea". These pin the cut so a
// future edit can't silently re-introduce the ◆ path — capture must keep steering raw pain to the bench (not a
// card) while the bug/story paths stay intact, and a story may LINK to an existing open idea.
describe("buildProposalPrompt — WS-9: capture never mints an idea", () => {
  const prompt = buildProposalPrompt({ config: config(), cards: [], strategy: "", text: "qualquer plano" });

  it("no longer offers the ◆ idea CLASSIFICATION path in PASSO 1", () => {
    // the old caminho 2 minted "UMA E SÓ UMA ◆ type:'idea'" — that steer must be gone.
    expect(prompt).not.toMatch(/type:"idea"\)\s*\.?\s*O title é o enunciado da dor/);
    expect(prompt).not.toMatch(/UMA E SÓ UMA ◆/);
    // PASSO 1 agora abre pela SUPERFÍCIE ("já existe story para isto?") e só então separa defeito ×
    // trabalho novo — o caminho que faltava era justamente "a superfície existe ⇒ entrega/estender".
    expect(prompt).toMatch(/# PASSO 1[\s\S]*SUPERFÍCIE já existe no board/);
    expect(prompt).toMatch(/# PASSO 1[\s\S]*ENTREGA \*\*filha daquela story\*\*/);
    expect(prompt).toMatch(/# PASSO 1[\s\S]*DEFEITO[\s\S]*TRABALHO NOVO/);
  });

  it("steers raw pain WITHOUT a deliverable to the bench (a summary note), not a card", () => {
    expect(prompt).toMatch(/DOR CRUA/);
    expect(prompt).toMatch(/bancada de Ideias/i);
    expect(prompt).toMatch(/NÃO emita item|NÃO invente um item|NENHUM item/i);
  });

  it("keeps the DEFEITO → story:bug path intact (unchanged)", () => {
    expect(prompt).toMatch(/DEFEITO/);
    expect(prompt).toMatch(/storyType:"bug"/);
  });

  it("tells the response contract that items are only story/backbone (no type:idea emitted)", () => {
    expect(prompt).toMatch(/a captura NUNCA emite type:"idea"/i);
  });

  it("lists OPEN ideas and allows a story to LINK to one via addresses (9.3)", () => {
    const idea = {
      id: "idea-dor-x",
      type: "idea",
      title: "fallback",
      idea: { statement: "Usuário não acha os eventos salvos", status: "open" },
    } as unknown as Card;
    const withOpp = buildProposalPrompt({ config: config(), cards: [idea], strategy: "", text: "algo" });
    expect(withOpp).toMatch(/Ideias abertas na bancada/i);
    expect(withOpp).toMatch(/idea-dor-x — "Usuário não acha os eventos salvos"/);
    expect(withOpp).toMatch(/addresses/);
  });

  it("shows a 'nenhuma ideia aberta' placeholder when the bench is empty", () => {
    expect(prompt).toMatch(/nenhuma ideia aberta na bancada/i);
  });
});
