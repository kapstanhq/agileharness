// DILEMAS (política só-negócio): quando um trade-off técnico afeta o produto (ex.: cortar escopo para cumprir uma data),
// o responsável (o proxy ou o condutor) decide pela meta principal do PRD e grava uma DECISÃO REGISTRADA no card —
// o quê, as opções, a escolha, o porquê (preso ao PRD) e como desfazer. Nada para.

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import {
  appendRecordedDecision,
  recordedDecisionError,
  recordedDecisionRefusal,
  revertRecordedDecision,
  type RecordedDecisionInput,
} from "./recorded-decisions";
import { coerceCard } from "./repo";
import { serializeCard } from "./write";
import { parseCard } from "./contracts";
import { ELEMENT_MERGED_FIELDS, PIPELINE_OWNED_FIELDS } from "./card-merge";
import type { BoardConfig, Card } from "./types";

const ultra = { autonomy: { mode: "ultra" as const } } as Pick<BoardConfig, "autonomy">;
const human = { autonomy: { mode: "human" as const } } as Pick<BoardConfig, "autonomy">;
const card = (over: Partial<Card> = {}): Card => ({ ...coerceCard("story-x", { type: "story", storyType: "technical" }, ""), ...over });

const input = (over: Partial<RecordedDecisionInput> = {}): RecordedDecisionInput => ({
  what: "Cortar o filtro por bairro para entregar a busca na sexta",
  options: ["Entregar sem o filtro", "Atrasar a entrega uma semana"],
  choice: "Entregar sem o filtro",
  why: "A meta principal do PRD é o primeiro uso na semana do lançamento; o filtro é um refinamento",
  prdAnchor: "Meta: busca utilizável por qualquer morador no dia do lançamento",
  undo: "Reabrir o card com o filtro como critério (o código da busca já aceita o parâmetro)",
  ...over,
});

describe("recordedDecisionError — a decisão precisa estar completa", () => {
  it("o quê, porquê e como desfazer são obrigatórios; 2–6 opções distintas; a escolha é uma delas", () => {
    expect(recordedDecisionError(input())).toBeNull();
    expect(recordedDecisionError(input({ what: " " }))).toMatch(/o quê/);
    expect(recordedDecisionError(input({ why: "" }))).toMatch(/porquê/);
    expect(recordedDecisionError(input({ undo: "" }))).toMatch(/desfazer/);
    expect(recordedDecisionError(input({ options: ["só uma"], choice: "só uma" }))).toMatch(/opç/);
    expect(recordedDecisionError(input({ options: ["a", "a"], choice: "a" }))).toMatch(/opç/);
    expect(recordedDecisionError(input({ options: ["a", "b", "c", "d", "e", "f", "g"], choice: "a" }))).toMatch(/opç/);
    expect(recordedDecisionError(input({ choice: "outra coisa" }))).toMatch(/escolha/);
  });
});

describe("recordedDecisionRefusal — quem decide o dilema", () => {
  it("só-negócio: o sistema decide e registra", () => {
    expect(recordedDecisionRefusal(card(), ultra, input())).toBeNull();
  });
  it("modo human: o dilema é do dono — pergunte", () => {
    expect(recordedDecisionRefusal(card(), human, input())).toMatch(/humano|pergunt/i);
  });
  it("um dilema que toca uma classe do dono é pergunta a ele, nunca decisão registrada", () => {
    expect(recordedDecisionRefusal(card(), ultra, input({ ownerClass: "prd" }))).toMatch(/PRD e metas/);
  });
});

describe("appendRecordedDecision / revertRecordedDecision", () => {
  it("ids estáveis d1, d2…; carimba quem e quando", () => {
    const one = appendRecordedDecision([], input(), { by: "harness-conductor", at: "2026-09-28" });
    const two = appendRecordedDecision(one, input({ what: "Outra" }), { by: "proxy", at: "2026-09-29" });
    expect(two.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(two[0]).toMatchObject({ what: input().what, choice: "Entregar sem o filtro", by: "harness-conductor", at: "2026-09-28" });
  });

  it("desfazer marca a decisão uma vez, com quem e o porquê; a segunda vez não muda nada", () => {
    const list = appendRecordedDecision([], input(), { by: "harness-conductor", at: "2026-09-28" });
    const r1 = revertRecordedDecision(list, "d1", { by: "human", at: "2026-09-30", note: "o filtro é essencial" });
    expect(r1[0].reverted).toEqual({ by: "human", at: "2026-09-30", note: "o filtro é essencial" });
    expect(revertRecordedDecision(r1, "d1", { by: "human", at: "2026-10-01" })).toBe(r1);
    expect(revertRecordedDecision(list, "d9", { by: "human", at: "x" })).toBe(list);
  });
});

describe("Card.decisions — type · coerce · contract · serializer · merge", () => {
  it("round-trip pelo serializer real; decisão incompleta cai na leitura", () => {
    const decisions = revertRecordedDecision(appendRecordedDecision([], input(), { by: "harness-conductor", at: "2026-09-28" }), "d1", {
      by: "human",
      at: "2026-09-30",
    });
    const c = coerceCard("story-x", { type: "story", decisions }, "");
    expect(c.decisions).toEqual(decisions);
    expect(parseCard(c).ok).toBe(true);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-x", back.data, back.content).decisions).toEqual(decisions);
    expect(coerceCard("story-x", { type: "story", decisions: [{ id: "d1", what: "x" }] }, "").decisions).toBeUndefined();
  });

  it("é da pipeline (o Save do drawer não apaga) e se funde por id no merge-back", () => {
    expect(PIPELINE_OWNED_FIELDS).toContain("decisions");
    expect(ELEMENT_MERGED_FIELDS).toContain("decisions");
  });
});
