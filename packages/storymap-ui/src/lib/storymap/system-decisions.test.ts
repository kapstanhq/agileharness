// O REGISTRO do que o sistema decidiu em nome do dono (política só-negócio) — a parte pura: as entradas de cada produtor,
// a projeção para o futuro «Acompanhar» do Inbox, as pré-condições de cada «Desfazer» e o que cada um faz no card.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agentLabel,
  applyUndoToCard,
  undoLabel,
  deliverySkipEntry,
  dilemmaEntry,
  followUpItems,
  proxyAnswerEntries,
  publishEntry,
  recoveryFixCardEntry,
  triageJudgeEntry,
  undoRefusal,
  type SystemDecision,
} from "./system-decisions";
import { coerceCard } from "./repo";
import type { BoardConfig, Card } from "./types";

const statuses = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "enriquecer", name: "Especificar" },
  { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
  { id: "cancelado", name: "Cancelado", terminal: true },
];
const config = { id: "b", name: "B", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "ultra" } } as unknown as BoardConfig;
const card = (id: string, over: Record<string, unknown> = {}): Card => coerceCard(id, { type: "story", storyType: "technical", title: `Card ${id}`, ...over }, "");
const at = "2026-09-28T12:00:00.000Z";

describe("as entradas de cada produtor — quem, o quê, por quê, quando, o card e o «Desfazer»", () => {
  it("juiz da triagem: aceitar/descartar/juntar voltam à Triagem; levar ao dono não é decisão em nome dele", () => {
    const accepted = card("story-a", { status: "enriquecer", triageDecision: { verdict: "accept", reason: "serve a aposta 1", from: "triage", to: "enriquecer", by: "triage-judge", at: "2026-09-28" } });
    const e = triageJudgeEntry("b", accepted, { at, id: "sd-1" })!;
    expect(e).toMatchObject({ board: "b", cardId: "story-a", agent: "triage-judge", kind: "triage-accept", why: "serve a aposta 1", undo: { kind: "return-to-triage", cardId: "story-a", from: "enriquecer" } });
    expect(e.what).toMatch(/Card story-a/);
    const owner = card("story-o", { status: "triage", triageDecision: { verdict: "owner", reason: "API paga", by: "triage-judge", at: "x" } });
    expect(triageJudgeEntry("b", owner, { at, id: "sd-2" })).toBeNull();
  });

  it("proxy: uma entrada por resposta aplicada; a escolha de tela guarda as alternativas", () => {
    const c = card("story-p", {
      questions: [
        { id: "q1", text: "Cursor ou offset?", status: "answered", answer: "cursor", answeredBy: "proxy", category: "technical", proxy: { assumptions: "PRD: tempo de resposta", confidence: 0.8 } },
        { id: "q2", text: "Qual tela?", status: "answered", answeredBy: "proxy", category: "ui-choice", selectedOptionIds: ["o2"], options: [{ id: "o1", label: "variante-a" }, { id: "o2", label: "variante-b" }], proxy: { assumptions: "guia de estilo", confidence: 0.7 } },
      ],
    });
    const [tech, ui] = proxyAnswerEntries("b", c, ["q1", "q2"], { at, idOf: (q) => `sd-${q}` });
    expect(tech).toMatchObject({ kind: "proxy-answer", agent: "proxy", why: "PRD: tempo de resposta", undo: { kind: "reopen-question", cardId: "story-p", questionId: "q1" } });
    expect(ui).toMatchObject({ kind: "ui-choice", alternatives: ["variante-a", "variante-b"] });
    expect(ui.what).toMatch(/variante-b/);
  });

  it("dilema, card de conserto, entrega sem aprovação e publicação", () => {
    const d = dilemmaEntry("b", "story-x", { id: "d1", what: "Cortar o filtro", options: ["a", "b"], choice: "a", why: "meta", undo: "reabrir", by: "harness-conductor", at: "2026-09-28" }, { at, id: "sd-3" });
    expect(d).toMatchObject({ kind: "dilemma", agent: "harness-conductor", alternatives: ["a", "b"], undo: { kind: "revert-decision", cardId: "story-x", decisionId: "d1" } });
    const r = recoveryFixCardEntry("b", { itemId: "story-t:stuck:error", cardId: "story-t", cardTitle: "T", fixCardId: "story-fix" }, { at, id: "sd-4" });
    expect(r).toMatchObject({ kind: "recovery-fix-card", agent: "jido", cardId: "story-fix", undo: { kind: "discard-card", cardId: "story-fix" } });
    const s = deliverySkipEntry("b", card("story-d", { status: "concluida" }), { at, id: "sd-5" });
    expect(s).toMatchObject({ kind: "delivery-skip", undo: { kind: "reopen-card", cardId: "story-d", deliveredIn: "concluida" } });
    // fase 6 (6D): sem o veredito do verificador o registro NÃO diz «verificador» — a entrega é auto-certificada
    expect(s).toMatchObject({ agent: "auto-certificada" });
    expect(s.why).not.toMatch(/verificador independente aprovou/);
    const v = deliverySkipEntry("b", card("story-d", { status: "concluida" }), { at, id: "sd-5b", verified: { runId: "r1", model: "sonnet" } });
    expect(v).toMatchObject({ agent: "verifier", why: expect.stringMatching(/verificador independente/) });
    expect(publishEntry("b", card("story-q"), { sha: "bbb", previousSha: "aaa" }, { at, id: "sd-6" }).undo).toEqual({ kind: "republish-previous", cardId: "story-q", sha: "bbb", previousSha: "aaa" });
    // sem sha anterior não há para onde voltar: sem «Desfazer»
    expect(publishEntry("b", card("story-q"), { sha: "bbb" }, { at, id: "sd-7" }).undo).toBeUndefined();
  });
});

