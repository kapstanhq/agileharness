import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, StatusDef } from "./types";
import type { MergeQueueEntry, RunnerFailure, RunnerRun } from "./runner/types";
import { bannedTermsIn } from "./inbox/copy";
import {
  CARD_PRESENCE,
  CARD_PRESENCES,
  cardLiveFactsFor,
  cardLiveText,
  countPresence,
  diffWords,
  presencePulses,
  projectCardLiveStatus,
  type CardLiveFacts,
  type CardLiveFeed,
  type CardLiveKind,
  type CardSessionFact,
} from "./card-live-status";

const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
const CONFIG: Pick<BoardConfig, "statuses"> = {
  statuses: [
    st("triage", "Triagem"),
    st("desenvolver", "Desenvolver", { trigger: "harness-do" }),
    st("merge", "Integrar", { autorun: true, laneStep: true }),
    st("deploy", "Publicar", { onEnter: "promote-and-deploy", laneStep: true }),
    st("concluida", "No ar", { terminal: true }),
  ],
};
const card = (over: Partial<Card> = {}) => ({ status: "desenvolver", ...over }) as Card;

// Um instante fixo à noite no servidor (UTC+2); o dono mora num fuso diferente do servidor (UTC−3).
const NOW = Date.parse("2026-09-28T22:20:00.000Z");
const TZ = "America/Sao_Paulo";
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

const conductor = (over: Partial<CardSessionFact> = {}): CardSessionFact => ({
  board: "armazem",
  cardId: "story-ex0004",
  sessionId: "4a9d7e12",
  role: "implement",
  conductor: true,
  tmuxSession: "agent-conductor-story-ex0004-jnme",
  openedAt: iso(NOW - min(20)),
  heartbeatAt: iso(NOW - min(1)),
  ...over,
});

const text = (c: Card, facts: CardLiveFacts) => {
  const s = projectCardLiveStatus(c, CONFIG, facts, NOW);
  return s ? cardLiveText(s, NOW, TZ) : null;
};

