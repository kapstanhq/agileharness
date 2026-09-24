import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeEnvOverrides,
  applyEnvOverrides,
  coerceRunnerSettings,
  DEFAULT_RUNNER_SETTINGS,
  resolveRunPolicyArgs,
} from "./config";
import { budgetFlags } from "./flags";
import {
  coerceBudgetUSD,
  coerceRunBudgetSetting,
  DEFAULT_RUN_BUDGET_USD,
  FALLBACK_RUN_BUDGET_USD,
  resolveRunBudgetUSD,
} from "./run-budget";
import { TRIGGER_IDS, type Card, type RunnerSettings, type StatusDef, type TriggerId } from "@/lib/storymap/types";

// O DISJUNTOR DE CUSTO POR RUN. Medido com o CLI 2.1.281 numa conta de assinatura: `claude -p … --max-budget-usd
// 0.001 --output-format json` termina com `subtype: "error_max_budget_usd"`, `is_error: true`, exit 1 e
// `total_cost_usd` preenchido — o teto é checado entre turnos, então o estouro é de no máximo um turno. O
// AgileHarness nunca passava a flag: um run em loop gastava até o watchdog de RELÓGIO matá-lo.

const ENV = "AGILEHARNESS_AUTORUN_MAX_BUDGET_USD";
const saved = process.env[ENV];
beforeEach(() => {
  delete process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/** O valor que segue `--max-budget-usd` num argv, ou null quando a flag não está lá. */
function budgetOf(argv: string[]): string | null {
  const i = argv.indexOf("--max-budget-usd");
  return i >= 0 ? argv[i + 1] : null;
}

const def = { id: "desenvolver", name: "Desenvolver", model: "sonnet", effort: "high", trigger: "harness-do" } as StatusDef;
const settingsWith = (maxBudgetUSD: RunnerSettings["autorun"]["maxBudgetUSD"]): RunnerSettings => ({
  ...DEFAULT_RUNNER_SETTINGS,
  autorun: { ...DEFAULT_RUNNER_SETTINGS.autorun, ...(maxBudgetUSD !== undefined ? { maxBudgetUSD } : {}) },
});

describe("a tabela default por skill — max(2×p90, p99) do custo nocional histórico", () => {
  it("cada skill medida tem o seu teto, e toda outra cai em US$ 8", () => {
    const esperado: Array<[TriggerId, number]> = [
      ["harness-do", 23.8],
      ["harness-review", 13.9],
      ["harness-plan", 11.1],
      ["harness-sync-card", 10.9],
      ["harness-fix", 7.8],
      ["harness-qa", 7.5],
      ["harness-grill", 4.7],
      ["harness-ui", 4.3],
      ["harness-enrich", 3.5],
      ["harness-ux", 3.5],
      ["harness-interview", 3.3],
      ["harness-prioritize", 2.8],
      ["harness-capture", 2.6],
    ];
    for (const [t, usd] of esperado) expect(resolveRunBudgetUSD(t, undefined), t).toBe(usd);
    expect(FALLBACK_RUN_BUDGET_USD).toBe(8);
    for (const t of TRIGGER_IDS.filter((x) => !(x in DEFAULT_RUN_BUDGET_USD))) {
      expect(resolveRunBudgetUSD(t, undefined), t).toBe(8);
    }
  });

  it("TODA skill conhecida resolve para um teto LIGADO por default (nenhuma nasce sem disjuntor)", () => {
    for (const t of TRIGGER_IDS) expect(resolveRunBudgetUSD(t, undefined), t).toBeGreaterThan(0);
  });
});

describe("resolveRunBudgetUSD — precedência número > mapa > tabela; 0 desliga", () => {
  it("um NÚMERO vale para toda skill", () => {
    expect(resolveRunBudgetUSD("harness-do", 5)).toBe(5);
    expect(resolveRunBudgetUSD("harness-enrich", 5)).toBe(5);
  });

  it("um MAPA vale para as skills que nomeia; as demais seguem a tabela", () => {
    const map = { "harness-do": 40, "harness-enrich": 1 };
    expect(resolveRunBudgetUSD("harness-do", map)).toBe(40);
    expect(resolveRunBudgetUSD("harness-enrich", map)).toBe(1);
    expect(resolveRunBudgetUSD("harness-review", map)).toBe(13.9);
  });

  it("0 desliga — global ou por skill", () => {
    expect(resolveRunBudgetUSD("harness-do", 0)).toBeNull();
    expect(resolveRunBudgetUSD("harness-do", { "harness-do": 0 })).toBeNull();
    expect(resolveRunBudgetUSD("harness-plan", { "harness-do": 0 })).toBe(11.1); // só a skill nomeada desliga
  });
});

describe("coerção ESTRITA — lixo nunca desliga o disjuntor", () => {
  it("coerceBudgetUSD: número/string numérica ≥ 0; vazio, negativo, NaN, booleano ⇒ undefined", () => {
    expect(coerceBudgetUSD(12.5)).toBe(12.5);
    expect(coerceBudgetUSD("7")).toBe(7);
    expect(coerceBudgetUSD(0)).toBe(0);
    expect(coerceBudgetUSD("0")).toBe(0);
    // O caso que motiva a régua: Number("") === 0 desligaria o teto em silêncio.
    expect(coerceBudgetUSD("")).toBeUndefined();
    expect(coerceBudgetUSD("   ")).toBeUndefined();
    expect(coerceBudgetUSD(-1)).toBeUndefined();
    expect(coerceBudgetUSD("abc")).toBeUndefined();
    expect(coerceBudgetUSD(Number.NaN)).toBeUndefined();
    expect(coerceBudgetUSD(Infinity)).toBeUndefined();
    expect(coerceBudgetUSD(true)).toBeUndefined();
    expect(coerceBudgetUSD(null)).toBeUndefined();
  });

  it("coerceRunBudgetSetting: mapa só com TriggerId conhecido + valor válido; o resto é descartado", () => {
    expect(coerceRunBudgetSetting(9)).toBe(9);
    expect(coerceRunBudgetSetting({ "harness-do": 30, "harness-dooo": 5, "harness-plan": "x", "harness-qa": -2 })).toEqual({
      "harness-do": 30,
    });
    // Nada sobrou ⇒ "não declarado", nunca `{}` fingindo configuração.
    expect(coerceRunBudgetSetting({ bogus: 1 })).toBeUndefined();
    expect(coerceRunBudgetSetting([1, 2])).toBeUndefined();
    expect(coerceRunBudgetSetting("")).toBeUndefined();
    expect(coerceRunBudgetSetting(undefined)).toBeUndefined();
  });

  it("coerceRunnerSettings carrega autorun.maxBudgetUSD (número, mapa, 0) e omite o lixo", () => {
    expect(coerceRunnerSettings({ autorun: { maxBudgetUSD: 6 } }).autorun.maxBudgetUSD).toBe(6);
    expect(coerceRunnerSettings({ autorun: { maxBudgetUSD: 0 } }).autorun.maxBudgetUSD).toBe(0);
    expect(coerceRunnerSettings({ autorun: { maxBudgetUSD: { "harness-do": 50 } } }).autorun.maxBudgetUSD).toEqual({
      "harness-do": 50,
    });
    expect("maxBudgetUSD" in coerceRunnerSettings({ autorun: { maxBudgetUSD: "lixo" } }).autorun).toBe(false);
    expect("maxBudgetUSD" in coerceRunnerSettings({ autorun: {} }).autorun).toBe(false);
  });
});

describe("AGILEHARNESS_AUTORUN_MAX_BUDGET_USD — ENV vence o arquivo", () => {
  it("um número substitui o valor do arquivo (inclusive um mapa)", () => {
    process.env[ENV] = "3.5";
    expect(applyEnvOverrides(settingsWith({ "harness-do": 50 })).autorun.maxBudgetUSD).toBe(3.5);
  });

  it("0 desliga todo teto", () => {
    process.env[ENV] = "0";
    const s = applyEnvOverrides(settingsWith(undefined));
    expect(s.autorun.maxBudgetUSD).toBe(0);
    expect(resolveRunBudgetUSD("harness-do", s.autorun.maxBudgetUSD)).toBeNull();
  });

  it("vazia/lixo é IGNORADA — o arquivo segue valendo (env malformada nunca desliga o disjuntor)", () => {
    process.env[ENV] = "";
    expect(applyEnvOverrides(settingsWith(12)).autorun.maxBudgetUSD).toBe(12);
    process.env[ENV] = "caro";
    expect(applyEnvOverrides(settingsWith(12)).autorun.maxBudgetUSD).toBe(12);
    process.env[ENV] = "-4";
    expect(applyEnvOverrides(settingsWith(undefined)).autorun.maxBudgetUSD).toBeUndefined();
  });

  it("aparece em activeEnvOverrides quando setada", () => {
    expect(activeEnvOverrides()).not.toContain(ENV);
    process.env[ENV] = "4";
    expect(activeEnvOverrides()).toContain(ENV);
  });
});

describe("budgetFlags — o texto que chega ao CLI", () => {
  it("emite `--max-budget-usd <n>` com até 4 casas e sem zeros à direita", () => {
    expect(budgetFlags(23.8)).toEqual(["--max-budget-usd", "23.8"]);
    expect(budgetFlags(2)).toEqual(["--max-budget-usd", "2"]);
    expect(budgetFlags(0.001)).toEqual(["--max-budget-usd", "0.001"]);
    expect(budgetFlags(1 / 3)).toEqual(["--max-budget-usd", "0.3333"]);
  });

  it("nada quando desligado (null/0/lixo); um positivo minúsculo NÃO vira 0", () => {
    expect(budgetFlags(null)).toEqual([]);
    expect(budgetFlags(undefined)).toEqual([]);
    expect(budgetFlags(0)).toEqual([]);
    expect(budgetFlags(-3)).toEqual([]);
    expect(budgetFlags(Number.NaN)).toEqual([]);
    expect(budgetFlags(0.00001)).toEqual(["--max-budget-usd", "0.0001"]);
  });
});

describe("resolveRunPolicyArgs — o ponto único por onde o spawn do engine passa", () => {
  const card = { id: "story-x", type: "story", storyType: "user", tasks: [], findings: [] } as unknown as Card;

  it("acrescenta o teto do TRIGGER EFETIVO depois das flags de rota (com e sem card)", () => {
    expect(resolveRunPolicyArgs(null, def, DEFAULT_RUNNER_SETTINGS, "harness-do")).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--max-budget-usd",
      "23.8",
    ]);
    expect(budgetOf(resolveRunPolicyArgs(card, def, DEFAULT_RUNNER_SETTINGS, "harness-do"))).toBe("23.8");
    // O trigger efetivo manda, não o da coluna: um card reaberto na coluna de build roda harness-fix.
    expect(budgetOf(resolveRunPolicyArgs(card, def, DEFAULT_RUNNER_SETTINGS, "harness-fix"))).toBe("7.8");
    // Skill sem linha na tabela ⇒ o fallback.
    expect(budgetOf(resolveRunPolicyArgs(null, def, DEFAULT_RUNNER_SETTINGS, "harness-refine"))).toBe("8");
  });

  it("o override do settings (número / mapa) e o 0 que desliga chegam ao argv", () => {
    expect(budgetOf(resolveRunPolicyArgs(null, def, settingsWith(5), "harness-do"))).toBe("5");
    expect(budgetOf(resolveRunPolicyArgs(null, def, settingsWith({ "harness-do": 40 }), "harness-do"))).toBe("40");
    expect(budgetOf(resolveRunPolicyArgs(null, def, settingsWith({ "harness-do": 40 }), "harness-plan"))).toBe("11.1");
    expect(budgetOf(resolveRunPolicyArgs(null, def, settingsWith(0), "harness-do"))).toBeNull();
  });

  it("um teto não é uma rota: modelo/effort/turnos são os MESMOS com e sem teto", () => {
    const comTeto = resolveRunPolicyArgs(card, def, DEFAULT_RUNNER_SETTINGS, "harness-do");
    const semTeto = resolveRunPolicyArgs(card, def, settingsWith(0), "harness-do");
    expect(comTeto.slice(0, comTeto.indexOf("--max-budget-usd"))).toEqual(semTeto);
  });
});
