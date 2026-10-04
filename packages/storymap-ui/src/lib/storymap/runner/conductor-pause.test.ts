// A parada do condutor, do lado do serviço (fatia 2 das «paradas por recurso»):
// a resposta chega à sessão sem ninguém digitar; o card estacionado volta para a FRENTE da fila; e o condutor
// quieto que espera o dono há mais que a carência recebe o pedido de estacionar — uma vez.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { compareConductorQueue, admitConductorCard, memoryConductorQueueStore, type ConductorDeps } from "./conductor";
import {
  CHILD_WORK_WINDOW_FACTOR,
  DECLARED_PARK_LINE,
  ladderLine,
  DEFAULT_PARK_SETTINGS,
  ladderGraceMs,
  NUDGE_LINE,
  PARK_LINE,
  QUIET_PARK_LINE,
  TRANSPORT_RETRY_LINE,
  TRANSPORT_RETRY_WINDOW_MS,
  ladderDecision,
  parkWaitingConductors,
  PACE_PARK_LINE,
  parkBoardConductors,
  quietLadderStep,
  waitsForOwner,
  wakeConductor,
  wakeLine,
  type ConductorParkDeps,
  type ConductorWakeDeps,
  type QuietLadderFacts,
} from "./conductor-pause";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { AgentSession } from "./session-worktree";

