import { describe, expect, it } from "vitest";
import {
  composeCardDocument,
  cardDocumentMarkdown,
  cardDocumentIsEmpty,
  openFindings,
  splitFindingsBySeverity,
  orderedWireframeOptions,
  type CardDocContext,
} from "./card-document";
import type { Card, Finding, WireframeDoc } from "./types";
import type { StepRollup } from "./step-rollup";

/** A minimal, valid Card — overridable per test. */
function card(over: Partial<Card> = {}): Card {
  return {
    id: "story-abc123",
    type: "story",
    title: "Acompanhar um run e editar seu spec",
    storyType: "user",
    status: "desenvolver",
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    findings: [],
    order: 10,
    created: null,
    updated: null,
    body: "",
    ...over,
  } as Card;
}

function ctx(over: Partial<CardDocContext> = {}): CardDocContext {
  return {
    strategic: { norte: [], idea: null, personas: [], systems: [], runPolicy: null },
    plan: null,
    wireframe: null,
    rollups: [],
    ...over,
  };
}

/** A minimal StepRollup — overridable per test (the projection consumes these directly; the
 *  fold from telemetry+fields is covered by step-rollup.test.ts). */
function rollup(over: Partial<StepRollup> = {}): StepRollup {
  return {
    trigger: "harness-do",
    statusId: "desenvolver",
    step: "Desenvolver",
    order: 0,
    onPath: true,
    isCurrent: false,
    live: false,
    runs: 1,
    lastRunAt: 1_000_000,
    lastStatus: "ok",
    left: null,
    gate: "ok",
    metrics: { model: "opus", effort: "high", durationMs: 45_000, turns: 3, tokens: 1200, costUSD: 0.12, totalCostUSD: 0.12 },
    capabilities: [],
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return { id: "f1", lens: "general", severity: "blocker", title: "mobile não renderiza", status: "open", ...over } as Finding;
}

describe("composeCardDocument — section order + content", () => {
  it("emits the canonical H1 title", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card({ title: "Ver eventos no feed" }), ctx()));
    expect(md).toContain("# Ver eventos no feed");
  });

  it("composes the agile narrative as a prose sentence using the storyType connectors", () => {
    const c = card({ storyType: "user", narrative: { role: "operador", want: "ver o run state", soThat: "supervisionar sem scroll" } });
    const md = cardDocumentMarkdown(composeCardDocument(c, ctx()));
    expect(md).toContain("Como operador, quero ver o run state, para supervisionar sem scroll.");
  });

  it("renders strategic context as a blockquote meta block", () => {
    const md = cardDocumentMarkdown(
      composeCardDocument(
        card(),
        ctx({
          strategic: {
            // A forma que `prdDigest` entrega: uma linha `Rótulo: texto` por seção do PRD.
            norte: [
              "Posicionamento: a ferramenta de produto",
              "Resultado-alvo: ativar 50% dos boards",
              "Métrica de negócio: ARR",
            ],
            idea: { statement: "o modal mistura run state com spec", statusName: "validando" },
            personas: ["Operador", "Orquestrador"],
            systems: ["UI"],
            runPolicy: { skill: "harness-review", model: "opus", effort: "high", maxTurns: 40 },
          },
        }),
      ),
    );
    expect(md).toContain("> **Posicionamento** — a ferramenta de produto");
    expect(md).toContain("> **Métrica de negócio** — ARR");
    expect(md).toContain("> **Resultado-alvo** — ativar 50% dos boards");
    expect(md).toContain("> **Ideia** — o modal mistura run state com spec _(validando)_");
    expect(md).toContain("> **Personas** — Operador, Orquestrador");
    expect(md).toContain("> **Run** — harness-review · opus · high · 40 turns");
    // Cada linha é seu PRÓPRIO parágrafo dentro da citação: sem o `>` vazio entre elas o markdown
    // aplica continuação preguiçosa e Posicionamento/Resultado-alvo/Métrica viram um paredão só.
    expect(md).toContain("> **Posicionamento** — a ferramenta de produto\n>\n> **Resultado-alvo** — ativar 50% dos boards");
  });

  it("renders acceptance as an UNCHECKED GFM checklist until QA passes", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card({ acceptance: ["a view exibe run state", "Editar alterna pra spec"] }), ctx()));
    expect(md).toContain("## Critérios de aceite");
    expect(md).toContain("- [ ] a view exibe run state");
    expect(md).toContain("- [ ] Editar alterna pra spec");
  });

  it("checks the acceptance list once qaPassed is true", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card({ acceptance: ["critério único"], qaPassed: true }), ctx()));
    expect(md).toContain("- [x] critério único");
  });

  it("renders the free body markdown as-is (its own headings survive)", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card({ body: "## Contexto & valor\nO modal mistura run state…" }), ctx()));
    expect(md).toContain("## Contexto & valor");
    expect(md).toContain("O modal mistura run state…");
  });

  it("renders the prioritization as one compact line", () => {
    const md = cardDocumentMarkdown(
      composeCardDocument(card({ rice: { reach: 100, impact: 2, confidence: 0.8, effort: 2 }, kano: "must-be", funnelStage: "retention" }), ctx()),
    );
    expect(md).toContain("## Priorização");
    expect(md).toMatch(/\*\*RICE [\d.,]+\*\* \(R 100 · I 2 · C 0\.8 · E 2\)/);
    expect(md).toContain("KANO:");
    expect(md).toContain("Funil:");
  });

  it("flags the live run in the history with ▸ agora", () => {
    const md = cardDocumentMarkdown(
      composeCardDocument(
        card(),
        ctx({
          rollups: [
            rollup({ trigger: "harness-review", step: "Revisão de código", live: true, runs: 0, lastRunAt: null, lastStatus: null, left: "1 bloqueador", gate: "blocked" }),
            rollup({ trigger: "harness-qa", step: "QA automatizado", left: "QA aprovado", lastStatus: "ok", gate: "ok" }),
          ],
        }),
      ),
    );
    expect(md).toContain("## Histórico");
    // the live run is highlighted with ▸ agora + its field signal, never a date
    expect(md).toContain("**▸ agora** · Revisão de código · rodando — 1 bloqueador");
    // a settled step: step · what it left · outcome (date asserted loosely — it's locale/timezone-bound)
    expect(md).toContain("QA automatizado · QA aprovado · ok");
  });

  it("renders each ran step as Quando · Step · Deixou · Status, with a runs count and no empty Deixou", () => {
    const md = cardDocumentMarkdown(
      composeCardDocument(
        card(),
        ctx({
          rollups: [
            rollup({ trigger: "harness-do", step: "Desenvolver", left: "commit a1b2c", lastStatus: "ok", runs: 2 }),
            rollup({ trigger: "harness-plan", step: "Plano técnico", left: null, lastStatus: "ok", runs: 1 }),
          ],
        }),
      ),
    );
    // what the step LEFT sits between the step and its status
    expect(md).toContain("Desenvolver (2 runs) · commit a1b2c · ok");
    // a step with nothing to show collapses the Deixou segment (no `·  ·` gap)
    expect(md).toContain("Plano técnico · ok");
    expect(md).not.toContain("Plano técnico ·  · ok");
  });

  it("omits the Histórico section entirely when no step has run", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card({ body: "algo" }), ctx({ rollups: [rollup({ runs: 0, live: false, lastRunAt: null, lastStatus: null })] })));
    expect(md).not.toContain("## Histórico");
  });

  it("keeps the canonical order: aceite/corpo → notas → bloqueios → priorização", () => {
    const c = card({
      acceptance: ["crit"],
      body: "corpo",
      findings: [finding()],
      rice: { reach: 1, impact: 1, confidence: 1, effort: 1 },
    });
    const md = cardDocumentMarkdown(composeCardDocument(c, ctx({ plan: "passo 1" })));
    const iAceite = md.indexOf("Critérios de aceite");
    const iNotas = md.indexOf("Notas de execução");
    const iBloq = md.indexOf("Bloqueios");
    const iPrior = md.indexOf("Priorização");
    expect(iAceite).toBeGreaterThanOrEqual(0);
    expect(iAceite).toBeLessThan(iNotas);
    expect(iNotas).toBeLessThan(iBloq);
    expect(iBloq).toBeLessThan(iPrior);
  });
});

