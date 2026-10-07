import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";

// Fase 4.2 — setCardRouteAction MATERIALIZES a named routeProfile onto the card. The [confirmar] was
// DEFINITIVE: the runner reads routing.skips/modelCap/effortCap DIRECTLY, so a route stamped with only
// `profile` is inert. This action test pins the materialization: profile → skips/caps copied, input caps win,
// input skips union, a load-bearing profile skip is rejected after the merge.

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const opcional: StatusDef = { id: "opcional", name: "Opcional", dispensable: true };
const designUx: StatusDef = { id: "design-ux", name: "Design UX", dispensable: true };
const desenvolver: StatusDef = { id: "desenvolver", name: "Desenvolver" }; // load-bearing (prefix)
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [opcional, designUx, desenvolver],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  routeProfiles: {
    express: { skips: ["opcional", "design-ux"], modelCap: "sonnet", effortCap: "low", description: "trivial" },
    bad: { skips: ["desenvolver"] }, // a profile that names a load-bearing step (must be rejected on merge)
  },
};

let cardOnDisk: Card;

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readBoardConfig: async () => board,
    readCards: async () => [cardOnDisk],
    readCard: async () => cardOnDisk,
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

import { setCardRouteAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";

describe("setCardRouteAction — profile materialization (4.2)", () => {
  beforeEach(() => {
    cardOnDisk = coerceCard("story-x", { type: "story", status: "plano-tecnico", priorityCall: { rank: 2, source: "human", assessedAt: "2026-07-10" } }, "");
  });

  it("materializes profile → skips + caps when only `profile` is given (not inert)", async () => {
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", profile: "express" });
    expect(res.ok).toBe(true);
    const r = res.ok ? res.data?.card.routing ?? null : null;
    expect(r?.skips.sort()).toEqual(["design-ux", "opcional"]);
    expect(r?.modelCap).toBe("sonnet");
    expect(r?.effortCap).toBe("low");
    expect(r?.profile).toBe("express");
    expect(r?.decidedBy).toBe("human");
  });

  it("explicit input caps OVERRIDE the profile caps", async () => {
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", profile: "express", modelCap: "opus", effortCap: "high" });
    const r = res.ok ? res.data?.card.routing ?? null : null;
    expect(r?.modelCap).toBe("opus");
    expect(r?.effortCap).toBe("high");
  });

  it("unions explicit skips with a real profile (both present, deduped)", async () => {
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", profile: "express", skips: ["opcional"] });
    const r = res.ok ? res.data?.card.routing ?? null : null;
    expect(r?.skips.sort()).toEqual(["design-ux", "opcional"]); // opcional not duplicated
  });

  it("REJECTS a profile whose materialized skips include a load-bearing step", async () => {
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", profile: "bad" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/load-bearing/);
  });

  it("unknown profile → error", async () => {
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", profile: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/desconhecido/);
  });

  it("empty route (no skips/profile/caps) CLEARS the routing", async () => {
    cardOnDisk = { ...cardOnDisk, routing: { skips: ["opcional"], decidedBy: "human", decidedAt: "2026-07-10" } };
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x" });
    expect(res.ok && res.data?.card.routing).toBeNull();
  });

  it("a priorização saiu: pular um passo dispensável não gera aviso de prioridade (sem `note`)", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", status: "plano-tecnico" }, "");
    const res = await setCardRouteAction({ boardId: "b", cardId: "story-x", profile: "express" });
    expect(res.ok).toBe(true);
    expect(res.ok && res.data && "note" in res.data).toBe(false);
  });
});
