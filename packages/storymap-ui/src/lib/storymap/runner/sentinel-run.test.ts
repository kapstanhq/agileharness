import { describe, expect, it, vi } from "vitest";
import { reconcileOrphanWakes, runSentinelBoard, type SentinelRunDeps } from "./sentinel-run";
import type { SentinelCause, SentinelLogEntry } from "./sentinel";
import type { SentinelRunResult } from "./sentinel-spawn";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const cause = (key: string, over: Partial<SentinelCause> = {}): SentinelCause => ({
  kind: "stalled-run",
  key,
  board: "livraria",
  cardIds: ["story-ex9001"],
  summary: `Execução parada: ${key}`,
  ...over,
});

function makeDeps(over: Partial<SentinelRunDeps> & { causes?: SentinelCause[][]; box?: boolean; result?: SentinelRunResult | null } = {}) {
  const log: SentinelLogEntry[] = [];
  const queue = [...(over.causes ?? [])];
  let last: SentinelCause[] = queue[0] ?? [];
  const spawn = vi.fn(async (): Promise<SentinelRunResult | null> =>
    over.result === undefined ? { sessionId: "s-1", costUSD: 0.4, finalText: "Diagnóstico: o worktree perdeu o lockfile.", commands: [], exitCode: 0 } : over.result,
  );
  const deps: SentinelRunDeps = {
    collect: vi.fn(async () => {
      if (queue.length) last = queue.shift()!;
      return last;
    }),
    deterministicPass: vi.fn(async () => {}),
    sentinelBox: vi.fn(async () => over.box ?? false),
    capacityHeld: () => false,
    readLog: async () => [...log],
    append: vi.fn(async (e) => {
      log.push({ v: 1, at: new Date(NOW).toISOString(), ...e } as SentinelLogEntry);
    }),
    spawn,
    now: () => NOW,
    ...over,
  };
  return { deps, log, spawn };
}

