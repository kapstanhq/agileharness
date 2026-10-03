// Os mapeamentos puros do coletor de saúde: o que vira entrada do Inbox, raia, fila de publicação, pergunta técnica,
// assinatura de falha da ferramenta e linha da frota. O IO (disco, tmux) é fino demais para ter teste próprio; ele é
// medido ao vivo e somente-leitura (ver o relatório do pacote).

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dump } from "js-yaml";
import { FIXTURE_BOARD } from "../board-fixture";
import { findRepoRoot, resetRepoRootCache, transitionsPath } from "../paths";
import { readBoardConfig } from "../repo";
import { makeDraftCard } from "../draft";
import { writeCard } from "../write";
import type { BoardConfig, Card, CardQuestion } from "../types";
import type { CardClaim } from "../runner/claims";
import type { AgentSession } from "../runner/session-worktree";
import type { InboxEntry } from "../inbox/entries";
import type { SystemDecision } from "../system-decisions";
import {
  attributionOf,
  collectHealthInputs,
  demandLaneOf,
  fleetHealthOf,
  inboxEntriesOf,
  infraSignatureOf,
  openTechnicalQuestionsOf,
  publishWaitingOf,
  toolFailuresFromEvents,
} from "./health-collect";

// A sonda do tmux do host não pode decidir o teste: o terminal «de condutor» abaixo não tem linha no registro.
vi.mock("@/lib/vps/tmux", async (orig) => ({
  ...(await orig<typeof import("@/lib/vps/tmux")>()),
  probeLiveTmuxSessions: async () => ({ ok: true as const, names: ["agent-conductor-story-zz-ab12", "claude"] }),
}));

const NOW = Date.parse("2026-03-12T14:40:05Z");
const MIN = 60_000;

let base: BoardConfig;
beforeAll(async () => {
  base = await readBoardConfig(FIXTURE_BOARD);
});

const story = (id: string, status: string | null, extra: Partial<Card> = {}): Card =>
  ({ id, type: "story", title: id, storyType: "user", status, parent: "step-x", release: null, personas: [], systems: [], links: [], acceptance: [], tasks: [], body: "", order: 0, created: "2026-03-01", updated: "2026-03-01", ...extra }) as Card;

const question = (over: Partial<CardQuestion> & Pick<CardQuestion, "id">): CardQuestion => ({ text: "pergunta", status: "open", ...over });

// ── inboxEntriesOf ───────────────────────────────────────────────────────────────────────────────────

const opt = (kind: string, auditCls = "write-board") => ({ invoke: { kind }, auditCls });
const entry = (over: { cardId: string; kind?: string; item?: unknown; bucket?: string; decider?: string; ownerClass?: string | null; options?: unknown[] }): InboxEntry =>
  ({
    key: `b/${over.cardId}`,
    boardId: "b",
    boardName: "B",
    itemId: over.cardId,
    cardId: over.cardId,
    cardTitle: over.cardId,
    kind: over.kind ?? "gate",
    facets: [],
    item: over.item,
    decision: { bucket: over.bucket ?? "decidir", ask: `decidir ${over.cardId}`, verdict: { decider: over.decider ?? "owner", ownerClass: over.ownerClass ?? null, reason: "r" }, options: over.options ?? [] },
  }) as unknown as InboxEntry;

