// The CONDUCTOR dispatch (runner/conductor.ts) — admit + pump, over injected IO.
//
// What these pin, each with the defect it prevents:
//   • the card gets `routing.driver: conductor` BEFORE anything else (else the cascade spawns a column skill
//     into the card while its conductor is being born);
//   • at most `maxSessions` live conductors PER BOARD — the excess waits, and a slot freed by a conductor whose
//     tmux died is re-used on the next pass (the "re-check when a session ends" loop);
//   • idempotent: a re-admission never queues twice, a card with a live conductor is never re-spawned;
//   • the spawn is the SAME door `claude_new` uses, with the conductor's first prompt and role implement;
//   • every refusal of the spawn door lands in the right bucket (wait / drop / give up with a finding).

import { describe, expect, it } from "vitest";
import {
  cardMissingDecision,
  conductorSessionSlug,
  conductorSlotFacts,
  derivedQueueTier,
  isConductorOrphan,
  isSlotWait,
  slotWait,
  countLiveConductorsByBoard,
  admitConductorCard,
  CONDUCTOR_END_GRACE_MS,
  CONDUCTOR_MAX_SPAWN_ATTEMPTS,
  compareConductorQueue,
  endFinishedConductors,
  endOrphanConductorTerminals,
  CONDUCTOR_TMUX_NAME,
  type ConductorOrphanDeps,
  isLiveConductor,
  memoryConductorQueueStore,
  pumpConductorQueue,
  type ConductorDeps,
  type ConductorEndDeps,
  type ConductorQueueEntry,
  type QueuedCardMiss,
} from "./conductor";
import { resolveBoardGate, type BoardPaceRow } from "./board-pace";
import type { AgentSession } from "./session-worktree";
import type { SpawnSessionInput, SpawnSessionResult } from "./session-spawn";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { coerceCard } from "@/lib/storymap/repo";

const statuses = [
  { id: "pronta", name: "Pronta", autorun: false },
  { id: "desenvolver", name: "Dev", trigger: "harness-do" as const, autorun: true },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
  { id: "arquivados", name: "Arquivados", terminal: true },
];
const cfg = (over: Partial<BoardConfig["conductor"]> | null = {}): BoardConfig => ({
  id: "b",
  name: "B",
  statuses,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  ...(over === null ? {} : { conductor: { enabled: true, fromStatus: "pronta", ...over } }),
});

const conducted = (id: string, status = "pronta"): Card =>
  coerceCard(id, { type: "story", status, routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" } }, "");

interface Harness {
  deps: ConductorDeps;
  queue: ReturnType<typeof memoryConductorQueueStore>;
  spawns: SpawnSessionInput[];
  sessions: AgentSession[];
  live: Set<string>;
  cards: Map<string, Card>;
  marked: string[];
  cleared: string[];
  findings: Array<{ cardId: string; detail: string }>;
  config: { value: BoardConfig };
  master: { on: boolean };
  gate: { admit: boolean };
}

function harness(opts: { spawn?: (i: SpawnSessionInput) => SpawnSessionResult; config?: BoardConfig } = {}): Harness {
  const queue = memoryConductorQueueStore();
  const spawns: SpawnSessionInput[] = [];
  const sessions: AgentSession[] = [];
  const live = new Set<string>();
  const cards = new Map<string, Card>();
  const marked: string[] = [];
  const cleared: string[] = [];
  const findings: Array<{ cardId: string; detail: string }> = [];
  const config = { value: opts.config ?? cfg() };
  const master = { on: true };
  const gate = { admit: true };
  let n = 0;
  const defaultSpawn = (i: SpawnSessionInput): SpawnSessionResult => {
    n += 1;
    const session: AgentSession = {
      sessionId: `sess-${n}`,
      agentId: `sess-${n}`,
      role: i.role,
      board: i.board,
      cardId: i.cardId,
      task: i.task,
      driver: i.driver,
      tmuxSession: `agent-conductor-${i.cardId}`,
      openedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    sessions.push(session);
    live.add(session.tmuxSession!);
    return { ok: true, session, tmuxSession: session.tmuxSession!, route: { model: i.model, why: "t" }, claim: null, mcpMounted: true };
  };
  const deps: ConductorDeps = {
    queue,
    sessions: async () => sessions,
    liveTmux: async () => live,
    heartbeatAlive: () => true,
    readCard: async (_b, id) => cards.get(id) ?? null,
    readBoardConfig: async () => config.value,
    markDriver: async (_b, id) => {
      marked.push(id);
      const c = cards.get(id);
      // Like the real `withDriver`: stamp the driver and KEEP the rest of the route (a model cap, skips…).
      if (c) cards.set(id, { ...c, routing: { skips: [], decidedBy: "rules", decidedAt: "x", ...c.routing, driver: "conductor" } });
    },
    clearDriver: async (_b, id) => {
      cleared.push(id);
    },
    stampDispatchFailure: async (_b, cardId, detail) => {
      findings.push({ cardId, detail });
    },
    spawn: async (i) => {
      spawns.push(i);
      return (opts.spawn ?? defaultSpawn)(i);
    },
    masterEnabled: () => master.on,
    admission: () =>
      gate.admit
        ? { admit: true, reason: "admit", detail: "ok", retryAt: null }
        : { admit: false, reason: "latch", detail: "trava 92/90", retryAt: null },
    log: () => {},
  };
  return { deps, queue, spawns, sessions, live, cards, marked, cleared, findings, config, master, gate };
}

describe("admitConductorCard — driver primeiro, fila durável, idempotente", () => {
  it("marca o driver e enfileira", async () => {
    const h = harness();
    h.cards.set("s1", coerceCard("s1", { type: "story", status: "pronta" }, ""));
    expect(await admitConductorCard(h.deps, "b", "s1")).toEqual({ queued: true });
    expect(h.marked).toEqual(["s1"]);
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["s1"]);
  });

  it("a segunda admissão (eco do watcher) não duplica a fila", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    expect(await admitConductorCard(h.deps, "b", "s1")).toEqual({ queued: false });
    expect(h.queue.entries).toHaveLength(1);
  });

  it("um card que JÁ tem condutor vivo não entra na fila (o próprio condutor moveu o card para cá)", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    h.sessions.push({ sessionId: "x", agentId: "x", role: "implement", board: "b", cardId: "s1", task: "t", driver: "conductor", tmuxSession: "agent-x", openedAt: "", heartbeatAt: "" });
    h.live.add("agent-x");
    expect(await admitConductorCard(h.deps, "b", "s1")).toEqual({ queued: false });
    expect(h.queue.entries).toHaveLength(0);
  });
});

