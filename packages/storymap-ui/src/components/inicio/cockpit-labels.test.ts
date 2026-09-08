import { describe, expect, it } from "vitest";
import {
  COCKPIT_DEMAND_LABEL,
  COCKPIT_KIND_LABEL,
  LANE_DOT_CLS,
  LANE_TEXT_CLS,
  cockpitItemShowsStatus,
  cockpitItemSnippet,
  cockpitItemTitle,
  cockpitItemWaitingMs,
} from "./cockpit-labels";
import {
  COCKPIT_GROUP_ORDER,
  type CockpitItem,
  type CockpitItemKind,
} from "@/lib/storymap/demands";

describe("COCKPIT_KIND_LABEL", () => {
  it("gives every kind a non-empty human label", () => {
    for (const [kind, label] of Object.entries(COCKPIT_KIND_LABEL)) {
      expect(typeof label, kind).toBe("string");
      expect(label.trim().length, kind).toBeGreaterThan(0);
    }
  });
});

describe("COCKPIT_DEMAND_LABEL", () => {
  it("gives every kind a non-empty demand phrase", () => {
    for (const [kind, label] of Object.entries(COCKPIT_DEMAND_LABEL)) {
      expect(typeof label, kind).toBe("string");
      expect(label.trim().length, kind).toBeGreaterThan(0);
    }
  });

  // O pedido tem de ser um VERBO no imperativo — é isso que o distingue do substantivo do kind e o
  // motivo de ele existir: o cabeçalho passa a dizer o que FAZER em vez de enfileirar categorias.
  it("phrases every demand as an action, never as the kind's noun", () => {
    for (const kind of Object.keys(COCKPIT_DEMAND_LABEL) as Array<keyof typeof COCKPIT_DEMAND_LABEL>) {
      const demand = COCKPIT_DEMAND_LABEL[kind];
      expect(demand, kind).not.toBe(COCKPIT_KIND_LABEL[kind]);
      expect(demand.split(" ")[0], kind).toMatch(/(ar|er|ir)$/);
    }
  });
});

describe("cockpitItemShowsStatus", () => {
  // O status do pipeline de uma PROPOSTA é o "Capturando" do contêiner efêmero — era a terceira
  // palavra redundante do cabeçalho do Inbox, e o CockpitItemRow já a suprimia com um if local.
  it("hides the pipeline status when the column is constant or there is no card", () => {
    expect(cockpitItemShowsStatus({ kind: "proposal", cardId: "capture-xyz" })).toBe(false);
    expect(cockpitItemShowsStatus({ kind: "review", cardId: "story-abc" })).toBe(false);
    expect(cockpitItemShowsStatus({ kind: "governance", cardId: "" })).toBe(false);
    expect(cockpitItemShowsStatus({ kind: "approval", cardId: "story-abc" })).toBe(false);
  });

  it("shows it for a card-backed item, and never invents one without a card", () => {
    expect(cockpitItemShowsStatus({ kind: "question", cardId: "story-abc" })).toBe(true);
    expect(cockpitItemShowsStatus({ kind: "question", cardId: "" })).toBe(false);
  });
});

describe("lane visual maps", () => {
  it("cover every cockpit lane (dot + text colour)", () => {
    for (const lane of COCKPIT_GROUP_ORDER) {
      expect(LANE_DOT_CLS[lane], lane).toBeTruthy();
      expect(LANE_TEXT_CLS[lane], lane).toBeTruthy();
    }
  });
});

describe("cockpitItemTitle", () => {
  it("uses the underlying card title when present", () => {
    const item = { kind: "question", cardTitle: "Avisar quando a rede cai" } as unknown as CockpitItem;
    expect(cockpitItemTitle(item)).toBe("Avisar quando a rede cai");
  });

  it("falls back to the kind label for a board-level item with no card title", () => {
    const item = { kind: "governance", cardTitle: "" } as unknown as CockpitItem;
    expect(cockpitItemTitle(item)).toBe(COCKPIT_KIND_LABEL.governance);
  });

  it("treats a whitespace-only card title as empty (fallback to the kind label)", () => {
    const item = { kind: "approval", cardTitle: "   " } as unknown as CockpitItem;
    expect(cockpitItemTitle(item)).toBe(COCKPIT_KIND_LABEL.approval);
  });
});

