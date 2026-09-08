// Unit tests for story-gk8zl3: idea schema + bet block + owner.
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
  groupIdeasByStatus,
  ADDRESSES_REL,
} from "./idea";
import type { IdeaStatus } from "./frameworks";
import type { Card } from "./types";

// ── Agrupamento da bancada por estado de EXPLORAÇÃO ───────────────────────────
//
// Cada asserção aqui trava uma decisão de leitura da tela, e todas elas têm modo de falha silencioso:
// um grupo vazio que aparece, um cabeçalho sobre lista de um item, uma ideia legada sem `status` que
// desaparece do agrupamento, ou "Decidida" e "Descartada" fundidas — nada disso quebra nada, só
// piora a tela sem ninguém notar no code review.

function idea(id: string, status: IdeaStatus | undefined, updatedMs: number): Card {
  return {
    id,
    title: id,
    type: "idea",
    links: [],
    ...(status ? { idea: { statement: id, status } } : {}),
    updatedMs,
  } as unknown as Card;
}

describe("groupIdeasByStatus", () => {
  it("agrupa na ordem do ciclo de vida e omite os grupos vazios", () => {
    const groups = groupIdeasByStatus([
      idea("d", "discarded", 4),
      idea("a", "open", 3),
      idea("c", "addressed", 2),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["open", "addressed", "discarded"]);
    expect(groups.map((g) => g.label)).toEqual(["Nova", "Decidida", "Descartada"]);
  });

  it("marca como terminal SÓ o que está encerrado — e nunca funde os dois desfechos", () => {
    const groups = groupIdeasByStatus([
      idea("a", "open", 1),
      idea("b", "exploring", 2),
      idea("c", "addressed", 3),
      idea("d", "discarded", 4),
    ]);
    expect(groups.filter((g) => g.terminal).map((g) => g.key)).toEqual(["addressed", "discarded"]);
    expect(groups.filter((g) => !g.terminal).map((g) => g.key)).toEqual(["open", "exploring"]);
  });

  it("com UM grupo só, o rótulo vem null — cabeçalho sobre a lista inteira é enfeite", () => {
    const groups = groupIdeasByStatus([idea("a", "open", 1), idea("b", "open", 2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBeNull();
    expect(groups[0].items).toHaveLength(2);
  });

  it("ideia legada sem status cai em Nova — o mesmo default da leitura e do pontinho da linha", () => {
    const groups = groupIdeasByStatus([idea("velha", undefined, 1), idea("nova", "exploring", 2)]);
    expect(groups.find((g) => g.key === "open")?.items.map((i) => i.id)).toEqual(["velha"]);
  });

  it("dentro do grupo, a mais recente no topo", () => {
    const groups = groupIdeasByStatus([
      idea("antiga", "open", 100),
      idea("recente", "open", 900),
      idea("meio", "open", 500),
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["recente", "meio", "antiga"]);
  });

  it("lista vazia devolve zero grupos (nunca quatro cabeçalhos vazios)", () => {
    expect(groupIdeasByStatus([])).toEqual([]);
  });
});

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
  it("preserves candidateSolutions, keyAssumption, successSignal, valueSize (sparse round-trip)", () => {
    const card = coerceCard("idea-ost", {
      type: "idea",
      idea: {
        statement: "Operador não dirige o sistema top-down",
        candidateSolutions: ["editor de contexto", "validação de premissa"],
        keyAssumption: "o operador QUER editar o cérebro, não só os cards",
        successSignal: "edições de contexto por semana sobe",
        valueSize: { reach: 100, impact: 3 },
      },
    }, "");
    expect(card.idea).toMatchObject({
      candidateSolutions: ["editor de contexto", "validação de premissa"],
      keyAssumption: "o operador QUER editar o cérebro, não só os cards",
      successSignal: "edições de contexto por semana sobe",
      valueSize: { reach: 100, impact: 3 },
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

  it("valueSize keeps a partial axis (reach set, impact null)", () => {
    const card = coerceCard("idea-partial", {
      type: "idea",
      idea: { statement: "Dor", valueSize: { reach: 50, impact: null } },
    }, "");
    expect(card.idea?.valueSize).toEqual({ reach: 50, impact: null });
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
        valueSize: { reach: 100, impact: 3 },
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
      valueSize: { reach: 100, impact: 3 },
    });
  });
});
