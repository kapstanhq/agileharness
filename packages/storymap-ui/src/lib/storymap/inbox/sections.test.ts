import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, StatusDef } from "../types";
import type { CockpitItem } from "../demands";
import type { SystemDecision } from "../system-decisions";
import { inboxSections, inboxSummary } from "./entries";
import { boardEntries, boardResolved } from "./collect";
import { DEPLOY_WATCH_MINUTES } from "./decision";

// As SEÇÕES e o NÚMERO (onda 2, passo 3): o badge, o chip, a aba do celular e a fala do Jido contam SÓ Decidir; o que o
// sistema está resolvendo vai para Acompanhar (contado em voz baixa), com o que ninguém vai pegar sozinho à vista.

const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
const STATUSES = [
  st("triage", "Triagem", { staging: true }),
  st("interview", "Entrevista", { autorun: true }),
  st("enriquecer", "Especificar", { autorun: true, trigger: "harness-enrich" }),
  st("release", "Liberar", { autorun: false, laneStep: true }),
  st("deploy", "Publicar", { autorun: false, onEnter: "promote-and-deploy", laneStep: true }),
  st("concluida", "No ar", { terminal: true }),
];
const HUMAN = { id: "b1", name: "Livraria", statuses: STATUSES } as BoardConfig;
const ULTRA = { ...HUMAN, autonomy: { mode: "ultra" } } as BoardConfig;
const NOW = Date.parse("2026-09-28T20:00:00Z");

const card = (id: string, over: Partial<Card> = {}): Card =>
  ({ id, type: "story", title: `Card ${id}`, storyType: "user", status: "release", parent: "step-1", findings: [], tasks: [], acceptance: [], links: [], personas: [], systems: [], created: "2026-09-20", ...over }) as unknown as Card;
const item = (kind: string, cardId: string, over: Record<string, unknown> = {}): CockpitItem =>
  ({ id: `${cardId}:${kind}`, kind, boardId: "b1", cardId, cardTitle: `Card ${cardId}`, status: "release", lane: "travado", severity: "high", since: "2026-09-28T19:00:00Z", ...over }) as CockpitItem;

const cards = [
  card("c1", { status: "triage", needsHumanReview: true }),
  card("c2", { status: "enriquecer" }),
  card("c3", { status: "release" }),
  card("c4", { status: "deploy", deployFiredAt: "2026-09-28T18:00:00Z" }),
];
const items: CockpitItem[] = [
  item("review", "c1", { id: "c1:review", status: "triage", lane: "pergunta", severity: "medium" }),
  item("stuck", "c2", { id: "c2:stuck:exit", status: "enriquecer", trigger: "harness-enrich", outcome: "exit", reason: "exit" }),
  // dois itens do MESMO card c3: uma publicação falha e o gate — um item de Decidir só
  item("deploy-failed", "c3", { findingId: "deploy-failure", title: "A publicação falhou" }),
  item("gate", "c3", { id: "c3:approval:release", lane: "aprovar", severity: "medium", gateLabel: "Liberar" }),
  item("finding", "c3", { id: "c3:f:f1", lane: "pergunta", severity: "low", findingId: "f1", title: "Aviso", findingSeverity: "low" }),
  item("delivery-audit", "c3", { id: "c3:da", lane: "aprovar", sampledAt: "2026-09-27" }),
  item("meter-stalled", "", { id: "host:meter-stalled:1", status: null, stalledSince: NOW - 3_600_000, detectedAt: NOW, detail: "d" }),
];
const decisions: SystemDecision[] = [
  { v: 1, id: "sd-2d", at: "2026-09-26T10:00:00Z", board: "b1", cardId: "c2", agent: "triage-judge", kind: "triage-accept", what: "Aceitou na triagem: «Card c2»", why: "o PRD pede", undo: { kind: "return-to-triage", cardId: "c2", from: "enriquecer" } },
  { v: 1, id: "sd-today", at: "2026-09-28T19:30:00Z", board: "b1", cardId: "c1", agent: "proxy", kind: "proxy-answer", what: "Respondeu", why: "PRD" },
  { v: 1, id: "sd-other-board", at: "2026-09-26T10:00:00Z", board: "b2", agent: "system", kind: "publish", what: "x", why: "y" },
];

