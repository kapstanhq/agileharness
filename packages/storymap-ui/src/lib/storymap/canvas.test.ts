import { describe, expect, it } from "vitest";
import {
  blockOrNull,
  blockToReviewText,
  blockToText,
  coerceCanvas,
  coerceCanvasBlock,
  coerceCanvasTags,
  ensureItemIds,
  groupsOf,
  isEmptyCanvasValue,
  itemColor,
  itemsOf,
  nextItemId,
  removeItem,
  resolveItemTags,
  stripTagFromCanvas,
  stripUnknownTagRefs,
  tagIdFromName,
  upsertItem,
  MAX_ITEMS_PER_BLOCK,
  MAX_ITEM_TEXT,
} from "./canvas";
import { CANVAS_BLOCKS, CANVAS_BLOCK_KEYS, CANVAS_GRID_BLOCKS, subBlocksOf } from "./canvas-blocks";
import type { BoardConfig, CanvasTag } from "./types";

const TAGS: CanvasTag[] = [
  { id: "descobridor", name: "Descobridor", color: "#E8A13C" },
  { id: "organizador", name: "Organizador", color: "#D9683E" },
];

describe("nextItemId / ensureItemIds", () => {
  it("hands out the first FREE sequential id (never collides with a taken one)", () => {
    expect(nextItemId([])).toBe("i1");
    expect(nextItemId(["i1", "i2"])).toBe("i3");
    expect(nextItemId(["i2"])).toBe("i1"); // buraco no meio é reaproveitado
  });

  it("keeps the ids an agent supplied and mints one for every NEW item", () => {
    const out = ensureItemIds([{ id: "i1", text: "mantido" }, { text: "novo" }, { id: "i5", text: "explícito" }]);
    expect(out.map((i) => i.id)).toEqual(["i1", "i2", "i5"]);
  });

  it("never lets a minted id steal an explicit id declared LATER in the list", () => {
    // Se o "i1" explícito do 2º item não fosse reservado antes, o 1º item ganharia "i1" e os dois
    // colidiriam — dois itens com o mesmo id somem um por baixo do outro na re-renderização.
    const out = ensureItemIds([{ text: "sem id" }, { id: "i1", text: "com id" }]);
    expect(out.map((i) => i.id)).toEqual(["i2", "i1"]);
    expect(new Set(out.map((i) => i.id)).size).toBe(2);
  });
});

describe("coerceCanvasBlock — tolerant of every shape the field has ever had", () => {
  it("promotes a LEGACY prose string into a single item (lossless)", () => {
    expect(coerceCanvasBlock("a agenda está espalhada")).toEqual({
      items: [{ id: "i1", text: "a agenda está espalhada" }],
    });
  });

  it("accepts a bare list of strings (hand-written YAML)", () => {
    expect(coerceCanvasBlock(["um", "dois"])).toEqual({
      items: [
        { id: "i1", text: "um" },
        { id: "i2", text: "dois" },
      ],
    });
  });

  it("keeps tags/group/highlight and drops empty text", () => {
    expect(
      coerceCanvasBlock({
        items: [
          { id: "a", text: " dor ", tags: ["descobridor"], group: "Demanda", highlight: true },
          { text: "  " },
        ],
      }),
    ).toEqual({ items: [{ id: "a", text: "dor", tags: ["descobridor"], group: "Demanda", highlight: true }] });
  });

  it("re-keys a DUPLICATE id instead of losing the item", () => {
    const block = coerceCanvasBlock({ items: [{ id: "i1", text: "um" }, { id: "i1", text: "dois" }] });
    expect(block?.items).toHaveLength(2);
    expect(new Set(block?.items.map((i) => i.id)).size).toBe(2);
  });

  it("empty is NULL (no husks): null, '', {} sem items, {items: []}", () => {
    expect(coerceCanvasBlock(null)).toBeNull();
    expect(coerceCanvasBlock("")).toBeNull();
    expect(coerceCanvasBlock("   ")).toBeNull();
    expect(coerceCanvasBlock({ items: [] })).toBeNull();
    expect(coerceCanvasBlock({})).toBeNull();
  });
});

describe("coerceCanvasTags", () => {
  it("drops entries with no id/name, dedupes by id, keeps a valid hex", () => {
    expect(
      coerceCanvasTags([
        { id: "a", name: "A", color: "#E8A13C" },
        { id: "a", name: "duplicada" },
        { id: "", name: "sem id" },
        { id: "b", name: "" },
        { id: "c", name: "C" },
      ]),
    ).toEqual([{ id: "a", name: "A", color: "#E8A13C" }, { id: "c", name: "C" }]);
  });

  it("REFUSES a colour that is not a plain hex (it is interpolated into an inline style)", () => {
    const [tag] = coerceCanvasTags([{ id: "x", name: "X", color: "red; background:url(javascript:1)" }]) ?? [];
    expect(tag).toEqual({ id: "x", name: "X" }); // sem cor → chip neutro, nunca a string crua
  });

  it("returns undefined for a non-list or an empty list", () => {
    expect(coerceCanvasTags(undefined)).toBeUndefined();
    expect(coerceCanvasTags([])).toBeUndefined();
    expect(coerceCanvasTags({ id: "x" })).toBeUndefined();
  });
});

