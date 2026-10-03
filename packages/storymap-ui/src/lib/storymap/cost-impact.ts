// A FRONTEIRA DO DINHEIRO numa entrega. PURA.
//
//   • trocar o modelo de IA usado nas respostas ao usuário é DINHEIRO (custo por chamada + qualidade) — do dono; no
//     deploy o alvo marca isso pelo guard dele (ex.: um guard de gasto com modelo), e `autonomy.deployRuleClasses` diz ao AH que a
//     regra é da classe `money` (o pedido «precisa de você» nomeia a classe);
//   • um aumento de custo DENTRO dos tetos do dono (`autonomy.budget`: caixa e infraestrutura por mês) é do SISTEMA;
//   • passar de um teto, ou trazer um fornecedor, plano pago ou API paga NOVOS, é do DONO (classe `money`), qualquer
//     que seja o valor.
// Antes de publicar, quem construiu a entrega projeta o impacto mensal — simples e honesto, com as premissas e a linha
// de base que assumiu (sem ela, 0, e a conta DIZ isso). Sem teto declarado nada prova que o aumento cabe: é do dono.

import { MONEY_CLASS, ownerClassLabel } from "./owner-classes";
import type { BoardConfig, Card, CostImpact } from "./types";

/** O que quem construiu a entrega informa. */
export interface CostImpactInput {
  monthlyBRL: number;
  scope: "infra" | "cash";
  assumptions: string;
  baselineMonthlyBRL?: number;
  newVendor?: string;
  paidPlan?: boolean;
  paidApi?: boolean;
}

export interface CostImpactVerdict {
  owner: boolean;
  ownerClass: typeof MONEY_CLASS;
  projectedMonthlyBRL: number;
  ceilingBRL: number | null;
  reason: string;
}

const brl = (n: number) => `R$${Math.round(n)}`;

/** Por que a projeção está incompleta — ou null. PURA. */
export function costImpactError(input: CostImpactInput): string | null {
  if (!Number.isFinite(input.monthlyBRL) || input.monthlyBRL < 0) return "o impacto mensal precisa ser um número (R$/mês, 0 ou mais)";
  if (input.scope !== "infra" && input.scope !== "cash") return "escopo: infra ou cash";
  if (!input.assumptions?.trim()) return "diga as premissas da projeção (de onde vem o número)";
  if (input.baselineMonthlyBRL != null && (!Number.isFinite(input.baselineMonthlyBRL) || input.baselineMonthlyBRL < 0)) return "a linha de base precisa ser um número";
  return null;
}

/** Quem decide este aumento de custo: dentro do teto, o sistema; fora, ou algo pago NOVO, o dono (dinheiro). PURA. */
export function costImpactVerdict(input: CostImpactInput, config: Pick<BoardConfig, "autonomy"> | null | undefined): CostImpactVerdict {
  const b = config?.autonomy?.budget;
  const ceiling = input.scope === "infra" ? (b?.infraMonthlyBRL ?? null) : (b?.cashMonthlyBRL ?? null);
  const declaredBase = input.baselineMonthlyBRL ?? (input.scope === "infra" ? b?.baselineInfraMonthlyBRL : b?.baselineCashMonthlyBRL);
  const baseline = declaredBase ?? 0;
  const projected = baseline + input.monthlyBRL;
  const baseNote = declaredBase == null ? " (sem linha de base conhecida — assumido R$0)" : "";
  const label = input.scope === "infra" ? "infraestrutura" : "caixa";
  const owner = (reason: string): CostImpactVerdict => ({ owner: true, ownerClass: MONEY_CLASS, projectedMonthlyBRL: projected, ceilingBRL: ceiling, reason });
  if (input.newVendor?.trim()) return owner(`traz um fornecedor NOVO (${input.newVendor.trim()}) — dinheiro, decisão sua`);
  if (input.paidPlan) return owner("assina um plano pago novo — dinheiro, decisão sua");
  if (input.paidApi) return owner("passa a usar uma API paga nova — dinheiro, decisão sua");
  if (input.monthlyBRL === 0) {
    return { owner: false, ownerClass: MONEY_CLASS, projectedMonthlyBRL: projected, ceilingBRL: ceiling, reason: "a entrega não aumenta o custo mensal" };
  }
  if (ceiling == null) return owner(`aumenta o custo em ${brl(input.monthlyBRL)}/mês e não há teto de ${label} declarado — não dá para provar que cabe`);
  if (projected > ceiling) {
    return owner(`projeta ${brl(projected)}/mês de ${label}${baseNote} (+${brl(input.monthlyBRL)}), acima do seu teto de ${brl(ceiling)} — decisão sua`);
  }
  return {
    owner: false,
    ownerClass: MONEY_CLASS,
    projectedMonthlyBRL: projected,
    ceilingBRL: ceiling,
    reason: `projeta ${brl(projected)}/mês de ${label}${baseNote} (+${brl(input.monthlyBRL)}), dentro do teto de ${brl(ceiling)} — o sistema decide`,
  };
}

/**
 * Grava a projeção no card; quando o veredito é do dono, o card passa a TOCAR a classe `money` (as paradas dele —
 * gate, aprovação — vão ao dono, pela régua de sempre). PURA.
 */
export function applyCostImpact(card: Card, input: CostImpactInput, verdict: CostImpactVerdict, opts: { by: string; at: string }): Card {
  const impact: CostImpact = {
    monthlyBRL: input.monthlyBRL,
    scope: input.scope,
    assumptions: input.assumptions.trim(),
    ...(input.baselineMonthlyBRL != null ? { baselineMonthlyBRL: input.baselineMonthlyBRL } : {}),
    ...(input.newVendor?.trim() ? { newVendor: input.newVendor.trim() } : {}),
    ...(input.paidPlan ? { paidPlan: true } : {}),
    ...(input.paidApi ? { paidApi: true } : {}),
    decider: verdict.owner ? "owner" : "system",
    by: opts.by,
    at: opts.at,
  };
  if (!verdict.owner) return { ...card, costImpact: impact };
  const ids = [...new Set([...(card.businessClasses?.ids ?? []), MONEY_CLASS])];
  return { ...card, costImpact: impact, businessClasses: { ids, reason: verdict.reason, by: opts.by, at: opts.at } };
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
