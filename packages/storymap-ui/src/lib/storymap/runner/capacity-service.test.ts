import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapacityGovernor, readingFromUsage, type CapacityServiceDeps, type StoppedRun } from "./capacity-service";
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

function harness(opts: { usage?: UsageWindow | null; statsUrl?: string | null; settings?: Partial<GovernorSettings> } = {}) {
  let now = T0;
  let current: UsageWindow | null = opts.usage === undefined ? usage() : opts.usage;
  const notices: CapacityCriticalNotice[] = [];
  const logs: string[] = [];
  let settings: GovernorSettings = { ...DEFAULT_GOVERNOR_SETTINGS, timezone: "UTC", ...opts.settings };
  const deps: CapacityServiceDeps = {
    now: () => now,
    settings: () => settings,
    statsUrl: () => (opts.statsUrl === undefined ? "http://medidor/stats" : opts.statsUrl),
    readUsage: async () => current,
    stateDir: () => path.join(dir, "autonomy"),
    haltPath: () => haltFile,
    notify: (n) => notices.push(n),
    log: (m) => logs.push(m),
    readTtlMs: 60_000,
  };
  const g = new CapacityGovernor(deps);
  live.push(g);
  return {
    g,
    deps,
    notices,
    logs,
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

  it("proxy que responde sem janela e NUNCA teve uma ⇒ inerte (quem adota sem medidor não trava)", async () => {
    const h = harness({ usage: null });
    await h.g.refresh();
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
