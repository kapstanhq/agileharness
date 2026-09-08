import { describe, expect, it } from "vitest";
import { waitForAnyCore, waitForRunCore, type AnyWatcher, type RunWaitDeps } from "./run-wait";

// story-97gpdm — a espera BLOQUEANTE nativa por conclusão de run (em vez de repolling manual de
// runner_status). O CORE é injetável (isActive / latestOutcome / subscribe / schedule) para ser
// determinístico no teste; o wrapper MCP liga engine.isInFlight + engine.onComplete + journal.latest.

function fakeDeps(over: Partial<RunWaitDeps> & { active?: boolean; last?: string | null } = {}): {
  deps: RunWaitDeps;
  fire: (outcome: string | null) => void;
  fireTimeout: () => void;
  subscribed: () => boolean;
  cancelled: () => boolean;
} {
  let onDone: ((o: string | null) => void) | null = null;
  let timeoutCb: (() => void) | null = null;
  let unsubbed = false;
  let timerCancelled = false;
  const deps: RunWaitDeps = {
    isActive: over.isActive ?? (() => over.active ?? true),
    latestOutcome: over.latestOutcome ?? (() => over.last ?? null),
    subscribe: (cb) => {
      onDone = cb;
      return () => {
        unsubbed = true;
      };
    },
    schedule: (_ms, cb) => {
      timeoutCb = cb;
      return () => {
        timerCancelled = true;
      };
    },
  };
  return {
    deps,
    fire: (o) => onDone?.(o),
    fireTimeout: () => timeoutCb?.(),
    subscribed: () => onDone !== null,
    cancelled: () => unsubbed && timerCancelled,
  };
}

describe("waitForRunCore — resolve por evento OU timeout, sem repolling", () => {
  it("sem run ativo ⇒ resolve JÁ com o último outcome durável (fast-path, waited 0)", async () => {
    const { deps } = fakeDeps({ active: false, last: "ok" });
    const r = await waitForRunCore(deps, 5000, () => 0);
    expect(r).toEqual({ state: "already-idle", outcome: "ok", waitedMs: 0 });
  });

  it("run ativo + evento de conclusão ⇒ resolve 'completed' com o outcome do evento", async () => {
    const h = fakeDeps({ active: true });
    let t = 0;
    const p = waitForRunCore(h.deps, 5000, () => t);
    expect(h.subscribed()).toBe(true); // assinou ANTES de checar (sem corrida de evento perdido)
    t = 1200;
    h.fire("exit");
    expect(await p).toEqual({ state: "completed", outcome: "exit", waitedMs: 1200 });
  });

  it("run ativo + timeout ⇒ resolve 'timeout' (o caller re-chama; não bloqueia pra sempre)", async () => {
    const h = fakeDeps({ active: true });
    let t = 0;
    const p = waitForRunCore(h.deps, 5000, () => t);
    t = 5000;
    h.fireTimeout();
    expect(await p).toEqual({ state: "timeout", waitedMs: 5000 });
  });

  it("limpa a subscription E o timer ao resolver (sem leak)", async () => {
    const h = fakeDeps({ active: true });
    const p = waitForRunCore(h.deps, 5000, () => 0);
    h.fire("ok");
    await p;
    expect(h.cancelled()).toBe(true);
  });

  it("resolve EXATAMENTE uma vez (evento depois do timeout é ignorado)", async () => {
    const h = fakeDeps({ active: true });
    const p = waitForRunCore(h.deps, 5000, () => 0);
    h.fireTimeout();
    h.fire("ok"); // tarde — deve ser no-op
    expect((await p).state).toBe("timeout");
  });
});

