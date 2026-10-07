// O LOTE DO CONDUTOR — as operações sobre IO injetado (runner/conductor-batch-ops.ts). Fixtures inventadas.
//
// O que cada teste trava, com o defeito que ele evita:
//   • claim_batch tudo ou nada — um claim que falha no meio não deixa itens presos à sessão;
//   • a recusa de história, de outra funcionalidade, de item solo e de item com dono;
//   • os itens saem da fila, ganham a marca do lote e entram na linha da sessão;
//   • a CORRIDA com o pump: claim_batch e batch_drop intercalados com uma passada não perdem nem duplicam entrada da
//     fila (a passada grava a cópia dela no fim — fora da trava, a mudança da tool sumia);
//   • batch_drop: o item volta à fila sozinho (`solo`), com o achado; o líder não sai por aqui;
//   • o líder que saiu devolve os itens à fila normal; a divisão do train devolve-os sozinhos.

import { describe, expect, it } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { FeatureKey } from "@/lib/storymap/feature-key";
import type { BoardConfig, Card, CardBatchMark, Finding } from "@/lib/storymap/types";
import { sessionClaimActor, type CardClaim } from "./claims";
import { memoryConductorQueueStore, pumpConductorQueue, withConductorDispatchLock, type ConductorDeps, type ConductorQueueEntry } from "./conductor";
import { BATCH_DROPPED_FINDING_ID, claimBatch, clearBatchMarks, dropBatchItem, releaseBatchItems, splitBatch, type BatchOpsDeps } from "./conductor-batch-ops";
import type { AgentSession, SessionBatch } from "./session-worktree";
import type { SpawnSessionResult } from "./session-spawn";

const routing = { skips: [], decidedBy: "rules" as const, decidedAt: "2026-10-01", driver: "conductor" as const };
const bug = (id: string, extra: Record<string, unknown> = {}): Card => coerceCard(id, { type: "story", storyType: "bug", status: "pronta", routing, ...extra }, "");
const story = (id: string): Card => coerceCard(id, { type: "story", storyType: "user", status: "pronta", routing }, "");

const LEAD = "story-ex9201";
const statuses = [
  { id: "pronta", name: "Pronta", autorun: false },
  { id: "desenvolver", name: "Dev", trigger: "harness-do" as const, autorun: true },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
];
const config: BoardConfig = { id: "b", name: "B", statuses, releases: [], personas: [], systems: [], linkTypes: [], conductor: { enabled: true, fromStatus: "pronta", maxSessions: 2 } };

const keyA: FeatureKey = { id: "busca-no-catalogo", title: "Busca no catálogo", self: false, source: "prd" };
const keyB: FeatureKey = { id: "lista-de-desejos", title: "Lista de desejos", self: false, source: "prd" };

