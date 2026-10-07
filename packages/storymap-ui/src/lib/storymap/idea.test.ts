// Unit tests for story-ex0079: idea schema + bet block + owner.
// Covers: guards (T1), coerceCard round-trips (T4), edge helpers (T5).

import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import {
  isIdeaStatus,
  isExperimentStatus,
  isOwner,
  IDEA_STATUS_IDS,
  EXPERIMENT_STATUS_IDS,
  OWNER_IDS,
} from "./frameworks";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";
import { parseCard } from "./contracts";
import {
  isAddressesLink,
  resolvesToIdea,
  getAddressedIdea,
  cardsAddressing,
  ideaAsTriageCard,
  ADDRESSES_REL,
} from "./idea";
import type { Card } from "./types";

// ── T1: guards ────────────────────────────────────────────────────────────────

describe("isIdeaStatus", () => {
  it("accepts every valid id", () => {
    for (const id of IDEA_STATUS_IDS) {
      expect(isIdeaStatus(id)).toBe(true);
    }
  });
  it("rejects unknown values", () => {
    expect(isIdeaStatus("todo")).toBe(false);
    expect(isIdeaStatus(null)).toBe(false);
    expect(isIdeaStatus(undefined)).toBe(false);
    expect(isIdeaStatus(42)).toBe(false);
  });
});

describe("isExperimentStatus", () => {
  it("accepts every valid id", () => {
    for (const id of EXPERIMENT_STATUS_IDS) {
      expect(isExperimentStatus(id)).toBe(true);
    }
  });
  it("rejects unknown values", () => {
    expect(isExperimentStatus("proven")).toBe(false);
    expect(isExperimentStatus(null)).toBe(false);
  });
});

describe("isOwner", () => {
  it("accepts every valid owner class", () => {
    for (const id of OWNER_IDS) {
      expect(isOwner(id)).toBe(true);
    }
  });
  it("rejects unknown values", () => {
    expect(isOwner("system")).toBe(false);
    expect(isOwner(null)).toBe(false);
    expect(isOwner(undefined)).toBe(false);
  });
  it("derives values from ownership.js OWNER constant (no duplication)", () => {
    // The canonical values from ownership.js
    expect(OWNER_IDS).toContain("human");
    expect(OWNER_IDS).toContain("proposable");
    expect(OWNER_IDS).toContain("agent");
    expect(OWNER_IDS).toHaveLength(3);
  });
});

// ── T4: coerceCard — idea + bet + owner round-trips ───────────────────

describe("coerceCard — idea block (AC1)", () => {
  it("coerces a valid idea block", () => {
    const card = coerceCard("idea-1", {
      type: "idea",
      title: "Usuário não sabe que recurso existe",
      // personas live on Card.personas (single source of truth), not the idea block
      personas: ["explorador"],
      idea: {
        statement: "Difícil descobrir novos recursos sem ajuda",
        evidence: "10 entrevistas / 8 mencionaram",
        status: "exploring",
      },
    }, "");
    expect(card.type).toBe("idea");
    expect(card.personas).toEqual(["explorador"]);
    expect(card.idea).toMatchObject({
      statement: "Difícil descobrir novos recursos sem ajuda",
      evidence: "10 entrevistas / 8 mencionaram",
      status: "exploring",
    });
    expect(card.idea).not.toHaveProperty("personas");
  });

  it("defaults status to 'open' when missing", () => {
    const card = coerceCard("idea-2", {
      type: "idea",
      idea: { statement: "Dor genérica" },
    }, "");
    expect(card.idea?.status).toBe("open");
  });

  it("coerces to null when statement is absent", () => {
    const card = coerceCard("idea-3", {
      type: "idea",
      idea: { evidence: "e" },
    }, "");
    expect(card.idea).toBeNull();
  });

  it("coerces to null when idea is absent", () => {
    const card = coerceCard("story-1", { type: "story" }, "");
    expect(card.idea).toBeNull();
  });

  it("satisfies CardSchema after coercion", () => {
    const card = coerceCard("idea-4", {
      type: "idea",
      idea: { statement: "Dor", status: "open" },
    }, "");
    const result = parseCard(card);
    expect(result.ok).toBe(true);
  });
});