// M5 — a espera MULTIPLEXADA. Sem ela, um orquestrador com N sessões vivas só bloqueava numa por vez e
// descobria as outras só depois do timeout — ou seja, voltava a fazer polling.
describe("waitForAnyCore", () => {
  type Ev = { quem: string };
  const fakeWatcher = (key: string, jaPronto: Ev | null = null) => {
    let fire: ((e: Ev) => void) | null = null;
    let cancelado = false;
    const w: AnyWatcher<Ev> = {
      key,
      settledNow: () => jaPronto,
      subscribe: (onEvent) => {
        fire = onEvent;
        return () => {
          cancelado = true;
        };
      },
    };
    return { w, fire: (e: Ev) => fire?.(e), cancelado: () => cancelado };
  };
  const relogio = () => {
    let agora = 0;
    let cb: (() => void) | null = null;
    return {
      now: () => agora,
      avanca: (ms: number) => (agora += ms),
      schedule: (_ms: number, c: () => void) => {
        cb = c;
        return () => {
          cb = null;
        };
      },
      estoura: () => cb?.(),
    };
  };

  it("resolve com o PRIMEIRO que dispara e diz QUAL foi", async () => {
    const a = fakeWatcher("run:a");
    const b = fakeWatcher("session:b");
    const t = relogio();
    const p = waitForAnyCore([a.w, b.w], 1000, t.schedule, t.now);
    t.avanca(50);
    b.fire({ quem: "b" });
    await expect(p).resolves.toEqual({ state: "fired", key: "session:b", event: { quem: "b" }, waitedMs: 50 });
  });

  it("cancela TODAS as assinaturas ao resolver (um watcher esquecido vazaria um timer por chamada)", async () => {
    const a = fakeWatcher("run:a");
    const b = fakeWatcher("session:b");
    const t = relogio();
    const p = waitForAnyCore([a.w, b.w], 1000, t.schedule, t.now);
    a.fire({ quem: "a" });
    await p;
    expect(a.cancelado()).toBe(true);
    expect(b.cancelado()).toBe(true);
  });

  it("um alvo JÁ pronto resolve na hora, sem esperar", async () => {
    const t = relogio();
    const res = await waitForAnyCore([fakeWatcher("run:a").w, fakeWatcher("submit:x", { quem: "x" }).w], 1000, t.schedule, t.now);
    expect(res).toEqual({ state: "already", key: "submit:x", event: { quem: "x" }, waitedMs: 0 });
  });

  it("ASSINA todos ANTES de checar quem já estava pronto (anti missed-event race)", async () => {
    // O watcher que já estava pronto vem por ÚLTIMO: se a checagem rodasse antes das assinaturas, o
    // evento do primeiro watcher chegando no meio se perderia.
    const a = fakeWatcher("run:a");
    const t = relogio();
    const p = waitForAnyCore([a.w, fakeWatcher("submit:x", { quem: "x" }).w], 1000, t.schedule, t.now);
    await p;
    expect(a.cancelado()).toBe(true); // foi assinado — e portanto cancelado
  });

  it("timeout devolve os alvos PENDENTES (o chamador re-chama com os mesmos)", async () => {
    const t = relogio();
    const p = waitForAnyCore([fakeWatcher("run:a").w, fakeWatcher("session:b").w], 1000, t.schedule, t.now);
    t.avanca(1000);
    t.estoura();
    await expect(p).resolves.toEqual({ state: "timeout", waitedMs: 1000, pending: ["run:a", "session:b"] });
  });

  it("resolve UMA vez só — um segundo disparo não muda o resultado", async () => {
    const a = fakeWatcher("run:a");
    const b = fakeWatcher("session:b");
    const t = relogio();
    const p = waitForAnyCore([a.w, b.w], 1000, t.schedule, t.now);
    a.fire({ quem: "a" });
    b.fire({ quem: "b" });
    t.estoura();
    await expect(p).resolves.toMatchObject({ key: "run:a" });
  });

  it("lista vazia devolve timeout imediato em vez de pendurar para sempre", async () => {
    const t = relogio();
    await expect(waitForAnyCore([], 1000, t.schedule, t.now)).resolves.toEqual({ state: "timeout", waitedMs: 0, pending: [] });
  });
});
