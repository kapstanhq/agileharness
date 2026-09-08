import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetBootSignalForTest,
  engineBootDurationMs,
  engineBooted,
  markEngineBooted,
  whenEngineBooted,
} from "@/lib/storymap/runner/boot-signal";

describe("sinal de boot do motor", () => {
  beforeEach(() => __resetBootSignalForTest());
  afterEach(() => __resetBootSignalForTest());

  it("começa NÃO armado — o default é o estado honesto", () => {
    expect(engineBooted()).toBe(false);
    expect(engineBootDurationMs()).toBeNull();
  });

  it("marcar arma o sinal e cronometra o boot", () => {
    markEngineBooted();
    expect(engineBooted()).toBe(true);
    expect(engineBootDurationMs()).toBeGreaterThanOrEqual(0);
  });

  it("é idempotente — a segunda marcação não move o instante", () => {
    markEngineBooted();
    const primeiro = engineBootDurationMs();
    markEngineBooted();
    expect(engineBootDurationMs()).toBe(primeiro);
  });

  it("quem espera é acordado quando o boot termina", async () => {
    const espera = whenEngineBooted(5_000);
    markEngineBooted();
    await expect(espera).resolves.toBe(true);
  });

  it("já armado ⇒ resolve na hora", async () => {
    markEngineBooted();
    await expect(whenEngineBooted(5_000)).resolves.toBe(true);
  });

  it("boot travado devolve false no timeout em vez de pendurar o observador", async () => {
    // É a diferença entre "o motor não armou" (dizível) e um observador preso junto com ele.
    await expect(whenEngineBooted(10)).resolves.toBe(false);
    expect(engineBooted()).toBe(false);
  });

  it("N observadores são todos acordados por UMA marcação", async () => {
    const todos = Promise.all([whenEngineBooted(5_000), whenEngineBooted(5_000), whenEngineBooted(5_000)]);
    markEngineBooted();
    await expect(todos).resolves.toEqual([true, true, true]);
  });
});
