// A DECISÃO DO DONO ESPERA: uma decisão que só o dono toma e que ele ainda não respondeu
// ESPERA para sempre — nunca vence, nunca vira a opção recomendada por falta de resposta. O card dela não vai ao ar
// por cima dela (nenhum agente o leva adiante), e o resto do board segue. O lembrete é semanal, no resumo; as
// propostas de PRD mantêm o vencimento de 14 dias.

import { describe, expect, it } from "vitest";
import { decideForward } from "@/lib/notifications/server/channels/cascade-decision";
import { decideAdvance } from "./advance";
import { isProxiableQuestion, proxyRefusal } from "./autonomy";
import { cardCockpitItems, type CockpitItem } from "./demands";
import { foldByCard, itemEntries } from "./inbox/entries";
import { GOVERNANCE_DRAFT_TTL_DAYS } from "./governance";
import { OWNER_DECISION_STOP_REASON, ownerDecisionsWaiting, ownerPublishHold } from "./owner-waiting";
import { coerceCard } from "./repo";
import type { BoardConfig, Card, CardQuestion, StatusDef } from "./types";

const statuses: StatusDef[] = [
  { id: "construir", name: "Construir", autorun: false },
  { id: "aprovar", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
  { id: "integrar", name: "Integrar", autorun: true },
  { id: "release", name: "Liberar", autorun: true },
  { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy", autoEnterTerminal: true, autorun: true },
  { id: "concluida", name: "No ar", terminal: true },
  { id: "refinar", name: "Refinar", autorun: false },
];
const config = (mode: "ultra" | "human" = "ultra"): BoardConfig =>
  ({ id: "b", name: "B", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode } }) as unknown as BoardConfig;

const ownerQ: CardQuestion = { id: "q1", text: "Anunciamos a promoção no mural da loja?", status: "open", category: "owner", ownerClass: "brand-voice", askedAt: "2025-01-02" };
const techQ: CardQuestion = { id: "q2", text: "Cache em memória ou no Redis?", status: "open", category: "technical", askedAt: "2026-09-20" };
const card = (over: Record<string, unknown> = {}): Card =>
  coerceCard("story-x", { type: "story", storyType: "technical", title: "Cache de eventos", status: "aprovar", qaPassed: true, ...over }, "");
const def = (id: string) => statuses.find((s) => s.id === id);

describe("uma decisão do dono nunca vence", () => {
  it("parada há mais de um ano, continua do dono: o proxy não a pega e nada a responde por tempo", () => {
    const c = card({ questions: [ownerQ] });
    expect(proxyRefusal(ownerQ, c, config())).not.toBeNull();
    expect(isProxiableQuestion(ownerQ, c, config())).toBe(false);
    const now = Date.parse("2026-09-28T12:00:00Z");
    const entries = itemEntries(cardCockpitItems(c, config(), "b"), { boardId: "b", boardName: "B", config: config(), cardsById: new Map([[c.id, c]]), now });
    const waiting = ownerDecisionsWaiting(entries, config(), now);
    expect(waiting).toEqual([expect.objectContaining({ cardId: "story-x", kind: "question", what: ownerQ.text, days: expect.any(Number) })]);
    expect(waiting[0].days).toBeGreaterThan(365);
  });

  it("as propostas de PRD mantêm o vencimento de 14 dias (a única decisão que sai do Inbox sozinha — e o board fica como estava)", () => {
    expect(GOVERNANCE_DRAFT_TTL_DAYS).toBe(14);
  });
});

describe("ownerPublishHold — o card não vai ao ar por cima de uma decisão do dono", () => {
  it("pergunta do dono aberta: sair de «Aprovar entrega» para frente espera; a técnica não segura nada", () => {
    expect(ownerPublishHold(card({ questions: [ownerQ] }), def("aprovar"), def("integrar"), config())).toMatch(/mural da loja/);
    expect(ownerPublishHold(card({ questions: [techQ] }), def("aprovar"), def("integrar"), config())).toBeNull();
  });

  it("o card toca uma classe do dono: publicar é dele", () => {
    const touched = card({ businessClasses: { ids: ["money"], reason: "passa do teto de infraestrutura", by: "harness-conductor", at: "2026-09-28" } });
    expect(ownerPublishHold(touched, def("release"), def("deploy"), config())).toMatch(/Dinheiro/);
  });

  // Num caso real: o dono aprovou a entrega (moveu de «Aprovar entrega» para «Integrar») e o card,
  // que toca dados de pessoas, ficou parado em «Integrar» para sempre — a cascata recusava cada passo seguinte.
  it("depois que o DONO aprova a entrega, a classe do card deixa de segurar — a cascata o leva até o ar", () => {
    const touched = card({ status: "integrar", businessClasses: { ids: ["personal-data"], reason: "envia dados a um fornecedor", by: "triage-judge", at: "2026-10-01" } });
    expect(ownerPublishHold(touched, def("integrar"), def("release"), config())).toMatch(/Dados de pessoas|personal-data/);
    expect(ownerPublishHold(touched, def("integrar"), def("release"), config(), { ownerApproved: true })).toBeNull();
    expect(decideForward(touched, def("integrar")!, config())).toMatchObject({ action: "stop" });
    expect(decideForward(touched, def("integrar")!, config(), { ownerApproved: true })).toEqual({ action: "forward", to: "release" });
  });

  it("…mas uma PERGUNTA do dono ainda aberta continua segurando, aprovada a entrega ou não", () => {
    const asked = card({ status: "integrar", questions: [ownerQ], businessClasses: { ids: ["money"], reason: "x", by: "harness-conductor", at: "2026-10-01" } });
    expect(ownerPublishHold(asked, def("integrar"), def("release"), config(), { ownerApproved: true })).toMatch(/mural da loja/);
    expect(ownerPublishHold(asked, def("integrar"), def("release"), config(), { ownerApproved: true })).not.toMatch(/Dinheiro/);
  });

  it("só para FRENTE, rumo ao ar: chegar em «Aprovar entrega», voltar para refinar ou arquivar seguem livres", () => {
    const c = card({ questions: [ownerQ] });
    expect(ownerPublishHold({ ...c, status: "construir" }, def("construir"), def("aprovar"), config())).toBeNull();
    expect(ownerPublishHold(c, def("aprovar"), def("refinar"), config())).toBeNull();
    expect(ownerPublishHold(c, def("aprovar"), def("concluida"), config())).toBeNull();
    // pular a aprovação também espera
    expect(ownerPublishHold({ ...c, status: "construir" }, def("construir"), def("integrar"), config())).not.toBeNull();
  });

  it("modo humano: o dono já aprova cada passo — nenhuma trava nova", () => {
    expect(ownerPublishHold(card({ questions: [ownerQ] }), def("aprovar"), def("integrar"), config("human"))).toBeNull();
  });

  it("a cascata e o advance-card param com o motivo; sem decisão do dono, seguem", () => {
    const held = card({ status: "release", questions: [ownerQ] });
    const stop = decideForward(held, def("release")!, config());
    expect(stop).toMatchObject({ action: "stop" });
    expect(stop.action === "stop" && stop.reason.startsWith(OWNER_DECISION_STOP_REASON)).toBe(true);
    expect(decideAdvance(held, config())).toMatchObject({ action: "blocked", to: "deploy" });
    const free = card({ status: "release", questions: [techQ] });
    expect(decideForward(free, def("release")!, config())).toEqual({ action: "forward", to: "deploy" });
    expect(decideAdvance(free, config())).toMatchObject({ action: "advance", to: "deploy" });
  });
});

describe("ownerDecisionsWaiting — o que espera o dono (o lembrete semanal lê daqui)", () => {
  it("só as decisões do dono, a mais antiga primeiro; o que o sistema decide e as amostras ficam de fora", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    const a = card({ id: "story-a", questions: [ownerQ, techQ] });
    const touched = coerceCard("story-t", { type: "story", storyType: "technical", title: "Plano pago do mapa", status: "aprovar", qaPassed: true, tasks: [{ id: "t", title: "t", done: true }], businessClasses: { ids: ["money"], reason: "plano pago", by: "juiz", at: "2026-09-20" } }, "");
    const plain = coerceCard("story-p", { type: "story", storyType: "technical", title: "Índice", status: "aprovar", qaPassed: true, tasks: [{ id: "t", title: "t", done: true }] }, "");
    const governance: CockpitItem = { id: "gov:d1", kind: "governance", boardId: "b", cardId: "", cardTitle: "", status: null, lane: "aprovar", severity: "medium", since: "2026-09-21T10:00:00Z", draftId: "d1", changes: [], reason: "trocar a meta principal", conflicts: [] };
    const items = [...cardCockpitItems(a, config(), "b"), ...cardCockpitItems(touched, config(), "b", { stepEnteredAt: new Map([["story-t", "2026-09-25T09:00:00Z"]]) }), ...cardCockpitItems(plain, config(), "b"), governance];
    const cards = new Map([a, touched, plain].map((c) => [c.id, c]));
    // as entradas do Inbox — o lembrete lê o MESMO Decidir do badge
    const entries = foldByCard(itemEntries(items, { boardId: "b", boardName: "B", config: config(), cardsById: cards, now }));
    const waiting = ownerDecisionsWaiting(entries, config(), now);
    expect(waiting.map((w) => [w.kind, w.cardId])).toEqual([
      ["question", "story-x"],
      ["governance", ""],
      ["gate", "story-t"],
    ]);
    // a decisão como o dono a lê, com a classe dele
    expect(waiting[1]).toMatchObject({ what: expect.stringMatching(/^Aprovar .*PRD/), days: 7, ownerClass: expect.stringMatching(/PRD/) });
    expect(waiting[2]).toMatchObject({ what: expect.stringMatching(/«Plano pago do mapa»/), ownerClass: expect.stringMatching(/Dinheiro/), days: 3 });
  });
});
