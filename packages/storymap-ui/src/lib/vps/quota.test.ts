import { beforeEach, describe, expect, it } from "vitest";
import { clearQuotaCache, projectBucket, readQuota } from "./quota";
import type { TokenWindow, UsageWindow, VpsMetrics } from "@/lib/vps/types";

describe("projectBucket — extrapolação linear da janela rolante", () => {
  it("projeta o total da janela a partir do ritmo médio e diz quantos minutos faltam para o teto", () => {
    // 20% queimados na metade de uma janela de 5h ⇒ 40% ao final; o teto chega em 600 min.
    expect(projectBucket({ usedPct: 20, resetsInMinutes: 150 }, 300)).toEqual({
      projectedPct: 40,
      willExceedBeforeReset: false,
      minutesToLimit: 600,
    });
  });

  it("acusa o estouro antes do reset quando o ritmo passa de 100%", () => {
    // 80% queimados em 100 min de 300 ⇒ 240% projetados: o teto chega em 25 min, muito antes do reset.
    expect(projectBucket({ usedPct: 80, resetsInMinutes: 200 }, 300)).toEqual({
      projectedPct: 240,
      willExceedBeforeReset: true,
      minutesToLimit: 25,
    });
  });

  it("cedo demais para extrapolar devolve null — 5 min de dados não são uma previsão", () => {
    // 1,7% da janela decorrido: qualquer número aqui seria ruído apresentado como projeção.
    expect(projectBucket({ usedPct: 1, resetsInMinutes: 295 }, 300)).toBeNull();
    // a fronteira: exatamente 5% já projeta.
    expect(projectBucket({ usedPct: 1, resetsInMinutes: 285 }, 300)).not.toBeNull();
  });

  it("consumo zero não vira Infinity — ausência de ritmo é null, nunca um número", () => {
    expect(projectBucket({ usedPct: 0, resetsInMinutes: 150 }, 300)).toEqual({
      projectedPct: 0,
      willExceedBeforeReset: false,
      minutesToLimit: null,
    });
  });
});

const NOW = Date.parse("2026-07-23T13:52:56.870Z");

/** A snapshot carrying ONLY what the quota block reads — everything else is honestly null. */
function snapshot(over: Partial<VpsMetrics>): VpsMetrics {
  return { at: NOW, ram: null, disk: null, load: null, tokens: null, usage: null, headroom: null, ...over };
}

describe("readQuota — a manchete é a janela de assinatura", () => {
  beforeEach(() => {
    clearQuotaCache();
  });

  it("recomputa `stale` contra o relógio e nunca confia no placeholder false do parser", async () => {
    const usage: UsageWindow = {
      source: "subscription",
      session: { usedPct: 1, resetsInMinutes: 274 },
      week: { usedPct: 17, resetsInMinutes: 8114 },
      // a proxy não reporta a janela Sonnet nesta caixa — ela some do array, não vira uma 3ª barra zerada
      weekSonnet: null,
      extra: null,
      polledAt: NOW - 40 * 60_000, // 40 min > orçamento de 20 min
      stale: false, // parseHeadroomStats não tem relógio (subscription.ts) — escreve este placeholder
    };

    const block = await readQuota(NOW, async () => snapshot({ usage }));

    expect(block?.stale).toBe(true);
    expect(block?.source).toBe("subscription");
    expect(block?.approximate).toBe(false);
    expect(block?.buckets.map((b) => b.id)).toEqual(["session", "week"]);
  });

  it("ccusage só entra marcado como aproximado — 100% dele nunca vira a manchete", async () => {
    // Evidência viva: ccusage diz 100% contra um limite ADIVINHADO de 760M enquanto a semana real diz 17%.
    const tokens: TokenWindow = {
      source: "ccusage",
      startedAt: NOW - 3 * 24 * 60 * 60_000,
      resetsAt: NOW + 4 * 24 * 60 * 60_000,
      resetsInMinutes: 5760,
      usedTokens: 760_000_000,
      costUSD: 61.72,
      limitTokens: 760_000_000,
      remainingPct: 0,
      usedPct: 100,
      projectedTokens: null,
      willExceedBeforeReset: null,
      burnTokensPerMin: null,
      burnCostPerHour: null,
      models: [],
    };

    const block = await readQuota(NOW, async () => snapshot({ usage: null, tokens }));

    expect(block?.source).toBe("ccusage");
    expect(block?.approximate).toBe(true);
    expect(block?.buckets.map((b) => b.id)).toEqual(["week"]);
    expect(block?.costUSD).toBe(61.72);
  });
});
