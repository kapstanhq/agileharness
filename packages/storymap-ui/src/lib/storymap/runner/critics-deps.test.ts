// A régua dos críticos no `move_card` de um agente (critics-deps.ts `criticMoveHold`) e o ledger em disco: o estado vive
// no diretório temporário do vitest (AGILEHARNESS_RUNNER_STATE_DIR). O crítico em si é falso (nada é lançado de verdade).

import { promises as fs } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storymap/sidecars", () => ({ readPlan: vi.fn(async () => "## Plano\n- filtro por autor\n") }));
const launched: string[] = [];
vi.mock("./critics", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, startCritic: vi.fn(async (_d: unknown, _q: unknown, p: { kind: string }) => void launched.push(p.kind)) };
});

const repoCard: { card: Card | null } = { card: null };
vi.mock("@/lib/storymap/repo", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readCard: async () => repoCard.card,
  readBoardConfig: async () => config,
}));

import { coerceCard } from "@/lib/storymap/repo";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { criticKey, planSubjectHash } from "./critics";
import { criticMoveHold, criticsLedgerPath, diskCriticLedger, driverClearHold, verifiedDeliveryNow } from "./critics-deps";

const statuses = [
  { id: "enriquecer", name: "Moldando" },
  { id: "desenvolver", name: "Construindo", trigger: "harness-do" },
  { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed" },
  { id: "merge", name: "Integrar" },
];
const config = { id: "demo", name: "Livraria", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy: { agentDecides: { spec: true, design: true, delivery: true } } } as unknown as BoardConfig;
const card = (over: Partial<Card> = {}): Card => ({
  ...coerceCard("story-ex9651", { type: "story", storyType: "user", title: "Filtro por autor", status: "enriquecer", acceptance: ["filtra"] }, ""),
  routing: { driver: "conductor" } as unknown as Card["routing"],
  ...over,
});

describe("driverClearHold — limpar → mover → repor o driver não pula o crítico", () => {
  it("antes de construir e sem o plano aprovado: recusa; aprovado, ou já depois de construir: pode", async () => {
    await fs.rm(criticsLedgerPath(), { force: true });
    repoCard.card = card();
    expect(await driverClearHold("demo", "story-ex9651")).toMatch(/plano deste card ainda não foi aprovado/);
    const hash = planSubjectHash("## Plano\n- filtro por autor\n", ["filtra"]);
    await diskCriticLedger().persist([{ key: criticKey("demo", "story-ex9651", "plan", hash), kind: "plan", board: "demo", cardId: "story-ex9651", subject: hash, outcome: "approved", attempts: 0, at: "x" }]);
    expect(await driverClearHold("demo", "story-ex9651")).toBeNull();
    await fs.rm(criticsLedgerPath(), { force: true });
    repoCard.card = card({ status: "revisao" });
    expect(await driverClearHold("demo", "story-ex9651")).toBeNull();
    repoCard.card = card({ routing: null });
    expect(await driverClearHold("demo", "story-ex9651")).toBeNull();
  });
});

describe("criticMoveHold — o move_card de um agente passa pelos críticos", () => {
  it("construir sem o plano aprovado: recusa e chama o crítico do plano; aprovado no ledger: passa", async () => {
    await fs.rm(criticsLedgerPath(), { force: true });
    launched.length = 0;
    const held = await criticMoveHold("demo", card(), config, "desenvolver");
    expect(held).toMatch(/crítico do plano/);
    await new Promise((r) => setTimeout(r, 10));
    expect(launched).toContain("plan");
    const hash = planSubjectHash("## Plano\n- filtro por autor\n", ["filtra"]);
    await diskCriticLedger().persist([{ key: criticKey("demo", "story-ex9651", "plan", hash), kind: "plan", board: "demo", cardId: "story-ex9651", subject: hash, outcome: "approved", attempts: 0, at: "x" }]);
    expect(await criticMoveHold("demo", card(), config, "desenvolver")).toBeNull();
  });

  it("um movimento que nenhuma régua cobre passa sem ler nada", async () => {
    expect(await criticMoveHold("demo", card({ routing: null }), config, "desenvolver")).toBeNull();
    expect(await criticMoveHold("demo", card(), config, "enriquecer")).toBeNull();
  });

  it("a entrega autônoma só sai de «Aprovar entrega» com o verificador; o ledger diz se ele aprovou ESTA mudança", async () => {
    await fs.rm(criticsLedgerPath(), { force: true });
    launched.length = 0;
    const range = { base: "a".repeat(40), head: "c".repeat(40) };
    const atReview = card({ status: "revisao", commitRange: range });
    expect(await criticMoveHold("demo", atReview, config, "merge")).toMatch(/verificador independente/);
    await new Promise((r) => setTimeout(r, 10));
    expect(launched).toContain("delivery");
    expect(await verifiedDeliveryNow("demo", atReview)).toBeNull();
    await diskCriticLedger().persist([{ key: criticKey("demo", "story-ex9651", "delivery", range.head), kind: "delivery", board: "demo", cardId: "story-ex9651", subject: range.head, outcome: "approved", attempts: 0, at: "x", runId: "r1", model: "sonnet" }]);
    expect(await criticMoveHold("demo", atReview, config, "merge")).toBeNull();
    expect(await verifiedDeliveryNow("demo", atReview)).toEqual({ runId: "r1", model: "sonnet" });
  });
});
