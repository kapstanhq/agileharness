import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Layout contract for the minimalist closed Kanban card footer (story-2ulzzl, which
// SUPERSEDES story-7tzpc8). The redesign drops the old run-only "command strip" and the
// idle id/links footer in favour of ONE always-present action strip: the priority TIER on the
// left (Crítica/Alta/Média/Baixa, derived from WSJF; omitted when unscored — AC2; the exact number
// lives in the tooltip), and the controls pinned to the right edge — "Mover
// para" (MoveToPopover), ▶/⏹ Rodar/Parar (KanbanCardRunButton) and the ⋮ overflow
// (CardRunStatusBadge). The spirit of story-7tzpc8 survives: info left, actions glued
// right, never crowding.
//
// The AgileHarness UI test rig is node-env with no DOM renderer (jsdom / testing-library are
// absent and the include glob is `*.test.ts` only), so the layout contract is asserted
// against the component source — the className composition IS the contract.
const source = readFileSync(
  fileURLToPath(new URL("./KanbanCard.tsx", import.meta.url)),
  "utf8",
);

/**
 * Extract the action-strip footer block — from its comment marker to the start of the
 * `KanbanTypeLabel` helper (the action strip is the card's last JSX block, the helper follows it),
 * so the assertions target the footer only.
 */
function footerBlock(): string {
  const start = source.indexOf("Action strip");
  expect(start, "action strip comment marker present").toBeGreaterThan(-1);
  const end = source.indexOf("function KanbanTypeLabel", start);
  expect(end, "footer block end (KanbanTypeLabel helper) present").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("KanbanCard closed-card minimalist footer (story-2ulzzl)", () => {
  const block = footerBlock();

  it("renders the strip only on the real card, not the drag overlay (!overlay guard)", () => {
    expect(block).toMatch(/\{!overlay && \(/);
  });

  it("lays the strip on ONE row with a top divider (flex items-center + border-t)", () => {
    expect(block).toMatch(/flex items-center gap-1\.5 border-t border-line-muted/);
  });

  it("shows the priority TIER behind a null-guard so it is OMITTED when unscored (AC2)", () => {
    // The bare WSJF number was replaced by a qualitative tier (Crítica/Alta/Média/Baixa) — the face
    // shows the tier label, the WHY stays in the tooltip. Element renders only when the tier
    // (cardPriorityTier) is non-null (no placeholder/dash). story-redesenho-ia / prioridade-argumentada.
    expect(block).toMatch(/\{tier &&/);
    expect(block).toMatch(/\{tier\.label\}/);
    // The tooltip is now the computed `priorityTitle` — the argued rationale when set, else the WSJF.
    expect(block).toMatch(/title=\{priorityTitle\}/);
    // The exact WSJF number is preserved as the fallback branch for cards without an argued tier.
    expect(source).toMatch(/WSJF \$\{priorityScore\(card\)\}/);
  });

  it("pins the action controls RIGHT in an ml-auto group that WRAPS whole buttons (issue 2026-07-21)", () => {
    // flex-wrap + justify-end: num card estreito o BOTÃO inteiro desce de linha — nunca o texto de um
    // botão quebra no meio (o "Abrir no Inbox" sanduíche). Os filhos são shrink-0/nowrap por
    // contrato (QuickActionButton h-7/h-8 + icon-buttons h-7 — a régua vertical única da linha).
    expect(block).toMatch(/<div className="ml-auto flex flex-wrap items-center justify-end gap-1\.5">/);
  });

  it("the right group carries Mover then Rodar/Parar (the ⋮ overflow was removed — story-redesenho-cards)", () => {
    const move = block.indexOf("<MoveToPopover");
    const run = block.indexOf("<KanbanCardRunButton");
    expect(move, "MoveToPopover present").toBeGreaterThan(-1);
    expect(run, "KanbanCardRunButton present").toBeGreaterThan(move);
    // O kebab ⋮ (CardRunStatusBadge menuOnly) saiu: ações migraram pro drawer ao abrir o card.
    expect(block).not.toMatch(/<CardRunStatusBadge/);
  });

  it("carries the next-action slot between Console and Mover (copilot-actionability WS-2)", () => {
    // The slot (KanbanCardNextAction — the 1-click próxima ação + escalate) sits AFTER the console button and
    // BEFORE MoveToPopover. Guarding it here means a refactor that removed it would REPROVE (invariant 4),
    // instead of silently dropping the operator's next-obvious-action.
    const console_ = block.indexOf("<KanbanCardConsoleButton");
    const next = block.indexOf("<KanbanCardNextAction");
    const move = block.indexOf("<MoveToPopover");
    expect(next, "KanbanCardNextAction present").toBeGreaterThan(console_);
    expect(move, "MoveToPopover after the slot").toBeGreaterThan(next);
  });

  it("no longer carries the ⋮ overflow flags (menuOnly + hideMoves gone with the kebab)", () => {
    expect(block).not.toMatch(/menuOnly/);
    expect(block).not.toMatch(/hideMoves/);
  });
});

describe("KanbanCard minimalist surgery removed the old clutter (story-2ulzzl)", () => {
  it("dropped the run-only command strip and the id/links footer", () => {
    expect(source).not.toMatch(/Command strip/);
    expect(source).not.toMatch(/CopyIdButton/);
    // CardIdleDiffBadge foi RE-ADICIONADO (diff +/− no card fechado, só em colunas acionáveis) —
    // story-wdmio4 + redesenho-cards; por isso NÃO é mais asserido como ausente.
  });

  it("dropped the tasks preview, RICE/KANO/funil badges and the stage-progress bar", () => {
    expect(source).not.toMatch(/CardTasksPreview/);
    expect(source).not.toMatch(/RiceBadge|KanoBadge|FunnelBadge/);
    expect(source).not.toMatch(/CardStageProgress/);
  });

  it("keeps exactly ONE type label (KanbanTypeLabel) atop the card", () => {
    expect(source).toMatch(/<KanbanTypeLabel card=\{card\} \/>/);
  });
});