const MIN = 60_000;
const config = (mode: "ultra" | "human" = "ultra") =>
  ({
    id: "b",
    name: "B",
    autonomy: { mode },
    statuses: [
      { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
      { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed" },
      { id: "concluida", name: "No ar", terminal: true },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  }) as unknown as BoardConfig;

const q = (id: string, category: string, status: "open" | "answered" = "open", extra: Record<string, unknown> = {}) => ({ id, text: `pergunta ${id}`, status, category, ...extra });
const cardOf = (status: string, questions: unknown[] = [], extra: Record<string, unknown> = {}): Card =>
  coerceCard("story-x", { type: "story", storyType: "bug", title: "Calcular o frete", status, routing: { driver: "conductor" }, questions, ...extra }, "");
const session = (over: Partial<AgentSession> = {}): AgentSession =>
  ({ sessionId: "s1", agentId: "a1", role: "implement", task: "t", board: "b", cardId: "story-x", driver: "conductor", tmuxSession: "agent-conductor-story-x-ab12", openedAt: "2026-10-01T10:00:00Z", heartbeatAt: "2026-10-01T10:00:00Z", ...over }) as AgentSession;

function wakeWorld(opts: { card: Card | null; sessions?: AgentSession[]; live?: string[] | null; claude?: boolean; mode?: "ultra" | "human" }) {
  const delivered: Array<{ tmux: string; text: string }> = [];
  const resumed: string[] = [];
  const deps: ConductorWakeDeps = {
    sessions: async () => opts.sessions ?? [],
    liveTmux: async () => (opts.live === null ? null : new Set(opts.live ?? [])),
    heartbeatAlive: () => true,
    readCard: async () => opts.card,
    readBoardConfig: async () => config(opts.mode),
    runsClaude: async () => opts.claude ?? true,
    deliver: async (tmux, text) => {
      delivered.push({ tmux, text });
      return true;
    },
    admitResume: async (b, c) => {
      resumed.push(`${b}/${c}`);
      return { queued: true };
    },
    log: () => {},
  };
  return { deps, delivered, resumed };
}
const ANSWER = { board: "b", cardId: "story-x", questionIds: ["q1"], by: "owner" as const };

describe("wakeConductor — a resposta chega à sessão sem ninguém digitar «continuar»", () => {
  it("condutor vivo: a linha fixa é entregue no terminal DELE, dizendo quem respondeu e qual pergunta", async () => {
    const w = wakeWorld({ card: cardOf("desenvolver", [q("q1", "money", "answered")]), sessions: [session()], live: ["agent-conductor-story-x-ab12"] });
    expect(await wakeConductor(w.deps, ANSWER)).toBe("delivered");
    expect(w.delivered).toEqual([{ tmux: "agent-conductor-story-x-ab12", text: "continuar — o dono respondeu q1 neste card. Releia o card (get_card) antes de seguir." }]);
    expect(w.resumed).toEqual([]);
  });

  it("as palavras são do código: um id sem forma de id nunca entra na linha; o proxy diz que há premissas; pergunta do dono restante é avisada", () => {
    expect(wakeLine("owner", ["q1; rm -rf /", "q2"], 0)).toBe("continuar — o dono respondeu q2 neste card. Releia o card (get_card) antes de seguir.");
    expect(wakeLine("owner", ["$(x)"], 0)).toMatch(/respondeu uma pergunta neste card/);
    expect(wakeLine("proxy", ["q3"], 1)).toBe(
      "continuar — o PROXY (modo ultra) respondeu q3 neste card, com premissas registradas. Releia o card (get_card) antes de seguir. Restam 1 pergunta(s) só do dono abertas: siga no que não depende delas.",
    );
  });

  it("card ESTACIONADO (sem condutor vivo) e nada mais aberto: volta para a frente da fila, e ninguém recebe texto", async () => {
    const w = wakeWorld({ card: cardOf("desenvolver", [q("q1", "money", "answered")]), sessions: [], live: [] });
    expect(await wakeConductor(w.deps, ANSWER)).toBe("resumed");
    expect(w.resumed).toEqual(["b/story-x"]);
    expect(w.delivered).toEqual([]);
  });

  it("estacionado com OUTRA pergunta ainda aberta: continua esperando — a próxima resposta o acorda", async () => {
    const w = wakeWorld({ card: cardOf("desenvolver", [q("q1", "money", "answered"), q("q2", "money")]), sessions: [], live: [] });
    expect(await wakeConductor(w.deps, ANSWER)).toBe("still-waiting");
    expect(w.resumed).toEqual([]);
  });

  it("não age em card que não é conduzido, nem em card já terminal", async () => {
    const plain = wakeWorld({ card: coerceCard("story-x", { type: "story", title: "t", status: "desenvolver" }, ""), live: [] });
    expect(await wakeConductor(plain.deps, ANSWER)).toBe("not-conducted");
    const done = wakeWorld({ card: cardOf("concluida"), live: [] });
    expect(await wakeConductor(done.deps, ANSWER)).toBe("terminal");
    expect([...plain.resumed, ...done.resumed, ...plain.delivered, ...done.delivered]).toEqual([]);
  });

  it("sem saber quem está vivo (a sonda falhou) não digita nem reabre; pane que não roda o claude não recebe texto", async () => {
    const blind = wakeWorld({ card: cardOf("desenvolver"), sessions: [session()], live: null });
    expect(await wakeConductor(blind.deps, ANSWER)).toBe("unknown");
    const shell = wakeWorld({ card: cardOf("desenvolver"), sessions: [session()], live: ["agent-conductor-story-x-ab12"], claude: false });
    expect(await wakeConductor(shell.deps, ANSWER)).toBe("undeliverable");
    expect([...blind.delivered, ...blind.resumed, ...shell.delivered, ...shell.resumed]).toEqual([]);
  });
});

describe("waitsForOwner — quando a espera é do dono (e estacionar faz sentido)", () => {
  it("toda pergunta aberta é do dono ⇒ sim; havendo uma que o proxy responde em minutos ⇒ não", () => {
    expect(waitsForOwner(cardOf("desenvolver", [q("q1", "money")]), config())).toBe(true);
    expect(waitsForOwner(cardOf("desenvolver", [q("q1", "money"), q("q2", "technical")]), config())).toBe(false);
    expect(waitsForOwner(cardOf("desenvolver", [q("q1", "technical")]), config())).toBe(false);
  });
  it("em board de modo humano toda pergunta é do dono", () => {
    expect(waitsForOwner(cardOf("desenvolver", [q("q1", "technical")]), config("human"))).toBe(true);
  });
  it("sem pergunta aberta: só no passo em que o dono aprova a entrega", () => {
    expect(waitsForOwner(cardOf("revisao"), config())).toBe(true);
    expect(waitsForOwner(cardOf("desenvolver"), config())).toBe(false);
    expect(waitsForOwner(cardOf("concluida"), config())).toBe(false);
  });
});

function parkWorld(opts: { card: Card; quietMin: number | null; asking?: boolean; live?: string[] | null; claude?: boolean; afterMinutes?: number }) {
  let t = Date.UTC(2026, 9, 1, 12, 0);
  const delivered: string[] = [];
  const lines: string[] = [];
  const deps: ConductorParkDeps = {
    sessions: async () => [session()],
    liveTmux: async () => (opts.live === null ? null : new Set(opts.live ?? ["agent-conductor-story-x-ab12"])),
    heartbeatAlive: () => true,
    readCard: async () => opts.card,
    readBoardConfig: async () => config(),
    runsClaude: async () => opts.claude ?? true,
    deliver: vi.fn(async (_tmux: string, text: string) => {
      delivered.push(text);
      return true;
    }),
    settings: () => ({ ...DEFAULT_PARK_SETTINGS, afterMinutes: opts.afterMinutes ?? 10 }),
    quietForMs: () => (opts.quietMin == null ? null : opts.quietMin * MIN),
    asking: () => opts.asking ?? false,
    state: new Map(),
    now: () => t,
    log: (l) => lines.push(l),
  };
  return { deps, delivered, lines, tick: (ms: number) => void (t += ms) };
}

describe("parkWaitingConductors — o condutor que espera o dono libera a vaga", () => {
  const owned = cardOf("desenvolver", [q("q1", "money")]);

  it("quieto além da carência, esperando o dono: recebe o pedido de estacionar — UMA vez", async () => {
    const w = parkWorld({ card: owned, quietMin: 10 });
    expect((await parkWaitingConductors(w.deps)).asked).toEqual([{ board: "b", cardId: "story-x", tmuxSession: "agent-conductor-story-x-ab12", cause: "owner" }]);
    expect(w.delivered).toEqual([PARK_LINE]);
    await parkWaitingConductors(w.deps);
    await parkWaitingConductors(w.deps);
    expect(w.delivered).toHaveLength(1);
    expect(w.lines.join("\n")).toMatch(/pedido de estacionar enviado/);
  });

  it("«só se demorar»: dentro da carência (a decisão de um agente chega em minutos) nada é pedido", async () => {
    const w = parkWorld({ card: owned, quietMin: 9 });
    expect((await parkWaitingConductors(w.deps)).asked).toEqual([]);
  });

  it("quem espera o PROXY, quem está trabalhando e quem tem um prompt desenhado na tela não é tocado", async () => {
    const proxy = parkWorld({ card: cardOf("desenvolver", [q("q1", "technical")]), quietMin: 60 });
    const working = parkWorld({ card: owned, quietMin: null });
    const asking = parkWorld({ card: owned, quietMin: 60, asking: true });
    const nothing = parkWorld({ card: cardOf("desenvolver"), quietMin: 60 });
    for (const w of [proxy, working, asking, nothing]) {
      expect((await parkWaitingConductors(w.deps)).asked).toEqual([]);
      expect(w.delivered).toEqual([]);
    }
  });

  it("o condutor que descansa em «Aprovar entrega» também estaciona (a aprovação é do dono e pode levar dias)", async () => {
    const w = parkWorld({ card: cardOf("revisao"), quietMin: 30 });
    expect((await parkWaitingConductors(w.deps)).asked).toHaveLength(1);
  });

  it("sonda sem resposta não pede nada; pane que não roda o claude fica para o próximo passe", async () => {
    const blind = parkWorld({ card: owned, quietMin: 60, live: null });
    expect((await parkWaitingConductors(blind.deps)).asked).toEqual([]);
    const shell = parkWorld({ card: owned, quietMin: 60, claude: false });
    expect((await parkWaitingConductors(shell.deps)).asked).toEqual([]);
    expect(shell.deps.state.size).toBe(0);
  });

  it("o pedido é uma linha só, de palavras fixas, e diz para NÃO limpar o driver (a coluna recomeçaria do zero)", () => {
    expect(PARK_LINE).not.toMatch(/\n/);
    expect(PARK_LINE).toMatch(/^estacionar — /);
    expect(PARK_LINE).toMatch(/NÃO limpe o driver/);
    expect(PARK_LINE).toMatch(/Estado do condutor/);
    // Regressão: estacionado em «Aprovar entrega» por uma PERGUNTA do dono, o condutor limpou o
    // driver; respondida a pergunta, ninguém levou o card adiante. Com pergunta aberta o driver fica.
    expect(PARK_LINE).toMatch(/SEM pergunta sua aberta/);
    expect(PARK_LINE).toMatch(/com pergunta aberta, mantenha o driver/);
  });
});

describe("a fila do condutor — a retomada passa na frente", () => {
  const entry = (cardId: string, queuedAt: string, resume = false) => ({ entry: { board: "b", cardId, queuedAt, attempts: 0, ...(resume ? { resume: true as const } : {}) }, card: null });
  it("retomada vem antes de qualquer prioridade; entre retomadas vale a ordem de chegada", () => {
    const critical = { entry: { board: "b", cardId: "c-critico", queuedAt: "2026-10-01T08:00:00Z", attempts: 0 }, card: { priorityCall: { rank: 3 } } as unknown as Card };
    const list = [entry("c-novo", "2026-10-01T09:00:00Z"), critical, entry("c-retomada-2", "2026-10-01T11:00:00Z", true), entry("c-retomada-1", "2026-10-01T10:00:00Z", true)];
    expect([...list].sort(compareConductorQueue).map((x) => x.entry.cardId)).toEqual(["c-retomada-1", "c-retomada-2", "c-critico", "c-novo"]);
  });

  it("admitir como retomada um card que JÁ espera só o promove: nunca duplica a entrada", async () => {
    const queue = memoryConductorQueueStore([{ board: "b", cardId: "story-x", queuedAt: "2026-10-01T09:00:00Z", attempts: 0 }]);
    const deps = { queue, sessions: async () => [], liveTmux: async () => new Set<string>(), heartbeatAlive: () => true, markDriver: async () => {}, log: () => {} } as unknown as ConductorDeps;
    expect(await admitConductorCard(deps, "b", "story-x", { resume: true })).toEqual({ queued: false });
    expect(queue.entries).toEqual([{ board: "b", cardId: "story-x", queuedAt: "2026-10-01T09:00:00Z", attempts: 0, resume: true }]);
    // um card novo entra como retomada já marcado
    expect(await admitConductorCard(deps, "b", "story-y", { resume: true })).toEqual({ queued: true });
    expect(queue.entries.find((e) => e.cardId === "story-y")?.resume).toBe(true);
  });
});

// ── WP5-F2: a escada única do condutor parado ─────────────────────────────────────────────────────────────────────
// Um condutor que recebeu «API Error: The response stopped arriving» ficava
// parado no prompt até o dono digitar «continue» (às vezes por horas). E um condutor quieto sem pedir nada
// segurava uma das 2 vagas com seis cards na fila. A vaga só é segurada por atividade provada ou espera declarada.

describe("quietLadderStep — a escada (pura)", () => {
  const NOW = Date.UTC(2026, 9, 1, 20, 10);
  const S = DEFAULT_PARK_SETTINGS;
  const f = (over: Partial<QuietLadderFacts> = {}): QuietLadderFacts => ({ quietForMs: 0, asking: false, transportError: null, declaredWaiting: false, ownerWait: false, slotWaiters: 0, ...over });
  const memo = (over: Record<string, unknown> = {}) => ({ board: "b", cardId: "story-x", ...over });

  it("erro de transporte + prompt há ≥3 min ⇒ retomar (1ª, 2ª); a 3ª vez estaciona — sem depender de fila", () => {
    const api = f({ quietForMs: 3 * MIN, transportError: "API Error: The response stopped arriving." });
    expect(quietLadderStep(api, undefined, S, NOW)).toEqual({ kind: "transport-retry", attempt: 1 });
    expect(quietLadderStep(api, memo({ retriedAt: [NOW - 4 * MIN] }), S, NOW)).toEqual({ kind: "transport-retry", attempt: 2 });
    expect(quietLadderStep(api, memo({ retriedAt: [NOW - 8 * MIN, NOW - 4 * MIN] }), S, NOW)).toEqual({ kind: "park", cause: "transport" });
  });

  it("erro de transporte: antes dos 3 min nada; a linha não se repete dentro do mesmo intervalo; retomadas de MAIS de uma hora não contam", () => {
    expect(quietLadderStep(f({ quietForMs: 2 * MIN, transportError: "API Error" }), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(f({ quietForMs: 10 * MIN, transportError: "API Error" }), memo({ retriedAt: [NOW - MIN] }), S, NOW)).toEqual({ kind: "none" });
    const old = [NOW - TRANSPORT_RETRY_WINDOW_MS - MIN, NOW - TRANSPORT_RETRY_WINDOW_MS - 2 * MIN];
    expect(quietLadderStep(f({ quietForMs: 3 * MIN, transportError: "API Error" }), memo({ retriedAt: old }), S, NOW)).toEqual({ kind: "transport-retry", attempt: 1 });
    // `transportRetries: 0` é o jeito declarado de estacionar direto
    expect(quietLadderStep(f({ quietForMs: 3 * MIN, transportError: "API Error" }), undefined, { ...S, transportRetries: 0 }, NOW)).toEqual({ kind: "park", cause: "transport" });
  });

  it("quieto + fila esperando vaga ⇒ UM lembrete aos 10 min; quieto de novo 10 min depois dele ⇒ estacionar", () => {
    const quiet = (min: number) => f({ quietForMs: min * MIN, slotWaiters: 3 });
    expect(quietLadderStep(quiet(9), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(quiet(10), undefined, S, NOW)).toEqual({ kind: "nudge" });
    // lembrado há 5 min: ainda dentro do prazo
    expect(quietLadderStep(quiet(15), memo({ nudgedAt: NOW - 5 * MIN }), S, NOW)).toEqual({ kind: "none" });
    // trabalhou depois do lembrete (quieto há só 4 min): o prazo conta da quietude, não do lembrete
    expect(quietLadderStep(quiet(4), memo({ nudgedAt: NOW - 30 * MIN }), S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(quiet(20), memo({ nudgedAt: NOW - 10 * MIN }), S, NOW)).toEqual({ kind: "park", cause: "quiet" });
  });

  it("sem fila, com pausa declarada, com prompt desenhado, trabalhando (quietForMs null) ou já pedido ⇒ nada", () => {
    const long = 60 * MIN;
    expect(quietLadderStep(f({ quietForMs: long, slotWaiters: 0 }), undefined, S, NOW)).toEqual({ kind: "none" });
    // a pausa declarada segura a vaga enquanto dentro do prazo dela (story-ex9602 — o caso de mais de 30 min está abaixo)
    expect(quietLadderStep(f({ quietForMs: 20 * MIN, slotWaiters: 2, declaredWaiting: true }), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(f({ quietForMs: long, slotWaiters: 2, asking: true }), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(f({ quietForMs: null, slotWaiters: 2, transportError: "API Error" }), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(f({ quietForMs: long, slotWaiters: 2 }), memo({ askedAt: NOW - MIN }), S, NOW)).toEqual({ kind: "none" });
  });

  // Revisão do WP5-F2: o filho vivo segura a vaga só por um tempo — a suíte em segundo plano é trabalho; um dev server
  // esquecido, um watcher ou um MCP stdio não podem segurá-la para sempre.
  it("filho vivo no pane (a suíte em segundo plano): o lembrete espera a janela do filho; passada ela, a escada segue", () => {
    const window = CHILD_WORK_WINDOW_FACTOR * S.afterMinutes;
    const busy = (min: number) => f({ quietForMs: min * MIN, slotWaiters: 3, childBusy: true });
    expect(quietLadderStep(busy(10), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(busy(window - 1), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(busy(window), undefined, S, NOW)).toEqual({ kind: "nudge" });
    // filho vivo há 1 h, transcript parado há 1 h: o processo esquecido não esconde o condutor
    expect(quietLadderStep(busy(60), undefined, S, NOW)).toEqual({ kind: "nudge" });
    expect(quietLadderStep(busy(60), memo({ nudgedAt: NOW - 15 * MIN }), S, NOW)).toEqual({ kind: "park", cause: "quiet" });
    // depois do lembrete, quieto de novo com o filho vivo: a janela vale de novo antes de estacionar
    expect(quietLadderStep(busy(12), memo({ nudgedAt: NOW - 15 * MIN }), S, NOW)).toEqual({ kind: "none" });
  });

  // story-ex9602 — a espera declarada (report_progress waiting) que fica parada no terminal: nenhum item no Inbox e a
  // vaga presa enquanto há fila.
  it("espera DECLARADA sem prazo, quieta além de declaredAfterMinutes com fila ⇒ estacionar «declared»; sem fila, nada", () => {
    const declared = (min: number, over: Partial<QuietLadderFacts> = {}) => f({ quietForMs: min * MIN, slotWaiters: 1, declaredWaiting: true, ...over });
    expect(quietLadderStep(declared(S.declaredAfterMinutes - 1), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(declared(S.declaredAfterMinutes), undefined, S, NOW)).toEqual({ kind: "park", cause: "declared" });
    expect(quietLadderStep(declared(120, { slotWaiters: 0 }), undefined, S, NOW)).toEqual({ kind: "none" });
    // nunca o lembrete: a espera foi declarada — o próximo degrau é estacionar
    expect(quietLadderStep(declared(S.declaredAfterMinutes), memo({ nudgedAt: NOW - MIN }), S, NOW)).toEqual({ kind: "park", cause: "declared" });
  });

  it("espera declarada COM prazo no futuro é respeitada até o prazo; vencido, segue a régua", () => {
    const withUntil = (until: number) => f({ quietForMs: 90 * MIN, slotWaiters: 2, declaredWaiting: true, declaredUntilMs: until });
    expect(quietLadderStep(withUntil(NOW + 5 * MIN), undefined, S, NOW)).toEqual({ kind: "none" });
    expect(quietLadderStep(withUntil(NOW - MIN), undefined, S, NOW)).toEqual({ kind: "park", cause: "declared" });
  });

  it("a linha do estacionar declarado manda transformar a espera numa pergunta do dono e não carrega texto de quem chamou", () => {
    const line = ladderLine({ kind: "park", cause: "declared" });
    expect(line).toBe(DECLARED_PARK_LINE);
    expect(line).toContain("ask_question");
    expect(line).toContain("[humano]");
    expect(line).toContain("worktree_discard");
    expect(line).not.toContain("${");
  });

  it("filho vivo NÃO segura o estacionar por espera do dono (como antes do F2) nem a retomada de um turno cortado", () => {
    expect(quietLadderStep(f({ quietForMs: 10 * MIN, ownerWait: true, childBusy: true }), undefined, S, NOW)).toEqual({ kind: "park", cause: "owner" });
    expect(quietLadderStep(f({ quietForMs: 3 * MIN, transportError: "API Error", childBusy: true }), undefined, S, NOW)).toEqual({ kind: "transport-retry", attempt: 1 });
  });

  it("espera do dono: estaciona depois da carência (a fatia 2), com ou sem fila", () => {
    expect(quietLadderStep(f({ quietForMs: 10 * MIN, ownerWait: true }), undefined, S, NOW)).toEqual({ kind: "park", cause: "owner" });
    expect(quietLadderStep(f({ quietForMs: 9 * MIN, ownerWait: true, slotWaiters: 4 }), undefined, S, NOW)).toEqual({ kind: "none" });
  });

  it("ladderGraceMs — o prazo que a escada ainda tem (o vigia só avisa depois dele): sem fila nem erro ⇒ 0; com filho vivo, inclui a janela dele", () => {
    expect(ladderGraceMs(S, { transportError: false, slotWaiters: 0, childBusy: true })).toBe(0);
    expect(ladderGraceMs(S, { transportError: false, slotWaiters: 2, childBusy: false })).toBe((S.nudgeAfterMinutes + S.afterMinutes) * MIN);
    expect(ladderGraceMs(S, { transportError: false, slotWaiters: 2, childBusy: true })).toBe((CHILD_WORK_WINDOW_FACTOR * S.afterMinutes + S.afterMinutes) * MIN);
    expect(ladderGraceMs(S, { transportError: true, slotWaiters: 0, childBusy: false })).toBe(Math.max(S.nudgeAfterMinutes + S.afterMinutes, (S.transportRetries + 1) * S.transportRetryAfterMinutes) * MIN);
  });

  it("as linhas são fixas, de uma linha só; o registro diz o porquê e o estacionar tem «Desfazer»", () => {
    for (const line of [TRANSPORT_RETRY_LINE, NUDGE_LINE, QUIET_PARK_LINE]) expect(line).not.toMatch(/\n/);
    expect(TRANSPORT_RETRY_LINE).toMatch(/^continuar — sua resposta anterior foi cortada/);
    expect(NUDGE_LINE).toMatch(/report_progress/);
    expect(QUIET_PARK_LINE).toMatch(/^estacionar — /);
    expect(QUIET_PARK_LINE).toMatch(/NÃO limpe o driver/);
    const ctx = { board: "b", card: { id: "story-x", title: "Calcular o frete" }, quietMin: 12, transportError: "API Error: x", slotWaiters: 2, retries: 2, at: "2026-10-01T20:10:00Z", id: "d1" };
    expect(ladderDecision({ kind: "transport-retry", attempt: 1 }, ctx)).toMatchObject({ kind: "stall-retry", what: expect.stringMatching(/erro de API \(1\/2\)/) });
    expect(ladderDecision({ kind: "nudge" }, ctx)).toMatchObject({ kind: "stall-retry", why: expect.stringMatching(/2 card\(s\) na fila/) });
    expect(ladderDecision({ kind: "park", cause: "quiet" }, ctx)).toMatchObject({ kind: "conductor-park", undo: { kind: "resume-conductor", cardId: "story-x" } });
  });
});

function ladderWorld(opts: { card: Card; quietMin: () => number | null; transportError?: () => string | null; waiters?: number; claude?: boolean }) {
  let t = Date.UTC(2026, 9, 1, 20, 5);
  const delivered: string[] = [];
  const decisions: SystemDecision[] = [];
  const requeued: Array<[string, string, "resume" | "yield"]> = [];
  const sessions = [session()];
  const live = new Set(["agent-conductor-story-x-ab12"]);
  const deps: ConductorParkDeps = {
    sessions: async () => sessions,
    liveTmux: async () => live,
    heartbeatAlive: () => true,
    readCard: async () => opts.card,
    readBoardConfig: async () => config(),
    runsClaude: async () => opts.claude ?? true,
    deliver: async (_tmux, text) => {
      delivered.push(text);
      return true;
    },
    settings: () => DEFAULT_PARK_SETTINGS,
    quietForMs: () => {
      const m = opts.quietMin();
      return m == null ? null : m * MIN;
    },
    asking: () => false,
    transportError: () => opts.transportError?.() ?? null,
    slotWaiters: () => opts.waiters ?? 0,
    requeue: async (b, c, place) => void requeued.push([b, c, place]),
    record: async (e) => void decisions.push(e),
    newId: () => `d${decisions.length + 1}`,
    state: new Map(),
    now: () => t,
    log: () => {},
  };
  return { deps, delivered, decisions, requeued, sessions, live, tick: (min: number) => void (t += min * MIN) };
}

describe("parkWaitingConductors — a escada no passe do tick (sem tocar sessão viva: tudo por deps falsas)", () => {
  it("o caso real: «API Error» + prompt há 3 min ⇒ retoma 2x, a 3ª estaciona; cada degrau fica registrado", async () => {
    let quiet = 3;
    const w = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => quiet, transportError: () => "API Error: The response stopped arriving." });
    expect((await parkWaitingConductors(w.deps)).retried).toEqual([{ board: "b", cardId: "story-x", tmuxSession: "agent-conductor-story-x-ab12", attempt: 1 }]);
    expect(w.delivered).toEqual([TRANSPORT_RETRY_LINE]);
    // o passe seguinte (1 min depois) não repete a linha
    w.tick(1);
    quiet = 4;
    await parkWaitingConductors(w.deps);
    expect(w.delivered).toHaveLength(1);
    // o erro voltou: depois do intervalo, a 2ª retomada; e depois dela, estacionar
    w.tick(3);
    quiet = 3;
    await parkWaitingConductors(w.deps);
    w.tick(3);
    const last = await parkWaitingConductors(w.deps);
    expect(w.delivered).toEqual([TRANSPORT_RETRY_LINE, TRANSPORT_RETRY_LINE, QUIET_PARK_LINE]);
    expect(last.asked).toEqual([{ board: "b", cardId: "story-x", tmuxSession: "agent-conductor-story-x-ab12", cause: "transport" }]);
    expect(w.decisions.map((d) => d.kind)).toEqual(["stall-retry", "stall-retry", "conductor-park"]);
    expect(w.decisions[2].undo).toEqual({ kind: "resume-conductor", cardId: "story-x" });
    // pedido feito: mais nada é digitado
    w.tick(30);
    await parkWaitingConductors(w.deps);
    expect(w.delivered).toHaveLength(3);
  });

  it("quieto com fila esperando vaga ⇒ lembrete, depois estacionar; quando a sessão sai, o card volta à fila CEDENDO a vez a quem esperava", async () => {
    let quiet = 10;
    const w = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => quiet, waiters: 3 });
    expect((await parkWaitingConductors(w.deps)).nudged).toHaveLength(1);
    expect(w.delivered).toEqual([NUDGE_LINE]);
    w.tick(10);
    quiet = 20;
    expect((await parkWaitingConductors(w.deps)).asked).toMatchObject([{ cause: "quiet" }]);
    expect(w.delivered).toEqual([NUDGE_LINE, QUIET_PARK_LINE]);
    // o condutor estacionou: worktree_discard tirou a linha do registro
    w.sessions.length = 0;
    expect((await parkWaitingConductors(w.deps)).requeued).toEqual([{ board: "b", cardId: "story-x" }]);
    expect(w.requeued).toEqual([["b", "story-x", "yield"]]);
    expect(w.deps.state.size).toBe(0);
  });

  it("o estacionado por erro de transporte volta na FRENTE (trabalho interrompido pela infraestrutura); o que espera o dono volta pelo acordar", async () => {
    const api = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => 3, transportError: () => "API Error" });
    api.deps.settings = () => ({ ...DEFAULT_PARK_SETTINGS, transportRetries: 0 });
    await parkWaitingConductors(api.deps);
    api.sessions.length = 0;
    await parkWaitingConductors(api.deps);
    expect(api.requeued).toEqual([["b", "story-x", "resume"]]);

    const owner = ladderWorld({ card: cardOf("desenvolver", [q("q1", "money")]), quietMin: () => 30 });
    await parkWaitingConductors(owner.deps);
    expect(owner.delivered).toEqual([PARK_LINE]);
    owner.sessions.length = 0;
    await parkWaitingConductors(owner.deps);
    expect(owner.requeued).toEqual([]);
  });

  // story-ex9602 — de ponta a ponta: espera declarada sem pergunta do dono, a vaga presa com fila. O passe pede para estacionar com a linha que manda virar pergunta do dono; se o condutor a fez,
  // o card volta pelo acordar (a resposta); se não fez, volta à fila CEDENDO a vez (nunca na frente — senão re-segura a vaga).
  it("espera declarada longa com fila ⇒ estacionar «declared»; virou pergunta do dono ⇒ volta pelo acordar; não virou ⇒ fila, cedendo a vez", async () => {
    const card = cardOf("desenvolver");
    const w = ladderWorld({ card, quietMin: () => DEFAULT_PARK_SETTINGS.declaredAfterMinutes, waiters: 1 });
    w.sessions[0] = { ...w.sessions[0], progress: { phase: "moldar", at: "2026-10-01T19:00:00Z", phaseSince: "2026-10-01T19:00:00Z", waiting: "o operador renovar uma credencial no painel do provedor" } };
    expect((await parkWaitingConductors(w.deps)).asked).toMatchObject([{ cause: "declared" }]);
    expect(w.delivered).toEqual([DECLARED_PARK_LINE]);
    expect(w.decisions.map((d) => d.kind)).toEqual(["conductor-park"]);
    expect(w.decisions[0].why).toMatch(/pergunta sua no card/);

    // o condutor transformou a espera numa pergunta do dono e saiu: não volta à fila — volta quando o dono responder
    const asked = cardOf("desenvolver", [q("q1", "owner")]);
    w.deps.readCard = async () => asked;
    w.sessions.length = 0;
    await parkWaitingConductors(w.deps);
    expect(w.requeued).toEqual([]);

    // outro condutor, que estacionou SEM fazer a pergunta: volta à fila cedendo a vez
    const bare = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => DEFAULT_PARK_SETTINGS.declaredAfterMinutes, waiters: 1 });
    bare.sessions[0] = { ...bare.sessions[0], progress: { phase: "construir", at: "2026-10-01T19:00:00Z", phaseSince: "2026-10-01T19:00:00Z", waiting: "algo" } };
    await parkWaitingConductors(bare.deps);
    bare.sessions.length = 0;
    await parkWaitingConductors(bare.deps);
    expect(bare.requeued).toEqual([["b", "story-x", "yield"]]);
  });

  it("o processo esquecido (filho vivo há 1 h, transcript parado há 1 h) não segura a vaga: com fila, o lembrete sai", async () => {
    const w = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => 60, waiters: 2 });
    w.deps.childBusy = () => true;
    expect((await parkWaitingConductors(w.deps)).nudged).toHaveLength(1);
    // dentro da janela do filho (a suíte em segundo plano), nada
    const suite = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => 12, waiters: 2 });
    suite.deps.childBusy = () => true;
    await parkWaitingConductors(suite.deps);
    expect(suite.delivered).toEqual([]);
  });

  it("sem fila ninguém é incomodado; pane que não roda o claude não recebe nada (e tenta de novo depois)", async () => {
    const calm = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => 60, waiters: 0 });
    await parkWaitingConductors(calm.deps);
    expect(calm.delivered).toEqual([]);
    const shell = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => 60, waiters: 2, claude: false });
    await parkWaitingConductors(shell.deps);
    expect(shell.delivered).toEqual([]);
    expect(shell.decisions).toEqual([]);
    expect(shell.deps.state.size).toBe(0);
  });

  it("um card que ganhou pergunta aberta enquanto estacionava não volta à fila pelo passe — o acordar o traz quando for respondida", async () => {
    const w = ladderWorld({ card: cardOf("desenvolver"), quietMin: () => 3, transportError: () => "API Error" });
    w.deps.settings = () => ({ ...DEFAULT_PARK_SETTINGS, transportRetries: 0 });
    await parkWaitingConductors(w.deps);
    w.deps.readCard = async () => cardOf("desenvolver", [q("q9", "technical")]);
    w.sessions.length = 0;
    await parkWaitingConductors(w.deps);
    expect(w.requeued).toEqual([]);
  });
});

