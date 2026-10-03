// O Decidir por card — o que o Kanban desenha na raia do dono, na pílula e no rodapé. Casos do Inbox vivo:
//   • 5 publicações «que só você publica» com só «como publicar» (howto) e «Pedir ao Jido» (escalate): nenhuma delas é
//     um botão de RESOLVER no card — conversar e ler não mudam o desfecho;
//   • um card com dois itens em Decidir (o passo travado e o pedido do agente) aparece UMA vez;
//   • a ordem é a do Inbox (o mais urgente primeiro), não a do arquivo.

import { describe, expect, it } from "vitest";
import type { CockpitItem } from "../demands";
import type { BoardConfig, Card, StatusDef } from "../types";
import { decidirCardIds, ownerDecisionsFromEntries } from "./decidir-set";
import { itemEntries, type InboxEntry } from "./entries";
import { primaryOption, type DecisionOption } from "./decision";

const opt = (o: Partial<DecisionOption> & Pick<DecisionOption, "invoke">): DecisionOption =>
  ({ id: o.invoke.kind, label: o.invoke.kind, consequence: "", tone: "neutral", auditCls: "write-board", done: "", ...o }) as DecisionOption;

const entry = (cardId: string, extra: { bucket?: "decidir" | "acompanhar"; dot?: "red" | "amber" | "green" | "grey"; options?: DecisionOption[]; kind?: string; board?: string } = {}): InboxEntry =>
  ({
    key: `${extra.board ?? "b"}/${cardId}:${extra.kind ?? "x"}`,
    boardId: extra.board ?? "b",
    boardName: "B",
    itemId: `${cardId}:${extra.kind ?? "x"}`,
    cardId,
    cardTitle: cardId,
    kind: extra.kind ?? "question",
    facets: [],
    decision: {
      bucket: extra.bucket ?? "decidir",
      ask: `Decidir ${cardId}?`,
      askVerb: "Decidir",
      options: extra.options ?? [],
      dot: extra.dot ?? "amber",
      since: "2026-10-01T10:00:00Z",
      next: { who: "voce", label: "você" },
    },
  }) as unknown as InboxEntry;

describe("ownerDecisionsFromEntries", () => {
  it("só Decidir, só deste board, um por card, na ordem do Inbox — com as segundas decisões contadas", () => {
    const d = ownerDecisionsFromEntries(
      [
        entry("a", { dot: "amber" }),
        entry("b", { dot: "red" }),
        entry("c", { bucket: "acompanhar" }),
        entry("a", { dot: "amber", kind: "approval" }),
        entry("z", { board: "outro" }),
        entry("", { dot: "green", kind: "governance" }),
      ],
      "b",
    );
    expect(decidirCardIds(d)).toEqual(["b", "a"]); // vermelho antes do âmbar: a ordem do Inbox
    expect(d.cards.find((c) => c.cardId === "a")).toMatchObject({ more: 1, rank: 1, itemId: "a:x" });
    expect(d.total).toBe(4); // b, a, a (pedido), governança sem card
  });

  it("o botão do card é só a opção que MUDA o desfecho: nunca «como publicar», «Pedir ao Jido» ou um link", () => {
    const onlyTalk = entry("p", {
      kind: "deploy-failed",
      options: [
        opt({ invoke: { kind: "howto", title: "Como publicar", steps: [] }, auditCls: "read" }),
        opt({ invoke: { kind: "escalate", ref: {} } as unknown as DecisionOption["invoke"], tone: "primary", auditCls: "read" }),
      ],
    });
    const gate = entry("g", {
      kind: "gate",
      options: [
        opt({ id: "back", label: "Devolver", invoke: { kind: "move-card", boardId: "b", cardId: "g", status: "qa" } }),
        opt({ id: "go", label: "Mandar para «Integrar»", tone: "primary", invoke: { kind: "move-card", boardId: "b", cardId: "g", status: "merge" } }),
      ],
    });
    const answer = entry("q", {
      options: [opt({ label: "Responder", tone: "primary", requires: "answer", invoke: { kind: "answer-question", boardId: "b", cardId: "q", questionId: "q1" } })],
    });
    const d = ownerDecisionsFromEntries([onlyTalk, gate, answer], "b");
    const by = new Map(d.cards.map((c) => [c.cardId, c]));
    expect(by.get("p")!.primary).toBeNull();
    expect(by.get("g")!.primary).toMatchObject({ label: "Mandar para «Integrar»", invoke: { kind: "move-card", status: "merge" } });
    expect(by.get("q")!.primary).toBeNull(); // responder é um formulário: a pílula leva ao Inbox
    expect(by.get("p")!.what).toBe("Decidir p?");
  });

  it("uma principal recusada não é trocada por outra alternativa: o card fica sem botão", () => {
    // «Mandar para Integrar» recusada pelo gate e «Devolver» livre: o primaryOption cai na alternativa, o card não
    const gate = entry("g", {
      kind: "gate",
      options: [
        opt({ id: "back", label: "Devolver", invoke: { kind: "move-card", boardId: "b", cardId: "g", status: "qa" } }),
        opt({ id: "go", label: "Mandar para «Integrar»", tone: "primary", disabled: { reason: "falta o QA" }, invoke: { kind: "move-card", boardId: "b", cardId: "g", status: "merge" } }),
      ],
    });
    expect(ownerDecisionsFromEntries([gate], "b").cards[0].primary).toBeNull();
  });
});