describe("projectCardLiveStatus — quem age agora, e fazendo o quê", () => {
  // REESCRITO de propósito (WP4-A): antes o «há N» era o começo do BLOCO («construindo · há 12 min»), e isso não
  // distinguia «trabalha há 12 min» de «parou há 12 min». Agora ele é a última atividade PROVADA.
  it("o condutor que relatou há pouco diz o bloco, e o «há N» é a última atividade (não o começo do bloco)", () => {
    const s = conductor({ progress: { phase: "construir", at: iso(NOW - min(1)), phaseSince: iso(NOW - min(12)), note: "tarefa 3 de 5" } });
    const st = projectCardLiveStatus(card(), CONFIG, { session: s }, NOW)!;
    expect(cardLiveText(st, NOW, TZ)).toBe("Condutor construindo · há 1 min");
    expect(st.note).toBe("tarefa 3 de 5");
    expect(st.actor).toBe("Condutor");
    expect(st.presence).toBe("working");
  });

  it("verificar lê «Condutor verificando»", () => {
    const s = conductor({ progress: { phase: "verificar", at: iso(NOW), phaseSince: iso(NOW) } });
    expect(text(card(), { session: s })).toBe("Condutor verificando · agora");
  });

  // REESCRITO de propósito (WP4-A): «sem relato, trabalhando desde que abriu» afirmava trabalho sem prova nenhuma — o
  // heartbeat de 1 min atrás é o tick da frota vendo o tmux, não o agente trabalhando.
  it("sem relato e sem prova de atividade, o condutor vivo é «parado» desde que abriu — heartbeat fresco não é trabalho", () => {
    const st = projectCardLiveStatus(card(), CONFIG, { session: conductor({ heartbeatAt: iso(NOW) }) }, NOW)!;
    expect(cardLiveText(st, NOW, TZ)).toBe("Condutor parado · há 20 min");
    expect(st).toMatchObject({ kind: "quiet", presence: "waiting" });
  });

  it("a tela trabalhando AGORA é trabalho, mesmo sem relato e com o transcript calado (uma suíte longa)", () => {
    const s = conductor({ busy: true, lastActivityAt: iso(NOW - min(9)) });
    expect(text(card(), { session: s })).toBe("Condutor trabalhando · agora");
  });

  it("atividade provada há menos de 2 min (o transcript) é trabalho, ancorada nela", () => {
    expect(text(card(), { session: conductor({ lastActivityAt: iso(NOW - min(1)) }) })).toBe("Condutor trabalhando · há 1 min");
  });

  describe("presença quieta vence relato velho (prova executada com um terminal ocioso)", () => {
    const relato = (agoMin: number) => ({ phase: "construir" as const, at: iso(NOW - min(agoMin)), phaseSince: iso(NOW - min(100)), note: "tarefa 3 de 5" });
    const idle = (agoMin: number) => ({ session: "agent-conductor-story-ex0004-jnme", kind: "idle" as const, since: NOW - min(agoMin) });
    const cases: Array<[string, CardLiveFacts, string]> = [
      ["relato há 14 min + terminal idle há 14 min", { session: conductor({ progress: relato(14) }), terminal: idle(14) }, "Condutor parado · há 14 min"],
      ["relato há 3 h + terminal idle há 3 h", { session: conductor({ progress: relato(180) }), terminal: idle(180) }, "Condutor parado · há 3 h"],
      ["relato há 3 h, sem fato de terminal (vigia cego)", { session: conductor({ progress: relato(180) }) }, "Condutor parado · há 3 h"],
      ["sem relato + terminal idle há 14 min", { session: conductor(), terminal: idle(14) }, "Condutor parado · há 14 min"],
      ["sem relato + terminal idle há 20 min", { session: conductor(), terminal: idle(20) }, "Condutor parado · há 20 min"],
    ];
    for (const [name, facts, want] of cases) {
      it(`${name} ⇒ «${want}», sem pulso`, () => {
        const st = projectCardLiveStatus(card(), CONFIG, facts, NOW)!;
        expect(cardLiveText(st, NOW, TZ)).toBe(want);
        expect(st.kind).toBe("quiet");
        expect(presencePulses(st.presence)).toBe(false);
      });
    }

    it("o último relato vira a nota: «parado» diz onde parou", () => {
      const st = projectCardLiveStatus(card(), CONFIG, { session: conductor({ progress: relato(45) }) }, NOW)!;
      expect(st.note).toBe("Último relato: construindo · tarefa 3 de 5");
    });

    it("heartbeat fresco com o transcript parado há 40 min ⇒ parado há 40 min", () => {
      const s = conductor({ heartbeatAt: iso(NOW - 5_000), lastActivityAt: iso(NOW - min(40)), progress: relato(45) });
      expect(text(card(), { session: s })).toBe("Condutor parado · há 40 min");
    });
  });

  it("o limite de ações do board fechado depois do último relato ⇒ esperando a janela, com a hora do DONO", () => {
    const s = conductor({ progress: { phase: "construir", at: iso(NOW - min(30)), phaseSince: iso(NOW - min(40)) } });
    const throttle = { board: "armazem", at: iso(NOW - min(5)), until: "2026-09-28T23:00:00.000Z" };
    // 23:00Z = 20:00 no fuso do dono (UTC−3) — nunca a hora do servidor nem a UTC.
    expect(text(card(), { session: s, throttle })).toBe("Esperando a janela de ações · volta às 20:00");
  });

  it("um relato MAIS NOVO que a última ação freada prova que o condutor voltou a andar", () => {
    const s = conductor({ progress: { phase: "construir", at: iso(NOW - min(1)), phaseSince: iso(NOW - min(40)) } });
    const throttle = { board: "armazem", at: iso(NOW - min(5)), until: "2026-09-28T23:00:00.000Z" };
    expect(text(card(), { session: s, throttle })).toBe("Condutor construindo · há 1 min");
  });

  it("uma janela que já abriu não segura ninguém", () => {
    const throttle = { board: "armazem", at: iso(NOW - min(90)), until: iso(NOW - min(20)) };
    expect(text(card(), { session: conductor({ busy: true }), throttle })).toBe("Condutor trabalhando · agora");
  });

  it("a espera dita pelo próprio condutor, com a hora da volta", () => {
    const s = conductor({
      progress: { phase: "construir", at: iso(NOW), phaseSince: iso(NOW - min(9)), waiting: "a janela da conta", until: "2026-09-29T01:30:00.000Z" },
    });
    expect(text(card(), { session: s })).toBe("Esperando a janela da conta · volta às 22:30");
  });

  it("uma volta amanhã diz amanhã", () => {
    const s = conductor({ progress: { phase: "moldar", at: iso(NOW), phaseSince: iso(NOW), waiting: "a vaga de publicação", until: "2026-09-29T10:00:00.000Z" } });
    expect(text(card(), { session: s })).toBe("Esperando a vaga de publicação · volta amanhã às 07:00");
  });

  it("um prompt parado no terminal da sessão trava tudo e diz isso", () => {
    const s = conductor({ progress: { phase: "construir", at: iso(NOW), phaseSince: iso(NOW) } });
    const st = projectCardLiveStatus(card(), CONFIG, { session: s, terminal: { session: s.tmuxSession!, kind: "asking", since: NOW - min(4) } }, NOW)!;
    expect(cardLiveText(st, NOW, TZ)).toBe("Condutor esperando resposta no terminal · há 4 min");
    expect(st.presence).toBe("stopped");
  });

  it("um terminal quieto há muito, sem relato, é «parado» — não «trabalhando»", () => {
    const facts = { session: conductor(), terminal: { session: "agent-conductor-story-ex0004-jnme", kind: "idle" as const, since: NOW - min(18) } };
    expect(text(card(), facts)).toBe("Condutor parado · há 18 min");
  });

  it("uma integração VELHA terminada nunca aparece enquanto o condutor trabalha", () => {
    const merge = [{ status: "done", enqueuedAt: NOW - min(90), runId: "r1" }] as MergeQueueEntry[];
    const st = projectCardLiveStatus(card(), CONFIG, { session: conductor({ busy: true }), merge }, NOW)!;
    expect(cardLiveText(st, NOW, TZ)).toBe("Condutor trabalhando · agora");
    expect(cardLiveText(st, NOW, TZ)).not.toMatch(/Terminou/);
  });

  it("uma execução terminada, sozinha, não é estado atual (é histórico)", () => {
    const merge = [{ status: "done", enqueuedAt: NOW - min(9), runId: "r1" }] as MergeQueueEntry[];
    expect(projectCardLiveStatus(card(), CONFIG, { merge }, NOW)).toBeNull();
  });

  it("a execução do motor rodando agora nomeia o agente e a etapa", () => {
    const run = { trigger: "harness-do", startedAt: NOW - min(3) } as RunnerRun;
    const st = projectCardLiveStatus(card(), CONFIG, { run, session: conductor() }, NOW)!;
    expect(cardLiveText(st, NOW, TZ)).toBe("Agente construindo · há 3 min");
    expect(st.note).toBe("Passo: Desenvolver"); // o glossário único (WP3): «passo», nunca «etapa»
  });

  it("a integração em andamento vence o relato do condutor (ele submeteu; quem age é ela)", () => {
    const s = conductor({ progress: { phase: "publicar", at: iso(NOW - min(6)), phaseSince: iso(NOW - min(6)) } });
    const merging = [{ status: "merging", enqueuedAt: NOW - min(5), mergeStartedAt: NOW - min(2), runId: "r" }] as MergeQueueEntry[];
    expect(text(card(), { session: s, merge: merging })).toBe("Integrando · há 2 min");
    const waiting = [{ status: "waiting", enqueuedAt: NOW - min(5), runId: "r" }] as MergeQueueEntry[];
    expect(text(card(), { session: s, merge: waiting, mergePosition: 2 })).toBe("Na fila da integração · 2º · há 5 min");
  });

  it("a integração parada sem ninguém nela diz o motivo", () => {
    const merge = [{ status: "conflict", enqueuedAt: NOW - min(30), runId: "r" }] as MergeQueueEntry[];
    const st = projectCardLiveStatus(card(), CONFIG, { merge }, NOW)!;
    expect(st.label).toBe("Parado: conflito ao integrar");
    expect(st.presence).toBe("stopped");
  });

  it("a execução que falhou diz o motivo em português", () => {
    const failure = { reason: "timeout", at: NOW - min(7) } as RunnerFailure;
    expect(text(card(), { failure })).toBe("Parado: a execução ficou sem resposta · há 7 min");
  });

  it("a fila do condutor diz a posição e guarda o motivo da espera", () => {
    const queue = { board: "armazem", cardId: "c", position: 2, total: 5, queuedAt: iso(NOW - min(100)), waitKind: "slots", waitReason: "2 condutores vivos no board — esperando uma vaga" };
    const st = projectCardLiveStatus(card(), CONFIG, { queue }, NOW)!;
    expect(st.label).toBe("Na fila do condutor · 2º");
    expect(st.note).toBe(queue.waitReason);
  });

  it("o juiz da triagem decidindo", () => {
    expect(text(card({ status: "triage" }), { judging: true })).toBe("Juiz da triagem decidindo");
  });

  it("publicando só com o disparo carimbado; no ar com a hora da prova", () => {
    const fired = projectCardLiveStatus(card({ status: "deploy", deployFiredAt: iso(NOW - min(4)) }), CONFIG, {}, NOW)!;
    expect(cardLiveText(fired, NOW, TZ)).toBe("Publicando · há 4 min");
    expect(fired).toMatchObject({ kind: "publishing", presence: "delivering", actor: "Publicação" });
    expect(text(card({ status: "concluida", deployProof: { sha: "a", targets: [], at: iso(NOW - min(185)), source: "settle-webhook" } }), {})).toBe("No ar · há 3 h");
  });

  it("no passo de publicação SEM disparo nada está publicando: «Aguardando publicação», a vez do sistema (não pulsa)", () => {
    const st = projectCardLiveStatus(card({ status: "deploy" }), CONFIG, {}, NOW)!;
    expect(cardLiveText(st, NOW, TZ)).toBe("Aguardando publicação");
    expect(st).toMatchObject({ kind: "publishing", presence: "delivering", actor: "Publicação" });
    expect(presencePulses(st.presence)).toBe(false);
    expect(st.since).toBeUndefined();
  });

  it("o disparo carimbado fora do passo de publicação segue lendo «Publicando» (o que já era)", () => {
    expect(text(card({ status: "merge", deployFiredAt: iso(NOW - min(2)) }), {})).toBe("Publicando · há 2 min");
  });

  describe("o card travado — o achado aberto do vigia", () => {
    const stalled = (over: Record<string, unknown> = {}) =>
      [{ id: "card-stalled", lens: "general", severity: "high", status: "open", title: "Parado em «Publicar» sem ninguém cuidando", detail: "Parado desde ontem. O sistema refez o passo uma vez e abriu um card de conserto.", ...over }] as Card["findings"];

    it("no passo de publicação: «Travado em «Publicar»», em alerta — nunca «Publicando», mesmo com o disparo carimbado", () => {
      const st = projectCardLiveStatus(card({ status: "deploy", findings: stalled() }), CONFIG, {}, NOW)!;
      expect(cardLiveText(st, NOW, TZ)).toBe("Travado em «Publicar»");
      expect(st).toMatchObject({ kind: "stopped", presence: "stopped", actor: "Sistema", note: "Parado desde ontem. O sistema refez o passo uma vez e abriu um card de conserto." });
      const firedToo = card({ status: "deploy", deployFiredAt: iso(NOW - min(90)), findings: stalled() });
      expect(text(firedToo, {})).toBe("Travado em «Publicar»");
    });

    it("em qualquer passo não terminal (o card conduzido parado em Desenvolver)", () => {
      const st = projectCardLiveStatus(card({ status: "desenvolver", findings: stalled() }), CONFIG, {}, NOW)!;
      expect(st).toMatchObject({ kind: "stopped", presence: "stopped", label: "Travado em «Desenvolver»" });
    });

    it("achado fechado, ou card num passo terminal ⇒ não é mais «travado»", () => {
      expect(text(card({ status: "deploy", findings: stalled({ status: "fixed" }) }), {})).toBe("Aguardando publicação");
      expect(projectCardLiveStatus(card({ status: "desenvolver", findings: stalled({ status: "fixed" }) }), CONFIG, {}, NOW)).toBeNull();
      expect(text(card({ status: "concluida", releasedAt: "2026-09-27", findings: stalled() }), {})).toMatch(/^No ar/);
    });

    it("a decisão do dono e todo ator vivo vencem o achado (se alguém voltou a trabalhar, é isso que se lê)", () => {
      const c = card({ status: "deploy", findings: stalled() });
      expect(text(c, { ownerDecision: { label: "Aprovar a mudança no PRD", itemId: "i1" } })).toBe("Precisa de você: Aprovar a mudança no PRD");
      expect(text(c, { run: { trigger: "harness-do", startedAt: NOW - min(3) } as RunnerRun })).toBe("Agente construindo · há 3 min");
      expect(text(c, { session: conductor({ busy: true }) })).toBe("Condutor trabalhando · agora");
      expect(text(c, { merge: [{ status: "conflict", enqueuedAt: NOW - min(30), runId: "r" }] as MergeQueueEntry[] })).toMatch(/^Parado: conflito ao integrar/);
      expect(text(c, { failure: { reason: "timeout", at: NOW - min(7) } as RunnerFailure })).toBe("Parado: a execução ficou sem resposta · há 7 min");
      const queue = { board: "armazem", cardId: "c", position: 1, total: 1, queuedAt: iso(NOW - min(5)) };
      expect(text(c, { queue })).toBe("Na fila do condutor · 1º · há 5 min");
    });

    it("a linha não usa termo interno (o glossário do Inbox)", () => {
      for (const status of ["desenvolver", "merge", "deploy"]) {
        const t = text(card({ status, findings: stalled() }), {})!;
        expect(bannedTermsIn(t).map((b) => b.id), t).toEqual([]);
      }
      expect(bannedTermsIn(text(card({ status: "deploy" }), {})!).map((b) => b.id)).toEqual([]);
    });
  });

  it("precisa de você só com a decisão do dono — e ela vence qualquer ator", () => {
    const facts = { session: conductor(), ownerDecision: { label: "Aprovar a mudança no PRD", itemId: "i1" } };
    const st = projectCardLiveStatus(card(), CONFIG, facts, NOW)!;
    expect(st.label).toBe("Precisa de você: Aprovar a mudança no PRD");
    expect(st.itemId).toBe("i1");
    expect(st.presence).toBe("owner");
  });

  it("nada vivo e nada provado ⇒ null (a tela mostra só a etapa)", () => {
    expect(projectCardLiveStatus(card(), CONFIG, {}, NOW)).toBeNull();
  });

  it("o diff vivo da árvore acompanha a linha; sem árvore, o integrado", () => {
    const live = projectCardLiveStatus(card(), CONFIG, { session: conductor({ diff: { additions: 187, deletions: 23, files: 9 } }) }, NOW)!;
    expect(diffWords(live.diff!)).toBe("+187 −23 · 9 arquivos");
    const done = projectCardLiveStatus(card({ status: "concluida", releasedAt: "2026-09-27" }), CONFIG, { integratedDiff: { additions: 1, deletions: 0, files: 1 } }, NOW)!;
    expect(diffWords(done.diff!)).toBe("+1 −0 · 1 arquivo");
  });

  it("nenhuma linha usa termo interno (o glossário do Inbox)", () => {
    const s = conductor();
    const all: CardLiveFacts[] = [
      { session: conductor({ progress: { phase: "moldar", at: iso(NOW), phaseSince: iso(NOW) } }) },
      { session: conductor({ progress: { phase: "publicar", at: iso(NOW), phaseSince: iso(NOW) } }) },
      { session: conductor({ progress: { phase: "verificar", at: iso(NOW - min(50)), phaseSince: iso(NOW - min(60)), note: "rodando a suíte" } }) },
      { session: s, throttle: { board: "armazem", at: iso(NOW), until: iso(NOW + min(30)) } },
      { session: s, terminal: { session: s.tmuxSession!, kind: "asking", since: NOW } },
      { merge: [{ status: "gate-running", enqueuedAt: NOW, runId: "r" }] as MergeQueueEntry[] },
      { merge: [{ status: "gate-failed", enqueuedAt: NOW, runId: "r" }] as MergeQueueEntry[] },
      ...["timeout", "exit", "error", "oom-killed", "no-op", "budget-cut"].map((reason) => ({ failure: { reason, at: NOW } as RunnerFailure })),
      { run: { trigger: "harness-review", startedAt: NOW } as RunnerRun },
      { run: { trigger: "some-custom-skill", startedAt: NOW } as unknown as RunnerRun },
    ];
    for (const facts of all) {
      const st = projectCardLiveStatus(card(), CONFIG, facts, NOW)!;
      const t = cardLiveText(st, NOW, TZ);
      expect(t, t).toBeTruthy();
      expect(bannedTermsIn([t, st.note].filter(Boolean).join("\n")).map((b) => b.id), t).toEqual([]);
    }
  });
});