describe("runSentinelBoard — o laço", () => {
  it("UM disparo por causa: a segunda varredura com a mesma causa não abre sessão", async () => {
    const c = cause("stalled-run:livraria:sandbox", { cardIds: ["story-ex9001", "story-ex9002"] });
    const { deps, spawn } = makeDeps({ causes: [[c], [c]] });
    const r1 = await runSentinelBoard("livraria", deps);
    await Promise.all(r1.map((r) => r.done));
    expect(spawn).toHaveBeenCalledTimes(1);
    const r2 = await runSentinelBoard("livraria", deps);
    expect(r2).toEqual([{ causeKey: c.key, action: "skipped" }]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(deps.deterministicPass).toHaveBeenCalledTimes(1); // sem causa nova, nem o passe $0 roda
  });

  it("o determinístico primeiro: a causa que some na releitura é registrada como resolvida, sem sessão", async () => {
    const c = cause("merge-failed:livraria:x", { kind: "merge-failed" });
    const { deps, log, spawn } = makeDeps({ causes: [[c], []] });
    const r = await runSentinelBoard("livraria", deps);
    expect(r).toEqual([{ causeKey: c.key, action: "deterministic-fix" }]);
    expect(spawn).not.toHaveBeenCalled();
    expect(log[0]).toMatchObject({ did: "deterministic-fix", outcome: "resolved", costUSD: 0 });
  });

  it("Mínima NUNCA executa: a sessão nasce em modo diagnóstico, e o diagnóstico vira item aberto", async () => {
    const c = cause("stalled-run:livraria:y");
    const { deps, log, spawn } = makeDeps({ causes: [[c], [c], [c]], box: false });
    const [rep] = await runSentinelBoard("livraria", deps);
    await rep.done;
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ key: c.key }), "diagnose", expect.any(Number), expect.anything());
    // o registro: antes de nascer (aberto) e o desfecho com o diagnóstico e o custo
    expect(log.map((e) => [e.did, e.outcome])).toEqual([
      ["diagnosed", "open"],
      ["diagnosed", "open"],
    ]);
    expect(log[1]).toMatchObject({ costUSD: 0.4, diagnosis: expect.stringContaining("lockfile"), sessionId: "s-1" });
    expect(log.some((e) => e.commands?.length)).toBe(false);
  });

  it("Máxima conserta; o desfecho vem do MUNDO (a causa sumiu da releitura) e cada comando fica registrado", async () => {
    const c = cause("stalled-run:livraria:z");
    const { deps, log } = makeDeps({
      causes: [[c], [c], []],
      box: true,
      repairReady: async () => ({ ok: true }),
      result: { sessionId: "s-2", costUSD: 1.1, finalText: "Limpei o worktree.", commands: ["git -C /tmp/wt status", "rm -rf /tmp/wt/node_modules/.cache"], exitCode: 0 },
    });
    const [rep] = await runSentinelBoard("livraria", deps);
    expect(rep).toMatchObject({ action: "spawned", mode: "repair" });
    await rep.done;
    expect(log.at(-1)).toMatchObject({ did: "repaired", outcome: "resolved", costUSD: 1.1, commands: ["git -C /tmp/wt status", "rm -rf /tmp/wt/node_modules/.cache"] });
  });

  it("teto do dia estourado: só o diagnóstico do sinal, sem sessão", async () => {
    const c = cause("deploy-failed:livraria:w", { kind: "deploy-failed", detail: "o build quebrou no passo de imagem" });
    const { deps, log, spawn } = makeDeps({ causes: [[c], [c]], box: true, repairReady: async () => ({ ok: true }) });
    log.push({ v: 1, at: new Date(NOW - 60_000).toISOString(), board: "livraria", causeKey: "outra", kind: "stalled-run", reason: "x", cardIds: [], mode: "repair", did: "repaired", costUSD: 10, outcome: "open" });
    const r = await runSentinelBoard("livraria", deps);
    expect(r).toEqual([{ causeKey: c.key, action: "diagnosis-only", mode: "repair" }]);
    expect(spawn).not.toHaveBeenCalled();
    expect(log.at(-1)).toMatchObject({ did: "diagnosis-only", why: "ceiling", costUSD: 0, diagnosis: expect.stringContaining("o build quebrou") });
  });

  it("cota segurando: só diagnóstico, sem sessão", async () => {
    const c = cause("stalled-run:livraria:q");
    const { deps, spawn } = makeDeps({ causes: [[c], [c]], capacityHeld: () => true });
    const r = await runSentinelBoard("livraria", deps);
    expect(r[0]).toMatchObject({ action: "diagnosis-only" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("no máximo UMA sessão por board por varredura — as outras causas esperam a próxima (sem registro)", async () => {
    const a = cause("stalled-run:livraria:a");
    const b = cause("merge-failed:livraria:b", { kind: "merge-failed" });
    const { deps, spawn, log } = makeDeps({ causes: [[a, b], [a, b], [a, b]] });
    const r = await runSentinelBoard("livraria", deps);
    expect(r.map((x) => x.action)).toEqual(["spawned", "deferred"]);
    await r[0].done;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log.some((e) => e.causeKey === b.key)).toBe(false);
  });

  it("a sessão que não nasce é registrada como falha e não queima a causa", async () => {
    const c = cause("stalled-run:livraria:n");
    const { deps, log } = makeDeps({ causes: [[c], [c]], result: null });
    const [rep] = await runSentinelBoard("livraria", deps);
    await rep.done;
    expect(log.at(-1)).toMatchObject({ did: "spawn-failed", outcome: "failed" });
  });

  it("causa do host não roda o passe determinístico de board", async () => {
    const h = cause("health-red:*:S6", { kind: "health-red", board: "*", cardIds: [] });
    const { deps } = makeDeps({ causes: [[h], [h]] });
    const r = await runSentinelBoard("*", deps);
    await Promise.all(r.map((x) => x.done));
    expect(deps.deterministicPass).not.toHaveBeenCalled();
  });

  it("board PAREADO, com o dono no comando ou com o copiloto desligado: o passe determinístico NÃO roda (nenhum card se move)", async () => {
    const c = cause("stalled-run:livraria:p");
    const { deps, spawn } = makeDeps({ causes: [[c], [c], [c]], deterministicAllowed: async () => false });
    const [rep] = await runSentinelBoard("livraria", deps);
    await rep.done;
    expect(deps.deterministicPass).not.toHaveBeenCalled();
    // ela segue diagnosticando (sessão de leitura) — só não move nada
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ key: c.key }), "diagnose", expect.any(Number), expect.anything());
  });

  it("Máxima pedida sem a casa em ordem: nasce em diagnóstico e o registro diz por quê", async () => {
    const c = cause("stalled-run:livraria:r");
    const { deps, log, spawn } = makeDeps({ causes: [[c], [c], [c]], box: true, repairReady: async () => ({ ok: false, why: "a trava dura do host não está instalada" }) });
    const [rep] = await runSentinelBoard("livraria", deps);
    await rep.done;
    expect(spawn).toHaveBeenCalledWith(expect.anything(), "diagnose", expect.any(Number), expect.anything());
    expect(log[0]).toMatchObject({ mode: "diagnose", diagnosis: expect.stringContaining("trava dura") });
  });

  it("a abertura RESERVA o teto do despertar e cada comando entra no registro ENQUANTO a sessão roda", async () => {
    const c = cause("stalled-run:livraria:s");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, log } = makeDeps({
      causes: [[c], [c], [c]],
      box: true,
      repairReady: async () => ({ ok: true }),
      newWakeId: () => "w-ex1",
      spawn: vi.fn(async (_c, mode, _b, hooks) => {
        hooks?.onStart?.(777, mode);
        hooks?.onCommands?.(["git status"]);
        await gate;
        return { sessionId: "s-3", costUSD: 0.5, finalText: "ok", commands: ["git status"], exitCode: 0, mode };
      }),
    });
    const [rep] = await runSentinelBoard("livraria", deps);
    await new Promise((r) => setTimeout(r, 5));
    // antes do desfecho: a abertura com a reserva, o pid e o comando já estão no registro
    expect(log[0]).toMatchObject({ why: "em andamento", wakeId: "w-ex1", reservedUSD: 2 });
    expect(log.some((e) => e.pid === 777 && e.wakeId === "w-ex1")).toBe(true);
    expect(log.some((e) => e.commands?.includes("git status") && e.why === "em andamento")).toBe(true);
    release();
    await rep.done;
    expect(log.at(-1)).toMatchObject({ wakeId: "w-ex1", costUSD: 0.5 });
  });

  it("o interruptor geral desligado: nenhuma sessão nasce", async () => {
    const c = cause("stalled-run:livraria:o");
    const { deps, spawn, log } = makeDeps({ causes: [[c], [c]], autorunEnabled: () => false });
    const r = await runSentinelBoard("livraria", deps);
    expect(r[0]).toMatchObject({ action: "diagnosis-only" });
    expect(spawn).not.toHaveBeenCalled();
    expect(log.at(-1)).toMatchObject({ why: "autorun-off" });
  });
});

