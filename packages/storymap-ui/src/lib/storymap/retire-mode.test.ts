import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { cardToFrontmatter } from "./write";
import { checkGate } from "./gates";
import { mergeCardOnSave } from "./card-merge";
import type { BoardConfig, Card } from "./types";

const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "rascunho", name: "Rascunho" },
    { id: "descontinuar", name: "Descontinuar", gate: "hasRetireBrief", trigger: "harness-retire" },
    { id: "arquivados", name: "Arquivados", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

describe("coerceCard — retire mode (mode + retirement)", () => {
  it("defaults a card to build mode with no retirement", () => {
    const c = card({});
    expect(c.mode).toBeUndefined();
    expect(c.retirement).toBeNull();
  });

  it("reads mode:retire and the full retirement block", () => {
    const c = card({
      mode: "retire",
      retirement: {
        brief: "não engajou; tira do ar",
        disposition: "descontinuado",
        level: "remover-codigo",
        scope: ["codigo", "rota"],
        target: "/perfil/salvos",
        screenshot: "current.png",
        fromStatus: "concluida",
        dataDeletionApproved: false,
        openedAt: "2026-06-03",
      },
    });
    expect(c.mode).toBe("retire");
    expect(c.retirement).toMatchObject({
      brief: "não engajou; tira do ar",
      disposition: "descontinuado",
      level: "remover-codigo",
      scope: ["codigo", "rota"],
      target: "/perfil/salvos",
      screenshot: "current.png",
      fromStatus: "concluida",
      dataDeletionApproved: false,
      openedAt: "2026-06-03",
    });
  });

  it("forces level to null for a postergado card (it never removes code)", () => {
    const c = card({
      mode: "retire",
      retirement: { brief: "depois a gente faz", disposition: "postergado", level: "excluir-tudo" },
    });
    expect(c.retirement?.disposition).toBe("postergado");
    expect(c.retirement?.level).toBeNull();
  });

  it("dedups scope, drops unknown scopes, and defaults a missing disposition to descontinuado", () => {
    const c = card({
      retirement: { brief: "x", scope: ["codigo", "codigo", "bogus", "dados"] },
    });
    expect(c.retirement?.scope).toEqual(["codigo", "dados"]);
    expect(c.retirement?.disposition).toBe("descontinuado");
  });

  it("drops a retirement with no brief and coerces an unknown level to null", () => {
    expect(card({ mode: "retire", retirement: { disposition: "abandonado" } }).retirement).toBeNull(); // no brief
    expect(card({ retirement: { brief: "y", disposition: "abandonado", level: "nope" } }).retirement?.level).toBeNull();
  });

  it("coerces an unknown mode back to build (undefined)", () => {
    expect(card({ mode: "weird" }).mode).toBeUndefined();
  });
});

describe("checkGate — hasRetireBrief (gate de `descontinuar`)", () => {
  it("blocks entry to descontinuar without a retirement brief", () => {
    expect(checkGate(card({}), "descontinuar", board)).toMatch(/descontinua/i);
  });

  it("passes once the retirement carries a brief", () => {
    const c = card({
      mode: "retire",
      retirement: { brief: "remover o mural", disposition: "descontinuado", level: "despublicar" },
    });
    expect(checkGate(c, "descontinuar", board)).toBeNull();
  });

  it("has no gate on the terminal arquivados column", () => {
    expect(checkGate(card({}), "arquivados", board)).toBeNull();
  });
});

describe("cardToFrontmatter — retire round-trip", () => {
  const base = card({ title: "X" });

  it("omits mode + retirement on a build card (stays lean)", () => {
    const fm = cardToFrontmatter(base);
    expect("mode" in fm).toBe(false);
    expect("retirement" in fm).toBe(false);
  });

  it("emits + round-trips mode + retirement on a retire card", () => {
    const retired: Card = {
      ...base,
      mode: "retire",
      status: "descontinuar",
      retirement: {
        brief: "matar a feature",
        disposition: "descontinuado",
        level: "excluir-tudo",
        scope: ["codigo", "dados"],
        target: null,
        screenshot: null,
        fromStatus: "concluida",
        dataDeletionApproved: true,
        openedAt: "2026-06-03",
      },
    };
    const fm = cardToFrontmatter(retired);
    expect(fm.mode).toBe("retire");
    expect(fm.retirement).toMatchObject({
      brief: "matar a feature",
      disposition: "descontinuado",
      level: "excluir-tudo",
      scope: ["codigo", "dados"],
      dataDeletionApproved: true,
    });

    const back = coerceCard("x", fm as Record<string, unknown>, "");
    expect(back.mode).toBe("retire");
    expect(back.retirement).toMatchObject({
      brief: "matar a feature",
      level: "excluir-tudo",
      dataDeletionApproved: true,
      fromStatus: "concluida",
    });
  });

  it("does not emit a retirement whose brief is empty", () => {
    const empty: Card = {
      ...base,
      mode: "retire",
      retirement: {
        brief: "",
        disposition: "descontinuado",
        level: null,
        scope: [],
        target: null,
        screenshot: null,
        fromStatus: null,
        dataDeletionApproved: false,
        openedAt: null,
      },
    };
    expect("retirement" in cardToFrontmatter(empty)).toBe(false);
  });
});

describe("mergeCardOnSave — retirement is pipeline-owned (never clobbered by the drawer)", () => {
  it("preserves the on-disk retirement block over a stale drawer draft", () => {
    const onDisk = card({
      mode: "retire",
      retirement: { brief: "removido", disposition: "descontinuado", level: "remover-codigo" },
    });
    // A drawer draft that never re-synced the reopen block (its mode/retirement are stale/absent).
    const staleDraft: Card = { ...onDisk, mode: undefined, retirement: null, title: "novo título" };
    const merged = mergeCardOnSave(staleDraft, onDisk);
    expect(merged.title).toBe("novo título"); // human-authored field wins
    expect(merged.mode).toBe("retire"); // pipeline-owned field preserved from disk
    expect(merged.retirement?.brief).toBe("removido");
  });
});