describe("inboxEntriesOf — o Inbox reduzido ao que os sinais leem", () => {
  const inbox = (entries: InboxEntry[], cards: Card[] = [], decisions: SystemDecision[] = []) => ({ boardId: "b", entries, cards, decisions });

  it("conta só as opções que mudam o desfecho: «como fazer» + «pedir ao Jido» dão 0", () => {
    const [e] = inboxEntriesOf(inbox([entry({ cardId: "c", kind: "deploy-failed", options: [opt("howto"), opt("escalate")] })]), NOW);
    expect(e).toMatchObject({ board: "b", cardId: "c", kind: "deploy-failed", bucket: "decidir", decider: "owner", ownerClass: null, executable: 0 });
  });

  it("opção desabilitada não conta", () => {
    const [e] = inboxEntriesOf(inbox([entry({ cardId: "c", options: [{ ...opt("move-card"), disabled: { reason: "gate" } }, opt("move-card")] })]), NOW);
    expect(e.executable).toBe(1);
  });

  it("pergunta que só tem palavra de dinheiro (sem categoria declarada) é floorOnly; a que o autor declarou dinheiro NÃO", () => {
    const text = "Rodo uma passada extra de revisão? Estimativa de ~US$ 3-5 por causa do plano pago do serviço de OCR.";
    const cards = [story("c1", "desenvolver", { questions: [question({ id: "q1", text })] }), story("c2", "desenvolver", { questions: [question({ id: "q1", text, category: "money" })] })];
    const q = (cardId: string) => entry({ cardId, kind: "question", ownerClass: "money", item: { kind: "question", questionId: "q1" }, options: [opt("answer-question")] });
    const [floor, declared] = inboxEntriesOf(inbox([q("c1"), q("c2")], cards), NOW);
    expect(floor.floorOnly).toBe(true);
    expect(declared.floorOnly).toBe(false);
  });

  it("o marcador [humano] e o dono declarado pelo classificador também NÃO são só o piso", () => {
    const text = "Pode usar o fornecedor X (preço mensal)?";
    const cards = [
      story("c1", "x", { questions: [question({ id: "q1", text: `[humano] ${text}` })] }),
      story("c2", "x", { questions: [question({ id: "q1", text, classified: { category: "owner", ownerClass: "money" } as CardQuestion["classified"] })] }),
    ];
    const q = (cardId: string) => entry({ cardId, kind: "question", ownerClass: "money", item: { kind: "question", questionId: "q1" } });
    expect(inboxEntriesOf(inbox([q("c1"), q("c2")], cards), NOW).map((e) => e.floorOnly)).toEqual([false, false]);
  });

  it("só pergunta que o DONO decide é candidata a floorOnly (veredito do sistema nunca)", () => {
    const cards = [story("c1", "x", { questions: [question({ id: "q1", text: "preço do fornecedor?" })] })];
    const [e] = inboxEntriesOf(inbox([entry({ cardId: "c1", kind: "question", decider: "system", item: { kind: "question", questionId: "q1" } })], cards), NOW);
    expect(e.floorOnly).toBe(false);
  });

  describe("followUpAllowed — Acompanhar só com o que o contrato deixa lá (RC2/C8)", () => {
    const follow = (over: { cardId: string; kind: string; itemId?: string; next?: { who: string; stalled?: true }; since?: string }): InboxEntry =>
      ({
        ...entry({ cardId: over.cardId, kind: over.kind, bucket: "acompanhar", decider: "system" }),
        itemId: over.itemId ?? over.cardId,
        decision: { bucket: "acompanhar", verdict: { decider: "system", ownerClass: null, reason: "r" }, options: [], next: { label: "x", ...(over.next ?? { who: "sistema" }) }, since: over.since ?? null },
      }) as unknown as InboxEntry;
    const sd = (id: string, cardId: string, kind: string) => ({ v: 1, id, at: "2026-03-10T10:00:00Z", board: "b", cardId, agent: "triage-judge", kind, what: "w", why: "y" }) as SystemDecision;

    it("decisão do sistema: só o aceite de triagem de história `user` fica; o de história técnica e as outras decisões são registro", () => {
      const cards = [story("u", "concluida"), story("t", "concluida", { storyType: "technical" })];
      const decisions = [sd("d1", "u", "triage-accept"), sd("d2", "t", "triage-accept"), sd("d3", "u", "proxy-answer")];
      const got = inboxEntriesOf(
        inbox(
          decisions.map((d) => follow({ cardId: d.cardId!, kind: "system-decision", itemId: `sd:${d.id}` })),
          cards,
          decisions,
        ),
        NOW,
      );
      expect(got.map((e) => e.followUpAllowed)).toEqual([true, false, false]);
    });

    it("trabalho do sistema em andamento fica, e o parado sem ninguém cuidando também (o alarme honesto); o aviso que nada espera é registro", () => {
      const got = inboxEntriesOf(
        inbox([
          follow({ cardId: "a", kind: "deploy-failed", next: { who: "jido" } }),
          follow({ cardId: "b", kind: "stuck", next: { who: "ninguem", stalled: true } }),
          follow({ cardId: "c", kind: "finding", next: { who: "ninguem" } }),
        ]),
        NOW,
      );
      expect(got.map((e) => e.followUpAllowed)).toEqual([true, true, false]);
    });

    it("amostra de entrega: dentro de 7 dias fica; depois, ou sem data, é registro", () => {
      const got = inboxEntriesOf(
        inbox([
          follow({ cardId: "a", kind: "delivery-audit", next: { who: "ninguem" }, since: "2026-03-10" }),
          follow({ cardId: "b", kind: "delivery-audit", next: { who: "ninguem" }, since: "2026-02-28" }),
          follow({ cardId: "c", kind: "delivery-audit", next: { who: "ninguem" } }),
        ]),
        NOW,
      );
      expect(got.map((e) => e.followUpAllowed)).toEqual([true, false, false]);
    });

    it("Decidir nunca é «permitido em Acompanhar»", () => {
      expect(inboxEntriesOf(inbox([entry({ cardId: "c", options: [opt("move-card")] })]), NOW)[0].followUpAllowed).toBe(false);
    });
  });
});