describe("CARD_PRESENCE — as seis presenças, mutuamente exclusivas", () => {
  const KINDS: CardLiveKind[] = ["owner", "run", "terminal-prompt", "integrating", "waiting", "working", "quiet", "stopped", "queued", "judging", "publishing", "live"];

  it("é exaustiva (todo tipo de linha tem UMA presença) e não passa de seis presenças, todas em uso", () => {
    expect(Object.keys(CARD_PRESENCE).sort()).toEqual([...KINDS].sort());
    expect(CARD_PRESENCES.length).toBeLessThanOrEqual(6);
    expect(new Set(Object.values(CARD_PRESENCE))).toEqual(new Set(CARD_PRESENCES));
  });

  it("só `working` pulsa", () => {
    expect(CARD_PRESENCES.filter(presencePulses)).toEqual(["working"]);
  });

  it("a fila do condutor e o condutor parado nunca usam a presença do dono nem a de alarme", () => {
    for (const k of ["queued", "quiet", "waiting"] as const) expect(["owner", "stopped"]).not.toContain(CARD_PRESENCE[k]);
    const queue = { board: "armazem", cardId: "c", position: 1, total: 6, queuedAt: iso(NOW - min(5)), waitKind: "slots" };
    expect(projectCardLiveStatus(card(), CONFIG, { queue }, NOW)!.presence).toBe("waiting");
  });

  it("a integração e a publicação são a vez do SISTEMA (delivering), nunca «trabalhando»", () => {
    const merging = [{ status: "merging", enqueuedAt: NOW - min(5), runId: "r" }] as MergeQueueEntry[];
    expect(projectCardLiveStatus(card(), CONFIG, { merge: merging }, NOW)!.presence).toBe("delivering");
    expect(projectCardLiveStatus(card({ status: "deploy" }), CONFIG, {}, NOW)!.presence).toBe("delivering");
  });

  it("card no passo terminal SEM prova de publicação tem presença `live` (nunca «nada vivo»)", () => {
    const st = projectCardLiveStatus(card({ status: "concluida" }), CONFIG, {}, NOW)!;
    expect(st).toMatchObject({ kind: "live", presence: "live", label: "No ar" });
    expect(st.since).toBeUndefined();
  });

  it("a presença de toda linha projetada é CARD_PRESENCE[kind] — posta num ponto só", () => {
    const facts: CardLiveFacts[] = [
      { ownerDecision: { label: "x", itemId: "i" } },
      { run: { trigger: "harness-do", startedAt: NOW } as RunnerRun },
      { session: conductor(), terminal: { session: conductor().tmuxSession!, kind: "asking", since: NOW } },
      { session: conductor({ busy: true }) },
      { session: conductor() },
      { failure: { reason: "timeout", at: NOW } as RunnerFailure },
      { judging: true },
    ];
    for (const f of facts) {
      const st = projectCardLiveStatus(card(), CONFIG, f, NOW)!;
      expect(st.presence, st.kind).toBe(CARD_PRESENCE[st.kind]);
    }
  });

  it("countPresence conta cada presença e o «nada vivo»", () => {
    const q = projectCardLiveStatus(card(), CONFIG, { queue: { board: "armazem", cardId: "c", position: 1, total: 1, queuedAt: iso(NOW) } }, NOW);
    const w = projectCardLiveStatus(card(), CONFIG, { session: conductor({ busy: true }) }, NOW);
    const p = projectCardLiveStatus(card(), CONFIG, { session: conductor() }, NOW);
    expect(countPresence([q, w, p, null, undefined])).toEqual({ owner: 0, working: 1, waiting: 2, delivering: 0, stopped: 0, live: 0, none: 2 });
  });
});

