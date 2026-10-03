import { describe, expect, it } from "vitest";
import { changeBoardPace, changeBoardScope, GIVE_BACK_CONCURRENCY, newlyAdmittedCards, sweepBoardPace, type BoardPaceDeps } from "./board-pace-actions";
import { effectivePaceLevel, effectiveScope, FIXES_ONLY_TYPES, type BoardPaceRow, type PaceActor, type PaceHeldEntry, type ScopeCard } from "./board-pace";

const OWNER: PaceActor = { kind: "owner" };
const AGENT: PaceActor = { kind: "agent", id: "TOKEN_ORCH" };
const T0 = Date.parse("2026-03-10T12:00:00.000Z");

/** Um mundo em memória: o arquivo de ritmo, o engine e a fila do condutor como dublês que registram o que foi pedido. */
function world(
  opts: {
    rows?: BoardPaceRow[];
    unreadable?: boolean;
    queued?: string[];
    running?: string[];
    conductors?: string[];
    disarmed?: boolean;
    missing?: boolean;
    rearmFails?: string[];
    cards?: ScopeCard[];
    cardsFail?: boolean;
  } = {},
) {
  const state = { rows: opts.rows ?? [], unreadable: opts.unreadable ?? false, now: T0, cards: opts.cards ?? ([] as ScopeCard[]) };
  const calls = { stop: [] as Array<{ board: string; reason: string; running: boolean; filtered: boolean }>, park: [] as string[], rearm: [] as Array<{ board: string; entry: PaceHeldEntry }>, kick: 0, log: [] as string[] };
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
      calls.stop.push({ board, reason, running: o.running, filtered: !!o.only });
      const all = [...(opts.queued ?? []), ...(o.running ? (opts.running ?? []) : [])];
      // como o engine: com `only`, sai da fila só o que o predicado aponta
      const out: string[] = [];
      for (const id of all) if (!o.only || (await o.only(id))) out.push(id);
      return out.map((cardId) => ({ cardId }));
    },
    readCards: async () => {
      if (opts.cardsFail) throw new Error("sem cards");
      return state.cards;
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
    expect(w.calls.stop).toEqual([{ board: "acme", reason: "cota apertada", running: false, filtered: false }]);
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

// ══ o ESCOPO de tipos ═══════════════════════════════════════════════════════════════════════════════

const FIXES = [...FIXES_ONLY_TYPES];
const cardOf = (id: string, over: Partial<ScopeCard> = {}): ScopeCard => ({ id, type: "story", storyType: "user", mode: "build", status: "desenvolver", ...over });
/** um board de uma livraria: funcionalidades (user), erros e manutenção em colunas diferentes */
const shop: ScopeCard[] = [
  cardOf("story-ex9901", { status: "desenvolver" }), // funcionalidade nova, na construção
  cardOf("story-ex9902", { status: "plano-tecnico" }), // funcionalidade nova, na construção
  cardOf("story-ex9903", { status: "desenvolver", storyType: "bug" }), // erro
  cardOf("story-ex9904", { status: "desenvolver", storyType: "chore" }), // manutenção
  cardOf("story-ex9905", { status: "pronta" }), // funcionalidade esperando o go (não é construção)
  cardOf("story-ex9906", { status: "stage" }), // funcionalidade já construída, na entrega
  cardOf("story-ex9907", { status: "qa-automatizado", mode: "fix" }), // `user` em modo fix = erro
];

describe("mudar o escopo de um board — changeBoardScope", () => {
  it("ESTREITAR (dono): da fila do engine sai SÓ o que ficou fora do escopo, anotado para voltar; o que roda termina; nenhum condutor é incomodado; o ritmo não muda", async () => {
    const w = world({ cards: shop, queued: ["story-ex9901", "story-ex9903", "story-ex9904", "story-ex9902"], running: ["story-ex9905"], conductors: ["k1"] });
    const res = await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER, reason: "semana de consertos" });
    expect(res).toMatchObject({ ok: true, changed: true, purged: 2, released: 0, rescanned: 0, rewritten: false });
    expect(w.calls.stop).toEqual([{ board: "acme", reason: "semana de consertos", running: false, filtered: true }]);
    expect(w.calls.park).toEqual([]);
    expect(w.row()?.held).toEqual([
      expect.objectContaining({ cardId: "story-ex9901", why: "scope" }),
      expect.objectContaining({ cardId: "story-ex9902", why: "scope" }),
    ]);
    expect(w.row()?.ownerScope?.types).toEqual(FIXES);
    expect(effectivePaceLevel(w.row(), T0)).toBe("normal");
    expect(w.calls.kick).toBe(0);
    if (res.ok) expect(res.gate.scope?.types).toEqual(FIXES);
  });

  it("o predicado da purga reconhece o que não é da regra: card que não existe ou não é story fica na fila", async () => {
    const w = world({ cards: [...shop, cardOf("idea-ex9910", { type: "idea", storyType: null })], queued: ["idea-ex9910", "fantasma", "story-ex9901"] });
    const res = await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    expect(res).toMatchObject({ ok: true, purged: 1 });
    expect(w.row()?.held?.map((h) => h.cardId)).toEqual(["story-ex9901"]);
  });

  it("ESTREITAR por um agente: grava na camada dos agentes e também purga", async () => {
    const w = world({ cards: shop, queued: ["story-ex9901"] });
    expect(await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: AGENT, forMinutes: 60 })).toMatchObject({ ok: true, purged: 1 });
    expect(w.row()?.agentScope).toMatchObject({ by: AGENT });
    expect(w.row()?.ownerScope).toBeUndefined();
    expect(effectiveScope(w.row(), T0)?.until).toBe(new Date(T0 + 3_600_000).toISOString());
  });

  it("sem conseguir ler os cards, não purga nada (fail-safe) mas grava o escopo e diz no log", async () => {
    const w = world({ cardsFail: true, queued: ["story-ex9901"] });
    expect(await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER })).toMatchObject({ ok: true, changed: true, purged: 0 });
    expect(w.calls.stop).toEqual([]);
    expect(w.calls.log.join("\n")).toMatch(/ler os cards falhou/);
    expect(effectiveScope(w.row(), T0)).not.toBeNull();
  });

  it("ALARGAR (dono): devolve o que o escopo segurava + re-varre os cards de CONSTRUÇÃO que o escopo novo admite, e re-bombeia", async () => {
    const w = world({ cards: shop, queued: ["story-ex9901"] });
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    const res = await changeBoardScope(w.deps, { board: "acme", types: "all", by: OWNER });
    expect(res).toMatchObject({ ok: true, changed: true, released: 2, rescanned: 1 });
    // a anotada (story-ex9901) + a achada pela re-varredura (story-ex9902, plano técnico); erros, manutenção, "a fazer" e a entrega não
    expect(w.calls.rearm.map((c) => c.entry.cardId).sort()).toEqual(["story-ex9901", "story-ex9902"]);
    expect(w.calls.rearm.every((c) => c.entry.why === "scope")).toBe(true);
    expect(w.calls.kick).toBe(1);
    expect(w.row()?.held).toBeUndefined();
    expect(w.row()?.ownerScope).toBeUndefined();
  });

  it("ALARGAR parcialmente (Erro → Erro + Funcionalidade nova): só o que passou a ser admitido volta", async () => {
    const w = world({ cards: shop });
    await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: OWNER });
    const res = await changeBoardScope(w.deps, { board: "acme", types: ["bug", "chore"], by: OWNER });
    // a manutenção (story-ex9904, em Desenvolver) passou a ser admitida; as funcionalidades continuam de fora
    expect(res).toMatchObject({ ok: true, released: 1, rescanned: 1 });
    expect(w.calls.rearm.map((c) => c.entry.cardId)).toEqual(["story-ex9904"]);
  });

  it("C8: ALARGAR parcialmente devolve SÓ as entradas cujo card o escopo novo admite — as que seguem fora continuam anotadas, sem passar pelo pipeline à toa", async () => {
    const w = world({ cards: shop, queued: ["story-ex9901", "story-ex9904"] });
    await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: OWNER });
    expect(w.row()?.held?.map((h) => h.cardId).sort()).toEqual(["story-ex9901", "story-ex9904"]); // a funcionalidade e a manutenção, tiradas da fila
    const res = await changeBoardScope(w.deps, { board: "acme", types: ["bug", "chore"], by: OWNER });
    expect(res).toMatchObject({ ok: true, released: 1, rescanned: 0 });
    expect(w.calls.rearm.map((c) => c.entry.cardId)).toEqual(["story-ex9904"]); // só a manutenção volta
    expect(w.row()?.held?.map((h) => h.cardId)).toEqual(["story-ex9901"]); // a funcionalidade segue anotada para o dia em que o escopo a admitir
    // e alargar de vez devolve a que sobrou
    w.calls.rearm.length = 0;
    await changeBoardScope(w.deps, { board: "acme", types: "all", by: OWNER });
    expect(w.calls.rearm.map((c) => c.entry.cardId).sort()).toEqual(["story-ex9901", "story-ex9902"]);
    expect(w.row()?.held).toBeUndefined();
  });

  it("C8: a re-varredura ao alargar roda com concorrência LIMITADA (não em série, não toda de uma vez)", async () => {
    const at = new Date(T0).toISOString();
    const ids = Array.from({ length: 12 }, (_, n) => `story-ex99${String(10 + n)}`);
    const cards = ids.map((id) => cardOf(id, { status: "desenvolver" }));
    const w = world({
      cards,
      rows: [{ board: "acme", ownerScope: { types: FIXES.slice() as never, by: OWNER, at }, held: ids.map((cardId) => ({ cardId, why: "scope" as const, at })) }],
    });
    let live = 0;
    let peak = 0;
    w.deps.rearm = async (board, entry) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live -= 1;
      w.calls.rearm.push({ board, entry });
    };
    const res = await changeBoardScope(w.deps, { board: "acme", types: "all", by: OWNER });
    expect(res).toMatchObject({ ok: true, released: 12 });
    expect(w.calls.rearm).toHaveLength(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(GIVE_BACK_CONCURRENCY);
  });

  it("ALARGAR com a PAUSA em vigor: a re-varredura roda (o evento de entrada decide, e retém de novo); a pausa não é desfeita", async () => {
    const w = world({ cards: shop });
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: OWNER });
    const res = await changeBoardScope(w.deps, { board: "acme", types: "all", by: OWNER });
    expect(res).toMatchObject({ ok: true, rescanned: 2 });
    expect(effectivePaceLevel(w.row(), T0)).toBe("paused");
  });

  it("A REGRA DO DONO: o agente não alarga além do que o dono admitiu — nem depois de limitar por cima; o dono alarga e apaga o do agente", async () => {
    const w = world({ cards: shop });
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    // «Tudo» de um agente é tirar a camada DELE (C11): sem camada de agente é um no-op, e o escopo do dono segue valendo
    expect(await changeBoardScope(w.deps, { board: "acme", types: "all", by: AGENT })).toMatchObject({ ok: true, changed: false });
    expect(w.row()?.ownerScope).toMatchObject({ by: OWNER });
    expect(await changeBoardScope(w.deps, { board: "acme", types: ["user"], by: AGENT })).toMatchObject({ ok: false, error: expect.stringMatching(/só ele alarga/) });
    expect(await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: AGENT })).toMatchObject({ ok: true });
    expect(await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: AGENT })).toMatchObject({ ok: true }); // volta ao do dono
    expect(w.row()?.ownerScope).toMatchObject({ by: OWNER });
    expect(await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: AGENT })).toMatchObject({ ok: true });
    expect(await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER })).toMatchObject({ ok: true, changed: true });
    expect(w.row()?.agentScope).toBeUndefined();
  });

  it("pedir o que já está em vigor não grava, não purga e não re-bombeia", async () => {
    const w = world({ cards: shop, queued: ["story-ex9901"] });
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    const again = await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    expect(again).toMatchObject({ ok: true, changed: false, purged: 0, released: 0 });
    expect(w.calls.stop).toHaveLength(1);
    expect(w.calls.kick).toBe(0);
  });

  it("pedido malformado, board que não existe, desarmado e registro ilegível", async () => {
    const w = world();
    expect(await changeBoardScope(w.deps, { board: "acme", types: [], by: OWNER })).toMatchObject({ ok: false, error: expect.stringMatching(/ao menos um tipo/) });
    expect(await changeBoardScope(w.deps, { board: "acme", types: "all", by: OWNER, forMinutes: 5 })).toMatchObject({ ok: false, error: expect.stringMatching(/prazo vale para limitar/) });
    expect(await changeBoardScope(world({ missing: true }).deps, { board: "ghost", types: FIXES, by: OWNER })).toMatchObject({ ok: false, error: expect.stringMatching(/não existe/) });
    expect(w.state.rows).toEqual([]);
    expect(await changeBoardScope(world({ disarmed: true }).deps, { board: "acme", types: FIXES, by: OWNER })).toMatchObject({ ok: true }); // não acelera nada
    const u = world({ unreadable: true });
    expect(await changeBoardScope(u.deps, { board: "acme", types: FIXES, by: AGENT })).toMatchObject({ ok: false, error: expect.stringMatching(/só o dono/) });
    const res = await changeBoardScope(u.deps, { board: "acme", types: FIXES, by: OWNER });
    expect(res).toMatchObject({ ok: true, rewritten: true });
    expect(u.state.unreadable).toBe(false);
  });

  it("uma porta que lança vira recusa com a frase — a ação nunca lança", async () => {
    const w = world();
    w.deps.mutate = async () => {
      throw new Error("disco cheio");
    };
    expect(await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER })).toMatchObject({ ok: false, error: expect.stringMatching(/disco cheio/) });
  });

  it("o ritmo e o escopo não se atropelam: pausar/retomar não mexe no escopo, e a retomada não devolve o que o escopo segura", async () => {
    const opts = { cards: shop, queued: ["story-ex9901"] };
    const w = world(opts);
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: OWNER });
    opts.queued = []; // o engine já não tem o que o escopo tirou
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT });
    const resumed = await changeBoardPace(w.deps, { board: "acme", level: "normal", by: AGENT });
    expect(resumed).toMatchObject({ ok: true, released: 0 });
    expect(w.calls.rearm).toEqual([]);
    expect(w.row()?.ownerScope?.types).toEqual(FIXES);
    expect(w.row()?.held?.map((h) => h.why)).toEqual(["scope"]);
  });

  it("newlyAdmittedCards: só story em coluna de construção que o escopo antigo recusava e o novo admite", () => {
    const fixes = effectiveScope(world({ rows: [{ board: "acme", ownerScope: { types: FIXES_ONLY_TYPES.slice() as never, by: OWNER, at: "2026-03-10T12:00:00.000Z" } }] }).row(), T0);
    expect(newlyAdmittedCards(shop, fixes, null).map((c) => c.id)).toEqual(["story-ex9901", "story-ex9902"]);
    expect(newlyAdmittedCards(shop, null, fixes)).toEqual([]);
    expect(newlyAdmittedCards(shop, fixes, fixes)).toEqual([]);
  });
});