// ── a raia de demanda ────────────────────────────────────────────────────────────────────────────────

describe("demandLaneOf — os cards que a raia «Precisa de você» mostra", () => {
  // A raia do dono não lista status: ela é o Decidir do Inbox (WP4). `release` mora numa raia comum.
  const lanes = [
    { id: "triagem", label: "Triagem", statuses: ["triage"] },
    { id: "voce", label: "Precisa de você", statuses: [], demand: true },
    { id: "resto", label: "Resto", statuses: ["desenvolver", "revisao", "release"] },
  ];
  const cfg = (): BoardConfig => ({ ...base, view: { lanes } }) as BoardConfig;

  it("o card entra na raia pelo DECIDIR, nunca pelo status (release fica na raia comum)", () => {
    const entries = [entry({ cardId: "c", options: [opt("move-card")] })];
    const lane = demandLaneOf("b", cfg(), [story("a", "release"), story("b", "desenvolver"), story("c", "revisao")], entries);
    expect(lane).toEqual({ board: "b", laneId: "voce", cardIds: ["c"] });
  });

  it("sem nada em Decidir a raia do dono fica vazia, mesmo com card em release/revisao", () => {
    expect(demandLaneOf("b", cfg(), [story("a", "release"), story("c", "revisao")], [])!.cardIds).toEqual([]);
  });

  it("board sem raia de demanda (ou sem raias) ⇒ null", () => {
    expect(demandLaneOf("b", base, [story("a", "release")], [])).toBeNull();
    expect(demandLaneOf("b", { ...base, view: { lanes: [lanes[0]] } } as BoardConfig, [story("a", "triage")], [])).toBeNull();
  });

  it("só história entra (um passo ou atividade não é card de entrega)", () => {
    const step = { ...story("s", "release"), type: "step" } as Card;
    const entries = [entry({ cardId: "a", options: [opt("move-card")] })];
    expect(demandLaneOf("b", cfg(), [step, story("a", "release")], entries)!.cardIds).toEqual(["a"]);
  });
});

// ── a fila de publicação ─────────────────────────────────────────────────────────────────────────────

describe("publishWaitingOf — o código aprovado que espera o ar", () => {
  it("release e o passo que dispara o deploy esperam; o No ar e o que está em desenvolvimento não", () => {
    const cards = [story("rel", "release"), story("dep", "deploy"), story("live", "concluida"), story("dev", "desenvolver"), story("sem", null)];
    expect(publishWaitingOf("b", base, cards).map((w) => w.cardId)).toEqual(["rel", "dep"]);
  });

  it("um passo, mesmo em release, não é entrega", () => {
    expect(publishWaitingOf("b", base, [{ ...story("s", "release"), type: "step" } as Card])).toEqual([]);
  });
});

