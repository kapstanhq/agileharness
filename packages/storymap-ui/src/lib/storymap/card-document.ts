// card-document.ts — the card as a LIVING MARKDOWN DOCUMENT (the read surface).
//
// A card lives across four storage surfaces (frontmatter = gate routing, body = prose,
// sidecars = heavy, telemetry = run ledger). The READ view used to stack four mismatched
// widgets; this module is the single, faithful PROJECTION that assembles them into ONE
// cohesive markdown document in canonical order — so opening a card reads as a document,
// not a form. Storage stays structured; the READ is a pure projection of it.
//
// PURE: no React, no node:fs — so the boundary logic (section order, what renders, the
// markdown string) is node-unit-testable and the components are thin consumers. The
// React layer (CardDocument.tsx) maps the block list to components (Markdown / inline
// wireframes / inline blockers); cardDocumentMarkdown() flattens the SAME blocks to a
// plain string (for "copiar como markdown" + the tests), so the two projections never
// drift: the rendered drawer ≡ the markdown ≡ the source of truth.

import { formatRiceScore, riceScore } from "./rice";
import { KANO_BY_ID, FUNNEL_BY_ID, STORY_TYPE_BY_ID } from "./frameworks";
import { runStatusLabel, type StepRollup } from "./step-rollup";
import { isMechanismBlockerId } from "./runner/findings";
import { canvasWideFeedback, hasCanvasContent, JOURNEY_FEEDBACK_ID, orderedCanvasArtifacts } from "./design-canvas";
import type { Card, DesignArtifact, Finding, Rice, WireframeDoc, WireframeOption } from "./types";

/** The effective run policy of the card's CURRENT status (skill + spawn knobs), resolved from its StatusDef. */
export interface CardDocRunPolicy {
  /** the skill (trigger id) that processes this status, e.g. "harness-review" */
  skill: string;
  model: string | null;
  effort: string | null;
  maxTurns: number | null;
}

/** Strategic context (resolved by the caller) shown at the head of the document. */
export interface CardDocStrategic {
  /**
   * O norte do produto, uma linha por seção, já rotulado — o digest do PRD (`prdDigest`).
   *
   * Eram três campos separados lidos do `board.yaml`. Viraram um porque a fonte virou uma: o card
   * não decide QUAIS seções do PRD orientam uma decisão, o digest decide — e assim uma seção nova
   * que passe a orientar aparece aqui sem ninguém editar este arquivo.
   */
  norte: string[];
  /** the idea this card addresses (resolved via getAddressedIdea), or null */
  idea: { statement: string; statusName: string | null } | null;
  /** resolved persona display names (board vocab) */
  personas: string[];
  /** resolved system display names (board vocab) */
  systems: string[];
  /** the current status' run policy (skill/model/effort/turns) — transparency of what the next autorun spends. */
  runPolicy: CardDocRunPolicy | null;
}

/** Everything the projection needs beyond the card itself (resolved by the caller). */
export interface CardDocContext {
  strategic: CardDocStrategic;
  /** technical plan markdown (plans/<id>.md), or null */
  plan: string | null;
  /** wireframe sidecar (journey + options), or null */
  wireframe: WireframeDoc | null;
  /** per-step execution rollup (computeStepRollups) — folds the run ledger + the card's fields into
   *  the `## Histórico` table (the steps that ran) and would feed the closed-card stage trail. */
  rollups: StepRollup[];
}

/**
 * One block of the rendered document, in canonical order. Most are `prose` (plain markdown
 * rendered richly); `wireframe`/`blockers` are the two blocks that need interactivity
 * (choose a frame / resolve a finding), so they're React components, not markdown.
 */
export type CardDocBlock =
  | { kind: "prose"; md: string }
  | { kind: "wireframe"; doc: WireframeDoc }
  | { kind: "blockers"; findings: Finding[] }
  | { kind: "stage-history"; rollups: StepRollup[] };

// ── formatting helpers (pure) ────────────────────────────────────────────────

const num = (v: number | null): string => (v == null ? "—" : String(v));

/** Escape a value used INSIDE a markdown paragraph so it can't accidentally start a block. */
function inlineText(s: string): string {
  return s.replace(/\r/g, "").trim();
}

