import { describe, expect, it } from "vitest";
import {
  applyViewFilter,
  archivedKanbanStatusIds,
  KANBAN_LOOSE_COLUMN,
  kanbanColumnOf,
  kanbanColumnStatuses,
  kanbanStories,
  terminalStatusIds,
  unlistedKanbanStatusIds,
  type Row,
} from "./views";
import { coerceCard } from "./repo";
import type { BoardConfig, Card, StatusDef } from "./types";

function status(id: string, extra: Partial<StatusDef> = {}): StatusDef {
  return { id, name: id, ...extra };
}

// Mirrors the real pipeline shape: a `refinar` re-entry column sits just BEFORE the
// terminal `concluida`, which is flagged terminal EXPLICITLY (not last-by-position).
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    status("rascunho"),
    status("desenvolver"),
    status("revisao"),
    status("refinar"),
    status("concluida", { terminal: true }),
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const row = (id: string, statusId: string | null, score: number | null): Row => ({
  card: coerceCard(id, { type: "story", status: statusId }, ""),
  score,
});

describe("terminalStatusIds", () => {
  it("returns the explicitly-flagged terminal statuses (not the last by position)", () => {
    expect(terminalStatusIds(board)).toEqual(new Set(["concluida"]));
  });

  it("falls back to the last status when none is flagged terminal", () => {
    const noFlag: BoardConfig = {
      ...board,
      statuses: board.statuses.map((s) => ({ ...s, terminal: undefined })),
    };
    expect(terminalStatusIds(noFlag)).toEqual(new Set(["concluida"])); // concluida is last here
  });

  it("the flag wins even when a NON-terminal column is last in the array", () => {
    // The exact regression: `refinar` appended after the terminal column. A positional
    // statuses[length-1] heuristic would wrongly pick `refinar`; the flag picks concluida.
    const refinarLast: BoardConfig = {
      ...board,
      statuses: [status("rascunho"), status("concluida", { terminal: true }), status("refinar")],
    };
    expect(terminalStatusIds(refinarLast)).toEqual(new Set(["concluida"]));
  });
});

