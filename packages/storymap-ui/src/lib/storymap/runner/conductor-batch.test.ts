// O LOTE DO CONDUTOR — as réguas puras (runner/conductor-batch.ts). Fixtures inventadas (story-ex9NNN).
//
// O que cada bloco trava:
//   • `batchable` — história/técnica/spike nunca entram num lote (decisão 5 do dono);
//   • `batchCapUSD` — US$ 10 por item, no máximo US$ 30, nunca acima do teto do board, e nada com o teto desligado;
//   • `validateBatch` — cada motivo de recusa, tudo ou nada, a retomada que re-pega os itens do lote anterior;
//   • os trailers `Card:` — o código de um item que saiu é visto até ser desfeito, e cada item ganha o seu intervalo.

import { describe, expect, it } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { FeatureKey } from "@/lib/storymap/feature-key";
import type { Card } from "@/lib/storymap/types";
import {
  batchable,
  batchCapUSD,
  commitTrailers,
  itemCommitRanges,
  sharesFeature,
  unrevertedDroppedCommits,
  validateBatch,
  type BatchValidationCtx,
} from "./conductor-batch";
import type { ConductorQueueEntry } from "./conductor";

const routing = { skips: [], decidedBy: "rules" as const, decidedAt: "2026-10-01", driver: "conductor" as const };
const bug = (id: string, extra: Record<string, unknown> = {}): Card =>
  coerceCard(id, { type: "story", storyType: "bug", status: "pronta", routing, ...extra }, "");
const chore = (id: string, extra: Record<string, unknown> = {}): Card =>
  coerceCard(id, { type: "story", storyType: "chore", status: "pronta", routing, ...extra }, "");
const story = (id: string): Card => coerceCard(id, { type: "story", storyType: "user", status: "pronta", routing }, "");

const keyA: FeatureKey = { id: "busca-no-catalogo", title: "Busca no catálogo", self: false, source: "prd" };
const keyB: FeatureKey = { id: "lista-de-desejos", title: "Lista de desejos", self: false, source: "prd" };
const outros: FeatureKey = { id: "outros", title: "Outros (fora do PRD)", self: false, source: "outros" };

const entry = (cardId: string, extra: Partial<ConductorQueueEntry> = {}): ConductorQueueEntry => ({ board: "b", cardId, queuedAt: "2026-10-01T00:00:00Z", attempts: 0, ...extra });

function ctx(over: Partial<BatchValidationCtx> = {}, keys: Record<string, FeatureKey> = {}): BatchValidationCtx {
  return {
    board: "b",
    boardOf: () => "b",
    featureKeyOf: (c) => keys[c.id] ?? keyA,
    queue: [entry("story-ex9102"), entry("story-ex9103"), entry("story-ex9104")],
    fromStatus: null,
    admittedByScope: () => true,
    droppedBySession: new Set(),
    foreignClaimHolder: () => null,
    settingsCapUSD: 30,
    ledgerUSD: () => 0,
    sessionCostUSD: 0,
    closed: false,
    ...over,
  };
}

describe("batchable — história nunca entra num lote", () => {
  it("correção e manutenção entram; história, técnica e spike não", () => {
    expect(batchable({ storyType: "bug" })).toBe(true);
    expect(batchable({ storyType: "user", mode: "fix" })).toBe(true);
    expect(batchable({ storyType: "chore" })).toBe(true);
    expect(batchable({ storyType: "user" })).toBe(false);
    expect(batchable({ storyType: "technical" })).toBe(false);
    expect(batchable({ storyType: "spike" })).toBe(false);
  });

  it("«Outros» e o card que é a própria funcionalidade não formam lote", () => {
    expect(sharesFeature(keyA)).toBe(true);
    expect(sharesFeature(outros)).toBe(false);
    expect(sharesFeature({ source: "map", self: true })).toBe(false);
    expect(sharesFeature({ source: "map", self: false })).toBe(true);
    expect(sharesFeature(null)).toBe(false);
  });
});

describe("batchCapUSD — US$ 10 por item, no máximo US$ 30", () => {
  const items = (n: number) => Array.from({ length: n }, () => ({ storyType: "bug" as const }));
  it("1 → 10, 2 → 20, 3 → 30, 5 → 30", () => {
    expect(batchCapUSD(30, items(1))).toBe(10);
    expect(batchCapUSD(30, items(2))).toBe(20);
    expect(batchCapUSD(30, items(3))).toBe(30);
    expect(batchCapUSD(30, items(5))).toBe(30);
  });
  it("manutenção também conta US$ 10 (não o teto de história)", () => {
    expect(batchCapUSD(30, [{ storyType: "chore" }])).toBe(10);
  });
  it("teto do board 8 ⇒ 8 por item; teto desligado ⇒ sem teto; sem itens ⇒ sem teto", () => {
    expect(batchCapUSD(8, items(2))).toBe(16);
    expect(batchCapUSD(null, items(2))).toBeNull();
    expect(batchCapUSD(0, items(2))).toBeNull();
    expect(batchCapUSD(30, [])).toBeNull();
  });
});

