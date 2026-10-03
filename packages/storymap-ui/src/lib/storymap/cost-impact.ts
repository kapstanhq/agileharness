// A FRONTEIRA DO DINHEIRO numa entrega. PURA.
//
//   • trocar um serviço ou modelo PAGO de que o produto depende muda custo e qualidade: é DINHEIRO, do dono; no
//     deploy o alvo marca isso pelo guard dele (um guard de gasto), e `autonomy.deployRuleClasses` diz ao AH que a
//     regra é da classe `money` (o pedido «precisa de você» nomeia a classe). A redação exata da classe, com os
//     exemplos do alvo, é a que ele declara em `autonomy.ownerClasses`;
//   • um aumento de custo DENTRO dos tetos do dono (`autonomy.budget`: caixa e infraestrutura por mês) é do SISTEMA;
//   • passar de um teto, ou trazer um fornecedor, plano pago ou API paga NOVOS, é do DONO (classe `money`), qualquer
//     que seja o valor.
// Antes de publicar, quem construiu a entrega projeta o impacto mensal — simples e honesto, com as premissas e a linha
// de base que assumiu (sem ela, 0, e a conta DIZ isso). Sem teto declarado nada prova que o aumento cabe: é do dono.

import { MONEY_CLASS, ownerClassLabel } from "./owner-classes";
import { formatMoneyShort, resolveCurrency, type CurrencyBoardInput } from "./currency";
import { isCurrencyCode, type TargetProfile } from "./target-profile";
import type { AutonomyBudget, BoardConfig, Card, CostImpact } from "./types";

// ── A MOEDA (nunca suposta pelo repositório de origem — ver currency.ts) ─────────────────────────────────────────────
// O custo anda com a moeda dele: o board a declara (`autonomy.budget.currency`), ou o alvo (`target.currency`), ou o
// próprio dado se autodeclara (uma chave legada `*BRL` leva a moeda no nome). Sem nenhuma das três, quem ESCREVE ou
// DECIDE dinheiro recusa dizendo o que declarar — o veredito nunca é calculado numa unidade desconhecida. Não existe
// câmbio: moedas diferentes nunca se comparam.

/** A moeda de uma projeção. `neutralWrites` (do alvo) só decide a GRAFIA da escrita nova de BRL. */
export interface MoneyCurrency {
  code: string;
  locale?: string;
  neutralWrites?: boolean;
}

/** O que quem construiu a entrega informa. */
export interface CostImpactInput {
  /** o AUMENTO mensal na moeda do board (a grafia neutra, a preferida). */
  monthlyAmount?: number;
  /**
   * A grafia LEGADA (chamada antiga): sozinha, significa BRL. A porta (`buildCostImpactInput`) monta a entrada só com a
   * neutra; quem lê o número usa {@link amountOf}, que entende as duas.
   */
  monthlyBRL?: number;
  scope: "infra" | "cash";
  assumptions: string;
  baselineMonthlyAmount?: number;
  /** a grafia legada da linha de base, como `monthlyBRL`. */
  baselineMonthlyBRL?: number;
  newVendor?: string;
  paidPlan?: boolean;
  paidApi?: boolean;
  /** a moeda JÁ resolvida pela porta (board → alvo). Ausente: a chamada legada vale BRL; a neutra cai no teto do board. */
  currency?: MoneyCurrency;
}

export interface CostImpactVerdict {
  owner: boolean;
  ownerClass: typeof MONEY_CLASS;
  /** a moeda em que a conta foi feita; null ⇒ não resolvida (o veredito vai ao dono). */
  currency: MoneyCurrency | null;
  projectedMonthly: number;
  ceiling: number | null;
  reason: string;
}

/** O aumento mensal da entrada, na grafia que vier. PURA. */
// Sem nenhuma das duas grafias vale NaN: `costImpactError` o recusa («precisa ser um número») em vez de gravar um zero inventado.
export const amountOf = (input: Pick<CostImpactInput, "monthlyAmount" | "monthlyBRL">): number => input.monthlyAmount ?? input.monthlyBRL ?? Number.NaN;
/** A linha de base da entrada, na grafia que vier. PURA. */
export const baselineOf = (input: Pick<CostImpactInput, "baselineMonthlyAmount" | "baselineMonthlyBRL">): number | undefined =>
  input.baselineMonthlyAmount ?? input.baselineMonthlyBRL;

/**
 * O valor mensal da entrada no formato CURTO, na moeda do veredito (para texto que vai PERSISTIDO). Sem moeda resolvida
 * (só acontece num aumento zero) vale a da grafia legada, que é a que o nome do campo diz. PURA.
 */
export const moneyTextOf = (input: Pick<CostImpactInput, "monthlyAmount" | "monthlyBRL">, verdict: Pick<CostImpactVerdict, "currency">): string =>
  formatMoneyShort(amountOf(input), verdict.currency ?? { code: "BRL" });