describe("pumpConductorQueue — o cap POR BOARD, a espera e a vaga que volta", () => {
  it("abre a sessão pela MESMA porta do claude_new: implement, driver conductor, prompt /harness-conductor", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned.map((s) => s.cardId)).toEqual(["s1"]);
    expect(h.spawns[0]).toMatchObject({
      role: "implement",
      board: "b",
      cardId: "s1",
      driver: "conductor",
      command: "/harness-conductor b/s1",
      model: "opus",
      name: expect.stringMatching(/^conductor-s1-[0-9a-z]{4}$/), // sufixo por despacho (v0.9.1)
    });
    expect(h.queue.entries).toHaveLength(0);
  });

  it("o teto de modelo do CARD (routing.modelCap) vale para o condutor: sonnet com a janela de 1M, e só nesse card", async () => {
    const h = harness({ config: cfg({ model: "opus[1m]" }) });
    h.cards.set("capped", { ...conducted("capped"), routing: { ...conducted("capped").routing!, modelCap: "sonnet" } });
    h.cards.set("plain", conducted("plain"));
    await admitConductorCard(h.deps, "b", "capped");
    await admitConductorCard(h.deps, "b", "plain");
    await pumpConductorQueue(h.deps);
    const modelOf = (cardId: string) => h.spawns.find((s) => s.cardId === cardId)?.model;
    expect(modelOf("capped")).toBe("sonnet[1m]");
    // Sem teto no card, NADA muda — nem o modelo do board, nem o sufixo.
    expect(modelOf("plain")).toBe("opus[1m]");
  });

  // Paradas por recurso, fatia 3: para um card conduzido o teto de gasto era só texto da skill. Agora a fila o respeita.
  it("card que chegou ao teto de gasto ESPERA na fila (não sai, não nasce condutor) e entra quando o teto é aumentado", async () => {
    const h = harness();
    h.cards.set("caro", conducted("caro"));
    h.cards.set("ok", conducted("ok"));
    const over = new Set(["caro"]);
    h.deps.budgetRefusal = async (_b, card) => (over.has(card.id) ? "o card chegou ao teto de gasto (US$ 12.40 de US$ 12) — só segue com um aumento aprovado" : null);
    await admitConductorCard(h.deps, "b", "caro");
    await admitConductorCard(h.deps, "b", "ok");
    const first = await pumpConductorQueue(h.deps);
    expect(first.spawned.map((x) => x.cardId)).toEqual(["ok"]);
    expect(first.waiting).toEqual([{ board: "b", cardId: "caro", reason: expect.stringContaining("teto de gasto") }]);
    expect(h.queue.entries.map((e) => [e.cardId, e.lastWaitKind])).toEqual([["caro", "budget"]]);
    over.clear(); // o aumento foi aprovado
    expect((await pumpConductorQueue(h.deps)).spawned.map((x) => x.cardId)).toEqual(["caro"]);
  });

  // Paradas por recurso, fatia 4: a vaga extra — só quando o dep diz que TODAS as travas passam.
  it("board no limite: o card que ganha a vaga extra nasce (e fica registrado); o seguinte espera — só UMA a mais", async () => {
    const h = harness();
    const extraFor: string[] = [];
    const asked: Array<[string, number, number]> = [];
    h.deps.extraSlot = async (_b, card, live, max) => {
      asked.push([card.id, live, max]);
      return live < max + 1 ? { open: true, why: "máquina folgada" } : { open: false, why: "o board já usa 1 vaga(s) extra(s)" };
    };
    h.deps.onExtraSlot = async (_b, card) => {
      extraFor.push(card.id);
    };
    for (const id of ["s1", "s2", "s3", "s4"]) {
      h.cards.set(id, conducted(id));
      await admitConductorCard(h.deps, "b", id);
    }
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned.map((x) => x.cardId)).toEqual(["s1", "s2", "s3"]);
    expect(rep.waiting.map((x) => x.cardId)).toEqual(["s4"]);
    expect(extraFor).toEqual(["s3"]);
    // as duas primeiras nascem dentro do limite: o dep nem é consultado para elas
    expect(asked).toEqual([["s3", 2, 2], ["s4", 3, 2]]);
  });

  it("sem as travas (ou sem o dep, ou com o dep falhando) o limite do board é o limite", async () => {
    for (const extraSlot of [undefined, async () => ({ open: false, why: "processador em 4.0" }), async () => { throw new Error("sonda fora"); }]) {
      const h = harness();
      if (extraSlot) h.deps.extraSlot = extraSlot as never;
      for (const id of ["s1", "s2", "s3"]) {
        h.cards.set(id, conducted(id));
        await admitConductorCard(h.deps, "b", id);
      }
      const rep = await pumpConductorQueue(h.deps);
      expect(rep.spawned.map((x) => x.cardId)).toEqual(["s1", "s2"]);
      expect(rep.waiting[0]).toMatchObject({ cardId: "s3", reason: expect.stringContaining("esperando uma vaga") });
    }
  });

  it("um leitor de teto que falha não prende a fila (o condutor nasce — o teto da skill segue valendo)", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    h.deps.budgetRefusal = async () => {
      throw new Error("ledger ilegível");
    };
    await admitConductorCard(h.deps, "b", "s1");
    expect((await pumpConductorQueue(h.deps)).spawned.map((x) => x.cardId)).toEqual(["s1"]);
  });

  it("maxSessions (default 2): o TERCEIRO espera; quando um condutor morre, ele entra no próximo pump", async () => {
    const h = harness();
    for (const id of ["s1", "s2", "s3"]) {
      h.cards.set(id, conducted(id));
      await admitConductorCard(h.deps, "b", id);
    }
    const first = await pumpConductorQueue(h.deps);
    expect(first.spawned.map((s) => s.cardId)).toEqual(["s1", "s2"]);
    expect(first.waiting.map((w) => w.cardId)).toEqual(["s3"]);
    expect(first.waiting[0].reason).toContain("esperando uma vaga");

    // Sem vaga, um pump de novo não faz nada.
    expect((await pumpConductorQueue(h.deps)).spawned).toEqual([]);

    // O condutor de s1 MORRE (o tmux sumiu): a vaga volta.
    h.live.delete("agent-conductor-s1");
    const after = await pumpConductorQueue(h.deps);
    expect(after.spawned.map((s) => s.cardId)).toEqual(["s3"]);
    expect(h.queue.entries).toHaveLength(0);
  });

  it("o cap é POR BOARD — um condutor vivo de OUTRO board não ocupa vaga aqui", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    h.sessions.push({ sessionId: "o", agentId: "o", role: "implement", board: "outro", cardId: "z", task: "t", driver: "conductor", tmuxSession: "agent-o", openedAt: "", heartbeatAt: "" });
    h.live.add("agent-o");
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    expect((await pumpConductorQueue(h.deps)).spawned.map((s) => s.cardId)).toEqual(["s1"]);
  });

  it("master switch desligado: a fila ESPERA (não descarta) e anda quando ele volta", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    h.master.on = false;
    const paused = await pumpConductorQueue(h.deps);
    expect(paused.spawned).toEqual([]);
    expect(h.queue.entries).toHaveLength(1);
    h.master.on = true;
    expect((await pumpConductorQueue(h.deps)).spawned).toHaveLength(1);
  });

  it("governador retém (cota/trava): a fila ESPERA sem spawn e anda quando a janela libera", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    h.gate.admit = false;
    const held = await pumpConductorQueue(h.deps);
    expect(held.spawned).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(h.queue.entries).toHaveLength(1);
    h.gate.admit = true;
    expect((await pumpConductorQueue(h.deps)).spawned).toHaveLength(1);
  });

  it("o board desligou o conductor antes da sessão nascer: sai da fila E o driver da dispatch é removido", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    h.config.value = cfg({ enabled: false });
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.dropped.map((d) => d.cardId)).toEqual(["s1"]);
    expect(h.cleared).toEqual(["s1"]);
    expect(h.spawns).toEqual([]);
  });

  it("o operador tirou o driver enquanto esperava: sai da fila sem spawn", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    h.cards.set("s1", coerceCard("s1", { type: "story", status: "pronta" }, ""));
    expect((await pumpConductorQueue(h.deps)).dropped[0].reason).toContain("driver foi removido");
    expect(h.spawns).toEqual([]);
  });

  it("máquina saturada (no_capacity): espera e PARA a passada (os seguintes falhariam igual)", async () => {
    const h = harness({ spawn: () => ({ ok: false, code: "no_capacity", reason: "cheio", queue: [] }) });
    for (const id of ["s1", "s2"]) {
      h.cards.set(id, conducted(id));
      await admitConductorCard(h.deps, "b", id);
    }
    const rep = await pumpConductorQueue(h.deps);
    expect(h.spawns).toHaveLength(1); // s2 nem tentou
    expect(rep.waiting.map((w) => w.cardId)).toEqual(["s1", "s2"]);
    expect(h.queue.entries).toHaveLength(2);
  });

  it("card reservado por OUTRA SESSÃO: sai da fila (já tem dono); por um RUN: espera", async () => {
    const holder = (actor: string) => ({ board: "b", cardId: "s1", actor, kind: "implement" as const, scope: "both" as const, acquiredAt: "", expiresAt: "", heartbeatAt: "" });
    const bySession = harness({ spawn: () => ({ ok: false, code: "card_claimed", reason: "r", holder: holder("session:op") }) });
    bySession.cards.set("s1", conducted("s1"));
    await admitConductorCard(bySession.deps, "b", "s1");
    expect((await pumpConductorQueue(bySession.deps)).dropped).toHaveLength(1);

    const byRun = harness({ spawn: () => ({ ok: false, code: "card_claimed", reason: "r", holder: holder("run:abc") }) });
    byRun.cards.set("s1", conducted("s1"));
    await admitConductorCard(byRun.deps, "b", "s1");
    expect((await pumpConductorQueue(byRun.deps)).waiting).toHaveLength(1);
    expect(byRun.queue.entries).toHaveLength(1);
  });

  it(`falha de encanamento: tenta ${CONDUCTOR_MAX_SPAWN_ATTEMPTS}x e desiste com um finding para o operador`, async () => {
    const h = harness({ spawn: () => ({ ok: false, code: "session_lost", reason: "morreu ao nascer" }) });
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    for (let i = 1; i < CONDUCTOR_MAX_SPAWN_ATTEMPTS; i++) {
      await pumpConductorQueue(h.deps);
      expect(h.queue.entries[0].attempts).toBe(i);
      expect(h.findings).toEqual([]);
    }
    const last = await pumpConductorQueue(h.deps);
    expect(last.dropped).toHaveLength(1);
    expect(h.queue.entries).toHaveLength(0);
    expect(h.findings).toHaveLength(1);
    expect(h.findings[0].detail).toContain("set_card_driver");
  });

  it("card num status terminal sai da fila sem spawn", async () => {
    const h = harness();
    h.cards.set("s1", conducted("s1", "concluida"));
    await admitConductorCard(h.deps, "b", "s1");
    expect((await pumpConductorQueue(h.deps)).dropped).toHaveLength(1);
    expect(h.spawns).toEqual([]);
  });
});

