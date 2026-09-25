import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapacityGovernor, meterBootRetryDelays, readingFromUsage, type CapacityServiceDeps, type StoppedRun } from "./capacity-service";
import { DAY_MS, DEFAULT_GOVERNOR_SETTINGS, HOUR_MS } from "./capacity-governor";
import type { CapacityCriticalNotice } from "./capacity-notify";
import type { GovernorSettings } from "@/lib/storymap/types";
import type { UsageWindow } from "@/lib/vps/types";

// O governador VIVO: a trava durável e quem a solta, o HALT do host, a leitura defasada, o medidor ausente, os
// avisos (SÓ os críticos, uma vez por borda), o que está retido há mais de 24h, e a trava dura que para e
// re-arma. Tudo com o relógio, o medidor e o notificador injetados — nenhuma ida à rede, estado num temp.

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function usage(over: { week?: number; session?: number | null; polledAt?: number | null; extra?: boolean; resetsAt7d?: number } = {}): UsageWindow {
  const polledAt = over.polledAt === undefined ? T0 - 60_000 : over.polledAt;
  return {
    source: "subscription",
    week: { usedPct: over.week ?? 40, resetsInMinutes: 3 * 24 * 60, resetsAt: over.resetsAt7d ?? T0 + 3 * DAY_MS },
    session: over.session === null ? null : { usedPct: over.session ?? 20, resetsInMinutes: 120, resetsAt: T0 + 2 * HOUR_MS },
    weekSonnet: null,
    extra: { enabled: over.extra ?? false, usedUsd: 0, limitUsd: 0 },
    polledAt,
    stale: false,
  };
}

let dir: string;
let haltFile: string;
// Toda instância criada no teste: o afterEach espera as gravações pendentes ANTES de apagar o temp (senão a
// gravação atrasada de um teste cai no diretório já removido e polui o log do seguinte).
const live: CapacityGovernor[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "capacity-svc-"));
  haltFile = path.join(dir, "HALT");
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((g) => g.flush()));
  rmSync(dir, { recursive: true, force: true });
});

function harness(
  opts: { usage?: UsageWindow | null; statsUrl?: string | null; settings?: Partial<GovernorSettings>; readUsage?: () => Promise<UsageWindow | null> } = {},
) {
  let now = T0;
  let current: UsageWindow | null = opts.usage === undefined ? usage() : opts.usage;
  const notices: CapacityCriticalNotice[] = [];
  const logs: string[] = [];
  // As re-tentativas de boot NUNCA disparam sozinhas no teste: ficam na fila até `fireRetry()` — nenhum
  // timer real sobrevive ao teste para reler um diretório já apagado.
  const scheduled: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const s = { ms, fn, cancelled: false };
    scheduled.push(s);
    return () => void (s.cancelled = true);
  };
  let settings: GovernorSettings = { ...DEFAULT_GOVERNOR_SETTINGS, timezone: "UTC", ...opts.settings };
  const deps: CapacityServiceDeps = {
    now: () => now,
    settings: () => settings,
    statsUrl: () => (opts.statsUrl === undefined ? "http://medidor/stats" : opts.statsUrl),
    readUsage: opts.readUsage ?? (async () => current),
    stateDir: () => path.join(dir, "autonomy"),
    haltPath: () => haltFile,
    notify: (n) => notices.push(n),
    log: (m) => logs.push(m),
    readTtlMs: 60_000,
    schedule,
  };
  const g = new CapacityGovernor(deps);
  live.push(g);
  return {
    g,
    deps,
    notices,
    logs,
    scheduled,
    /** dispara a re-tentativa pendente (a última agendada e não cancelada) e espera a leitura dela */
    fireRetry: async () => {
      const s = [...scheduled].reverse().find((x) => !x.cancelled);
      if (!s) throw new Error("nenhuma re-tentativa pendente");
      s.cancelled = true;
      s.fn();
      await g.flush();
    },
    setNow: (t: number) => (now = t),
    setUsage: (u: UsageWindow | null) => (current = u),
    setSettings: (s: Partial<GovernorSettings>) => (settings = { ...settings, ...s }),
    latchPath: path.join(dir, "autonomy", "latch.json"),
  };
}

