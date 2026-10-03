import { describe, expect, it, vi } from "vitest";
import {
  BUSY_REASONS,
  FATAL_409_REASON,
  MAX_BUSY_WAIT_MS,
  OUTBOX_CAP,
  busyBackoffMs,
  busyWaitExhausted,
  classifyTurnRejection,
  dropOutboxItem,
  enqueueOutbox,
  makeOutboxId,
  nextOutboxItem,
  outboxItemLabel,
  outboxSummary,
  outboxWaitingNotice,
  parseRejectionBody,
  runOutboxPump,
  type BusyReason,
  type OutboxItem,
  type OutboxPumpDeps,
  type TurnAttempt,
} from "./outbox";

const item = (id: string, over: Partial<OutboxItem> = {}): OutboxItem => ({ id, text: `msg ${id}`, enqueuedAt: 0, ...over });

describe("classifyTurnRejection — ocupado (espera) × falha (pausa)", () => {
  it("409 com reason transitório → espera, preservando QUEM ocupa", () => {
    for (const reason of BUSY_REASONS) {
      expect(classifyTurnRejection(409, JSON.stringify({ ok: false, error: "…", reason }))).toEqual({ kind: "busy", reason });
    }
  });

  it("409 SEM reason (servidor antigo, aba atravessando um deploy) → espera", () => {
    expect(classifyTurnRejection(409, JSON.stringify({ ok: false, error: "já há um turno em andamento neste board" }))).toEqual({
      kind: "busy",
      reason: "turn-in-flight",
    });
    expect(classifyTurnRejection(409, "")).toEqual({ kind: "busy", reason: "turn-in-flight" });
  });

  it("409 permanente (sessão atrelada a outro board) → FALHA, nunca laço de retry", () => {
    expect(classifyTurnRejection(409, JSON.stringify({ ok: false, reason: FATAL_409_REASON }))).toEqual({ kind: "fatal" });
  });

  it("409 com reason DESCONHECIDO → falha (conservador: sem saber se libera, esperar viraria laço)", () => {
    expect(classifyTurnRejection(409, JSON.stringify({ ok: false, reason: "algo-novo-que-nao-conhecemos" }))).toEqual({ kind: "fatal" });
  });

  it("qualquer status ≠ 409 é falha — inclusive 5xx e 429 (só o 409 é a trava de 1-turno-por-board)", () => {
    for (const status of [400, 401, 404, 429, 500, 502, 503]) {
      expect(classifyTurnRejection(status, JSON.stringify({ ok: false, reason: "turn-in-flight" }))).toEqual({ kind: "fatal" });
    }
  });
});

describe("parseRejectionBody", () => {
  it("extrai error + reason e ignora campos não-string/vazios", () => {
    expect(parseRejectionBody(JSON.stringify({ error: " boom ", reason: "turn-in-flight" }))).toEqual({
      error: "boom",
      reason: "turn-in-flight",
    });
    expect(parseRejectionBody(JSON.stringify({ error: "   ", reason: 7 }))).toEqual({});
  });

  it("corpo não-JSON nunca lança", () => {
    expect(parseRejectionBody("<html>bad gateway</html>")).toEqual({});
    expect(parseRejectionBody("")).toEqual({});
  });
});

describe("backoff e teto de espera", () => {
  it("cresce e satura no teto (nunca 0, nunca infinito)", () => {
    const seq = [0, 1, 2, 3, 4, 50].map(busyBackoffMs);
    expect(seq[0]).toBeGreaterThan(0);
    expect(seq[0]).toBeLessThan(seq[1]);
    expect(seq[1]).toBeLessThan(seq[2]);
    expect(seq[3]).toBe(seq[4]); // saturou
    expect(seq[5]).toBe(seq[3]); // e segue saturado para sempre
    expect(seq[5]).toBeLessThanOrEqual(10_000); // teto baixo: é o pior atraso entre "abriu espaço" e "saiu"
  });

  it("trata attempt negativo/fracionário sem NaN", () => {
    expect(busyBackoffMs(-3)).toBe(busyBackoffMs(0));
    expect(busyBackoffMs(1.9)).toBe(busyBackoffMs(1));
  });

  it("a espera total é LIMITADA — no teto a fila pausa em vez de bater no servidor para sempre", () => {
    expect(busyWaitExhausted(0)).toBe(false);
    expect(busyWaitExhausted(MAX_BUSY_WAIT_MS - 1)).toBe(false);
    expect(busyWaitExhausted(MAX_BUSY_WAIT_MS)).toBe(true);
    expect(MAX_BUSY_WAIT_MS).toBeGreaterThan(600_000); // > watchdog do turno (10min): ocupação legítima já acabou
  });
});