describe("blockers", () => {
  it("openFindings keeps only OPEN, well-formed findings", () => {
    const all: Finding[] = [
      finding({ id: "f1", status: "open", title: "real" }),
      finding({ id: "f2", status: "fixed", title: "resolvido" }),
      finding({ id: "f3", status: "open", title: "   " }), // titleless → dropped (gate parity)
    ];
    expect(openFindings(all).map((f) => f.id)).toEqual(["f1"]);
  });

  it("emits the Bloqueios section only when there's an open well-formed finding", () => {
    const withOpen = cardDocumentMarkdown(composeCardDocument(card({ findings: [finding()] }), ctx()));
    expect(withOpen).toContain("## Bloqueios");
    const noOpen = cardDocumentMarkdown(composeCardDocument(card({ findings: [finding({ status: "fixed" })] }), ctx()));
    expect(noOpen).not.toContain("## Bloqueios");
  });

  it("renders each open blocker as a single readable line", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card({ findings: [finding({ title: "run state some no mobile" })] }), ctx()));
    expect(md).toContain("- 🔴 run state some no mobile _(blocker, aberto)_");
  });

  it("splitFindingsBySeverity (4.4): real blockers vs soft advisories, both open-only, order preserved", () => {
    const all: Finding[] = [
      finding({ id: "b1", status: "open", severity: "blocker", title: "quebra" }),
      finding({ id: "a1", status: "open", severity: "low", title: "tooling-unused" }),
      finding({ id: "a2", status: "open", severity: "medium", title: "route-undersized" }),
      finding({ id: "closed", status: "fixed", severity: "blocker", title: "resolvido" }), // dropped (not open)
      finding({ id: "a3", status: "open", severity: "high", title: "loop-guard" }),
    ];
    const { blockers, advisories } = splitFindingsBySeverity(all);
    expect(blockers.map((f) => f.id)).toEqual(["b1"]);
    expect(advisories.map((f) => f.id)).toEqual(["a1", "a2", "a3"]); // high/medium/low, closed excluded
  });

  it("triaged: o RASTRO — findings com desfecho voltam como registro, fora dos baldes de trabalho", () => {
    // Sem isto, um aviso triado pelo Autônomo simplesmente SOME do card: a única prova de que houve decisão
    // seria a ausência dela, e "o humano supervisiona" viraria promessa não-verificável.
    const all = [
      finding({ id: "f1", status: "open", severity: "blocker", title: "trava" }),
      finding({ id: "f2", status: "open", severity: "low", title: "aviso" }),
      finding({ id: "f3", status: "acknowledged", severity: "medium", title: "conhecido" }),
      finding({ id: "f4", status: "fixed", severity: "blocker", title: "resolvido" }),
      finding({ id: "f5", status: "wontfix", severity: "low", title: "não corrige" }),
      finding({ id: "f6", status: "acknowledged", severity: "low", title: "" }), // mal-formado ⇒ fora
    ];
    const { blockers, advisories, triaged } = splitFindingsBySeverity(all);
    // os baldes de TRABALHO seguem open-only, byte-idênticos ao contrato de sempre
    expect(blockers.map((f) => f.id)).toEqual(["f1"]);
    expect(advisories.map((f) => f.id)).toEqual(["f2"]);
    // e o registro traz os triados BEM-FORMADOS, de qualquer severity, em ordem
    expect(triaged.map((f) => f.id)).toEqual(["f3", "f4", "f5"]);
  });

  it("splitFindingsBySeverity: all-advisory set → empty blockers (no 'Bloqueios' section would render)", () => {
    const { blockers, advisories } = splitFindingsBySeverity([finding({ status: "open", severity: "low", title: "x" })]);
    expect(blockers).toEqual([]);
    expect(advisories).toHaveLength(1);
  });

  it("terminal=true: a residual MECHANISM blocker leaves the active `blockers` bucket and becomes inert `triaged`", () => {
    const all: Finding[] = [
      finding({ id: "code-not-landed-r1", status: "open", severity: "blocker", title: "código não aterrissou" }),
      finding({ id: "b1", status: "open", severity: "blocker", title: "trava real" }), // non-mechanism → stays live
    ];
    // active card: both are live blockers (default, byte-identical to before)
    expect(splitFindingsBySeverity(all).blockers.map((f) => f.id)).toEqual(["code-not-landed-r1", "b1"]);
    // terminal card: the stale mechanism blocker drops from the WORK bucket and surfaces as an inert record
    const term = splitFindingsBySeverity(all, { terminal: true });
    expect(term.blockers.map((f) => f.id)).toEqual(["b1"]);
    expect(term.triaged.map((f) => f.id)).toContain("code-not-landed-r1");
  });
});

