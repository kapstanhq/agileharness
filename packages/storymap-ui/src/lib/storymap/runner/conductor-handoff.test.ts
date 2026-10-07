// A PASSAGEM AO TRAIN (runner/conductor-handoff.ts) — o condutor encerra depois de submeter, e o serviço fecha o ciclo.
//
// O que estes testes travam, cada um com o defeito que impedem:
//   • a passagem só nasce de um descarte que a DECLARA (`handoff: true`) com submissão no train — um estacionado depois
//     de um checkpoint `done` não volta à frente da fila pela passagem (desfaria a vaga cedida), e o condutor aberto à
//     mão (sem `driver` na linha do registro) também passa;
//   • enquanto o train está com a entrada, nada acontece (nem condutor novo, nem a passagem some); a entrada que some
//     do snapshot sem veredito visto espera um prazo (a fila pode não ter carregado), e o veredito visto fica gravado;
//   • conflito / gate reprovado / merge falho / devolvida-à-sessão ⇒ o card volta para a FRENTE da fila do condutor,
//     com o sessionId de quem submeteu e o veredito na entrada; `done` também (a projeção é do condutor);
//   • uma submissão SUBSTITUÍDA (superseded) ou com outra mais nova do mesmo card não reabre ninguém;
//   • devoluções seguidas têm teto: passado ele, finding no card e nenhum condutor novo; o `done` zera a conta;
//   • a readmissão NÃO re-carimba o driver que o operador limpou entre a leitura e a readmissão;
//   • o assentamento roda ANTES do pump.

import { describe, expect, it } from "vitest";
import {
  CONDUCTOR_HANDOFF_MAX_RETURNS,
  CONDUCTOR_HANDOFF_MISSING_TTL_MS,
  handoffFor,
  handoffVerdict,
  memoryConductorHandoffStore,
  recordConductorHandoff,
  settleConductorHandoffs,
  settleThenPump,
  type ConductorHandoffDeps,
  type TrainEntryView,
} from "./conductor-handoff";
import { admitConductorCard, memoryConductorQueueStore, pumpConductorQueue, type ConductorDeps } from "./conductor";
import type { AgentSession } from "./session-worktree";
import type { SpawnSessionInput, SpawnSessionResult } from "./session-spawn";
import type { MergeQueueStatus } from "./types";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { coerceCard } from "@/lib/storymap/repo";

