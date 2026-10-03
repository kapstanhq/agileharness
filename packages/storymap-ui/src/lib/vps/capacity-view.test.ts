import { describe, expect, it } from "vitest";
import { capacityView } from "./capacity-view";
import type { GovernorSnapshot } from "@/lib/storymap/runner/capacity-governor";

// O PAINEL de capacidade: o que ele diz em cada estado — liberado, retido (com o porquê e quando volta),
// travado (mole/dura/HALT, e se oferece o botão de soltar), inerte — e a honestidade do número defasado.

const NOW = Date.UTC(2026, 8, 25, 12, 0);
const CAPS = { weekCapPct: 80, weekCapLast24hPct: 90, fiveHourCapPct: 85, latchWeekPct: 92, latchFiveHourPct: 90 };

function snap(over: Partial<GovernorSnapshot> = {}): GovernorSnapshot {
  return {
    at: NOW,
    enabled: true,
    inert: null,
    verdict: { kind: "admit", reason: "admit", detail: "dentro do ritmo", retryAt: null },
    reading: { usage7dPct: 42.3, usage5hPct: 20, resetsAt7d: NOW + 3 * 86_400_000, resetsAt5h: NOW + 3_600_000, polledAt: NOW - 60_000, extraUsageEnabled: false, stale: false },
    pacing: { day: "2026-09-25", ceilingPct: 80, last24h: false, baselinePct: 40, allowancePct: 10, usedTodayPct: 2.3, daysUntilReset: 3.5 },
    projectionAtResetPct: 71.2,
    held: { count: 0, oldestSince: null },
    latch: null,
    meterStall: null,
    caps: CAPS,
    ...over,
  };
}

describe("capacityView", () => {
  it("sem retrato ⇒ null (o painel mostra a ausência, não um zero)", () => {
    expect(capacityView(null, NOW)).toBeNull();
  });

  it("liberado: janela 7d/5h com o teto, a cota de hoje, a projeção e os retidos", () => {
    const v = capacityView(snap(), NOW)!;
    expect(v).toMatchObject({ tone: "idle", headline: "Automação liberada", canClear: false, latch: null, retry: null });
    expect(v.rows.map((r) => [r.key, r.value])).toEqual([
      ["week", "42.3% · teto 80%"],
      ["session", "20% · teto 85%"],
      ["today", "2.3 de 10 pp"],
      ["projection", "71.2%"],
      ["held", "nenhum"],
    ]);
    expect(v.rows.find((r) => r.key === "today")?.pct).toBeCloseTo(23);
  });

  it("retido: diz POR QUÊ e QUANDO volta; conta os retidos e há quanto tempo", () => {
    const v = capacityView(
      snap({
        verdict: { kind: "hold", reason: "daily-allowance", detail: "a cota de hoje acabou", retryAt: NOW + 3_600_000 },
        held: { count: 3, oldestSince: NOW - 5 * 3_600_000 },
      }),
      NOW,
    )!;
    expect(v.tone).toBe("attention");
    expect(v.headline).toBe("Automação retida — cota de hoje esgotada");
    expect(v.retry).toMatch(/^volta a tentar às \d\d:\d\d$/);
    expect(v.rows.find((r) => r.key === "held")?.value).toBe("3 · o mais antigo há 5h");
  });

  it("travado pelo arquivo: tom de perigo e o botão de SOLTAR; pelo HALT: sem botão (sai no host)", () => {
    const latched = capacityView(
      snap({ latch: { level: "soft", reason: "janela de 7 dias em 93%", at: NOW - 600_000, trippedBy: "auto:week", source: "file" } }),
      NOW,
    )!;
    expect(latched).toMatchObject({ tone: "danger", headline: "Travado (mole)", canClear: true, detail: "janela de 7 dias em 93%" });
    expect(latched.latch).toMatchObject({ by: "auto:week", since: "há 10min", halt: false });
    const halt = capacityView(
      snap({ latch: { level: "hard", reason: "arquivo /etc/agileharness/HALT presente no host", at: NOW, trippedBy: "host:HALT", source: "halt" } }),
      NOW,
    )!;
    expect(halt).toMatchObject({ tone: "danger", headline: "Travado — HALT do host", canClear: false });
  });

  it("inerte sem medidor: sem linhas de janela (não inventa número), só os retidos", () => {
    const v = capacityView(snap({ inert: "no-meter", reading: null, pacing: null, projectionAtResetPct: null, verdict: { kind: "admit", reason: "no-meter", detail: "sem medidor", retryAt: null } }), NOW)!;
    expect(v.headline).toBe("Inerte — sem medidor de uso");
    expect(v.rows.map((r) => r.key)).toEqual(["held"]);
  });

  it("leitura defasada: as barras ficam, sem cor de autoridade; 5h desconhecida é '—'", () => {
    const base = snap();
    const v = capacityView(snap({ reading: { ...base.reading!, stale: true, usage5hPct: null } }), NOW)!;
    expect(v.rows.find((r) => r.key === "week")?.muted).toBe(true);
    expect(v.rows.find((r) => r.key === "session")).toMatchObject({ value: "—", pct: null });
  });

  it("medidor PARADO: é o impasse, não uma espera — tom de perigo, a manchete diz, o detalhe traz o desde-quando e a saída", () => {
    const detail = "medidor de cota parado desde 01:48 — automação retida; causa provável: sem tráfego pelo proxy de uso";
    const v = capacityView(
      snap({
        verdict: { kind: "hold", reason: "stale", detail: "leitura de uso defasada (90min, limite 20min)", retryAt: NOW + 300_000 },
        reading: { usage7dPct: 42.3, usage5hPct: 20, resetsAt7d: NOW + 3 * 86_400_000, resetsAt5h: NOW + 3_600_000, polledAt: NOW - 90 * 60_000, extraUsageEnabled: false, stale: true },
        meterStall: { since: NOW - 90 * 60_000, detectedAt: NOW - 60 * 60_000, detail },
      }),
      NOW,
    )!;
    expect(v.tone).toBe("danger");
    expect(v.headline).toBe("Medidor de cota PARADO — automação retida");
    expect(v.detail).toBe(detail);
    // a trava, quando existe, continua vencendo (é ela que o operador precisa soltar)
    const locked = capacityView(snap({ meterStall: { since: 0, detectedAt: 0, detail }, latch: { level: "soft", reason: "7d ≥ 92%", at: NOW, trippedBy: "auto:week", source: "file" } }), NOW)!;
    expect(locked.headline).toBe("Travado (mole)");
  });
});
