import { describe, expect, it } from "vitest";
import { coerceCard } from "../repo";
import type { BoardConfig, Card } from "../types";
import {
  acceptRoute,
  buildTriageBugReport,
  buildTriageRefinement,
  decideTriage,
  inferTriagePlacement,
  parseTriage,
  refineAppliesTo,
  sanitizeIntakeText,
  triagePlacementGap,
  TRIAGE_CONFIDENCE_THRESHOLD,
} from "./parse";
import type { TriageReport } from "./types";

// Fase 1 — the deterministic core of the triage intake: the allowlist cage
// (parseTriage), the prompt-injection sanitizer, and the confidence gate (decideTriage).
// The LLM call itself is integration; everything that keeps it SAFE is unit-tested here.

const config = { id: "b", name: "B", statuses: [], releases: [], personas: [], systems: [], linkTypes: [] } as BoardConfig;
const cards: Card[] = [
  coerceCard("story-a", { type: "story", title: "A" }, ""),
  coerceCard("story-b", { type: "story", title: "B" }, ""),
];

const report = (over: Partial<TriageReport>): TriageReport => ({
  verb: "create",
  intent: "bug",
  storyType: "bug",
  severity: "medium",
  frequency: "sometimes",
  hasWorkaround: false,
  title: "t",
  summary: "s",
  labels: [],
  relatesTo: [],
  duplicateOf: null,
  declineReason: null,
  confidence: 1,
  reasoning: "r",
  ...over,
});

describe("sanitizeIntakeText — neutralize injection carriers", () => {
  it("strips control + zero-width chars but keeps tab/newline", () => {
    const dirty = `ok${String.fromCharCode(0x07)}${String.fromCharCode(0x200b)}\tend`;
    expect(sanitizeIntakeText(dirty)).toBe("ok\tend");
  });

  it("caps very long input", () => {
    expect(sanitizeIntakeText("x".repeat(5000)).length).toBe(4000);
  });

  it("handles null/undefined safely", () => {
    expect(sanitizeIntakeText(undefined as unknown as string)).toBe("");
  });
});

describe("parseTriage — the allowlist cage", () => {
  it("keeps a well-formed report intact", () => {
    const raw = JSON.stringify({
      verb: "create",
      storyType: "bug",
      severity: "high",
      title: "Catálogo não carrega imagens",
      summary: "imagens 404 no catálogo",
      labels: ["catalogo", "regressao"],
      relatesTo: ["story-a"],
      duplicateOf: null,
      declineReason: null,
      confidence: 0.9,
      reasoning: "regressão clara",
    });
    const r = parseTriage(raw, config, cards);
    expect(r).toMatchObject({
      verb: "create",
      storyType: "bug",
      severity: "high",
      labels: ["catalogo", "regressao"],
      relatesTo: ["story-a"],
      confidence: 0.9,
    });
  });

  it("falls back unknown verb→create, unknown storyType→bug, invalid severity→medium", () => {
    const r = parseTriage(
      JSON.stringify({ verb: "nuke", storyType: "epic", severity: "catastrophic" }),
      config,
      cards,
    );
    expect(r.verb).toBe("create");
    expect(r.storyType).toBe("bug");
    expect(r.severity).toBe("medium");
  });

  it("drops a duplicateOf / relatesTo that don't point at a real card", () => {
    const r = parseTriage(
      JSON.stringify({ duplicateOf: "story-ghost", relatesTo: ["story-a", "nope"] }),
      config,
      cards,
    );
    expect(r.duplicateOf).toBeNull();
    expect(r.relatesTo).toEqual(["story-a"]);
  });

  it("clamps confidence to [0,1] and defaults non-numbers to 0", () => {
    expect(parseTriage(JSON.stringify({ confidence: 5 }), config, cards).confidence).toBe(1);
    expect(parseTriage(JSON.stringify({ confidence: -3 }), config, cards).confidence).toBe(0);
    expect(parseTriage(JSON.stringify({ confidence: "nope" }), config, cards).confidence).toBe(0);
  });

  it("sanitizes labels: trims, dedupes, caps count", () => {
    const many = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const r = parseTriage(JSON.stringify({ labels: [" a ", "a", "", ...many] }), config, cards);
    expect(r.labels.length).toBeLessThanOrEqual(8);
    expect(r.labels[0]).toBe("a");
    expect(new Set(r.labels).size).toBe(r.labels.length); // no dupes
  });

  // WS6 (F5) — the SUGGESTED placement (read-only): validated against real card ids, sparse.
  it("keeps a placement whose parentSuggestion/serves are REAL card ids", () => {
    const r = parseTriage(
      JSON.stringify({ placement: { parentSuggestion: "story-a", serves: "story-b", rationale: "encaixa aqui" } }),
      config,
      cards,
    );
    expect(r.placement).toEqual({ parentSuggestion: "story-a", serves: "story-b", rationale: "encaixa aqui" });
  });

  it("DROPS a hallucinated placement id (mirrors relatesTo); a lone rationale is not a placement", () => {
    const r = parseTriage(JSON.stringify({ placement: { parentSuggestion: "ghost", rationale: "x" } }), config, cards);
    expect(r.placement).toBeUndefined();
  });

  it("omits placement entirely when absent (sparse)", () => {
    expect(parseTriage(JSON.stringify({ title: "t" }), config, cards).placement).toBeUndefined();
  });

  it("extracts JSON wrapped in code fences / prose", () => {
    const raw = 'Aqui está:\n```json\n{"verb":"decline","declineReason":"spam","confidence":0.95}\n```';
    const r = parseTriage(raw, config, cards);
    expect(r.verb).toBe("decline");
    expect(r.declineReason).toBe("spam");
  });
});