describe("applyViewFilter — scope", () => {
  const rows: Row[] = [
    row("a", "concluida", 10),
    row("b", "desenvolver", 8),
    row("c", "concluida", 6),
    row("d", "rascunho", null),
  ];

  it('"open" hides terminal (concluida) cards — the bug the terminal flag fixes', () => {
    const out = applyViewFilter(rows, { scope: "open", topN: null }, board);
    expect(out.map((r) => r.card.id)).toEqual(["b", "d"]);
  });

  it('"all" shows every row', () => {
    const out = applyViewFilter(rows, { scope: "all", topN: null }, board);
    expect(out.map((r) => r.card.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("a specific status keeps only that status", () => {
    const out = applyViewFilter(rows, { scope: "concluida", topN: null }, board);
    expect(out.map((r) => r.card.id)).toEqual(["a", "c"]);
  });
});

describe("applyViewFilter — topN counts only scored rows", () => {
  const rows: Row[] = [
    row("a", "desenvolver", 10),
    row("b", "desenvolver", 8),
    row("c", "desenvolver", null), // unscored — must never fill a Top-N slot
    row("d", "desenvolver", null),
  ];

  it("Top 2 returns the 2 scored rows, not the unscored tail", () => {
    const out = applyViewFilter(rows, { scope: "all", topN: 2 }, board);
    expect(out.map((r) => r.card.id)).toEqual(["a", "b"]);
  });

  it("Top N never pads with unscored cards when fewer than N are scored", () => {
    const out = applyViewFilter(rows, { scope: "all", topN: 5 }, board);
    expect(out.map((r) => r.card.id)).toEqual(["a", "b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Kanban placement — the "never lose an active card" invariant. Mirrors the real
// _base pipeline shape: a `construcao` stage, the ELIMINATED hidden `reentry` stage
// (corrigir/refinar hidden), the hidden `backlog` capture lane, the live terminal,
// and the `archive` SYSTEM column (arquivados/duplicado) the trash drawer owns.
// ─────────────────────────────────────────────────────────────────────────────
const kb: BoardConfig = {
  id: "k",
  name: "K",
  columns: [
    { id: "construcao", name: "Construção" },
    { id: "reentry", name: "Reentrada" }, // exists but renders nothing (all its statuses hidden)
    { id: "live", name: "No ar" },
    { id: "archive", name: "Arquivo", system: true },
  ],
  statuses: [
    status("desenvolver", { column: "construcao" }),
    status("revisar-codigo", { column: "construcao" }),
    status("corrigir", { column: "reentry", hidden: true }), // reentry executor (bug fix)
    status("refinar", { column: "reentry", hidden: true }),
    status("capturando", { column: "backlog", hidden: true }), // ephemeral capture lane
    status("concluida", { column: "live", terminal: true }),
    status("arquivados", { column: "archive", terminal: true }),
    status("duplicado", { column: "archive", terminal: true }),
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (id: string, data: Partial<Card>): Card =>
  coerceCard(id, { type: "story", ...data } as Record<string, unknown>, "");

describe("kanban status partitions", () => {
  it("unlistedKanbanStatusIds = hidden statuses + statuses in a system column (drives the column LIST)", () => {
    expect(unlistedKanbanStatusIds(kb)).toEqual(
      new Set(["corrigir", "refinar", "capturando", "arquivados", "duplicado"]),
    );
  });

  it("archivedKanbanStatusIds = ONLY system-column statuses — hidden reentry is NOT archived", () => {
    // The whole fix in one assertion: `corrigir`/`refinar` are hidden but NOT dropped from the board.
    expect(archivedKanbanStatusIds(kb)).toEqual(new Set(["arquivados", "duplicado"]));
  });

  it("kanbanColumnStatuses renders every non-hidden, non-archive status as a column", () => {
    expect(kanbanColumnStatuses(kb).map((s) => s.id)).toEqual([
      "desenvolver",
      "revisar-codigo",
      "concluida",
    ]);
  });
});

describe("kanbanStories — an active card is never silently dropped", () => {
  it("KEEPS a bug being fixed in the hidden `corrigir` status (the reported bug)", () => {
    const cards = [card("bug", { status: "corrigir", storyType: "bug", mode: "fix" })];
    expect(kanbanStories(cards, kb).map((c) => c.id)).toEqual(["bug"]);
  });

  it("KEEPS a card in an UNKNOWN/future status (forward-safe fallback)", () => {
    const cards = [card("future", { status: "some-new-status-2027" })];
    expect(kanbanStories(cards, kb).map((c) => c.id)).toEqual(["future"]);
  });

  it("KEEPS a card with no status at all", () => {
    const cards = [card("nostatus", { status: null })];
    expect(kanbanStories(cards, kb).map((c) => c.id)).toEqual(["nostatus"]);
  });

  it("DROPS archived terminals (the trash drawer owns them)", () => {
    const cards = [card("a", { status: "arquivados" }), card("d", { status: "duplicado" })];
    expect(kanbanStories(cards, kb)).toEqual([]);
  });

  it("DROPS ephemeral capture/style containers even in a normal status", () => {
    const cards = [
      card("cap", { status: "desenvolver", capture: true }),
      card("sty", { status: "desenvolver", container: "style" }),
    ];
    expect(kanbanStories(cards, kb)).toEqual([]);
  });

  it("DROPS activities/steps — only stories flow through the kanban", () => {
    const cards = [
      coerceCard("act", { type: "activity", status: "desenvolver" } as Record<string, unknown>, ""),
      coerceCard("stp", { type: "step", status: "desenvolver" } as Record<string, unknown>, ""),
    ];
    expect(kanbanStories(cards, kb)).toEqual([]);
  });
});

describe("kanbanColumnOf — safe fallback to the loose lane, never null", () => {
  const columnIds = new Set(kanbanColumnStatuses(kb).map((s) => s.id));

  it("a card in a rendered status lands in that status column", () => {
    expect(kanbanColumnOf(card("x", { status: "desenvolver" }), columnIds)).toBe("desenvolver");
  });

  it("a card in a hidden reentry status falls into the loose lane (visible, not lost)", () => {
    expect(kanbanColumnOf(card("x", { status: "corrigir" }), columnIds)).toBe(KANBAN_LOOSE_COLUMN);
  });

  it("a card in an unknown status falls into the loose lane", () => {
    expect(kanbanColumnOf(card("x", { status: "zzz" }), columnIds)).toBe(KANBAN_LOOSE_COLUMN);
  });

  it("a card with no status falls into the loose lane", () => {
    expect(kanbanColumnOf(card("x", { status: null }), columnIds)).toBe(KANBAN_LOOSE_COLUMN);
  });
});

describe("kanban end-to-end — every kept story resolves to a rendered lane (nothing sumido)", () => {
  it("bug processed by autorun (create bug -> corrigir -> desenvolver) is always placed", () => {
    const columnIds = new Set(kanbanColumnStatuses(kb).map((s) => s.id));
    const renderedKeys = new Set([...columnIds, KANBAN_LOOSE_COLUMN]);
    const pool = [
      card("bug-triage", { status: "corrigir", storyType: "bug", mode: "fix" }), // mid-autorun (hidden)
      card("bug-building", { status: "desenvolver", storyType: "bug", mode: "fix" }), // advanced to build
      card("bug-done", { status: "concluida", storyType: "bug" }), // shipped
      card("weird", { status: "ghost-status" }), // corrupt/future status
      card("archived", { status: "arquivados" }), // legitimately off-board
    ];
    const rendered = kanbanStories(pool, kb);
    // the archived one is the only drop; every other card is present AND lands in a real lane
    expect(rendered.map((c) => c.id).sort()).toEqual(
      ["bug-building", "bug-done", "bug-triage", "weird"].sort(),
    );
    for (const c of rendered) {
      expect(renderedKeys.has(kanbanColumnOf(c, columnIds))).toBe(true);
    }
    // and the in-`corrigir` bug specifically shows in the loose lane, not nowhere
    expect(kanbanColumnOf(rendered.find((c) => c.id === "bug-triage")!, columnIds)).toBe(
      KANBAN_LOOSE_COLUMN,
    );
  });
});