function harness(opts: { keys?: Record<string, FeatureKey>; failClaimOn?: string } = {}) {
  const fail = { sessionWrite: false, queueWrite: false };
  const cards = new Map<string, Card>();
  const claims: CardClaim[] = [];
  const session: AgentSession = {
    sessionId: "sess-lead-0001",
    agentId: "agent-lead",
    role: "implement",
    board: "b",
    cardId: LEAD,
    task: "/harness-conductor b/" + LEAD,
    driver: "conductor",
    tmuxSession: "agent-conductor-lead",
    openedAt: "2026-10-01T00:00:00Z",
    heartbeatAt: "2026-10-01T00:00:00Z",
  };
  const sessions: AgentSession[] = [session];
  const queue = memoryConductorQueueStore();
  const marks: Array<{ cardId: string; mark: CardBatchMark | null; finding?: Finding }> = [];
  const now = Date.parse("2026-10-01T01:00:00Z");
  const claim = (cardId: string, actor: string): CardClaim => ({
    board: "b",
    cardId,
    actor,
    kind: "implement",
    scope: "both",
    acquiredAt: "2026-10-01T00:00:00Z",
    expiresAt: "2026-10-01T05:00:00Z",
    heartbeatAt: "2026-10-01T00:00:00Z",
  });
  claims.push(claim(LEAD, sessionClaimActor(session.agentId)));
  cards.set(LEAD, bug(LEAD));
  const deps: BatchOpsDeps = {
    sessions: async () => sessions,
    readCard: async (_b, id) => cards.get(id) ?? null,
    readBoardConfig: async () => config,
    featureKeyOf: async (_b, c) => opts.keys?.[c.id] ?? keyA,
    queue,
    withDispatchLock: withConductorDispatchLock,
    claims: {
      acquire: async (req) => {
        if (req.cardId === opts.failClaimOn) return { ok: false, holder: claim(req.cardId, "run:alheio") };
        const held = claims.find((c) => c.cardId === req.cardId && c.actor !== req.actor);
        if (held) return { ok: false, holder: held };
        const c = claim(req.cardId, req.actor);
        claims.push(c);
        return { ok: true, claim: c };
      },
      release: async (_b, cardId, actor) => {
        const i = claims.findIndex((c) => c.cardId === cardId && c.actor === actor);
        if (i >= 0) claims.splice(i, 1);
      },
      list: async () => claims,
    },
    admittedByScope: () => true,
    settingsCapUSD: () => 30,
    ledgerUSD: async () => 0,
    sessionCostUSD: async () => 0,
    writeBatchMark: async (_b, cardId, mark, finding) => {
      marks.push({ cardId, mark, finding });
      const c = cards.get(cardId);
      if (c) {
        const next = { ...c };
        if (mark) next.batch = mark;
        else delete next.batch;
        if (finding) next.findings = [...(c.findings ?? []), finding];
        cards.set(cardId, next);
      }
    },
    setSessionBatch: async (id, batch: SessionBatch | undefined) => {
      if (fail.sessionWrite) throw new Error("registro de sessões indisponível");
      const s = sessions.find((x) => x.sessionId === id);
      if (s) s.batch = batch;
    },
    now: () => now,
    log: () => {},
  };
  const enqueue = async (...ids: string[]) => {
    for (const id of ids) {
      if (!cards.has(id)) cards.set(id, bug(id));
    }
    await queue.persist([...(await queue.load()), ...ids.map((cardId): ConductorQueueEntry => ({ board: "b", cardId, queuedAt: "2026-10-01T00:00:00Z", attempts: 0 }))]);
  };
  return { deps, cards, claims, session, sessions, queue, marks, enqueue, fail };
}