describe("medidor ausente, pendente, defasado", () => {
  it("sem medidor (proxy desligado) ⇒ INERTE e diz isso UMA vez no log", async () => {
    const h = harness({ statsUrl: null });
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "inert" });
    await h.g.refresh();
    await h.g.refresh();
    expect(h.logs.filter((l) => l.includes("inerte"))).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  it("medidor configurado, 1ª leitura em voo ⇒ automação espera; lida ⇒ entra", async () => {
    const h = harness();
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "measuring" });
    await h.g.flush();
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "admit" });
  });

  it("proxy que responde sem janela e NUNCA teve uma ⇒ inerte DEPOIS das re-tentativas (quem adota sem medidor não trava)", async () => {
    const h = harness({ usage: null });
    await h.g.refresh();
    for (let i = 0; i < 5; i++) await h.fireRetry();
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "inert" });
  });

  it("leitura defasada ⇒ espera (fail-closed); o operador passa", async () => {
    const h = harness({ usage: usage({ polledAt: T0 - 30 * 60_000 }) });
    await h.g.refresh();
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "stale" });
    expect(h.g.admission("operator")).toMatchObject({ admit: true, reason: "operator" });
  });

  it("o medidor SOME depois de existir: a última leitura envelhece e a automação espera — inclusive após restart", async () => {
    const h = harness();
    await h.g.refresh();
    h.setUsage(null);
    h.setNow(T0 + 25 * 60_000);
    await h.g.refresh();
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "stale" });
    await h.g.flush();
    // um processo NOVO (restart) lê o estado: o medidor já existiu ⇒ não vira "inerte" por esquecimento
    const h2 = new CapacityGovernor({ ...h.deps, readUsage: async () => null });
    live.push(h2);
    await h2.refresh();
    expect(h2.admission("automation")).toMatchObject({ admit: false, reason: "stale" });
    // o medidor JÁ existiu: a falha é "defasado", não "primeira leitura" — nenhuma re-tentativa de boot
    expect(h.scheduled).toEqual([]);
  });
});

describe("a PRIMEIRA leitura que falha não declara «sem medidor» — re-tenta rápido antes", () => {
  // Medido no host vivo (v0.8.0): o proxy estava de pé e respondia em 12 ms; só a leitura do BOOT falhou. O
  // governador logou «sem medidor … governador inerte» e admitiu TUDO até o tick seguinte, 5 min depois.

  it("falha no boot ⇒ a automação ESPERA a medição e re-tenta em 15 s, 30 s…; a leitura chega ⇒ governa, e «inerte» nunca é dito", async () => {
    let calls = 0;
    const h = harness({ readUsage: async () => (++calls <= 2 ? null : usage()) });
    const { g, logs } = h;

    await g.refresh(); // 1ª: falha
    expect(g.admission("automation")).toMatchObject({ admit: false, reason: "measuring" });
    expect(h.scheduled.map((s) => s.ms)).toEqual([15_000]);
    await h.fireRetry(); // 2ª: falha
    expect(g.admission("automation")).toMatchObject({ admit: false, reason: "measuring" });
    expect(h.scheduled.map((s) => s.ms)).toEqual([15_000, 30_000]);
    await h.fireRetry(); // 3ª: lê
    expect(calls).toBe(3);
    expect(g.admission("automation")).toMatchObject({ admit: true, reason: "admit" });
    expect(h.scheduled.filter((s) => !s.cancelled)).toEqual([]); // nada mais pendente
    expect(logs.some((l) => l.includes("inerte"))).toBe(false);
    // o operador nunca esperou por isso
    expect(g.admission("operator")).toMatchObject({ admit: true, reason: "operator" });
  });

  it("esgotadas as re-tentativas (15·30·60·120·240 s — dobrando até o tick) ⇒ inerte, dito UMA vez e só no fim", async () => {
    const h = harness({ usage: null });
    await h.g.refresh();
    for (let i = 0; i < 5; i++) {
      expect(h.g.admission("automation"), `re-tentativa ${i}`).toMatchObject({ admit: false, reason: "measuring" });
      expect(h.logs.some((l) => l.includes("inerte")), `«inerte» dito antes de esgotar (${i})`).toBe(false);
      await h.fireRetry();
    }
    expect(h.scheduled.map((s) => s.ms)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "inert" });
    const inert = h.logs.filter((l) => l.includes("inerte"));
    expect(inert).toHaveLength(1);
    expect(inert[0]).toContain("AGILEHARNESS_HEADROOM_URL=off");
    // depois de esgotar, uma nova falha não reabre a fila de re-tentativas
    await h.g.refresh();
    expect(h.scheduled).toHaveLength(5);
    expect(h.logs.filter((l) => l.includes("inerte"))).toHaveLength(1);
  });

  it("proxy desligado por env ⇒ inerte JÁ, sem re-tentativa (a ausência é declarada, não medida)", async () => {
    const h = harness({ statsUrl: null });
    await h.g.refresh();
    expect(h.scheduled).toEqual([]);
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "inert" });
    expect(h.logs.filter((l) => l.includes("inerte"))).toHaveLength(1);
  });

  it("uma leitura pedida pela admissão durante a espera não agenda uma SEGUNDA re-tentativa", async () => {
    const h = harness({ usage: null });
    await h.g.refresh();
    h.setNow(T0 + 61_000); // passou o TTL de leitura: a admissão cutuca uma leitura nova
    h.g.admission("automation");
    await h.g.flush();
    expect(h.scheduled.filter((s) => !s.cancelled)).toHaveLength(1);
  });

  it("meterBootRetryDelays: dobra a partir da base enquanto for MENOR que o tick", () => {
    expect(meterBootRetryDelays()).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(meterBootRetryDelays(15_000, 60_000)).toEqual([15_000, 30_000]);
    expect(meterBootRetryDelays(0, 60_000)).toEqual([]);
  });
});