// ── perguntas técnicas ───────────────────────────────────────────────────────────────────────────────

describe("openTechnicalQuestionsOf — o que o proxy deveria ter respondido", () => {
  let ultra: BoardConfig;
  beforeAll(() => {
    ultra = { ...base, autonomy: { ...(base.autonomy ?? {}), mode: "ultra" } } as BoardConfig;
  });
  const card = (qs: CardQuestion[], status = "desenvolver") => story("c", status, { questions: qs });

  it("pergunta técnica ou de produto aberta, sem resposta do proxy, entra com o askedAt como está no card", () => {
    const out = openTechnicalQuestionsOf("b", ultra, [card([question({ id: "q1", category: "technical", askedAt: "2026-03-12" }), question({ id: "q2", category: "interview", askedAt: "2026-03-12T13:00:00Z" })])]);
    expect(out).toEqual([
      { board: "b", cardId: "c", questionId: "q1", askedAt: "2026-03-12" },
      { board: "b", cardId: "c", questionId: "q2", askedAt: "2026-03-12T13:00:00Z" },
    ]);
  });

  it("não entram: a do dono, a sem categoria, a já respondida, a que o proxy tratou, e a de card terminal", () => {
    const proxied = question({ id: "q4", category: "technical", proxy: { auditOutcome: "confirmed" } as CardQuestion["proxy"] });
    expect(openTechnicalQuestionsOf("b", ultra, [card([question({ id: "q1", category: "owner" }), question({ id: "q2" }), question({ id: "q3", category: "technical", status: "answered" }), proxied])])).toEqual([]);
    expect(openTechnicalQuestionsOf("b", ultra, [card([question({ id: "q1", category: "technical" })], "concluida")])).toEqual([]);
  });

  it("o veredito do classificador conta como categoria (a pergunta sem categoria do autor)", () => {
    const classified = question({ id: "q1", classified: { category: "technical" } as CardQuestion["classified"] });
    expect(openTechnicalQuestionsOf("b", ultra, [card([classified])]).map((q) => q.questionId)).toEqual(["q1"]);
  });

  it("board que NÃO é só-negócio não tem proxy: nada a medir", () => {
    expect(openTechnicalQuestionsOf("b", { ...base, autonomy: undefined } as BoardConfig, [card([question({ id: "q1", category: "technical" })])])).toEqual([]);
  });
});

// ── falhas da ferramenta ─────────────────────────────────────────────────────────────────────────────

describe("infraSignatureOf / toolFailuresFromEvents — falha da FERRAMENTA, não do produto", () => {
  it("reconhece o sandbox que não sobe (a causa de no-ops repetidos) e o binário que não abre", () => {
    expect(infraSignatureOf("toda chamada falha com `apply-seccomp: write /proc/self/setgroups ... Permission denied`")).toBe("sandbox:seccomp");
    expect(infraSignatureOf("bwrap: Can't mount proc on /newroot/proc: Operation not permitted")).toBe("sandbox:bwrap");
    expect(infraSignatureOf("erro: bwrap: setting up uid map: Permission denied")).toBe("sandbox:bwrap");
    expect(infraSignatureOf("o card fala de bwrap na documentação do sandbox")).toBeNull(); // citar não é falhar
    expect(infraSignatureOf("Error: spawn /root/.local/bin/claude ENOENT")).toBe("spawn:claude-enoent");
  });

  it("falha de teste do produto, texto vazio ou nulo NÃO é falha da ferramenta", () => {
    for (const t of ["AssertionError: expected 1 to be 2", "", null, undefined]) expect(infraSignatureOf(t)).toBeNull();
  });

  it("só evento `settled` que NÃO terminou ok e tem assinatura conhecida; o `at` pode ser texto", () => {
    const seccomp = "falhou: apply-seccomp: write /proc/self/setgroups Permission denied";
    const events = [
      { type: "settled", board: "p", cardId: "c1", outcome: "no-op", at: 1773300044880, result: { finalText: seccomp } },
      { type: "settled", board: "p", cardId: "c1", outcome: "no-op", at: "1773306709951", result: { finalText: seccomp } },
      { type: "settled", board: "p", cardId: "c1", outcome: "ok", at: 1773367575093, result: { finalText: seccomp } },
      { type: "settled", board: "p", cardId: "c2", outcome: "exit", at: 1773031897506 },
      { type: "started", board: "p", cardId: "c3", outcome: "no-op", at: 1, result: { finalText: seccomp } },
      null,
    ];
    expect(toolFailuresFromEvents(events)).toEqual([
      { signature: "sandbox:seccomp", at: 1773300044880, board: "p", cardId: "c1" },
      { signature: "sandbox:seccomp", at: 1773306709951, board: "p", cardId: "c1" },
    ]);
  });
});