// ── O BOARD FOI PAUSADO COM «PARAR AGORA» (board-pace.ts) ────────────────────────────────────────────
describe("parkBoardConductors — a pausa «parar agora» pede a cada condutor do board que guarde e encerre", () => {
  const working = cardOf("desenvolver");

  it("o condutor TRABALHANDO também recebe o pedido (uma vez), e a sessão que sai devolve o card à FRENTE da fila", async () => {
    // quietMin null = trabalhando: a escada sozinha nunca falaria com ele
    const w = ladderWorld({ card: working, quietMin: () => null });
    expect(await parkBoardConductors(w.deps, "b")).toEqual([{ cardId: "story-x", tmuxSession: "agent-conductor-story-x-ab12" }]);
    expect(w.delivered).toEqual([PACE_PARK_LINE]);
    expect(await parkBoardConductors(w.deps, "b")).toEqual([]); // uma vez por sessão
    await parkWaitingConductors(w.deps); // a escada não repete o pedido
    expect(w.delivered).toHaveLength(1);

    // o condutor estacionou e saiu: o card volta na frente (trabalho interrompido), não cedendo a vez
    w.sessions.length = 0;
    w.live.clear();
    expect((await parkWaitingConductors(w.deps)).requeued).toEqual([{ board: "b", cardId: "story-x" }]);
    expect(w.requeued).toEqual([["b", "story-x", "resume"]]);
  });

  it("só o board pausado; quem tem um prompt na tela, ou não roda o claude, não recebe texto", async () => {
    const other = ladderWorld({ card: working, quietMin: () => null });
    expect(await parkBoardConductors(other.deps, "outro-board")).toEqual([]);
    expect(other.delivered).toEqual([]);

    const asking = ladderWorld({ card: working, quietMin: () => 1 });
    expect(await parkBoardConductors({ ...asking.deps, asking: () => true }, "b")).toEqual([]);
    expect(asking.delivered).toEqual([]);

    const shell = ladderWorld({ card: working, quietMin: () => null, claude: false });
    expect(await parkBoardConductors(shell.deps, "b")).toEqual([]);
    expect(shell.delivered).toEqual([]);
  });

  it("sonda do tmux sem resposta: ninguém é incomodado; uma porta que lança não derruba quem chama", async () => {
    const w = ladderWorld({ card: working, quietMin: () => null });
    expect(await parkBoardConductors({ ...w.deps, liveTmux: async () => null }, "b")).toEqual([]);
    expect(
      await parkBoardConductors(
        {
          ...w.deps,
          sessions: async () => {
            throw new Error("registro fora");
          },
        },
        "b",
      ),
    ).toEqual([]);
    expect(w.delivered).toEqual([]);
  });
});
