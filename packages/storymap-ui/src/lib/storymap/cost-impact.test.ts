// A FRONTEIRA DO DINHEIRO: trocar o modelo de IA usado nas respostas ao usuário é dinheiro (do
// dono); aumento de custo DENTRO dos tetos do dono é do sistema; passar do teto, ou fornecedor / plano pago / API paga
// NOVOS, é do dono. Antes de publicar, a entrega traz uma projeção simples e honesta, com as premissas.

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { applyCostImpact, costImpactError, costImpactVerdict, ownerClassOfDeployRules, type CostImpactInput } from "./cost-impact";
import { DEFAULT_OWNER_CLASSES, whoDecides } from "./decision-class";
import { coerceAutonomy, coerceCard, readBaseTemplateConfig } from "./repo";
import { serializeCard } from "./write";
import { parseCard, parseBoardConfig } from "./contracts";
import { buildDeployFailureFinding } from "./runner/deploy-revert";
import type { BoardConfig, Card } from "./types";

const budget = { cashMonthlyBRL: 360, infraMonthlyBRL: 110 };
const cfg = (over: Partial<NonNullable<BoardConfig["autonomy"]>> = {}) => ({ autonomy: { mode: "ultra" as const, budget, ...over } }) as Pick<BoardConfig, "autonomy">;
const card = (over: Record<string, unknown> = {}): Card => coerceCard("story-x", { type: "story", storyType: "technical", title: "Cache de catálogo", ...over }, "");
const input = (over: Partial<CostImpactInput> = {}): CostImpactInput => ({
  monthlyBRL: 20,
  scope: "infra",
  assumptions: "uma instância mínima a mais no servidor de aplicação (~R$20/mês pela tabela pública)",
  baselineMonthlyBRL: 70,
  ...over,
});

describe("o modelo de IA das respostas ao usuário é dinheiro", () => {
  it("a classe `money` diz isso (é o que o classificador e o juiz leem)", () => {
    expect(DEFAULT_OWNER_CLASSES.find((c) => c.id === "money")?.description).toMatch(/modelo de IA/);
  });

  it("a regra de deploy declarada aponta a classe do dono (o guard de gasto com modelo do alvo)", () => {
    const c = cfg({ deployRuleClasses: { "paid-api-usage": "money" } });
    expect(ownerClassOfDeployRules(["paid-api-usage"], c)).toBe("money");
    expect(ownerClassOfDeployRules(["orphan-unit-rule"], c)).toBeNull();
    const f = buildDeployFailureFinding({ phase: "needs-human", exitCode: 3, pkg: "shopfront", units: ["worker"], ownerClass: "Dinheiro e preço" }, "2026-09-28");
    expect(f.title).toMatch(/Dinheiro e preço/);
  });
});

describe("costImpactVerdict — dentro do teto é do sistema; fora, ou novo fornecedor/plano/API paga, é do dono", () => {
  it("dentro do teto de infraestrutura: o sistema decide", () => {
    expect(costImpactVerdict(input(), cfg())).toMatchObject({ owner: false, projectedMonthlyBRL: 90, ceilingBRL: 110 });
  });
  it("passa do teto: do dono (dinheiro), com a conta dita", () => {
    const v = costImpactVerdict(input({ monthlyBRL: 60 }), cfg());
    expect(v).toMatchObject({ owner: true, ownerClass: "money", projectedMonthlyBRL: 130 });
    expect(v.reason).toMatch(/130.*110/);
  });
  it("fornecedor, plano pago ou API paga NOVOS: do dono mesmo com custo zero", () => {
    expect(costImpactVerdict(input({ monthlyBRL: 0, newVendor: "Mapbox" }), cfg()).owner).toBe(true);
    expect(costImpactVerdict(input({ monthlyBRL: 0, paidPlan: true }), cfg()).owner).toBe(true);
    expect(costImpactVerdict(input({ monthlyBRL: 0, paidApi: true }), cfg()).owner).toBe(true);
  });
  it("sem linha de base: a conta assume 0 e DIZ isso; sem teto declarado, qualquer aumento é do dono (não dá para provar que cabe)", () => {
    const v = costImpactVerdict(input({ baselineMonthlyBRL: undefined }), cfg());
    expect(v.owner).toBe(false);
    expect(v.reason).toMatch(/sem linha de base/);
    expect(costImpactVerdict(input(), { autonomy: { mode: "ultra" } }).owner).toBe(true);
    expect(costImpactVerdict(input({ monthlyBRL: 0 }), { autonomy: { mode: "ultra" } }).owner).toBe(false);
  });
  it("o teto de caixa vale para o escopo caixa", () => {
    expect(costImpactVerdict(input({ scope: "cash", baselineMonthlyBRL: 320, monthlyBRL: 55 }), cfg())).toMatchObject({ owner: true, ceilingBRL: 360 });
  });
});

