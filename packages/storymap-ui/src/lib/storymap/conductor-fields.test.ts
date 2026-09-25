// conductor-core — the two new DATA fields, in lockstep across the four places a field must live
// (type · coerce · contract · serializer). Each case is the regression the missing place would cause:
//   • `routing.driver` dropped by the coerce/serializer ⇒ the very next app write hands a conducted card back
//     to the column cascade (a stale column run fires into the conductor's card);
//   • board `conductor` dropped by the coerce ⇒ an `enabled: true` that silently never dispatches;
//     dropped by the persist ⇒ any board.yaml save (vocab/canvas) deletes the line from disk.

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { coerceCard, coerceConductor, deriveBoardConfigForPersist, readBoardConfig } from "./repo";
import { cardToFrontmatter, serializeCard } from "./write";
import { parseBoardConfig, parseCard } from "./contracts";
import { FIXTURE_BOARD } from "./board-fixture";

describe("card `routing.driver` — type · coerce · contract · serializer", () => {
  const raw = { type: "story", status: "pronta", routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" } };

  it("o coerce mantém um routing que SÓ carrega o driver (antes: skips vazio ⇒ routing null)", () => {
    const card = coerceCard("story-x", raw, "");
    expect(card.routing).toEqual({ skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" });
  });

  it("um driver desconhecido é descartado (tolerante), sem inventar routing", () => {
    const card = coerceCard("story-x", { ...raw, routing: { skips: [], driver: "robot" } }, "");
    expect(card.routing).toBeNull();
  });

  it("o serializer EMITE o bloco quando só há driver — e o round-trip é idêntico", () => {
    const card = coerceCard("story-x", raw, "");
    expect(cardToFrontmatter(card).routing).toEqual({ skips: [], decidedBy: "rules", decidedAt: "2026-09-25", driver: "conductor" });
    const parsed = matter(serializeCard(card));
    const back = coerceCard("story-x", parsed.data, parsed.content);
    expect(back.routing).toEqual(card.routing);
  });

  it("o driver convive com skips/perfil (e cada um round-tripa)", () => {
    const card = coerceCard(
      "story-x",
      { ...raw, routing: { skips: ["interview"], decidedBy: "agent", decidedAt: "2026-09-25", profile: "express", driver: "conductor" } },
      "",
    );
    const parsed = matter(serializeCard(card));
    expect(coerceCard("story-x", parsed.data, "").routing).toEqual(card.routing);
  });

  it("o contrato Card aceita o driver (e recusa um valor fora do vocabulário)", () => {
    const card = coerceCard("story-x", raw, "");
    expect(parseCard(card).ok).toBe(true);
    const bad = { ...card, routing: { ...card.routing!, driver: "robot" } };
    expect(parseCard(bad).ok).toBe(false);
  });
});

describe("board `conductor` — type · coerce · contract · persist", () => {
  it("coerceConductor: exige fromStatus; `enabled` só com true literal; cap e modelo validados", () => {
    expect(coerceConductor(undefined)).toBeUndefined();
    expect(coerceConductor({ enabled: true })).toBeUndefined(); // sem fromStatus nunca dispararia
    expect(coerceConductor({ enabled: "yes", fromStatus: " pronta " })).toEqual({ enabled: false, fromStatus: "pronta" });
    expect(coerceConductor({ enabled: true, fromStatus: "pronta", maxSessions: 3, model: "sonnet" })).toEqual({
      enabled: true,
      fromStatus: "pronta",
      maxSessions: 3,
      model: "sonnet",
    });
    expect(coerceConductor({ enabled: true, fromStatus: "pronta", maxSessions: 0, model: "gpt" })).toEqual({ enabled: true, fromStatus: "pronta" });
  });

  it("coerceConductor: fromStatus em LISTA — ids aparados, sem vazio/duplicata, na ordem autorada; lista vazia ⇒ sem bloco", () => {
    expect(coerceConductor({ enabled: true, fromStatus: [" interview ", "enriquecer", "", 7, "enriquecer", "corrigir"] })).toEqual({
      enabled: true,
      fromStatus: ["interview", "enriquecer", "corrigir"],
    });
    expect(coerceConductor({ enabled: true, fromStatus: [] })).toBeUndefined();
    expect(coerceConductor({ enabled: true, fromStatus: ["", "  "] })).toBeUndefined();
  });

  it("a lista round-tripa pelo contrato e pelo persist (um save não a achata em string)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const conductor = { enabled: true, fromStatus: ["pronta", "enriquecer"] };
    expect(parseBoardConfig({ ...base, conductor }).ok).toBe(true);
    expect(parseBoardConfig({ ...base, conductor: { enabled: true, fromStatus: [] } }).ok).toBe(false);
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, conductor })).conductor).toEqual(conductor);
  });

  it("o contrato BoardConfig aceita o bloco (e recusa um fromStatus vazio)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    expect(parseBoardConfig({ ...base, conductor: { enabled: true, fromStatus: "pronta", maxSessions: 2, model: "opus" } }).ok).toBe(true);
    expect(parseBoardConfig({ ...base, conductor: { enabled: true, fromStatus: "" } }).ok).toBe(false);
  });

  it("deriveBoardConfigForPersist EMITE o conductor — um save de outra coisa não apaga a linha", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const conductor = { enabled: true, fromStatus: "pronta", maxSessions: 2 };
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, conductor })).conductor).toEqual(conductor);
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, conductor: undefined })).conductor).toBeUndefined();
  });

  it("um board sem o bloco lê `conductor` ausente (sem chave fantasma)", async () => {
    const cfg = await readBoardConfig(FIXTURE_BOARD);
    expect("conductor" in cfg).toBe(false);
  });
});