const config: BoardConfig = {
  id: "demo",
  name: "Demo",
  statuses: [
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: true },
    { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed" },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  conductor: { enabled: true, fromStatus: "desenvolver" },
};

const ROUTING = { skips: [], decidedBy: "rules" as const, decidedAt: "2026-10-01", driver: "conductor" as const };
const conducted = (id: string, extra: Record<string, unknown> = {}): Card =>
  coerceCard(id, { type: "story", status: "desenvolver", routing: ROUTING, ...extra }, "");
const semDriver = (id: string, status = "desenvolver"): Card => coerceCard(id, { type: "story", status }, "");

const T0 = Date.parse("2026-10-06T10:00:00.000Z");

const conductorSession = (over: Partial<AgentSession> = {}): AgentSession =>
  ({
    sessionId: "s-ex9001",
    agentId: "a-ex9001",
    role: "implement",
    task: "conduzir",
    board: "demo",
    cardId: "story-ex9001",
    driver: "conductor",
    tmuxSession: "agent-conductor-story-ex9001-abcd",
    openedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    ...over,
  }) as AgentSession;

const tEntry = (runId: string, status: MergeQueueStatus, extra: Partial<TrainEntryView> = {}): TrainEntryView => ({
  runId,
  board: "demo",
  cardId: "story-ex9001",
  status,
  enqueuedAt: T0,
  ...extra,
});

// ── a régua (PURA) ─────────────────────────────────────────────────────────────────────────────────────

describe("handoffFor — só o descarte que DECLARA a passagem, com submissão no train, deixa passagem", () => {
  const entries = [{ runId: "s-ex9001", enqueuedAt: T0 }];
  it("passagem declarada com a própria entrada no train ⇒ passagem com o runId == sessionId e o instante da entrada", () => {
    expect(handoffFor(conductorSession(), { handoff: true }, entries, "2026-10-06T10:05:00.000Z")).toEqual({
      board: "demo",
      cardId: "story-ex9001",
      runId: "s-ex9001",
      at: "2026-10-06T10:05:00.000Z",
      enqueuedAt: T0,
    });
  });
  it("descarte SEM a marca (estacionar depois de um checkpoint já `done`) ⇒ nenhuma passagem", () => {
    expect(handoffFor(conductorSession(), undefined, entries, "x")).toBeNull();
    expect(handoffFor(conductorSession(), { handoff: false }, entries, "x")).toBeNull();
  });
  it("condutor aberto à MÃO (sem driver na linha do registro) que declara a passagem ⇒ passagem", () => {
    expect(handoffFor(conductorSession({ driver: undefined }), { handoff: true }, entries, "x")).not.toBeNull();
  });
  it("sem submissão, ou sem card ⇒ nenhuma passagem", () => {
    expect(handoffFor(conductorSession(), { handoff: true }, [{ runId: "outra", enqueuedAt: T0 }], "x")).toBeNull();
    expect(handoffFor(conductorSession({ cardId: undefined }), { handoff: true }, entries, "x")).toBeNull();
  });
});

describe("handoffVerdict — o que o veredito do train faz com o card", () => {
  const h = { at: new Date(T0).toISOString(), enqueuedAt: T0 };
  const base = { handoff: h, others: [] as TrainEntryView[], config, someoneLive: false, queued: false, returns: 0, now: T0 + 60_000 };
  const card = conducted("story-ex9001");
  it("train ainda com a entrada (waiting/gate-running/merging) ⇒ keep", () => {
    for (const s of ["waiting", "gate-running", "merging"] as const) {
      expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", s), card }).kind).toBe("keep");
    }
  });
  it("cada veredito de FALHA ⇒ resume, com o status e o motivo do train", () => {
    for (const s of ["returned-to-session", "conflict", "gate-failed", "failed"] as const) {
      const v = handoffVerdict({ ...base, entry: tEntry("s-ex9001", s, { conflictDetail: "conflito em src/a.ts" }), card });
      expect(v).toMatchObject({ kind: "resume", status: s });
      expect(v.why).toContain(s);
    }
  });
  it("done com o card ainda conduzido ⇒ resume (a projeção é do condutor), mesmo depois de devoluções", () => {
    const v = handoffVerdict({ ...base, returns: CONDUCTOR_HANDOFF_MAX_RETURNS, entry: tEntry("s-ex9001", "done"), card });
    expect(v).toMatchObject({ kind: "resume", status: "done" });
  });
  it("devoluções seguidas no teto ⇒ give-up (nenhum condutor novo)", () => {
    const v = handoffVerdict({ ...base, returns: CONDUCTOR_HANDOFF_MAX_RETURNS, entry: tEntry("s-ex9001", "gate-failed"), card });
    expect(v.kind).toBe("give-up");
  });
  it("alguém VIVO no card ⇒ keep (nunca um segundo agente no mesmo card)", () => {
    expect(handoffVerdict({ ...base, someoneLive: true, entry: tEntry("s-ex9001", "failed"), card }).kind).toBe("keep");
  });
  it("card ilegível agora ⇒ keep; card que não existe ⇒ drop", () => {
    expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", "failed"), card: undefined }).kind).toBe("keep");
    expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", "failed"), card: null }).kind).toBe("drop");
  });
  it("entrada fora do snapshot: keep antes do prazo, drop depois; com o veredito já GRAVADO, decide por ele", () => {
    expect(handoffVerdict({ ...base, entry: undefined, card }).kind).toBe("keep");
    expect(handoffVerdict({ ...base, now: T0 + CONDUCTOR_HANDOFF_MISSING_TTL_MS, entry: undefined, card }).kind).toBe("drop");
    const gravado = { ...h, verdict: { status: "gate-failed" as const, failureReason: "suite vermelha" } };
    expect(handoffVerdict({ ...base, handoff: gravado, now: T0 + 10 * CONDUCTOR_HANDOFF_MISSING_TTL_MS, entry: undefined, card })).toMatchObject({
      kind: "resume",
      status: "gate-failed",
    });
  });
  it("submissão SUBSTITUÍDA (superseded) ⇒ drop — quem a substituiu segue", () => {
    for (const reason of ["superseded por run mais novo do mesmo card (s-ex9002)", "superseded — card movido/reaberto"]) {
      expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", "failed", { failureReason: reason }), card }).kind).toBe("drop");
    }
  });
  it("outra submissão MAIS NOVA do card ⇒ drop; outra integração ATIVA mais antiga ⇒ keep", () => {
    const own = tEntry("s-ex9001", "done");
    expect(handoffVerdict({ ...base, entry: own, others: [tEntry("s-ex9002", "waiting", { enqueuedAt: T0 + 1 })], card }).kind).toBe("drop");
    expect(handoffVerdict({ ...base, entry: own, others: [tEntry("s-ex9002", "done", { enqueuedAt: T0 + 1 })], card }).kind).toBe("drop");
    expect(handoffVerdict({ ...base, entry: own, others: [tEntry("s-ex9003", "merging", { enqueuedAt: T0 - 1 })], card }).kind).toBe("keep");
    expect(handoffVerdict({ ...base, entry: own, others: [tEntry("s-ex9003", "done", { enqueuedAt: T0 - 1 })], card }).kind).toBe("resume");
  });
  it("story acabou (sem driver, entregue/terminal) ⇒ drop", () => {
    expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", "done"), card: semDriver("story-ex9002", "revisao") }).kind).toBe("drop");
    expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", "done"), card: conducted("story-ex9003", { status: "concluida" }) }).kind).toBe("drop");
  });
  it("já na fila ⇒ drop; pergunta aberta ⇒ drop (a resposta é que acorda)", () => {
    expect(handoffVerdict({ ...base, queued: true, entry: tEntry("s-ex9001", "failed"), card }).kind).toBe("drop");
    const perguntando = conducted("story-ex9004", { questions: [{ id: "q1", text: "qual?", status: "open" }] });
    expect(handoffVerdict({ ...base, entry: tEntry("s-ex9001", "failed"), card: perguntando }).kind).toBe("drop");
  });
});

// ── o ciclo inteiro, com IO injetado ───────────────────────────────────────────────────────────────────

function harness() {
  const handoffs = memoryConductorHandoffStore();
  const queue = memoryConductorQueueStore();
  const train = new Map<string, TrainEntryView>();
  const cards = new Map<string, Card>();
  const sessions: AgentSession[] = [];
  const live = new Set<string>();
  const marked: string[] = [];
  const findings: Array<{ cardId: string; detail: string }> = [];
  const clock = { now: T0 + 60_000 };
  const spawns: SpawnSessionInput[] = [];
  const conductorDeps = {
    queue,
    sessions: async () => sessions,
    liveTmux: async () => live,
    heartbeatAlive: () => false,
    readCard: async (_b: string, id: string) => cards.get(id) ?? null,
    readBoardConfig: async () => config,
    // como o `withDriver` real: carimba o driver no card — o teste vê se a readmissão re-carimbou
    markDriver: async (_b: string, id: string) => {
      marked.push(id);
      const c = cards.get(id);
      if (c) cards.set(id, { ...c, routing: { ...ROUTING, ...c.routing, driver: "conductor" } });
    },
    clearDriver: async () => {},
    stampDispatchFailure: async () => {},
    masterEnabled: () => true,
    spawn: async (i: SpawnSessionInput): Promise<SpawnSessionResult> => {
      spawns.push(i);
      const session = conductorSession({ sessionId: `novo-${spawns.length}`, tmuxSession: `agent-novo-${spawns.length}`, task: i.task });
      return { ok: true, session, tmuxSession: session.tmuxSession!, route: { model: i.model, why: "t" }, claim: null, mcpMounted: true };
    },
    log: () => {},
  } as unknown as ConductorDeps;
  const deps: ConductorHandoffDeps = {
    store: handoffs,
    entries: async () => [...train.values()],
    readCard: async (_b, id) => cards.get(id) ?? null,
    readBoardConfig: async () => config,
    sessions: async () => sessions,
    liveTmux: async () => live,
    heartbeatAlive: () => false,
    queued: async (b, id) => (await queue.load()).some((e) => e.board === b && e.cardId === id),
    readmit: async (b, id, handoff) => (await admitConductorCard(conductorDeps, b, id, { resume: true, requireDriver: true, handoff })).queued,
    giveUp: async (_b, cardId, detail) => {
      findings.push({ cardId, detail });
    },
    now: () => clock.now,
    log: () => {},
  };
  /** o condutor submeteu (entrada `status` no train) e descartou DECLARANDO a passagem. */
  const handOff = async (runId = "s-ex9001", status: MergeQueueStatus = "waiting") => {
    train.set(runId, tEntry(runId, status));
    return recordConductorHandoff(handoffs, conductorSession({ sessionId: runId }), { handoff: true }, [...train.values()], clock.now);
  };
  return { deps, conductorDeps, handoffs, queue, train, cards, sessions, live, marked, findings, clock, spawns, handOff };
}

describe("settleConductorHandoffs — o serviço fecha o ciclo que o condutor deixou", () => {
  it("submete → encerra → o train DEVOLVE ⇒ o card volta para a FRENTE da fila, com o veredito e o driver intacto, uma vez só", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    // um card qualquer já esperava vaga
    h.queue.entries.push({ board: "demo", cardId: "story-ex9050", queuedAt: "2026-10-06T09:00:00.000Z", attempts: 0 });
    expect(await h.handOff()).not.toBeNull();

    // gate rodando: nada muda
    let r = await settleConductorHandoffs(h.deps);
    expect(r).toMatchObject({ resumed: [], dropped: [], kept: 1 });
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["story-ex9050"]);

    // o train devolveu (a sessão já não existe para resolver)
    h.train.set("s-ex9001", tEntry("s-ex9001", "returned-to-session", { conflictDetail: "código conflita com stage" }));
    r = await settleConductorHandoffs(h.deps);
    expect(r.resumed).toHaveLength(1);
    expect(r.resumed[0].why).toContain("returned-to-session");
    const back = h.queue.entries.find((e) => e.cardId === "story-ex9001");
    expect(back).toMatchObject({ resume: true, handoff: { runId: "s-ex9001", status: "returned-to-session" } });
    expect(h.marked).toEqual([]); // a readmissão não carimba driver (ele já estava lá)
    expect(h.cards.get("story-ex9001")?.routing?.driver).toBe("conductor");
    expect(h.handoffs.entries).toEqual([]); // decidida UMA vez
    expect(h.handoffs.returns).toEqual({ "demo/story-ex9001": 1 });

    // o próximo tick não readmite de novo
    r = await settleConductorHandoffs(h.deps);
    expect(r).toMatchObject({ resumed: [], dropped: [], kept: 0 });
    expect(h.queue.entries.filter((e) => e.cardId === "story-ex9001")).toHaveLength(1);

    // e o pump abre o condutor novo NA FRENTE, com o sessionId de quem submeteu e o veredito na tarefa
    const pumped = await pumpConductorQueue(h.conductorDeps);
    expect(pumped.spawned[0]).toMatchObject({ cardId: "story-ex9001" });
    expect(h.spawns[0].task).toContain("s-ex9001");
    expect(h.spawns[0].task).toContain("returned-to-session");
  });

  it("merge falho e gate reprovado também voltam para a fila (não só a devolução à sessão)", async () => {
    for (const status of ["failed", "gate-failed", "conflict"] as const) {
      const h = harness();
      h.cards.set("story-ex9001", conducted("story-ex9001"));
      await h.handOff("s-ex9001", status);
      const r = await settleConductorHandoffs(h.deps);
      expect(r.resumed.map((x) => x.cardId)).toEqual(["story-ex9001"]);
      expect(h.queue.entries[0]).toMatchObject({ cardId: "story-ex9001", resume: true, handoff: { status } });
    }
  });

  it("(a) checkpoint `done` e depois um ESTACIONAR (descarte sem a marca) ⇒ nada gravado, nada retomado", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    h.train.set("s-ex9001", tEntry("s-ex9001", "done")); // o checkpoint de dados do CONSTRUIR
    expect(await recordConductorHandoff(h.handoffs, conductorSession(), { handoff: false }, [...h.train.values()])).toBeNull();
    expect(await settleConductorHandoffs(h.deps)).toMatchObject({ resumed: [], dropped: [], kept: 0 });
    expect(h.queue.entries).toEqual([]);
  });

  it("(b) o card que CEDEU a vaga (yielded) nunca é promovido a retomada por uma passagem", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001", "gate-failed");
    // o passe de estacionar já o devolveu cedendo a vez
    await admitConductorCard(h.conductorDeps, "demo", "story-ex9001", { yielded: true });
    const r = await settleConductorHandoffs(h.deps);
    expect(r.dropped.map((x) => x.why)).toEqual(["o card já está na fila do condutor"]);
    expect(h.queue.entries).toEqual([expect.objectContaining({ cardId: "story-ex9001", yielded: true })]);
    expect(h.queue.entries[0].resume).toBeUndefined();
  });

  it("submissão substituída (superseded) ou com outra mais nova do card ⇒ nenhum condutor reaberto", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001");
    h.train.set("s-ex9001", tEntry("s-ex9001", "failed", { failureReason: "superseded por run mais novo do mesmo card (s-ex9002)" }));
    h.train.set("s-ex9002", tEntry("s-ex9002", "gate-running", { enqueuedAt: T0 + 5 }));
    const r = await settleConductorHandoffs(h.deps);
    expect(r.resumed).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(h.queue.entries).toEqual([]);
  });

  it("devoluções SEGUIDAS têm teto: passado ele, finding no card e nenhum condutor; o `done` zera a conta", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    for (let i = 1; i <= CONDUCTOR_HANDOFF_MAX_RETURNS; i++) {
      await h.handOff(`s-ex90${i}0`, "gate-failed");
      expect((await settleConductorHandoffs(h.deps)).resumed).toHaveLength(1);
      h.queue.entries.splice(0); // o condutor retomado nasceu e saiu da fila
    }
    expect(h.handoffs.returns["demo/story-ex9001"]).toBe(CONDUCTOR_HANDOFF_MAX_RETURNS);
    await h.handOff("s-ex9090", "gate-failed");
    const r = await settleConductorHandoffs(h.deps);
    expect(r.resumed).toEqual([]);
    expect(r.gaveUp.map((x) => x.cardId)).toEqual(["story-ex9001"]);
    expect(h.findings[0].detail).toContain("failed/agent/s-ex9090");
    expect(h.queue.entries).toEqual([]);
    expect(h.handoffs.returns).toEqual({});

    // uma devolução e depois um `done`: a conta recomeça
    await h.handOff("s-ex9091", "conflict");
    await settleConductorHandoffs(h.deps);
    h.queue.entries.splice(0);
    await h.handOff("s-ex9092", "done");
    await settleConductorHandoffs(h.deps);
    expect(h.handoffs.returns).toEqual({});
  });

  it("o operador limpou o driver entre a leitura e a readmissão ⇒ o driver NÃO é re-carimbado e nada entra na fila", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001", "gate-failed");
    // a régua leu o card conduzido; a readmissão lê de novo — e o operador acabou de devolver o card à cascata
    const deps: ConductorHandoffDeps = {
      ...h.deps,
      queued: async () => {
        h.cards.set("story-ex9001", semDriver("story-ex9001"));
        return false;
      },
    };
    const r = await settleConductorHandoffs(deps);
    expect(r.resumed).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(h.marked).toEqual([]);
    expect(h.cards.get("story-ex9001")?.routing?.driver).toBeUndefined();
    expect(h.queue.entries).toEqual([]);
  });

  it("veredito visto com alguém vivo no card fica GRAVADO: a poda do train não o perde", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001", "gate-failed");
    h.sessions.push(conductorSession({ sessionId: "s-ex9009", tmuxSession: "agent-operador" }));
    h.live.add("agent-operador");
    expect((await settleConductorHandoffs(h.deps)).kept).toBe(1);
    expect(h.handoffs.entries[0].verdict).toMatchObject({ status: "gate-failed" });
    // o operador saiu e o train podou a entrada (100 terminais)
    h.live.delete("agent-operador");
    h.train.delete("s-ex9001");
    h.clock.now += 2 * CONDUCTOR_HANDOFF_MISSING_TTL_MS;
    const r = await settleConductorHandoffs(h.deps);
    expect(r.resumed.map((x) => x.cardId)).toEqual(["story-ex9001"]);
  });

  it("fila do train sem a entrada (não carregou): a passagem espera o prazo; um train ilegível não decide nada", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001", "waiting");
    h.train.clear();
    expect((await settleConductorHandoffs(h.deps)).kept).toBe(1);
    expect((await settleConductorHandoffs({ ...h.deps, entries: async () => Promise.reject(new Error("store")) })).kept).toBe(1);
    expect(h.handoffs.entries).toHaveLength(1);
    h.clock.now += CONDUCTOR_HANDOFF_MISSING_TTL_MS;
    expect((await settleConductorHandoffs(h.deps)).dropped).toHaveLength(1);
  });

  it("done com a projeção já feita (driver limpo no fim da story) ⇒ ninguém é reaberto", async () => {
    const h = harness();
    h.cards.set("story-ex9001", semDriver("story-ex9001", "revisao"));
    await h.handOff("s-ex9001", "done");
    const r = await settleConductorHandoffs(h.deps);
    expect(r.resumed).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(h.queue.entries).toEqual([]);
  });

  it("uma sessão VIVA no card segura a decisão (keep) — e o veredito é entregue quando ela sai", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001", "failed");
    h.sessions.push(conductorSession({ sessionId: "s-ex9009", tmuxSession: "agent-operador" }));
    h.live.add("agent-operador");
    let r = await settleConductorHandoffs(h.deps);
    expect(r.kept).toBe(1);
    expect(h.queue.entries).toEqual([]);
    h.live.delete("agent-operador");
    r = await settleConductorHandoffs(h.deps);
    expect(r.resumed.map((x) => x.cardId)).toEqual(["story-ex9001"]);
  });

  it("uma readmissão ou um finding que FALHA mantém a passagem (o próximo tick tenta) — perder é esperar para sempre", async () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    await h.handOff("s-ex9001", "failed");
    let r = await settleConductorHandoffs({ ...h.deps, readmit: async () => Promise.reject(new Error("disco cheio")) });
    expect(r.kept).toBe(1);
    expect(h.handoffs.entries).toHaveLength(1);
    const cheio = memoryConductorHandoffStore([...h.handoffs.entries], { "demo/story-ex9001": CONDUCTOR_HANDOFF_MAX_RETURNS });
    r = await settleConductorHandoffs({ ...h.deps, store: cheio, giveUp: async () => Promise.reject(new Error("disco cheio")) });
    expect(r.kept).toBe(1);
    expect(cheio.entries).toHaveLength(1);
  });

  it("registrar é idempotente por runId (descarte repetido não duplica)", async () => {
    const h = harness();
    await h.handOff();
    await h.handOff();
    expect(h.handoffs.entries).toHaveLength(1);
  });
});