describe("o número conta SÓ Decidir", () => {
  it("modo humano: triagem, execução parada e a publicação falha (com o gate dobrado nela) — 3 para decidir", () => {
    const { entries } = boardEntries({ boardId: "b1", config: HUMAN, cards, items, decisions, now: NOW });
    const s = inboxSummary(entries);
    expect(s.decidir).toBe(3);
    const { decidir, acompanhar, banners } = inboxSections(entries);
    expect(decidir.map((e) => e.kind).sort()).toEqual(["deploy-failed", "review", "stuck"]);
    // o gate do mesmo card virou faceta da publicação falha — e não conta
    expect(decidir.find((e) => e.kind === "deploy-failed")!.facets.map((f) => f.kind)).toEqual(["gate"]);
    // Acompanhar: a amostra (o aviso que não trava nada é dívida do card, não entrada) e o aceite da triagem de uma
    // história de usuário de 2 dias atrás (o que o dono combinou rever, com o «Desfazer» que ainda funciona)
    expect(acompanhar.map((e) => e.kind).sort()).toEqual(["delivery-audit", "system-decision"]);
    expect(banners).toHaveLength(1);
    expect(s.acompanhar).toBe(acompanhar.length);
  });

  it("só-negócio: o técnico sai de Decidir — e o que ninguém vai pegar sozinho aparece contado", () => {
    const { entries } = boardEntries({ boardId: "b1", config: ULTRA, cards, items, decisions, now: NOW });
    const s = inboxSummary(entries);
    expect(s.decidir).toBe(0);
    // a execução parada e a publicação falha são do sistema, e o Jido está desligado neste board: ninguém tenta
    expect(s.stalled).toBe(2);
  });

  it("a faixa do host (o medidor parado) nunca conta, em nenhuma seção", () => {
    const onlyMeter = boardEntries({ boardId: "b1", config: HUMAN, cards, items: items.filter((i) => i.kind === "meter-stalled"), decisions: [], now: NOW });
    expect(inboxSummary(onlyMeter.entries)).toEqual({ decidir: 0, acompanhar: 0, stalled: 0 });
  });

  // REESCRITO de propósito (WP3): passado o prazo, a publicação que ainda roda só tem «Pedir ao Jido para conferir» — e
  // subia a Decidir com isso. A regra B vale para a promoção: o número de Decidir não sobe; a de «sem ninguém cuidando» sim.
  it("a regra de promoção chega ao número: passado o prazo, a publicação que ainda roda vira «sem ninguém cuidando», nunca Decidir sem ação", () => {
    const running = item("deploy-unsettled", "c4", { id: "c4:deploy-unsettled", status: "deploy", deployFiredAt: "2026-09-28T18:00:00Z", lastDeploy: { target: "web", status: "running" } });
    const before = boardEntries({ boardId: "b1", config: HUMAN, cards, items: [running], decisions: [], now: Date.parse("2026-09-28T18:30:00Z") });
    expect(inboxSummary(before.entries)).toMatchObject({ decidir: 0, stalled: 0 });
    const after = boardEntries({ boardId: "b1", config: HUMAN, cards, items: [running], decisions: [], now: Date.parse("2026-09-28T18:00:00Z") + (DEPLOY_WATCH_MINUTES + 5) * 60_000 });
    expect(inboxSummary(after.entries)).toMatchObject({ decidir: 0, stalled: 1 });
    // e no só-negócio, não sobe: fica em Acompanhar como parado sem dono
    const ultra = boardEntries({ boardId: "b1", config: ULTRA, cards, items: [running], decisions: [], now: Date.parse("2026-09-28T18:00:00Z") + (DEPLOY_WATCH_MINUTES + 5) * 60_000 });
    expect(inboxSummary(ultra.entries)).toMatchObject({ decidir: 0, stalled: 1 });
  });
});

