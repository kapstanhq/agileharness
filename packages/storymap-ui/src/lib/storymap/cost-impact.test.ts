// A FRONTEIRA DO DINHEIRO: trocar um serviço pago de que o produto depende é decisão do dono; aumento de custo DENTRO
// dos tetos do dono é do sistema; passar do teto, ou fornecedor / plano pago / API paga NOVOS, é do dono.
// Antes de publicar, a entrega traz uma projeção simples e honesta, com as premissas.

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import {
  applyCostImpact,
  budgetFigures,
  buildCostImpactInput,
  costImpactError,
  costImpactFigures,
  costImpactVerdict,
  CURRENCY_DECLARE_HOW,
  ownerClassOfDeployRules,
  type CostImpactInput,
} from "./cost-impact";
import { formatMoney, formatMoneyShort, resolveCurrency } from "./currency";
import { coerceTargetProfile } from "./target-profile";
import { DEFAULT_OWNER_CLASSES, ownerClassesOf, whoDecides } from "./decision-class";
import { coerceAutonomy, coerceCard, deriveBoardConfigForPersist, readBaseTemplateConfig } from "./repo";
import { serializeCard } from "./write";
import { parseCard, parseBoardConfig } from "./contracts";
import { buildDeployFailureFinding } from "./runner/deploy-revert";
import type { BoardConfig, Card } from "./types";

const budget = { cashMonthlyBRL: 1200, infraMonthlyBRL: 110 };
const cfg = (over: Partial<NonNullable<BoardConfig["autonomy"]>> = {}) => ({ autonomy: { mode: "ultra" as const, budget, ...over } }) as Pick<BoardConfig, "autonomy">;
const card = (over: Record<string, unknown> = {}): Card => coerceCard("story-x", { type: "story", storyType: "technical", title: "Cache de catálogo", ...over }, "");
const input = (over: Partial<CostImpactInput> = {}): CostImpactInput => ({
  monthlyBRL: 20,
  scope: "infra",
  assumptions: "uma instância mínima a mais no servidor de aplicação (~R$20/mês pela tabela pública)",
  baselineMonthlyBRL: 70,
  ...over,
});