describe("operações da fila", () => {
  it("enfileira preservando a ordem de digitação (FIFO) e não muta a entrada", () => {
    const a = [item("q1")];
    const { queue, accepted } = enqueueOutbox(a, item("q2"));
    expect(accepted).toBe(true);
    expect(queue.map((i) => i.id)).toEqual(["q1", "q2"]);
    expect(a).toHaveLength(1);
  });

  it("no teto RECUSA o novo (o composer mantém o texto) e NUNCA dropa item já aceito", () => {
    const full = Array.from({ length: OUTBOX_CAP }, (_, i) => item(`q${i}`));
    const { queue, accepted } = enqueueOutbox(full, item("novo"));
    expect(accepted).toBe(false);
    expect(queue).toHaveLength(OUTBOX_CAP);
    expect(queue.map((i) => i.id)).not.toContain("novo");
  });

  it("dropOutboxItem remove por id e é idempotente", () => {
    const q = [item("q1"), item("q2")];
    expect(dropOutboxItem(q, "q1").map((i) => i.id)).toEqual(["q2"]);
    expect(dropOutboxItem(dropOutboxItem(q, "q1"), "q1").map((i) => i.id)).toEqual(["q2"]);
    expect(dropOutboxItem(q, "inexistente")).toHaveLength(2);
  });

  it("nextOutboxItem: a CABEÇA da fila, e nada quando pausada (nada sai atrás do operador)", () => {
    const q = [item("q1"), item("q2")];
    expect(nextOutboxItem(q, { paused: false })?.id).toBe("q1");
    expect(nextOutboxItem(q, { paused: true })).toBeNull();
    expect(nextOutboxItem([], { paused: false })).toBeNull();
  });

  it("makeOutboxId é determinístico e único por sequência", () => {
    expect(makeOutboxId(1)).toBe(makeOutboxId(1));
    expect(makeOutboxId(1)).not.toBe(makeOutboxId(2));
  });
});

/**
 * O PUMP com o mundo inteiro injetado: fila real (array), rede falsa (roteiro de desfechos), relógio virtual e
 * sleep instantâneo. É aqui que a promessa do incidente é verificada — "as mensagens devem ser enfileiradas e
 * enviadas conforme abrirem espaço" — sem React, sem timers e sem rede.
 */
function harness(queue: OutboxItem[], script: TurnAttempt[], opts: { alive?: () => boolean } = {}) {
  const sent: string[] = [];
  const slept: number[] = [];
  const waited: (BusyReason | null)[] = [];
  let clock = 0;
  let exhausted = 0;
  let fatal = 0;
  const deps: OutboxPumpDeps = {
    next: () => queue[0] ?? null,
    attempt: async (item) => {
      const outcome = script.shift() ?? { kind: "sent" };
      // O contrato do chamador real: um turno ACEITO sai da fila; ocupado/falha mantêm o item na cabeça.
      if (outcome.kind === "sent") {
        sent.push(item.id);
        queue.shift();
      }
      return outcome;
    },
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms; // o sono é o que faz o relógio virtual andar
    },
    now: () => clock,
    alive: opts.alive ?? (() => true),
    onWaiting: (reason) => waited.push(reason),
    onExhausted: () => {
      exhausted += 1;
    },
    onFatal: () => {
      fatal += 1;
    },
  };
  return {
    deps,
    run: () => runOutboxPump(deps),
    get sent() {
      return sent;
    },
    get slept() {
      return slept;
    },
    get waited() {
      return waited;
    },
    get queue() {
      return queue;
    },
    get exhausted() {
      return exhausted;
    },
    get fatal() {
      return fatal;
    },
  };
}