describe("claimBatch — tudo ou nada, sob a trava do despacho", () => {
  it("pega os itens: claims da sessão, fora da fila, marca no líder e nos itens, lote na sessão", async () => {
    const h = harness();
    await h.enqueue("story-ex9202", "story-ex9203", "story-ex9204");
    const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202", "story-ex9203"] });
    expect(res).toMatchObject({ ok: true, lead: LEAD, cardIds: [LEAD, "story-ex9202", "story-ex9203"], capUSD: 30 });
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["story-ex9204"]);
    const actor = sessionClaimActor("agent-lead");
    expect(h.claims.filter((c) => c.actor === actor).map((c) => c.cardId).sort()).toEqual([LEAD, "story-ex9202", "story-ex9203"]);
    for (const id of [LEAD, "story-ex9202", "story-ex9203"]) expect(h.cards.get(id)?.batch).toMatchObject({ id: "lote-sess-lea", lead: LEAD, sessionId: h.session.sessionId });
    expect(h.session.batch).toEqual({ id: "lote-sess-lea", featureKey: "busca-no-catalogo", cardIds: ["story-ex9202", "story-ex9203"], dropped: [] });
  });

  it("recusa história, outra funcionalidade, item solo e item com dono — sem mexer em nada", async () => {
    const cases: Array<{ name: string; prep: (h: ReturnType<typeof harness>) => Promise<void>; reason: string }> = [
      { name: "história", prep: async (h) => { h.cards.set("story-ex9202", story("story-ex9202")); }, reason: "not-batchable" },
      { name: "solo", prep: async (h) => { await h.queue.persist(h.queue.entries.map((e) => ({ ...e, solo: true as const }))); }, reason: "solo" },
      { name: "com dono", prep: async (h) => { h.claims.push({ ...h.claims[0], cardId: "story-ex9202", actor: "session:outra" }); }, reason: "claimed" },
    ];
    for (const c of cases) {
      const h = harness();
      await h.enqueue("story-ex9202");
      await c.prep(h);
      const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
      expect(res.ok, c.name).toBe(false);
      if (!res.ok) expect(res.refusals?.map((r) => r.reason), c.name).toContain(c.reason);
      expect(h.queue.entries.map((e) => e.cardId), c.name).toEqual(["story-ex9202"]);
      expect(h.marks, c.name).toEqual([]);
    }
    const h = harness({ keys: { "story-ex9202": keyB } });
    await h.enqueue("story-ex9202");
    const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusals?.[0]?.reason).toBe("other-feature");
  });

  it("um claim que falha no meio solta os já pegos e não tira ninguém da fila", async () => {
    const h = harness({ failClaimOn: "story-ex9203" });
    await h.enqueue("story-ex9202", "story-ex9203");
    const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202", "story-ex9203"] });
    expect(res.ok).toBe(false);
    expect(h.claims.map((c) => c.cardId)).toEqual([LEAD]);
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["story-ex9202", "story-ex9203"]);
    expect(h.session.batch).toBeUndefined();
  });

  it("só a sessão dona do líder pega lote; lote fechado (plano submetido) recusa", async () => {
    const h = harness();
    await h.enqueue("story-ex9202");
    expect((await claimBatch(h.deps, { sessionId: "nao-existe", board: "b", cardIds: ["story-ex9202"] })).ok).toBe(false);
    h.claims.splice(0, 1); // sem o claim do líder
    expect((await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] })).ok).toBe(false);
    const h2 = harness();
    await h2.enqueue("story-ex9202");
    h2.session.batch = { id: "lote-x", featureKey: "busca-no-catalogo", cardIds: [], dropped: [], closed: true };
    const res = await claimBatch(h2.deps, { sessionId: h2.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.refusals?.[0]?.reason).toBe("closed");
  });

  it("a retomada re-pega os itens do lote anterior do líder e mantém o plano congelado", async () => {
    const h = harness();
    const old = { id: "lote-old", lead: LEAD, sessionId: "sess-old", at: "2026-09-30T00:00:00Z", planHash: "abcdef0123456789.a1b2c3d4" };
    h.cards.set(LEAD, bug(LEAD, { batch: old }));
    h.cards.set("story-ex9202", bug("story-ex9202", { batch: old }));
    const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    expect(res.ok).toBe(true);
    expect(h.cards.get("story-ex9202")?.batch).toMatchObject({ lead: LEAD, sessionId: h.session.sessionId, planHash: old.planHash });
    // …mas um item NOVO depois do plano aprovado não entra
    await h.enqueue("story-ex9203");
    const h3 = harness();
    h3.cards.set(LEAD, bug(LEAD, { batch: old }));
    await h3.enqueue("story-ex9203");
    const more = await claimBatch(h3.deps, { sessionId: h3.session.sessionId, board: "b", cardIds: ["story-ex9203"] });
    expect(more.ok).toBe(false);
  });
});

describe("claimBatch / dropBatchItem — a sessão é gravada primeiro", () => {
  it("claim_batch: a sessão não grava ⇒ recusa, os claims voltam e a fila fica como estava", async () => {
    const h = harness();
    await h.enqueue("story-ex9202", "story-ex9203");
    h.fail.sessionWrite = true;
    const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202", "story-ex9203"] });
    expect(res.ok).toBe(false);
    expect(h.claims.map((c) => c.cardId)).toEqual([LEAD]);
    expect(h.queue.entries.map((e) => e.cardId)).toEqual(["story-ex9202", "story-ex9203"]);
    expect(h.marks).toEqual([]);
  });

  it("claim_batch: a fila não grava ⇒ recusa, a sessão volta ao que era e os claims voltam", async () => {
    const h = harness();
    await h.enqueue("story-ex9202");
    const persist = h.queue.persist.bind(h.queue);
    h.queue.persist = async () => {
      throw new Error("disco cheio");
    };
    const res = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    h.queue.persist = persist;
    expect(res.ok).toBe(false);
    expect(h.session.batch).toBeUndefined();
    expect(h.claims.map((c) => c.cardId)).toEqual([LEAD]);
    expect(h.marks).toEqual([]);
  });

  it("batch_drop: a sessão não grava ⇒ recusa e nada muda (o item segue no lote, fora da fila)", async () => {
    const h = harness();
    await h.enqueue("story-ex9202");
    await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    h.fail.sessionWrite = true;
    const res = await dropBatchItem(h.deps, { sessionId: h.session.sessionId, cardId: "story-ex9202", reason: "falhou" });
    expect(res.ok).toBe(false);
    expect(h.queue.entries).toEqual([]);
    expect(h.cards.get("story-ex9202")?.batch?.lead).toBe(LEAD);
    expect(h.claims.some((c) => c.cardId === "story-ex9202")).toBe(true);
    expect(h.session.batch?.dropped).toEqual([]);
  });
});