/** Os tetos/baselines do board lidos nas DUAS grafias (a neutra vence quando as duas existem na mesma chave). PURA. */
export interface BudgetFigures {
  cash?: number;
  infra?: number;
  baselineCash?: number;
  baselineInfra?: number;
  /** a moeda do teto: a declarada, ou BRL quando o teto veio por chave legada; undefined ⇒ a do alvo. */
  currency?: string;
  /** o board usa (ao menos uma) chave legada. */
  legacy: boolean;
}

const LEGACY_BUDGET_KEYS = ["cashMonthlyBRL", "infraMonthlyBRL", "baselineCashMonthlyBRL", "baselineInfraMonthlyBRL"] as const;

export function budgetFigures(b: AutonomyBudget | null | undefined): BudgetFigures {
  const legacy = LEGACY_BUDGET_KEYS.some((k) => typeof b?.[k] === "number");
  const currency = isCurrencyCode(b?.currency) ? b?.currency : legacy ? "BRL" : undefined;
  const cash = b?.cashMonthly ?? b?.cashMonthlyBRL;
  const infra = b?.infraMonthly ?? b?.infraMonthlyBRL;
  const baselineCash = b?.baselineCashMonthly ?? b?.baselineCashMonthlyBRL;
  const baselineInfra = b?.baselineInfraMonthly ?? b?.baselineInfraMonthlyBRL;
  return {
    ...(cash != null ? { cash } : {}),
    ...(infra != null ? { infra } : {}),
    ...(baselineCash != null ? { baselineCash } : {}),
    ...(baselineInfra != null ? { baselineInfra } : {}),
    ...(currency ? { currency } : {}),
    legacy,
  };
}

/** O que a resolução da moeda (currency.ts) precisa saber do teto do board. PURA. */
export function budgetCurrencyInput(b: AutonomyBudget | null | undefined): CurrencyBoardInput {
  const f = budgetFigures(b);
  return { budgetCurrency: isCurrencyCode(b?.currency) ? b?.currency : null, legacyBudgetKeys: f.legacy };
}

/** A moeda em que a ENTRADA está, ou null. Entrada legada (`monthlyBRL` sozinho) vale BRL: a unidade vai no nome do campo. PURA. */
function currencyOfInput(input: CostImpactInput, budget: AutonomyBudget | null | undefined): MoneyCurrency | null {
  if (input.currency) return input.currency;
  if (input.monthlyAmount == null) return { code: "BRL" };
  const r = resolveCurrency(null, budgetCurrencyInput(budget));
  return r ? { code: r.code } : null;
}

/** O que o operador escreve para declarar a moeda. */
export const CURRENCY_DECLARE_HOW =
  "declare em storymap/settings.yaml → target.currency: {code: <ISO 4217>, locale: <BCP 47>} (ou autonomy.budget.currency no board.yaml)";
/** A frase de «moeda não declarada» — a recusa da porta, que diz exatamente o que declarar. */
export const CURRENCY_UNDECLARED_HINT = `o alvo não declara a moeda do custo — ${CURRENCY_DECLARE_HOW} e projete de novo`;

/** Por que a projeção está incompleta — ou null. PURA. */
export function costImpactError(input: CostImpactInput): string | null {
  const amount = amountOf(input);
  if (!Number.isFinite(amount) || amount < 0) return "o impacto mensal precisa ser um número (por mês, 0 ou mais, na moeda do alvo)";
  if (input.scope !== "infra" && input.scope !== "cash") return "escopo: infra ou cash";
  if (!input.assumptions?.trim()) return "diga as premissas da projeção (de onde vem o número)";
  const base = baselineOf(input);
  if (base != null && (!Number.isFinite(base) || base < 0)) return "a linha de base precisa ser um número";
  return null;
}

