import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, StatusDef } from "./types";
import type { MergeQueueEntry, RunnerRun } from "./runner/types";
import { conductorQuiet } from "./runner/conductor-quiet";
import { PRESENCE_FRESH_MS, agentPulse, latestActivity, reduceAgentPresence, sessionPresence, workingAgents } from "./agent-presence";
import { cardLiveFactsFor, countPresence, projectCardLiveStatus, type CardLiveFeed, type CardSessionFact, type TerminalWaitFact } from "./card-live-status";

// Um retrato vivo inventado da frota: dois condutores com relato, cinco cards na fila esperando vaga, os dois terminais
// do dono (`claude` e `shell`) e um condutor que sobrou com a pasta de trabalho apagada.
const NOW = Date.parse("2026-03-12T15:40:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

const session = (over: Partial<CardSessionFact> = {}): CardSessionFact => ({
  board: "armazem",
  cardId: "story-cond-a",
  sessionId: "s-alfa",
  role: "implement",
  conductor: true,
  tmuxSession: "agent-conductor-story-cond-a-k3",
  openedAt: iso(NOW - min(68)),
  heartbeatAt: iso(NOW - 5_000), // o tick da frota acabou de passar — para TODOS os tmux vivos
  ...over,
});

const LIVE_FEED: CardLiveFeed = {
  at: NOW,
  sessions: [
    // «Aguardo a suíte … (59s)»: a tela trabalhando, relato de publicar há 1 min
    session({ busy: true, progress: { phase: "publicar", at: "2026-03-12T15:38:57.000Z", phaseSince: "2026-03-12T15:12:00.000Z" } }),
    // relato de verificar há 6 min, mas o transcript foi escrito há 30 s
    session({
      cardId: "story-cond-b",
      sessionId: "s-beta",
      tmuxSession: "agent-conductor-story-cond-b-q7",
      lastActivityAt: iso(NOW - 30_000),
      progress: { phase: "verificar", at: "2026-03-12T15:33:20.000Z", phaseSince: "2026-03-12T15:33:20.000Z" },
    }),
    // o condutor que já entregou: o tmux sobrou com a pasta apagada — não é agente
    session({ cardId: "story-cond-zumbi", sessionId: "zumbi", tmuxSession: "agent-conductor-story-cond-zumbi-z9", zombie: true, lastActivityAt: iso(NOW - 30_000) }),
  ],
  queue: ["fila-a", "fila-b", "fila-c", "fila-d", "fila-e"].map((id, i) => ({
    board: "armazem",
    cardId: `story-${id}`,
    position: i + 1,
    total: 5,
    queuedAt: iso(NOW - min(150 - i * 12)),
    waitKind: "slots",
    waitReason: "2 condutor(es) vivo(s) no board — esperando uma vaga",
  })),
  throttles: [],
  judging: [],
};

// os terminais do dono, vistos pelo vigia: um parado no prompt e um anexado, perguntando
const OWNER_TERMINALS: TerminalWaitFact[] = [
  { session: "claude", kind: "idle", since: NOW - min(300) },
  { session: "shell", kind: "asking", since: NOW - min(2) },
];

describe("reduceAgentPresence — o golden de um retrato vivo da frota", () => {
  const p = reduceAgentPresence({ feed: LIVE_FEED, terminals: OWNER_TERMINALS }, NOW);

  it("2 agentes, os 2 trabalhando — os terminais do dono e o zumbi ficam fora", () => {
    expect(p.agents.map((a) => a.cardId).sort()).toEqual(["story-cond-a", "story-cond-b"]);
    expect(p.agents.every((a) => a.presence.state === "working")).toBe(true);
    expect(p.agents.some((a) => a.tmuxSession === "claude" || a.tmuxSession === "shell")).toBe(false);
    expect(p.totals).toEqual({ agents: 2, working: 2, quiet: 0, asking: 0, waiting: 0, queued: 5 });
  });

  it("a fila sai na ordem de despacho, com o motivo da espera", () => {
    expect(p.queued.map((q) => q.position)).toEqual([1, 2, 3, 4, 5]);
    expect(p.queued.every((q) => q.waitKind === "slots")).toBe(true);
  });

  it("o condutor diz o bloco que relatou", () => {
    expect(p.agents.find((a) => a.cardId === "story-cond-b")).toMatchObject({ kind: "conductor", phase: "verificar" });
  });

  it("as vagas passam adiante quando o feed as traz (o campo é opcional)", () => {
    expect(p.slots).toEqual([]);
    const slots = [{ board: "armazem", used: 2, max: 2, extra: { open: false, why: "a fila de integração tem 1 entrada" } }];
    expect(reduceAgentPresence({ feed: { ...LIVE_FEED, slots } }, NOW).slots).toEqual(slots);
  });

  it("o juiz da triagem julgando é um agente trabalhando — o card dele pinta «Agindo», o nav conta", () => {
    const r = reduceAgentPresence({ feed: { ...LIVE_FEED, judging: ["armazem/story-juiz"] } }, NOW);
    expect(r.agents.find((a) => a.kind === "judge")).toMatchObject({ key: "judge:armazem/story-juiz", board: "armazem", cardId: "story-juiz", presence: { state: "working" } });
    expect(r.totals.working).toBe(3);
  });

  it("uma execução do motor viva é um agente trabalhando", () => {
    const running = [{ board: "armazem", cardId: "story-run", startedAt: NOW - min(3) }] as RunnerRun[];
    const r = reduceAgentPresence({ feed: LIVE_FEED, running }, NOW);
    expect(r.agents.find((a) => a.kind === "run")).toMatchObject({ key: "run:armazem/story-run", presence: { state: "working", since: NOW - min(3) } });
    expect(r.totals.working).toBe(3);
  });

  it("sem feed nenhum: zero, nunca lança", () => {
    expect(reduceAgentPresence({}, NOW).totals).toEqual({ agents: 0, working: 0, quiet: 0, asking: 0, waiting: 0, queued: 0 });
  });
});

describe("sessionPresence — a regra, na ordem", () => {
  const relato = (agoMin: number, over = {}) => ({ phase: "construir" as const, at: iso(NOW - min(agoMin)), phaseSince: iso(NOW - min(agoMin + 30)), ...over });

  it("relato de 45 min + tela no prompt há 30 min ⇒ quieto, desde a última atividade", () => {
    const s = session({ progress: relato(45) });
    expect(sessionPresence(s, { terminal: { session: s.tmuxSession!, kind: "idle", since: NOW - min(30) } }, NOW)).toEqual({ state: "quiet", since: NOW - min(45) });
  });

  it("heartbeat fresco com o transcript parado ⇒ quieto (o heartbeat é prova de VIDA, não de trabalho)", () => {
    const s = session({ heartbeatAt: iso(NOW), lastActivityAt: iso(NOW - min(40)) });
    expect(sessionPresence(s, {}, NOW)).toEqual({ state: "quiet", since: NOW - min(40) });
  });

  it("sem prova nenhuma, quieto desde que a sessão abriu", () => {
    expect(sessionPresence(session(), {}, NOW)).toEqual({ state: "quiet", since: NOW - min(68) });
  });

  it("asking vence tudo — a espera declarada, a tela trabalhando, o relato fresco", () => {
    const s = session({ busy: true, progress: relato(0, { waiting: "a janela da conta" }) });
    expect(sessionPresence(s, { terminal: { session: s.tmuxSession!, kind: "asking", since: NOW - min(4) } }, NOW)).toEqual({ state: "asking", since: NOW - min(4) });
  });

  it("a espera declarada, com a hora da volta", () => {
    const until = iso(NOW + min(40));
    expect(sessionPresence(session({ progress: relato(3, { waiting: "a janela da conta", until }) }), {}, NOW)).toEqual({
      state: "waiting",
      waitingFor: "a janela da conta",
      until: Date.parse(until),
      since: NOW - min(3),
    });
  });

  it("o limite de ações do board fechado DEPOIS do último relato ⇒ esperando; um relato mais novo ⇒ não", () => {
    const throttle = { board: "armazem", at: iso(NOW - min(5)), until: iso(NOW + min(20)) };
    expect(sessionPresence(session({ progress: relato(9) }), { throttle }, NOW)).toEqual({ state: "waiting", throttled: true, until: NOW + min(20) });
    expect(sessionPresence(session({ progress: relato(1) }), { throttle }, NOW).state).toBe("working");
  });

  it("a tela trabalhando agora ⇒ trabalhando «agora», por mais velha que seja a última escrita", () => {
    expect(sessionPresence(session({ busy: true, lastActivityAt: iso(NOW - min(9)) }), {}, NOW)).toEqual({ state: "working", since: NOW });
  });

  it("a fronteira: atividade há menos de PRESENCE_FRESH_MS trabalha; exatamente nela, já é quieto", () => {
    expect(sessionPresence(session({ lastActivityAt: iso(NOW - PRESENCE_FRESH_MS + 1) }), {}, NOW).state).toBe("working");
    expect(sessionPresence(session({ lastActivityAt: iso(NOW - PRESENCE_FRESH_MS) }), {}, NOW).state).toBe("quiet");
  });
});

describe("PRESENCE_FRESH_MS é a MESMA janela de conductorQuiet (um número só para «quieto» e «trabalhando»)", () => {
  const fake = (mtime: number, screen: string) => ({ capture: async () => screen, mtimeMs: async () => mtime });
  const atPrompt = "resposta anterior\n\n❯ \n";
  const s = { tmuxSession: "agent-x", transcriptFile: "/t.jsonl" };

  it("transcript mais novo que a janela: conductorQuiet nem olha a tela — é trabalho para os dois", async () => {
    expect((await conductorQuiet(s, undefined, NOW, fake(NOW - PRESENCE_FRESH_MS + 1, atPrompt))).quietForMs).toBeNull();
  });

  it("transcript exatamente na janela, tela no prompt: quieto para os dois", async () => {
    expect((await conductorQuiet(s, undefined, NOW, fake(NOW - PRESENCE_FRESH_MS, atPrompt))).quietForMs).toBe(PRESENCE_FRESH_MS);
    expect(sessionPresence(session({ lastActivityAt: iso(NOW - PRESENCE_FRESH_MS) }), {}, NOW).state).toBe("quiet");
  });
});

describe("latestActivity", () => {
  it("o mais novo entre ISO e epoch; ilegíveis não contam", () => {
    expect(latestActivity(iso(NOW - min(5)), NOW - min(2), "lixo", null, undefined)).toBe(NOW - min(2));
    expect(latestActivity(null, "")).toBeUndefined();
  });
});

describe("uma régua só: o nº de agentes trabalhando bate com os cards que a linha diz «trabalhando»", () => {
  const st = (id: string, over: Partial<StatusDef> = {}) => ({ id, name: id, ...over }) as StatusDef;
  const CONFIG: Pick<BoardConfig, "statuses"> = { statuses: [st("desenvolver"), st("concluida", { terminal: true })] };
  const card = (id: string) => ({ id, status: "desenvolver" }) as Card;

  it("com o mesmo retrato: totals.working == cards com linha working|run; totals.queued == a fila do feed", () => {
    const feed: CardLiveFeed = {
      ...LIVE_FEED,
      sessions: [
        ...LIVE_FEED.sessions,
        session({ cardId: "story-estacionado", sessionId: "p", tmuxSession: "agent-p", progress: { phase: "construir", at: iso(NOW - min(40)), phaseSince: iso(NOW - min(60)) } }),
      ],
    };
    const running = [{ board: "armazem", cardId: "story-run", trigger: "harness-do", startedAt: NOW - min(3) }] as RunnerRun[];
    const presence = reduceAgentPresence({ feed, running, terminals: OWNER_TERMINALS }, NOW);
    const cardIds = [...new Set([...feed.sessions.map((s) => s.cardId), ...feed.queue.map((q) => q.cardId), "story-run"])];
    const kinds = cardIds.map((id) => projectCardLiveStatus(card(id), CONFIG, cardLiveFactsFor("armazem", id, { running, feed, terminals: OWNER_TERMINALS }), NOW)?.kind);
    expect(presence.totals.working).toBe(kinds.filter((k) => k === "working" || k === "run").length);
    expect(presence.totals.quiet).toBe(kinds.filter((k) => k === "quiet").length);
    expect(presence.totals.queued).toBe(kinds.filter((k) => k === "queued").length);
  });

  // REESCRITO de propósito (revisão posterior). O teste antigo afirmava «Agentes N == cards com presença working» num
  // retrato sem decisão do dono, sem integração e sem juiz — o único em que as duas contas coincidem. Elas contam coisas
  // diferentes: o nav conta AGENTES; a legenda conta CARDS por cor, e a cor do card segue a precedência da linha (a
  // decisão do dono e a integração vencem a sessão que trabalha). Com os três casos que a revisão reproduziu, o nav dizia
  // «Agentes 1» e o pulso «0 agindo» (a, b), ou «Agentes 0» e «1 agindo» (c). O invariante VERDADEIRO, agora imposto:
  //   • o número de agentes é UMA função (agentPulse) — o nav lê a frota inteira, o pulso do board lê o recorte dele, e
  //     a soma dos recortes é o nav;
  //   • nenhum card pinta «Agindo» sem um agente trabalhando nele (o juiz da triagem é um agente);
  //   • a fila do pulso é a fila do condutor, não os cards cuja linha calhou de ser «na fila».
  it("o nav e o pulso do board leem a MESMA conta de agentes — com decisão do dono, integração andando e juiz", () => {
    const feed: CardLiveFeed = {
      ...LIVE_FEED,
      sessions: [
        ...LIVE_FEED.sessions,
        // (a) um condutor trabalhando num card que está em Decidir — a linha do card é a do dono
        session({ cardId: "story-dono", sessionId: "d", tmuxSession: "agent-d", lastActivityAt: iso(NOW - 20_000) }),
        // (b) o condutor no PUBLICAR esperando o train: a tela trabalhando, a entrada do train `merging`
        session({ cardId: "story-pub", sessionId: "pb", tmuxSession: "agent-pb", busy: true, progress: { phase: "publicar", at: iso(NOW - min(1)), phaseSince: iso(NOW - min(9)) } }),
        // um agente de OUTRO board — entra no nav, não no pulso deste board
        session({ board: "outro-board", cardId: "story-outro", sessionId: "o", tmuxSession: "agent-o", lastActivityAt: iso(NOW - 10_000) }),
      ],
      // (c) o juiz da triagem julgando um card
      judging: ["armazem/story-juiz"],
    };
    const mergeEntries = [{ runId: "pb", board: "armazem", cardId: "story-pub", branch: "agent/pb", status: "merging", enqueuedAt: NOW - min(2), mergeStartedAt: NOW - min(1) }] as unknown as MergeQueueEntry[];
    const running = [{ board: "armazem", cardId: "story-run", trigger: "harness-do", startedAt: NOW - min(3) }] as RunnerRun[];
    const presence = reduceAgentPresence({ feed, running, terminals: OWNER_TERMINALS }, NOW);

    const ownerOf = new Set(["story-dono", feed.queue[0].cardId]); // um card da fila também em Decidir: a linha é do dono
    const cardIds = ["story-cond-a", "story-cond-b", "story-cond-zumbi", "story-run", "story-dono", "story-pub", "story-juiz", ...feed.queue.map((q) => q.cardId)];
    const statuses = new Map(
      cardIds.map((id) => {
        const facts = cardLiveFactsFor("armazem", id, { running, mergeEntries, feed, terminals: OWNER_TERMINALS });
        const ownerDecision = ownerOf.has(id) ? { label: "Aceitar?", itemId: `${id}:review` } : null;
        return [id, projectCardLiveStatus(card(id), CONFIG, { ...facts, ownerDecision }, NOW)] as const;
      }),
    );

    // a precedência da linha: (a) é do dono, (b) é da integração, (c) é do juiz
    expect(statuses.get("story-dono")?.presence).toBe("owner");
    expect(statuses.get("story-pub")?.presence).toBe("delivering");
    expect(statuses.get("story-juiz")).toMatchObject({ kind: "judging", presence: "working" });

    // UMA conta: 2 condutores do golden + execução + (a) + (b) + juiz = 6 no board; + o outro board = 7 no nav
    expect(agentPulse(presence, "armazem").working).toBe(6);
    expect(agentPulse(presence).working).toBe(workingAgents(presence.agents));
    expect(agentPulse(presence).working).toBe(agentPulse(presence, "armazem").working + agentPulse(presence, "outro-board").working);
    // a fila do pulso é a do condutor (5), mesmo com um card da fila pintado como «precisa de você»
    expect(agentPulse(presence, "armazem").queued).toBe(5);
    expect(countPresence(statuses.values()).owner).toBe(2);

    // nenhum card pinta «Agindo» sem um agente trabalhando NELE
    const workingCards = new Set(presence.agents.filter((a) => a.board === "armazem" && a.presence.state === "working").map((a) => a.cardId));
    const blue = [...statuses].filter(([, s]) => s?.presence === "working").map(([id]) => id);
    expect(blue.length).toBeGreaterThan(0);
    for (const id of blue) expect(workingCards.has(id)).toBe(true);
    expect(countPresence(statuses.values()).working).toBeLessThanOrEqual(agentPulse(presence, "armazem").working);
  });
});
