import { describe, expect, it } from "vitest";
import { needsTriageReview } from "./demands";
import type { Card } from "./types";

// `needsHumanReview` significa UMA coisa: o card chegou sem ninguém olhar. Havia DOIS consumidores
// lendo o campo com regras diferentes — o item do cockpit guardado por `def.staging`, o CTA do card
// sem guarda nenhuma. Efeito visível: "Revisar item da triagem (baixa confiança)" continuava no card
// já em Dúvidas, com run em voo. Este arquivo fixa a regra única.

const card = (needsHumanReview?: boolean) => ({ needsHumanReview }) as Pick<Card, "needsHumanReview">;

describe("needsTriageReview — a cobrança morre quando o card sai da quarentena", () => {
  it("é devida enquanto o card está na lane de quarentena", () => {
    expect(needsTriageReview(card(true), { staging: true })).toBe(true);
  });

  it("NÃO é devida depois que o card avança — avançar É a revisão acontecendo", () => {
    // o caso do print: card em Dúvidas (não-staging), rodando, ainda exibindo o CTA de triagem
    expect(needsTriageReview(card(true), { staging: false })).toBe(false);
    expect(needsTriageReview(card(true), {})).toBe(false);
  });

  it("sem a flag, nunca é devida", () => {
    expect(needsTriageReview(card(false), { staging: true })).toBe(false);
    expect(needsTriageReview(card(undefined), { staging: true })).toBe(false);
  });

  it("status desconhecido/ausente não cobra nada (defensivo)", () => {
    expect(needsTriageReview(card(true), null)).toBe(false);
    expect(needsTriageReview(card(true), undefined)).toBe(false);
  });
});
