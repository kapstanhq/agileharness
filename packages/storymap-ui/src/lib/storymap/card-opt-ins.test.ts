// As duas escolhas OPCIONAIS do dono no início de um card (política só-negócio): a TECNOLOGIA a usar
// (`techPreference`, texto livre — restrição dura do plano) e «quero ver as opções de tela» (`ownerReviewsUi` —
// torna a escolha de tela do card uma decisão dele). Editáveis só enquanto o card não começou a ser construído.

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasStartedConstruction, optInsEditable, optInsRefusal } from "./card-opt-ins";
import { isProxiableQuestion, proxyRefusal } from "./autonomy";
import { whoDecides } from "./decision-class";
import { coerceCard } from "./repo";
import { serializeCard } from "./write";
import { parseCard } from "./contracts";
import { PIPELINE_OWNED_FIELDS } from "./card-merge";
import { buildProxyContextNote, type ProxyRequest } from "./runner/proxy-spawn";
import type { BoardConfig, Card } from "./types";

const config = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "enriquecer", name: "Especificar", trigger: "harness-enrich" },
    { id: "com-design", name: "Aprovar design", gate: "hasWireframe" },
    { id: "plano-tecnico", name: "Plano & Tarefas", trigger: "harness-plan" },
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
    { id: "concluida", name: "No ar", terminal: true },
    { id: "refinar", name: "Refinar", trigger: "harness-refine" },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  autonomy: { mode: "ultra" },
} as unknown as BoardConfig;
const card = (over: Record<string, unknown> = {}): Card => coerceCard("story-x", { type: "story", storyType: "user", status: "enriquecer", ...over }, "");

describe("quando as escolhas ainda podem mudar", () => {
  it("antes do primeiro passo de construção (o trigger do plano/build) e sem trabalho produzido", () => {
    for (const status of [null, "triage", "enriquecer", "com-design"]) expect(optInsEditable(card({ status }), config)).toBe(true);
    for (const status of ["plano-tecnico", "desenvolver", "concluida", "refinar"]) {
      expect(hasStartedConstruction(card({ status }), config)).toBe(true);
      expect(optInsEditable(card({ status }), config)).toBe(false);
    }
  });

  it("plano pronto, tasks ou trabalho produzido também contam como construção começada", () => {
    expect(optInsEditable(card({ techPlanReady: true }), config)).toBe(false);
    expect(optInsEditable(card({ tasks: [{ id: "t1", title: "x", done: false }] }), config)).toBe(false);
    expect(optInsEditable(card({ commitRange: { base: "a", head: "b" } }), config)).toBe(false);
  });

  it("só story tem as escolhas", () => {
    expect(optInsEditable(coerceCard("step-a", { type: "step", status: null }, ""), config)).toBe(false);
  });
});

describe("optInsRefusal — o servidor recusa mudar depois que a construção começou", () => {
  it("mudar tecnologia ou tela num card em construção ⇒ recusa, dizendo onde o card está", () => {
    const prev = card({ status: "desenvolver" });
    expect(optInsRefusal(prev, { ...prev, techPreference: "Postgres" }, config)).toMatch(/Desenvolver/);
    expect(optInsRefusal(prev, { ...prev, ownerReviewsUi: true }, config)).toMatch(/construção/);
  });
  it("sem mudança nas escolhas, nada a recusar (o Save do resto do card segue)", () => {
    const prev = card({ status: "desenvolver", techPreference: "Postgres" });
    expect(optInsRefusal(prev, { ...prev, title: "outro" }, config)).toBeNull();
  });
  it("antes da construção, mudar é livre; um card NOVO já em construção não nasce com elas", () => {
    const prev = card();
    expect(optInsRefusal(prev, { ...prev, techPreference: "Postgres", ownerReviewsUi: true }, config)).toBeNull();
    expect(optInsRefusal(null, card({ status: "desenvolver", ownerReviewsUi: true }), config)).toMatch(/construção/);
  });
});

describe("«quero ver as opções de tela» torna a escolha de tela do DONO", () => {
  it("sem marcar: o sistema escolhe (o proxy responde a ui-choice); marcado: é do dono", () => {
    const q = { id: "q1", text: "Qual variante?", status: "open" as const, category: "ui-choice" as const };
    expect(whoDecides({ kind: "ui-choice" }, card(), config).decider).toBe("system");
    expect(whoDecides({ kind: "ui-choice" }, card({ ownerReviewsUi: true }), config)).toMatchObject({ decider: "owner", ownerClass: null });
    expect(whoDecides({ kind: "question", question: q }, card({ ownerReviewsUi: true }), config).decider).toBe("owner");
    expect(isProxiableQuestion(q, card(), config)).toBe(true);
    expect(isProxiableQuestion(q, card({ ownerReviewsUi: true }), config)).toBe(false);
    expect(proxyRefusal(q, card({ ownerReviewsUi: true }), config)).toMatch(/opções de tela/);
    // as outras perguntas do card seguem do proxy
    expect(isProxiableQuestion({ ...q, category: "technical" }, card({ ownerReviewsUi: true }), config)).toBe(true);
  });
});

describe("a tecnologia pedida chega ao proxy como restrição", () => {
  it("a nota de contexto do proxy nomeia a restrição do dono", () => {
    const req = { board: "b", cardId: "story-x", cardTitle: "X", personas: [], history: [], questions: [], model: "sonnet", techPreference: "Usar o Postgres que já existe" } as ProxyRequest;
    expect(buildProxyContextNote(req)).toMatch(/Tecnologia pedida pelo dono[\s\S]*Postgres/);
  });
});

describe("os campos — type · coerce · contract · serializer; são do DONO (o drawer os edita)", () => {
  it("round-trip; texto vazio e não-booleano caem", () => {
    const c = card({ techPreference: "  Usar o Postgres  ", ownerReviewsUi: true });
    expect(c).toMatchObject({ techPreference: "Usar o Postgres", ownerReviewsUi: true });
    expect(parseCard(c).ok).toBe(true);
    const back = matter(serializeCard(c));
    expect(coerceCard("story-x", back.data, back.content)).toMatchObject({ techPreference: "Usar o Postgres", ownerReviewsUi: true });
    expect(card({ techPreference: " ", ownerReviewsUi: "sim" })).toMatchObject({ techPreference: undefined, ownerReviewsUi: undefined });
  });

  it("NÃO são da pipeline — o Save do drawer é quem as grava", () => {
    expect(PIPELINE_OWNED_FIELDS as readonly string[]).not.toContain("techPreference");
    expect(PIPELINE_OWNED_FIELDS as readonly string[]).not.toContain("ownerReviewsUi");
  });
});

describe("a tela — os dois campos no formulário de campos (criação e página do card)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../components/card/CardFields.tsx", import.meta.url)), "utf8");
  it("a seção existe, usa a MESMA régua do servidor e diz por que travou", () => {
    expect(src).toMatch(/Tecnologia \(opcional\)/);
    expect(src).toMatch(/Quero ver as opções de tela/);
    expect(src).toMatch(/optInsEditable\(/);
    expect(src).toMatch(/techPreference/);
    expect(src).toMatch(/ownerReviewsUi/);
  });
});