// The MINIMUM shape each kind needs for its snippet branch. Typed as an exhaustive Record over
// CockpitItemKind, so a new kind cannot be added to the union without also being covered here.
const SNIPPET_FIXTURE: Record<CockpitItemKind, Record<string, unknown>> = {
  question: { prompt: "Qual gatilho usar para a reconexão?" },
  blocker: { title: "Rules permitem escrita anônima" },
  finding: { title: "N+1 na listagem de cards" },
  "deploy-failed": { title: "Publish revertido pelo canário" },
  gate: { gateLabel: "Aprovar entrega" },
  approval: { gateLabel: "Copiloto pede: Bash (destructive)", tool: "Bash" },
  review: {},
  stuck: { outcome: "timeout após 900s" },
  conflict: { conflictKind: "merge-conflict" },
  proposal: { summary: "3 stories sobre notificação", items: [] },
  design: { artifacts: [{}, {}] },
  governance: { reason: "Renomear o passo Revisar", changes: [] },
  "deploy-unsettled": { deployFiredAt: "2026-07-22T10:00:00.000Z" },
  "release-aging": { stagedAt: "2026-07-18T10:00:00.000Z", ageDays: 4 },
  "merge-failed": { runId: "r1", branch: "failed/run/r1", failureReason: "o gate reprovou" },
};

const ALL_KINDS = Object.keys(SNIPPET_FIXTURE) as CockpitItemKind[];

function fixture(kind: CockpitItemKind, extra: Record<string, unknown> = {}): CockpitItem {
  return {
    id: `x:${kind}`,
    kind,
    boardId: "acme",
    cardId: "story-abc",
    cardTitle: "Avisar quando a rede cai",
    status: "desenvolver",
    lane: "pergunta",
    severity: "media",
    ...SNIPPET_FIXTURE[kind],
    ...extra,
  } as unknown as CockpitItem;
}

describe("cockpitItemSnippet", () => {
  // The pile shows ONE item at a time — a kind that renders a blank second line would read as a
  // broken card, so "every kind says something" is the invariant, not a nice-to-have.
  it.each(ALL_KINDS)("gives %s a non-empty line", (kind) => {
    const snippet = cockpitItemSnippet(fixture(kind));
    expect(snippet.trim().length, kind).toBeGreaterThan(0);
  });

  it("prefers the question's own prompt", () => {
    expect(cockpitItemSnippet(fixture("question"))).toBe("Qual gatilho usar para a reconexão?");
  });

  it("falls back from an empty prompt to the question's context", () => {
    const item = fixture("question", { prompt: "   ", context: "Decide o formato do webhook." });
    expect(cockpitItemSnippet(item)).toBe("Decide o formato do webhook.");
  });

  it("distinguishes a gate failure from a content conflict", () => {
    const gateFailed = cockpitItemSnippet(fixture("conflict", { conflictKind: "merge-gate-failed" }));
    const contentConflict = cockpitItemSnippet(fixture("conflict", { conflictKind: "merge-conflict" }));
    expect(gateFailed).not.toBe(contentConflict);
    expect(gateFailed).toContain("gate");
  });

  it("carries the release age into the line", () => {
    expect(cockpitItemSnippet(fixture("release-aging", { ageDays: 9 }))).toContain("9d");
  });

  it("falls back to the branch when a merge failure has no reason", () => {
    const item = fixture("merge-failed", { failureReason: undefined });
    expect(cockpitItemSnippet(item)).toContain("failed/run/r1");
  });

  it("names the tool when an approval carries no note", () => {
    expect(cockpitItemSnippet(fixture("approval"))).toContain("Bash");
  });
});

describe("cockpitItemWaitingMs", () => {
  const NOW = Date.parse("2026-07-23T12:00:00.000Z");

  it("measures the wait from `since`", () => {
    const item = fixture("question", { since: "2026-07-23T11:30:00.000Z" });
    expect(cockpitItemWaitingMs(item, NOW)).toBe(30 * 60_000);
  });

  it("returns null when the item carries no timestamp", () => {
    expect(cockpitItemWaitingMs(fixture("question", { since: null }), NOW)).toBeNull();
    expect(cockpitItemWaitingMs(fixture("question"), NOW)).toBeNull();
  });

  it("returns null for a malformed timestamp instead of NaN", () => {
    const item = fixture("question", { since: "ontem à tarde" });
    expect(cockpitItemWaitingMs(item, NOW)).toBeNull();
  });

  it("clamps a future timestamp to 0 rather than going negative", () => {
    const item = fixture("question", { since: "2026-07-23T12:05:00.000Z" });
    expect(cockpitItemWaitingMs(item, NOW)).toBe(0);
  });
});