describe("a espera do condutor NÃO é muda — motivo persistido, log na mudança, e o governador sabe quem ele retém", () => {
  // Medido na v0.8.0 no ar: o despacho esperava em silêncio — `wait(e, reason)` não era logado nem persistido, e
  // o painel do governador dizia «retidos: nenhum» com um condutor parado pela janela da conta.
  function observed() {
    const h = harness();
    const logs: string[] = [];
    const held: string[][] = [];
    let t = Date.UTC(2026, 8, 25, 2, 0);
    let pct = 90;
    h.deps.log = (l) => void logs.push(l);
    h.deps.reportHeld = (keys) => void held.push([...keys]);
    h.deps.now = () => t;
    // o detalhe do governador muda a cada passada (números) — a CLASSE do motivo, não
    h.deps.admission = () =>
      h.gate.admit
        ? { admit: true, reason: "admit", detail: "ok", retryAt: null }
        : { admit: false, reason: "stale", detail: `leitura de uso defasada (${pct++}min, limite 20min)`, retryAt: null };
    return { h, logs, held, tick: (ms: number) => void (t += ms) };
  }

  it("o motivo e DESDE QUANDO ficam na entrada da fila; o log sai UMA vez por classe de motivo", async () => {
    const { h, logs, tick } = observed();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    h.gate.admit = false;
    const t0 = new Date(h.deps.now!()).toISOString();
    await pumpConductorQueue(h.deps);
    tick(300_000);
    await pumpConductorQueue(h.deps);
    tick(300_000);
    await pumpConductorQueue(h.deps);

    const e = h.queue.entries[0];
    expect(e.lastWaitKind).toBe("account:stale");
    expect(e.lastWaitReason).toMatch(/^janela da conta: leitura de uso defasada \(92min/);
    expect(e.lastWaitAt).toBe(t0); // desde a PRIMEIRA passada com este motivo, não a última
    expect(logs.filter((l) => l.includes("esperando"))).toEqual([
      expect.stringContaining("b/s1 esperando: janela da conta: leitura de uso defasada (90min"),
    ]);

    // o motivo MUDA de classe ⇒ uma linha nova, e o relógio recomeça
    h.master.on = false;
    tick(60_000);
    await pumpConductorQueue(h.deps);
    expect(h.queue.entries[0]).toMatchObject({ lastWaitKind: "autorun-off", lastWaitAt: new Date(h.deps.now!()).toISOString() });
    expect(logs.filter((l) => l.includes("esperando"))).toHaveLength(2);
  });

  it("o governador recebe o conjunto RETIDO PELA JANELA — e ele se esvazia quando a janela libera", async () => {
    const { h, held } = observed();
    h.cards.set("s1", conducted("s1"));
    h.cards.set("s2", conducted("s2"));
    await admitConductorCard(h.deps, "b", "s1");
    await admitConductorCard(h.deps, "b", "s2");
    h.gate.admit = false;
    await pumpConductorQueue(h.deps);
    expect(held.at(-1)).toEqual(["b/s1", "b/s2"]);
    h.gate.admit = true;
    await pumpConductorQueue(h.deps);
    expect(h.spawns).toHaveLength(2);
    expect(held.at(-1)).toEqual([]);
  });

  it("uma passada que NÃO perguntou ao governador não zera o retido (não sabe) — fila vazia zera", async () => {
    const { h, held } = observed();
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    h.gate.admit = false;
    await pumpConductorQueue(h.deps);
    expect(held).toEqual([["b/s1"]]);
    h.master.on = false; // a passada para antes do governador
    await pumpConductorQueue(h.deps);
    expect(held).toEqual([["b/s1"]]);
    h.cards.delete("s1"); // o card sumiu: a fila esvazia
    await pumpConductorQueue(h.deps);
    await pumpConductorQueue(h.deps);
    expect(held.at(-1)).toEqual([]);
  });

  it("a falha de encanamento também é dita (antes só ia para o contador em silêncio)", async () => {
    const { h, logs } = observed();
    h.deps.spawn = async () => ({ ok: false, code: "spawn_failed", reason: "tmux: no server" });
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    await pumpConductorQueue(h.deps);
    await pumpConductorQueue(h.deps);
    expect(h.queue.entries[0]).toMatchObject({ attempts: 2, lastWaitKind: "spawn-failed", lastError: "spawn_failed: tmux: no server" });
    expect(logs.filter((l) => l.includes("esperando: spawn falhou"))).toHaveLength(1);
  });
});

describe("isLiveConductor — a contagem do cap", () => {
  const s = (over: Partial<AgentSession> = {}): AgentSession => ({
    sessionId: "x",
    agentId: "x",
    role: "implement",
    task: "t",
    driver: "conductor",
    tmuxSession: "agent-x",
    openedAt: "",
    heartbeatAt: "",
    ...over,
  });

  it("vivo enquanto o tmux responde; morto quando some", () => {
    expect(isLiveConductor(s(), new Set(["agent-x"]), () => false)).toBe(true);
    expect(isLiveConductor(s(), new Set(), () => true)).toBe(false);
  });

  it("sonda sem resposta (null) conta como VIVO — fail-closed para um CAP", () => {
    expect(isLiveConductor(s(), null, () => false)).toBe(true);
  });

  it("uma sessão comum (sem driver) nunca ocupa vaga de condutor", () => {
    expect(isLiveConductor(s({ driver: undefined }), new Set(["agent-x"]), () => true)).toBe(false);
  });
});


describe("identidade do condutor — um tmux, um condutor (v0.9.1)", () => {
  const row = (sessionId: string, tmuxSession: string | undefined, board = "b") =>
    ({ sessionId, agentId: sessionId, role: "implement", board, cardId: "s1", task: "t", driver: "conductor", tmuxSession, openedAt: "x", heartbeatAt: "x" }) as AgentSession;

  it("duas linhas do registro no MESMO tmux contam como UM condutor (a morta não ressuscita pela viva)", () => {
    const counts = countLiveConductorsByBoard([row("dead", "agent-conductor-s1"), row("live", "agent-conductor-s1"), row("other", "agent-conductor-s2")]);
    expect(counts.get("b")).toBe(2);
  });

  it("linha sem tmux conta por si; boards separados", () => {
    const counts = countLiveConductorsByBoard([row("hb", undefined), row("x", "agent-x", "c")]);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("c")).toBe(1);
  });

  it("dois despachos do mesmo card nunca repetem o nome do tmux", () => {
    expect(conductorSessionSlug("story-1", 1_790_000_000_000)).not.toBe(conductorSessionSlug("story-1", 1_790_000_060_000));
    expect(conductorSessionSlug("story-1", 1_790_000_000_000)).toMatch(/^conductor-story-1-[0-9a-z]{4}$/);
  });
});