describe("decideTriage — confidence gate + verb resolution", () => {
  it("high-confidence duplicate with a canonical → duplicado terminal", () => {
    const o = decideTriage(report({ verb: "duplicate", duplicateOf: "story-a", confidence: 0.95 }));
    expect(o).toEqual({ status: "duplicado", needsHumanReview: false, duplicateOf: "story-a" });
  });

  it("high-confidence decline → cancelado terminal", () => {
    const o = decideTriage(report({ verb: "decline", confidence: 0.9 }));
    expect(o.status).toBe("cancelado");
    expect(o.needsHumanReview).toBe(false);
  });

  it("create (high confidence) → triage, no human review needed", () => {
    const o = decideTriage(report({ verb: "create", confidence: 0.9 }));
    expect(o).toEqual({ status: "triage", needsHumanReview: false, duplicateOf: null });
  });

  it("ESCAPE HATCH: low confidence never auto-dedupes/declines → triage + needsHumanReview", () => {
    const lo = TRIAGE_CONFIDENCE_THRESHOLD - 0.1;
    expect(decideTriage(report({ verb: "duplicate", duplicateOf: "story-a", confidence: lo }))).toEqual({
      status: "triage",
      needsHumanReview: true,
      duplicateOf: null,
    });
    expect(decideTriage(report({ verb: "decline", confidence: lo })).status).toBe("triage");
  });

  it("duplicate WITHOUT a canonical can't be anchored → triage even at high confidence", () => {
    const o = decideTriage(report({ verb: "duplicate", duplicateOf: null, confidence: 0.99 }));
    expect(o.status).toBe("triage");
  });
});

// --- Routing (Opção B, Fase 2) ---------------------------------------------

describe("parseTriage — intent + bug axes", () => {
  it("keeps a valid intent; defaults to bug for a bug storyType, feature otherwise", () => {
    expect(parseTriage(JSON.stringify({ intent: "melhoria", storyType: "user" }), config, cards).intent).toBe("melhoria");
    expect(parseTriage(JSON.stringify({ storyType: "bug" }), config, cards).intent).toBe("bug"); // derived
    expect(parseTriage(JSON.stringify({ storyType: "user" }), config, cards).intent).toBe("feature"); // derived
    expect(parseTriage(JSON.stringify({ intent: "garbage", storyType: "technical" }), config, cards).intent).toBe("feature");
  });

  it("parses frequency + hasWorkaround, with safe defaults", () => {
    const r = parseTriage(JSON.stringify({ frequency: "always", hasWorkaround: true }), config, cards);
    expect(r.frequency).toBe("always");
    expect(r.hasWorkaround).toBe(true);
    const d = parseTriage(JSON.stringify({ frequency: "nope" }), config, cards);
    expect(d.frequency).toBe("sometimes"); // invalid → neutral default
    expect(d.hasWorkaround).toBe(false); // absent → worst-case default
  });
});

describe("acceptRoute — promote out of triage by kind", () => {
  const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");
  it("bug (storyType bug / fix mode) → corrigir", () => {
    expect(acceptRoute(card({ storyType: "bug" }))).toBe("corrigir");
    expect(acceptRoute(card({ storyType: "user", mode: "fix" }))).toBe("corrigir");
  });
  it("melhoria (refine mode) → refinar", () => {
    expect(acceptRoute(card({ mode: "refine" }))).toBe("refinar");
  });
  it("user feature → interview (discovery FIRST); non-user feature → enriquecer (skips interview)", () => {
    expect(acceptRoute(card({ storyType: "user" }))).toBe("interview");
    expect(acceptRoute(card({ storyType: "technical" }))).toBe("enriquecer");
    expect(acceptRoute(card({ storyType: "chore" }))).toBe("enriquecer");
  });
});

describe("canonical block builders (satisfy the lane gates)", () => {
  it("buildTriageBugReport carries the brief + severity (expected/actual deferred to harness-fix)", () => {
    const br = buildTriageBugReport(report({ summary: "o botão X não fecha", severity: "high" }));
    expect(br.brief).toBe("o botão X não fecha");
    expect(br.severity).toBe("high");
    expect(br.steps).toEqual([]);
    expect(br.expected).toBeNull();
  });
  it("buildTriageRefinement carries the brief + a default functionality kind", () => {
    const ref = buildTriageRefinement(report({ summary: "deixar o header mais limpo" }));
    expect(ref.brief).toBe("deixar o header mais limpo");
    expect(ref.kinds).toEqual(["functionality"]);
  });
});

