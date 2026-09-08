import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import {
  cardCockpitItems,
  designItemsFromWireframes,
  governanceItemsFromDrafts,
  proposalItemsFromContainers,
} from "./demands";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";
import type { BoardConfig, GovernanceDraft, WireframeDoc } from "./types";
import type { ProposalDoc } from "./smart-capture/types";

// Board with the capture steps + the "approve design" stop, so the sidecar-fed folding (proposal/design)
// and the rich-question projection can be exercised purely (no IO — the docs are passed in).
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "grill", name: "Dúvidas", trigger: "harness-grill", autorun: true },
    { id: "capturando", name: "Capturando", trigger: "harness-capture", autorun: true, hidden: true },
    { id: "com-design", name: "Aprovar design", gate: "hasWireframe", autorun: false },
    { id: "capturado", name: "Capturado", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const proposalDoc = (containerId: string, items = 1, feedback: string[] = []): ProposalDoc => ({
  containerId,
  summary: "separei a UI do enabler técnico",
  items: Array.from({ length: items }, (_, i) => ({
    tempId: `i${i + 1}`,
    type: "story" as const,
    title: `Item ${i + 1}`,
    rationale: "cobre uma capacidade",
  })),
  feedback,
  generatedBy: "harness-capture",
  updated: "2026-06-14",
});

describe("proposalItemsFromContainers — capture proposals folded from the sidecar", () => {
  it("emits ONE proposal item for a capture container PARKED in `capturando` WITH a proposal doc, parented to the container", () => {
    const container = coerceCard("cap-1", { type: "story", capture: true, status: "capturando", title: "captura" }, "fonte");
    const items = proposalItemsFromContainers([container], new Map([["cap-1", proposalDoc("cap-1", 3, ["mais granular"])]]), board, "b");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "proposal", cardId: "cap-1", lane: "aprovar", rounds: 1 });
    expect(items[0].items).toHaveLength(3); // the proposed cards
    expect(items[0].summary).toContain("enabler");
  });

  it("emits a GENERATING item (no doc yet) while the container is in `capturando`", () => {
    const container = coerceCard("cap-2", { type: "story", capture: true, status: "capturando", title: "x" }, "fonte");
    const items = proposalItemsFromContainers([container], new Map(), board, "b");
    expect(items).toHaveLength(1);
    expect(items[0].items).toEqual([]); // nothing proposed yet → renderer shows "gerando…"
    expect(items[0].summary).toBe("");
  });

  it("skips non-capture cards and terminal (consumed) containers", () => {
    const normal = coerceCard("story-1", { type: "story", status: "triage", title: "x" }, "");
    const consumed = coerceCard("cap-3", { type: "story", capture: true, status: "capturado", title: "x" }, "");
    const items = proposalItemsFromContainers(
      [normal, consumed],
      new Map([["cap-3", proposalDoc("cap-3")]]),
      board,
      "b",
    );
    expect(items).toEqual([]);
  });
});

const wireframeDoc = (cardId: string, chosen: string | null = null): WireframeDoc => ({
  cardId,
  status: chosen ? "chosen" : "draft",
  chosenOptionId: chosen,
  generatedBy: "harness-ux",
  updated: "2026-06-14",
  journey: null,
  options: [
    { id: "o1", label: "A — on-brand", direction: "on-brand", rationale: "coração no card", format: "ascii", viewport: "mobile", state: "populated", heightHint: null, content: "┌──┐\n│♥ │\n└──┘" },
    { id: "o2", label: "B — fresh", direction: "fresh-slate", rationale: "bottom-sheet", format: "ascii", viewport: "mobile", state: "populated", heightHint: null, content: "[mural]" },
  ],
  artifacts: [],
  feedback: [],
});

