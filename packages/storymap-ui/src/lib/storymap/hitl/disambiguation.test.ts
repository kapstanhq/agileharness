import { describe, it, expect } from "vitest";
import { planDisambiguation } from "@/lib/storymap/hitl/disambiguation";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";

const idea: ProposedItem = {
  tempId: "i1",
  type: "idea",
  title: "Usuário fica perdido no feed",
  storyType: null,
  rationale: "Dor de orientação",
  body: "soluções candidatas...",
  candidateSolutions: ["cache", "skeleton"],
  keyAssumption: "lentidão confunde",
};

describe("planDisambiguation", () => {
  it("retorna invalid quando done não é objeto", () => {
    expect(planDisambiguation(idea, "sim").kind).toBe("invalid");
    expect(planDisambiguation(idea, null).kind).toBe("invalid");
    expect(planDisambiguation(idea, 42).kind).toBe("invalid");
  });

  it("retorna invalid quando type não é idea|story", () => {
    expect(planDisambiguation(idea, { type: "activity" }).kind).toBe("invalid");
    expect(planDisambiguation(idea, { type: "bug" }).kind).toBe("invalid"); // bug é storyType, não type
    expect(planDisambiguation(idea, {}).kind).toBe("invalid");
  });

  // WS-9 (D15): a captura NUNCA cunha ideia. Um veredito type:"idea" (= dor crua) vira um item da
  // TRIAGEM — uma story de usuário — porque a bancada de Ideias saiu (fase 2): antes o item ficava parado com
  // um aviso apontando uma tela que não existe mais. Nunca carimba/reescreve o item para ◆.
  it("DOR CRUA (type idea) → reescreve como story de USUÁRIO para a Triagem, NUNCA um ◆ (título/racional do done)", () => {
    const plan = planDisambiguation(idea, { type: "idea", title: "Novo título", rationale: "Novo racional" });
    expect(plan.kind).toBe("recast");
    if (plan.kind !== "recast") throw new Error("esperava recast");
    expect(plan.toType).toBe("story");
    expect(plan.toStoryType).toBe("user");
    expect(plan.title).toBe("Novo título");
    expect(plan.rationale).toBe("Novo racional");
  });

  it("uma story de usuário julgada dor crua só é carimbada (já é o item da Triagem), sem ◆", () => {
    const userStory: ProposedItem = { ...idea, type: "story", storyType: "user", candidateSolutions: undefined };
    const plan = planDisambiguation(userStory, { type: "idea" });
    expect(plan.kind).toBe("stamp");
    if (plan.kind !== "stamp") throw new Error("esperava stamp");
    expect(plan.item.type).toBe("story");
    expect(plan.item.storyType).toBe("user");
  });

  it("CARIMBA (stamp) uma STORY quando o tipo/subtipo não muda — refina título/racional e limpa ⚠", () => {
    const bugStory: ProposedItem = { ...idea, type: "story", storyType: "bug", candidateSolutions: undefined };
    const plan = planDisambiguation(bugStory, { type: "story", storyType: "bug", title: "Novo título", rationale: "Novo racional" });
    expect(plan.kind).toBe("stamp");
    if (plan.kind !== "stamp") throw new Error("esperava stamp");
    expect(plan.item.title).toBe("Novo título");
    expect(plan.item.rationale).toBe("Novo racional");
    expect(plan.item.ambiguous).toBe(false);
    expect(plan.item.confidence).toBe(0.9);
    expect(plan.item.type).toBe("story");
    expect(plan.item.storyType).toBe("bug");
  });

  it("exige RECAST (reescrita profunda) quando o tipo muda dor→story:bug", () => {
    const plan = planDisambiguation(idea, { type: "story", storyType: "bug", title: "Corrigir feed", rationale: "defeito" });
    expect(plan.kind).toBe("recast");
    if (plan.kind !== "recast") throw new Error("esperava recast");
    expect(plan.toType).toBe("story");
    expect(plan.toStoryType).toBe("bug");
    expect(plan.title).toBe("Corrigir feed");
    expect(plan.rationale).toBe("defeito");
  });

  it("exige RECAST quando muda o SUBTIPO de story (user→technical)", () => {
    const userStory: ProposedItem = { ...idea, type: "story", storyType: "user" };
    const plan = planDisambiguation(userStory, { type: "story", storyType: "technical" });
    expect(plan.kind).toBe("recast");
    if (plan.kind !== "recast") throw new Error("esperava recast");
    expect(plan.toStoryType).toBe("technical");
  });

  it("default de storyType inválido cai no atual do item, senão 'user'", () => {
    const plan = planDisambiguation(idea, { type: "story", storyType: "xpto" });
    if (plan.kind !== "recast") throw new Error("esperava recast");
    expect(plan.toStoryType).toBe("user");
  });
});