// ── section builders (each returns markdown, or "" when it has nothing) ───────

/** Title (H1) + the three-part agile narrative as a prose sentence + strategic meta block. */
function headProse(card: Card, ctx: CardDocContext): string {
  const out: string[] = [];
  out.push(`# ${inlineText(card.title || "") || "(sem título)"}`);

  const conn = card.storyType ? STORY_TYPE_BY_ID[card.storyType]?.connectors : null;
  const n = card.narrative ?? { role: null, want: null, soThat: null };
  if (conn && (n.role || n.want || n.soThat)) {
    const sentence = [
      n.role ? `${conn.role} ${inlineText(n.role)}` : null,
      n.want ? `${conn.want} ${inlineText(n.want)}` : null,
      n.soThat ? `${conn.soThat} ${inlineText(n.soThat)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (sentence) out.push(`${sentence}.`);
  }

  const meta = strategicLines(ctx.strategic);
  // UMA linha por PARÁGRAFO dentro da citação (`>\n>` entre elas). Juntá-las só com "\n" fazia o
  // markdown aplicar continuação preguiçosa e colar Posicionamento + Resultado-alvo + Métrica num
  // único parágrafo — o paredão de texto que abria todo card.
  if (meta.length) out.push(meta.map((l) => `> ${l}`).join("\n>\n"));

  return out.join("\n\n");
}

/** The strategic-context lines (positioning ladder + idea + personas/systems). */
function strategicLines(s: CardDocStrategic): string[] {
  const lines: string[] = [];
  for (const linha of s.norte) {
    // `Rótulo: texto` (a forma do digest) → `**Rótulo** — texto` (a forma do documento). Uma linha
    // sem rótulo entra inteira, em vez de sumir.
    const corte = linha.indexOf(":");
    if (corte > 0) lines.push(`**${linha.slice(0, corte).trim()}** — ${inlineText(linha.slice(corte + 1))}`);
    else if (linha.trim()) lines.push(inlineText(linha));
  }
  if (s.idea?.statement?.trim()) {
    const status = s.idea.statusName ? ` _(${s.idea.statusName})_` : "";
    lines.push(`**Ideia** — ${inlineText(s.idea.statement)}${status}`);
  }
  if (s.personas.length) lines.push(`**Personas** — ${s.personas.join(", ")}`);
  if (s.systems.length) lines.push(`**Sistemas** — ${s.systems.join(", ")}`);
  if (s.runPolicy) {
    const p = s.runPolicy;
    const policy = [p.skill, p.model, p.effort, p.maxTurns != null ? `${p.maxTurns} turns` : null]
      .filter(Boolean)
      .join(" · ");
    if (policy) lines.push(`**Run** — ${policy}`);
  }
  return lines;
}

/** Acceptance criteria as a GFM checklist; checked ⇔ QA proved them (qaPassed). */
function acceptanceProse(card: Card): string {
  const items = (card.acceptance ?? []).map((a) => inlineText(a)).filter(Boolean);
  if (!items.length) return "";
  const mark = card.qaPassed === true ? "x" : " ";
  const list = items.map((a) => `- [${mark}] ${a}`).join("\n");
  return `## Critérios de aceite\n\n${list}`;
}

/** The free markdown body (enrich/interview/review/qa prose) — rendered AS-IS (it carries
 *  its own `##` headings). The single biggest win: rich markdown instead of raw mono text. */
function bodyProse(card: Card): string {
  const body = (card.body ?? "").replace(/\r/g, "").trim();
  return body;
}

/** The technical plan (plans/<id>.md) under a canonical heading. */
function notasProse(ctx: CardDocContext): string {
  const plan = (ctx.plan ?? "").trim();
  if (!plan) return "";
  return `## Notas de execução\n\n${plan}`;
}

/** Priorização as ONE compact meta line: RICE score + inputs · KANO · funil. */
function prioritizationProse(card: Card): string {
  const bits: string[] = [];
  const score = formatRiceScore(riceScore(card.rice));
  if (score != null) {
    const r: Rice = card.rice;
    bits.push(`**RICE ${score}** (R ${num(r.reach)} · I ${num(r.impact)} · C ${num(r.confidence)} · E ${num(r.effort)})`);
  }
  if (card.kano) bits.push(`KANO: ${KANO_BY_ID[card.kano]?.name ?? card.kano}`);
  if (card.funnelStage) bits.push(`Funil: ${FUNNEL_BY_ID[card.funnelStage]?.name ?? card.funnelStage}`);
  if (!bits.length) return "";
  return `## Priorização\n\n${bits.join(" · ")}`;
}

/** Locale-aware date-time for a history row (pt-BR dd/mm hh:mm). Pure (React-free). */
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** `## Histórico` — the per-step rollup flattened to a list (mirrors the StageTable: the steps that
 *  ran, the live one highlighted), so the markdown projection ≡ the rendered table. */
function stageHistoryMarkdown(rollups: StepRollup[]): string {
  const rows = rollups.filter((r) => r.runs > 0 || r.live);
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    if (r.live) {
      const left = r.left?.trim() ? ` — ${inlineText(r.left)}` : "";
      return `- **▸ agora** · ${r.step} · rodando${left}`;
    }
    const step = r.runs > 1 ? `${r.step} (${r.runs} runs)` : r.step;
    const parts = [
      r.lastRunAt != null ? fmtDateTime(r.lastRunAt) : null,
      step,
      r.left?.trim() ? inlineText(r.left) : null,
      runStatusLabel(r.lastStatus),
    ].filter(Boolean);
    return `- ${parts.join(" · ")}`;
  });
  return `## Histórico\n\n${lines.join("\n")}`;
}