describe("wireframe figures", () => {
  function wf(over: Partial<WireframeDoc> = {}): WireframeDoc {
    return {
      cardId: "story-abc123",
      status: "draft",
      chosenOptionId: null,
      generatedBy: "harness-ux",
      updated: null,
      journey: { format: "ascii", flow: "abre ▸ vê run ▸ edita", narrative: "o operador entra e supervisiona", generatedBy: "harness-ux", updated: null },
      options: [
        { id: "o1", label: "Coluna única", direction: "on-brand", rationale: "", format: "ascii", viewport: "mobile", state: "populated", heightHint: null, content: "[ topo ]\n[ doc  ]" },
      ],
      artifacts: [],
      feedback: [],
      ...over,
    };
  }

  it("renders the journey + screens as ```ascii fences inline", () => {
    const md = cardDocumentMarkdown(composeCardDocument(card(), ctx({ wireframe: wf() })));
    expect(md).toContain("## Jornada");
    expect(md).toContain("o operador entra e supervisiona");
    expect(md).toContain("```ascii\nabre ▸ vê run ▸ edita\n```");
    expect(md).toContain("## Telas");
    expect(md).toContain("**Coluna única · mobile · populated**");
    expect(md).toContain("```ascii\n[ topo ]\n[ doc  ]\n```");
  });

  it("orders the chosen option first", () => {
    const doc = wf({
      chosenOptionId: "o2",
      options: [
        { id: "o1", label: "A", direction: "on-brand", rationale: "", format: "ascii", viewport: "mobile", state: "populated", heightHint: null, content: "a" },
        { id: "o2", label: "B", direction: "fresh-slate", rationale: "", format: "ascii", viewport: "mobile", state: "populated", heightHint: null, content: "b" },
      ],
    });
    expect(orderedWireframeOptions(doc).map((o) => o.id)).toEqual(["o2", "o1"]);
  });

  it("skips HTML-format legacy options (no iframe) but mirrors the legacy note for parity", () => {
    const doc = wf({
      options: [{ id: "o1", label: "HTML", direction: "on-brand", rationale: "", format: "html", viewport: "mobile", state: "populated", heightHint: null, content: "<div>x</div>" }],
      journey: null,
    });
    const md = cardDocumentMarkdown(composeCardDocument(card(), ctx({ wireframe: doc })));
    expect(md).not.toContain("<div>x</div>"); // the iframe/XSS surface is gone
    expect(md).toContain("HTML legado"); // but the note IS emitted (drawer ≡ markdown invariant)
  });

  it("emits mermaid options as ```ascii fences too (parity with the live AsciiFigure render)", () => {
    const doc = wf({
      journey: { format: "mermaid", flow: "graph TD; A-->B", narrative: "", generatedBy: "harness-ux", updated: null },
      options: [{ id: "o1", label: "Diag", direction: "on-brand", rationale: "", format: "mermaid", viewport: "mobile", state: "populated", heightHint: null, content: "graph TD; X-->Y" }],
    });
    const md = cardDocumentMarkdown(composeCardDocument(card(), ctx({ wireframe: doc })));
    // both the journey flow and the mermaid option render as ```ascii (no Mermaid lib — ASCII-only),
    // so the string projection matches the live InlineWireframes (which routes both through AsciiFigure).
    expect(md).toContain("```ascii\ngraph TD; A-->B\n```");
    expect(md).toContain("```ascii\ngraph TD; X-->Y\n```");
    expect(md).not.toContain("```text");
  });

  it("renders an artifacts-only canvas: sections per kind, primary ✓, notes, feedback thread", () => {
    const doc = wf({
      options: [],
      chosenOptionId: "tela-1",
      artifacts: [
        { id: "tela-1", kind: "screen", title: "Agenda por dia", note: "reusa AgendaTimeline", format: "text", viewport: "mobile", state: "populated", content: "[ agenda ]" },
        { id: "comp-1", kind: "component", title: "Card de evento", note: "", format: "text", viewport: "mobile", state: null, content: "[ card ]" },
      ],
      feedback: [
        { id: "fb1", artifactId: "tela-1", kind: "approve", note: "aprovado", by: "human", at: "2026-07-22", resolvedAt: "2026-07-22" },
        { id: "fb2", artifactId: "fantasma", kind: "change", note: "não some comigo", by: "human", at: null, resolvedAt: null },
      ],
    });
    const md = cardDocumentMarkdown(composeCardDocument(card(), ctx({ wireframe: doc })));
    expect(md).toContain("## Telas");
    expect(md).toContain("**Agenda por dia · mobile · populated ✓**");
    expect(md).toContain("## Componentes");
    expect(md).toContain("_reusa AgendaTimeline_");
    expect(md).toContain("## Feedback de design");
    expect(md).toContain("aprovado");
    // a dangling artifactId is KEPT and rendered as canvas-wide ("geral") — never dropped
    expect(md).toContain("**geral** — não some comigo");
  });

  it("an html artifact projects ONLY its htmlToText outline — raw markup never reaches the markdown", () => {
    const doc = wf({
      options: [],
      journey: null,
      artifacts: [
        { id: "a1", kind: "screen", title: "Tela rica", note: "", format: "html", viewport: "mobile", state: "populated", html: "<div class=\"x\"><h2>Agenda</h2></div>", content: "Agenda" },
      ],
    });
    const md = cardDocumentMarkdown(composeCardDocument(card(), ctx({ wireframe: doc })));
    expect(md).toContain("Agenda");
    expect(md).not.toContain("<div");
    expect(md).not.toContain("</");
  });
});

describe("empty handling", () => {
  it("an utterly blank card projects to an empty document", () => {
    const blocks = composeCardDocument(card({ title: "" }), ctx());
    // only the H1 placeholder — but no spec/body/artifacts
    const md = cardDocumentMarkdown(blocks);
    expect(md).toContain("(sem título)");
    expect(md).not.toContain("## ");
  });

  it("cardDocumentIsEmpty is false once any content exists", () => {
    expect(cardDocumentIsEmpty(composeCardDocument(card({ body: "algo" }), ctx()))).toBe(false);
  });
});