describe("condutor que TERMINOU não segura vaga (num caso real, condutores ociosos por dias em «No ar»)", () => {
  const liveConductor = (h: Harness, cardId: string) => {
    const s: AgentSession = {
      sessionId: `sess-${cardId}`,
      agentId: `sess-${cardId}`,
      role: "implement",
      board: "b",
      cardId,
      task: "t",
      driver: "conductor",
      tmuxSession: `agent-conductor-${cardId}`,
      worktreePath: `/w/${cardId}`,
      branch: `agent/sess-${cardId}`,
      baseCommit: "abc",
      openedAt: "",
      heartbeatAt: "",
    };
    h.sessions.push(s);
    h.live.add(s.tmuxSession!);
    return s;
  };

  it("card entregue (No ar) não conta para maxSessions — o próximo da fila nasce na MESMA passada", async () => {
    const h = harness();
    liveConductor(h, "feito");
    h.cards.set("feito", conducted("feito", "concluida"));
    liveConductor(h, "andando");
    h.cards.set("andando", conducted("andando", "desenvolver"));
    h.cards.set("s3", conducted("s3"));
    await admitConductorCard(h.deps, "b", "s3");

    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned.map((s) => s.cardId)).toEqual(["s3"]);
    expect(h.queue.entries).toHaveLength(0);
  });

  it.each([
    ["foi para a lixeira (o card sumiu)", () => null],
    ["perdeu o routing.driver: conductor", () => coerceCard("x", { type: "story", status: "desenvolver" }, "")],
    ["foi arquivado (terminal, não entregue)", () => conducted("x", "arquivados")],
    ["está sendo descontinuado", () => ({ ...conducted("x", "desenvolver"), mode: "retire" as const })],
  ])("também não conta o condutor cujo card %s", async (_why, card) => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    liveConductor(h, "x");
    const c = card();
    if (c) h.cards.set("x", c);
    h.cards.set("s9", conducted("s9"));
    await admitConductorCard(h.deps, "b", "s9");
    expect((await pumpConductorQueue(h.deps)).spawned.map((s) => s.cardId)).toEqual(["s9"]);
  });

  it("um condutor com a story em andamento segue ocupando a vaga", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    liveConductor(h, "andando");
    h.cards.set("andando", conducted("andando", "desenvolver"));
    h.cards.set("s9", conducted("s9"));
    await admitConductorCard(h.deps, "b", "s9");
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned).toEqual([]);
    expect(rep.waiting[0].reason).toContain("esperando uma vaga");
  });

  function ending(h: Harness, settled: { value: { settled: true; detail: string } | { settled: false; reason: string } }) {
    let t = Date.UTC(2026, 8, 29, 12, 0);
    const exits: string[] = [];
    const kills: string[] = [];
    const released: string[] = [];
    const deps: ConductorEndDeps = {
      sessions: h.deps.sessions,
      liveTmux: h.deps.liveTmux,
      heartbeatAlive: h.deps.heartbeatAlive,
      readCard: h.deps.readCard,
      readBoardConfig: h.deps.readBoardConfig,
      workSettled: async () => settled.value,
      requestExit: async (s) => {
        exits.push(s.sessionId);
        return true;
      },
      kill: async (s) => {
        kills.push(s.sessionId);
      },
      releaseClaims: async (s) => {
        released.push(s.sessionId);
      },
      state: new Map(),
      now: () => t,
      log: () => {},
    };
    return { deps, exits, kills, released, tick: (ms: number) => void (t += ms) };
  }

  it("encerra com carência: espera, pede /exit UMA vez, libera o claim — e só mata se o /exit não pegou", async () => {
    const h = harness();
    const s = liveConductor(h, "feito");
    h.cards.set("feito", conducted("feito", "concluida"));
    const e = ending(h, { value: { settled: true, detail: "integrado" } });

    await endFinishedConductors(e.deps);
    expect(e.exits).toEqual([]); // a carência começa agora
    e.tick(CONDUCTOR_END_GRACE_MS - 1);
    await endFinishedConductors(e.deps);
    expect(e.exits).toEqual([]);

    e.tick(1);
    await endFinishedConductors(e.deps);
    expect(e.exits).toEqual([s.sessionId]);
    expect(e.released).toEqual([s.sessionId]);
    await endFinishedConductors(e.deps);
    expect(e.exits).toHaveLength(1); // não repete o /exit a cada tick
    expect(e.kills).toEqual([]);

    // o /exit não pegou (o tmux segue vivo uma carência inteira depois) → encerra à força
    e.tick(CONDUCTOR_END_GRACE_MS);
    await endFinishedConductors(e.deps);
    expect(e.kills).toEqual([s.sessionId]);
  });

  it.each([
    ["árvore suja", { settled: false as const, reason: "trabalho NÃO commitado na árvore" }],
    ["submissão não integrada", { settled: false as const, reason: "a última submissão está 'gate-failed' no train" }],
  ])("%s: NUNCA encerra — mas também não segura a vaga", async (_why, verdict) => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    liveConductor(h, "feito");
    h.cards.set("feito", conducted("feito", "concluida"));
    const e = ending(h, { value: verdict });
    for (let i = 0; i < 5; i++) {
      await endFinishedConductors(e.deps);
      e.tick(CONDUCTOR_END_GRACE_MS);
    }
    expect(e.exits).toEqual([]);
    expect(e.kills).toEqual([]);
    expect(e.released).toEqual([]);

    h.cards.set("s9", conducted("s9"));
    await admitConductorCard(h.deps, "b", "s9");
    expect((await pumpConductorQueue(h.deps)).spawned.map((x) => x.cardId)).toEqual(["s9"]);
  });

  it("a carência exige o fim CONTÍNUO: um card que voltou a ter trabalho zera o relógio; um condutor em andamento nunca é tocado", async () => {
    const h = harness();
    liveConductor(h, "feito");
    h.cards.set("feito", conducted("feito", "concluida"));
    liveConductor(h, "andando");
    h.cards.set("andando", conducted("andando", "desenvolver"));
    const e = ending(h, { value: { settled: true, detail: "integrado" } });

    await endFinishedConductors(e.deps);
    e.tick(CONDUCTOR_END_GRACE_MS / 2);
    h.cards.set("feito", conducted("feito", "desenvolver")); // reaberto
    await endFinishedConductors(e.deps);
    e.tick(CONDUCTOR_END_GRACE_MS / 2);
    h.cards.set("feito", conducted("feito", "concluida"));
    await endFinishedConductors(e.deps);
    e.tick(CONDUCTOR_END_GRACE_MS / 2);
    await endFinishedConductors(e.deps);
    expect(e.exits).toEqual([]); // o relógio recomeçou quando ele voltou a terminar

    e.tick(CONDUCTOR_END_GRACE_MS / 2);
    await endFinishedConductors(e.deps);
    expect(e.exits).toEqual(["sess-feito"]); // e o que está andando, nunca
  });

  it("sonda de tmux sem resposta: não encerra ninguém (não sei quem está vivo)", async () => {
    const h = harness();
    liveConductor(h, "feito");
    h.cards.set("feito", conducted("feito", "concluida"));
    const e = ending(h, { value: { settled: true, detail: "integrado" } });
    e.deps.liveTmux = async () => null;
    await endFinishedConductors(e.deps);
    e.tick(CONDUCTOR_END_GRACE_MS * 3);
    await endFinishedConductors(e.deps);
    expect(e.exits).toEqual([]);
  });
});

describe("a fila anda pela PRIORIDADE do board (a régua da Priorização), não pela hora do aceite", () => {
  // O juiz da triagem aceita muitos cards de uma vez: a ordem de construção tem de ser a do board.
  const scored = (id: string, rank: 0 | 1 | 2 | 3, wsjf?: { value: number; urgency: number; unlock: number; size: number }): Card =>
    coerceCard(
      id,
      {
        type: "story",
        status: "pronta",
        routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" },
        priorityCall: {
          rank,
          rationale: "r",
          source: "agent",
          assessedAt: "2026-09-29",
          ...(wsjf ? { wsjf: { ...wsjf, basis: [], cohortSize: 1, cohortAt: "2026-09-29" } } : {}),
        },
      },
      "",
    );

  it("um card de prioridade MAIOR que entrou DEPOIS nasce primeiro", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    h.cards.set("cedo", scored("cedo", 1));
    h.cards.set("tarde", scored("tarde", 3));
    await admitConductorCard(h.deps, "b", "cedo");
    await admitConductorCard(h.deps, "b", "tarde");
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned.map((s) => s.cardId)).toEqual(["tarde"]);
    expect(rep.waiting.map((w) => w.cardId)).toEqual(["cedo"]);
  });

  it("tier, depois WSJF dentro do tier, avaliado antes de não-avaliado — e FIFO no empate e entre os sem nota", async () => {
    const h = harness({ config: cfg({ maxSessions: 10 }) });
    h.cards.set("a", conducted("a")); // sem nota
    h.cards.set("b", scored("b", 2)); // Alta, sem WSJF
    h.cards.set("c", conducted("c")); // sem nota
    h.cards.set("d", scored("d", 2)); // Alta, sem WSJF — empata com b
    h.cards.set("e", scored("e", 2, { value: 8, urgency: 8, unlock: 5, size: 3 })); // Alta, WSJF 7
    h.cards.set("f", scored("f", 0)); // Baixa
    for (const id of ["a", "b", "c", "d", "e", "f"]) await admitConductorCard(h.deps, "b", id);
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned.map((s) => s.cardId)).toEqual(["e", "b", "d", "f", "a", "c"]);
  });

  it("a ordem é determinística: qualquer permutação da fila sai igual, e o empate cai na hora do aceite", () => {
    const entry = (cardId: string, queuedAt: string): ConductorQueueEntry => ({ board: "b", cardId, queuedAt, attempts: 0 });
    const cards: Record<string, Card> = {
      x: scored("x", 2),
      y: scored("y", 2),
      z: conducted("z"),
      w: scored("w", 3),
    };
    const queue = [
      entry("y", "2026-09-29T10:00:05.000Z"),
      entry("z", "2026-09-29T10:00:00.000Z"),
      entry("x", "2026-09-29T10:00:01.000Z"),
      entry("w", "2026-09-29T10:00:09.000Z"),
    ];
    const order = (q: ConductorQueueEntry[]) =>
      q
        .map((e) => ({ entry: e, card: cards[e.cardId] }))
        .sort(compareConductorQueue)
        .map((x) => x.entry.cardId);
    expect(order(queue)).toEqual(["w", "x", "y", "z"]);
    expect(order([...queue].reverse())).toEqual(["w", "x", "y", "z"]);
    expect(order([queue[2], queue[0], queue[3], queue[1]])).toEqual(["w", "x", "y", "z"]);
  });
});

