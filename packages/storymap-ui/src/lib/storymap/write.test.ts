import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { cardToFrontmatter, serializeCard } from "./write";
import { coerceCard } from "./repo";
import type { Card } from "./types";

// WS1 review fix (#6/#7): cardToFrontmatter dropped stagedAt/releasedAt/deployFiredAt, so release-aging
// (WS1.5) and the deploy-unsettled watchdog (WS1.1) — and the pre-existing Fase 4b staged-release dates —
// could never fire in production (the stamp was lost on the same write that set it).
const card = (over: Partial<Card>): Card => coerceCard("story-x", { type: "story", title: "T", status: "release", ...over }, "b");

describe("cardToFrontmatter — persist the pipeline date fields", () => {
  it("emits stagedAt/releasedAt/deployFiredAt when set", () => {
    const fm = cardToFrontmatter(card({ stagedAt: "2026-07-01", releasedAt: "2026-07-02", deployFiredAt: "2026-07-09T12:00:00Z" }));
    expect(fm.stagedAt).toBe("2026-07-01");
    expect(fm.releasedAt).toBe("2026-07-02");
    expect(fm.deployFiredAt).toBe("2026-07-09T12:00:00Z");
  });

  it("omits them when unset (sparse frontmatter)", () => {
    const fm = cardToFrontmatter(card({}));
    expect("stagedAt" in fm).toBe(false);
    expect("releasedAt" in fm).toBe(false);
    expect("deployFiredAt" in fm).toBe(false);
    expect("releasedSha" in fm).toBe(false);
    expect("deployTargets" in fm).toBe(false);
  });

  // MESMO footgun, campos novos: `releasedSha`/`deployTargets` são a EVIDÊNCIA que reconcilia um
  // `deploy-failure` contra a realidade publicada (deploy-reconcile.ts). Se não round-trippassem, o carimbo
  // morreria no próprio write que o cria, a reconciliação nunca teria o que ler, e o card ficaria travado
  // para sempre com o código no ar — exatamente o bug que este par de campos existe para fechar.
  it("ROUND-TRIP preserva releasedSha + deployTargets (a evidência do deploy-reconcile)", () => {
    const original = card({
      releasedSha: "5947d050253cdb017ba398454e62d06423cf28a6",
      deployTargets: ["acmeapp", "mosaico-site"],
    });
    const fm = cardToFrontmatter(original);
    expect(fm.releasedSha).toBe("5947d050253cdb017ba398454e62d06423cf28a6");
    expect(fm.deployTargets).toEqual(["acmeapp", "mosaico-site"]);

    const parsed = coerceCard("story-x", matter(serializeCard(original)).data, "b");
    expect(parsed.releasedSha).toBe("5947d050253cdb017ba398454e62d06423cf28a6"); // sha NÃO vira número/Date
    expect(parsed.deployTargets).toEqual(["acmeapp", "mosaico-site"]);
  });

  it("deployTargets vazio é tratado como ausente (não polui o frontmatter nem engana a reconciliação)", () => {
    const fm = cardToFrontmatter(card({ deployTargets: [] }));
    expect("deployTargets" in fm).toBe(false);
  });

  it("ROUND-TRIP through real YAML preserves the dates — incl. deployFiredAt's FULL time (not truncated, not dropped as a Date)", () => {
    // serializeCard → .md text → gray-matter parse (which turns an unquoted ISO into a Date) → coerceCard.
    const original = card({ stagedAt: "2026-07-01", releasedAt: "2026-07-02", deployFiredAt: "2026-07-09T12:34:56Z" });
    const parsed = coerceCard("story-x", matter(serializeCard(original)).data, "b");
    expect(parsed.stagedAt).toBe("2026-07-01");
    expect(parsed.releasedAt).toBe("2026-07-02");
    // the watchdog needs the minute-granular time, so a YYYY-MM-DD truncation or a dropped Date would break it
    expect(parsed.deployFiredAt).toBeTruthy();
    expect(Date.parse(parsed.deployFiredAt!)).toBe(Date.parse("2026-07-09T12:34:56Z"));
  });
});

// D7 (bloco de Design WS-0) — the style-guide generation container marker. A DEDICATED field, never
// `capture`: the Inbox's smart-capture surface collects every non-terminal `capture:true` card as
// a proposal-review item (cockpit-collect.ts: `cards.filter((c) => c.capture && !terminal)`) — a style
// container wrongly flagged `capture:true` would become a phantom item there with the wrong accept
// semantics (see types.ts Card.container doc + D7 in docs/plans/storymap-design-block/README.md).
describe("cardToFrontmatter — container (D7 style-guide generation marker)", () => {
  it("ROUND-TRIPs container:'style' through real YAML, and never sets `capture` alongside it", () => {
    const original = card({ container: "style" });
    const fm = cardToFrontmatter(original);
    expect(fm.container).toBe("style");
    expect("capture" in fm).toBe(false); // the two fields are disjoint by construction

    const parsed = coerceCard("story-x", matter(serializeCard(original)).data, "b");
    expect(parsed.container).toBe("style");
    // this is exactly the property cockpit-collect.ts's `c.capture && …` filter relies on: a style
    // container is falsy here, so it can never be picked up as a smart-capture proposal item.
    expect(parsed.capture).toBeUndefined();
  });

  it("omits container when unset (sparse frontmatter — every existing card stays lean)", () => {
    const fm = cardToFrontmatter(card({}));
    expect("container" in fm).toBe(false);
  });

  it("an unknown/garbage container value on disk degrades to absent (never throws, never a phantom kind)", () => {
    const parsed = coerceCard("story-x", { type: "story", title: "T", container: "not-a-real-kind" }, "b");
    expect(parsed.container).toBeUndefined();
  });
});

