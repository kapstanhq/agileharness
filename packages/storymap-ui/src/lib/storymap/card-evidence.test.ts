// conductor-core — the evidence a session writes on MAIN mid-build (add_finding, set_tasks) and the
// STRUCTURED questions ask_question now carries. Pure rules; the actions own the IO.

import { describe, expect, it } from "vitest";
import { addOrRefreshFinding, normalizeTasks, tasksError } from "./card-evidence";
import { addQuestions, addStructuredQuestions, structuredQuestionError } from "./questions";
import type { CardQuestion, Finding } from "./types";

describe("addOrRefreshFinding — add_finding", () => {
  const closed: Finding = { id: "conductor-budget", lens: "general", severity: "high", title: "orçamento", status: "fixed", statusBy: "human", statusAt: "2026-09-24" };

  it("um finding NOVO nasce `open` com id `<lens>-<n>` único", () => {
    const r = addOrRefreshFinding([{ id: "general-1", lens: "general", severity: "low", title: "x", status: "open" }], {
      severity: "blocker",
      title: "rota quebrada",
    });
    expect(r.ok && r.created).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBe("general-2");
    expect(r.findings.at(-1)).toEqual({ id: "general-2", lens: "general", severity: "blocker", title: "rota quebrada", status: "open" });
  });

  it("id ESTÁVEL já existente: atualiza o CONTEÚDO e NUNCA o status (quem muda status é a triagem)", () => {
    const r = addOrRefreshFinding([closed], { id: "conductor-budget", severity: "high", title: "orçamento", detail: "gasto $12 de $10" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(false);
    expect(r.findings[0]).toMatchObject({ status: "fixed", statusBy: "human", detail: "gasto $12 de $10" });
  });

  it("re-adicionar o MESMO conteúdo é no-op (changed:false ⇒ sem escrita ⇒ sem loop do watcher)", () => {
    const r = addOrRefreshFinding([closed], { id: "conductor-budget", severity: "high", title: "orçamento" });
    expect(r.ok && r.changed).toBe(false);
  });

  it("recusa título vazio, severity/lens fora do vocabulário e id malformado", () => {
    expect(addOrRefreshFinding([], { severity: "high", title: "  " }).ok).toBe(false);
    expect(addOrRefreshFinding([], { severity: "critical" as never, title: "x" }).ok).toBe(false);
    expect(addOrRefreshFinding([], { severity: "high", title: "x", lens: "ux" as never }).ok).toBe(false);
    expect(addOrRefreshFinding([], { severity: "high", title: "x", id: "../../x y" }).ok).toBe(false);
  });
});

describe("tasksError / normalizeTasks — set_tasks", () => {
  it("aceita uma lista bem-formada e normaliza espaços", () => {
    const tasks = [{ id: " t1 ", title: " escrever o teste ", done: true }];
    expect(tasksError(tasks)).toBeNull();
    expect(normalizeTasks(tasks)).toEqual([{ id: "t1", title: "escrever o teste", done: true }]);
  });

  it("recusa id duplicado (o train funde tasks POR id), título vazio, done não-booleano e listas enormes", () => {
    expect(tasksError([{ id: "t1", title: "a", done: false }, { id: "t1", title: "b", done: false }])).toMatch(/duplicado/);
    expect(tasksError([{ id: "t1", title: " ", done: false }])).toMatch(/título/);
    expect(tasksError([{ id: "t1", title: "a", done: "yes" as never }])).toMatch(/done/);
    expect(tasksError(Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, title: "x", done: false })))).toMatch(/50/);
  });
});

describe("ask_question ESTRUTURADA", () => {
  const q = {
    text: "O filtro fica no topo ou num menu?",
    context: "muda a hierarquia da tela",
    options: [
      { label: "Topo", pros: ["visível"], cons: ["ocupa espaço"], recommended: true },
      { label: "Menu", pros: ["limpo"], cons: ["escondido"] },
    ],
  };

  it("grava opções (ids o1…), modo single por padrão, contexto — o formato da fila /perguntas", () => {
    const out = addStructuredQuestions([], [q], "harness-conductor", "2026-09-25");
    expect(out).toEqual<CardQuestion[]>([
      {
        id: "q1",
        text: q.text,
        askedBy: "harness-conductor",
        askedAt: "2026-09-25",
        status: "open",
        options: [
          { id: "o1", label: "Topo", pros: ["visível"], cons: ["ocupa espaço"], recommended: true },
          { id: "o2", label: "Menu", pros: ["limpo"], cons: ["escondido"] },
        ],
        mode: "single",
        context: "muda a hierarquia da tela",
      },
    ]);
  });

  it("convive com as de texto (compat): ids seguem a numeração e o dedup por texto aberto vale para as duas", () => {
    const withText = addQuestions([], ["Qual o público?"], "operator", "2026-09-25");
    const out = addStructuredQuestions(withText, [q, { text: "Qual o público?" }], "harness-conductor", "2026-09-25");
    expect(out.map((x) => x.id)).toEqual(["q1", "q2"]);
  });

  it("sem opções, `recommendation` em prosa é gravada", () => {
    const out = addStructuredQuestions([], [{ text: "Nome do botão?", recommendation: "Salvar" }], "a", "d");
    expect(out[0].recommendation).toBe("Salvar");
  });

  it("valida: 1 opção só, 2 recomendadas, opção sem rótulo, recommendation junto com opções", () => {
    expect(structuredQuestionError({ text: "x", options: [{ label: "a" }] })).toMatch(/uma opção/);
    expect(structuredQuestionError({ text: "x", options: [{ label: "a", recommended: true }, { label: "b", recommended: true }] })).toMatch(/UMA/);
    expect(structuredQuestionError({ text: "x", options: [{ label: "a" }, { label: " " }] })).toMatch(/rótulo/);
    expect(structuredQuestionError({ text: "x", options: [{ label: "a" }, { label: "b" }], recommendation: "a" })).toMatch(/recommended/);
    expect(structuredQuestionError({ text: " " })).toMatch(/texto/);
    expect(structuredQuestionError(q)).toBeNull();
  });
});