// Num caso real: vários terminais `agent-conductor-*` ficaram abertos por horas — condutores que terminaram a
// story, descartaram o próprio worktree (a linha do registro some com ele) e ficaram no prompt. O passe de
// encerramento só conhece quem TEM linha.
describe("endOrphanConductorTerminals — o terminal que sobrou de um condutor que já saiu do registro", () => {
  const MIN = 60_000;
  function orphanWorld(opts: { live: string[] | null; tracked?: string[]; asking?: string[]; exitOk?: boolean; sessionsFail?: boolean }) {
    let t = Date.UTC(2026, 9, 1, 12, 0);
    const exits: string[] = [];
    const kills: string[] = [];
    const lines: string[] = [];
    const state = { live: opts.live, tracked: opts.tracked ?? [] };
    const deps: ConductorOrphanDeps = {
      sessions: async () => {
        if (opts.sessionsFail) throw new Error("registro ilegível");
        return state.tracked.map((tmuxSession) => ({ tmuxSession }) as never);
      },
      liveTmux: async () => (state.live === null ? null : new Set(state.live)),
      asking: (name) => (opts.asking ?? []).includes(name),
      requestExit: async (name) => {
        if (opts.exitOk === false) return false;
        exits.push(name);
        return true;
      },
      kill: async (name) => {
        kills.push(name);
      },
      state: new Map(),
      now: () => t,
      log: (l) => lines.push(l),
    };
    return { deps, state, exits, kills, lines, tick: (ms: number) => void (t += ms) };
  }
  const ORPHAN = "agent-conductor-story-ex0143-rp5h";

  it("só nomes com a forma do condutor: a sessão do operador e o shell nunca são candidatos", () => {
    for (const n of [ORPHAN, "agent-conductor-story-ex0029-9d0y", "agent-conductor-step-checkout-a1b2"]) expect(CONDUCTOR_TMUX_NAME.test(n), n).toBe(true);
    for (const n of ["claude", "shell", "claude-jido", "agent-session-abcd", "agent-conductor-story-x", "conductor-story-x-abcd", "agent-conductor-story-x-ABCD"]) expect(CONDUCTOR_TMUX_NAME.test(n), n).toBe(false);
  });

  it("com carência: espera, pede /exit UMA vez — e só mata se o /exit não pegou", async () => {
    const w = orphanWorld({ live: [ORPHAN, "claude", "shell"] });
    await endOrphanConductorTerminals(w.deps);
    w.tick(9 * MIN);
    await endOrphanConductorTerminals(w.deps);
    expect(w.exits).toEqual([]); // ainda na carência
    w.tick(1 * MIN);
    expect(await endOrphanConductorTerminals(w.deps)).toEqual({ exited: [ORPHAN], killed: [] });
    w.tick(5 * MIN);
    await endOrphanConductorTerminals(w.deps);
    expect(w.exits).toEqual([ORPHAN]); // não pede de novo
    expect(w.kills).toEqual([]);
    w.tick(5 * MIN);
    expect(await endOrphanConductorTerminals(w.deps)).toEqual({ exited: [], killed: [ORPHAN] });
    expect(w.lines.join("\n")).toMatch(/sem sessão registrada/);
  });

  it("o /exit pegou: o terminal sumiu, ninguém é morto e a memória é esquecida", async () => {
    const w = orphanWorld({ live: [ORPHAN] });
    await endOrphanConductorTerminals(w.deps);
    w.tick(10 * MIN);
    await endOrphanConductorTerminals(w.deps);
    w.state.live = [];
    w.tick(10 * MIN);
    expect(await endOrphanConductorTerminals(w.deps)).toEqual({ exited: [], killed: [] });
    expect(w.deps.state.size).toBe(0);
  });

  it("um condutor COM linha no registro nunca é órfão — é dele que pode haver trabalho a perder", async () => {
    const w = orphanWorld({ live: [ORPHAN], tracked: [ORPHAN] });
    await endOrphanConductorTerminals(w.deps);
    w.tick(60 * MIN);
    expect(await endOrphanConductorTerminals(w.deps)).toEqual({ exited: [], killed: [] });
  });

  it("voltou a ter linha no meio da carência: a contagem recomeça do zero se ele ficar órfão de novo", async () => {
    const w = orphanWorld({ live: [ORPHAN] });
    await endOrphanConductorTerminals(w.deps);
    w.tick(9 * MIN);
    w.state.tracked = [ORPHAN];
    await endOrphanConductorTerminals(w.deps);
    w.state.tracked = [];
    w.tick(2 * MIN);
    await endOrphanConductorTerminals(w.deps);
    expect(w.exits).toEqual([]);
  });

  it("sonda que não respondeu, ou registro ilegível, não encerram ninguém", async () => {
    const noProbe = orphanWorld({ live: null });
    noProbe.tick(60 * MIN);
    expect(await endOrphanConductorTerminals(noProbe.deps)).toEqual({ exited: [], killed: [] });
    const noRegistry = orphanWorld({ live: [ORPHAN], sessionsFail: true });
    await endOrphanConductorTerminals(noRegistry.deps);
    noRegistry.tick(60 * MIN);
    expect(await endOrphanConductorTerminals(noRegistry.deps)).toEqual({ exited: [], killed: [] });
  });

  it("um prompt desenhado na tela não recebe /exit (seria respondê-lo); pane que não é do claude tenta de novo depois", async () => {
    const asking = orphanWorld({ live: [ORPHAN], asking: [ORPHAN] });
    await endOrphanConductorTerminals(asking.deps);
    asking.tick(30 * MIN);
    expect(await endOrphanConductorTerminals(asking.deps)).toEqual({ exited: [], killed: [] });
    const notClaude = orphanWorld({ live: [ORPHAN], exitOk: false });
    await endOrphanConductorTerminals(notClaude.deps);
    notClaude.tick(30 * MIN);
    expect(await endOrphanConductorTerminals(notClaude.deps)).toEqual({ exited: [], killed: [] });
    expect(notClaude.kills).toEqual([]); // sem /exit entregue não há prazo de morte correndo
  });
});