describe("a trava automática", () => {
  it("7d ≥ 92 ⇒ latch.json DURÁVEL (soft, auto:week), um aviso crítico, e o operador segue passando", async () => {
    const h = harness({ usage: usage({ week: 93 }) });
    await h.g.refresh();
    await h.g.flush();
    const latch = JSON.parse(readFileSync(h.latchPath, "utf8"));
    expect(latch).toMatchObject({ level: "soft", trippedBy: "auto:week" });
    expect(h.notices.map((n) => n.kind)).toEqual(["latch"]);
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "latch" });
    expect(h.g.admission("operator").admit).toBe(true);
    await h.g.refresh(); // a mesma condição, lida de novo: nenhum aviso novo (borda, não nível)
    expect(h.notices).toHaveLength(1);
  });

  it("a trava SOBREVIVE à condição: a semana reseta, o uso cai, e só o operador solta", async () => {
    const h = harness({ usage: usage({ week: 95 }) });
    await h.g.refresh();
    h.setNow(T0 + 4 * DAY_MS);
    h.setUsage(usage({ week: 2, polledAt: T0 + 4 * DAY_MS - 60_000, resetsAt7d: T0 + 10 * DAY_MS }));
    await h.g.refresh();
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "latch" });
  });

  it("uso extra ligado ⇒ trava com UM aviso (o de uso extra), não dois", async () => {
    const h = harness({ usage: usage({ extra: true, week: 10 }) });
    await h.g.refresh();
    expect(h.notices.map((n) => n.kind)).toEqual(["extra-usage"]);
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "latch" });
  });

  it("espera por ritmo, 5h no teto e defasagem NÃO notificam — só o crítico vai ao celular", async () => {
    const h = harness({ usage: usage({ week: 85 }) }); // teto semanal (hold)
    await h.g.refresh();
    h.setUsage(usage({ session: 87 })); // teto de 5h
    h.setNow(T0 + 2 * 60_000);
    await h.g.refresh();
    h.setUsage(usage({ polledAt: T0 - 3 * HOUR_MS })); // defasada
    h.setNow(T0 + 4 * 60_000);
    await h.g.refresh();
    expect(h.notices).toEqual([]);
  });
});

