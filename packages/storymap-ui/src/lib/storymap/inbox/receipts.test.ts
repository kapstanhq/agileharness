// O RECIBO e o «RESOLVIDO HOJE» (onda 2, passo 5): cada ação do dono pelo Inbox deixa um desfecho durável, com
// «Desfazer» quando a ação volta atrás; e o que saiu do Inbox nas últimas 24 horas — pelo dono, pelo sistema ou por um
// prazo — segue à vista, para um item que sumiu SEMPRE ter um desfecho.

import { describe, expect, it } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { followUpItems, type SystemDecision } from "@/lib/storymap/system-decisions";
import { bannedTermsIn } from "./copy";
import {
  applyReceiptUndoToCard,
  expiredFacts,
  latestReceiptFor,
  receiptFromInput,
  receiptUndoLabel,
  receiptUndoRefusal,
  resolvedToday,
  undoneText,
  type InboxReceiptRecord,
} from "./receipts";

const config = {
  id: "b",
  name: "Livraria",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "interview", name: "Entrevista", autorun: true },
    { id: "enriquecer", name: "Especificar" },
    { id: "arquivados", name: "Arquivados", terminal: true },
  ],
} as unknown as BoardConfig;
const NOW = Date.parse("2026-09-28T20:00:00Z");
const card = (over: Partial<Card> = {}): Card => ({ ...coerceCard("story-a", { type: "story", title: "Busca por autor", status: "interview" }, ""), ...over });
const receipt = (over: Partial<InboxReceiptRecord> = {}): InboxReceiptRecord => ({
  v: 1,
  id: "rc-1",
  at: "2026-09-28T19:00:00Z",
  board: "b",
  itemId: "story-a:review",
  cardId: "story-a",
  kind: "review",
  ask: "Aceitar «Busca por autor» como trabalho?",
  text: "«Busca por autor» foi para «Entrevista»; o agente começou.",
  undo: { kind: "move-back", boardId: "b", cardId: "story-a", from: "interview", to: "triage", toStaging: true },
  ...over,
});

describe("o «Desfazer» de um recibo — a mesma régua do botão e do servidor", () => {
  it("voltar só vale enquanto o card está onde o clique o deixou", () => {
    const u = receipt().undo!;
    expect(receiptUndoRefusal(u, { config, card: card(), undone: false })).toBeNull();
    expect(receiptUndoRefusal(u, { config, card: card({ status: "enriquecer" }), undone: false })).toMatch(/já andou depois disso \(está em «Especificar»\)/);
    expect(receiptUndoRefusal(u, { config, card: null, undone: false })).toMatch(/não existe mais/);
    expect(receiptUndoRefusal(u, { config, card: card(), undone: true })).toMatch(/já foi desfeito/);
  });

  it("reabrir o aviso só quando ele não está aberto; tirar do arquivo só quando está arquivado", () => {
    const reopen = { kind: "reopen-finding" as const, boardId: "b", cardId: "story-a", findingId: "f1" };
    const f = (status: "open" | "acknowledged") => [{ id: "f1", lens: "general", severity: "low", status, title: "t", detail: "d" }] as Card["findings"];
    expect(receiptUndoRefusal(reopen, { config, card: card({ findings: f("acknowledged") }), undone: false })).toBeNull();
    expect(receiptUndoRefusal(reopen, { config, card: card({ findings: f("open") }), undone: false })).toMatch(/já está aberto/);
    const revive = { kind: "revive-card" as const, boardId: "b", cardId: "story-a" };
    expect(receiptUndoRefusal(revive, { config, card: card({ mode: "retire", retirement: { disposition: "postergado" } as Card["retirement"] }), undone: false })).toBeNull();
    expect(receiptUndoRefusal(revive, { config, card: card(), undone: false })).toMatch(/não está mais arquivado/);
  });

  it("de volta à Triagem, o card é do dono de novo — e o juiz não o re-aceita por cima", () => {
    const back = applyReceiptUndoToCard(receipt().undo as Extract<InboxReceiptRecord["undo"], { kind: "move-back" }>, card(), { today: "2026-09-28" });
    expect(back).toMatchObject({ status: "triage", needsHumanReview: true, triageDecision: { verdict: "hold", by: "human" } });
    expect(undoneText(receipt().undo!, back, config)).toBe("«Busca por autor» voltou para «Triagem».");
  });

  it("cada «Desfazer» diz o que faz", () => {
    expect(receiptUndoLabel(receipt().undo!)).toBe("Desfazer: voltar à Triagem");
    expect(receiptUndoLabel({ kind: "restore-card", boardId: "b", cardId: "c" })).toBe("Desfazer: restaurar da lixeira");
    // o descarte que levou junto o que dependia do card: o desfazer restaura todos, e o rótulo diz isso
    expect(receiptUndoLabel({ kind: "restore-card", boardId: "b", cardId: "c", group: true })).toBe("Desfazer: restaurar todos da lixeira");
    expect(undoneText({ kind: "restore-card", boardId: "b", cardId: "c", group: true }, { title: "Busca por autor" }, { statuses: [] })).toBe("«Busca por autor» voltou da lixeira, com o que tinha ido junto.");
    expect(receiptUndoLabel({ kind: "reopen-finding", boardId: "b", cardId: "c", findingId: "f" })).toBe("Desfazer: reabrir o aviso");
    expect(receiptUndoLabel({ kind: "revive-card", boardId: "b", cardId: "c" })).toBe("Desfazer: tirar do arquivo");
  });
});

