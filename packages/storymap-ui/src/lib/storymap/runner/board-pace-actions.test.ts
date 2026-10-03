import { describe, expect, it } from "vitest";
import { changeBoardPace, sweepBoardPace, type BoardPaceDeps } from "./board-pace-actions";
import { effectivePaceLevel, type BoardPaceRow, type PaceActor, type PaceHeldEntry } from "./board-pace";

const OWNER: PaceActor = { kind: "owner" };
const AGENT: PaceActor = { kind: "agent", id: "TOKEN_ORCH" };
const T0 = Date.parse("2026-03-10T12:00:00.000Z");

/** Um mundo em memória: o arquivo de ritmo, o engine e a fila do condutor como dublês que registram o que foi pedido. */
function world(opts: { rows?: BoardPaceRow[]; unreadable?: boolean; queued?: string[]; running?: string[]; conductors?: string[]; disarmed?: boolean; missing?: boolean; rearmFails?: string[] } = {}) {
  const state = { rows: opts.rows ?? [], unreadable: opts.unreadable ?? false, now: T0 };
  const calls = { stop: [] as Array<{ board: string; reason: string; running: boolean }>, park: [] as string[], rearm: [] as Array<{ board: string; entry: PaceHeldEntry }>, kick: 0, log: [] as string[] };
  const deps: BoardPaceDeps = {
    readConfig: async () => (opts.missing ? null : opts.disarmed ? { autorunDisabled: true } : {}),
    snapshot: () => ({ rows: state.rows, unreadable: state.unreadable }),
    mutate: async (fn) => {
      const next = fn(state.unreadable ? [] : state.rows, state.unreadable);
      if (!next) return null;
      state.rows = next;
      state.unreadable = false;
      return next;
    },
    stopRuns: async (board, reason, o) => {
      calls.stop.push({ board, reason, running: o.running });
      return [...(opts.queued ?? []), ...(o.running ? (opts.running ?? []) : [])].map((cardId) => ({ cardId }));
    },
    parkConductors: async (board) => {
      calls.park.push(board);
      return (opts.conductors ?? []).map((cardId) => ({ cardId }));
    },
    rearm: async (board, entry) => {
      if (opts.rearmFails?.includes(entry.cardId)) throw new Error("boom");
      calls.rearm.push({ board, entry });
    },
    kick: () => {
      calls.kick += 1;
    },
    now: () => state.now,
    log: (l) => calls.log.push(l),
  };
  return { deps, state, calls, row: () => state.rows.find((r) => r.board === "acme") };
}

