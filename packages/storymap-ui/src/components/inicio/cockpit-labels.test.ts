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
  docProposalHeadline,
  docProposalNotices,
  governanceDecision,
  governanceSections,
  meterRenewMessage,
  meterStallHeadline,
  previewList,
} from "./cockpit-labels";
import { PRD_SCHEMA } from "@/lib/storymap/doc/schemas/prd";
import type { KeepaliveNowOutcome } from "@/lib/storymap/runner/capacity-service";
import type { GovernanceChange, GovernanceDraft } from "@/lib/storymap/types";
import { inboxItemHref } from "@/lib/storymap/deep-links";
import {
  COCKPIT_GROUP_ORDER,
  governanceItemsFromDrafts,
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
  "proxy-audit": { prompt: "Quem é o público?", answer: "Leitoras", assumptions: "PRD", confidence: 0.8 },
  "delivery-audit": { sampledAt: "2026-09-25", proof: "- **O que mudou:** filtro por gênero na lista" },
  "meter-stalled": { stalledSince: Date.UTC(2026, 8, 25, 3, 10), detectedAt: Date.UTC(2026, 8, 25, 3, 40), detail: "leitura com 30min" },
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

  it("o medidor parado diz desde QUANDO (hora local de quem lê), o efeito e a causa provável", () => {
    const since = Date.UTC(2026, 8, 25, 3, 10);
    const hhmm = new Date(since).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    expect(cockpitItemSnippet(fixture("meter-stalled", { stalledSince: since }))).toBe(
      `medidor de cota parado desde ${hhmm} — automação retida; causa provável: sem tráfego pelo proxy / token expirado`,
    );
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

// ── A proposta de governança como DECISÃO (v0.9.2) ────────────────────────────────────────────────
// Medido no ar (board nook): o rascunho do PRD — 20 mudanças, 16 seções — vinha INTEIRO antes do Aprovar, que
// ficava a 8.768 px do topo a 390px; e o título do item era a lista de chaves ("prd.resumo + prd.problema + …").

/** Um rascunho do PRD INTEIRO: uma mudança por seção do schema (topo e subseções), como o do board nook. */
const fullPrd: GovernanceChange[] = PRD_SCHEMA.sections.map((sec) => ({
  artifact: "prd",
  field: sec.key,
  before: "",
  after: `texto de ${sec.label}`,
  label: `PRD · ${sec.label}`,
}));
const topLevel = PRD_SCHEMA.sections.filter((sec) => sec.level === 2);

describe("governanceSections", () => {
  it("no PRD conta a seção de TOPO: a subseção entra como a seção que a contém, sem repetir", () => {
    const sections = governanceSections(fullPrd);
    expect(fullPrd.length).toBe(20);
    expect(sections).toHaveLength(16);
    expect(sections).toEqual(topLevel.map((sec) => sec.label));
  });

  it("nos outros artefatos cada campo tocado é uma unidade, com o rótulo do proponente", () => {
    expect(
      governanceSections([
        { artifact: "canvas", field: "problem", before: "", after: "x", label: "Canvas · Problema" },
        { artifact: "canvas", field: "problem", before: "", after: "y", label: "Canvas · Problema" },
        { artifact: "desiredOutcome", field: null, before: "", after: "z" },
      ]),
    ).toEqual(["Canvas · Problema", "resultado-alvo"]);
  });
});

describe("governanceDecision", () => {
  it("o PRD inteiro vira UMA manchete — o que se decide e o tamanho: «Aprovar o PRD do board — 16 seções»", () => {
    const d = governanceDecision({ changes: fullPrd, conflicts: [] })!;
    expect(d.headline).toBe("Aprovar o PRD do board — 16 seções");
    expect(d.readLabel).toBe("Ler o rascunho completo (16 seções)");
    expect(d.sections).toHaveLength(16);
  });

  it("conflitos entram na manchete — o dono vê que o Aprovar está bloqueado antes de tentar", () => {
    expect(governanceDecision({ changes: fullPrd, conflicts: ["PRD · Posicionamento"] })!.headline).toBe(
      "Aprovar o PRD do board — 16 seções, 1 conflito",
    );
    const one: GovernanceChange[] = [{ artifact: "positioning", field: null, before: "a", after: "b" }];
    expect(governanceDecision({ changes: one, conflicts: ["positioning", "x"] })!.headline).toBe(
      "Aprovar o posicionamento — 2 conflitos",
    );
  });

  it("um artefato só, uma mudança: sem contagem; várias: contadas; canvas por bloco; vários artefatos: nomeados", () => {
    const one: GovernanceChange[] = [{ artifact: "desiredOutcome", field: null, before: "a", after: "b" }];
    expect(governanceDecision({ changes: one, conflicts: [] })).toMatchObject({
      headline: "Aprovar o resultado-alvo",
      readLabel: "Ver o antes e depois (1 mudança)",
    });
    const canvas: GovernanceChange[] = [
      { artifact: "canvas", field: "problem", before: "", after: "x" },
      { artifact: "canvas", field: "solution", before: "", after: "y" },
    ];
    expect(governanceDecision({ changes: canvas, conflicts: [] })!.headline).toBe("Aprovar o Lean Canvas — 2 blocos");
    const mixed: GovernanceChange[] = [...one, ...canvas];
    expect(governanceDecision({ changes: mixed, conflicts: [] })!.headline).toBe(
      "Aprovar mudanças no board — resultado-alvo + Lean Canvas",
    );
  });

  it("sem mudança nenhuma ⇒ null (a tela cai no rótulo do kind)", () => {
    expect(governanceDecision({ changes: [], conflicts: [] })).toBeNull();
  });

  it("é o TÍTULO do item de governança em toda superfície — nunca mais a lista de chaves", () => {
    const item = {
      kind: "governance",
      cardTitle: fullPrd.map((c) => `prd.${c.field}`).join(" + "),
      changes: fullPrd,
      conflicts: [],
    } as unknown as CockpitItem;
    expect(cockpitItemTitle(item)).toBe("Aprovar o PRD do board — 16 seções");
  });
});

// ── A proposta pendente vista de DENTRO do documento ──────────────────────────────────────────────
// O dono abriu o PRD e disse «parece que o prd ainda segue o mesmo»: a versão nova esperava no Inbox, e a
// tela do documento não dava sinal nenhum. O aviso diz que existe, o tamanho, quem propôs — e leva ao item.

describe("docProposalHeadline", () => {
  it("uma: diz que existe e que o que está na tela é a versão aprovada", () => {
    expect(docProposalHeadline(1)).toBe(
      "Há uma proposta pendente para este documento — o que você vê abaixo é a versão aprovada.",
    );
  });

  it("várias: contadas na mesma frase", () => {
    expect(docProposalHeadline(3)).toBe(
      "Há 3 propostas pendentes para este documento — o que você vê abaixo é a versão aprovada.",
    );
  });
});

describe("docProposalNotices", () => {
  const draft = (over: Partial<GovernanceDraft> = {}): GovernanceDraft => ({
    id: "85f2-draft",
    board: "b",
    status: "pending",
    reason: "",
    origin: { skill: "claude-code-session", cardId: null },
    changes: fullPrd,
    createdAt: "2026-09-25",
    decidedAt: null,
    ...over,
  });

  it("leva à página do MESMO item que o Inbox mostra — o id é o do cockpit, não uma segunda construção", () => {
    const d = draft();
    const [notice] = docProposalNotices([d], "b");
    const [item] = governanceItemsFromDrafts([d], new Map(), "b", Date.parse("2026-09-25T12:00:00Z"));
    expect(notice.href).toBe(inboxItemHref("b", item.id));
    expect(notice.href).toBe("/board/b/inbox/gov%3A85f2-draft");
    expect(notice.draftId).toBe("85f2-draft");
  });

  it("o detalhe: o tamanho na unidade do Inbox, quem propôs e o dia — «16 seções», como no título do item", () => {
    expect(docProposalNotices([draft()], "b")[0].detail).toBe(
      "16 seções · proposta por um agente (claude-code-session) · em 25/09",
    );
  });

  it("sem `origin.skill` a proposta é de uma pessoa (a UI não o preenche, `propose_change` sim)", () => {
    const humana = draft({ origin: null, changes: fullPrd.slice(0, 1) });
    expect(docProposalNotices([humana], "b")[0].detail).toBe("1 seção · proposta por uma pessoa · em 25/09");
  });

  it("no Lean Canvas a unidade é o bloco; data ilegível some do detalhe em vez de virar lixo", () => {
    const canvas = draft({
      createdAt: "ontem",
      changes: [
        { artifact: "canvas", field: "problem", before: null, after: { items: [] } },
        { artifact: "canvas", field: "solution", before: null, after: { items: [] } },
      ],
    });
    expect(docProposalNotices([canvas], "b")[0].detail).toBe("2 blocos · proposta por um agente (claude-code-session)");
  });

  it("uma linha por proposta, na ordem recebida", () => {
    const notices = docProposalNotices([draft({ id: "x" }), draft({ id: "y" })], "b");
    expect(notices.map((n) => n.draftId)).toEqual(["x", "y"]);
  });
});

describe("previewList", () => {
  it("até `max` nomes, o resto contado", () => {
    expect(previewList(["a", "b"])).toBe("a, b");
    expect(previewList(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d e mais 2");
    expect(previewList(["a", "b", "c"], 2)).toBe("a, b e mais 1");
  });
});

// ── O medidor de cota parado: aviso compacto + «Renovar agora» (v0.9.2) ──────────────────────────────

describe("meterStallHeadline", () => {
  it("UMA linha: o fato e o efeito, na hora de quem lê — a causa fica no «por quê» recolhido", () => {
    const since = Date.UTC(2026, 8, 25, 3, 10);
    const hhmm = new Date(since).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    expect(meterStallHeadline(since)).toBe(`Medidor de cota parado desde ${hhmm} — automação retida`);
  });
});

describe("meterRenewMessage", () => {
  const ALL: KeepaliveNowOutcome[] = ["renewed", "still-stalled", "failed", "not-configured", "no-meter"];

  it.each(ALL)("dá a %s uma frase", (outcome) => {
    expect(meterRenewMessage({ outcome, detail: "" }).text.trim().length).toBeGreaterThan(0);
  });

  it("só «renovado» é sucesso; «não configurado» diz a QUEM pedir e O QUÊ", () => {
    expect(meterRenewMessage({ outcome: "renewed", detail: "ok" })).toEqual({
      tone: "success",
      text: "Medidor renovado — a automação volta a entrar.",
    });
    const nc = meterRenewMessage({ outcome: "not-configured", detail: "" });
    expect(nc.tone).not.toBe("success");
    expect(nc.text).toContain("operador do host");
    expect(nc.text).toContain("AGILEHARNESS_METER_KEEPALIVE");
    for (const o of ALL.filter((x) => x !== "renewed")) expect(meterRenewMessage({ outcome: o, detail: "" }).tone, o).not.toBe("success");
  });

  it("a falha carrega o erro do keepalive", () => {
    expect(meterRenewMessage({ outcome: "failed", detail: "exit 1 — not logged in" })).toEqual({
      tone: "error",
      text: "O keepalive falhou: exit 1 — not logged in",
    });
  });
});