describe("coerceCard — bet block (AC2)", () => {
  it("coerces a valid bet block", () => {
    const card = coerceCard("story-bet", {
      type: "story",
      bet: {
        assumptions: ["Usuário quer notificações push", "Push aumenta engajamento 20%"],
        riskiestAssumption: "Push aumenta engajamento 20%",
        experimentStatus: "testing",
      },
    }, "");
    expect(card.bet).toMatchObject({
      assumptions: ["Usuário quer notificações push", "Push aumenta engajamento 20%"],
      riskiestAssumption: "Push aumenta engajamento 20%",
      experimentStatus: "testing",
    });
  });

  it("defaults experimentStatus to 'untested' when missing", () => {
    const card = coerceCard("story-bet2", {
      bet: { assumptions: ["Hipótese A"] },
    }, "");
    expect(card.bet?.experimentStatus).toBe("untested");
  });

  it("coerces to null when assumptions is empty", () => {
    const card = coerceCard("story-bet3", {
      bet: { assumptions: [], riskiestAssumption: "algo" },
    }, "");
    expect(card.bet).toBeNull();
  });

  it("satisfies CardSchema after coercion", () => {
    const card = coerceCard("story-bet4", {
      bet: { assumptions: ["Hipótese"], experimentStatus: "validated" },
    }, "");
    const result = parseCard(card);
    expect(result.ok).toBe(true);
  });
});

describe("coerceCard — owner field (AC3)", () => {
  it("coerces a valid owner value", () => {
    const card = coerceCard("idea-owner", {
      type: "idea",
      idea: { statement: "Dor" },
      owner: "proposable",
    }, "");
    expect(card.owner).toBe("proposable");
  });

  it("coerces undefined for unknown owner values", () => {
    const card = coerceCard("story-owner2", { owner: "system" }, "");
    expect(card.owner).toBeUndefined();
  });

  it("coerces undefined when owner is absent", () => {
    const card = coerceCard("story-no-owner", {}, "");
    expect(card.owner).toBeUndefined();
  });

  it("satisfies CardSchema with owner:proposable", () => {
    const card = coerceCard("idea-contract", {
      type: "idea",
      idea: { statement: "Dor" },
      owner: "proposable",
    }, "");
    const result = parseCard(card);
    expect(result.ok).toBe(true);
  });
});

// ── T5: edge helpers (AC4) ────────────────────────────────────────────────────

describe("isAddressesLink / resolvesToIdea (AC4)", () => {
  it("recognizes an addresses link", () => {
    expect(isAddressesLink({ rel: ADDRESSES_REL, to: "idea-abc" })).toBe(true);
  });

  it("rejects other rel types", () => {
    expect(isAddressesLink({ rel: "moves", to: "metric-1" })).toBe(false);
    expect(isAddressesLink({ rel: "blocks", to: "story-x" })).toBe(false);
  });

  it("resolvesToIdea returns true when at least one addresses edge exists", () => {
    expect(
      resolvesToIdea([
        { rel: "moves", to: "metric-1" },
        { rel: "addresses", to: "idea-abc" },
      ]),
    ).toBe(true);
  });

  it("resolvesToIdea returns false with no addresses edges", () => {
    expect(resolvesToIdea([{ rel: "moves", to: "metric-1" }])).toBe(false);
    expect(resolvesToIdea([])).toBe(false);
  });
});

describe("getAddressedIdea (Fatia 4 — hydrates the run context)", () => {
  const idea = coerceCard("idea-abc", { type: "idea", title: "Dor X", idea: { statement: "Dor X" } }, "");
  const story = coerceCard("story-1", { type: "story", title: "Fecha a dor", links: [{ rel: "addresses", to: "idea-abc" }] }, "");

  it("resolves the idea a story addresses, against the pool", () => {
    expect(getAddressedIdea(story, [story, idea])?.id).toBe("idea-abc");
  });

  it("returns null when the story addresses nothing", () => {
    const plain = coerceCard("story-2", { type: "story", title: "Sem dor" }, "");
    expect(getAddressedIdea(plain, [plain, idea])).toBeNull();
  });

  it("returns null when the addressed target is missing from the pool", () => {
    expect(getAddressedIdea(story, [story])).toBeNull();
  });

  it("returns null when the addressed target is not an idea", () => {
    const notIdea = coerceCard("idea-abc", { type: "story", title: "não é ideia" }, "");
    expect(getAddressedIdea(story, [story, notIdea])).toBeNull();
  });
});

// ── Fatia 2: OST-light fields + rollup ─────────────────────────────────────────

