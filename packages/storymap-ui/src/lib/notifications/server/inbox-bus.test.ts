// `inbox.changed` (onda 2, passo 8): o Inbox de um board muda sem card nenhum mudar — um sidecar (a proposta de PRD, o
// pedido de um agente), um ledger (a decisão do sistema, o recibo do dono), a fila do train, a telemetria. Cada
// produtor sinaliza o board, o barramento coalesce, a rota SSE entrega, e a tela relê — sem poll.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendSystemDecision, resetSystemDecisionSink, setSystemDecisionSink } from "@/lib/storymap/runner/decision-log";
import { appendInboxReceipt, resetInboxReceiptSink, setInboxReceiptSink } from "@/lib/storymap/runner/receipts-log";
import { TelemetryStore, type TelemetryRecord } from "@/lib/storymap/runner/telemetry";
import { inboxEventConcerns } from "@/components/inbox/useInboxChanged";
import {
  INBOX_COALESCE_MS,
  changedBoards,
  resetInboxBus,
  signalInboxChanged,
  signaturesByBoard,
  startInboxSignals,
  subscribeInboxChanged,
  type InboxChanged,
  type RunnerLike,
} from "./inbox-bus";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

let events: InboxChanged[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  resetInboxBus();
  events = [];
});
afterEach(() => {
  resetInboxBus();
  vi.useRealTimers();
});
const listen = () => subscribeInboxChanged((e) => events.push(e));