// WP5-F1 — a fila do condutor nunca dropa em SILÊNCIO um card que não leu. Caso real: o merge train
// apagou cards aceitos na triagem e a fila os tirou com uma linha de journal («card não existe mais»), sem registro.
describe("pump — card que não veio: não lido FICA; lixeira sai; sumiço vira decisão do sistema", () => {
  const entry = (cardId: string): ConductorQueueEntry => ({ board: "b", cardId, queuedAt: "2026-03-05T09:12:30.000Z", attempts: 0 });

  it("readCard que LANÇA: a entrada fica na fila (espera com motivo), nada é registrado como sumido", async () => {
    const h = harness();
    const recorded: string[] = [];
    h.deps.readCard = async () => {
      throw new Error("EMFILE: too many open files");
    };
    h.deps.explainMissingCard = async () => ({ kind: "missing", lastHop: null });
    h.deps.recordCardMissing = async (e) => void recorded.push(e.cardId);
    await h.queue.persist([entry("story-x")]);

    const r = await pumpConductorQueue(h.deps);

    expect(r.dropped).toEqual([]);
    expect(h.queue.entries).toHaveLength(1);
    expect(h.queue.entries[0]).toMatchObject({ cardId: "story-x", lastWaitKind: "card-unreadable" });
    expect(h.queue.entries[0].lastWaitReason).toContain("EMFILE");
    expect(recorded).toEqual([]);
    expect(h.spawns).toEqual([]);
  });

  it("arquivo existe mas não foi lido (unreadable): a entrada fica", async () => {
    const h = harness();
    h.deps.explainMissingCard = async () => ({ kind: "unreadable", detail: "recusado pelo chokepoint" });
    await h.queue.persist([entry("story-y")]);
    const r = await pumpConductorQueue(h.deps);
    expect(r.dropped).toEqual([]);
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["story-y"]);
  });

  it("explicação que LANÇA conta como não lido: a entrada fica", async () => {
    const h = harness();
    h.deps.explainMissingCard = async () => {
      throw new Error("EIO");
    };
    await h.queue.persist([entry("story-y")]);
    await pumpConductorQueue(h.deps);
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["story-y"]);
  });

  it("card na lixeira: sai da fila sem registro de sumiço (quem apagou decidiu)", async () => {
    const h = harness();
    const recorded: string[] = [];
    h.deps.explainMissingCard = async () => ({ kind: "trashed" });
    h.deps.recordCardMissing = async (e) => void recorded.push(e.cardId);
    await h.queue.persist([entry("story-t")]);
    const r = await pumpConductorQueue(h.deps);
    expect(r.dropped).toEqual([{ board: "b", cardId: "story-t", reason: "o card foi para a lixeira" }]);
    expect(recorded).toEqual([]);
    expect(h.queue.entries).toEqual([]);
  });

  it("ENOENT confirmado fora da lixeira: registra card-missing UMA vez (com o último salto do ledger) e sai", async () => {
    const h = harness();
    const recorded: Array<{ cardId: string; miss: QueuedCardMiss }> = [];
    const miss: QueuedCardMiss = { kind: "missing", lastHop: { from: "triagem", to: "interview", at: "2026-03-05T09:12:30Z" } };
    h.deps.explainMissingCard = async () => miss;
    h.deps.recordCardMissing = async (e, m) => void recorded.push({ cardId: e.cardId, miss: m });
    await h.queue.persist([entry("story-ex0154")]);

    const r = await pumpConductorQueue(h.deps);
    await pumpConductorQueue(h.deps); // a segunda passada não tem mais a entrada: nada a registrar de novo

    expect(recorded).toEqual([{ cardId: "story-ex0154", miss }]);
    expect(r.dropped[0]).toMatchObject({ cardId: "story-ex0154" });
    expect(r.dropped[0].reason).toContain("card-missing");
    expect(h.queue.entries).toEqual([]);
  });

  it("um card sumido não segura os outros: a entrada seguinte nasce na mesma passada", async () => {
    const h = harness();
    h.cards.set("story-ok", conducted("story-ok"));
    h.deps.explainMissingCard = async () => ({ kind: "missing", lastHop: null });
    h.deps.recordCardMissing = async () => {};
    await h.queue.persist([entry("story-gone"), entry("story-ok")]);
    const r = await pumpConductorQueue(h.deps);
    expect(r.spawned.map((x) => x.cardId)).toEqual(["story-ok"]);
  });

  it("cardMissingDecision (pura): kind card-missing, do sistema, com a fila e o ledger no porquê, sem «Desfazer»", () => {
    const d = cardMissingDecision(entry("story-ex0039"), { kind: "missing", lastHop: { from: null, to: "triagem", at: "2026-03-05T09:12:10Z" } }, "2026-03-05T11:02:44Z", "sd-1");
    expect(d).toMatchObject({ v: 1, id: "sd-1", at: "2026-03-05T11:02:44Z", board: "b", cardId: "story-ex0039", agent: "system", kind: "card-missing" });
    expect(d.why).toContain("2026-03-05T09:12:30.000Z");
    expect(d.why).toContain("— → triagem");
    expect(d.undo).toBeUndefined();
  });
});

// ── WP5-F2: orquestração honesta ─────────────────────────────────────────────────────────────────────────────────

describe("o tmux ZUMBI não segura vaga (o terminal com cwd «(deleted)» contava como uma das vagas)", () => {
  const row = (id: string, over: Partial<AgentSession> = {}): AgentSession =>
    ({ sessionId: id, agentId: id, role: "implement", board: "b", cardId: id, task: "t", driver: "conductor", tmuxSession: `agent-${id}`, worktreePath: `/w/${id}`, openedAt: "", heartbeatAt: "", ...over }) as AgentSession;
  const gone = new Set(["/w/zumbi"]);
  const treeGone = (s: AgentSession) => gone.has(s.worktreePath ?? "");

  it("árvore apagada ⇒ não é condutor vivo, nem com o tmux respondendo, nem com a sonda cega", () => {
    expect(isLiveConductor(row("zumbi"), new Set(["agent-zumbi"]), () => true, treeGone)).toBe(false);
    expect(isLiveConductor(row("zumbi"), null, () => true, treeGone)).toBe(false);
    expect(isLiveConductor(row("ok"), new Set(["agent-ok"]), () => true, treeGone)).toBe(true);
    // sem a prova (dep ausente) ninguém é zumbi — o comportamento de antes
    expect(isLiveConductor(row("zumbi"), new Set(["agent-zumbi"]), () => true)).toBe(true);
  });

  it("no pump: o zumbi não ocupa vaga, e o card da fila nasce", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    h.sessions.push(row("zumbi"));
    h.live.add("agent-zumbi");
    h.deps.treeGone = treeGone;
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    expect((await pumpConductorQueue(h.deps)).spawned.map((x) => x.cardId)).toEqual(["s1"]);
  });
});

describe("a espera grava o MOTIVO REAL (vários cards «esperando uma vaga» e a vaga extra fechada pelo processador, sem rastro)", () => {
  it("vaga extra fechada: a classe diz QUAL trava e o texto traz o porquê", async () => {
    const h = harness();
    h.deps.extraSlot = async () => ({ open: false, why: "processador em 4.5 (a vaga extra pede abaixo de 3.0)", lock: "load" });
    for (const id of ["s1", "s2", "s3"]) {
      h.cards.set(id, conducted(id));
      await admitConductorCard(h.deps, "b", id);
    }
    await pumpConductorQueue(h.deps);
    expect(h.queue.entries[0]).toMatchObject({
      cardId: "s3",
      lastWaitKind: "slots:extra-closed:load",
      lastWaitReason: "2 condutor(es) vivo(s) no board — esperando uma vaga (vaga extra fechada: processador em 4.5 (a vaga extra pede abaixo de 3.0))",
    });
    expect(isSlotWait(h.queue.entries[0].lastWaitKind)).toBe(true);
  });

  it("sem dep ou sem trava nomeada, a classe segue «slots»; outras esperas não são de vaga", () => {
    expect(slotWait(2, null)).toEqual({ reason: "2 condutor(es) vivo(s) no board — esperando uma vaga", kind: "slots" });
    expect(slotWait(2, { open: false, why: "x" }).kind).toBe("slots");
    expect(isSlotWait("slots")).toBe(true);
    for (const k of ["budget", "account:latch", "box-full", undefined]) expect(isSlotWait(k)).toBe(false);
  });
});

describe("conductorSlotFacts — as vagas do board para o nav, a MESMA conta do pump", () => {
  const row = (id: string, board = "b"): AgentSession => ({ sessionId: id, agentId: id, role: "implement", board, cardId: id, task: "t", driver: "conductor", tmuxSession: `agent-${id}`, openedAt: "", heartbeatAt: "" }) as AgentSession;
  const q = (cardId: string, kind?: string, board = "b"): ConductorQueueEntry => ({ board, cardId, queuedAt: "2026-10-01T18:00:00Z", attempts: 0, ...(kind ? { lastWaitKind: kind } : {}) });
  it("usados = vivos do board menos quem terminou a story; fila e quem espera vaga; a vaga extra com o porquê", () => {
    const facts = conductorSlotFacts("b", {
      config: cfg({ maxSessions: 2 }),
      liveConductors: [row("a"), row("c"), row("x", "outro")],
      finished: new Set(["c"]),
      queue: [q("q1", "slots"), q("q2", "slots:extra-closed:load"), q("q3", "budget"), q("q4", "slots", "outro")],
      extra: { open: false, why: "processador em 4.5" },
    });
    expect(facts).toEqual({ board: "b", used: 1, max: 2, extra: { open: false, why: "processador em 4.5" }, queued: 3, waitingForSlot: 2 });
  });
  it("condutor desligado no board ⇒ max 0; vaga extra não medida é dita", () => {
    expect(conductorSlotFacts("b", { config: cfg(null), liveConductors: [], queue: [], extra: null })).toMatchObject({ used: 0, max: 0, extra: { open: false, why: expect.stringMatching(/não foi medida/) } });
  });
});