describe("followUpItems — a projeção pura para o «Acompanhar»", () => {
  const e = (id: string, over: Partial<SystemDecision> = {}): SystemDecision => ({ v: 1, id, at, board: "b", agent: "proxy", kind: "proxy-answer", what: id, why: "x", ...over });

  it("do board, mais novo primeiro, com o que ainda pode ser desfeito", () => {
    const entries = [
      e("sd-1", { at: "2026-09-28T10:00:00Z", undo: { kind: "reopen-question", cardId: "c", questionId: "q1" } }),
      e("sd-2", { at: "2026-09-28T11:00:00Z", board: "outro" }),
      e("sd-3", { at: "2026-09-28T12:00:00Z", undo: { kind: "discard-card", cardId: "c2" } }),
      e("sd-4", { at: "2026-09-28T13:00:00Z", kind: "undo", agent: "human", undoOf: "sd-3" }),
    ];
    const items = followUpItems(entries, { board: "b" });
    expect(items.map((i) => i.id)).toEqual(["sd-3", "sd-1"]);
    expect(items[0]).toMatchObject({ undoable: false, undoneAt: "2026-09-28T13:00:00Z" });
    expect(items[1]).toMatchObject({ undoable: true });
    expect(followUpItems(entries, { board: "b", since: "2026-09-28T11:30:00Z" }).map((i) => i.id)).toEqual(["sd-3"]);
  });
});

