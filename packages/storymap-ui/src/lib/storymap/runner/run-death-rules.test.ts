import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

// O carimbo da morte de um run lê o ambiente que o ALVO declarou (settings.yaml → target.qa). O alvo abaixo é
// INVENTADO (uma oficina de bicicletas com um barramento fictício, o «fakebus»); `loadRunnerConfig` é simulado para o
// teste não tocar o disco.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("./config", () => ({ loadRunnerConfig: () => config.current }));

import { classifyRunDeath, declaredFailureRules, nextRunDeathFinding } from "./run-death";

const card = (): Card => ({ id: "story-ex9993", type: "story", title: "Troca de pneu", status: "desenvolver", findings: [] }) as unknown as Card;
const FAKEBUS_DETAIL = "fakebus broker exited with code 3";

beforeEach(() => {
  config.current = {};
});

describe("declaredFailureRules — a declaração do alvo no formato do classificador", () => {
  it("sem `target` (ou com settings ilegível) só sobra a porta desta instalação: nada de vocabulário de produto", () => {
    expect(declaredFailureRules()).toMatchObject({ ports: [], failureClasses: [] });
    config.current = { target: undefined };
    expect(declaredFailureRules().failureClasses).toEqual([]);
  });

  it("com `target.qa` traz as portas e as classes declaradas", () => {
    config.current = { target: { checks: {}, dev: {}, docs: {}, qa: { ports: [7101], failureClasses: [{ pattern: "fakebus[\\s\\S]{0,60}broker", class: "infra" }] } } };
    const r = declaredFailureRules();
    expect(r.ports).toEqual([7101]);
    expect(r.failureClasses).toHaveLength(1);
    expect(typeof r.selfPort).toBe("number");
  });

  it("nunca lança: um loadRunnerConfig que quebra devolve regras vazias", async () => {
    config.current = new Proxy({}, { get() { throw new Error("settings ilegível"); } });
    expect(declaredFailureRules()).toEqual({});
  });
});

describe("a morte `exit` com o texto do ambiente do alvo", () => {
  it("SEM declaração não inventa classe (nem app): fica não classificada", () => {
    expect(classifyRunDeath("exit", FAKEBUS_DETAIL)).toBeUndefined();
    const f = nextRunDeathFinding(card(), { reason: "exit", detail: FAKEBUS_DETAIL, today: "2026-10-03" });
    expect(f.failureClass).toBeUndefined();
  });

  it("COM a declaração do alvo o diagnóstico sai infra e o hint manda olhar o ambiente", () => {
    config.current = { target: { checks: {}, dev: {}, docs: {}, qa: { failureClasses: [{ pattern: "fakebus[\\s\\S]{0,60}broker", class: "infra" }] } } };
    const rules = declaredFailureRules();
    expect(classifyRunDeath("exit", FAKEBUS_DETAIL, null, null, rules)).toBe("infra");
    const f = nextRunDeathFinding(card(), { reason: "exit", detail: FAKEBUS_DETAIL, today: "2026-10-03", rules });
    expect(f.failureClass).toBe("infra");
    expect(f.detail).toMatch(/INFRA/);
  });

  it("uma regra declarada `test` também vale para o `exit` (a classe é a do alvo)", () => {
    const rules = { failureClasses: [{ pattern: "depot-spec", class: "test" as const }] };
    expect(classifyRunDeath("exit", "depot-spec is stale", null, null, rules)).toBe("test");
  });
});