// ── O modelo REAL (itemEntries → decideItem → primaryOption), não opções escritas à mão ─────────────────────────────
// O defeito que a revisão achou: o botão do card escolhia «a primeira opção que sobra» depois de tirar conversa e
// leitura. No conflito de integração, a principal do Inbox é «Pedir ao Jido para integrar» (conversa) — sobrava só
// «Descartar este trabalho», e ELE virava o único botão do card fechado. Na triagem com o aceite recusado, sobrava
// «Descartar» (lixeira). Um botão vermelho e destrutivo como ÚNICA ação visível do card, num lugar onde o Inbox mostra
// a principal recusada com o «Completar o card agora».
describe("ownerDecisionsFromEntries — o botão do card é a principal do Inbox, ou nada", () => {
  const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
  const CONFIG = {
    id: "b",
    name: "B",
    statuses: [
      st("triage", "Triagem", { staging: true }),
      // o aceite de uma user story vai para a Entrevista, que exige critério de aceite — sem ele, o «Aceitar» é recusado
      st("interview", "Entrevista", { autorun: true, trigger: "harness-interview", gate: "hasAcceptance" }),
      st("merge", "Integrar", { autorun: true, laneStep: true }),
      st("concluida", "No ar", { terminal: true }),
    ],
  } as unknown as BoardConfig;
  const NOW = Date.parse("2026-10-01T22:45:00Z");
  const card = (id: string, over: Partial<Card>): Card =>
    ({ id, type: "story", title: `Story ${id}`, storyType: "user", parent: "step-1", release: null, personas: [], systems: [], links: [], narrative: { role: "", want: "", soThat: "" }, acceptance: [], tasks: [], rice: {}, kano: null, funnelStage: null, findings: [], order: 10, created: "2026-09-30", updated: null, body: "", ...over }) as unknown as Card;
  const item = (cardId: string, kind: CockpitItem["kind"], over: Record<string, unknown>): CockpitItem =>
    ({ id: `${cardId}:${kind}`, boardId: "b", cardId, cardTitle: `Story ${cardId}`, lane: "travado", severity: "high", since: "2026-10-01T21:00:00Z", kind, ...over }) as CockpitItem;
  const decide = (items: CockpitItem[], cards: Card[]) => {
    const entries = itemEntries(items, { boardId: "b", boardName: "B", config: CONFIG, cardsById: new Map(cards.map((c) => [c.id, c])), now: NOW });
    return { entries, d: ownerDecisionsFromEntries(entries, "b") };
  };

  it("conflito de integração (Pedir ao Jido · como integrar · Descartar): sem botão no card — nunca o «Descartar»", () => {
    const { entries, d } = decide([item("x", "conflict", { status: "merge", runId: "run-abc", conflictKind: "merge-conflict" })], [card("x", { status: "merge" })]);
    // a pré-condição é o modelo vivo: a principal do Inbox é conversar com o Jido, e há um descarte vermelho ao lado
    const options = entries[0].decision.options;
    expect(entries[0].decision.bucket).toBe("decidir");
    // (WP3) a principal canônica nunca é a conversa nem o descarte: aqui não há principal — o Inbox mostra as três
    expect(primaryOption(entries[0].decision)).toBeNull();
    expect(options.some((o) => o.tone === "danger" && o.invoke.kind === "resolve-merge")).toBe(true);
    expect(d.cards).toHaveLength(1);
    expect(d.cards[0].primary).toBeNull(); // a pílula leva ao Inbox, onde a decisão inteira está
  });

  it("triagem com o aceite recusado (card sem critério de aceite): sem botão no card — nunca o «Descartar» para a lixeira", () => {
    const { entries, d } = decide([item("t", "review", { lane: "pergunta", severity: "medium", status: "triage" })], [card("t", { status: "triage", needsHumanReview: true })]);
    const accept = entries[0].decision.options.find((o) => o.invoke.kind === "accept-triage");
    expect(accept?.disabled).toBeTruthy(); // a pré-condição: o aceite está recusado agora
    expect(d.cards[0].primary).toBeNull();
  });

  it("o mesmo item com o aceite LIVRE: o botão é o «Aceitar» — a mesma opção que o Inbox destaca", () => {
    const ready = card("t", { status: "triage", needsHumanReview: true, acceptance: ["Dado que abro o app, então vejo a lista de hoje"] } as unknown as Partial<Card>);
    const { entries, d } = decide([item("t", "review", { lane: "pergunta", severity: "medium", status: "triage" })], [ready]);
    const main = primaryOption(entries[0].decision);
    expect(main).toMatchObject({ invoke: { kind: "accept-triage" } });
    expect(main?.disabled).toBeUndefined();
    expect(d.cards[0].primary).toMatchObject({ id: main!.id, label: main!.label, invoke: { kind: "accept-triage" } });
  });
});