// Defeito: a triagem criou uma entrega (technical) com `parent: null` e sem `serves`, a partir
// de outra entrega que SERVIA uma user story. O aceite falhou com «Este card não tem lugar na
// hierarquia». O lugar estava a um passo: o card relacionado já dizia a quem ele serve.
describe("inferTriagePlacement — o lugar no mapa, inferido dos cards a que a triagem o relacionou", () => {
  const board: Card[] = [
    coerceCard("step-1", { type: "step", title: "Passo", parent: "act-1" }, ""),
    coerceCard("story-user", { type: "story", storyType: "user", title: "User", parent: "step-1" }, ""),
    coerceCard("story-chore", { type: "story", storyType: "chore", title: "Chore", serves: "story-user" }, ""),
    coerceCard("story-bug-parent", { type: "story", storyType: "bug", title: "Bug", parent: "story-user" }, ""),
    coerceCard("story-orphan", { type: "story", storyType: "technical", title: "Órfã" }, ""),
    coerceCard("story-bad-serves", { type: "story", storyType: "chore", title: "X", serves: "step-1" }, ""),
    coerceCard("idea-1", { type: "idea", title: "Ideia" }, ""),
  ];

  it("entrega relacionada a uma entrega que SERVE uma user story ⇒ serve a mesma (o caso do incidente)", () => {
    expect(inferTriagePlacement("technical", ["story-chore"], board)).toEqual({ serves: "story-user" });
  });

  it("entrega relacionada a uma user story ⇒ serve ela; a uma entrega pendurada por parent ⇒ serve o parent", () => {
    expect(inferTriagePlacement("bug", ["story-user"], board)).toEqual({ serves: "story-user" });
    expect(inferTriagePlacement("chore", ["story-bug-parent"], board)).toEqual({ serves: "story-user" });
  });

  it("o primeiro relacionado que dá lugar vence; os que não dão são pulados", () => {
    expect(inferTriagePlacement("spike", ["story-orphan", "idea-1", "story-bad-serves", "story-chore"], board)).toEqual({
      serves: "story-user",
    });
  });

  it("user story relacionada a outra user story (ou ao passo) ⇒ fica sob o MESMO passo", () => {
    expect(inferTriagePlacement("user", ["story-user"], board)).toEqual({ parent: "step-1" });
    expect(inferTriagePlacement("user", ["step-1"], board)).toEqual({ parent: "step-1" });
    expect(inferTriagePlacement("user", ["story-chore"], board)).toEqual({ parent: "step-1" }); // via a story servida
  });

  it("nada relacionado dá lugar ⇒ {} (nunca inventa — o card fica na Triagem e o Inbox pede o lugar)", () => {
    expect(inferTriagePlacement("technical", [], board)).toEqual({});
    expect(inferTriagePlacement("technical", ["story-orphan", "idea-1", "step-1", "nao-existe"], board)).toEqual({});
  });
});

describe("triagePlacementGap — o card da Triagem tem lugar para ser ACEITO?", () => {
  const cfg = {
    ...config,
    statuses: [
      { id: "triage", name: "Triagem", staging: true },
      { id: "refinar", name: "Refinar" },
      { id: "enriquecer", name: "Enriquecer" },
      { id: "interview", name: "Entrevista" },
      { id: "corrigir", name: "Corrigir" },
    ],
  } as BoardConfig;

  it("na quarentena a invariante dorme — mas o aceite a acorda: a lacuna aparece ANTES do clique", () => {
    const orphan = coerceCard("s", { type: "story", storyType: "technical", status: "triage", mode: "refine" }, "");
    expect(triagePlacementGap(orphan, cfg)).toMatch(/não tem lugar na hierarquia/);
  });

  it("com o lugar declarado ⇒ nenhuma lacuna", () => {
    expect(triagePlacementGap(coerceCard("s", { type: "story", storyType: "technical", status: "triage", serves: "story-user" }, ""), cfg)).toBeNull();
    expect(triagePlacementGap(coerceCard("s", { type: "story", storyType: "user", status: "triage", parent: "step-1" }, ""), cfg)).toBeNull();
  });
});

describe("refineAppliesTo — «refinar» só reabre story de usuário", () => {
  it("user (ou sem tipo) ⇒ refinar; entrega técnica, chore, spike, bug ⇒ fluxo normal", () => {
    expect(refineAppliesTo("user")).toBe(true);
    expect(refineAppliesTo(undefined)).toBe(true);
    expect(refineAppliesTo(null)).toBe(true);
    for (const t of ["technical", "chore", "spike", "bug"]) expect(refineAppliesTo(t)).toBe(false);
  });
});