describe("clearBatchMarks — a sessão do lote acabou", () => {
  it("apaga a marca DESTE lote no líder, nos itens e no que saiu; a de outro lote fica", async () => {
    const h = harness();
    await h.enqueue("story-ex9202", "story-ex9203");
    await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202", "story-ex9203"] });
    await dropBatchItem(h.deps, { sessionId: h.session.sessionId, cardId: "story-ex9203", reason: "falhou" });
    const other = { id: "lote-outro", lead: "story-ex9203", sessionId: "sess-outra", at: "2026-10-01T02:00:00Z" };
    h.cards.set("story-ex9203", { ...h.cards.get("story-ex9203")!, batch: other });
    const cleared = await clearBatchMarks(h.deps, h.session);
    expect(cleared.sort()).toEqual([LEAD, "story-ex9202"]);
    expect(h.cards.get(LEAD)?.batch).toBeUndefined();
    expect(h.cards.get("story-ex9202")?.batch).toBeUndefined();
    expect(h.cards.get("story-ex9203")?.batch).toEqual(other);
  });

  it("a retomada que seguiu só (sem lote na sessão) limpa a marca velha do líder; card sem marca, nada", async () => {
    const h = harness();
    h.cards.set(LEAD, bug(LEAD, { batch: { id: "lote-old", lead: LEAD, sessionId: "sess-old", at: "2026-09-30T00:00:00Z" } }));
    expect(await clearBatchMarks(h.deps, h.session)).toEqual([LEAD]);
    expect(h.cards.get(LEAD)?.batch).toBeUndefined();
    expect(await clearBatchMarks(h.deps, h.session)).toEqual([]);
  });
});

describe("dropBatchItem — o item que falhou volta sozinho", () => {
  it("solta o claim, apaga a marca, deixa o achado e volta à fila `solo`; o líder não sai", async () => {
    const h = harness();
    await h.enqueue("story-ex9202", "story-ex9203");
    await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202", "story-ex9203"] });
    const res = await dropBatchItem(h.deps, { sessionId: h.session.sessionId, cardId: "story-ex9202", reason: "o teste de aceite não passa" });
    expect(res.ok).toBe(true);
    expect(h.claims.some((c) => c.cardId === "story-ex9202")).toBe(false);
    expect(h.cards.get("story-ex9202")?.batch).toBeUndefined();
    expect(h.cards.get("story-ex9202")?.findings?.find((f) => f.id === BATCH_DROPPED_FINDING_ID)?.detail).toContain("o teste de aceite não passa");
    expect(h.queue.entries).toEqual([expect.objectContaining({ cardId: "story-ex9202", solo: true, lastWaitKind: "batch-dropped" })]);
    expect(h.session.batch?.dropped.map((d) => d.cardId)).toEqual(["story-ex9202"]);
    expect(h.cards.get("story-ex9202")?.routing?.driver).toBe("conductor");
    expect((await dropBatchItem(h.deps, { sessionId: h.session.sessionId, cardId: LEAD, reason: "x" })).ok).toBe(false);
    expect((await dropBatchItem(h.deps, { sessionId: h.session.sessionId, cardId: "story-ex9299", reason: "x" })).ok).toBe(false);
    // um item que saiu não volta a este lote
    const again = await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    expect(again.ok).toBe(false);
  });
});