describe("a projeção no card", () => {
  it("a validação pede premissas e número honesto", () => {
    expect(costImpactError(input())).toBeNull();
    expect(costImpactError(input({ assumptions: " " }))).toMatch(/premissas/);
    expect(costImpactError(input({ monthlyBRL: -1 }))).toMatch(/número/);
  });

  it("fora do teto: o card ganha a classe `money` (as paradas dele vão ao dono); dentro: só a projeção", () => {
    const over = applyCostImpact(card(), input({ monthlyBRL: 60 }), costImpactVerdict(input({ monthlyBRL: 60 }), cfg()), { by: "harness-conductor", at: "2026-09-28" });
    expect(over.businessClasses).toMatchObject({ ids: ["money"], by: "harness-conductor" });
    expect(whoDecides({ kind: "gate" }, over, cfg())).toMatchObject({ decider: "owner", ownerClass: "money" });
    const inside = applyCostImpact(card(), input(), costImpactVerdict(input(), cfg()), { by: "harness-conductor", at: "2026-09-28" });
    expect(inside.businessClasses).toBeUndefined();
    expect(inside.costImpact).toMatchObject({ monthlyBRL: 20, scope: "infra", baselineMonthlyBRL: 70, by: "harness-conductor" });
    expect(whoDecides({ kind: "gate" }, inside, cfg()).decider).toBe("system");
  });

  it("Card.costImpact — type · coerce · contract · serializer", () => {
    const c = applyCostImpact(card(), input({ newVendor: "Mapbox" }), costImpactVerdict(input({ newVendor: "Mapbox" }), cfg()), { by: "x", at: "2026-09-28" });
    expect(parseCard(c).ok).toBe(true);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-x", back.data, back.content).costImpact).toEqual(c.costImpact);
  });
});

describe("os tetos e o mapa de regras — declarados no `_base`, sobrescrevíveis", () => {
  it("coerceAutonomy guarda o orçamento e o mapa de regras de deploy", () => {
    expect(coerceAutonomy({ budget: { cashMonthlyBRL: "360", infraMonthlyBRL: 110, lixo: 1 }, deployRuleClasses: { "paid-api-usage": "money", x: 3 } })).toEqual({
      budget: { cashMonthlyBRL: 360, infraMonthlyBRL: 110 },
      deployRuleClasses: { "paid-api-usage": "money" },
    });
  });

  it("o `_base` NÃO traz teto (um número ali seria o orçamento de outra pessoa): sem teto, todo aumento vai ao dono", async () => {
    const base = await readBaseTemplateConfig();
    expect(base.autonomy?.budget).toBeUndefined();
    expect(parseBoardConfig(base).ok).toBe(true);
    for (const scope of ["cash", "infra"] as const) {
      const v = costImpactVerdict({ monthlyBRL: 1, scope, assumptions: "um real a mais por mês" }, base);
      expect(v.owner, scope).toBe(true);
      expect(v.reason).toMatch(/não há teto/);
    }
  });
});
