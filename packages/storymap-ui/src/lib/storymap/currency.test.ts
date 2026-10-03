// A moeda: de onde vem (board > alvo > o próprio dado) e como vira texto. Nada de moeda por omissão.
import { describe, expect, it } from "vitest";
import { UI_LOCALE, currencySymbol, formatMoney, formatMoneyShort, resolveCurrency } from "./currency";
import { coerceTargetProfile } from "./target-profile";

describe("resolveCurrency — a moeda nunca é suposta", () => {
  const target = coerceTargetProfile({ currency: { code: "EUR", locale: "de-DE" } });

  it("o board vence o alvo; sem board declarado vale o alvo (com o locale dele)", () => {
    expect(resolveCurrency(target, { budgetCurrency: "USD" })).toEqual({ code: "USD", locale: "de-DE", source: "board" });
    expect(resolveCurrency(target, {})).toEqual({ code: "EUR", locale: "de-DE", source: "target" });
    expect(resolveCurrency(target)).toEqual({ code: "EUR", locale: "de-DE", source: "target" });
  });

  it("sem alvo nem board, só o DADO se autodeclara: teto lido por chave legada ⇒ a moeda do nome do campo", () => {
    expect(resolveCurrency(undefined, { legacyBudgetKeys: true })).toEqual({ code: "BRL", source: "legacy-keys" });
    expect(resolveCurrency(target, { legacyBudgetKeys: true })?.source).toBe("target"); // declaração vence a chave legada
  });

  it("NADA que determine a moeda ⇒ null (quem escreve ou decide dinheiro recusa)", () => {
    expect(resolveCurrency(undefined, undefined)).toBeNull();
    expect(resolveCurrency({}, {})).toBeNull();
    expect(resolveCurrency(undefined, { budgetCurrency: null })).toBeNull();
  });

  it("código inválido no board é tratado como ausente (cai para o alvo, ou null)", () => {
    for (const bad of ["xxq", "REAIS", "", "USDD"]) {
      expect(resolveCurrency(target, { budgetCurrency: bad })?.source).toBe("target");
      expect(resolveCurrency(undefined, { budgetCurrency: bad })).toBeNull();
    }
  });
});

describe("formatMoneyShort — o texto que vai PERSISTIDO", () => {
  it("é byte-idêntico ao formato legado para a moeda legada: símbolo + inteiro, sem NBSP nem milhar", () => {
    expect(formatMoneyShort(90, { code: "BRL", locale: "pt-BR" })).toBe("R$90");
    expect(formatMoneyShort(89.6, { code: "BRL" })).toBe("R$90");
    expect(formatMoneyShort(1234.4, { code: "BRL" })).toBe("R$1234");
    expect(formatMoneyShort(90, { code: "BRL" })).not.toMatch(/ /);
  });

  it("outras moedas: símbolo estreito do ICU; símbolo em letras ganha espaço", () => {
    expect(formatMoneyShort(90, { code: "USD", locale: "en-US" })).toBe("$90");
    expect(formatMoneyShort(90, { code: "EUR" })).toBe("€90");
    expect(formatMoneyShort(90, { code: "CHF" })).toBe("CHF 90");
    expect(currencySymbol("USD")).toBe("$");
  });
});

describe("formatMoney — o formato das telas", () => {
  it("usa Intl completo com o locale da moeda, ou o da UI", () => {
    expect(UI_LOCALE).toBe("pt-BR");
    expect(formatMoney(12, { code: "BRL", locale: "pt-BR" })).toBe((12).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
    expect(formatMoney(12, { code: "USD", locale: "en-US" })).toBe("$12.00");
    expect(formatMoney(12, { code: "USD" })).toBe((12).toLocaleString("pt-BR", { style: "currency", currency: "USD" }));
  });

  it("um código que o Intl recusa não lança: cai num texto legível", () => {
    expect(formatMoney(3.5, { code: "x" })).toBe("x 3.50");
  });
});