describe("mudar o ritmo de um board — changeBoardPace", () => {
  it("PAUSAR (deixar terminar): o que está na fila sai e fica anotado; o que executa segue; nenhum condutor é incomodado", async () => {
    const w = world({ queued: ["q1"], running: ["r1"], conductors: ["k1"] });
    const res = await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT, reason: "cota apertada" });
    expect(res).toMatchObject({ ok: true, changed: true, stopped: 1, parked: 0, released: 0 });
    expect(w.calls.stop).toEqual([{ board: "acme", reason: "cota apertada", running: false }]);
    expect(w.calls.park).toEqual([]);
    expect(w.row()?.held).toEqual([expect.objectContaining({ cardId: "q1", why: "stopped" })]);
    expect(w.calls.kick).toBe(0);
    if (res.ok) expect(res.gate).toMatchObject({ level: "paused", held: true });
  });

  it("PAUSAR (parar agora): fila e execução saem, e cada condutor vivo recebe o pedido de estacionar", async () => {
    const w = world({ queued: ["q1"], running: ["r1"], conductors: ["k1", "k2"] });
    const res = await changeBoardPace(w.deps, { board: "acme", level: "paused", by: OWNER, mode: "stop" });
    expect(res).toMatchObject({ ok: true, stopped: 2, parked: 2 });
    expect(w.calls.stop[0].running).toBe(true);
    expect(w.calls.park).toEqual(["acme"]);
    expect(w.row()?.held?.map((h) => h.cardId)).toEqual(["q1", "r1"]);
  });

  it("RETOMAR: cada card que a pausa segurou volta ao pipeline e as filas são re-bombeadas", async () => {
    const w = world({ queued: ["q1"] });
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT });
    const res = await changeBoardPace(w.deps, { board: "acme", level: "normal", by: AGENT });
    expect(res).toMatchObject({ ok: true, changed: true, released: 1 });
    expect(w.calls.rearm).toEqual([{ board: "acme", entry: expect.objectContaining({ cardId: "q1", why: "stopped" }) }]);
    expect(w.calls.kick).toBe(1);
    expect(w.row()?.held).toBeUndefined();
    expect(effectivePaceLevel(w.row(), T0)).toBe("normal");
  });

  it("uma devolução que falha não derruba as outras — o vigia de card parado pega a que sobrou", async () => {
    const at = new Date(T0).toISOString();
    const w = world({
      rows: [{ board: "acme", owner: { level: "paused", by: OWNER, at }, held: [{ cardId: "a", why: "entry", at }, { cardId: "b", why: "entry", at }] }],
      rearmFails: ["a"],
    });
    const res = await changeBoardPace(w.deps, { board: "acme", level: "normal", by: OWNER });
    expect(res).toMatchObject({ ok: true, released: 1 });
    expect(w.calls.rearm.map((c) => c.entry.cardId)).toEqual(["b"]);
    expect(w.calls.log.join("\n")).toMatch(/acme\/a: devolver ao pipeline falhou/);
  });

  it("DEVAGAR e a volta ao normal re-bombeiam; nada é parado", async () => {
    const w = world({ queued: ["q1"], running: ["r1"] });
    const slow = await changeBoardPace(w.deps, { board: "acme", level: "slow", by: AGENT });
    expect(slow).toMatchObject({ ok: true, changed: true, stopped: 0, parked: 0 });
    expect(w.calls.stop).toEqual([]);
    await changeBoardPace(w.deps, { board: "acme", level: "normal", by: AGENT });
    expect(w.calls.kick).toBe(2);
  });

  it("A REGRA DO DONO: o agente não retoma o que o dono pausou — nem depois de re-pausar por cima", async () => {
    const w = world();
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: OWNER });
    expect(await changeBoardPace(w.deps, { board: "acme", level: "normal", by: AGENT })).toMatchObject({ ok: false, error: expect.stringMatching(/só ele retoma/) });
    // a tentativa de virar o autor: pausa de agente por cima, depois retomar
    expect(await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT, mode: "stop", forMinutes: 1 })).toMatchObject({ ok: true });
    expect(await changeBoardPace(w.deps, { board: "acme", level: "normal", by: AGENT })).toMatchObject({ ok: false });
    expect(await changeBoardPace(w.deps, { board: "acme", level: "slow", by: AGENT })).toMatchObject({ ok: false });
    expect(effectivePaceLevel(w.row(), T0)).toBe("paused");
    expect(w.row()?.owner).toMatchObject({ level: "paused", by: OWNER });
    expect(w.row()?.owner?.until).toBeUndefined();
    // o dono retoma: as duas camadas saem
    expect(await changeBoardPace(w.deps, { board: "acme", level: "normal", by: OWNER })).toMatchObject({ ok: true, changed: true });
    expect(effectivePaceLevel(w.row(), T0)).toBe("normal");
  });

  it("pedir o que já está em vigor não grava, não para nada e não re-bombeia", async () => {
    const w = world({ queued: ["q1"] });
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT });
    const again = await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT });
    expect(again).toMatchObject({ ok: true, changed: false, stopped: 0 });
    expect(w.calls.stop).toHaveLength(1);
  });

  it("pedido malformado, board que não existe e board desarmado: recusa com a frase, sem gravar", async () => {
    const w = world();
    expect(await changeBoardPace(w.deps, { board: "acme", level: "normal", by: OWNER, forMinutes: 5 })).toMatchObject({ ok: false, error: expect.stringMatching(/prazo vale para pausar/) });
    expect(await changeBoardPace(world({ missing: true }).deps, { board: "ghost", level: "paused", by: OWNER })).toMatchObject({ ok: false, error: expect.stringMatching(/não existe/) });
    expect(await changeBoardPace(world({ disarmed: true }).deps, { board: "acme", level: "normal", by: OWNER })).toMatchObject({ ok: false, error: expect.stringMatching(/desarmado/) });
    expect(w.state.rows).toEqual([]);
  });

  it("registro ILEGÍVEL: o agente não grava; a mudança do dono regrava — e diz que regravou", async () => {
    const w = world({ unreadable: true });
    expect(await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT })).toMatchObject({ ok: false, error: expect.stringMatching(/só o dono/) });
    expect(w.state.unreadable).toBe(true);
    const res = await changeBoardPace(w.deps, { board: "acme", level: "normal", by: OWNER });
    expect(res).toMatchObject({ ok: true, changed: true, rewritten: true });
    expect(w.state.unreadable).toBe(false);
    if (res.ok) expect(res.gate).toMatchObject({ level: "normal", held: false });
  });

  it("uma porta que lança vira recusa com a frase — a ação nunca lança", async () => {
    const w = world();
    w.deps.mutate = async () => {
      throw new Error("disco cheio");
    };
    expect(await changeBoardPace(w.deps, { board: "acme", level: "paused", by: OWNER })).toMatchObject({ ok: false, error: expect.stringMatching(/disco cheio/) });
  });
});

describe("a varredura do prazo — sweepBoardPace", () => {
  it("sem prazo vencido não grava nem re-bombeia", async () => {
    const w = world();
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT, forMinutes: 60 });
    const kicks = w.calls.kick;
    expect(await sweepBoardPace(w.deps)).toEqual({ resumed: [] });
    expect(w.calls.kick).toBe(kicks);
  });

  it("prazo vencido: o board volta ao ritmo de antes, o que a pausa segurou é devolvido e as filas andam", async () => {
    const w = world({ queued: ["q1"] });
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT, forMinutes: 60 });
    w.state.now = T0 + 61 * 60_000;
    const report = await sweepBoardPace(w.deps);
    expect(report.resumed).toEqual([{ board: "acme", level: "normal", released: 1 }]);
    expect(w.calls.rearm.map((c) => c.entry.cardId)).toEqual(["q1"]);
    expect(w.calls.kick).toBe(1);
    expect(w.row()?.agent).toBeUndefined();
    expect(w.row()?.history?.at(-1)).toMatchObject({ expired: true, level: "normal" });
    // a segunda passada não repete
    expect(await sweepBoardPace(w.deps)).toEqual({ resumed: [] });
  });

  it("vence o freio do agente e o dono segue pausando: nada é devolvido e nada é re-bombeado", async () => {
    const w = world({ queued: ["q1"] });
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: OWNER });
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT, mode: "stop", forMinutes: 5 });
    w.state.now = T0 + 6 * 60_000;
    const report = await sweepBoardPace(w.deps);
    expect(report.resumed).toEqual([{ board: "acme", level: "paused", released: 0 }]);
    expect(w.calls.rearm).toEqual([]);
    expect(w.calls.kick).toBe(0);
    expect(w.row()?.held?.length).toBeGreaterThan(0);
  });
});
