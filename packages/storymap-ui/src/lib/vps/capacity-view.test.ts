import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { capacityView, quotaBucket, unifiedQuota } from "./capacity-view";
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
    expect(v).toMatchObject({ tone: "idle", headline: "Cota livre para o trabalho automático", canClear: false, latch: null, retry: null });
    expect(v.rows.map((r) => [r.key, r.value])).toEqual([
      ["week", "42,3% · teto 80%"],
      ["session", "20% · teto 85%"],
      ["today", "2,3 de 10 pontos da semana"],
      ["projection", "71,2%"],
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
    expect(latched).toMatchObject({ tone: "danger", headline: "Travado (mole)", canClear: true });
    expect(latched.latch).toMatchObject({ by: "auto:week", since: "há 10min", halt: false });
    // o número da trava é o do ENGATE: o detalhe diz quando foi e o uso de AGORA, para o 93% não passar por uso de hoje
    expect(latched.detail).toBe("acionada há 10min: janela de 7 dias em 93% · agora: semana em 42,3%, sessão em 20%");
    const halt = capacityView(
      snap({ latch: { level: "hard", reason: "arquivo /etc/agileharness/HALT presente no host", at: NOW, trippedBy: "host:HALT", source: "halt" } }),
      NOW,
    )!;
    expect(halt).toMatchObject({ tone: "danger", headline: "Travado — HALT do host", canClear: false });
    expect(halt.detail).toBe("arquivo /etc/agileharness/HALT presente no host");
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

// UMA fonte para o número da cota: o chip da barra de topo e o painel da frota liam leituras diferentes da mesma janela
// (a do proxy e a que o governador guardou) e mostravam porcentagens diferentes lado a lado.
describe("unifiedQuota — o mesmo número no chip e no painel", () => {
  const proxy = (week: number, polledAt: number, stale = false) => ({ week: { usedPct: week }, session: { usedPct: 11 }, polledAt, stale });

  it("vale a leitura MAIS RECENTE; empate ⇒ a do proxy; a defasagem vem junto", () => {
    const s = snap(); // governador: 42.3% lido em NOW - 60s
    expect(unifiedQuota(proxy(44, NOW - 10_000), s)).toMatchObject({ weekPct: 44, source: "proxy" });
    expect(unifiedQuota(proxy(40, NOW - 600_000, true), s)).toMatchObject({ weekPct: 42.3, source: "governor", stale: false });
    expect(unifiedQuota(proxy(41, NOW - 60_000), s)).toMatchObject({ weekPct: 41, source: "proxy" });
    expect(unifiedQuota(null, s)).toMatchObject({ weekPct: 42.3, source: "governor" });
    expect(unifiedQuota(proxy(44, NOW), null)).toMatchObject({ weekPct: 44, source: "proxy" });
    expect(unifiedQuota(null, null)).toBeNull();
  });

  it("o painel desenha o MESMO número que o chip: linha da semana e o «agora» da trava", () => {
    const s = snap({ latch: { level: "soft", reason: "janela de 7 dias em 93%", at: NOW - 600_000, trippedBy: "auto:week", source: "file" } });
    const q = unifiedQuota(proxy(7, NOW - 5_000), s)!;
    const v = capacityView(s, NOW, q)!;
    expect(v.rows.find((r) => r.key === "week")).toMatchObject({ pct: 7, value: expect.stringMatching(/^7% /) });
    expect(v.detail).toContain("agora: semana em 7%, sessão em 11%");
    // sem o número unificado, o painel cai na leitura do governador (quem não tem o proxy, como a página de Métricas)
    expect(capacityView(s, NOW)!.rows.find((r) => r.key === "week")?.pct).toBe(42.3);
  });

  it("a barra de topo usa o número unificado no chip, nas barras e no painel (uma fonte, não duas)", () => {
    const pill = readFileSync(path.join(__dirname, "..", "..", "components", "HealthPill.tsx"), "utf8");
    expect(pill).toMatch(/const quota = unifiedQuota\(metrics\.usage, metrics\.governor\)/);
    expect(pill).toMatch(/<CapacityPanel snapshot=\{metrics\.governor\} quota=\{quota\}/);
    expect(pill).toMatch(/latchSealWords\(metrics\.governor, quota\?\.weekPct/);
    expect(pill).toMatch(/bucket=\{quotaBucket\(usage\.week, quota\?\.week, Date\.now\(\)\)\}/);
    // a defasagem do aviso é a da fonte vencedora, com o texto dela
    expect(pill).toMatch(/\{quota\?\.week\?\.stale && \(/);
    expect(pill).not.toMatch(/\{usage\.stale && \(/);
    // a página de Métricas: o painel unifica sozinho com a leitura viva quando quem desenha não passa o número
    expect(readFileSync(path.join(__dirname, "..", "..", "components", "CapacityPanel.tsx"), "utf8")).toMatch(/quota !== undefined \? quota : unifiedQuota\(live\?\.usage, current\)/);
  });
});

describe("unifiedQuota — por campo, «desconhecido» igual, e o reset da fonte vencedora", () => {
  it("semana e sessão escolhem a fonte SEPARADAMENTE", () => {
    const s = snap(); // governador: 42.3% / 20%, lido em NOW - 60s
    const proxy = { week: { usedPct: 50 }, session: null, polledAt: NOW - 1_000, stale: false };
    const q = unifiedQuota(proxy, s)!;
    expect(q.week).toMatchObject({ pct: 50, source: "proxy" });
    expect(q.session).toMatchObject({ pct: 20, source: "governor" }); // o proxy não tinha sessão
    expect(q).toMatchObject({ weekPct: 50, sessionPct: 20, source: "proxy" });
  });

  it("polledAt 0 e ausente são «desconhecido», iguais entre si — empate ⇒ proxy", () => {
    const base = snap();
    const g0 = snap({ reading: { ...base.reading!, polledAt: 0 } });
    expect(unifiedQuota({ week: { usedPct: 9 }, polledAt: null }, g0)!.week?.source).toBe("proxy");
    expect(unifiedQuota({ week: { usedPct: 9 }, polledAt: 0 }, g0)!.week?.source).toBe("proxy");
    // uma leitura CONHECIDA vence uma desconhecida
    expect(unifiedQuota({ week: { usedPct: 9 }, polledAt: 0 }, base)!.week?.source).toBe("governor");
  });

  it("a barra usa o reset da fonte vencedora; o do proxy só quando ele venceu ou o vencedor não diz", () => {
    const s = snap(); // resetsAt7d = NOW + 3 dias
    const q = unifiedQuota({ week: { usedPct: 9 }, polledAt: NOW - 600_000 }, s)!; // governador mais recente
    expect(quotaBucket({ usedPct: 9, resetsInMinutes: 5 }, q.week, NOW)).toEqual({ usedPct: 42.3, resetsInMinutes: 3 * 24 * 60 });
    const qp = unifiedQuota({ week: { usedPct: 9 }, polledAt: NOW }, s)!; // proxy mais recente, sem resetsAt
    expect(quotaBucket({ usedPct: 9, resetsInMinutes: 5 }, qp.week, NOW)).toEqual({ usedPct: 9, resetsInMinutes: 5 });
    expect(quotaBucket(null, null, NOW)).toBeNull();
  });

  it("«Hoje» e «No reset» dizem que são do governador quando o número da semana mostrado é o do proxy", () => {
    const s = snap();
    const label = (k: string, q: ReturnType<typeof unifiedQuota>) => capacityView(s, NOW, q)!.rows.find((r) => r.key === k)?.label;
    const doProxy = unifiedQuota({ week: { usedPct: 50 }, polledAt: NOW }, s);
    expect(label("today", doProxy)).toBe("Hoje · pela leitura anterior da cota");
    expect(label("projection", doProxy)).toBe("Na virada da semana (estimativa) · pela leitura anterior da cota");
    expect(label("today", unifiedQuota(null, s))).toBe("Hoje");
  });
});