describe("coerceCard — idea OST-light fields (Fatia 2)", () => {
  it("preserves candidateSolutions, keyAssumption, successSignal (sparse round-trip)", () => {
    const card = coerceCard("idea-ost", {
      type: "idea",
      idea: {
        statement: "Operador não dirige o sistema top-down",
        candidateSolutions: ["editor de contexto", "validação de premissa"],
        keyAssumption: "o operador QUER editar o cérebro, não só os cards",
        successSignal: "edições de contexto por semana sobe",
      },
    }, "");
    expect(card.idea).toMatchObject({
      candidateSolutions: ["editor de contexto", "validação de premissa"],
      keyAssumption: "o operador QUER editar o cérebro, não só os cards",
      successSignal: "edições de contexto por semana sobe",
    });
    expect(parseCard(card).ok).toBe(true);
  });

  it("drops empty OST-light fields (sparse — keeps the card lean)", () => {
    const card = coerceCard("idea-empty", {
      type: "idea",
      idea: { statement: "Dor", candidateSolutions: [], keyAssumption: "  ", valueSize: { reach: null, impact: null } },
    }, "");
    expect(card.idea).not.toHaveProperty("candidateSolutions");
    expect(card.idea).not.toHaveProperty("keyAssumption");
    expect(card.idea).not.toHaveProperty("successSignal");
    expect(card.idea).not.toHaveProperty("valueSize");
  });

  it("a nota de valor antiga (valueSize) de uma ideia legada é ignorada na leitura — a priorização saiu", () => {
    const card = coerceCard("idea-ex9352", {
      type: "idea",
      idea: { statement: "Dor", valueSize: { reach: 50, impact: 2 }, priorityCall: { rank: 2, rationale: "r" } },
    }, "");
    expect(card.idea).not.toHaveProperty("valueSize");
    expect(card.idea).not.toHaveProperty("priorityCall");
    expect(card.idea?.statement).toBe("Dor");
  });
});

describe("cardsAddressing (Fatia 2 rollup)", () => {
  const idea = coerceCard("idea-r", { type: "idea", title: "Dor", idea: { statement: "Dor" } }, "");
  const s1 = coerceCard("story-a", { type: "story", title: "A", links: [{ rel: "addresses", to: "idea-r" }] }, "");
  const s2 = coerceCard("story-b", { type: "story", title: "B", links: [{ rel: "addresses", to: "idea-r" }] }, "");
  const other = coerceCard("story-c", { type: "story", title: "C", links: [{ rel: "addresses", to: "idea-x" }] }, "");

  it("returns every story that addresses the idea", () => {
    expect(cardsAddressing(idea, [idea, s1, s2, other]).map((c) => c.id)).toEqual(["story-a", "story-b"]);
  });

  it("returns [] when nothing addresses it", () => {
    expect(cardsAddressing(idea, [idea, other])).toEqual([]);
  });
});

describe("idea block survives the REAL write→read round-trip (write.ts + gray-matter)", () => {
  it("persists statement/evidence/status + all OST-light fields (Fatia 2 — the write path was a no-op before)", () => {
    const c0 = coerceCard("idea-rt", {
      type: "idea",
      title: "Dor X",
      idea: {
        statement: "Dor X",
        evidence: "10 entrevistas",
        status: "exploring",
        candidateSolutions: ["sol A", "sol B"],
        keyAssumption: "premissa arriscada",
        successSignal: "métrica sobe",
      },
    }, "");
    // The exact path writeCard/readCards use: cardToFrontmatter → matter.stringify → matter → coerceCard.
    const file = matter.stringify("\nbody\n", cardToFrontmatter(c0));
    const { data, content } = matter(file);
    const back = coerceCard("idea-rt", data as Record<string, unknown>, content);
    expect(back.idea).toMatchObject({
      statement: "Dor X",
      evidence: "10 entrevistas",
      status: "exploring",
      candidateSolutions: ["sol A", "sol B"],
      keyAssumption: "premissa arriscada",
      successSignal: "métrica sobe",
    });
  });
});

describe("ideaAsTriageCard — o create_idea vira card da Triagem", () => {
  it("sem título nem enunciado não há card", () => {
    expect(ideaAsTriageCard({})).toBeNull();
    expect(ideaAsTriageCard({ title: "  ", statement: " " })).toBeNull();
  });

  it("o enunciado vira o título quando falta o título, e não se repete no texto", () => {
    expect(ideaAsTriageCard({ statement: "Exportar a lista em planilha" })).toEqual({
      title: "Exportar a lista em planilha",
      body: "",
    });
  });

  it("os campos de exploração viram seções curtas, na ordem, sem os vazios", () => {
    const r = ideaAsTriageCard({
      title: "Planilha da lista",
      statement: "Quem organiza quer levar a lista para fora",
      evidence: "três pedidos no suporte",
      candidateSolutions: [" CSV ", "", "link compartilhado"],
      keyAssumption: "  ",
      successSignal: "metade de quem monta listas exporta no primeiro mês",
    });
    expect(r?.title).toBe("Planilha da lista");
    expect(r?.body).toBe(
      [
        "Quem organiza quer levar a lista para fora",
        "**O que sustenta:** três pedidos no suporte",
        "**Caminhos possíveis:**\n- CSV\n- link compartilhado",
        "**Como saber que deu certo:** metade de quem monta listas exporta no primeiro mês",
      ].join("\n\n"),
    );
  });
});
