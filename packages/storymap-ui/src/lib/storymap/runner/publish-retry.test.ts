import { describe, expect, it, vi } from "vitest";
import { PUBLISH_BACKOFF, PublishBreaker, type PublishAttempt, type PublishBreakerStore } from "./publish-breaker";
import { retryDuePublishes, type PublishRetryDeps } from "./publish-retry";

// O RELÓGIO do disjuntor: a cascata é movida a evento, então sem esta varredura o recuo venceria e ninguém avisaria.

const T0 = Date.UTC(2026, 8, 29, 2, 0, 0);
const HOUR = 3_600_000;

class MemStore implements PublishBreakerStore {
  rows: PublishAttempt[] = [];
  async load() {
    return structuredClone(this.rows);
  }
  async persist(rows: PublishAttempt[]) {
    this.rows = structuredClone(rows);
  }
}

function setup(cards: Record<string, string | null>) {
  let now = T0;
  const breaker = new PublishBreaker(new MemStore(), () => now);
  const reevaluate = vi.fn(async (_b: string, _c: string) => {});
  const deps: PublishRetryDeps = {
    breaker,
    readConfig: async () => ({
      statuses: [
        { id: "release", name: "Liberar" },
        { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
        { id: "desenvolver", name: "Dev" },
        { id: "concluida", name: "No ar", terminal: true },
      ],
    }),
    readCard: async (_b, id) => (cards[id] === undefined || cards[id] === null ? null : { status: cards[id]! }),
    reevaluate,
    now: () => now,
  };
  return { breaker, deps, reevaluate, advance: (ms: number) => (now += ms) };
}

describe("retryDuePublishes — a linha da CAUSA re-encaminha todos os cards dela numa tentativa", () => {
  it("vencida, reavalia TODOS os cards em «Liberar» da causa, uma vez; o que já saiu do caminho é esquecido", async () => {
    const t = setup({ a: "release", b: "release", c: "concluida" });
    const NH = { phase: "needs-human", exitCode: 3, causeKey: "armazem:owner:money" };
    for (const id of ["a", "b", "c"]) await t.breaker.recordFailure("armazem", id, NH);
    t.advance(6 * HOUR);
    const r = await retryDuePublishes(t.deps);
    expect(r.dropped).toEqual(["armazem/c"]);
    expect(r.redriven).toEqual(["armazem/a", "armazem/b"]);
    t.advance(60_000);
    expect((await retryDuePublishes(t.deps)).redriven).toEqual([]); // o fôlego vale para a linha inteira
  });

  it("um card da causa já no passo de publicar = tentativa em voo: a linha não é reavaliada", async () => {
    const t = setup({ a: "deploy", b: "release" });
    const NS = { phase: "needs-units", exitCode: 3, causeKey: "armazem:system" };
    await t.breaker.recordFailure("armazem", "a", NS);
    await t.breaker.recordFailure("armazem", "b", NS);
    t.advance(6 * HOUR);
    expect((await retryDuePublishes(t.deps)).redriven).toEqual([]);
  });
});

describe("retryDuePublishes", () => {
  it("recuo VENCIDO + card ainda em «Liberar» ⇒ reavalia a cascata UMA vez e dá fôlego (não vence de novo no minuto seguinte)", async () => {
    const t = setup({ a: "release" });
    await t.breaker.recordFailure("armazem", "a", { phase: "needs-human", exitCode: 3 });
    t.advance(6 * HOUR);
    expect((await retryDuePublishes(t.deps)).redriven).toEqual(["armazem/a"]);
    expect(t.reevaluate).toHaveBeenCalledWith("armazem", "a");
    // o minuto seguinte: a avaliação pode não ter encaminhado (um gate) — não pode disparar de novo já
    t.advance(60_000);
    expect((await retryDuePublishes(t.deps)).redriven).toEqual([]);
    expect(t.reevaluate).toHaveBeenCalledTimes(1);
    // passado o fôlego, vence outra vez
    t.advance(PUBLISH_BACKOFF.retryLeaseMs);
    expect((await retryDuePublishes(t.deps)).redriven).toEqual(["armazem/a"]);
  });

  it("ainda DENTRO do recuo ⇒ não toca em nada", async () => {
    const t = setup({ a: "release" });
    await t.breaker.recordFailure("armazem", "a", { phase: "needs-human", exitCode: 3 });
    t.advance(HOUR);
    expect(await retryDuePublishes(t.deps)).toEqual({ redriven: [], dropped: [] });
    expect(t.reevaluate).not.toHaveBeenCalled();
  });

  it("ESGOTADO não é reavaliado (espera o botão), por mais tempo que passe", async () => {
    const t = setup({ a: "release" });
    for (let i = 0; i < PUBLISH_BACKOFF.deterministic.maxConsecutive; i++) await t.breaker.recordFailure("armazem", "a", { phase: "needs-human", exitCode: 3 });
    t.advance(30 * 24 * HOUR);
    expect((await retryDuePublishes(t.deps)).redriven).toEqual([]);
    expect(t.reevaluate).not.toHaveBeenCalled();
    expect(await t.breaker.snapshot()).toHaveLength(1); // e continua registrado: o card ainda espera em Liberar
  });

  it("card no passo de PUBLICAR = tentativa em voo: nem reavalia nem esquece", async () => {
    const t = setup({ a: "deploy" });
    await t.breaker.recordFailure("armazem", "a", { phase: "deploy", exitCode: 1 });
    t.advance(HOUR);
    expect(await retryDuePublishes(t.deps)).toEqual({ redriven: [], dropped: [] });
    expect(t.reevaluate).not.toHaveBeenCalled();
    expect(await t.breaker.snapshot()).toHaveLength(1);
  });

  it("quem saiu do caminho é ESQUECIDO: card apagado, concluído ou movido para outra coluna", async () => {
    const t = setup({ gone: null, done: "concluida", moved: "desenvolver", waiting: "release" });
    for (const id of ["gone", "done", "moved", "waiting"]) await t.breaker.recordFailure("armazem", id, { phase: "needs-human", exitCode: 3 });
    const r = await retryDuePublishes(t.deps);
    expect(r.dropped.sort()).toEqual(["armazem/done", "armazem/gone", "armazem/moved"]);
    expect((await t.breaker.snapshot()).map((x) => x.cardId)).toEqual(["waiting"]);
  });

  it("uma reavaliação que LANÇA não derruba a varredura nem os outros cards", async () => {
    const t = setup({ a: "release", b: "release" });
    await t.breaker.recordFailure("armazem", "a", { phase: "deploy" });
    await t.breaker.recordFailure("armazem", "b", { phase: "deploy" });
    t.advance(HOUR);
    t.reevaluate.mockRejectedValueOnce(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await retryDuePublishes(t.deps);
      expect(r.redriven).toHaveLength(1); // só o que reavaliou de fato
      expect(t.reevaluate).toHaveBeenCalledTimes(2);
    } finally {
      err.mockRestore();
    }
  });

  it("config ilegível ⇒ fail-safe: não esquece ninguém (esquecer é perder a trava)", async () => {
    const t = setup({ a: "release" });
    await t.breaker.recordFailure("armazem", "a", { phase: "needs-human", exitCode: 3 });
    t.deps.readConfig = async () => {
      throw new Error("yaml quebrado");
    };
    t.advance(HOUR);
    const r = await retryDuePublishes(t.deps);
    // sem config não dá para saber quais passos publicam: o conservador é NÃO apagar o registro por um erro de leitura
    expect(r.dropped).toEqual([]);
    expect(await t.breaker.snapshot()).toHaveLength(1);
  });
});