describe("a fila sem priorityCall usa a SEVERIDADE do bug (um bug ALTO esperava horas atrás de um bug baixo mais antigo)", () => {
  const bug = (id: string, severity: string, extra: Record<string, unknown> = {}): Card =>
    coerceCard(id, { type: "story", storyType: "bug", status: "pronta", routing: { skips: [], decidedBy: "rules", decidedAt: "2026-10-01", driver: "conductor" }, bugReport: { brief: "b", severity, expected: null, actual: null, steps: [], target: null, screenshot: null, openedAt: null }, ...extra }, "");
  const entry = (cardId: string, queuedAt: string, resume = false): ConductorQueueEntry => ({ board: "b", cardId, queuedAt, attempts: 0, ...(resume ? { resume: true as const } : {}) });
  const order = (items: Array<[ConductorQueueEntry, Card | null]>) => items.map(([e, card]) => ({ entry: e, card })).sort(compareConductorQueue).map((x) => x.entry.cardId);

  it("o tier derivado: bloqueante 3, alta 2, média 1, baixa 0; +1 com rótulo de segurança/dados de pessoas (teto 3)", () => {
    expect(derivedQueueTier(bug("a", "blocker"))).toBe(3);
    expect(derivedQueueTier(bug("a", "high"))).toBe(2);
    expect(derivedQueueTier(bug("a", "medium", { labels: ["LGPD"] }))).toBe(2);
    expect(derivedQueueTier(bug("a", "high", { labels: ["security"] }))).toBe(3);
    expect(derivedQueueTier(bug("a", "blocker", { labels: ["segurança"] }))).toBe(3);
    expect(derivedQueueTier(coerceCard("u", { type: "story", labels: ["privacidade"] }, ""))).toBe(1);
    expect(derivedQueueTier(conducted("u"))).toBeNull();
  });

  it("bug alto (sem priorityCall) passa à frente de bug baixo mais antigo — e de história sem nota", () => {
    expect(
      order([
        [entry("bug-baixo", "2026-10-01T19:11:54Z"), bug("bug-baixo", "low")],
        [entry("historia", "2026-10-01T18:00:00Z"), conducted("historia")],
        [entry("bug-alto", "2026-10-01T19:43:10Z"), bug("bug-alto", "high")],
      ]),
    ).toEqual(["bug-alto", "bug-baixo", "historia"]);
  });

  it("o priorityCall explícito do card manda sobre a severidade derivada; no empate de tier, o explícito vem antes", () => {
    const withCall = (id: string, rank: 0 | 1 | 2 | 3, severity: string) => ({ ...bug(id, severity), priorityCall: { rank, rationale: "r", source: "agent", assessedAt: "2026-10-01" } }) as Card;
    // bug alto com chamada «Baixa»: a chamada vale (tier 0), e o bug médio sem chamada (tier 1) vem antes
    expect(order([[entry("alto-baixa", "2026-10-01T10:00:00Z"), withCall("alto-baixa", 0, "high")], [entry("medio", "2026-10-01T11:00:00Z"), bug("medio", "medium")]])).toEqual(["medio", "alto-baixa"]);
    // mesmo tier 2: a chamada explícita antes da severidade derivada, mesmo chegando depois
    expect(order([[entry("derivado", "2026-10-01T10:00:00Z"), bug("derivado", "high")], [entry("explicito", "2026-10-01T12:00:00Z"), withCall("explicito", 2, "low")]])).toEqual(["explicito", "derivado"]);
  });

  it("a retomada continua na frente de tudo", () => {
    expect(order([[entry("critico", "2026-10-01T10:00:00Z"), bug("critico", "blocker")], [entry("retomada", "2026-10-01T12:00:00Z", true), conducted("retomada")]])).toEqual(["retomada", "critico"]);
  });

  // Revisão do WP5-F2: o card estacionado por QUIETUDE voltava com o tier dele e reconquistava a vaga que acabou de
  // liberar — os cards cuja espera justificou o estacionar continuavam esperando, e o ciclo de 20 min se repetia.
  it("a entrada que CEDEU a vaga (estacionou por quietude) vai depois das que esperavam, qualquer tier; a retomada segue na frente", () => {
    const yielded = (cardId: string, queuedAt: string): ConductorQueueEntry => ({ ...entry(cardId, queuedAt), yielded: true });
    expect(
      order([
        [yielded("alto", "2026-10-01T20:30:00Z"), bug("alto", "high")],
        [entry("baixo-1", "2026-10-01T19:00:00Z"), bug("baixo-1", "low")],
        [entry("historia", "2026-10-01T18:00:00Z"), conducted("historia")],
      ]),
    ).toEqual(["baixo-1", "historia", "alto"]);
    expect(order([[yielded("alto", "2026-10-01T20:30:00Z"), bug("alto", "high")], [entry("retomada", "2026-10-01T21:00:00Z", true), conducted("retomada")]])).toEqual(["retomada", "alto"]);
  });

  it("estacionar por quietude com waiter de tier menor ⇒ o waiter ganha a vaga liberada; servida a vez dele, o card volta ao seu tier", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    h.cards.set("baixo", bug("baixo", "low"));
    h.cards.set("medio", bug("medio", "medium"));
    h.cards.set("alto", bug("alto", "high"));
    await admitConductorCard(h.deps, "b", "baixo");
    await admitConductorCard(h.deps, "b", "medio");
    // o condutor de «alto» estacionou por quietude e saiu: a vaga está livre, e ele volta CEDENDO a vez
    await admitConductorCard(h.deps, "b", "alto", { yielded: true });
    expect(h.queue.entries.find((e) => e.cardId === "alto")?.yielded).toBe(true);
    const first = await pumpConductorQueue(h.deps);
    expect(first.spawned.map((s) => s.cardId)).toEqual(["medio"]);
    // a vez foi servida: «alto» perde a marca e, na próxima vaga, passa à frente de «baixo» pelo tier
    expect(h.queue.entries.find((e) => e.cardId === "alto")?.yielded).toBeUndefined();
    h.live.clear();
    const second = await pumpConductorQueue(h.deps);
    expect(second.spawned.map((s) => s.cardId)).toEqual(["alto"]);
  });
});

