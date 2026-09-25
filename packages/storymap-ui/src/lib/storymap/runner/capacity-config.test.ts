import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { applyEnvOverrides, coerceRunnerSettings, DEFAULT_RUNNER_SETTINGS } from "./config";
import { DEFAULT_GOVERNOR_SETTINGS } from "./capacity-governor";
import { settingsPath } from "@/lib/storymap/paths";

// O knob `governor:` tem LEITOR (a coerção do settings.yaml e o override de env) — e o settings.yaml publicado
// carrega o bloco com os números do dono, que a coerção aceita inteiros (nenhum campo cai no default por typo).

const saved = process.env.AGILEHARNESS_GOVERNOR;
beforeEach(() => {
  delete process.env.AGILEHARNESS_GOVERNOR;
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGILEHARNESS_GOVERNOR;
  else process.env.AGILEHARNESS_GOVERNOR = saved;
  vi.restoreAllMocks();
});

describe("settings.yaml governor: → RunnerSettings.governor", () => {
  it("ausente ⇒ materializado com os defaults (quem lê recebe um objeto completo)", () => {
    expect(coerceRunnerSettings({}).governor).toEqual({ ...DEFAULT_GOVERNOR_SETTINGS });
    expect(DEFAULT_RUNNER_SETTINGS.governor).toEqual({ ...DEFAULT_GOVERNOR_SETTINGS });
  });

  it("declarado ⇒ os valores do arquivo, campo a campo", () => {
    const g = coerceRunnerSettings({ governor: { weekCapPct: 75, fiveHourCapPct: 80, timezone: "Europe/Berlin", enabled: false } }).governor;
    expect(g).toMatchObject({ enabled: false, weekCapPct: 75, fiveHourCapPct: 80, timezone: "Europe/Berlin", latchWeekPct: 92 });
  });

  it("o settings.yaml publicado traz o bloco, e a coerção aceita TODOS os campos dele", () => {
    const raw = (yaml.load(readFileSync(settingsPath(), "utf8")) as { governor?: Record<string, unknown> }).governor;
    expect(raw, "o settings.yaml publicado não documenta o governador").toBeTruthy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const g = coerceRunnerSettings({ governor: raw }).governor!;
    expect(warn, "algum campo do bloco publicado foi DESCARTADO pela coerção").not.toHaveBeenCalled();
    for (const [k, v] of Object.entries(raw!)) expect(g[k as keyof typeof g]).toEqual(v);
  });
});

describe("AGILEHARNESS_GOVERNOR — o kill switch", () => {
  const base = () => coerceRunnerSettings({ governor: { enabled: true } });

  it("off desliga; on liga por cima de um arquivo desligado", () => {
    process.env.AGILEHARNESS_GOVERNOR = "off";
    expect(applyEnvOverrides(base()).governor?.enabled).toBe(false);
    process.env.AGILEHARNESS_GOVERNOR = "on";
    expect(applyEnvOverrides(coerceRunnerSettings({ governor: { enabled: false } })).governor?.enabled).toBe(true);
  });

  it("valor malformado é IGNORADO com aviso — não liga nem desliga nada por acidente", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AGILEHARNESS_GOVERNOR = "talvez";
    expect(applyEnvOverrides(base()).governor?.enabled).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("o override NÃO muta o objeto do arquivo (a camada de env clona)", () => {
    const b = base();
    process.env.AGILEHARNESS_GOVERNOR = "off";
    applyEnvOverrides(b);
    expect(b.governor?.enabled).toBe(true);
  });
});