describe("validateBatch — a admissão, tudo ou nada", () => {
  const lead = bug("story-ex9101");

  it("aceita correções/manutenções da mesma funcionalidade que esperam na fila, com o teto do lote", () => {
    const v = validateBatch(lead, [bug("story-ex9102"), chore("story-ex9103")], ctx());
    expect(v).toEqual({ ok: true, capUSD: 30, cardIds: ["story-ex9102", "story-ex9103"] });
  });

  it("ignora o próprio líder e ids repetidos", () => {
    const v = validateBatch(lead, [lead, bug("story-ex9102"), bug("story-ex9102")], ctx());
    expect(v).toEqual({ ok: true, capUSD: 20, cardIds: ["story-ex9102"] });
  });

  const refusal = (items: Card[], c: BatchValidationCtx, l: Card = lead) => {
    const v = validateBatch(l, items, c);
    if (v.ok) throw new Error("devia recusar");
    return v.refusals.map((r) => `${r.cardId}:${r.reason}`);
  };

  it("cada motivo de recusa de item", () => {
    expect(refusal([bug("story-ex9102")], ctx({ boardOf: () => "outro" }))).toEqual(["story-ex9102:other-board"]);
    expect(refusal([story("story-ex9102")], ctx())).toEqual(["story-ex9102:not-batchable"]);
    expect(refusal([bug("story-ex9102")], ctx({}, { "story-ex9102": keyB }))).toEqual(["story-ex9102:other-feature"]);
    expect(refusal([bug("story-ex9102")], ctx({}, { "story-ex9102": outros }))).toEqual(["story-ex9102:no-shared-feature"]);
    expect(refusal([bug("story-ex9102", { routing: { ...routing, driver: undefined } })], ctx())).toEqual(["story-ex9102:not-conducted"]);
    expect(refusal([bug("story-ex9105")], ctx())).toEqual(["story-ex9105:not-queued"]);
    expect(refusal([bug("story-ex9102")], ctx({ queue: [entry("story-ex9102", { solo: true })] }))).toEqual(["story-ex9102:solo"]);
    expect(refusal([bug("story-ex9102")], ctx({ droppedBySession: new Set(["story-ex9102"]) }))).toEqual(["story-ex9102:dropped"]);
    expect(refusal([bug("story-ex9102", { deferred: { reason: "depois", since: "2026-10-01" } })], ctx())).toEqual(["story-ex9102:deferred"]);
    expect(refusal([bug("story-ex9102", { reopenPending: true })], ctx())).toEqual(["story-ex9102:reopen-pending"]);
    expect(refusal([bug("story-ex9102")], ctx({ admittedByScope: () => false }))).toEqual(["story-ex9102:out-of-scope"]);
    expect(refusal([bug("story-ex9102")], ctx({ foreignClaimHolder: () => "session:outro" }))).toEqual(["story-ex9102:claimed"]);
  });

  it("item que já gastou o teto dele é recusado; lote acima do teto do lote é recusado no líder", () => {
    expect(refusal([bug("story-ex9102")], ctx({ ledgerUSD: (id) => (id === "story-ex9102" ? 10 : 0) }))).toContain("story-ex9102:item-over-cap");
    // líder + 1 item = US$ 20; a sessão já gastou 15 e o item tem 6 no ledger
    expect(refusal([bug("story-ex9102")], ctx({ sessionCostUSD: 15, ledgerUSD: (id) => (id === "story-ex9102" ? 6 : 0) }))).toEqual(["story-ex9101:batch-over-cap"]);
  });

  it("lote fechado (plano submetido) recusa tudo; líder história recusa; líder em «Outros» recusa", () => {
    expect(refusal([bug("story-ex9102")], ctx({ closed: true }))).toEqual(["story-ex9101:closed"]);
    expect(refusal([bug("story-ex9102")], ctx(), story("story-ex9101"))).toEqual(["story-ex9101:not-batchable"]);
    expect(refusal([bug("story-ex9102")], ctx({}, { "story-ex9101": outros }))).toEqual(expect.arrayContaining(["story-ex9101:no-shared-feature"]));
  });

  it("um item recusado recusa o lote inteiro (tudo ou nada)", () => {
    const v = validateBatch(lead, [bug("story-ex9102"), story("story-ex9103")], ctx());
    expect(v.ok).toBe(false);
  });

  it("a retomada re-pega os itens do lote ANTERIOR do mesmo líder, fora da fila", () => {
    const item = bug("story-ex9105", { batch: { id: "lote-old", lead: "story-ex9101", sessionId: "s-old", at: "2026-10-01T00:00:00Z" } });
    expect(validateBatch(lead, [item], ctx()).ok).toBe(true);
  });

  it("um órfão no status de entrada do condutor entra sem estar na fila", () => {
    expect(validateBatch(lead, [bug("story-ex9105")], ctx({ fromStatus: ["pronta"] })).ok).toBe(true);
  });

  it("os itens que a sessão já tem entram na conta do teto", () => {
    const v = validateBatch(lead, [bug("story-ex9103"), bug("story-ex9104")], ctx({ existingItems: [bug("story-ex9102")] }));
    expect(v).toEqual({ ok: true, capUSD: 30, cardIds: ["story-ex9103", "story-ex9104"] });
  });

  it("aumento aprovado no líder sobe o teto do lote", () => {
    const raised = bug("story-ex9101", {
      questions: [{ id: "q1", text: "teto", status: "answered", askedBy: "teto:40", selectedOptionIds: ["o1"], answeredBy: "human", askedAt: "2026-10-01" }],
    });
    const v = validateBatch(raised, [bug("story-ex9102")], ctx({ sessionCostUSD: 25 }));
    expect(v).toEqual({ ok: true, capUSD: 40, cardIds: ["story-ex9102"] });
  });
});