// ── wireframe → markdown (used by cardDocumentMarkdown + mirrored by InlineWireframes) ──

/** Pick the wireframe options to render in the document (the chosen one first, then the rest). */
export function orderedWireframeOptions(doc: WireframeDoc): WireframeOption[] {
  const chosen = doc.chosenOptionId ? doc.options.filter((o) => o.id === doc.chosenOptionId) : [];
  const rest = doc.options.filter((o) => o.id !== doc.chosenOptionId);
  return [...chosen, ...rest];
}

/** The shared note for legacy HTML-format wireframes — not rendered on the ASCII-only read surface
 *  (the iframe was dropped, with it the XSS surface). Mirrored by InlineWireframes so the two
 *  projections agree (the rendered drawer ≡ the markdown string). */
export function legacyHtmlWireframeNote(count: number): string {
  return `_${count} wireframe${count > 1 ? "s" : ""} HTML legado — não renderizado nesta superfície ASCII-only; rode /harness-ux para regerar em ASCII._`;
}

/** Section heading per artifact kind (screens keep the historic "## Telas"). */
const ARTIFACT_SECTION: Record<DesignArtifact["kind"], string> = {
  screen: "## Telas",
  component: "## Componentes",
  flow: "## Fluxos",
  note: "## Notas de design",
};

/**
 * Flatten a wireframe block to markdown, via the SAME canvas selector the live surfaces use
 * (orderedCanvasArtifacts — authored artifacts, else the in-memory legacy-options bridge), so the
 * markdown projection and the rendered drawer stay identical. Every artifact renders its
 * code-derived `content` projection in a ` ```ascii ` fence — raw html NEVER reaches this string
 * (html artifacts project through htmlToText at coerce time; locked by card-document.test.ts).
 */
