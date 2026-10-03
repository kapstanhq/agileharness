import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, CardQuestion, StatusDef } from "../types";
import { DEPLOY_FAILURE_FINDING_ID } from "../demands";
import { cardInboxSignal } from "./card-signal";
import { cardsForScreen } from "./collect";
import { emptyDecidirText, type InboxEntry } from "./entries";

// Um Inbox só, para todos os boards (onda 2, passo 4 — decisão 2 do dono): a tela, a chegada, a antiga Central de
// ações, e o que ainda lia o modelo legado (`cardDemands`) — o push, a pílula do Kanban e o «Resolver».

const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
const STATUSES = [
  st("triage", "Triagem", { staging: true }),
  st("interview", "Entrevista", { autorun: true }),
  st("desenvolver", "Desenvolver", { autorun: false }),
  st("release", "Liberar", { autorun: false, laneStep: true }),
  st("deploy", "Publicar", { autorun: false, onEnter: "promote-and-deploy", laneStep: true }),
  st("concluida", "No ar", { terminal: true }),
];
const HUMAN = { id: "b1", name: "Livraria", statuses: STATUSES } as BoardConfig;
const ULTRA = { ...HUMAN, autonomy: { mode: "ultra" } } as BoardConfig;
const NOW = Date.parse("2026-09-28T20:00:00Z");
const card = (over: Partial<Card> = {}): Card =>
  ({ id: "c1", type: "story", title: "Convite", storyType: "user", status: "release", parent: "step-1", findings: [], tasks: [], acceptance: [], links: [], personas: [], systems: [], created: "2026-09-20", ...over }) as unknown as Card;
const failure = { id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "A publicação falhou", status: "open" } as Card["findings"][number];

describe("o sinal de um card — o push, a pílula do Kanban e o «Resolver» leem o Decidir do Inbox", () => {
  it("o card com uma publicação falha e o gate: o sinal é a publicação (a dobra), com a ação e o id do item", () => {
    const sig = cardInboxSignal(card({ findings: [failure], reviewedAt: "2026-09-27" }), HUMAN, "b1", { now: NOW });
    expect(sig).toMatchObject({ kind: "deploy-failed", itemId: "c1:deploy-failed", label: "Publicar de novo em produção" });
    expect(sig!.ask).toBe("Publicar «Convite» de novo?");
  });

  it("só-negócio: o técnico não pede o dono — sem sinal (o push não cobra o que é do sistema)", () => {
    expect(cardInboxSignal(card({ findings: [failure], reviewedAt: "2026-09-27" }), ULTRA, "b1", { now: NOW })).toBeNull();
    // mas a pergunta de dinheiro segue pedindo
    const money = { id: "q1", text: "Contratar o plano pago?", status: "open", category: "money", askedAt: "2026-09-27" } as CardQuestion;
    expect(cardInboxSignal(card({ status: "desenvolver", questions: [money] }), ULTRA, "b1", { now: NOW })).toMatchObject({ kind: "question", label: "Responder" });
  });

  it("a raia de entrega não repete na pílula o gate que o botão dela já é (exclude)", () => {
    const gateOnly = card({ status: "release", reviewedAt: "2026-09-27" });
    expect(cardInboxSignal(gateOnly, HUMAN, "b1", { now: NOW })?.kind).toBe("gate");
    expect(cardInboxSignal(gateOnly, HUMAN, "b1", { now: NOW, exclude: (k) => k === "gate" })).toBeNull();
  });

  it("sem nada para o dono, sem sinal", () => {
    expect(cardInboxSignal(card({ status: "interview" }), HUMAN, "b1", { now: NOW })).toBeNull();
  });
});

describe("o Inbox de todos os boards", () => {
  const e = (over: Partial<InboxEntry>): InboxEntry => ({ key: "k", boardId: "b1", boardName: "B", itemId: "i", cardId: "c1", cardTitle: "t", kind: "gate", decision: {} as InboxEntry["decision"], causeKey: "card:c1", facets: [], ...over });
  it("a tela recebe só os cards que os itens citam — e todos, quando há uma proposta pronta (ela ancora em qualquer card)", () => {
    const cards = [card({ id: "c1" }), card({ id: "c2" }), card({ id: "c3" })];
    expect(cardsForScreen([e({ cardId: "c2" })], cards).map((c) => c.id)).toEqual(["c2"]);
    const ready = e({ kind: "proposal", item: { kind: "proposal", items: [{ tempId: "t" }] } as unknown as InboxEntry["item"] });
    expect(cardsForScreen([ready], cards)).toHaveLength(3);
  });

  it("o vazio diz onde está o resto: «Nada para você decidir. Livraria tem 3 em Acompanhar; Atendimento, 1.»", () => {
    const boards = [
      { id: "livraria", name: "Livraria", acompanhar: 3 },
      { id: "atendimento", name: "Atendimento", acompanhar: 1 },
      { id: "sebo", name: "Sebo", acompanhar: 0 },
    ];
    expect(emptyDecidirText(boards, null)).toBe("Nada para você decidir. Livraria tem 3 em Acompanhar; Atendimento, 1.");
    expect(emptyDecidirText(boards, "atendimento")).toBe("Nada para você decidir. Atendimento tem 1 em Acompanhar.");
    expect(emptyDecidirText(boards, "sebo")).toBe("Nada para você decidir. Os agentes seguem sozinhos.");
  });
});

describe("a chegada e a aposentadoria", () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("`/` chega no Inbox de todos os boards; /perguntas redireciona para ele", () => {
    expect(src("../../../app/page.tsx")).toMatch(/redirect\("\/inbox"\)/);
    expect(src("../../../app/perguntas/page.tsx")).toMatch(/redirect\("\/inbox"\)/);
    expect(existsSync(fileURLToPath(new URL("../../../components/QuestionsQueue.tsx", import.meta.url)))).toBe(false);
  });
  it("o Inbox (a rota própria e a do board) é a MESMA tela, com o selo do board e o filtro", () => {
    expect(src("../../../app/inbox/page.tsx")).toMatch(/<InboxHome snapshot=\{snapshot\}/);
    expect(src("../../../components/CockpitView.tsx")).toMatch(/<InboxHome snapshot=\{snapshot\}/);
    const home = src("../../../components/inbox/InboxHome.tsx");
    expect(home).toMatch(/showBoard=\{!filter\}/);
    expect(home).toMatch(/aria-label="Filtrar por board"/);
  });
  it("o push, a pílula do Kanban e o «Resolver» leem o modelo do Inbox, não mais o legado", () => {
    expect(src("../../notifications/server/watcher.ts")).toMatch(/cardInboxSignal\(/);
    // a pílula do Kanban mora na LINHA DE ESTADO do card (CardLiveStatus.tsx), que o KanbanCard usa
    expect(src("../../../components/CardLiveStatus.tsx")).toMatch(/cardInboxSignal\(/);
    expect(src("../../../components/KanbanCard.tsx")).toMatch(/useCardLiveStatus\(/);
    const provider = src("../../../components/RunnerStatusProvider.tsx");
    expect(provider).toMatch(/cardInboxSignal\(card, config, boardId/);
    for (const rel of ["../../notifications/server/watcher.ts", "../../../components/KanbanCard.tsx", "../../../components/CardLiveStatus.tsx"]) expect(src(rel)).not.toMatch(/dominantDemand\(cardDemands/);
  });
});