describe("designItemsFromWireframes — design approvals folded from the wireframe sidecar", () => {
  it("emits a design item ONLY at the approve-design stop (gate hasWireframe), carrying the options", () => {
    const card = coerceCard("st-1", { type: "story", status: "com-design", title: "favoritos" }, "");
    const items = designItemsFromWireframes([card], new Map([["st-1", wireframeDoc("st-1", "o1")]]), board, "b");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "design", cardId: "st-1", lane: "aprovar", chosenId: "o1" });
    expect(items[0].options.map((o) => o.id)).toEqual(["o1", "o2"]);
  });

  it("skips cards NOT at the approve-design stop, and stops with no wireframe options", () => {
    const elsewhere = coerceCard("st-2", { type: "story", status: "grill", title: "x" }, "");
    const empty = coerceCard("st-3", { type: "story", status: "com-design", title: "x" }, "");
    const emptyDoc: WireframeDoc = { ...wireframeDoc("st-3"), options: [] };
    const items = designItemsFromWireframes(
      [elsewhere, empty],
      new Map([["st-3", emptyDoc]]),
      board,
      "b",
    );
    expect(items).toEqual([]);
  });
});

describe("rich questions round-trip + project onto the cockpit item", () => {
  const richQuestion = {
    id: "q1",
    text: "O mural de favoritos é público ou privado?",
    status: "open",
    askedBy: "harness-grill",
    askedAt: "2026-06-14",
    context: "muda o modelo de dados e as regras de segurança",
    mode: "single",
    options: [
      { id: "o1", label: "Privado", pros: ["simples"], cons: ["sem efeito social"], recommended: true },
      { id: "o2", label: "Público", pros: ["viral"] },
    ],
  };

  it("coerceCard preserves option pros/cons/recommended + the question context", () => {
    const c = coerceCard("story-q", { type: "story", status: "grill", title: "t", questions: [richQuestion] }, "");
    const q = c.questions![0];
    expect(q.context).toBe("muda o modelo de dados e as regras de segurança");
    expect(q.options![0]).toMatchObject({ label: "Privado", pros: ["simples"], cons: ["sem efeito social"], recommended: true });
    expect(q.options![1].recommended).toBeUndefined();
  });

  it("cardCockpitItems carries the rich fields onto the question item (for the renderer)", () => {
    const c = coerceCard("story-q", { type: "story", status: "grill", title: "t", questions: [richQuestion] }, "");
    const items = cardCockpitItems(c, board, "b");
    const item = items.find((i) => i.kind === "question");
    expect(item).toBeDefined();
    expect(item).toMatchObject({ cardId: "story-q", context: "muda o modelo de dados e as regras de segurança" });
    // the parent invariant: every cockpit item carries its card id
    expect(item!.cardId).toBe("story-q");
  });
});

// ── governance draft helpers ──────────────────────────────────────────────────
const makeDraft = (id: string, overrides: Partial<GovernanceDraft> = {}): GovernanceDraft => ({
  id,
  board: "b",
  status: "pending",
  reason: "desiredOutcome atualizado pela análise de mercado Q2",
  origin: { skill: "harness-plan", cardId: "story-abc" },
  changes: [
    {
      artifact: "desiredOutcome",
      field: null,
      before: "Facilitar conexões urbanas",
      after: "Ser a camada social da mosaico",
      label: "desiredOutcome",
    },
  ],
  createdAt: "2026-06-15",
  decidedAt: null,
  ...overrides,
});