describe("a corrida com o pump — nenhuma entrada perdida nem duplicada", () => {
  it("claim_batch e batch_drop intercalados com passadas do pump", async () => {
    const h = harness();
    await h.enqueue("story-ex9202", "story-ex9203");
    h.cards.set("story-ex9210", story("story-ex9210"));
    await h.queue.persist([...(await h.queue.load()), { board: "b", cardId: "story-ex9210", queuedAt: "2026-10-01T00:00:01Z", attempts: 0 }]);
    let release: () => void = () => {};
    const slowSpawn = new Promise<void>((r) => (release = r));
    let started: () => void = () => {};
    const spawnStarted = new Promise<void>((r) => (started = r));
    const pumpDeps: ConductorDeps = {
      queue: h.queue,
      sessions: async () => h.sessions,
      liveTmux: async () => new Set(h.sessions.map((s) => s.tmuxSession as string)),
      heartbeatAlive: () => true,
      readCard: async (_b, id) => h.cards.get(id) ?? null,
      readBoardConfig: async () => ({ ...config, conductor: { enabled: true, fromStatus: "pronta", maxSessions: 3 } }),
      markDriver: async () => {},
      clearDriver: async () => {},
      stampDispatchFailure: async () => {},
      spawn: async (i): Promise<SpawnSessionResult> => {
        started();
        await slowSpawn;
        const s: AgentSession = { sessionId: `s-${i.cardId}`, agentId: `a-${i.cardId}`, role: "implement", board: "b", cardId: i.cardId, task: i.task, driver: "conductor", tmuxSession: `t-${i.cardId}`, openedAt: "", heartbeatAt: "" };
        h.sessions.push(s);
        return { ok: true, session: s, tmuxSession: s.tmuxSession!, route: { model: "sonnet", why: "t" }, claim: null, mcpMounted: true };
      },
      masterEnabled: () => true,
      // os itens são da funcionalidade do líder (ocupada por ele) — esperam; a história é de outra e nasce
      featureKeyOf: async (_b, c) => (c.id === "story-ex9210" ? keyB : keyA),
      log: () => {},
    };
    // o pump começa (trava pega, spawn lento), a tool chega no meio, e mais uma passada atrás dela
    const pass1 = pumpConductorQueue(pumpDeps);
    await spawnStarted; // a passada está DENTRO da trava, presa no spawn
    const claimed = claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202", "story-ex9203"] });
    const pass2 = pumpConductorQueue(pumpDeps);
    release();
    await Promise.all([pass1, claimed, pass2]);
    expect((await claimed).ok).toBe(true);
    // os itens pegos NÃO voltaram pela cópia da passada, e ninguém foi despachado para eles
    expect(h.queue.entries.map((e) => e.cardId)).toEqual([]);
    expect(h.sessions.map((s) => s.cardId).sort()).toEqual([LEAD, "story-ex9210"]);

    const drop = dropBatchItem(h.deps, { sessionId: h.session.sessionId, cardId: "story-ex9203", reason: "falhou" });
    const pass3 = pumpConductorQueue(pumpDeps);
    await Promise.all([drop, pass3]);
    const final = await pumpConductorQueue(pumpDeps);
    void final;
    const ids = h.queue.entries.map((e) => e.cardId);
    expect(ids.filter((id) => id === "story-ex9203").length + h.sessions.filter((s) => s.cardId === "story-ex9203").length).toBe(1);
  });
});

describe("o líder saiu / o train dividiu — os itens voltam", () => {
  it("o líder que saiu devolve os itens à fila NORMAL (sem solo)", async () => {
    const h = harness();
    await h.enqueue("story-ex9202");
    await claimBatch(h.deps, { sessionId: h.session.sessionId, board: "b", cardIds: ["story-ex9202"] });
    const back = await releaseBatchItems(h.deps, h.session, "o card foi para a lixeira");
    expect(back).toEqual(["story-ex9202"]);
    expect(h.queue.entries).toEqual([expect.objectContaining({ cardId: "story-ex9202" })]);
    expect(h.queue.entries[0].solo).toBeUndefined();
    expect(h.cards.get("story-ex9202")?.batch).toBeUndefined();
  });

  it("a divisão do train devolve os itens sozinhos, com o veredito como motivo", async () => {
    const h = harness();
    h.cards.set("story-ex9202", bug("story-ex9202"));
    h.cards.set("story-ex9203", bug("story-ex9203"));
    const back = await splitBatch(h.deps, { board: "b", leadId: LEAD, itemIds: [LEAD, "story-ex9202", "story-ex9203"], why: "gate-failed: suíte vermelha" });
    expect(back).toEqual(["story-ex9202", "story-ex9203"]);
    expect(h.queue.entries.every((e) => e.solo && /gate-failed/.test(e.lastWaitReason ?? ""))).toBe(true);
  });
});