describe("runOutboxPump — a política de envio", () => {
  it("drena a fila INTEIRA na ordem de digitação e termina limpando o estado de espera", async () => {
    const h = harness([item("q1"), item("q2"), item("q3")], []);
    await h.run();
    expect(h.sent).toEqual(["q1", "q2", "q3"]);
    expect(h.queue).toEqual([]);
    expect(h.waited.at(-1)).toBeNull();
    expect(h.exhausted + h.fatal).toBe(0);
  });

  it("OCUPADO: espera com backoff crescente e reenvia o MESMO item, até ele sair (o pedido do incidente)", async () => {
    const h = harness([item("q1"), item("q2")], [
      { kind: "busy", reason: "autonomous-tick" },
      { kind: "busy", reason: "autonomous-tick" },
      { kind: "busy", reason: "turn-in-flight" },
      { kind: "sent" }, // q1 finalmente sai
      { kind: "sent" }, // e a fila segue para q2
    ]);
    await h.run();
    expect(h.sent).toEqual(["q1", "q2"]); // ninguém foi perdido nem pulou a fila
    expect(h.slept).toEqual([busyBackoffMs(0), busyBackoffMs(1), busyBackoffMs(2)]);
    // o operador soube POR QUE esperava (e quem ocupava), e o estado de espera foi limpo ao sair
    expect(h.waited).toContain("autonomous-tick");
    expect(h.waited).toContain("turn-in-flight");
    expect(h.waited.at(-1)).toBeNull();
  });

  it("o backoff ZERA entre itens: uma espera longa não penaliza o envio seguinte", async () => {
    const h = harness([item("q1"), item("q2")], [
      { kind: "busy", reason: "turn-in-flight" },
      { kind: "busy", reason: "turn-in-flight" },
      { kind: "sent" },
      { kind: "busy", reason: "turn-in-flight" },
      { kind: "sent" },
    ]);
    await h.run();
    expect(h.slept).toEqual([busyBackoffMs(0), busyBackoffMs(1), busyBackoffMs(0)]);
  });

  it("espera LIMITADA: estourado o teto, pausa e avisa em vez de bater no servidor para sempre", async () => {
    // roteiro de ocupado infinito — só o teto pode parar o laço
    const h = harness([item("q1")], []);
    const forever = { kind: "busy", reason: "turn-in-flight" } as const;
    h.deps.attempt = async () => forever;
    await h.run();
    expect(h.exhausted).toBe(1);
    expect(h.fatal).toBe(0);
    expect(h.queue.map((i) => i.id)).toEqual(["q1"]); // a mensagem continua ali, intacta
    expect(h.slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(MAX_BUSY_WAIT_MS - busyBackoffMs(99));
    expect(h.waited.at(-1)).toBeNull();
  });

  it("FALHA real: para na hora, pausa, e o item NÃO é perdido nem reenviado às cegas", async () => {
    const h = harness([item("q1"), item("q2")], [{ kind: "fatal" }]);
    await h.run();
    expect(h.fatal).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.queue.map((i) => i.id)).toEqual(["q1", "q2"]); // ninguém saiu; o operador decide
  });

  it("ABORTADO (cancelar): para sem pausar e sem consumir a fila — quem cancelou decide", async () => {
    const h = harness([item("q1"), item("q2")], [{ kind: "aborted" }]);
    await h.run();
    expect(h.fatal).toBe(0);
    expect(h.exhausted).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.queue).toHaveLength(2);
  });

  it("fila vazia ou PAUSADA: sai imediatamente sem tentar nada (nada sai atrás do operador)", async () => {
    const empty = harness([], []);
    empty.deps.attempt = vi.fn();
    await empty.run();
    expect(empty.deps.attempt).not.toHaveBeenCalled();
    expect(empty.waited).toEqual([null]);

    const paused = harness([item("q1")], []);
    paused.deps.next = () => null; // é o que nextOutboxItem faz quando pausado
    paused.deps.attempt = vi.fn();
    await paused.run();
    expect(paused.deps.attempt).not.toHaveBeenCalled();
    expect(paused.queue).toHaveLength(1);
  });

  it("painel DESMONTADO no meio: o laço morre e não despacha o próximo", async () => {
    let alive = true;
    const h = harness([item("q1"), item("q2")], [{ kind: "sent" }], { alive: () => alive });
    h.deps.attempt = async (i) => {
      alive = false; // desmontou durante o turno
      h.queue.shift();
      h.sent.push(i.id);
      return { kind: "sent" };
    };
    await h.run();
    expect(h.sent).toEqual(["q1"]);
    expect(h.queue.map((i) => i.id)).toEqual(["q2"]); // q2 continua guardado, não enviado
  });
});

describe("copy da fila", () => {
  it("a bolha mostra o rótulo do comando, o texto, ou a contagem de imagens — nunca vazio", () => {
    expect(outboxItemLabel(item("q1", { command: "Compactando a conversa…", text: "/compact" }))).toBe("Compactando a conversa…");
    expect(outboxItemLabel(item("q1", { text: "  status?  " }))).toBe("  status?  ");
    expect(outboxItemLabel(item("q1", { text: "", images: ["/tmp/a.png", "/tmp/b.png"] }))).toBe("(2 imagens)");
    expect(outboxItemLabel(item("q1", { text: "" }))).toBe("(vazio)");
  });

  it("a contagem singulariza e o aviso NOMEIA quem está ocupando", () => {
    expect(outboxSummary(1)).toBe("1 mensagem na fila");
    expect(outboxSummary(3)).toBe("3 mensagens na fila");
    expect(outboxWaitingNotice("autonomous-tick")).toMatch(/autônomo/i);
    expect(outboxWaitingNotice("turn-in-flight")).toMatch(/turno atual/i);
    // nenhum aviso de espera sugere que a mensagem foi perdida ou que o operador precisa reenviar
    for (const r of BUSY_REASONS) expect(outboxWaitingNotice(r)).toMatch(/autom[áa]tico/i);
  });
});