describe("isEmptyCanvasValue — the governance conflict gate leans on this", () => {
  it("treats every flavour of nothing as nothing", () => {
    for (const v of [null, undefined, "", [], { items: [] }]) expect(isEmptyCanvasValue(v)).toBe(true);
  });

  it("a block with items is NOT empty", () => {
    expect(isEmptyCanvasValue({ items: [{ id: "i1", text: "x" }] })).toBe(false);
    expect(isEmptyCanvasValue([{ id: "t" }])).toBe(false);
    expect(isEmptyCanvasValue("texto")).toBe(false);
  });
});

describe("upsert / remove / blockOrNull", () => {
  it("upsert appends a new item and replaces an existing one IN PLACE (order is stable)", () => {
    const block = { items: [{ id: "i1", text: "um" }, { id: "i2", text: "dois" }] };
    expect(upsertItem(block, { id: "i3", text: "três" }).items.map((i) => i.id)).toEqual(["i1", "i2", "i3"]);
    const edited = upsertItem(block, { id: "i1", text: "UM" });
    expect(edited.items.map((i) => i.text)).toEqual(["UM", "dois"]); // não pula para o fim
  });

  it("removing the last item collapses the block to null (empty is null)", () => {
    expect(removeItem({ items: [{ id: "i1", text: "um" }] }, "i1")).toBeNull();
    expect(blockOrNull({ items: [] })).toBeNull();
    expect(blockOrNull(undefined)).toBeNull();
  });
});

describe("tags — colour resolution and deletion", () => {
  it("an item is painted by its FIRST resolvable tag; an unknown ref is ignored", () => {
    expect(itemColor({ id: "i1", text: "x", tags: ["organizador"] }, TAGS)).toBe("#D9683E");
    expect(itemColor({ id: "i1", text: "x", tags: ["fantasma", "descobridor"] }, TAGS)).toBe("#E8A13C");
    expect(itemColor({ id: "i1", text: "x" }, TAGS)).toBeUndefined();
    expect(resolveItemTags({ id: "i1", text: "x", tags: ["fantasma"] }, TAGS)).toEqual([]);
  });

  it("stripTagFromCanvas removes the id from EVERY item and returns only the blocks that changed", () => {
    const canvas = {
      problem: {
        items: [
          { id: "i1", text: "a", tags: ["descobridor", "organizador"] },
          { id: "i2", text: "b", tags: ["organizador"] },
        ],
      },
      solution: { items: [{ id: "i1", text: "c", tags: ["descobridor"] }] },
      channels: { items: [{ id: "i1", text: "d" }] },
    };
    const changed = stripTagFromCanvas(canvas, "organizador");
    expect(Object.keys(changed)).toEqual(["problem"]); // só o bloco que usava a tag
    expect(changed.problem?.items[0].tags).toEqual(["descobridor"]);
    expect(changed.problem?.items[1].tags).toBeUndefined(); // ficou sem tag → o campo some
    expect(canvas.problem.items[0].tags).toEqual(["descobridor", "organizador"]); // input intocado
  });
});

describe("groupsOf — the in-block headings emerge from the items themselves", () => {
  it("orders groups by first appearance and folds the ungrouped into a single null slot", () => {
    expect(
      groupsOf([
        { id: "i1", text: "a", group: "Demanda" },
        { id: "i2", text: "b" },
        { id: "i3", text: "c", group: "Oferta" },
        { id: "i4", text: "d", group: "Demanda" },
        { id: "i5", text: "e" },
      ]),
    ).toEqual(["Demanda", null, "Oferta"]);
  });

  it("no groups at all → one ungrouped slot", () => {
    expect(groupsOf([{ id: "i1", text: "a" }])).toEqual([null]);
    expect(groupsOf([])).toEqual([]);
  });
});

describe("tagIdFromName", () => {
  it("slugifies accents and spaces into a stable id", () => {
    expect(tagIdFromName("Curador Cultural")).toBe("curador-cultural");
    expect(tagIdFromName("Órgão Público!")).toBe("orgao-publico");
    expect(tagIdFromName("  ")).toBe("");
  });
});

describe("blockToText / itemsOf", () => {
  it("renders a block as one line per item (the diff the operator reads)", () => {
    expect(blockToText({ items: [{ id: "i1", text: "um" }, { id: "i2", text: "dois" }] })).toBe("- um\n- dois");
    expect(blockToText(null)).toBe("");
    expect(itemsOf(undefined, "problem")).toEqual([]);
  });
});

