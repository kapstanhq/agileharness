// style-doc invariants (o positioning-doc foi APAGADO: a escada estratégica virou o PRD, um
// documento de schema com fonte markdown — ver doc/schemas/prd.ts): no-op ≡ no change; edits land in the right field;
// unbound content refuses; read-only projections never fold into prose.

import { describe, expect, it } from "vitest";
import type { BoardConfig } from "../types";
import type { StyleGuideDoc } from "../style-guide";
import { commitStyleDoc, projectStyleDoc } from "./style-doc";
import type { DocBlock } from "./doc-model";

const config = (): BoardConfig =>
  ({
    id: "acme",
    name: "Nest",
    statuses: [],
    positioning: "Para quem quer viver a mosaico, o Nest é o amigo esperto.",
    businessMetric: "Receita recorrente da oferta local.",
    desiredOutcome: "Mais gente vivendo a mosaico.",
  }) as unknown as BoardConfig;

const guide = (): StyleGuideDoc => ({
  meta: { version: 3, updatedAt: "2026-07-18", sources: { refs: [] } },
  identity: { school: "editorial suíço", personality: ["calmo", "direto"], prose: "A marca fala baixo e mostra." },
  principles: { items: ["Hierarquia primeiro", "Um acento só"], prose: "Prioridade resolve conflito." },
  color: {
    tokens: [{ role: "accent", value: "#E8A13C", usage: "links e foco", budget: "≤ 10% da área" }],
    budgetRules: [],
    prose: "Âmbar é o único acento.",
  },
  typography: { fonts: [], scale: [{ id: "h1", size: "32/40px", weight: 700 }], rules: [], prose: "Escala curta." },
  spacing: { base: 4, steps: [4, 8, 12], prose: "Base 4." },
  shape: { radii: { card: "12px" }, depth: "flat", borders: "hairline", prose: "Cantos suaves." },
  motion: { durations: { fast: "120ms" }, easings: {}, prose: "Movimento discreto." },
  voice: {
    lexicon: { preferred: [{ use: "programa", avoid: "rolê" }], forbidden: ["zap"], exceptions: [] },
    prose: "Voz de amigo esperto.",
  },
  antiPatterns: [{ symptom: "3 acentos na mesma view", fix: "reduza a 1" }],
  debt: { knownIssues: ["FAB antigo sem token"] },
});

describe("style-doc", () => {
  it("no-op: commit(project(doc), doc) changes nothing", () => {
    const doc = guide();
    const { changedSections, unbound, doc: next } = commitStyleDoc(projectStyleDoc(doc), doc);
    expect(unbound).toEqual([]);
    expect(changedSections).toEqual([]);
    expect(next).toEqual(doc);
  });

  it("prose edit lands in the right section; structured half untouched", () => {
    const doc = guide();
    const model = projectStyleDoc(doc);
    const colorIdx = model.blocks.findIndex(
      (b) => b.kind === "heading" && b.binding === "style:color",
    );
    // the prose paragraph right after the color heading
    const prose = model.blocks[colorIdx + 1];
    if (prose.kind !== "paragraph") throw new Error("expected prose paragraph");
    prose.text = "Âmbar é o acento; verde só em done.";
    const { changedSections, doc: next } = commitStyleDoc(model, doc);
    expect(changedSections).toEqual(["color"]);
    expect(next.color.prose).toBe("Âmbar é o acento; verde só em done.");
    expect(next.color.tokens).toEqual(doc.color.tokens);
    expect(next.meta.version).toBe(doc.meta.version); // promote bumps, nunca o commit
  });

  it("read-only structured sections are skipped, never folded into prose", () => {
    const doc = guide();
    const model = projectStyleDoc(doc);
    const ro = model.blocks.filter(
      (b): b is Extract<DocBlock, { kind: "section" }> =>
        b.kind === "section" && !!b.binding?.startsWith("style-ro:"),
    );
    expect(ro.length).toBeGreaterThan(3);
    // mutate a read-only table cell — commit must ignore it entirely
    const table = ro.flatMap((s) => s.body).find((b) => b.kind === "table");
    if (table && table.kind === "table") table.rows[0][0] = "hackeado";
    const { changedSections } = commitStyleDoc(model, doc);
    expect(changedSections).toEqual([]);
  });

  it("unknown H2 refuses; prose with bullets round-trips", () => {
    const doc = guide();
    doc.voice.prose = "Voz de amigo:\n\n- direto\n- caloroso";
    const model = projectStyleDoc(doc);
    const noop = commitStyleDoc(model, doc);
    expect(noop.changedSections).toEqual([]);

    model.blocks.push({ kind: "heading", id: "h", level: 2, text: "Seção inventada" });
    const { unbound } = commitStyleDoc(model, doc);
    expect(unbound).toHaveLength(1);
  });
});