/** Quem decide este aumento de custo: dentro do teto, o sistema; fora, ou algo pago NOVO, o dono (dinheiro). PURA. */
export function costImpactVerdict(input: CostImpactInput, config: Pick<BoardConfig, "autonomy"> | null | undefined): CostImpactVerdict {
  const b = config?.autonomy?.budget;
  const fig = budgetFigures(b);
  const cur = currencyOfInput(input, b);
  const amount = amountOf(input);
  const ceiling = (input.scope === "infra" ? fig.infra : fig.cash) ?? null;
  const declaredBase = baselineOf(input) ?? (input.scope === "infra" ? fig.baselineInfra : fig.baselineCash);
  const baseline = declaredBase ?? 0;
  const projected = baseline + amount;
  const label = input.scope === "infra" ? "infraestrutura" : "caixa";
  const owner = (reason: string): CostImpactVerdict => ({ owner: true, ownerClass: MONEY_CLASS, currency: cur, projectedMonthly: projected, ceiling, reason });
  if (input.newVendor?.trim()) return owner(`traz um fornecedor NOVO (${input.newVendor.trim()}) — dinheiro, decisão sua`);
  if (input.paidPlan) return owner("assina um plano pago novo — dinheiro, decisão sua");
  if (input.paidApi) return owner("passa a usar uma API paga nova — dinheiro, decisão sua");
  if (amount === 0) {
    return { owner: false, ownerClass: MONEY_CLASS, currency: cur, projectedMonthly: projected, ceiling, reason: "a entrega não aumenta o custo mensal" };
  }
  // Sem moeda não há conta: a ferramenta não chuta uma unidade para o dinheiro do dono.
  if (!cur) return owner(`aumenta o custo mensal e a moeda do custo não está declarada (${CURRENCY_DECLARE_HOW}) — não dá para provar que cabe`);
  const money = (n: number) => formatMoneyShort(n, cur);
  const baseNote = declaredBase == null ? ` (sem linha de base conhecida — assumido ${money(0)})` : "";
  if (ceiling == null) return owner(`aumenta o custo em ${money(amount)}/mês e não há teto de ${label} declarado — não dá para provar que cabe`);
  // Sem câmbio: um teto em outra moeda não se compara. Vai ao dono em vez de inventar uma taxa.
  if (fig.currency && fig.currency !== cur.code) {
    return owner(`projeta ${amount} ${cur.code}/mês de ${label}, mas o teto de ${label} está em ${fig.currency} — a ferramenta não converte moedas; decisão sua`);
  }
  if (projected > ceiling) {
    return owner(`projeta ${money(projected)}/mês de ${label}${baseNote} (+${money(amount)}), acima do seu teto de ${money(ceiling)} — decisão sua`);
  }
  return {
    owner: false,
    ownerClass: MONEY_CLASS,
    currency: cur,
    projectedMonthly: projected,
    ceiling,
    reason: `projeta ${money(projected)}/mês de ${label}${baseNote} (+${money(amount)}), dentro do teto de ${money(ceiling)} — o sistema decide`,
  };
}

/**
 * Grava a projeção no card; quando o veredito é do dono, o card passa a TOCAR a classe `money` (as paradas dele —
 * gate, aprovação — vão ao dono, pela régua de sempre). PURA.
 *
 * A GRAFIA da escrita: BRL sem `neutralWrites` segue na chave LEGADA (`monthlyBRL`) — um release antigo lê o card
 * neutro como «sem projeção» e o próximo write dele apagaria o dado. Qualquer outra moeda nunca teve grafia legada, então
 * é sempre neutra (`monthlyAmount` + `currency`). Sem moeda resolvida não há unidade para gravar o número: o card só
 * ganha a marca do dono (a porta já recusou antes; isto é a defesa em profundidade).
 */
export function applyCostImpact(card: Card, input: CostImpactInput, verdict: CostImpactVerdict, opts: { by: string; at: string }): Card {
  const cur = verdict.currency;
  const amount = amountOf(input);
  const base = baselineOf(input);
  const legacy = cur?.code === "BRL" && !cur.neutralWrites;
  // A ORDEM das chaves é a de sempre (valor, scope, assumptions, linha de base, fornecedor…): o card sobe ao disco nessa
  // ordem e uma ordem nova reescreveria o frontmatter dos cards já gravados no 1º write de qualquer campo.
  const value: Partial<CostImpact> = !cur ? {} : legacy ? { monthlyBRL: amount } : { monthlyAmount: amount };
  const baseline: Partial<CostImpact> = !cur
    ? {}
    : legacy
      ? base != null
        ? { baselineMonthlyBRL: base }
        : {}
      : { ...(base != null ? { baselineMonthlyAmount: base } : {}), currency: cur.code };
  const impact = {
    ...value,
    scope: input.scope,
    assumptions: input.assumptions.trim(),
    ...baseline,
    ...(input.newVendor?.trim() ? { newVendor: input.newVendor.trim() } : {}),
    ...(input.paidPlan ? { paidPlan: true } : {}),
    ...(input.paidApi ? { paidApi: true } : {}),
    decider: verdict.owner ? "owner" : "system",
    by: opts.by,
    at: opts.at,
  } as CostImpact;
  const withImpact = cur ? { ...card, costImpact: impact } : card;
  if (!verdict.owner) return withImpact;
  const ids = [...new Set([...(card.businessClasses?.ids ?? []), MONEY_CLASS])];
  return { ...withImpact, businessClasses: { ids, reason: verdict.reason, by: opts.by, at: opts.at } };
}