// D14 (bloco de Design WS-3) — the style-guide conformance stamp, written by harness-qa's visual sweep on
// a board that has a published guide. Full lockstep required (types.ts + contracts.ts + write.ts +
// repo.ts:coerceCard) — a field with no serializer here is DROPPED on the very write that sets it
// (the exact lesson this test guards against, per the D7/container precedent above).
describe("cardToFrontmatter — styleGuideCheck (D14 style-guide conformance stamp)", () => {
  it("ROUND-TRIPs styleGuideCheck through real YAML (version/hash/passed/at all survive)", () => {
    const original = card({ styleGuideCheck: { version: 3, hash: "abc123def", passed: true, at: "2026-07-20T14:00:00Z" } });
    const fm = cardToFrontmatter(original);
    expect(fm.styleGuideCheck).toEqual({ version: 3, hash: "abc123def", passed: true, at: "2026-07-20T14:00:00Z" });

    const parsed = coerceCard("story-x", matter(serializeCard(original)).data, "b");
    expect(parsed.styleGuideCheck).toEqual({ version: 3, hash: "abc123def", passed: true, at: "2026-07-20T14:00:00Z" });
  });

  it("ROUND-TRIPs a FAILING check too (passed:false is a real, meaningful value — not dropped as falsy)", () => {
    const original = card({ styleGuideCheck: { version: 1, hash: "h1", passed: false, at: "2026-07-20" } });
    const parsed = coerceCard("story-x", matter(serializeCard(original)).data, "b");
    expect(parsed.styleGuideCheck).toEqual({ version: 1, hash: "h1", passed: false, at: "2026-07-20" });
  });

  it("omits styleGuideCheck when unset (sparse frontmatter — a card without it stays intact)", () => {
    const fm = cardToFrontmatter(card({}));
    expect("styleGuideCheck" in fm).toBe(false);
  });

  it("a half-written stamp on disk (missing hash) degrades to absent, never throws", () => {
    const parsed = coerceCard("story-x", { type: "story", title: "T", styleGuideCheck: { version: 2, passed: true, at: "2026-07-20" } }, "b");
    expect(parsed.styleGuideCheck).toBeUndefined();
  });
});

// WS-5.2 (storymap-parallel-work) — o carimbo `buildEvidence`, a prova que o gate hasBuildEvidence aceita
// quando o código do card já aterrissou num run anterior (story-uae2ag). MESMO footgun de sempre, e aqui ele
// seria especialmente cruel: sem serializer o carimbo morre no write que o cria, o gate nunca abre, e o
// deadlock que este campo existe para matar continuaria — só que agora com código dizendo que foi resolvido.
describe("cardToFrontmatter — buildEvidence (WS-5.2 prova de convergência)", () => {
  const stamp = {
    provenance: "already-landed" as const,
    at: "2026-07-16T10:00:00.000Z",
    range: "aaa1111..bbb2222",
    target: "stage",
    runId: "run/0c7488ee",
  };

  it("ROUND-TRIPa o carimbo inteiro por YAML real (o gate precisa lê-lo do disco)", () => {
    const original = card({ buildEvidence: stamp });
    expect(cardToFrontmatter(original).buildEvidence).toEqual(stamp);
    expect(coerceCard("story-x", matter(serializeCard(original)).data, "b").buildEvidence).toEqual(stamp);
  });

  it("omite quando ausente (frontmatter esparso — todo card sem o carimbo segue lean)", () => {
    expect("buildEvidence" in cardToFrontmatter(card({}))).toBe(false);
  });

  it("um carimbo de proveniência DESCONHECIDA no disco é descartado (ninguém forja evidência de build)", () => {
    const parsed = coerceCard("story-x", { type: "story", title: "T", buildEvidence: { provenance: "confia-em-mim", at: "2026-07-16" } }, "b");
    expect(parsed.buildEvidence).toBeUndefined();
  });

  it("um carimbo sem `at` é descartado; os campos de auditoria opcionais só enfraquecem a trilha", () => {
    expect(coerceCard("story-x", { type: "story", title: "T", buildEvidence: { provenance: "already-landed" } }, "b").buildEvidence).toBeUndefined();
    const minimal = coerceCard("story-x", { type: "story", title: "T", buildEvidence: { provenance: "already-landed", at: "2026-07-16T10:00:00.000Z" } }, "b");
    expect(minimal.buildEvidence).toEqual({ provenance: "already-landed", at: "2026-07-16T10:00:00.000Z" });
  });
});