// ── a frota ──────────────────────────────────────────────────────────────────────────────────────────

describe("fleetHealthOf — quem está vivo, quieto, órfão ou com claim sem sessão", () => {
  const session = (over: Partial<AgentSession> & Pick<AgentSession, "sessionId">): AgentSession =>
    ({ agentId: over.sessionId, role: "implement", task: "t", openedAt: new Date(NOW - 3_600_000).toISOString(), heartbeatAt: new Date(NOW - 10_000).toISOString(), ...over }) as AgentSession;
  const claim = (agentId: string, board: string, cardId: string, ageMin: number, over: Partial<CardClaim> = {}): CardClaim => ({
    board,
    cardId,
    actor: `session:${agentId}`,
    kind: "implement",
    scope: "both",
    acquiredAt: new Date(NOW - ageMin * MIN).toISOString(),
    expiresAt: new Date(NOW + 30 * MIN).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    ...over,
  });
  const run = (over: Partial<Parameters<typeof fleetHealthOf>[0]>) =>
    fleetHealthOf({ sessions: [], claims: [], liveTmux: new Set(), quiet: new Map(), worktreeExists: () => true, now: NOW, ...over });

  it("um condutor vivo e quieto: o tempo de silêncio e a idade do claim vão juntos (a evidência do vermelho)", () => {
    const s = session({ sessionId: "s1", board: "b", cardId: "c", tmuxSession: "agent-conductor-c-ab12", driver: "conductor" });
    const out = run({ sessions: [s], claims: [claim("s1", "b", "c", 45)], liveTmux: new Set(["agent-conductor-c-ab12"]), quiet: new Map([["s1", { quietForMs: 14 * MIN, asking: false }]]) });
    expect(out.fleet).toEqual([
      { agentId: "s1", board: "b", cardId: "c", alive: true, isConductor: true, quietForMs: 14 * MIN, declaredWaiting: false, asking: false, worktreeMissing: false, claimAgeMs: 45 * MIN },
    ]);
    expect(out.claims).toEqual([{ board: "b", cardId: "c", actor: "session:s1", claimAgeMs: 45 * MIN, holderAlive: true }]);
  });

  it("a espera declarada (report_progress) aparece como declaredWaiting", () => {
    const s = session({ sessionId: "s1", tmuxSession: "t", driver: "conductor", progress: { waiting: "a suíte em segundo plano" } as AgentSession["progress"] });
    expect(run({ sessions: [s], liveTmux: new Set(["t"]) }).fleet[0].declaredWaiting).toBe(true);
  });

  it("o tmux sumiu: a sessão NÃO está viva, e o claim dela vira «sem sessão viva»", () => {
    const s = session({ sessionId: "s1", board: "b", cardId: "c", tmuxSession: "t", driver: "conductor" });
    const out = run({ sessions: [s], claims: [claim("s1", "b", "c", 40)], liveTmux: new Set() });
    expect(out.fleet[0].alive).toBe(false);
    expect(out.claims[0]).toMatchObject({ holderAlive: false, claimAgeMs: 40 * MIN });
  });

  it("claim de quem não é sessão (run, copilot), tombstone e claim expirado não entram", () => {
    const out = run({
      claims: [claim("x", "b", "c1", 5, { actor: "run:abc" }), claim("x", "b", "c2", 5, { released: "released", releasedAt: new Date(NOW).toISOString() }), claim("x", "b", "c3", 5, { expiresAt: new Date(NOW - MIN).toISOString() })],
    });
    expect(out.claims).toEqual([]);
  });

  it("terminal de condutor SEM linha no registro é órfão; terminal do dono (outro nome) e terminal com linha não", () => {
    const s = session({ sessionId: "s1", tmuxSession: "agent-conductor-story-a-x1y2", driver: "conductor" });
    const out = run({ sessions: [s], liveTmux: new Set(["agent-conductor-story-a-x1y2", "agent-conductor-story-b-z9k3", "claude", "main"]) });
    expect(out.orphanTerminals).toEqual(["agent-conductor-story-b-z9k3"]);
  });

  it("worktree apagado do disco é sinalizado só em sessão com worktree declarado", () => {
    const withTree = session({ sessionId: "s1", tmuxSession: "t1", worktreePath: "/wt/gone" });
    const noTree = session({ sessionId: "s2", tmuxSession: "t2" });
    const out = run({ sessions: [withTree, noTree], liveTmux: new Set(["t1", "t2"]), worktreeExists: () => false });
    expect(out.fleet.map((r) => [r.agentId, r.worktreeMissing])).toEqual(expect.arrayContaining([["s1", true], ["s2", false]]));
  });
});

