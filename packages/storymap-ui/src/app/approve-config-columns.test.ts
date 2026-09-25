import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";

// conductor-core — approve_qa / approve_review resolvem as colunas-alvo pelo PIPELINE DO BOARD (o passo que roda
// harness-qa, o passo com gate hasQaPassed, o passo que roda harness-review), não pelos ids fixos
// `qa-automatizado`/`revisao`/`revisar-codigo`. Um board que renomeou as colunas era recusado no PRÓPRIO QA — e o
// condutor, que projeta o card no Kanban, não tinha como carimbar a evidência nele.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let cardOnDisk: Card;
let config: BoardConfig;

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readCard: async () => cardOnDisk,
    readCards: async () => [cardOnDisk],
    readBoardConfig: async () => config,
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(cardOnDisk);
      if (next) cardOnDisk = next;
      return next;
    },
    writeCard: async () => {},
  };
});

import { approveQaAction, approveReviewAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";
import { qaApprovalStatuses, reviewApprovalStatuses } from "@/lib/storymap/pipeline-routing";

const board = (statuses: StatusDef[]): BoardConfig => ({ id: "b", name: "B", statuses, releases: [], personas: [], systems: [], linkTypes: [] });

/** A board whose pipeline uses its OWN ids — none of the historical ones. */
const renamed = board([
  { id: "code-check", name: "Revisão", trigger: "harness-review", autorun: false },
  { id: "acceptance", name: "Aceite", trigger: "harness-qa", autorun: false },
  { id: "sign-off", name: "Aprovar", gate: "hasQaPassed" },
  // a column that merely reuses the OLD id but is not QA here — it must NOT be accepted any more
  { id: "qa-automatizado", name: "Outra coisa" },
]);

const at = (status: string) => coerceCard("story-x", { type: "story", storyType: "user", status }, "");

beforeEach(() => {
  config = renamed;
});
afterEach(() => vi.clearAllMocks());

describe("qaApprovalStatuses / reviewApprovalStatuses (puros)", () => {
  it("num board renomeado, derivam dos facets (trigger/gate), em ordem de pipeline", () => {
    expect(qaApprovalStatuses(renamed)).toEqual(["acceptance", "sign-off"]);
    expect(reviewApprovalStatuses(renamed)).toEqual(["code-check", "acceptance", "sign-off"]);
  });

  it("sem nenhum facet (ou config ilegível), caem nos ids históricos", () => {
    expect(qaApprovalStatuses(board([{ id: "x", name: "X" }]))).toEqual(["qa-automatizado", "revisao"]);
    expect(qaApprovalStatuses(null)).toEqual(["qa-automatizado", "revisao"]);
    expect(reviewApprovalStatuses(null)).toEqual(["revisar-codigo", "qa-automatizado", "revisao"]);
  });

  it("o pipeline CANÔNICO resolve exatamente os ids históricos (comportamento preservado)", async () => {
    const { readBaseTemplateConfig } = await vi.importActual<typeof import("@/lib/storymap/repo")>("@/lib/storymap/repo");
    const base = await readBaseTemplateConfig();
    expect(qaApprovalStatuses(base)).toEqual(["qa-automatizado", "revisao"]);
    expect(reviewApprovalStatuses(base)).toEqual(["revisar-codigo", "qa-automatizado", "revisao"]);
  });
});

describe("approveQaAction / approveReviewAction leem as colunas do board", () => {
  it("aprova QA na coluna de QA RENOMEADA", async () => {
    cardOnDisk = at("acceptance");
    const res = await approveQaAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.qaPassed).toBe(true);
  });

  it("RECUSA num card parado numa coluna que só reusa o id antigo — e não escreve", async () => {
    cardOnDisk = at("qa-automatizado");
    const res = await approveQaAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error).toContain("acceptance");
    expect(cardOnDisk.qaPassed).toBeFalsy();
  });

  it("aprova a revisão na coluna de review renomeada", async () => {
    cardOnDisk = at("code-check");
    const res = await approveReviewAction({ boardId: "b", cardId: "story-x", reviewCommit: "abc" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.reviewCommit).toBe("abc");
  });
});
