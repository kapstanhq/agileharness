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
  admitConductorCard,
  CONDUCTOR_MAX_SPAWN_ATTEMPTS,
  isLiveConductor,
  memoryConductorQueueStore,
  pumpConductorQueue,
  type ConductorDeps,
} from "./conductor";
import type { AgentSession } from "./session-worktree";
import type { SpawnSessionInput, SpawnSessionResult } from "./session-spawn";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { coerceCard } from "@/lib/storymap/repo";

const statuses = [
  { id: "pronta", name: "Pronta", autorun: false },
  { id: "desenvolver", name: "Dev", trigger: "harness-do" as const, autorun: true },
  { id: "concluida", name: "No ar", terminal: true },
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
      if (c) cards.set(id, { ...c, routing: { skips: [], decidedBy: "rules", decidedAt: "x", driver: "conductor" } });
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
    log: () => {},
  };
  return { deps, queue, spawns, sessions, live, cards, marked, cleared, findings, config, master };
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
      name: "conductor-s1",
    });
    expect(h.queue.entries).toHaveLength(0);
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