function wireframeMarkdown(doc: WireframeDoc): string {
  const out: string[] = [];
  if (doc.journey && (doc.journey.flow.trim() || doc.journey.narrative.trim())) {
    out.push("## Jornada");
    if (doc.journey.narrative.trim()) out.push(inlineText(doc.journey.narrative));
    if (doc.journey.flow.trim()) {
      out.push("```ascii\n" + doc.journey.flow.replace(/\r/g, "").trimEnd() + "\n```");
    }
  }
  const arts = orderedCanvasArtifacts(doc);
  let section = "";
  for (const a of arts) {
    if (!a.content.trim() && !a.note.trim()) continue;
    if (ARTIFACT_SECTION[a.kind] !== section) {
      section = ARTIFACT_SECTION[a.kind];
      out.push(section);
    }
    const caption = [a.title, a.viewport, a.state].filter(Boolean).join(" · ");
    const chosen = doc.chosenOptionId === a.id ? " ✓" : "";
    out.push(`**${caption}${chosen}**`);
    if (a.content.trim()) out.push("```ascii\n" + a.content.replace(/\r/g, "").trimEnd() + "\n```");
    if (a.note.trim() && doc.artifacts.length) out.push(`_${inlineText(a.note)}_`);
  }
  // The human feedback thread (per-artifact + canvas-wide) — same content the drawer shows.
  if (doc.feedback.length) {
    out.push("## Feedback de design");
    const title = new Map(arts.map((a) => [a.id, a.title]));
    const wide = new Set(canvasWideFeedback(doc).map((f) => f.id));
    for (const f of doc.feedback) {
      const target =
        f.artifactId === JOURNEY_FEEDBACK_ID
          ? "jornada"
          : f.artifactId != null && !wide.has(f.id)
            ? title.get(f.artifactId) ?? f.artifactId
            : "geral";
      const mark = f.kind === "approve" ? "✓" : f.resolvedAt ? "✔" : "→";
      out.push(`- ${mark} **${target}** — ${inlineText(f.note)}${f.at ? ` _(${f.by}, ${f.at})_` : ` _(${f.by})_`}`);
    }
  }
  // Legacy html-only docs render nothing but the note in the drawer — mirror it here for parity.
  const htmlCount = doc.options.filter((o) => o.format === "html").length;
  if (htmlCount > 0 && arts.length === 0) out.push(legacyHtmlWireframeNote(htmlCount));
  return out.join("\n\n");
}

/** Flatten the blockers block to markdown (one readable line per OPEN finding). */
function blockersMarkdown(findings: Finding[]): string {
  const open = (findings ?? []).filter((f) => f.status === "open" && hasTitle(f));
  if (!open.length) return "";
  const lines = open.map((f) => {
    const sev = f.severity === "blocker" ? "🔴" : "•";
    return `- ${sev} ${inlineText(f.title)} _(${f.severity}, aberto)_`;
  });
  return `## Bloqueios\n\n${lines.join("\n")}`;
}

/** A finding only counts when WELL-FORMED — same rule as the hasNoBlockers gate (gate-core.js). */
function hasTitle(f: Finding): boolean {
  return f != null && f.title != null && String(f.title).trim() !== "";
}

/** Open findings (well-formed) for the interactive inline-blockers section. */
export function openFindings(findings: Finding[]): Finding[] {
  return (findings ?? []).filter((f) => f.status === "open" && hasTitle(f));
}

/**
 * Fase 4.4 — split open findings into real BLOCKERS (`severity: "blocker"` — held out of QA by the
 * hasNoBlockers gate) and soft ADVISORIES (high/medium/low — e.g. `tooling-unused`, `route-undersized`, which
 * are NEVER gate-blocking). PURELY presentational: the gate is enforced in gate-core.js off
 * `severity === "blocker"` regardless — this just lets the panel label a blocker as a "Bloqueio" and an
 * advisory as an "Aviso" instead of calling everything a blocker. Preserves order within each bucket.
 *
 * `triaged` (well-formed, status ≠ open) é o TERCEIRO balde — e a razão dele é a supervisão. `blockers` e
 * `advisories` seguem OPEN-ONLY, byte-idênticos ao que sempre foram (é o TRABALHO: o que ainda espera alguém).
 * Mas um finding triado simplesmente DESAPARECIA do card, e isso deixou de ser aceitável quando o Autônomo
 * passou a triar sozinho: se o agente decide 6 avisos e os 6 somem sem deixar rastro, o humano não tem o que
 * supervisionar — a única prova de que houve decisão seria a ausência dela. Aqui eles voltam como REGISTRO
 * (inerte, sem botões, com quem/quando), separados do trabalho justamente para não se confundirem com ele.
 * Ordem preservada dentro de cada balde.
 */