describe("cardLiveFactsFor — recorta os retratos inteiros para um card", () => {
  const feed: CardLiveFeed = {
    at: NOW,
    sessions: [
      conductor({ sessionId: "free", conductor: false, heartbeatAt: iso(NOW) }),
      conductor({ sessionId: "cond" }),
      conductor({ sessionId: "other-card", cardId: "story-x" }),
    ],
    queue: [{ board: "armazem", cardId: "story-ex0004", position: 3, total: 4, queuedAt: iso(NOW) }],
    throttles: [{ board: "armazem", at: iso(NOW), until: iso(NOW + min(40)) }, { board: "other", at: iso(NOW), until: iso(NOW) }],
    judging: ["armazem/story-ex0004"],
  };

  it("prefere a sessão do condutor, e acha o terminal dela pelo nome da tmux", () => {
    const f = cardLiveFactsFor("armazem", "story-ex0004", {
      feed,
      terminals: [{ session: "agent-conductor-story-ex0004-jnme", kind: "asking", since: NOW }],
    });
    expect(f.session?.sessionId).toBe("cond");
    expect(f.terminal?.kind).toBe("asking");
    expect(f.queue?.position).toBe(3);
    expect(f.throttle?.board).toBe("armazem");
    expect(f.judging).toBe(true);
  });

  it("a posição na fila da integração conta só os que esperam, por ordem de chegada", () => {
    const e = (runId: string, cardId: string, status: string, enqueuedAt: number) => ({ runId, board: "armazem", cardId, status, enqueuedAt }) as MergeQueueEntry;
    const f = cardLiveFactsFor("armazem", "story-ex0004", {
      mergeEntries: [e("a", "x", "waiting", 1), e("b", "y", "done", 0), e("c", "story-ex0004", "waiting", 3), e("d", "z", "gate-running", 2)],
    });
    expect(f.mergePosition).toBe(3);
    expect(f.merge?.map((m) => m.runId)).toEqual(["c"]);
  });

  it("sem condutor, escolhe a sessão de ATIVIDADE mais recente — nunca a de heartbeat mais fresco", () => {
    const f = cardLiveFactsFor("armazem", "story-ex0004", {
      feed: {
        ...feed,
        sessions: [
          conductor({ sessionId: "batimento", conductor: false, heartbeatAt: iso(NOW), lastActivityAt: iso(NOW - min(50)) }),
          conductor({ sessionId: "trabalho", conductor: false, heartbeatAt: iso(NOW - min(1)), lastActivityAt: iso(NOW - min(1)) }),
        ],
      },
    });
    expect(f.session?.sessionId).toBe("trabalho");
  });

  it("um zumbi (pasta de trabalho apagada) nunca é a sessão do card", () => {
    const f = cardLiveFactsFor("armazem", "story-ex0004", { feed: { ...feed, sessions: [conductor({ sessionId: "zumbi", zombie: true })] } });
    expect(f.session).toBeNull();
  });

  it("nada deste card ⇒ fatos vazios", () => {
    const f = cardLiveFactsFor("armazem", "nada", { feed });
    expect(f.session).toBeNull();
    expect(f.queue).toBeNull();
    expect(f.judging).toBe(false);
  });
});