describe("undoRefusal — as pré-condições de cada «Desfazer» (a mesma régua do botão e do servidor)", () => {
  const entry = (undo: SystemDecision["undo"]): SystemDecision => ({ v: 1, id: "sd-1", at, board: "b", agent: "x", kind: "triage-accept", what: "x", why: "y", undo });

  it("sem handle, ou já desfeita: recusa", () => {
    expect(undoRefusal(entry(undefined), { config })).toMatch(/não tem como desfazer/);
    expect(undoRefusal(entry({ kind: "discard-card", cardId: "c" }), { config, undone: true })).toMatch(/já foi desfeita/);
  });

  it("voltar à Triagem: só se o card ainda está onde a decisão o deixou", () => {
    const u = entry({ kind: "return-to-triage", cardId: "c", from: "enriquecer" });
    expect(undoRefusal(u, { config, card: card("c", { status: "enriquecer" }) })).toBeNull();
    expect(undoRefusal(u, { config, card: card("c", { status: "desenvolver" }) })).toMatch(/já andou/);
    expect(undoRefusal(u, { config })).toMatch(/não existe/);
  });

  it("reabrir a pergunta: só uma resposta do proxy ainda de pé", () => {
    const u = entry({ kind: "reopen-question", cardId: "c", questionId: "q1" });
    const answered = card("c", { questions: [{ id: "q1", text: "?", status: "answered", answer: "a", answeredBy: "proxy", proxy: { assumptions: "x", confidence: 1 } }] });
    expect(undoRefusal(u, { config, card: answered })).toBeNull();
    const open = card("c", { questions: [{ id: "q1", text: "?", status: "open" }] });
    expect(undoRefusal(u, { config, card: open })).toMatch(/não está respondida pelo sistema/);
  });

  // paradas por recurso, fatia 3: o SISTEMA também responde sozinho (a aprovação do teto de gasto pela regra) — e o
  // dono desfaz do mesmo jeito. Uma resposta de gente nunca se desfaz por aqui.
  it("reabrir a pergunta: a aprovação do sistema também se desfaz; a resposta de uma pessoa, não", () => {
    const u = entry({ kind: "reopen-question", cardId: "c", questionId: "q1" });
    const bySystem = card("c", { questions: [{ id: "q1", text: "Subir o teto?", status: "answered", answer: "Aprovado pelo sistema", answeredBy: "system", selectedOptionIds: ["o1"], askedBy: "teto:70" }] });
    expect(undoRefusal(u, { config, card: bySystem })).toBeNull();
    const byHuman = card("c", { questions: [{ id: "q1", text: "Subir o teto?", status: "answered", answer: "sim", selectedOptionIds: ["o1"] }] });
    expect(undoRefusal(u, { config, card: byHuman })).toMatch(/não está respondida pelo sistema/);
  });

  it("reabrir a entrega pede o motivo e o card ainda no ar", () => {
    const u = entry({ kind: "reopen-card", cardId: "c", deliveredIn: "concluida" });
    expect(undoRefusal(u, { config, card: card("c", { status: "concluida" }), note: "o filtro sumiu" })).toBeNull();
    expect(undoRefusal(u, { config, card: card("c", { status: "concluida" }) })).toMatch(/motivo/);
    expect(undoRefusal(u, { config, card: card("c", { status: "desenvolver" }), note: "x" })).toMatch(/saiu/);
  });

  it("desfazer o card de conserto: só antes de a construção começar", () => {
    const u = entry({ kind: "discard-card", cardId: "c" });
    expect(undoRefusal(u, { config, card: card("c", { status: "triage" }) })).toBeNull();
    expect(undoRefusal(u, { config, card: card("c", { status: "desenvolver" }) })).toMatch(/construção/);
  });

  it("desfazer um dilema: a decisão existe e ainda não foi desfeita", () => {
    const u = entry({ kind: "revert-decision", cardId: "c", decisionId: "d1" });
    const d = { id: "d1", what: "w", options: ["a", "b"], choice: "a", why: "y", undo: "u", by: "x", at: "x" };
    expect(undoRefusal(u, { config, card: card("c", { decisions: [d] }) })).toBeNull();
    expect(undoRefusal(u, { config, card: card("c", { decisions: [{ ...d, reverted: { by: "human", at: "x" } }] }) })).toMatch(/já foi desfeita/);
  });
});