describe("a varredura do prazo do ESCOPO — sweepBoardPace", () => {
  it("sem escopo vencido, nada; o relatório do ritmo não ganha campo", async () => {
    const w = world({ cards: shop });
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: AGENT, forMinutes: 60 });
    const kicks = w.calls.kick;
    expect(await sweepBoardPace(w.deps)).toEqual({ resumed: [] });
    expect(w.calls.kick).toBe(kicks);
  });

  it("prazo vencido: o escopo sai, o que ele segurava e os cards de construção admitidos voltam, as filas andam e o ritmo não muda", async () => {
    const w = world({ cards: shop, queued: ["story-ex9901"] });
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: AGENT, forMinutes: 60 });
    w.state.now = T0 + 61 * 60_000;
    const report = await sweepBoardPace(w.deps);
    expect(report.resumed).toEqual([]);
    expect(report.scopeExpired).toEqual([{ board: "acme", released: 2, rescanned: 1 }]);
    expect(w.calls.rearm.map((c) => c.entry.cardId).sort()).toEqual(["story-ex9901", "story-ex9902"]);
    expect(w.calls.kick).toBe(1);
    expect(w.row()?.agentScope).toBeUndefined();
    expect(w.row()?.scopeHistory?.at(-1)).toMatchObject({ expired: true, types: null });
    expect(await sweepBoardPace(w.deps)).toEqual({ resumed: [] }); // a segunda passada não repete
  });

  it("vence o limite do agente e o do dono segue: o escopo alarga só até o do dono (re-varre o que o dono admite)", async () => {
    const w = world({ cards: shop });
    await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: OWNER });
    await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: AGENT, forMinutes: 5 });
    await changeBoardScope(w.deps, { board: "acme", types: ["bug", "chore"], by: OWNER }); // o dono alarga e apaga o do agente
    await changeBoardScope(w.deps, { board: "acme", types: ["bug"], by: AGENT, forMinutes: 5 });
    w.calls.rearm.length = 0;
    w.state.now = T0 + 6 * 60_000;
    const report = await sweepBoardPace(w.deps);
    expect(report.scopeExpired).toHaveLength(1);
    expect(w.row()?.ownerScope?.types).toEqual(["bug", "chore"]);
    expect(w.row()?.agentScope).toBeUndefined();
    expect(w.calls.rearm.map((c) => c.entry.cardId)).toEqual(["story-ex9904"]); // a manutenção que o limite do agente segurava
  });

  it("ritmo E escopo vencendo juntos: cada um devolve o seu", async () => {
    const opts = { cards: shop, queued: ["story-ex9901"] };
    const w = world(opts);
    await changeBoardScope(w.deps, { board: "acme", types: FIXES, by: AGENT, forMinutes: 60 });
    opts.queued = [];
    await changeBoardPace(w.deps, { board: "acme", level: "paused", by: AGENT, forMinutes: 60 });
    w.state.now = T0 + 61 * 60_000;
    const report = await sweepBoardPace(w.deps);
    expect(report.resumed).toEqual([{ board: "acme", level: "normal", released: 0 }]);
    expect(report.scopeExpired).toHaveLength(1);
  });
});
