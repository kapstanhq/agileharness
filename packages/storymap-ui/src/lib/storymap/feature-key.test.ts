// 🗝️ A chave de agrupamento de um card — a mesma para o Kanban, a página da funcionalidade e o despacho do condutor.
//
// O que não pode acontecer: (1) um board SEM funcionalidades no PRD mudar de agrupamento; (2) no dia da release, antes
// da primeira passada da âncora, o Kanban virar um único card «Outros».

import { describe, expect, it } from "vitest";
import { OUTROS_FEATURE, featureCtx, featureKeyOf, featureOf, hasPrdFeatures } from "./feature-key";
import type { Card } from "./types";

const node = (over: Partial<Card> & Pick<Card, "id" | "type">): Card => ({ title: over.id, status: null, ...over }) as Card;

const STEP = node({ id: "step-ex1", type: "step", title: "Cuidar do canteiro" });
const STORY = node({ id: "story-ex9201", type: "story", title: "Lembrete de rega", parent: STEP.id, feature: "regar" });
const TICKET = node({ id: "story-ex9202", type: "story", storyType: "bug", title: "Conserto do lembrete", serves: STORY.id });
const SOLTO = node({ id: "story-ex9203", type: "story", title: "Item solto", parent: STEP.id });
const SEM_PAI = node({ id: "story-ex9204", type: "story", title: "Sem pai" });
const byId = new Map([STEP, STORY, TICKET, SOLTO, SEM_PAI].map((c) => [c.id, c] as const));

const FEATURES = [
  { id: "regar", name: "Regar" },
  { id: "colher", name: "Colher" },
];

describe("featureKeyOf — modo PRD", () => {
  const ctx = featureCtx(byId, FEATURES, true);

  it("`card.feature` válida ⇒ a funcionalidade do PRD", () => {
    expect(hasPrdFeatures(ctx)).toBe(true);
    expect(featureKeyOf(STORY, ctx)).toEqual({ id: "regar", title: "Regar", self: false, source: "prd" });
  });

  it("sem funcionalidade própria herda a do card que `serves` (um salto)", () => {
    expect(featureKeyOf(TICKET, ctx)).toEqual({ id: "regar", title: "Regar", self: false, source: "prd" });
  });

  it("a própria vence a herdada", () => {
    expect(featureKeyOf({ ...TICKET, feature: "colher" }, ctx).id).toBe("colher");
  });

  it("sem funcionalidade (ou com um id que saiu do PRD) ⇒ «Outros (fora do PRD)»", () => {
    expect(featureKeyOf(SOLTO, ctx)).toEqual({ ...OUTROS_FEATURE, source: "outros" });
    expect(featureKeyOf({ ...SOLTO, feature: "apagada" }, ctx)).toEqual({ ...OUTROS_FEATURE, source: "outros" });
    expect(OUTROS_FEATURE.title).toBe("Outros (fora do PRD)");
  });

  it("PONTE do lançamento: antes da primeira passada da âncora, o card sem funcionalidade fica no passo do mapa", () => {
    const bridge = featureCtx(byId, FEATURES, false);
    expect(featureKeyOf(SOLTO, bridge)).toEqual({ ...featureOf(SOLTO, byId), source: "map" });
    expect(featureKeyOf(SOLTO, bridge).id).toBe(STEP.id);
    // o card JÁ ligado segue na funcionalidade do PRD mesmo durante a ponte
    expect(featureKeyOf(STORY, bridge).source).toBe("prd");
  });
});

describe("featureKeyOf — modo mapa (board sem funcionalidades no PRD)", () => {
  const ctx = featureCtx(byId, [], true);

  it("é exatamente o `featureOf` de antes, para todo card — mesmo com `feature` gravada", () => {
    expect(hasPrdFeatures(ctx)).toBe(false);
    for (const c of [STORY, TICKET, SOLTO, SEM_PAI]) expect(featureKeyOf(c, ctx)).toEqual({ ...featureOf(c, byId), source: "map" });
    expect(featureKeyOf(SEM_PAI, ctx)).toEqual({ id: SEM_PAI.id, title: "Sem pai", self: true, source: "map" });
  });
});