describe("os trailers dos commits do lote", () => {
  const c = (sha: string, message: string, parent = "p0") => ({ sha, parent, message });

  it("lê `Card:` e `Card-Revert:` (e o `git revert` padrão)", () => {
    expect(commitTrailers("conserta o filtro\n\nCard: story-ex9102\n")).toEqual({ cards: ["story-ex9102"], reverts: [] });
    expect(commitTrailers("Revert \"x\"\n\nThis reverts commit abcdef1234567.\n\nCard-Revert: abcdef1\n")).toEqual({ cards: [], reverts: ["abcdef1", "abcdef1234567"] });
  });

  it("o código de um item que saiu é visto até um revert dele", () => {
    const commits = [c("aaaaaaa1111", "a\n\nCard: story-ex9101"), c("bbbbbbb2222", "b\n\nCard: story-ex9102"), c("ccccccc3333", "c\n\nCard: story-ex9103")];
    expect(unrevertedDroppedCommits(commits, ["story-ex9102"])).toEqual([{ cardId: "story-ex9102", sha: "bbbbbbb2222" }]);
    const reverted = [...commits, c("ddddddd4444", "Revert b\n\nCard-Revert: bbbbbbb")];
    expect(unrevertedDroppedCommits(reverted, ["story-ex9102"])).toEqual([]);
    // reconstruído por cherry-pick: o item nem aparece no intervalo
    expect(unrevertedDroppedCommits([commits[0], commits[2]], ["story-ex9102"])).toEqual([]);
    expect(unrevertedDroppedCommits(commits, [])).toEqual([]);
  });

  it("cada item ganha o intervalo dele (do pai do primeiro ao último commit), sem os desfeitos", () => {
    const commits = [
      c("a1", "x\n\nCard: story-ex9101", "base0"),
      c("b1", "y\n\nCard: story-ex9102", "a1"),
      c("b2", "y2\n\nCard: story-ex9102", "b1"),
      c("c1", "z\n\nCard: story-ex9103", "b2"),
      c("c2", "Revert z\n\nCard-Revert: c1aaaaa", "c1"),
    ];
    // o revert usa um prefixo que não casa (curto demais para c1): conta só o que casa de verdade
    expect(itemCommitRanges(commits, ["story-ex9101", "story-ex9102"])).toEqual({
      "story-ex9101": { base: "base0", head: "a1" },
      "story-ex9102": { base: "a1", head: "b2" },
    });
    const longShas = [c("1111111aaaa", "z\n\nCard: story-ex9103", "base0"), c("2222222bbbb", "Revert\n\nCard-Revert: 1111111", "1111111aaaa")];
    expect(itemCommitRanges(longShas, ["story-ex9103"])).toEqual({});
  });
});