describe("soltar a trava", () => {
  it("token MCP / o próprio serviço NÃO soltam; o operador com sessão e motivo solta — e a automação volta, acordando quem espera", async () => {
    const h = harness({ usage: usage({ week: 93 }) });
    await h.g.refresh();
    // a semana virou: janela nova, 5% — e a trava continua segurando
    const t1 = T0 + 4 * DAY_MS;
    h.setNow(t1);
    h.setUsage(usage({ week: 5, polledAt: t1 - 60_000, resetsAt7d: t1 + 6 * DAY_MS }));
    await h.g.refresh();
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "latch" });
    let woke = 0;
    h.g.onChange(() => woke++);

    expect(await h.g.clearLatch({ caller: "mcp-token", reason: "quero rodar" })).toMatchObject({ ok: false });
    expect(await h.g.clearLatch({ caller: "in-process", reason: "quero rodar" })).toMatchObject({ ok: false });
    expect(existsSync(h.latchPath)).toBe(true);

    const r = await h.g.clearLatch({ caller: "operator-session", reason: "semana sob controle" });
    expect(r).toMatchObject({ ok: true, cleared: { trippedBy: "auto:week" } });
    expect(existsSync(h.latchPath)).toBe(false);
    expect(h.g.admission("automation")).toMatchObject({ admit: true });
    expect(woke).toBe(1);
    const audit = readFileSync(path.join(dir, "autonomy", "latch-audit.jsonl"), "utf8");
    expect(audit).toContain('"action":"clear"');
  });

  it("soltar com a condição AINDA viva: não re-engata na mesma borda, mas a condição segue segurando a automação; uma borda NOVA trava de novo", async () => {
    const h = harness({ usage: usage({ week: 93 }) });
    await h.g.refresh();
    await h.g.clearLatch({ caller: "operator-session", reason: "vou acompanhar" });
    h.setNow(T0 + 2 * 60_000);
    await h.g.refresh();
    expect(existsSync(h.latchPath)).toBe(false); // reconhecida: sem re-engate
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "auto-latch" });
    // a condição passa (leitura FRESCA abaixo) e volta: nova borda ⇒ trava de novo
    h.setUsage(usage({ week: 60, polledAt: T0 + 3 * 60_000 }));
    h.setNow(T0 + 4 * 60_000);
    await h.g.refresh();
    h.setUsage(usage({ week: 94, polledAt: T0 + 5 * 60_000 }));
    h.setNow(T0 + 6 * 60_000);
    await h.g.refresh();
    expect(existsSync(h.latchPath)).toBe(true);
  });

  it("engatar nunca REBAIXA uma trava dura", async () => {
    const h = harness();
    await h.g.refresh();
    await h.g.engageLatch({ level: "hard", reason: "parar tudo agora", by: "operator" });
    const r = await h.g.engageLatch({ level: "soft", reason: "agente pediu", by: "mcp:orch" });
    expect(r.level).toBe("hard");
  });
});

describe("o HALT do host", () => {
  it("existir o arquivo = trava DURA: a automação espera, o operador passa, o painel NÃO solta, e desligar o governador não a ignora", async () => {
    const h = harness();
    await h.g.refresh();
    writeFileSync(haltFile, "");
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "latch", detail: expect.stringContaining("hard") });
    expect(h.g.admission("operator").admit).toBe(true);
    expect(await h.g.clearLatch({ caller: "operator-session", reason: "liberar" })).toMatchObject({ ok: false, why: expect.stringContaining(haltFile) });
    h.setSettings({ enabled: false });
    expect(h.g.admission("automation")).toMatchObject({ admit: false, reason: "latch" });
    rmSync(haltFile);
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "inert" });
  });

  it("desligado, o latch.json do governador deixa de valer (o kill switch é a alavanca)", async () => {
    const h = harness({ usage: usage({ week: 93 }) });
    await h.g.refresh();
    h.setSettings({ enabled: false });
    expect(h.g.admission("automation")).toMatchObject({ admit: true, reason: "inert" });
  });

  it("latch.json ilegível é trava DURA (fail-closed)", async () => {
    const h = harness();
    await h.g.refresh();
    mkdirSync(path.dirname(h.latchPath), { recursive: true });
    writeFileSync(h.latchPath, "{isto não é json");
    await h.g.refresh();
    expect(h.g.snapshot().latch).toMatchObject({ level: "hard" });
    expect(h.g.admission("automation").admit).toBe(false);
  });
});