describe("as decisões do sistema entram em Acompanhar", () => {
  it("só as do board, só as da janela (1 a 7 dias — as de hoje moram em «Resolvido hoje»)", () => {
    const { all } = boardEntries({ boardId: "b1", config: HUMAN, cards, items: [], decisions, now: NOW });
    expect(all.map((e) => e.itemId)).toEqual(["sd:sd-2d"]);
    expect(all[0].decision.bucket).toBe("acompanhar");
    expect(all[0].decision.options.map((o) => o.invoke.kind)).toEqual(["undo-system-decision"]);
  });
});

// ── WP3: Acompanhar só com o que o dono combinou rever e o trabalho em andamento (antes eram dezenas de linhas)

describe("Acompanhar não é log", () => {
  it("a amostra de entrega com mais de 7 dias sai de Acompanhar — com o recibo do prazo em «Resolvido hoje»", () => {
    const old = item("delivery-audit", "c3", { id: "c3:da", lane: "aprovar", sampledAt: "2026-09-21", since: "2026-09-21" });
    const built = boardEntries({ boardId: "b1", config: ULTRA, cards, items: [old], decisions: [], now: NOW });
    expect(built.entries).toEqual([]);
    expect(built.retired.map((r) => r.item.id)).toEqual(["c3:da"]);
    const resolved = boardResolved({ boardId: "b1", config: ULTRA, cards, receipts: [], decisions: [], approvals: [], drafts: [], retired: built.retired, now: NOW });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ who: "prazo", whoLabel: "Prazo", itemId: "c3:da" });
    expect(resolved[0].what).toMatch(/passou de 7 dias sem revisão/);
  });

  it("a decisão do sistema sem «Desfazer» que funcione vai para o registro: fora da lista, viva na página do item", () => {
    const moved: SystemDecision = { v: 1, id: "sd-moved", at: "2026-09-26T10:00:00Z", board: "b1", cardId: "c2", agent: "triage-judge", kind: "triage-accept", what: "Aceitou na triagem: «Card c2»", why: "PRD", undo: { kind: "return-to-triage", cardId: "c2", from: "interview" } };
    const noUndo: SystemDecision = { v: 1, id: "sd-cost", at: "2026-09-26T11:00:00Z", board: "b1", cardId: "c2", agent: "system", kind: "cost-within-ceiling", what: "Aceitou o aumento de custo (+R$0/mês)", why: "dentro do teto" };
    const { entries, all } = boardEntries({ boardId: "b1", config: HUMAN, cards, items: [], decisions: [moved, noUndo], now: NOW });
    expect(entries).toEqual([]);
    expect(all.map((e) => e.itemId).sort()).toEqual(["sd:sd-cost", "sd:sd-moved"]);
    // na página do item, o «Desfazer» recusado vem bloqueado com a frase do servidor
    expect(all.find((e) => e.itemId === "sd:sd-moved")!.decision.options[0].disabled?.reason).toMatch(/o card já andou/);
  });

  it("só o aceite da triagem de uma história de USUÁRIO fica (a promessa de veto); o de uma técnica vai para o registro", () => {
    const tech = card("c5", { status: "enriquecer", storyType: "technical" } as Partial<Card>);
    const accept = (cardId: string, id: string): SystemDecision => ({ v: 1, id, at: "2026-09-26T10:00:00Z", board: "b1", cardId, agent: "triage-judge", kind: "triage-accept", what: "Aceitou", why: "PRD", undo: { kind: "return-to-triage", cardId, from: "enriquecer" } });
    const { entries } = boardEntries({ boardId: "b1", config: HUMAN, cards: [...cards, tech], items: [], decisions: [accept("c2", "u"), accept("c5", "t")], now: NOW });
    expect(entries.map((e) => e.itemId)).toEqual(["sd:u"]);
    expect(entries[0].decision.options[0].disabled).toBeUndefined();
  });
});
