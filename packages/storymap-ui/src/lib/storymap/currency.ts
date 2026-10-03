// A MOEDA — de onde ela vem e como vira texto. PURO (só `Intl`), isomórfico.
//
// POR QUE EXISTE: a ferramenta supunha a moeda de quem a escreveu (tetos, projeções, mensagens e o resumo da semana
// falavam em «R$»). Numa instalação que cobra em outra moeda, o veredito de dinheiro — a fronteira do dono — sairia em
// unidade errada. A regra agora é: a moeda NUNCA é suposta pelo repositório de origem. Ela vem, nesta ordem, de
//   (a) o BOARD (`autonomy.budget.currency`: o teto é a unidade de comparação, a moeda anda com o número que o dono escreveu),
//   (b) o ALVO (`target.currency` no settings.yaml),
//   (c) o próprio DADO, quando ele se autodeclara (o teto lido por uma chave legada `*BRL` carrega a moeda no nome),
// e, sem nenhuma das três, é «não resolvida» (null): quem ESCREVE ou DECIDE dinheiro recusa dizendo o que declarar;
// quem só EXIBE um impacto que já traz a própria moeda usa a dele. Não existe câmbio: moedas diferentes nunca se somam
// nem se comparam (a ferramenta jamais inventa uma taxa).

import { isCurrencyCode, type TargetCurrency, type TargetProfile } from "./target-profile";

/** O idioma da UI (toda a UI é pt-BR) — o locale de EXIBIÇÃO quando o alvo não declara um. Não é suposição sobre o repositório. */
export const UI_LOCALE = "pt-BR";

/** O que a resolução precisa saber de UM board. Estrutural: o `BoardConfig` passa por aqui sem ser importado. */
export interface CurrencyBoardInput {
  /** `autonomy.budget.currency` do board, quando declarada. */
  budgetCurrency?: string | null;
  /**
   * O teto do board foi lido por chaves LEGADAS (`cashMonthlyBRL`…): a moeda vem no nome do campo, então é `BRL` mesmo
   * sem declaração. É o dado se autodeclarando, não uma suposição.
   */
  legacyBudgetKeys?: boolean;
}

/** A moeda resolvida de um board: o código, o locale (só se o alvo declarou) e de onde veio. */
export interface ResolvedCurrency {
  code: string;
  locale?: string;
  source: "board" | "target" | "legacy-keys";
}

/**
 * A moeda de um board, ou `null` quando NADA a determina (quem escreve/decide dinheiro recusa nesse caso).
 * Código inválido no board é tratado como ausente (cai para o alvo). PURA.
 */
export function resolveCurrency(target: Pick<TargetProfile, "currency"> | null | undefined, board?: CurrencyBoardInput | null): ResolvedCurrency | null {
  const t: TargetCurrency | undefined = target?.currency;
  const locale = t?.locale ? { locale: t.locale } : {};
  if (isCurrencyCode(board?.budgetCurrency)) return { code: board.budgetCurrency, ...locale, source: "board" };
  if (t) return { code: t.code, ...locale, source: "target" };
  if (board?.legacyBudgetKeys) return { code: "BRL", ...locale, source: "legacy-keys" };
  return null;
}

/** O símbolo curto da moeda segundo o ICU («R$», «$», «€»; uma moeda sem símbolo próprio cai no código: «CHF»). */
export function currencySymbol(code: string, locale: string = UI_LOCALE): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

/**
 * O formato CURTO, para texto que vai PERSISTIDO (razão de decisão, mensagens do veredito): `${símbolo}${inteiro}`,
 * sem milhar e sem espaço — para BRL/pt-BR é BYTE-IDÊNTICO a `R$90` (o `Intl` completo daria `R$ 90` com NBSP e mudaria
 * texto observável). Um símbolo que termina em letra ganha um espaço: `CHF 90`. PURA.
 */
export function formatMoneyShort(amount: number, currency: { code: string; locale?: string }): string {
  const symbol = currencySymbol(currency.code, currency.locale ?? UI_LOCALE);
  const sep = /[A-Za-z]$/.test(symbol) ? " " : "";
  return `${symbol}${sep}${Math.round(amount)}`;
}

/** O formato COMPLETO das telas (com centavos, milhar e o espaço do locale). PURA. */
export function formatMoney(amount: number, currency: { code: string; locale?: string }): string {
  try {
    return new Intl.NumberFormat(currency.locale ?? UI_LOCALE, { style: "currency", currency: currency.code }).format(amount);
  } catch {
    return `${currency.code} ${amount.toFixed(2)}`;
  }
}