describe("trava DURA para e re-arma", () => {
  it("engatar dura chama o parador; soltar re-arma exatamente os parados", async () => {
    const h = harness();
    await h.g.refresh();
    const stopped: StoppedRun[] = [{ board: "acme", cardId: "c1", trigger: "harness-do" }];
    const stopCalls: string[] = [];
    const rearmed: StoppedRun[][] = [];
    h.g.setHardStop(async (reason) => {
      stopCalls.push(reason);
      return stopped;
    });
    h.g.setRearm(async (items) => {
      rearmed.push(items);
    });
    await h.g.engageLatch({ level: "hard", reason: "semana estourando", by: "operator" });
    expect(stopCalls).toEqual(["semana estourando"]);
    await h.g.refresh(); // ainda dura: não para de novo, não re-arma
    expect(stopCalls).toHaveLength(1);
    expect(rearmed).toEqual([]);
    await h.g.clearLatch({ caller: "operator-session", reason: "ok, pode voltar" });
    expect(rearmed).toEqual([stopped]);
  });

  it("os parados sobrevivem a um restart e são re-armados quando a trava some", async () => {
    const h = harness();
    await h.g.refresh();
    h.g.setHardStop(async () => [{ board: "acme", cardId: "c2", trigger: "harness-qa" }]);
    await h.g.engageLatch({ level: "hard", reason: "parar", by: "operator" });
    await h.g.flush();
    const h2 = new CapacityGovernor(h.deps);
    live.push(h2);
    const rearmed: StoppedRun[][] = [];
    h2.setRearm(async (items) => {
      rearmed.push(items);
    });
    await h2.clearLatch({ caller: "operator-session", reason: "voltar" });
    expect(rearmed).toEqual([[{ board: "acme", cardId: "c2", trigger: "harness-qa" }]]);
  });
});

describe("retido há mais de 24h", () => {
  it("avisa UMA vez por item; o item que deixou de estar retido some do registro", async () => {
    const h = harness({ usage: usage({ week: 85 }) });
    await h.g.refresh();
    h.g.reportHeld("engine", ["acme/c1", "acme/c2"]);
    h.g.reportHeld("tick:acme", ["acme"]);
    h.setNow(T0 + DAY_MS - 1);
    h.setUsage(usage({ week: 85, polledAt: T0 + DAY_MS - 60_000, resetsAt7d: T0 + 3 * DAY_MS }));
    await h.g.refresh();
    expect(h.notices).toEqual([]);
    h.g.reportHeld("engine", ["acme/c1"]); // c2 saiu da fila
    h.setNow(T0 + DAY_MS + 1);
    await h.g.refresh();
    expect(h.notices.map((n) => n.kind)).toEqual(["held-24h"]);
    expect(h.notices[0].title).toContain("2 trabalho(s)");
    expect(h.notices[0].body).toContain("acme/c1");
    expect(h.notices[0].body).not.toContain("acme/c2");
    await h.g.refresh();
    expect(h.notices).toHaveLength(1);
    expect(h.g.snapshot().held).toEqual({ count: 2, oldestSince: T0 });
  });
});

describe("o retrato", () => {
  it("janela, ritmo de hoje, projeção, retidos e trava — o que o painel mostra", async () => {
    const h = harness({ usage: usage({ week: 40 }) });
    await h.g.refresh();
    const s = h.g.snapshot();
    expect(s.reading).toMatchObject({ usage7dPct: 40, usage5hPct: 20, stale: false });
    expect(s.pacing).toMatchObject({ baselinePct: 40, usedTodayPct: 0, ceilingPct: 80 });
    expect(s.projectionAtResetPct).toBeGreaterThan(40);
    expect(s.verdict).toMatchObject({ kind: "admit" });
    expect(s.latch).toBeNull();
    expect(s.inert).toBeNull();
  });
});

describe("readingFromUsage", () => {
  it("prefere o reset absoluto; sem `polled_at` a leitura nasce defasada; sem 7d não há leitura", () => {
    const u = usage();
    expect(readingFromUsage(u, T0)).toMatchObject({ usage7dPct: 40, resetsAt7d: T0 + 3 * DAY_MS, polledAt: T0 - 60_000 });
    const semAbsoluto = { ...u, week: { usedPct: 40, resetsInMinutes: 60 } };
    expect(readingFromUsage(semAbsoluto, T0)?.resetsAt7d).toBe(T0 + 60 * 60_000);
    expect(readingFromUsage({ ...u, polledAt: null }, T0)?.polledAt).toBe(0);
    expect(readingFromUsage({ ...u, week: null }, T0)).toBeNull();
    expect(readingFromUsage(null, T0)).toBeNull();
  });
});