describe("gravar um recibo — o que vem do navegador tem forma, ou não entra", () => {
  const meta = { id: "rc-9", at: "2026-09-28T19:00:00Z" };
  const base = { boardId: "b", itemId: "story-a:review", cardId: "story-a", kind: "review", ask: "Aceitar?", text: "Feito." };
  it("aceita o recibo, e o desfazer do mesmo board", () => {
    expect(receiptFromInput({ ...base, undo: receipt().undo }, meta)).toMatchObject({ v: 1, id: "rc-9", board: "b", undo: { kind: "move-back", to: "triage", toStaging: true } });
    expect(receiptFromInput(base, meta)).not.toHaveProperty("undo");
    // a marca do descarte em grupo atravessa a validação (é ela que faz o desfazer restaurar todos); lixo, não
    expect(receiptFromInput({ ...base, undo: { kind: "restore-card", boardId: "b", cardId: "story-a", group: true } }, meta)?.undo).toEqual({ kind: "restore-card", boardId: "b", cardId: "story-a", group: true });
    expect(receiptFromInput({ ...base, undo: { kind: "restore-card", boardId: "b", cardId: "story-a", group: "sim" } as never }, meta)?.undo).toEqual({ kind: "restore-card", boardId: "b", cardId: "story-a" });
  });
  it("recusa um desfazer que aponta para OUTRO board, um kind desconhecido, e o recibo sem texto", () => {
    expect(receiptFromInput({ ...base, undo: { ...receipt().undo!, boardId: "outro" } }, meta)).toBeNull();
    expect(receiptFromInput({ ...base, undo: { kind: "rm-rf", boardId: "b", cardId: "x" } as never }, meta)).toBeNull();
    expect(receiptFromInput({ ...base, text: "  " }, meta)).toBeNull();
    expect(receiptFromInput({ ...base, itemId: "a\nb" }, meta)).toBeNull();
  });
});