export function splitFindingsBySeverity(
  findings: Finding[],
  opts?: { terminal?: boolean },
): {
  blockers: Finding[];
  advisories: Finding[];
  triaged: Finding[];
} {
  const open = openFindings(findings);
  // Num card TERMINAL um blocker de MECHANISM residual (code/data-not-landed, merge-back) é STALE — foi (ou
  // seria) supersedido na entrada do terminal; aqui ele sai do balde ATIVO `blockers` e vira REGISTRO inerte
  // em `triaged`, para nunca pintar um card arquivado como bloqueado (o backstop de display do mesmo invariante
  // do selo "Bloqueio"; cobre inclusive a rota harness-retire, que arquiva gravando o .md direto, sem chokepoint).
  const staleTerminal = (f: Finding) => opts?.terminal === true && isMechanismBlockerId(f.id);
  return {
    blockers: open.filter((f) => f.severity === "blocker" && !staleTerminal(f)),
    advisories: open.filter((f) => f.severity !== "blocker"),
    triaged: (findings ?? []).filter((f) => (f.status !== "open" || staleTerminal(f)) && hasTitle(f)),
  };
}

// ── the projection ────────────────────────────────────────────────────────────

/**
 * Assemble the canonical document blocks for a card. Order (report §5):
 *   1. Título + narrativa  2. (contexto estratégico)  3. Critérios de aceite  + corpo livre
 *   4. Jornada + Telas (figuras)  5. Notas de execução  6. Bloqueios  7. Priorização  8. Histórico
 * Empty sections are omitted (a faithful, complete projection of what EXISTS — nothing hidden,
 * nothing padded). The wireframe/blockers blocks are emitted only when they carry content.
 */
export function composeCardDocument(card: Card, ctx: CardDocContext): CardDocBlock[] {
  const blocks: CardDocBlock[] = [];

  // 1–3 + free body — the prose head.
  const head = [headProse(card, ctx), acceptanceProse(card), bodyProse(card)].filter(Boolean).join("\n\n");
  if (head.trim()) blocks.push({ kind: "prose", md: head });

  // 4 — journey + design canvas (journey, legacy options, or canvas artifacts).
  if (ctx.wireframe && (ctx.wireframe.journey != null || hasCanvasContent(ctx.wireframe))) {
    blocks.push({ kind: "wireframe", doc: ctx.wireframe });
  }

  // 5 — execution notes (the technical plan).
  const notas = notasProse(ctx);
  if (notas) blocks.push({ kind: "prose", md: notas });

  // 6 — findings (interactive p/ os abertos, registro p/ os triados). Qualquer finding BEM-FORMADO abre o
  // bloco: era `openFindings(...) > 0`, e a diferença aparece exatamente no caso que importa agora — o card
  // cujos findings o Autônomo JÁ triou. Sob a régua antiga, esse card não renderizava bloco nenhum, e a
  // supervisão do humano sobre o que o agente decidiu ficava sem superfície. Ver splitFindingsBySeverity.
  if ((card.findings ?? []).some((f) => f != null && String(f.title ?? "").trim() !== "")) {
    blocks.push({ kind: "blockers", findings: card.findings ?? [] });
  }

  // 7 — prioritization (prose).
  const prioritization = prioritizationProse(card);
  if (prioritization.trim()) blocks.push({ kind: "prose", md: prioritization });

  // 8 — per-step execution history (interactive table). Only when a step ran or one is in flight,
  //     so a never-run card shows no empty section (mirrors the old historyProse "" short-circuit).
  if (ctx.rollups.some((r) => r.runs > 0 || r.live)) {
    blocks.push({ kind: "stage-history", rollups: ctx.rollups });
  }

  return blocks;
}

/**
 * Flatten the blocks to a single markdown string — the SAME content the drawer renders, as a
 * portable artifact (copy-as-markdown) and the test target. The rendered drawer ≡ this string.
 */
export function cardDocumentMarkdown(blocks: CardDocBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "prose") return b.md;
      if (b.kind === "wireframe") return wireframeMarkdown(b.doc);
      if (b.kind === "blockers") return blockersMarkdown(b.findings);
      if (b.kind === "stage-history") return stageHistoryMarkdown(b.rollups);
      return "";
    })
    .filter((s) => s.trim())
    .join("\n\n");
}

/** True when the projection has no content at all — drives the graceful empty state. */
export function cardDocumentIsEmpty(blocks: CardDocBlock[]): boolean {
  return cardDocumentMarkdown(blocks).trim() === "";
}