describe("the block registry (canvas-blocks)", () => {
  it("has the 9 Lean blocks in the grid + 3 sub-blocks folded into their parents", () => {
    expect(CANVAS_GRID_BLOCKS).toHaveLength(9);
    expect(CANVAS_BLOCKS).toHaveLength(12);
    expect(subBlocksOf("problem").map((b) => b.key)).toEqual(["existingAlternatives"]);
    expect(subBlocksOf("uniqueValueProposition").map((b) => b.key)).toEqual(["highLevelConcept"]);
    expect(subBlocksOf("customerSegments").map((b) => b.key)).toEqual(["earlyAdopters"]);
  });

  it("every grid block carries a fill-order 1..9 EXACTLY once, and a cell", () => {
    const orders = CANVAS_GRID_BLOCKS.map((b) => b.order).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const b of CANVAS_GRID_BLOCKS) expect(b.cell).toBeTruthy();
  });

  it("a sub-block has NO order and points at a REAL parent (senão ele não renderiza em lugar nenhum)", () => {
    const subs = CANVAS_BLOCKS.filter((b) => b.parent != null);
    expect(subs).toHaveLength(3);
    for (const sub of subs) {
      expect(sub.order).toBeUndefined();
      expect(CANVAS_BLOCK_KEYS).toContain(sub.parent!);
      expect(sub.cell).toBeUndefined(); // sub-bloco não ocupa célula própria
    }
  });

  it("keys are unique (o agente é validado contra esta lista)", () => {
    expect(new Set(CANVAS_BLOCK_KEYS).size).toBe(CANVAS_BLOCK_KEYS.length);
  });
});

describe("ensureItemIds — a repeated id is two items, not one", () => {
  it("RE-KEYS a duplicate id (React would otherwise render two notes as one, and deleting either would delete both)", () => {
    const out = ensureItemIds([
      { id: "i1", text: "primeiro" },
      { id: "i1", text: "segundo" },
    ]);
    expect(out.map((i) => i.text)).toEqual(["primeiro", "segundo"]); // nenhum item se perde
    expect(new Set(out.map((i) => i.id)).size).toBe(2); // e os ids são distintos
  });
});

describe("stripUnknownTagRefs — the referential invariant (no item wears a tag that doesn't exist)", () => {
  const tags: CanvasTag[] = [{ id: "descobridor", name: "Descobridor" }];

  it("strips a ref to a tag outside the vocabulary and returns ONLY the blocks it repaired", () => {
    const canvas = {
      problem: {
        items: [
          { id: "i1", text: "a", tags: ["descobridor", "fantasma"] },
          { id: "i2", text: "b", tags: ["fantasma"] },
        ],
      },
      solution: { items: [{ id: "i1", text: "c", tags: ["descobridor"] }] },
    };
    const repaired = stripUnknownTagRefs(canvas, tags);
    expect(Object.keys(repaired)).toEqual(["problem"]); // solution já estava íntegro
    expect(repaired.problem?.items[0].tags).toEqual(["descobridor"]);
    expect(repaired.problem?.items[1].tags).toBeUndefined(); // sem tag válida → o campo some
    expect(canvas.problem.items[0].tags).toEqual(["descobridor", "fantasma"]); // entrada intocada
  });

  it("an EMPTY vocabulary orphans every ref — and the repair clears them all", () => {
    const canvas = { problem: { items: [{ id: "i1", text: "a", tags: ["descobridor"] }] } };
    expect(stripUnknownTagRefs(canvas, []).problem?.items[0].tags).toBeUndefined();
  });
});

describe("blockToReviewText — the operator must SEE what they approve", () => {
  it("renders the tags and the group, not only the text (a lost tag would otherwise diff as 'no change')", () => {
    const out = blockToReviewText(
      { items: [{ id: "i1", text: "agenda espalhada", tags: ["descobridor"], group: "Demanda", highlight: true }] },
      TAGS,
    );
    expect(out).toContain("agenda espalhada");
    expect(out).toContain("Descobridor");
    expect(out).toContain("grupo: Demanda");
    expect(out).toContain("destaque");
  });

  it("um item sem metadados rende uma linha limpa", () => {
    expect(blockToReviewText({ items: [{ id: "i1", text: "só texto" }] }, TAGS)).toBe("- só texto");
  });
});

describe("bounds — an LLM/browser payload cannot wedge the board", () => {
  it("caps the items per block and the text of an item", () => {
    const huge = { items: Array.from({ length: MAX_ITEMS_PER_BLOCK + 25 }, (_, i) => ({ text: `item ${i}` })) };
    expect(coerceCanvasBlock(huge)?.items).toHaveLength(MAX_ITEMS_PER_BLOCK);
    const long = coerceCanvasBlock({ items: [{ text: "x".repeat(MAX_ITEM_TEXT + 500) }] });
    expect(long?.items[0].text).toHaveLength(MAX_ITEM_TEXT);
  });
});
