import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";

// lanes-ultra — the server actions of the AUTONOMY KEY, through the service's single writer (updateCardOnDisk):
//   • setCardAutonomyAction sets/clears the per-story exception (idempotent), and offers open questions to the proxy;
//   • resolveProxyAuditAction closes ONLY a pending proxy audit (confirm keeps; reopen hands the question back);
//   • askQuestionsAction rings the proxy's doorbell for a CATEGORIZED question — never for a plain one.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let cardOnDisk: Card;
const nudgeProxy = vi.fn(async () => ({}));

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readCard: async () => cardOnDisk,
    readCards: async () => [cardOnDisk],
    readBoardConfig: async () => ({ id: "b", name: "B", statuses: [{ id: "grill", name: "Dúvidas" }], releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "human" } }),
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
  };
});

vi.mock("@/lib/storymap/runner/proxy-deps", () => ({ nudgeProxy: (...a: unknown[]) => nudgeProxy(...(a as [])) }));

import { askQuestionsAction, resolveProxyAuditAction, setCardAutonomyAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";

const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  nudgeProxy.mockClear();
  cardOnDisk = coerceCard("story-x", { type: "story", status: "grill", title: "X" }, "");
});

describe("setCardAutonomyAction — a exceção por story", () => {
  it("põe ultra (a efetiva vira ultra/card), é idempotente, e limpa com null (volta ao board)", async () => {
    const r = await setCardAutonomyAction({ boardId: "b", cardId: "story-x", mode: "ultra" });
    expect(r.ok && r.data).toMatchObject({ changed: true, effective: { mode: "ultra", source: "card" } });
    expect(cardOnDisk.autonomyMode).toBe("ultra");
    await flush();
    expect(nudgeProxy).toHaveBeenCalledWith("b", "story-x");

    const again = await setCardAutonomyAction({ boardId: "b", cardId: "story-x", mode: "ultra" });
    expect(again.ok && again.data?.changed).toBe(false);

    const cleared = await setCardAutonomyAction({ boardId: "b", cardId: "story-x", mode: null });
    expect(cleared.ok && cleared.data).toMatchObject({ changed: true, effective: { mode: "human", source: "board" } });
    expect("autonomyMode" in cardOnDisk).toBe(false);
  });

  it("modo desconhecido é recusado sem escrever", async () => {
    const r = await setCardAutonomyAction({ boardId: "b", cardId: "story-x", mode: "turbo" as never });
    expect(r.ok).toBe(false);
    expect(cardOnDisk.autonomyMode).toBeUndefined();
  });
});

describe("resolveProxyAuditAction — só uma auditoria de proxy PENDENTE fecha", () => {
  const withAudit = () =>
    coerceCard(
      "story-x",
      {
        type: "story",
        status: "grill",
        questions: [
          { id: "q1", text: "Público?", status: "answered", answer: "Leitoras", answeredBy: "proxy", category: "interview", proxy: { assumptions: "PRD", confidence: 0.8, audit: true } },
          { id: "q2", text: "Outra?", status: "answered", answer: "do dono" },
        ],
      },
      "",
    );

  it("reopened devolve a pergunta ao dono; confirmar a mesma depois é recusado (já fechada)", async () => {
    cardOnDisk = withAudit();
    const r = await resolveProxyAuditAction({ boardId: "b", cardId: "story-x", questionId: "q1", outcome: "reopened" });
    expect(r.ok).toBe(true);
    expect(cardOnDisk.questions![0]).toMatchObject({ status: "open", proxy: { auditOutcome: "reopened" } });
    const again = await resolveProxyAuditAction({ boardId: "b", cardId: "story-x", questionId: "q1", outcome: "confirmed" });
    expect(again.ok).toBe(false);
  });

  it("uma resposta do DONO não é auditoria de proxy ⇒ recusa", async () => {
    cardOnDisk = withAudit();
    const r = await resolveProxyAuditAction({ boardId: "b", cardId: "story-x", questionId: "q2", outcome: "confirmed" });
    expect(r.ok).toBe(false);
    expect(cardOnDisk.questions![1].answer).toBe("do dono");
  });
});

describe("askQuestionsAction — a campainha do proxy", () => {
  it("pergunta estruturada COM categoria ⇒ nudge; a categoria é gravada na pergunta", async () => {
    const r = await askQuestionsAction({ boardId: "b", cardId: "story-x", questions: [{ text: "Quem é o público?", category: "interview" }] });
    expect(r.ok).toBe(true);
    expect(cardOnDisk.questions?.[0]).toMatchObject({ text: "Quem é o público?", category: "interview", status: "open" });
    await flush();
    expect(nudgeProxy).toHaveBeenCalledWith("b", "story-x");
  });

  it("pergunta sem categoria (texto livre ou estruturada) ⇒ nenhum nudge", async () => {
    await askQuestionsAction({ boardId: "b", cardId: "story-x", texts: ["livre?"], questions: [{ text: "sem categoria?" }] });
    await flush();
    expect(nudgeProxy).not.toHaveBeenCalled();
  });
});