describe("applyUndoToCard — o que cada «Desfazer» faz no card (puro; o servidor aplica sob o lock)", () => {
  const opts = { today: "2026-09-29", note: "não era isso" };

  it("voltar à Triagem: o card volta à quarentena, e é do DONO (o juiz não re-julga por cima do veto)", () => {
    const c = card("c", { status: "enriquecer", triageDecision: { verdict: "accept", reason: "x", by: "triage-judge", at: "x" } });
    const out = applyUndoToCard({ kind: "return-to-triage", cardId: "c", from: "enriquecer" }, c, config, opts);
    expect(out).toMatchObject({ status: "triage", needsHumanReview: true, triageDecision: { verdict: "hold", by: "human" } });
    expect(out.triageDecision?.reason).toMatch(/não era isso/);
  });

  it("reabrir a pergunta: volta ABERTA para o dono, com o que o proxy assumiu, e nunca mais vai ao proxy", () => {
    const c = card("c", { questions: [{ id: "q1", text: "?", status: "answered", answer: "cursor", answeredBy: "proxy", category: "technical", proxy: { assumptions: "PRD", confidence: 0.8 } }] });
    const q = applyUndoToCard({ kind: "reopen-question", cardId: "c", questionId: "q1" }, c, config, opts).questions![0];
    expect(q).toMatchObject({ status: "open", proxy: { auditOutcome: "reopened" } });
    expect(q.answer).toBeUndefined();
    expect(q.context).toMatch(/cursor/);
  });

  it("reabrir a entrega: volta por refino com o motivo e um achado aberto", () => {
    const out = applyUndoToCard({ kind: "reopen-card", cardId: "c", deliveredIn: "concluida" }, card("c", { status: "concluida" }), config, opts);
    expect(out).toMatchObject({ mode: "refine", status: "desenvolver", reopenPending: true });
    expect(out.findings.some((f) => f.status === "open" && f.detail === "não era isso")).toBe(true);
  });

  it("desfazer o dilema: marca a decisão e abre um achado com o como-desfazer", () => {
    const d = { id: "d1", what: "Cortar o filtro", options: ["a", "b"], choice: "a", why: "y", undo: "reabrir com o filtro", by: "x", at: "x" };
    const out = applyUndoToCard({ kind: "revert-decision", cardId: "c", decisionId: "d1" }, card("c", { decisions: [d] }), config, opts);
    expect(out.decisions![0].reverted).toMatchObject({ by: "human", note: "não era isso" });
    expect(out.findings.find((f) => f.status === "open")?.detail).toMatch(/reabrir com o filtro/);
  });

  it("desfazer o card de conserto: vai para o cancelado", () => {
    expect(applyUndoToCard({ kind: "discard-card", cardId: "c" }, card("c", { status: "triage" }), config, opts).status).toBe("cancelado");
  });
});

describe("a superfície provisória «Acompanhar» (a onda 2 do Inbox a absorve)", () => {
  it("nomeia quem decidiu e o que o desfazer faz, em português", () => {
    expect(agentLabel("triage-judge")).toBe("Juiz da triagem");
    expect(agentLabel("proxy")).toBe("Procurador");
    expect(agentLabel("deploy-proof")).toBe("Produtor da prova de deploy");
    expect(undoLabel({ kind: "reopen-card", cardId: "c", deliveredIn: "x" })).toMatch(/motivo/);
    expect(undoLabel({ kind: "return-to-triage", cardId: "c", from: "x" })).toMatch(/Triagem/);
  });

  // Fase 3: a página /acompanhar virou parte de «Os agentes estão cuidando», no fim do Inbox — o registro (os dias
  // anteriores a «Resolvido hoje») sai da MESMA projeção pura, e o «Desfazer» é o do Inbox (UndoControl), que chama a
  // ação de servidor (a pré-condição é dela).
  it("o registro do Inbox lista pela projeção pura e desfaz pela ação de servidor (a pré-condição é dela)", () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(read("../../components/inbox/registry.ts")).toMatch(/followUpItems\(/);
    expect(read("../../components/inbox/UndoControl.tsx")).toMatch(/undoSystemDecisionAction\(/);
    // o link antigo /acompanhar é redirecionado no next.config (antes de qualquer render) para a seção aberta
    expect(read("../../../next.config.js")).toMatch(/source: "\/board\/:boardId\/acompanhar"/);
  });
});