/** O valor de um impacto GRAVADO, nas duas grafias: o número, a linha de base e a moeda (a legada vale BRL). PURA. */
export function costImpactFigures(ci: CostImpact): { amount: number; baseline?: number; currency: string | null; legacy: boolean } {
  if (ci.monthlyAmount != null) {
    return { amount: ci.monthlyAmount, ...(ci.baselineMonthlyAmount != null ? { baseline: ci.baselineMonthlyAmount } : {}), currency: ci.currency ?? null, legacy: false };
  }
  return { amount: ci.monthlyBRL ?? 0, ...(ci.baselineMonthlyBRL != null ? { baseline: ci.baselineMonthlyBRL } : {}), currency: "BRL", legacy: true };
}

/** O que a tool `record_cost_projection` recebe (as duas grafias do número; todas opcionais no esquema). */
export interface CostProjectionArgs {
  monthlyAmount?: number;
  baselineMonthlyAmount?: number;
  /** @deprecated alias da chamada antiga: só vale quando a moeda do board é BRL. */
  monthlyBRL?: number;
  /** @deprecated alias da chamada antiga. */
  baselineMonthlyBRL?: number;
  scope: "infra" | "cash";
  assumptions: string;
  newVendor?: string;
  paidPlan?: boolean;
  paidApi?: boolean;
}

/** Junta as duas grafias de UM número: iguais ou só uma ⇒ ele; diferentes ⇒ erro. */
function oneAmount(neutral: number | undefined, legacy: number | undefined, names: [string, string]): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (neutral != null && legacy != null && neutral !== legacy) return { ok: false, error: `${names[0]} e ${names[1]} divergem (${neutral} × ${legacy}) — mande só ${names[0]}` };
  return { ok: true, value: neutral ?? legacy };
}

/**
 * A PORTA da projeção de custo (MCP): valida as duas grafias do número, resolve a MOEDA do board/alvo e monta a entrada
 * que o veredito lê. O agente NÃO escolhe a moeda (evita projetar em USD contra um teto em BRL): ela é do board → alvo.
 * Recusa, sem tocar o card, quando nada determina a moeda. PURA.
 */
export function buildCostImpactInput(
  args: CostProjectionArgs,
  ctx: { config: Pick<BoardConfig, "autonomy"> | null | undefined; target: Pick<TargetProfile, "currency"> | null | undefined },
): { ok: true; input: CostImpactInput } | { ok: false; error: string } {
  const monthly = oneAmount(args.monthlyAmount, args.monthlyBRL, ["monthlyAmount", "monthlyBRL"]);
  if (!monthly.ok) return monthly;
  if (monthly.value == null) return { ok: false, error: "informe monthlyAmount (o AUMENTO mensal, na moeda do alvo; 0 quando não custa nada a mais)" };
  const baseline = oneAmount(args.baselineMonthlyAmount, args.baselineMonthlyBRL, ["baselineMonthlyAmount", "baselineMonthlyBRL"]);
  if (!baseline.ok) return baseline;
  const resolved = resolveCurrency(ctx.target, budgetCurrencyInput(ctx.config?.autonomy?.budget));
  if (!resolved) return { ok: false, error: CURRENCY_UNDECLARED_HINT };
  const usedLegacy = args.monthlyBRL != null || args.baselineMonthlyBRL != null;
  if (usedLegacy && resolved.code !== "BRL") return { ok: false, error: `o alvo declara ${resolved.code}; use monthlyAmount (monthlyBRL só vale em BRL)` };
  const input: CostImpactInput = {
    monthlyAmount: monthly.value,
    scope: args.scope,
    assumptions: args.assumptions,
    ...(baseline.value != null ? { baselineMonthlyAmount: baseline.value } : {}),
    ...(args.newVendor !== undefined ? { newVendor: args.newVendor } : {}),
    ...(args.paidPlan !== undefined ? { paidPlan: args.paidPlan } : {}),
    ...(args.paidApi !== undefined ? { paidApi: args.paidApi } : {}),
    currency: {
      code: resolved.code,
      ...(resolved.locale ? { locale: resolved.locale } : {}),
      ...(ctx.target?.currency?.neutralWrites !== undefined ? { neutralWrites: ctx.target.currency.neutralWrites } : {}),
    },
  };
  return { ok: true, input };
}

/** A classe do dono das regras de deploy que pediram o dono (`autonomy.deployRuleClasses`), ou null. PURA. */
export function ownerClassOfDeployRules(rules: readonly string[], config: Pick<BoardConfig, "autonomy"> | null | undefined): string | null {
  const map = config?.autonomy?.deployRuleClasses ?? {};
  for (const r of rules) if (map[r]) return map[r];
  return null;
}

/** O rótulo da classe das regras de deploy, para o pedido «precisa de você». PURA. */
export function deployRulesOwnerLabel(rules: readonly string[], config: Pick<BoardConfig, "autonomy"> | null | undefined): string | null {
  const cls = ownerClassOfDeployRules(rules, config);
  return cls ? ownerClassLabel(cls, config) : null;
}
