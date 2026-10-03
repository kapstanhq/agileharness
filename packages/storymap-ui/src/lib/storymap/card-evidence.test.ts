// conductor-core — the evidence a session writes on MAIN mid-build (add_finding, set_tasks) and the
// STRUCTURED questions ask_question now carries. Pure rules; the actions own the IO.

import { describe, expect, it } from "vitest";
import { addOrRefreshFinding, normalizeTasks, tasksError, undeclaredLensError } from "./card-evidence";
import { findingBatchItemSchemaFor, FindingBatchItemSchema } from "./contracts";
import { coerceCard } from "./repo";
import { CORE_REVIEW_LENSES } from "./target-profile";
import { CORE_LENS_IDS } from "./types";
import matter from "gray-matter";
import { serializeCard } from "./write";
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

// ── as LENTES de revisão: as embutidas são da ferramenta; as de domínio são DECLARADAS pelo alvo (lote D) ─────────────────
// Fixtures inventadas (oficina de bicicletas): `freios` e `cambio` são lentes de um alvo imaginário.
describe("add_finding — a lente precisa existir no vocabulário do alvo", () => {
  const base = { severity: "high" as const, title: "pinça sem teste de carga" };
  const declared = new Set<string>([...CORE_LENS_IDS, "freios"]);

  it("a lista embutida da ferramenta é a MESMA de target-profile (nenhuma das duas deriva sozinha)", () => {
    expect([...CORE_LENS_IDS]).toEqual(CORE_REVIEW_LENSES.map((l) => l.id));
  });

  it("SEM declaração: só as embutidas — general (padrão) e design passam; uma lente de domínio é recusada dizendo onde declarar", () => {
    expect(addOrRefreshFinding([], base)).toMatchObject({ ok: true, id: "general-1" });
    expect(addOrRefreshFinding([], { ...base, lens: "design" })).toMatchObject({ ok: true, id: "design-1" });
    for (const lens of ["freios", "firestore", "nextjs", "ux"]) {
      const r = addOrRefreshFinding([], { ...base, lens });
      expect(r.ok, lens).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(`lente "${lens}" não declarada`);
        expect(r.error).toContain("security, testing, perf, general, design");
        expect(r.error).toContain("storymap/settings.yaml → target.reviewLenses");
      }
    }
  });

  it("COM declaração: a lente do alvo é aceita e o id gerado leva o nome dela; as embutidas continuam válidas", () => {
    expect(addOrRefreshFinding([], { ...base, lens: "freios", lenses: declared })).toMatchObject({ ok: true, id: "freios-1" });
    expect(addOrRefreshFinding([{ id: "freios-1", lens: "freios", severity: "low", title: "a", status: "open" }], { ...base, lens: "freios", lenses: declared })).toMatchObject({ ok: true, id: "freios-2" });
    expect(addOrRefreshFinding([], { ...base, lens: "security", lenses: declared }).ok).toBe(true);
    expect(addOrRefreshFinding([], { ...base, lens: "cambio", lenses: declared }).ok).toBe(false);
  });

  it("o conjunto não vaza para o finding gravado; um id malformado vira a dica '<id>'", () => {
    const r = addOrRefreshFinding([], { ...base, lens: "freios", lenses: declared });
    expect(r.ok && r.findings[0]).toEqual({ id: "freios-1", lens: "freios", severity: "high", title: base.title, status: "open" });
    expect(undeclaredLensError("Foo Bar!", ["general"])).toContain("target.reviewLenses.<id>");
  });
});

describe("a lente de um finding é lida SEM PERDA (só o malformado cai em «general»)", () => {
  const findings = (...lens: unknown[]) => lens.map((l, i) => ({ id: `f${i}`, lens: l, severity: "low", title: "t", status: "open" }));

  it("lente embutida, de domínio já removida do settings e antiga (ux) sobrevivem ao ler → escrever → ler", () => {
    const c = coerceCard("story-ex9980", { type: "story", title: "x", findings: findings("design", "freios", "ux", "security") }, "");
    expect(c.findings?.map((f) => f.lens)).toEqual(["design", "freios", "ux", "security"]);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-ex9980", back.data, back.content).findings?.map((f) => f.lens)).toEqual(["design", "freios", "ux", "security"]);
  });

  it("lente malformada ou ausente cai em general", () => {
    const c = coerceCard("story-ex9980", { type: "story", title: "x", findings: findings("Foo Bar!", "", undefined, 7, "x".repeat(40)) }, "");
    expect(c.findings?.map((f) => f.lens)).toEqual(["general", "general", "general", "general", "general"]);
  });
});

describe("finding-batch — o gate estrito conhece o conjunto de lentes", () => {
  const item = (lens: string) => ({ lens, severity: "low", title: "x" });

  it("o padrão (sem alvo na mão) aceita só as embutidas; com o conjunto do alvo aceita as dele; continua .strict()", () => {
    expect(FindingBatchItemSchema.safeParse(item("design")).success).toBe(true);
    expect(FindingBatchItemSchema.safeParse(item("freios")).success).toBe(false);
    const withFreios = findingBatchItemSchemaFor(new Set([...CORE_LENS_IDS, "freios"]));
    expect(withFreios.safeParse(item("freios")).success).toBe(true);
    expect(withFreios.safeParse(item("cambio")).success).toBe(false);
    expect(withFreios.safeParse({ ...item("freios"), extra: 1 }).success).toBe(false);
    const refused = FindingBatchItemSchema.safeParse(item("freios"));
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues[0].message).toContain("target.reviewLenses");
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