describe("«Resolvido hoje» — o desfecho do que saiu do Inbox nas últimas 24 horas", () => {
  const decisions: SystemDecision[] = [
    { v: 1, id: "sd-today", at: "2026-09-28T18:00:00Z", board: "b", cardId: "story-b", agent: "triage-judge", kind: "triage-accept", what: "Aceitou na triagem: «B»", why: "o PRD pede", undo: { kind: "return-to-triage", cardId: "story-b", from: "enriquecer" } },
    { v: 1, id: "sd-old", at: "2026-09-26T10:00:00Z", board: "b", agent: "proxy", kind: "proxy-answer", what: "Respondeu", why: "PRD" },
  ];
  const input = (over: Partial<Parameters<typeof resolvedToday>[0]> = {}) => ({
    receipts: [receipt(), receipt({ id: "rc-old", at: "2026-09-27T10:00:00Z" })],
    decisions: followUpItems(decisions, { board: "b" }),
    expired: [{ boardId: "b", at: "2026-09-28T12:00:00Z", itemId: "apr:x", what: "O pedido de um agente venceu sem resposta — o agente seguiu sem fazer." }],
    boardName: () => "Livraria",
    now: NOW,
    ...over,
  });

  it("junta o que VOCÊ fez, o que o SISTEMA decidiu e o que um PRAZO decidiu — o mais novo primeiro, só das 24 horas", () => {
    const list = resolvedToday(input());
    expect(list.map((e) => [e.who, e.key])).toEqual([
      ["voce", "r:rc-1"],
      ["sistema", "s:sd-today"],
      ["prazo", "p:apr:x"],
    ]);
    expect(list[0]).toMatchObject({ whoLabel: "Você", undo: { source: "receipt", id: "rc-1", label: "Desfazer: voltar à Triagem" } });
    expect(list[1]).toMatchObject({ whoLabel: "Juiz da triagem", undo: { source: "system", id: "sd-today" } });
    expect(list[1].what).toMatch(/por quê: o PRD pede/);
  });

  it("o que foi desfeito segue na lista — dizendo que voltou atrás, sem outro «Desfazer»", () => {
    const undoLine = receipt({ id: "rc-u", at: "2026-09-28T19:05:00Z", undoOf: "rc-1", text: "«Busca por autor» voltou para «Triagem».", undo: undefined });
    const list = resolvedToday(input({ receipts: [receipt(), undoLine] }));
    const mine = list.find((e) => e.key === "r:rc-1")!;
    expect(mine.undoneAt).toBe("2026-09-28T19:05:00Z");
    expect(mine.undo).toBeUndefined();
    // a linha de desfazer não vira um desfecho à parte
    expect(list.some((e) => e.key === "r:rc-u")).toBe(false);
  });

  it("o recibo mais novo de um item é o desfecho da página dele", () => {
    const later = receipt({ id: "rc-2", at: "2026-09-28T19:30:00Z", text: "outro" });
    expect(latestReceiptFor([receipt(), later], "b", "story-a:review")?.id).toBe("rc-2");
    expect(latestReceiptFor([receipt()], "outro", "story-a:review")).toBeNull();
  });

  it("nenhum desfecho gerado pelo modelo fala o jargão do glossário", () => {
    const texts = [
      ...expiredFacts({
        boardId: "b",
        approvals: [{ id: "a1", status: "expired", cardId: "story-a", expiresAt: "2026-09-28T12:00:00Z" }],
        drafts: [{ id: "d1", status: "pending", createdAt: "2026-09-14", origin: null }],
        cardTitle: () => "Busca por autor",
        now: NOW,
      }).map((x) => x.what),
      undoneText({ kind: "restore-card", boardId: "b", cardId: "c" }, card(), config),
      undoneText({ kind: "reopen-finding", boardId: "b", cardId: "c", findingId: "f" }, card(), config),
      undoneText({ kind: "revive-card", boardId: "b", cardId: "c" }, card(), config),
    ];
    for (const t of texts) expect(bannedTermsIn(t), t).toEqual([]);
  });
});

describe("o que um PRAZO decidiu", () => {
  it("o pedido vencido SEM resposta entra; o autorizado que venceu sem uso, não", () => {
    const facts = expiredFacts({
      boardId: "b",
      approvals: [
        { id: "a1", status: "expired", cardId: "story-a", expiresAt: "2026-09-28T12:00:00Z" },
        { id: "a2", status: "expired", expiresAt: "2026-09-28T12:00:00Z", decidedAt: "2026-09-27T12:00:00Z" },
        { id: "a3", status: "pending", expiresAt: "2026-09-29T12:00:00Z" },
      ],
      drafts: [],
      cardTitle: () => "Busca por autor",
      now: NOW,
    });
    expect(facts).toEqual([{ boardId: "b", at: "2026-09-28T12:00:00Z", itemId: "apr:a1", cardId: "story-a", what: "O pedido de um agente sobre «Busca por autor» venceu sem resposta — o agente seguiu sem fazer." }]);
  });

  it("a proposta de PRD vence 14 dias depois de nascer — é essa a hora do desfecho", () => {
    const [fact] = expiredFacts({ boardId: "b", approvals: [], drafts: [{ id: "d1", status: "pending", createdAt: "2026-09-14", origin: null }], cardTitle: () => undefined, now: NOW });
    expect(fact).toMatchObject({ itemId: "gov:d1", at: "2026-09-28T00:00:00.000Z" });
    // dentro do prazo, nada
    expect(expiredFacts({ boardId: "b", approvals: [], drafts: [{ id: "d2", status: "pending", createdAt: "2026-09-20", origin: null }], cardTitle: () => undefined, now: NOW })).toEqual([]);
  });
});