describe("o pump admite os ÓRFÃOS de fromStatus (cards em «Moldando» sem driver, sem fila, sem ninguém)", () => {
  const plain = (id: string, status = "pronta", extra: Record<string, unknown> = {}): Card => coerceCard(id, { type: "story", status, ...extra }, "");
  const withOrphans = (h: Harness, cards: Card[], over: Partial<BoardConfig> = {}) => {
    for (const c of cards) h.cards.set(c.id, c);
    h.deps.orphanCandidates = async () => [{ board: "b", config: { ...h.config.value, ...over }, cards: [...h.cards.values()] }];
  };

  it("a régua é a da entrada: story em fromStatus, sem driver; fora do status, com driver, ou contêiner ⇒ não", () => {
    const c = cfg();
    expect(isConductorOrphan(plain("o1"), c)).toBe(true);
    expect(isConductorOrphan(plain("o2", "desenvolver"), c)).toBe(false);
    expect(isConductorOrphan(conducted("o3"), c)).toBe(false); // condutor que morreu: é do operador, nunca reaberto em laço
    expect(isConductorOrphan(plain("o4", "pronta", { capture: true }), c)).toBe(false);
    expect(isConductorOrphan(plain("o5"), cfg(null))).toBe(false);
  });

  it("admite UMA vez: driver + fila; a passada seguinte não duplica, e o card nasce condutor na vaga", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    withOrphans(h, [plain("orfao")]);
    const first = await pumpConductorQueue(h.deps);
    expect(first.adopted).toEqual([{ board: "b", cardId: "orfao" }]);
    expect(h.marked).toEqual(["orfao"]);
    expect(first.spawned.map((x) => x.cardId)).toEqual(["orfao"]);
    const second = await pumpConductorQueue(h.deps);
    expect(second.adopted).toEqual([]);
    expect(h.marked).toEqual(["orfao"]);
  });

  it("idempotente com a fila e com a sessão viva: card já na fila não entra de novo; o que tem condutor vivo não é órfão", async () => {
    const h = harness({ config: cfg({ maxSessions: 1 }) });
    h.cards.set("vivo", conducted("vivo"));
    await admitConductorCard(h.deps, "b", "vivo");
    await pumpConductorQueue(h.deps); // nasce o condutor de «vivo» — a vaga fica cheia
    withOrphans(h, [plain("espera")]);
    await pumpConductorQueue(h.deps);
    await pumpConductorQueue(h.deps);
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["espera"]);
    expect(h.marked.filter((x) => x === "espera")).toHaveLength(1);
  });

  it("autorun desligado (master ou board desarmado) não admite nada — a entrada também não admitiria", async () => {
    const off = harness();
    withOrphans(off, [plain("o1")]);
    off.master.on = false;
    expect((await pumpConductorQueue(off.deps)).adopted).toEqual([]);
    const disarmed = harness();
    withOrphans(disarmed, [plain("o1")], { autorunDisabled: true });
    expect((await pumpConductorQueue(disarmed.deps)).adopted).toEqual([]);
    expect([...off.marked, ...disarmed.marked]).toEqual([]);
  });

  // Revisão do WP5-F2: a adoção só olhava driver e fila. O operador trabalhando um card em fromStatus numa sessão sem
  // driver de condutor ganhava `routing.driver: conductor`; o spawn esbarrava no claim da sessão dele, a entrada saía da
  // fila e o driver ficava — o card virava «conduzido» sem condutor, e nenhuma skill de coluna rodava mais nele.
  const operatorSession = (cardId: string, tmux: string, over: Partial<AgentSession> = {}): AgentSession => ({
    sessionId: `op-${cardId}`,
    agentId: `op-${cardId}`,
    role: "implement",
    board: "b",
    cardId,
    task: "trabalho do operador",
    tmuxSession: tmux,
    openedAt: "2026-10-01T20:00:00Z",
    heartbeatAt: "2026-10-01T20:00:00Z",
    ...over,
  });

  it("card com alguém nele não é órfão: sessão viva de qualquer driver, claim, run do engine ou merge em voo ⇒ não adotado e sem driver", async () => {
    const h = harness();
    withOrphans(h, [plain("operador"), plain("reservado"), plain("livre")]);
    h.sessions.push(operatorSession("operador", "agent-op")); // a sessão interativa do operador, sem driver
    h.live.add("agent-op");
    h.deps.cardInFlight = async (_b, cardId) => cardId === "reservado"; // claim / run / merge do card
    const r = await pumpConductorQueue(h.deps);
    expect(r.adopted).toEqual([{ board: "b", cardId: "livre" }]);
    expect(h.marked).toEqual(["livre"]);
    expect(h.queue.entries.map((e) => e.cardId)).not.toContain("operador");
  });

  it("a linha MORTA no registro não segura o card: sem tmux vivo, o órfão é adotado", async () => {
    const h = harness();
    withOrphans(h, [plain("abandonado")]);
    h.sessions.push(operatorSession("abandonado", "agent-morto"));
    expect((await pumpConductorQueue(h.deps)).adopted).toEqual([{ board: "b", cardId: "abandonado" }]);
  });

  it("sem saber quem está nos cards nada é adotado (adotar MUDA o card): registro ilegível, ou a sonda do card lança", async () => {
    const noRegistry = harness();
    withOrphans(noRegistry, [plain("o1")]);
    noRegistry.deps.sessions = async () => {
      throw new Error("registro ilegível");
    };
    expect((await pumpConductorQueue(noRegistry.deps)).adopted).toEqual([]);
    const noProbe = harness();
    withOrphans(noProbe, [plain("o1")]);
    noProbe.deps.cardInFlight = async () => {
      throw new Error("claims ilegível");
    };
    expect((await pumpConductorQueue(noProbe.deps)).adopted).toEqual([]);
    // a sonda do tmux sem resposta: toda linha com tmux conta como viva (a direção segura)
    const noTmux = harness();
    withOrphans(noTmux, [plain("o1"), plain("o2")]);
    noTmux.sessions.push(operatorSession("o1", "agent-op"));
    noTmux.deps.liveTmux = async () => null;
    expect((await pumpConductorQueue(noTmux.deps)).adopted).toEqual([{ board: "b", cardId: "o2" }]);
    expect([...noRegistry.marked, ...noProbe.marked]).toEqual([]);
  });

  it("o driver que não gravou deixa o card fora da fila (tenta na próxima varredura) — nunca fila sem driver", async () => {
    const h = harness();
    withOrphans(h, [plain("o1")]);
    h.deps.markDriver = async () => {
      throw new Error("lock ocupado");
    };
    expect((await pumpConductorQueue(h.deps)).adopted).toEqual([]);
    expect(h.queue.entries).toEqual([]);
  });
});

// ── O RITMO DO BOARD (board-pace.ts) na fila do condutor ───────────────────────────────────────────
describe("ritmo do board — a fila do condutor espera na pausa e anda um por vez em devagar", () => {
  const at = "2026-10-02T12:00:00.000Z";
  const NOW = Date.parse(at) + 1000;
  const paceGate = (h: Harness, row: { value: BoardPaceRow | null }) => {
    h.deps.boardGate = (_board, config) => resolveBoardGate(config, row.value, NOW);
  };
  const plain = (id: string): Card => coerceCard(id, { type: "story", status: "pronta" }, "");

  it("PAUSADO: nada nasce, a fila espera com o motivo e a classe «board-paused»; retomado, anda sozinha", async () => {
    const h = harness();
    const row = { value: { board: "b", agent: { level: "paused", by: { kind: "agent" }, at } } as BoardPaceRow | null };
    paceGate(h, row);
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned).toEqual([]);
    expect(rep.waiting).toEqual([{ board: "b", cardId: "s1", reason: "board pausado por um agente — a fila espera" }]);
    expect(h.queue.entries.map((e) => [e.cardId, e.lastWaitKind])).toEqual([["s1", "board-paused"]]);
    row.value = null; // retomado
    expect((await pumpConductorQueue(h.deps)).spawned.map((x) => x.cardId)).toEqual(["s1"]);
  });

  it("PAUSADO: órfão não é adotado (adotar marca o card — e ninguém viria buscá-lo)", async () => {
    const h = harness();
    paceGate(h, { value: { board: "b", owner: { level: "paused", by: { kind: "owner" }, at } } });
    h.cards.set("o1", plain("o1"));
    h.deps.orphanCandidates = async () => [{ board: "b", config: h.config.value, cards: [...h.cards.values()] }];
    expect((await pumpConductorQueue(h.deps)).adopted).toEqual([]);
    expect(h.marked).toEqual([]);
  });

  it("DEVAGAR: um condutor por vez, e a vaga extra NÃO abre — nem com a máquina folgada", async () => {
    const h = harness();
    paceGate(h, { value: { board: "b", owner: { level: "slow", by: { kind: "owner" }, at } } });
    let asked = 0;
    h.deps.extraSlot = async () => {
      asked += 1;
      return { open: true, why: "máquina folgada" };
    };
    for (const id of ["s1", "s2"]) {
      h.cards.set(id, conducted(id));
      await admitConductorCard(h.deps, "b", id);
    }
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned.map((x) => x.cardId)).toEqual(["s1"]);
    expect(rep.waiting[0]).toMatchObject({ cardId: "s2", reason: expect.stringContaining("ritmo devagar") });
    expect(h.queue.entries.map((e) => e.lastWaitKind)).toEqual(["slots:extra-closed:pace"]);
    expect(asked).toBe(0); // o ritmo é a decisão de gastar menos: a sonda da vaga extra nem é consultada
  });

  it("as vagas que o nav mostra seguem o MESMO teto do pump: devagar = uma, sem extra; pausado = nenhuma", () => {
    const base = { config: cfg(), liveConductors: [], queue: [], extra: { open: true, why: "máquina folgada" } };
    expect(conductorSlotFacts("b", base)).toMatchObject({ max: 2, extra: { open: true } });
    const slow = resolveBoardGate({}, { board: "b", owner: { level: "slow", by: { kind: "owner" }, at } }, NOW);
    expect(conductorSlotFacts("b", { ...base, gate: slow })).toMatchObject({ max: 1, extra: { open: false, why: "o board está em ritmo devagar (um card por vez)" } });
    const paused = resolveBoardGate({}, { board: "b", agent: { level: "paused", by: { kind: "agent" }, at } }, NOW);
    expect(conductorSlotFacts("b", { ...base, gate: paused })).toMatchObject({ max: 0, extra: { open: false, why: "board pausado por um agente" } });
    expect(conductorSlotFacts("b", { ...base, gate: resolveBoardGate({}, null, NOW) })).toMatchObject({ max: 2, extra: { open: true } });
  });

  it("sem a porta de ritmo, só a configuração responde: desarmado espera como sempre", async () => {
    const h = harness({ config: { ...cfg(), autorunDisabled: true } });
    h.cards.set("s1", conducted("s1"));
    await admitConductorCard(h.deps, "b", "s1");
    const rep = await pumpConductorQueue(h.deps);
    expect(rep.spawned).toEqual([]);
    expect(h.queue.entries.map((e) => e.lastWaitKind)).toEqual(["autorun-off"]);
  });
});