describe("trocar um serviço pago de que o produto depende é dinheiro", () => {
  it("a classe `money` PADRÃO diz isso em termos neutros (é o que o classificador e o juiz leem)", () => {
    const money = DEFAULT_OWNER_CLASSES.find((c) => c.id === "money")?.description ?? "";
    expect(money).toMatch(/serviço pago de que o produto depende/);
    // …e a cláusula GENÉRICA da troca de modelo/fornecedor de IA (muda custo e qualidade) continua no piso neutro
    expect(money).toMatch(/o modelo ou o fornecedor de IA que atende o usuário do produto \(muda custo e qualidade\)/);
    // neutra: fala em categorias, sem exemplificar com o produto de ninguém
    expect(money).not.toMatch(/\bex\.|por exemplo/i);
  });

  it("o alvo declara a redação DELE (com o exemplo dele) e ela vence o padrão, sem perder o piso `money`", () => {
    const declarada = { id: "money", label: "Dinheiro e preço", description: "Qualquer gasto novo, inclusive trocar o provedor de frete usado nos pedidos da oficina de bicicletas." };
    const cls = ownerClassesOf({ autonomy: { ownerClasses: [declarada] } });
    expect(cls).toEqual([declarada]);
    expect(ownerClassesOf({ autonomy: { ownerClasses: [{ id: "legal", label: "Jurídico", description: "contratos" }] } }).map((c) => c.id)).toEqual(["money", "legal"]);
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
    expect(costImpactVerdict(input(), cfg())).toMatchObject({ owner: false, projectedMonthly: 90, ceiling: 110 });
  });
  it("passa do teto: do dono (dinheiro), com a conta dita", () => {
    const v = costImpactVerdict(input({ monthlyBRL: 60 }), cfg());
    expect(v).toMatchObject({ owner: true, ownerClass: "money", projectedMonthly: 130 });
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
    expect(costImpactVerdict(input({ scope: "cash", baselineMonthlyBRL: 1180, monthlyBRL: 55 }), cfg())).toMatchObject({ owner: true, ceiling: 1200 });
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
    expect(coerceAutonomy({ budget: { cashMonthlyBRL: "1200", infraMonthlyBRL: 110, lixo: 1 }, deployRuleClasses: { "paid-api-usage": "money", x: 3 } })).toEqual({
      budget: { cashMonthlyBRL: 1200, infraMonthlyBRL: 110 },
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


// ══ A MOEDA É DECLARADA, NUNCA SUPOSTA (lote D) ═══════════════════════════════════════════════════════════════════════
// Fixtures INVENTADAS (oficina de bicicletas, livraria): nenhuma vem de card ou board de um alvo real. A forma é a do
// alvo que declara `target.currency` + um teto lido pela grafia legada `*BRL`.

const bikeShop = coerceTargetProfile({ currency: { code: "BRL", locale: "pt-BR" } });
const bookshop = coerceTargetProfile({ currency: { code: "USD", locale: "en-US" } });
const bikeBudget = { autonomy: { mode: "ultra" as const, budget: { cashMonthlyBRL: 1200, infraMonthlyBRL: 110 } } } as Pick<BoardConfig, "autonomy">;
const bookBudget = { autonomy: { mode: "ultra" as const, budget: { cashMonthly: 300, infraMonthly: 90 } } } as Pick<BoardConfig, "autonomy">;
const args = (over: Record<string, unknown> = {}) => ({
  scope: "infra" as const,
  assumptions: "mais uma instância mínima para a vitrine de peças",
  ...over,
});

describe("a porta da projeção (buildCostImpactInput) — a moeda vem do board/alvo, nunca do agente", () => {
  it("SEM DECLARAÇÃO nenhuma: recusa dizendo exatamente o que declarar (nada de R$ por omissão)", () => {
    const r = buildCostImpactInput(args({ monthlyAmount: 20 }), { config: { autonomy: { mode: "ultra" } }, target: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("target.currency");
    expect(r.error).toContain("autonomy.budget.currency");
    expect(r.error).toContain(CURRENCY_DECLARE_HOW);
    expect(r.error).not.toMatch(/R\$/);
  });

  it("o alias antigo (monthlyBRL) também é recusado sem moeda declarada — o BRL não vem por omissão", () => {
    expect(buildCostImpactInput(args({ monthlyBRL: 20 }), { config: { autonomy: { mode: "ultra" } }, target: undefined }).ok).toBe(false);
  });

  it("COM o alvo declarado: monthlyAmount vale na moeda dele; o alvo dá o locale e o neutralWrites", () => {
    const r = buildCostImpactInput(args({ monthlyAmount: 20, baselineMonthlyAmount: 70 }), { config: bookBudget, target: bookshop });
    expect(r).toMatchObject({ ok: true, input: { monthlyAmount: 20, baselineMonthlyAmount: 70, currency: { code: "USD", locale: "en-US" } } });
  });

  it("o teto do board que carrega a moeda vence a do alvo; o teto legado (chave *BRL) implica BRL se o alvo nada declara", () => {
    const usdBoard = { autonomy: { mode: "ultra" as const, budget: { currency: "USD", cashMonthly: 10 } } } as Pick<BoardConfig, "autonomy">;
    const a = buildCostImpactInput(args({ monthlyAmount: 5 }), { config: usdBoard, target: bikeShop });
    expect(a).toMatchObject({ ok: true, input: { currency: { code: "USD", locale: "pt-BR" } } });
    const b = buildCostImpactInput(args({ monthlyAmount: 5 }), { config: bikeBudget, target: undefined });
    expect(b).toMatchObject({ ok: true, input: { currency: { code: "BRL" } } });
  });

  it("a chamada ANTIGA do condutor (monthlyBRL) funciona num board BRL e dá a mesma entrada que monthlyAmount", () => {
    const old = buildCostImpactInput(args({ monthlyBRL: 20, baselineMonthlyBRL: 70 }), { config: bikeBudget, target: bikeShop });
    const neu = buildCostImpactInput(args({ monthlyAmount: 20, baselineMonthlyAmount: 70 }), { config: bikeBudget, target: bikeShop });
    expect(old).toEqual(neu);
    expect(old.ok && old.input.currency).toEqual({ code: "BRL", locale: "pt-BR" });
  });

  it("monthlyBRL num board que NÃO é BRL é recusado, mandando usar monthlyAmount", () => {
    const r = buildCostImpactInput(args({ monthlyBRL: 20 }), { config: bookBudget, target: bookshop });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/USD.*monthlyAmount/);
  });

  it("as duas grafias do mesmo número: iguais passam; diferentes recusam; nenhuma recusa pedindo monthlyAmount", () => {
    expect(buildCostImpactInput(args({ monthlyAmount: 20, monthlyBRL: 20 }), { config: bikeBudget, target: bikeShop }).ok).toBe(true);
    const diff = buildCostImpactInput(args({ monthlyAmount: 20, monthlyBRL: 25 }), { config: bikeBudget, target: bikeShop });
    expect(diff.ok).toBe(false);
    const none = buildCostImpactInput(args(), { config: bikeBudget, target: bikeShop });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/informe monthlyAmount/);
  });

  it("neutralWrites do alvo atravessa para a entrada (decide só a grafia da escrita)", () => {
    const t = coerceTargetProfile({ currency: { code: "BRL", neutralWrites: true } });
    const r = buildCostImpactInput(args({ monthlyAmount: 5 }), { config: bikeBudget, target: t });
    expect(r.ok && r.input.currency).toEqual({ code: "BRL", neutralWrites: true });
  });
});

describe("o veredito na moeda declarada (COM declaração neutra)", () => {
  const usd = (over: Record<string, unknown> = {}) => {
    const r = buildCostImpactInput(args(over), { config: bookBudget, target: bookshop });
    if (!r.ok) throw new Error(r.error);
    return r.input;
  };

  it("dentro do teto: o sistema decide, com a conta em dólar e sem R$ em lugar nenhum", () => {
    const v = costImpactVerdict(usd({ monthlyAmount: 20, baselineMonthlyAmount: 40 }), bookBudget);
    expect(v).toMatchObject({ owner: false, projectedMonthly: 60, ceiling: 90, currency: { code: "USD" } });
    expect(v.reason).toBe("projeta $60/mês de infraestrutura (+$20), dentro do teto de $90 — o sistema decide");
  });

  it("acima do teto: do dono; sem teto declarado: do dono; sem linha de base: a conta diz 'assumido $0'", () => {
    expect(costImpactVerdict(usd({ monthlyAmount: 60, baselineMonthlyAmount: 40 }), bookBudget).owner).toBe(true);
    const noCeiling = costImpactVerdict(usd({ monthlyAmount: 5 }), { autonomy: { mode: "ultra" } });
    expect(noCeiling.owner).toBe(true);
    expect(noCeiling.reason).toBe("aumenta o custo em $5/mês e não há teto de infraestrutura declarado — não dá para provar que cabe");
    expect(costImpactVerdict(usd({ monthlyAmount: 5 }), bookBudget).reason).toContain("sem linha de base conhecida — assumido $0");
  });

  it("a moeda do impacto ≠ a moeda do teto: vai ao dono SEM conversão (a ferramenta nunca inventa câmbio)", () => {
    const v = costImpactVerdict(usd({ monthlyAmount: 5 }), bikeBudget);
    expect(v.owner).toBe(true);
    expect(v.reason).toMatch(/USD.*BRL.*não converte/);
  });

  it("entrada sem moeda resolvível (montada à mão, sem a porta): o veredito vai ao dono, nunca calcula em unidade desconhecida", () => {
    const v = costImpactVerdict({ monthlyAmount: 5, monthlyBRL: 5, scope: "infra", assumptions: "x" }, { autonomy: { mode: "ultra" } });
    expect(v).toMatchObject({ owner: true, currency: null });
    expect(v.reason).toContain("target.currency");
    // …e nada é gravado no card (sem unidade não há número a guardar), só a marca do dono
    const c = applyCostImpact(card(), { monthlyAmount: 5, monthlyBRL: 5, scope: "infra", assumptions: "x" }, v, { by: "x", at: "2026-10-01" });
    expect(c.costImpact).toBeUndefined();
    expect(c.businessClasses?.ids).toEqual(["money"]);
  });

  it("moeda do teto sem símbolo próprio (CHF): 'CHF 90'", () => {
    expect(formatMoneyShort(90, { code: "CHF" })).toBe("CHF 90");
  });
});

describe("LEGADO: o alvo que lê tetos *BRL decide como sempre (texto idêntico, byte a byte)", () => {
  it("a frase completa de hoje, com a moeda vinda do dado (BRL pela chave) — sem nenhum target.currency", () => {
    const v = costImpactVerdict(input(), cfg());
    expect(v.currency).toEqual({ code: "BRL" });
    expect(v.reason).toBe("projeta R$90/mês de infraestrutura (+R$20), dentro do teto de R$110 — o sistema decide");
    expect(costImpactVerdict(input({ monthlyBRL: 60 }), cfg()).reason).toBe("projeta R$130/mês de infraestrutura (+R$60), acima do seu teto de R$110 — decisão sua");
    expect(costImpactVerdict(input({ baselineMonthlyBRL: undefined }), cfg()).reason).toBe(
      "projeta R$20/mês de infraestrutura (sem linha de base conhecida — assumido R$0) (+R$20), dentro do teto de R$110 — o sistema decide",
    );
    expect(costImpactVerdict(input(), { autonomy: { mode: "ultra" } }).reason).toBe("aumenta o custo em R$20/mês e não há teto de infraestrutura declarado — não dá para provar que cabe");
  });

  it("o formato curto GOLDEN: BRL/pt-BR é exatamente 'R$90' (sem NBSP, sem milhar, arredondado)", () => {
    expect(formatMoneyShort(90, { code: "BRL" })).toBe("R$90");
    expect(formatMoneyShort(1234.6, { code: "BRL", locale: "pt-BR" })).toBe("R$1235");
    expect(formatMoneyShort(90, { code: "USD", locale: "en-US" })).toBe("$90");
    expect(formatMoney(12, { code: "BRL", locale: "pt-BR" })).toBe((12).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
  });

  it("os dois nomes do teto são lidos como a mesma coisa; se a mesma chave vem nos dois, a neutra vence", () => {
    expect(budgetFigures({ cashMonthlyBRL: 1200, infraMonthlyBRL: 110 })).toEqual({ cash: 1200, infra: 110, currency: "BRL", legacy: true });
    expect(budgetFigures({ cashMonthly: 300, infraMonthly: 90 })).toEqual({ cash: 300, infra: 90, legacy: false });
    expect(budgetFigures({ cashMonthly: 1, cashMonthlyBRL: 2 }).cash).toBe(1);
    expect(budgetFigures({ currency: "EUR", infraMonthly: 5 })).toMatchObject({ currency: "EUR", infra: 5 });
    expect(budgetFigures(undefined)).toEqual({ legacy: false });
  });

  it("coerceAutonomy guarda a GRAFIA que leu (nenhuma chave é renomeada) e valida a currency", () => {
    expect(coerceAutonomy({ budget: { cashMonthlyBRL: 1200, infraMonthlyBRL: "110" } })?.budget).toEqual({ cashMonthlyBRL: 1200, infraMonthlyBRL: 110 });
    expect(coerceAutonomy({ budget: { currency: "USD", cashMonthly: 300, infraMonthly: 90 } })?.budget).toEqual({ currency: "USD", cashMonthly: 300, infraMonthly: 90 });
    expect(coerceAutonomy({ budget: { currency: "xxq", cashMonthly: 1 } })?.budget).toEqual({ cashMonthly: 1 });
    expect(coerceAutonomy({ budget: { cashMonthly: -1, infraMonthlyBRL: "abc" } })?.budget).toBeUndefined();
    expect(coerceAutonomy({ budget: { cashMonthly: 5, cashMonthlyBRL: 9 } })?.budget).toEqual({ cashMonthly: 5 });
  });
});

describe("escrita nova: a grafia depende da moeda (BRL fica na legada; qualquer outra é sempre neutra)", () => {
  const apply = (code: string, neutralWrites?: boolean, extra: Record<string, unknown> = {}) => {
    const cur = { code, ...(neutralWrites !== undefined ? { neutralWrites } : {}) };
    const inp: CostImpactInput = { monthlyAmount: 20, monthlyBRL: 20, baselineMonthlyAmount: 70, baselineMonthlyBRL: 70, scope: "infra", assumptions: "uma instância a mais", currency: cur, ...extra };
    const budgetCfg = { autonomy: { mode: "ultra" as const, budget: { currency: code, infraMonthly: 500 } } } as Pick<BoardConfig, "autonomy">;
    return applyCostImpact(card(), inp, costImpactVerdict(inp, budgetCfg), { by: "x", at: "2026-10-01" }).costImpact!;
  };

  it("BRL sem neutralWrites ⇒ monthlyBRL (a leitura antiga continua enxergando o card); sem chave neutra alguma", () => {
    const ci = apply("BRL");
    expect(ci).toMatchObject({ monthlyBRL: 20, baselineMonthlyBRL: 70 });
    expect(ci).not.toHaveProperty("monthlyAmount");
    expect(ci).not.toHaveProperty("currency");
  });

  it("BRL com neutralWrites:true ⇒ monthlyAmount + currency; USD ⇒ sempre neutra", () => {
    expect(apply("BRL", true)).toMatchObject({ monthlyAmount: 20, baselineMonthlyAmount: 70, currency: "BRL" });
    const usd = apply("USD");
    expect(usd).toMatchObject({ monthlyAmount: 20, baselineMonthlyAmount: 70, currency: "USD" });
    expect(usd).not.toHaveProperty("monthlyBRL");
    expect(apply("USD", false)).toMatchObject({ currency: "USD" });
  });

  it("a ORDEM das chaves de applyCostImpact é a de sempre (valor, scope, assumptions, linha de base, fornecedor…), nas duas grafias", () => {
    const extra = { newVendor: "Fornecedor X", paidApi: true };
    expect(Object.keys(apply("BRL", undefined, extra))).toEqual(["monthlyBRL", "scope", "assumptions", "baselineMonthlyBRL", "newVendor", "paidApi", "decider", "by", "at"]);
    expect(Object.keys(apply("USD", undefined, extra))).toEqual(["monthlyAmount", "scope", "assumptions", "baselineMonthlyAmount", "currency", "newVendor", "paidApi", "decider", "by", "at"]);
  });

  it("costImpactFigures lê as duas grafias (a legada vale BRL)", () => {
    expect(costImpactFigures(apply("BRL"))).toEqual({ amount: 20, baseline: 70, currency: "BRL", legacy: true });
    expect(costImpactFigures(apply("USD"))).toEqual({ amount: 20, baseline: 70, currency: "USD", legacy: false });
  });
});

describe("round-trip: o disco não muda de grafia sozinho (nenhum write migra cards nem o board.yaml)", () => {
  // Frontmatter INVENTADO com a forma dos dados vivos (grafia legada).
  const legacyFm = {
    type: "story",
    storyType: "technical",
    title: "Vitrine de peças",
    // a ORDEM das chaves é a dos cards vivos (valor, scope, assumptions, linha de base, …) — o teste a compara em TEXTO
    costImpact: { monthlyBRL: 12, scope: "infra", assumptions: "uma consulta a mais por busca de peça", baselineMonthlyBRL: 4, decider: "system", by: "harness-conductor", at: "2026-09-01" },
  };
  // O bloco `costImpact:` do card serializado, como TEXTO (as chaves na ordem em que caem no disco).
  const costImpactText = (md: string) => {
    const lines = md.split("\n");
    const i = lines.indexOf("costImpact:");
    expect(i).toBeGreaterThan(-1);
    const out: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) out.push(lines[j]);
    return out.join("\n");
  };
  const roundTrip = (fm: Record<string, unknown>) => {
    const c = coerceCard("story-ex9975", fm, "");
    const back = matter(serializeCard(c));
    return { c, onDisk: back.data.costImpact as Record<string, unknown>, again: coerceCard("story-ex9975", back.data, back.content) };
  };

  it("(a) legado ⇒ lê ⇒ regrava com as MESMAS chaves e valores; nenhuma chave neutra aparece", () => {
    const { onDisk, again } = roundTrip(legacyFm);
    expect(onDisk).toEqual(legacyFm.costImpact);
    // byte a byte: a MESMA ordem de chaves (toEqual não vê ordem) — senão os cards já gravados mudam no 1º write de qualquer campo
    expect(Object.keys(onDisk)).toEqual(Object.keys(legacyFm.costImpact));
    expect(costImpactText(serializeCard(coerceCard("story-ex9975", legacyFm, "")))).toBe(
      [
        "  monthlyBRL: 12",
        "  scope: infra",
        "  assumptions: uma consulta a mais por busca de peça",
        "  baselineMonthlyBRL: 4",
        "  decider: system",
        "  by: harness-conductor",
        "  at: '2026-09-01'",
      ].join("\n"),
    );
    expect(Object.keys(onDisk)).not.toEqual(expect.arrayContaining(["monthlyAmount"]));
    expect(again.costImpact).toEqual(coerceCard("story-ex9975", legacyFm, "").costImpact);
  });

  it("(b) neutro ⇒ round-trip neutro", () => {
    const fm = { ...legacyFm, costImpact: { monthlyAmount: 30, baselineMonthlyAmount: 10, currency: "USD", scope: "cash", assumptions: "um plano de hospedagem maior", decider: "owner", by: "x", at: "2026-09-02" } };
    const { onDisk } = roundTrip(fm);
    expect(onDisk).toEqual(fm.costImpact);
    // a neutra segue a MESMA ordem de antes: valor, scope, assumptions, linha de base, moeda, …
    expect(Object.keys(onDisk)).toEqual(["monthlyAmount", "scope", "assumptions", "baselineMonthlyAmount", "currency", "decider", "by", "at"]);
  });

  it("(c) um card legado tocado por outra escrita (mudar o status) continua legado", () => {
    const c = coerceCard("story-ex9975", legacyFm, "");
    const moved = matter(serializeCard({ ...c, status: "concluida" }));
    expect(moved.data.costImpact).toEqual(legacyFm.costImpact);
    expect(Object.keys(moved.data.costImpact)).toEqual(Object.keys(legacyFm.costImpact));
  });

  it("(d) parseCard aceita as duas formas e recusa um costImpact sem número nenhum / neutro sem moeda", () => {
    expect(parseCard(roundTrip(legacyFm).c).ok).toBe(true);
    const neutral = coerceCard("story-ex9976", { type: "story", title: "x", costImpact: { monthlyAmount: 3, currency: "EUR", scope: "cash", assumptions: "a", decider: "system", by: "x", at: "2026-09-02" } }, "");
    expect(neutral.costImpact).toMatchObject({ monthlyAmount: 3, currency: "EUR" });
    expect(parseCard(neutral).ok).toBe(true);
    expect(parseCard({ ...neutral, costImpact: { ...neutral.costImpact!, currency: undefined } }).ok).toBe(false);
    expect(parseCard({ ...neutral, costImpact: { ...neutral.costImpact!, monthlyAmount: undefined } }).ok).toBe(false);
  });

  it("coerce: neutro sem moeda válida cai para a legada se houver; sem nenhuma, o impacto cai; as duas juntas ⇒ a neutra vence", () => {
    const base = { type: "story", title: "x" };
    const ci = { scope: "infra", assumptions: "a", decider: "system", by: "x", at: "2026-09-02" };
    expect(coerceCard("story-ex9977", { ...base, costImpact: { ...ci, monthlyAmount: 3, currency: "xxq" } }, "").costImpact).toBeUndefined();
    expect(coerceCard("story-ex9977", { ...base, costImpact: { ...ci, monthlyAmount: 3, currency: "xxq", monthlyBRL: 7 } }, "").costImpact).toMatchObject({ monthlyBRL: 7 });
    expect(coerceCard("story-ex9977", { ...base, costImpact: { ...ci, monthlyAmount: 3, currency: "EUR", monthlyBRL: 7 } }, "").costImpact).toMatchObject({ monthlyAmount: 3, currency: "EUR" });
    expect(coerceCard("story-ex9977", { ...base, costImpact: { ...ci, monthlyBRL: -1 } }, "").costImpact).toBeUndefined();
  });

  it("board config: salvar com o teto lido por chaves *BRL grava as MESMAS chaves (um save de vocab/canvas não reescreve o board.yaml)", async () => {
    const base = await readBaseTemplateConfig();
    const read = coerceAutonomy({ mode: "ultra", budget: { cashMonthlyBRL: 1200, infraMonthlyBRL: 110 } });
    const persisted = (await deriveBoardConfigForPersist("oficina-ex9975", { ...base, autonomy: { ...base.autonomy, ...read } })) as { autonomy?: { budget?: Record<string, unknown> } };
    expect(persisted.autonomy?.budget).toEqual({ cashMonthlyBRL: 1200, infraMonthlyBRL: 110 });
    const neutral = coerceAutonomy({ mode: "ultra", budget: { currency: "USD", cashMonthly: 300 } });
    const persistedNeutral = (await deriveBoardConfigForPersist("livraria-ex9975", { ...base, autonomy: { ...base.autonomy, ...neutral } })) as { autonomy?: { budget?: Record<string, unknown> } };
    expect(persistedNeutral.autonomy?.budget).toEqual({ currency: "USD", cashMonthly: 300 });
  });
});

describe("resolveCurrency do alvo + budget (a ordem declarada)", () => {
  it("board.currency > alvo > chave legada > nada", () => {
    expect(resolveCurrency(bookshop, { budgetCurrency: "EUR" })?.code).toBe("EUR");
    expect(resolveCurrency(bookshop, { legacyBudgetKeys: true })?.code).toBe("USD");
    expect(resolveCurrency(undefined, { legacyBudgetKeys: true })?.code).toBe("BRL");
    expect(resolveCurrency(undefined, {})).toBeNull();
  });
});