describe("o motivo de espera do escopo de tipos — «fora do que o board pode começar agora»", () => {
  // o escopo «só consertos e manutenção» como o portão o entrega
  const fixes = {
    types: ["bug", "technical", "chore", "spike"],
    by: { kind: "owner" },
    at: "2026-09-28T20:00:00.000Z",
    ownerTypes: ["bug", "technical", "chore", "spike"],
    agentTypes: null,
  } as NonNullable<CardLiveFacts["scope"]>;
  const story = (over: Partial<Card> = {}) => card({ type: "story", storyType: "user", status: "desenvolver", ...over });

  it("uma funcionalidade nova esperando a construção diz que espera DE PROPÓSITO, e por quê — espera, não alarme", () => {
    const s = projectCardLiveStatus(story(), CONFIG, { scope: fixes }, NOW)!;
    expect(s).toMatchObject({ kind: "waiting", presence: "waiting", actor: "Board", label: "Esperando: fora do que o board pode começar agora" });
    expect(s.note).toMatch(/Funcionalidade nova fica de fora/);
    expect(s.note).toMatch(/Erro, Trabalho técnico, Manutenção e Investigação/);
  });

  it("card sem storyType vale 'user' (o padrão): espera também", () => {
    expect(projectCardLiveStatus(story({ storyType: null }), CONFIG, { scope: fixes }, NOW)?.label).toMatch(/^Esperando: fora do que/);
  });

  it.each(["bug", "technical", "chore", "spike"] as const)("um card %s passa: nenhuma linha de espera", (storyType) => {
    expect(projectCardLiveStatus(story({ storyType }), CONFIG, { scope: fixes }, NOW)).toBeNull();
  });

  it("um 'user' em modo conserto (fix) conta como erro: passa", () => {
    expect(projectCardLiveStatus(story({ mode: "fix" }), CONFIG, { scope: fixes }, NOW)).toBeNull();
  });

  it("sem escopo no board: nada muda (a linha de sempre)", () => {
    expect(projectCardLiveStatus(story(), CONFIG, { scope: null }, NOW)).toBeNull();
    expect(projectCardLiveStatus(story(), CONFIG, {}, NOW)).toBeNull();
  });

  it("só o que está onde o escopo o segura: na triagem (que segue andando) e no passo final, nenhuma linha", () => {
    expect(projectCardLiveStatus(story({ status: "triage" }), CONFIG, { scope: fixes }, NOW)).toBeNull();
    expect(projectCardLiveStatus(story({ status: "concluida" }), CONFIG, { scope: fixes }, NOW)?.kind).not.toBe("waiting");
  });

  it("C5: só mostra «Esperando» onde o escopo SEGURA — design, «pronta» e o fechamento (revisão/QA) andam e não levam a linha", () => {
    for (const status of ["design-ux", "design-ui", "com-design", "pronta", "ready", "revisar-codigo", "qa-automatizado"]) {
      expect(projectCardLiveStatus(story({ status }), CONFIG, { scope: fixes }, NOW), status).toBeNull();
    }
    for (const status of ["plano-tecnico", "quebrar-tasks", "desenvolver"]) {
      expect(projectCardLiveStatus(story({ status }), CONFIG, { scope: fixes }, NOW)?.label, status).toMatch(/^Esperando: fora do que/);
    }
  });

  it("C5: um card CONDUZIDO (o que já começou termina) nunca mostra a espera do escopo, nem com a sessão fora do ar", () => {
    const conducted = story({ routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-28", driver: "conductor" } as Card["routing"] });
    expect(projectCardLiveStatus(conducted, CONFIG, { scope: fixes }, NOW)).toBeNull();
  });

  it("C5: num board com condutor o despacho dele também é barrado (entrevista, refinar…), menos a classificação, onde a skill roda", () => {
    const withConductor = { ...CONFIG, conductor: { enabled: true, fromStatus: ["enriquecer", "interview", "refinar"] } } as unknown as typeof CONFIG;
    expect(projectCardLiveStatus(story({ status: "interview" }), withConductor, { scope: fixes }, NOW)?.label).toMatch(/^Esperando: fora do que/);
    expect(projectCardLiveStatus(story({ status: "refinar" }), withConductor, { scope: fixes }, NOW)?.label).toMatch(/^Esperando: fora do que/);
    expect(projectCardLiveStatus(story({ status: "enriquecer" }), withConductor, { scope: fixes }, NOW)).toBeNull();
    expect(projectCardLiveStatus(story({ status: "interview" }), CONFIG, { scope: fixes }, NOW)).toBeNull(); // sem condutor a entrevista anda
  });

  it("só story entra na regra: uma ideia ou um passo do mapa não espera por tipo", () => {
    expect(projectCardLiveStatus(story({ type: "idea" }), CONFIG, { scope: fixes }, NOW)).toBeNull();
    expect(projectCardLiveStatus(story({ type: "step" }), CONFIG, { scope: fixes }, NOW)).toBeNull();
  });

  it("quem tem ator vivo mostra o ator: o escopo só fala quando ninguém age no card", () => {
    const run = projectCardLiveStatus(story(), CONFIG, { scope: fixes, run: { trigger: "harness-do", startedAt: NOW - min(2) } }, NOW)!;
    expect(run.kind).toBe("run");
    const queued = projectCardLiveStatus(
      story(),
      CONFIG,
      { scope: fixes, queue: { board: "armazem", cardId: "x", position: 1, total: 1, queuedAt: iso(NOW - min(1)), waitReason: "esperando o escopo" } },
      NOW,
    )!;
    expect(queued.kind).toBe("queued");
    expect(queued.note).toBe("esperando o escopo");
  });

  it("não é falha nem travamento: a presença é «waiting», nunca «stopped»", () => {
    const s = projectCardLiveStatus(story(), CONFIG, { scope: fixes }, NOW)!;
    expect(CARD_PRESENCE[s.kind]).toBe("waiting");
    expect(bannedTermsIn([s.label, s.note].filter(Boolean).join("\n")).map((b) => b.id)).toEqual([]);
  });

  it("cardLiveFactsFor recorta o escopo do board do card, e só dele", () => {
    const feed = { at: NOW, sessions: [], queue: [], throttles: [], judging: [], scopes: [{ board: "oficina", scope: fixes }] } as CardLiveFeed;
    expect(cardLiveFactsFor("oficina", "story-ex9902", { feed }).scope).toEqual(fixes);
    expect(cardLiveFactsFor("armazem", "story-ex9902", { feed }).scope).toBeNull();
    expect(cardLiveFactsFor("oficina", "story-ex9902", { feed: { ...feed, scopes: undefined } }).scope).toBeNull();
  });
});