describe("o barramento", () => {
  it("coalesce por board: uma rajada vira UM evento, com as causas juntas", () => {
    listen();
    signalInboxChanged("b1", "card");
    signalInboxChanged("b1", "sidecar");
    signalInboxChanged("b1", "card");
    signalInboxChanged("b2", "decision");
    expect(events).toEqual([]);
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    expect(events.map((e) => [e.board, e.causes])).toEqual([
      ["b1", ["card", "sidecar"]],
      ["b2", ["decision"]],
    ]);
  });

  it("um fato do HOST vale para todo board (board null)", () => {
    listen();
    signalInboxChanged(null, "runner");
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    expect(events[0].board).toBeNull();
  });

  it("sem ouvinte, não arma timer nenhum (quem grava num teste não deixa nada pendurado)", () => {
    signalInboxChanged("b1", "card");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("um ouvinte que explode sai do laço e não derruba os outros", () => {
    subscribeInboxChanged(() => {
      throw new Error("stream fechado");
    });
    listen();
    signalInboxChanged("b1", "card");
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    signalInboxChanged("b1", "card");
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    expect(events).toHaveLength(2);
  });
});

describe("os produtores da memória: as falhas do runner e a fila do train", () => {
  function fakeRegistry() {
    let runner: Parameters<RunnerLike["subscribe"]>[0] = () => {};
    let queue: Parameters<RunnerLike["subscribeMergeQueue"]>[0] = () => {};
    const reg: RunnerLike = {
      subscribe: (fn) => ((runner = fn), () => {}),
      subscribeMergeQueue: (fn) => ((queue = fn), () => {}),
    };
    return { reg, runner: (s: Parameters<typeof runner>[0]) => runner(s), queue: (s: Parameters<typeof queue>[0]) => queue(s) };
  }

  it("só o board cujo retrato mudou recebe o evento — o mesmo retrato de novo não recarrega nada", () => {
    listen();
    const r = fakeRegistry();
    startInboxSignals(r.reg);
    startInboxSignals(r.reg); // idempotente
    r.runner({ failures: [{ board: "b1", cardId: "c1", trigger: "harness-do", reason: "exit" }] });
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    r.runner({ failures: [{ board: "b1", cardId: "c1", trigger: "harness-do", reason: "exit" }] });
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    r.queue({ entries: [{ board: "b2", cardId: "c9", runId: "r1", status: "queued" }] });
    r.queue({ entries: [{ board: "b2", cardId: "c9", runId: "r1", status: "conflict" }] });
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    r.runner({ failures: [] }); // a falha resolveu: o board dela relê
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    expect(events.map((e) => [e.board, e.causes])).toEqual([
      ["b1", ["runner"]],
      ["b2", ["merge-queue"]],
      ["b1", ["runner"]],
    ]);
  });

  it("assinatura por board, e os boards que mudaram (inclusive os que sumiram)", () => {
    const a = signaturesByBoard([{ board: "b1", k: "x" }, { board: "b2", k: "y" }], (r) => r.k);
    const b = signaturesByBoard([{ board: "b1", k: "x" }, { board: "b3", k: "z" }], (r) => r.k);
    expect(changedBoards(a, b)).toEqual(["b2", "b3"]);
  });
});

describe("os produtores que escrevem em disco sinalizam de onde escrevem", () => {
  it("a decisão do sistema e o recibo do dono sinalizam o board deles", async () => {
    listen();
    setSystemDecisionSink({ append: async () => {} });
    setInboxReceiptSink({ append: async () => {} });
    try {
      await appendSystemDecision({ v: 1, id: "sd-1", at: "2026-09-28T19:00:00Z", board: "b1", agent: "proxy", kind: "proxy-answer", what: "x", why: "y" });
      await appendInboxReceipt({ v: 1, id: "rc-1", at: "2026-09-28T19:00:00Z", board: "b2", itemId: "c1:review", kind: "review", ask: "?", text: "ok" });
    } finally {
      resetSystemDecisionSink();
      resetInboxReceiptSink();
    }
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    expect(events.map((e) => [e.board, e.causes])).toEqual([
      ["b1", ["decision"]],
      ["b2", ["receipt"]],
    ]);
  });

  it("um run que termina sinaliza o board dele (a execução parada nasce da telemetria)", async () => {
    listen();
    const t = new TelemetryStore({ load: async () => [], persist: async () => {} });
    await t.recordRun({ id: "s1", board: "b3", cardId: "c1", trigger: "harness-do", startedAt: 1, durationMs: 1, turns: 1, inputTokens: 1, outputTokens: 1, costUSD: 0, status: "ok" } as TelemetryRecord);
    vi.advanceTimersByTime(INBOX_COALESCE_MS);
    expect(events.map((e) => [e.board, e.causes])).toEqual([["b3", ["telemetry"]]]);
  });

  it("o watcher dos boards sinaliza cards, o board.yaml e os SIDECARS que viram itens", () => {
    const w = read("./watcher.ts");
    expect(w).toMatch(/signalInboxChanged\(boardId, "card"\)/);
    expect(w).toMatch(/signalInboxChanged\(boardId, "board"\)/);
    expect(w).toMatch(/INBOX_SIDECAR_DIRS\.has\(parts\[1\]\)\) signalInboxChanged\(boardId, "sidecar"\)/);
    for (const dir of ["governance", "approvals", "proposals", "wireframes", ".trash"]) expect(w).toContain(`"${dir}"`);
  });
});

describe("a entrega e a tela", () => {
  it("a rota SSE entrega `event: inbox.changed`, liga os produtores da memória e sai do barramento ao fechar", () => {
    const route = read("../../../app/api/notifications/stream/route.ts");
    expect(route).toMatch(/event: inbox\.changed\\ndata:/);
    expect(route).toMatch(/startInboxSignals\(registry\)/);
    expect(route).toMatch(/unsubscribeInbox = subscribeInboxChanged\(sendInbox\)/);
    expect(route.match(/unsubscribeInbox\(\);/g)?.length).toBe(2); // no cleanup e no cancel
  });

  it("a lista e o número da barra releem por `inbox.changed` — e a barra não faz mais poll", () => {
    const home = read("../../../components/inbox/InboxHome.tsx");
    expect(home).toMatch(/useInboxChanged\(\(\) => router\.refresh\(\), \{ boards: filter \? \[filter\] : null \}\)/);
    expect(home).not.toMatch(/"agileharness"/);
    // o número da barra vem do hook compartilhado (WP4: o nav e o pulso do Kanban leem a MESMA contagem) —
    // reage a `inbox.changed` e não faz poll
    const summary = read("../../../components/useInboxSummary.ts");
    expect(summary).toMatch(/useInboxChanged\(\(\) => void load\(\)/);
    expect(summary).not.toMatch(/setInterval/);
    expect(read("../../../components/BoardHeader.tsx")).toMatch(/useInboxSummary\(\)/);
    // a barra das páginas app-level também lê a loja (o mesmo número, a mesma releitura por `inbox.changed`)
    expect(read("../../../components/nav/TopBar.tsx")).toMatch(/useInboxSummary\(\)/);
    // A home (o Início) foi ELIMINADA na fase 1 — a casa do board é o Kanban; a tela que ela relia saiu junto.
    expect(existsSync(fileURLToPath(new URL("../../../components/inicio/InicioScreen.tsx", import.meta.url)))).toBe(false);
  });

  it("a tela filtra pelo board que mostra; o fato do host e o evento torto sempre releem", () => {
    expect(inboxEventConcerns(JSON.stringify({ board: "b1" }), ["b1"])).toBe(true);
    expect(inboxEventConcerns(JSON.stringify({ board: "b2" }), ["b1"])).toBe(false);
    expect(inboxEventConcerns(JSON.stringify({ board: "b2" }), null)).toBe(true);
    expect(inboxEventConcerns(JSON.stringify({ board: null }), ["b1"])).toBe(true);
    expect(inboxEventConcerns("{torto", ["b1"])).toBe(true);
  });
});