describe("a retomada de um `done` não fica presa no teto de gasto do card", () => {
  it("handoff `done` ⇒ despacha mesmo acima do teto; uma devolução acima do teto espera o aumento", async () => {
    const h = harness();
    h.conductorDeps.budgetRefusal = async () => "o card chegou ao teto de gasto (US$ 12.40 de US$ 12)";
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    h.cards.set("story-ex9002", conducted("story-ex9002"));
    await admitConductorCard(h.conductorDeps, "demo", "story-ex9001", { resume: true, requireDriver: true, handoff: { runId: "s-ex9001", status: "done" } });
    await admitConductorCard(h.conductorDeps, "demo", "story-ex9002", { resume: true, requireDriver: true, handoff: { runId: "s-ex9002", status: "gate-failed" } });
    const r = await pumpConductorQueue(h.conductorDeps);
    expect(r.spawned.map((x) => x.cardId)).toEqual(["story-ex9001"]);
    expect(r.waiting).toEqual([expect.objectContaining({ cardId: "story-ex9002", reason: expect.stringContaining("teto de gasto") })]);
  });
});

describe("settleThenPump — o assentamento roda ANTES do pump, e a falha dele não impede o pump", () => {
  it("ordem settle → pump; settle que lança ainda bombeia", async () => {
    const order: string[] = [];
    await settleThenPump(
      async () => void order.push("settle"),
      async () => void order.push("pump"),
    );
    const errors: unknown[] = [];
    await settleThenPump(
      async () => {
        order.push("settle-falho");
        throw new Error("x");
      },
      async () => void order.push("pump"),
      (e) => errors.push(e),
    );
    expect(order).toEqual(["settle", "pump", "settle-falho", "pump"]);
    expect(errors).toHaveLength(1);
  });
});

