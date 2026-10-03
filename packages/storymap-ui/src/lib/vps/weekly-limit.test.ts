import { describe, expect, it } from "vitest";
import { parseWeeklyTokenWindow, resolveWeeklyTokenLimit } from "./ccusage";

// O denominador do «% usado» é DECLARADO (env > vps.weeklyTokenLimit > nada). Os números abaixo são inventados — a
// assinatura de uma oficina de bicicletas fictícia —, nunca o limite de ninguém.
describe("resolveWeeklyTokenLimit — env > settings > nenhum", () => {
  it("a env vence o settings", () => {
    expect(resolveWeeklyTokenLimit("500000", 900_000)).toBe(500_000);
  });

  it("sem env vale o declarado no settings (truncado para inteiro)", () => {
    expect(resolveWeeklyTokenLimit(undefined, 900_000)).toBe(900_000);
    expect(resolveWeeklyTokenLimit(undefined, 1234.9)).toBe(1234);
  });

  it("lixo na env (vazio, zero, negativo, NaN, texto) é ignorado e o settings segue valendo", () => {
    for (const lixo of ["", "   ", "0", "-5", "abc", "NaN", "Infinity"]) expect(resolveWeeklyTokenLimit(lixo, 900_000), lixo).toBe(900_000);
  });

  it("lixo no settings também é ignorado", () => {
    for (const lixo of [0, -1, Number.NaN, Infinity, undefined]) expect(resolveWeeklyTokenLimit(undefined, lixo as number | undefined), String(lixo)).toBeNull();
  });

  it("SEM declaração devolve null — nenhum limite embutido, nenhum percentual inventado", () => {
    expect(resolveWeeklyTokenLimit(undefined, undefined)).toBeNull();
    expect(resolveWeeklyTokenLimit("", undefined)).toBeNull();
  });
});

describe("sem limite declarado o ccusage mostra tokens e custo, SEM porcentagem", () => {
  const raw = JSON.stringify({ weekly: [{ period: "2026-09-28", totalTokens: 123_456, totalCost: 7.5, modelsUsed: ["sonnet"] }] });
  const NOW = Date.UTC(2026, 9, 1, 12);

  it("limite null ⇒ usedPct/remainingPct null e limitTokens null; o uso real segue visível", () => {
    const w = parseWeeklyTokenWindow(raw, NOW, null);
    expect(w).toMatchObject({ usedTokens: 123_456, costUSD: 7.5, limitTokens: null, usedPct: null, remainingPct: null });
  });

  it("com o limite declarado calcula o percentual", () => {
    const w = parseWeeklyTokenWindow(raw, NOW, 1_234_560);
    expect(w?.usedPct).toBe(10);
    expect(w?.remainingPct).toBe(90);
  });
});