describe("reconcileOrphanWakes — o despertar que o restart deixou pendurado", () => {
  it("mata o processo (pela dep), fecha com falha cobrando a reserva, e não fecha duas vezes", async () => {
    const log: SentinelLogEntry[] = [
      { v: 1, at: new Date(NOW - 60 * 60_000).toISOString(), board: "livraria", causeKey: "k", kind: "stalled-run", reason: "x", cardIds: [], mode: "repair", did: "repaired", costUSD: 0, outcome: "open", why: "em andamento", wakeId: "w-o", reservedUSD: 2, pid: 999 },
    ];
    const reaped: Array<number | undefined> = [];
    const deps = {
      readLog: async () => [...log],
      append: async (e: Omit<SentinelLogEntry, "v" | "at"> & { at?: string }) => void log.push({ v: 1, at: new Date(NOW).toISOString(), ...e } as SentinelLogEntry),
      reapOrphan: async (e: SentinelLogEntry) => void reaped.push(e.pid),
      now: () => NOW,
    };
    expect(await reconcileOrphanWakes(deps)).toBe(1);
    expect(reaped).toEqual([999]);
    expect(log.at(-1)).toMatchObject({ wakeId: "w-o", outcome: "failed", costUSD: 2 });
    expect(await reconcileOrphanWakes(deps)).toBe(0);
  });
});