describe("governanceItemsFromDrafts — governance drafts folded into the cockpit inbox (AC4/AC5/AC6)", () => {
  it("AC4: emits one item per PENDING draft, visible via the cockpit (lane=aprovar)", () => {
    const drafts = [makeDraft("d1"), makeDraft("d2")];
    const items = governanceItemsFromDrafts(drafts, new Map(), "b");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "governance", lane: "aprovar", draftId: "d1", boardId: "b" });
    expect(items[1]).toMatchObject({ kind: "governance", lane: "aprovar", draftId: "d2" });
  });

  it("AC4: skips APPROVED and REJECTED drafts — only pending show up", () => {
    const drafts = [
      makeDraft("d-pending", { status: "pending" }),
      makeDraft("d-approved", { status: "approved" }),
      makeDraft("d-rejected", { status: "rejected" }),
    ];
    const items = governanceItemsFromDrafts(drafts, new Map(), "b");
    expect(items).toHaveLength(1);
    expect(items[0].draftId).toBe("d-pending");
  });

  it("AC5: carries before/after/reason visible side-by-side (changes + reason)", () => {
    const draft = makeDraft("d3");
    const items = governanceItemsFromDrafts([draft], new Map(), "b");
    expect(items[0].reason).toBe("desiredOutcome atualizado pela análise de mercado Q2");
    expect(items[0].changes).toHaveLength(1);
    expect(items[0].changes[0]).toMatchObject({ artifact: "desiredOutcome", before: "Facilitar conexões urbanas", after: "Ser a camada social da mosaico" });
  });

  it("AC5: conflict detection — severity=high and conflicts list populated when before != canonical", () => {
    const draft = makeDraft("d4");
    // canonical diverged from `before`
    const conflictsByDraftId = new Map([["d4", ["desiredOutcome"]]]);
    const items = governanceItemsFromDrafts([draft], conflictsByDraftId, "b");
    expect(items[0].conflicts).toEqual(["desiredOutcome"]);
    expect(items[0].severity).toBe("high");
  });

  it("AC5: no conflicts → severity=medium", () => {
    const draft = makeDraft("d5");
    const items = governanceItemsFromDrafts([draft], new Map([["d5", []]]), "b");
    expect(items[0].conflicts).toEqual([]);
    expect(items[0].severity).toBe("medium");
  });

  it("AC6: multiple changes in ONE draft → ONE cockpit item (1 decision)", () => {
    const draft = makeDraft("d6", {
      changes: [
        { artifact: "desiredOutcome", field: null, before: "old", after: "new", label: "desiredOutcome" },
        { artifact: "canvas", field: "propositionValue", before: "x", after: "y", label: "canvas.propositionValue" },
      ],
    });
    const items = governanceItemsFromDrafts([draft], new Map(), "b");
    expect(items).toHaveLength(1);
    expect(items[0].changes).toHaveLength(2);
    expect(items[0].cardTitle).toContain("desiredOutcome");
    expect(items[0].cardTitle).toContain("canvas.propositionValue");
  });

  it("cardId falls back to empty string when origin has no cardId (no orphan item)", () => {
    const draft = makeDraft("d7", { origin: { skill: "harness-plan", cardId: null } });
    const items = governanceItemsFromDrafts([draft], new Map(), "b");
    expect(items[0].cardId).toBe("");
  });

  it("cardId is set from origin.cardId when present", () => {
    const draft = makeDraft("d8", { origin: { skill: "harness-plan", cardId: "story-abc" } });
    const items = governanceItemsFromDrafts([draft], new Map(), "b");
    expect(items[0].cardId).toBe("story-abc");
  });
});

describe("rich question survives the REAL write→read round-trip (write.ts + gray-matter)", () => {
  it("preserves option pros/cons/recommended, the question context, and a free-text recommendation", () => {
    const c0 = coerceCard(
      "story-rt",
      {
        type: "story",
        status: "grill",
        title: "t",
        questions: [
          {
            id: "q1",
            text: "público ou privado?",
            status: "open",
            context: "muda o modelo de dados",
            mode: "single",
            options: [
              { id: "o1", label: "Privado", pros: ["simples"], cons: ["sem social"], recommended: true },
              { id: "o2", label: "Público", pros: ["viral"] },
            ],
          },
          { id: "q2", text: "como medir?", status: "open", recommendation: "medir WAU sobre o mural" },
        ],
      },
      "",
    );
    // The exact path writeCard/readCards use: cardToFrontmatter → matter.stringify → matter → coerceCard.
    const file = matter.stringify("\nbody\n", cardToFrontmatter(c0));
    const { data, content } = matter(file);
    const back = coerceCard("story-rt", data as Record<string, unknown>, content);

    expect(back.questions![0].context).toBe("muda o modelo de dados");
    expect(back.questions![0].options![0]).toMatchObject({ pros: ["simples"], cons: ["sem social"], recommended: true });
    expect(back.questions![0].options![1].recommended).toBeUndefined();
    expect(back.questions![1].recommendation).toBe("medir WAU sobre o mural");
  });
});