describe("attributionOf — quantas ações MCP dizem quem as fez", () => {
  const a = (extra: object = {}) => ({ v: 1, at: "2026-03-12T00:00:00Z", tool: "move_card", cls: "write-board", disposition: "auto", outcome: "executed", actor: "TOKEN_ORCH", ...extra }) as never;

  it("hoje: só o nome do token ⇒ 0% atribuído", () => {
    expect(attributionOf([a(), a(), a()])).toEqual({ actions: 3, attributed: 0, ownerSessionActions: 0 });
  });

  it("sessão ou tipo de ator contam como atribuídas; a sessão do dono é contada à parte", () => {
    expect(attributionOf([a({ sessionId: "s1" }), a({ actorKind: "owner-session" }), a({ actorKind: "conductor" }), a()])).toEqual({ actions: 4, attributed: 3, ownerSessionActions: 1 });
  });

  it("sem ações ⇒ zeros", () => {
    expect(attributionOf([])).toEqual({ actions: 0, attributed: 0, ownerSessionActions: 0 });
  });
});


// ── uma passada de verdade, num repositório descartável ──────────────────────────────────────────────

describe("collectHealthInputs — lê tudo e NÃO escreve nada", () => {
  const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
  const tmp: string[] = [];
  afterEach(() => {
    delete process.env.AGILEHARNESS_TARGET;
    resetRepoRootCache();
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
  });

  /** O repositório inteiro como uma lista de «caminho:tamanho:mtime» — a prova de que nada foi escrito. */
  const fingerprint = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = path.join(e.parentPath, e.name);
        const st = statSync(p);
        return `${p}:${st.size}:${st.mtimeMs}`;
      })
      .sort();

  async function repo(): Promise<string> {
    const root = mkdtempSync(path.join(os.tmpdir(), "ah-health-collect-"));
    tmp.push(root);
    writeFileSync(path.join(root, "turbo.json"), "{}\n");
    mkdirSync(path.join(root, "storymap", "boards", "lab", "cards"), { recursive: true });
    cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
    const lanes = [
      { id: "resto", label: "Resto", statuses: base.statuses.map((s) => s.id) },
      { id: "voce", label: "Precisa de você", statuses: [], demand: true },
    ];
    writeFileSync(path.join(root, "storymap", "boards", "lab", "board.yaml"), dump({ id: "lab", name: "Lab", autonomy: { mode: "ultra" }, view: { lanes } }));
    process.env.AGILEHARNESS_TARGET = root;
    resetRepoRootCache();
    // todo card vive na hierarquia do mapa: uma atividade, um passo e as histórias sob ele
    const activity = { ...makeDraftCard({ type: "activity", title: "Atividade", status: null, cards: [] }), id: "act-lab" };
    const step = { ...makeDraftCard({ type: "step", title: "Passo", parent: activity.id, status: null, cards: [] }), id: "step-lab" };
    await writeCard("lab", activity);
    await writeCard("lab", step);
    const mk = async (id: string, status: string, extra: Partial<Card> = {}) => {
      const draft = makeDraftCard({ type: "story", title: id, parent: step.id, status, cards: [] });
      await writeCard("lab", { ...draft, id, ...extra });
    };
    await mk("story-rel", "release"); // esperando a publicação: é do SISTEMA, não cai na raia do dono
    await mk("story-tec", "desenvolver", { questions: [{ id: "q1", text: "qual índice usar?", status: "open", category: "technical", askedAt: "2026-03-12" }] });
    await mk("story-ok", "concluida");
    const ledger = [
      { v: 1, at: new Date(NOW - 5 * 3_600_000).toISOString(), board: "lab", cardId: "story-rel", from: "deploy", to: "release", actor: "system" },
      { v: 1, at: new Date(NOW - 3 * 3_600_000).toISOString(), board: "lab", cardId: "story-ok", from: "deploy", to: "concluida", actor: "system" },
    ];
    writeFileSync(transitionsPath(), ledger.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return root;
  }

  it("reúne o Inbox, a raia, o ledger, a fila de publicação e as perguntas técnicas do board", async () => {
    await repo();
    const inputs = await collectHealthInputs(NOW);

    expect(inputs.now).toBe(NOW);
    expect(inputs.demandLanes).toEqual([{ board: "lab", laneId: "voce", cardIds: [] }]);
    expect(inputs.cards).toEqual(expect.arrayContaining([{ board: "lab", cardId: "story-rel", status: "release" }, { board: "lab", cardId: "story-ok", status: "concluida" }]));
    expect(inputs.deliveredStatuses.lab).toEqual(["concluida"]);
    expect(inputs.publishWaiting).toEqual([{ board: "lab", cardId: "story-rel" }]);
    expect(inputs.openTechnicalQuestions).toEqual([{ board: "lab", cardId: "story-tec", questionId: "q1", askedAt: "2026-03-12" }]);
    expect(inputs.transitions).toEqual([
      { board: "lab", cardId: "story-rel", to: "release", at: NOW - 5 * 3_600_000, actor: "system" },
      { board: "lab", cardId: "story-ok", to: "concluida", at: NOW - 3 * 3_600_000, actor: "system" },
    ]);
    expect(inputs.fleetKnown).toBe(true);
    expect(inputs.orphanTerminals).toEqual(["agent-conductor-story-zz-ab12"]);
    expect(inputs.attribution).toEqual({ actions: 0, attributed: 0 });
  });

  it("a passada inteira é SOMENTE-LEITURA: nenhum arquivo do repositório nem do estado do runner muda", async () => {
    const root = await repo();
    const runnerDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR!;
    const before = [...fingerprint(root), ...fingerprint(runnerDir)];
    await collectHealthInputs(NOW);
    await collectHealthInputs(NOW + 5 * MIN);
    expect([...fingerprint(root), ...fingerprint(runnerDir)]).toEqual(before);
  });

  it("do coletor ao relatório: a vazão e a raia aparecem como o dono as veria", async () => {
    await repo();
    const { computeHealth } = await import("./ah-health");
    const r = computeHealth(await collectHealthInputs(NOW));
    expect(r.signals.find((s) => s.id === "S6")).toMatchObject({ value: 3, level: "amber" }); // 3 h sem nada no ar, com story-rel esperando
    expect(r.signals.find((s) => s.id === "S3")).toMatchObject({ value: 0, level: "ok" }); // a raia do dono é o Decidir: story-rel (release) não está nela
    expect(r.signals.find((s) => s.id === "S4")).toMatchObject({ value: 1, level: "amber" }); // o terminal de condutor sem linha
    expect(r.signals.find((s) => s.id === "S9")!.value).toBe(0);
  });
});