// ── fase 7 — a passagem de um LOTE ──────────────────────────────────────────────────────────────────────────────
describe("a passagem de um LOTE (fase 7)", () => {
  const batch = { id: "lote-s-ex9001", featureKey: "f1", cardIds: ["story-ex9002", "story-ex9003"], dropped: [{ cardId: "story-ex9003", reason: "falhou", at: "x" }] };

  it("a passagem leva os itens que ficaram no lote (sem o que saiu)", () => {
    const h = handoffFor(conductorSession({ batch }), { handoff: true }, [{ runId: "s-ex9001", enqueuedAt: T0 }], "2026-10-06T10:00:00.000Z");
    expect(h?.batchCardIds).toEqual(["story-ex9002"]);
    expect(handoffFor(conductorSession(), { handoff: true }, [{ runId: "s-ex9001", enqueuedAt: T0 }], "x")?.batchCardIds).toBeUndefined();
  });

  const batchHarness = () => {
    const h = harness();
    h.cards.set("story-ex9001", conducted("story-ex9001"));
    h.cards.set("story-ex9002", conducted("story-ex9002"));
    const stamped: string[] = [];
    const splits: Array<{ leadId: string; itemIds: readonly string[] }> = [];
    h.deps.stampItemRanges = async (handoff) => {
      stamped.push(handoff.runId);
    };
    h.deps.splitBatch = async (_b, leadId, itemIds) => {
      splits.push({ leadId, itemIds });
    };
    const handOffBatch = async (status: MergeQueueStatus = "waiting") => {
      h.train.set("s-ex9001", tEntry("s-ex9001", status));
      return recordConductorHandoff(h.handoffs, conductorSession({ batch: { ...batch, dropped: [] , cardIds: ["story-ex9002"] } }), { handoff: true }, [...h.train.values()], h.clock.now);
    };
    return { h, stamped, splits, handOffBatch };
  };

  it("`done` de um lote: cada item ganha o intervalo dele e o líder retoma com os itens na tarefa", async () => {
    const { h, stamped, handOffBatch } = batchHarness();
    await handOffBatch();
    h.train.set("s-ex9001", tEntry("s-ex9001", "done"));
    const r = await settleConductorHandoffs(h.deps);
    expect(r.resumed).toHaveLength(1);
    expect(stamped).toEqual(["s-ex9001"]);
    expect(h.queue.entries.find((e) => e.cardId === "story-ex9001")?.handoff).toEqual({ runId: "s-ex9001", status: "done", batchCardIds: ["story-ex9002"] });
  });

  it("primeira devolução: a retomada decide (lote inteiro); segunda: o serviço DIVIDE e o líder retoma só", async () => {
    const { h, splits, handOffBatch } = batchHarness();
    await handOffBatch();
    h.train.set("s-ex9001", tEntry("s-ex9001", "gate-failed", { failureReason: "suíte vermelha" }));
    await settleConductorHandoffs(h.deps);
    expect(splits).toEqual([]);
    expect(h.queue.entries.find((e) => e.cardId === "story-ex9001")?.handoff).toMatchObject({ status: "gate-failed", batchCardIds: ["story-ex9002"] });

    // a retomada submeteu de novo e o train devolveu outra vez
    await h.queue.persist([]);
    h.train.delete("s-ex9001");
    h.train.set("s-ex9002", tEntry("s-ex9002", "waiting", { enqueuedAt: T0 + 1 }));
    await recordConductorHandoff(h.handoffs, conductorSession({ sessionId: "s-ex9002", batch: { ...batch, dropped: [], cardIds: ["story-ex9002"] } }), { handoff: true }, [...h.train.values()], h.clock.now);
    h.train.set("s-ex9002", tEntry("s-ex9002", "gate-failed", { enqueuedAt: T0 + 1, failureReason: "suíte vermelha de novo" }));
    await settleConductorHandoffs(h.deps);
    expect(splits).toEqual([{ leadId: "story-ex9001", itemIds: ["story-ex9002"] }]);
    expect(h.queue.entries.find((e) => e.cardId === "story-ex9001")?.handoff).toEqual({ runId: "s-ex9002", status: "gate-failed", split: true });
  });

  it("uma divisão que falha segura a passagem para o próximo tick", async () => {
    const { h, handOffBatch } = batchHarness();
    await handOffBatch();
    h.handoffs.returns["demo/story-ex9001"] = 1;
    h.deps.splitBatch = async () => {
      throw new Error("disco cheio");
    };
    h.train.set("s-ex9001", tEntry("s-ex9001", "conflict"));
    const r = await settleConductorHandoffs(h.deps);
    expect(r.kept).toBe(1);
    expect(h.queue.entries.some((e) => e.cardId === "story-ex9001")).toBe(false);
  });
});
