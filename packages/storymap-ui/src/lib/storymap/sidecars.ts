// Sidecar IO (Fase C) — heavy pipeline content kept BESIDE the card, never in
// its frontmatter: the technical plan (plans/<id>.md, free markdown) and the
// low-fi wireframe options (wireframes/<id>.json). The card .md keeps only the
// light pointers (techPlanReady, wireframeChosen). SERVER-ONLY (node:fs).
//
// coerceWireframeDoc is pure (no fs) so it's unit-testable on its own.

import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write";
import {
  boardDir,
  bugsDir,
  designDir,
  governanceDir,
  governancePath,
  planPath,
  plansDir,
  proposalPath,
  proposalsDir,
  refineDir,
  retireDir,
  retirePlanPath,
  sanitizeId,
  styleGuideMdPath,
  wireframePath,
  wireframesDir,
} from "./paths";
import { CARD_TYPES } from "./types";
import { isStoryType } from "./frameworks";
import { scheduleBoardDataFlush } from "./runner/board-data-flush";
import type {
  DesignArtifact,
  DesignArtifactFormat,
  DesignArtifactKind,
  DesignFeedbackEntry,
  GovernanceDraft,
  WireframeDirection,
  WireframeDoc,
  WireframeFormat,
  WireframeJourney,
  WireframeOption,
  WireframeRenderState,
  WireframeViewport,
} from "./types";
import type { ProposalDoc, ProposedItem } from "./smart-capture/types";
import { coerceGovernanceDraft } from "./governance";
import { coerceNode, dslToText } from "./wireframe-dsl";
import { coerceGraphToText } from "./flow-graph";
import { htmlToText, MAX_HTML_ARTIFACT_BYTES } from "./wireframe-html";
import { compileStyleGuideMd, parseStyleGuideMd } from "./style-guide";
import type { StyleGuideDoc } from "./style-guide";

const DIRECTIONS: WireframeDirection[] = ["on-brand", "adjacent", "fresh-slate"];
const FORMATS: WireframeFormat[] = ["html", "ascii", "mermaid", "dsl"];
const VIEWPORTS: WireframeViewport[] = ["mobile", "desktop"];
const STATES: WireframeRenderState[] = ["populated", "empty", "loading", "error"];

function pick<T>(allowed: T[], v: unknown, fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function coerceOption(raw: unknown, i: number): WireframeOption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const viewport = pick(VIEWPORTS, o.viewport, "mobile");
  // Format: an explicit value wins; else `dsl` when a tree is present, else `ascii` (never `html` —
  // the old iframe gallery is gone with its XSS surface).
  let format = pick(FORMATS, o.format, o.dsl != null ? "dsl" : "ascii");
  let dsl = format === "dsl" ? coerceNode(o.dsl) : null;
  if (format === "dsl" && dsl == null) format = "ascii"; // an unusable tree degrades to the text path
  // For a dsl option `content` is DERIVED (not authored): regenerate the aligned-text projection from
  // the tree so every text surface (markdown/terminal/copilot/legacy <pre>) stays column-true.
  const content = dsl != null ? dslToText(dsl, { viewport }) : o.content != null ? String(o.content) : "";
  if (!content.trim()) return null; // an option with neither a usable tree nor content is useless
  const h = Number(o.heightHint);
  return {
    id: o.id != null && String(o.id) ? String(o.id) : `opt-${i + 1}`,
    label: o.label != null ? String(o.label) : `Opção ${i + 1}`,
    direction: pick(DIRECTIONS, o.direction, "on-brand"),
    rationale: o.rationale != null ? String(o.rationale) : "",
    format,
    viewport,
    state: pick(STATES, o.state, "populated"),
    heightHint: Number.isFinite(h) && h > 0 ? Math.floor(h) : null,
    content,
    ...(dsl != null ? { dsl } : {}),
  };
}

/** Coerce the raw `journey` block (harness-ux) — null when absent/empty. Pure + tolerant.
 *  For a `graph` journey the flow text is DERIVED (graphToText) BEFORE the emptiness check, so a
 *  graph-only journey (no narrative, no authored flow) is never dropped; coerce issues ride along
 *  so no repair the graph coerce made can hide from any surface. */
function coerceJourney(raw: unknown): WireframeJourney | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const { graph, issues, text } = coerceGraphToText(j.graph);
  const authoredFlow = j.flow != null ? String(j.flow) : "";
  const narrative = j.narrative != null ? String(j.narrative) : "";
  if (!graph && !authoredFlow.trim() && !narrative.trim()) return null; // an empty journey is absent
  const generatedBy = j.generatedBy != null ? String(j.generatedBy) : "harness-ux";
  const updated = j.updated != null ? String(j.updated) : null;
  if (graph) {
    return { format: "graph", flow: text, graph, issues, narrative, generatedBy, updated };
  }
  return {
    format: j.format === "ascii" ? "ascii" : "mermaid",
    flow: authoredFlow,
    narrative,
    generatedBy,
    updated,
  };
}

// --- Design Canvas coercion (Canvas v2) --------------------------------------

const ARTIFACT_KINDS: DesignArtifactKind[] = ["screen", "component", "flow", "note"];
const ARTIFACT_FORMATS: DesignArtifactFormat[] = ["dsl", "html", "graph", "text"];

/** Coerce one canvas artifact. Unlike legacy options (dropped when content is empty), an artifact
 *  is kept whenever it carries ANY substance — dropping one would change the design the human
 *  approves. `content` is always the code-derived safe projection (never authored for
 *  dsl/graph/html), so text surfaces can read every artifact without touching raw html. */
function coerceArtifact(raw: unknown, i: number): DesignArtifact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const authored = (k: string) => (o[k] != null && String(o[k]).trim() ? String(o[k]) : null);
  if (!authored("title") && !authored("note") && !authored("content") && o.dsl == null && o.html == null && o.graph == null) {
    return null; // structurally empty
  }
  const kind = pick(ARTIFACT_KINDS, o.kind, "screen");
  const viewport = pick(VIEWPORTS, o.viewport, "mobile");
  const state = STATES.includes(o.state as WireframeRenderState)
    ? (o.state as WireframeRenderState)
    : kind === "screen"
      ? "populated"
      : null;

  // Format: an explicit value wins; else inferred from the payload that is present. `html` is
  // NEVER inferred — only explicitly authored html enters the sandboxed-iframe path.
  let format = pick(ARTIFACT_FORMATS, o.format, o.dsl != null ? "dsl" : o.graph != null ? "graph" : "text");
  let dsl = format === "dsl" ? coerceNode(o.dsl) : null;
  let html = format === "html" && authored("html") ? String(o.html) : null;
  let graphText = "";
  let graph = null as ReturnType<typeof coerceGraphToText>["graph"];
  if (format === "graph") {
    const g = coerceGraphToText(o.graph);
    graph = g.graph;
    graphText = g.text;
  }
  if (format === "dsl" && dsl == null) format = "text";
  if (format === "graph" && graph == null) format = "text";
  if (format === "html" && html == null) format = "text";
  if (format === "html" && html != null && Buffer.byteLength(html, "utf8") > MAX_HTML_ARTIFACT_BYTES) {
    // Hard cap (enforced here, not just skill prose): oversize html degrades to its text
    // projection — the outline survives, the parse-DoS-sized blob does not.
    format = "text";
  }

  const note = authored("note") ?? "";
  const content =
    format === "dsl"
      ? dslToText(dsl!, { viewport })
      : format === "graph"
        ? graphText
        : format === "html"
          ? htmlToText(html!)
          : authored("content") ?? (authored("html") ? htmlToText(String(o.html)) : note);
  if (format !== "dsl") dsl = null;
  if (format !== "html") html = null;
  if (format !== "graph") graph = null;

  const h = Number(o.heightHint);
  return {
    id: authored("id") ?? `a${i + 1}`,
    kind,
    title: authored("title") ?? `Artefato ${i + 1}`,
    note,
    format,
    viewport,
    state,
    ...(dsl != null ? { dsl } : {}),
    ...(html != null ? { html } : {}),
    ...(graph != null ? { graph } : {}),
    content,
    ...(authored("journeyRef") ? { journeyRef: String(o.journeyRef) } : {}),
    ...(Number.isFinite(h) && h > 0 ? { heightHint: Math.floor(h) } : {}),
  };
}

/** Coerce one feedback entry. A dangling `artifactId` is KEPT — the thread must survive a regen
 *  that re-minted ids (the selector renders it as canvas-wide history, never drops it). */
function coerceFeedbackEntry(raw: unknown, i: number): DesignFeedbackEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const note = o.note != null ? String(o.note).trim() : "";
  if (!note) return null; // feedback IS its note
  return {
    id: o.id != null && String(o.id).trim() ? String(o.id) : `fb${i + 1}`,
    artifactId: o.artifactId != null && String(o.artifactId).trim() ? String(o.artifactId) : null,
    kind: o.kind === "approve" ? "approve" : "change",
    note,
    by: o.by != null && String(o.by).trim() ? String(o.by) : "human",
    at: o.at != null ? String(o.at) : null,
    resolvedAt: o.resolvedAt != null ? String(o.resolvedAt) : null,
  };
}

/** Coerce raw JSON into a WireframeDoc. Pure + tolerant — never throws. Round-trip FIXPOINT:
 *  coercing an already-coerced doc must preserve authored artifacts/feedback/journey.graph in
 *  meaning (derived fields recompute deterministically) — chooseWireframeAction and the feedback
 *  action persist the COERCED doc, so anything this function fails to copy is erased on the next
 *  human action (locked by the round-trip test in wireframe-dsl.test.ts). */
export function coerceWireframeDoc(cardId: string, raw: unknown): WireframeDoc {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const options = Array.isArray(r.options)
    ? r.options.map((o, i) => coerceOption(o, i)).filter((o): o is WireframeOption => o !== null)
    : [];
  const artifacts = Array.isArray(r.artifacts)
    ? r.artifacts.map((a, i) => coerceArtifact(a, i)).filter((a): a is DesignArtifact => a !== null)
    : [];
  const feedback = Array.isArray(r.feedback)
    ? r.feedback.map((f, i) => coerceFeedbackEntry(f, i)).filter((f): f is DesignFeedbackEntry => f !== null)
    : [];
  const wanted = r.chosenOptionId != null ? String(r.chosenOptionId) : null;
  const chosenOptionId =
    wanted &&
    (options.some((o) => o.id === wanted) || artifacts.some((a) => a.kind === "screen" && a.id === wanted))
      ? wanted
      : null;
  return {
    cardId,
    status: chosenOptionId ? "chosen" : "draft",
    chosenOptionId,
    // `harness-ux`, e não uma skill de UX do repositório-alvo: quem escreve este documento é a skill da
    // FERRAMENTA (o próprio `harness-ux/SKILL.md` grava `"generatedBy": "harness-ux"`), e o irmão da linha
    // 102 já usava esse valor. Uma skill do repositório CONSUMIDOR não viaja na extração — atribuir o
    // documento a ela creditaria a autoria a algo que não existe no repositório publicado.
    generatedBy: r.generatedBy != null ? String(r.generatedBy) : "harness-ux",
    updated: r.updated != null ? String(r.updated) : null,
    journey: coerceJourney(r.journey),
    options,
    artifacts,
    feedback,
  };
}

export async function readWireframe(boardId: string, cardId: string): Promise<WireframeDoc | null> {
  try {
    const raw = await fs.readFile(wireframePath(boardId, cardId), "utf8");
    return coerceWireframeDoc(cardId, JSON.parse(raw));
  } catch {
    return null; // no sidecar yet (or unreadable) — treat as absent
  }
}

export async function writeWireframe(boardId: string, doc: WireframeDoc): Promise<void> {
  await fs.mkdir(wireframesDir(boardId), { recursive: true });
  await fs.writeFile(wireframePath(boardId, doc.cardId), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

export async function readPlan(boardId: string, cardId: string): Promise<string | null> {
  try {
    return await fs.readFile(planPath(boardId, cardId), "utf8");
  } catch {
    return null;
  }
}

export async function writePlan(boardId: string, cardId: string, markdown: string): Promise<void> {
  await fs.mkdir(plansDir(boardId), { recursive: true });
  await fs.writeFile(planPath(boardId, cardId), markdown, "utf8");
}

/**
 * Persist a current-state screenshot for a refinement (a `data:image/...;base64`
 * URL → a file under refine/<id>/). Returns the stored filename to put on the
 * card's `refinement.screenshot`, or null when the data URL is absent/invalid.
 */
export async function writeRefineScreenshot(
  boardId: string,
  cardId: string,
  dataUrl: string,
): Promise<string | null> {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
  if (!m) return null;
  const ext = m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1];
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return null;
  await fs.mkdir(refineDir(boardId, cardId), { recursive: true });
  const file = `current.${ext}`;
  await fs.writeFile(path.join(refineDir(boardId, cardId), file), buf);
  return file;
}

/**
 * Persist a broken-state screenshot for a bug report (a `data:image/...;base64`
 * URL → a file under bugs/<id>/). Returns the stored filename to put on the card's
 * `bugReport.screenshot`, or null when the data URL is absent/invalid. Mirrors
 * writeRefineScreenshot — different sidecar dir (bugs/ vs refine/).
 */
export async function writeBugScreenshot(
  boardId: string,
  cardId: string,
  dataUrl: string,
): Promise<string | null> {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
  if (!m) return null;
  const ext = m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1];
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return null;
  await fs.mkdir(bugsDir(boardId, cardId), { recursive: true });
  const file = `current.${ext}`;
  await fs.writeFile(path.join(bugsDir(boardId, cardId), file), buf);
  return file;
}

/**
 * Persist MULTIPLE context screenshots for a captured bug (story-cl1mi9). Writes each
 * `data:image/...;base64` URL to bugs/<id>/context-N.<ext> and returns the stored filenames
 * (skipping absent/invalid/empty entries). Distinct from writeBugScreenshot's single
 * `current.<ext>` so the reopen flow (one screenshot) and the capture flow (many) never
 * collide in the sidecar dir. Empty/all-invalid in → [] out (no dir created).
 */
export async function writeBugScreenshots(
  boardId: string,
  cardId: string,
  dataUrls: string[],
): Promise<string[]> {
  const decoded: { file: string; buf: Buffer }[] = [];
  for (const dataUrl of dataUrls ?? []) {
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
    if (!m) continue;
    const ext = m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1];
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length) continue;
    decoded.push({ file: `context-${decoded.length + 1}.${ext}`, buf });
  }
  if (!decoded.length) return [];
  await fs.mkdir(bugsDir(boardId, cardId), { recursive: true });
  await Promise.all(
    decoded.map(({ file, buf }) => fs.writeFile(path.join(bugsDir(boardId, cardId), file), buf)),
  );
  return decoded.map((d) => d.file);
}

/**
 * Persist a current-state screenshot for a retirement (a `data:image/...;base64`
 * URL → a file under retire/<id>/). Returns the stored filename to put on the card's
 * `retirement.screenshot`, or null when the data URL is absent/invalid. Mirrors
 * writeRefineScreenshot — different sidecar dir (retire/ vs refine/).
 */
export async function writeRetireScreenshot(
  boardId: string,
  cardId: string,
  dataUrl: string,
): Promise<string | null> {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
  if (!m) return null;
  const ext = m[1] === "jpeg" || m[1] === "jpg" ? "jpg" : m[1];
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) return null;
  await fs.mkdir(retireDir(boardId, cardId), { recursive: true });
  const file = `current.${ext}`;
  await fs.writeFile(path.join(retireDir(boardId, cardId), file), buf);
  return file;
}

/** The removal plan harness-retire writes (what to delete, ordered safely) for a card; null when none. */
export async function readRetirePlan(boardId: string, cardId: string): Promise<string | null> {
  try {
    return await fs.readFile(retirePlanPath(boardId, cardId), "utf8");
  } catch {
    return null;
  }
}

export async function writeRetirePlan(boardId: string, cardId: string, markdown: string): Promise<void> {
  await fs.mkdir(retireDir(boardId, cardId), { recursive: true });
  await fs.writeFile(retirePlanPath(boardId, cardId), markdown, "utf8");
}

// --- Style Guide (bloco de Design, D2/D3/D7) --------------------------------------------------
// The CANONICAL guide is a single sidecar: design/style-guide.md (frontmatter=machine, body=prose,
// D2). writeStyleGuide NEVER persists raw model bytes (D3) — it always regrows the file from a
// COERCED doc via compileStyleGuideMd, so what's on disk is always the deterministic projection of
// a valid doc, never a half-written LLM blob.

/** The canonical guide, or null when the board has none yet (or the file is unreadable). */
export async function readStyleGuide(boardId: string): Promise<StyleGuideDoc | null> {
  try {
    const text = await fs.readFile(styleGuideMdPath(boardId), "utf8");
    return parseStyleGuideMd(text);
  } catch {
    return null;
  }
}

/**
 * Compile + persist the canonical guide (D3). The caller that also updates the board.yaml pointer
 * (the approve chokepoint, WS-1) must hash the SAME compiled bytes this writes —
 * `computeStyleGuideHash(compileStyleGuideMd(doc))` — so the pointer's hash and the file never drift.
 */
export async function writeStyleGuide(boardId: string, doc: StyleGuideDoc): Promise<void> {
  await fs.mkdir(designDir(boardId), { recursive: true });
  await fs.writeFile(styleGuideMdPath(boardId), compileStyleGuideMd(doc), "utf8");
  // The approve is a HITL chokepoint like governance's propose/approve — durable persistence matters
  // the same way (the same debounced scoped-flush choke-point pattern as writeGovernanceDraft below).
  scheduleBoardDataFlush();
}

// --- Proposals (smart capture) — the harness-capture OUTPUT for a capture container ---
// The source free text rides in the container card's body; the generated proposal
// (summary + items) + the refine feedback history live in proposals/<containerId>.json.
function coerceProposedItem(raw: unknown, i: number): ProposedItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = o.title != null ? String(o.title) : "";
  if (!title.trim()) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  const strOrNull = (v: unknown) => (v != null && String(v).trim() ? String(v).trim() : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const nv = o.valueSize && typeof o.valueSize === "object" ? (o.valueSize as Record<string, unknown>) : null;
  const valueSize = nv ? { reach: num(nv.reach), impact: num(nv.impact) } : null;
  const nn = o.narrative && typeof o.narrative === "object" ? (o.narrative as Record<string, unknown>) : null;
  return {
    tempId: o.tempId != null && String(o.tempId) ? String(o.tempId) : `i${i + 1}`,
    type: pick(CARD_TYPES, o.type, "story"),
    title,
    storyType: isStoryType(o.storyType) ? o.storyType : null,
    parent: o.parent != null && String(o.parent) ? String(o.parent) : null,
    serves: o.serves != null && String(o.serves) ? String(o.serves) : null,
    release: o.release != null && String(o.release) ? String(o.release) : null,
    personas: list(o.personas),
    systems: list(o.systems),
    rationale: o.rationale != null ? String(o.rationale) : "",
    duplicateOf: o.duplicateOf != null && String(o.duplicateOf) ? String(o.duplicateOf) : null,
    // O MODO do item (ESTENDER) e o sinal de incerteza da classificação também eram descartados aqui —
    // e sem `targetCardId` um item que só acrescentaria tasks a um card existente DEGRADAVA, no caminho
    // assíncrono, para "cria um card novo" (exatamente o que o contrato de ProposedItem proíbe); sem
    // confidence/ambiguous a revisão no Inbox perdia o ⚠ e o botão de desambiguar que o modal mostra.
    ...(strOrNull(o.targetCardId) ? { targetCardId: strOrNull(o.targetCardId)! } : {}),
    ...(num(o.confidence) != null ? { confidence: num(o.confidence)! } : {}),
    ...(o.ambiguous === true ? { ambiguous: true } : {}),
    // Fidelidade TOTAL (F4): reidrata os campos antes descartados — addresses/body/narrative/acceptance +
    // OST-light — para o caminho assíncrono (Inbox) mostrar/criar exatamente o mesmo do síncrono.
    ...(o.body != null && String(o.body) ? { body: String(o.body) } : {}),
    ...(o.addresses != null && String(o.addresses) ? { addresses: String(o.addresses) } : {}),
    ...(nn ? { narrative: { role: strOrNull(nn.role), want: strOrNull(nn.want), soThat: strOrNull(nn.soThat) } } : {}),
    ...(o.acceptance != null ? { acceptance: list(o.acceptance) } : {}),
    ...(o.candidateSolutions != null ? { candidateSolutions: list(o.candidateSolutions) } : {}),
    ...(strOrNull(o.keyAssumption) ? { keyAssumption: strOrNull(o.keyAssumption)! } : {}),
    ...(strOrNull(o.successSignal) ? { successSignal: strOrNull(o.successSignal)! } : {}),
    ...(valueSize && (valueSize.reach != null || valueSize.impact != null) ? { valueSize } : {}),
    // 1.6 — WS7 pre-seeded tasks were DROPPED on the async Inbox round-trip (this coerce didn't copy them),
    // killing the "N ajustes MESMA superfície ⇒ 1 card com N tasks" gain. Passthrough mirroring parse.ts (the
    // sync in-modal path) so both paths agree: accept {id?,title} objects OR bare strings, drop empty titles.
    ...(Array.isArray(o.tasks)
      ? (() => {
          const tasks = (o.tasks as unknown[])
            .map((t) => {
              if (typeof t === "string") return t.trim() ? { title: t.trim() } : null;
              if (t && typeof t === "object") {
                const rec = t as Record<string, unknown>;
                const tt = typeof rec.title === "string" ? rec.title.trim() : "";
                if (!tt) return null;
                const tid = typeof rec.id === "string" ? rec.id.trim() : "";
                return tid ? { id: tid, title: tt } : { title: tt };
              }
              return null;
            })
            .filter((t): t is { id?: string; title: string } => t != null);
          return tasks.length ? { tasks } : {};
        })()
      : {}),
  };
}

/** Coerce raw JSON into a ProposalDoc. Pure + tolerant — never throws. */
export function coerceProposalDoc(containerId: string, raw: unknown): ProposalDoc {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(r.items)
    ? r.items.map((it, i) => coerceProposedItem(it, i)).filter((it): it is ProposedItem => it !== null)
    : [];
  const feedback = Array.isArray(r.feedback) ? r.feedback.map((f) => String(f)).filter(Boolean) : [];
  return {
    containerId,
    summary: r.summary != null ? String(r.summary) : "",
    items,
    feedback,
    generatedBy: r.generatedBy != null ? String(r.generatedBy) : "harness-capture",
    updated: r.updated != null ? String(r.updated) : null,
  };
}

export async function readProposal(boardId: string, containerId: string): Promise<ProposalDoc | null> {
  try {
    const raw = await fs.readFile(proposalPath(boardId, containerId), "utf8");
    return coerceProposalDoc(containerId, JSON.parse(raw));
  } catch {
    return null; // no sidecar yet (or unreadable) — treat as absent
  }
}

export async function writeProposal(boardId: string, doc: ProposalDoc): Promise<void> {
  await fs.mkdir(proposalsDir(boardId), { recursive: true });
  await fs.writeFile(proposalPath(boardId, doc.containerId), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

// --- WS-3.2 — a superfície de escrita de sidecar para AGENTE (MCP write_sidecar) --------------
//
// D4 fecha o fs direto de `storymap/boards/**` no checkout runtime (o hook
// block-runtime-board-writes). Para a política ser CUMPRÍVEL, o que um agente legitimamente
// escreve por lá precisa existir como superfície do serviço. Cards já tinham (update_card /
// triage_finding / move_card / answer_question); os SIDECARS não tinham — este é o buraco.
//
// A regra de segurança inteira está em `sidecarPathForKind`: o chamador escolhe um KIND de uma
// allowlist FECHADA e o path é DERIVADO dos helpers de paths.ts (que já passam board/card por
// sanitizeId). O chamador NUNCA fornece path — logo não há traversal a validar: `../../etc/x`
// como cardId não é rejeitado por um filtro de string, ele simplesmente não sobrevive ao
// sanitizeId (vira `..etcx`, um nome de arquivo comum DENTRO do dir do board).
//
// board.yaml deliberadamente NÃO está aqui: config tem dono humano (governança/propose_change),
// e abrir write cru dela para agente reabriria exatamente o que o guard-business-intent fecha.

/** Os kinds de sidecar que um agente pode escrever. Fechada — um kind fora dela é recusado. */
export const SIDECAR_KINDS = ["plans", "wireframes", "proposals"] as const;
export type SidecarKind = (typeof SIDECAR_KINDS)[number];

/** Teto de tamanho de um sidecar (o maior real, um wireframes/<id>.json com N opções, fica na casa das dezenas de KB). */
export const MAX_SIDECAR_BYTES = 512 * 1024;

export function isSidecarKind(kind: string): kind is SidecarKind {
  return (SIDECAR_KINDS as readonly string[]).includes(kind);
}

/**
 * O path ABSOLUTO de um sidecar, DERIVADO de (kind, board, cardId) — nunca aceito do chamador.
 * Pure (só path). Cada kind mapeia para o helper canônico de paths.ts, de modo que esta função
 * não conheça nenhum layout de diretório por conta própria.
 */
export function sidecarPathForKind(kind: SidecarKind, boardId: string, cardId: string): string {
  switch (kind) {
    case "plans":
      return planPath(boardId, cardId);
    case "wireframes":
      return wireframePath(boardId, cardId);
    case "proposals":
      return proposalPath(boardId, cardId);
  }
}

/**
 * Escreve um sidecar de card ATOMICAMENTE (o mesmo atomicWriteFile dos cards: temp+rename, para
 * que a skill/o watcher nunca leiam um JSON pela metade). Valida kind ∈ allowlist e o teto de
 * tamanho. Devolve o path relativo ao board (para o retorno da tool) — nunca o absoluto do disco.
 * Lança em kind inválido / conteúdo grande demais / id vazio: são erros do CHAMADOR.
 */
export async function writeSidecarByKind(
  boardId: string,
  cardId: string,
  kind: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  if (!isSidecarKind(kind)) {
    throw new Error(`kind inválido: "${kind}" — use um de: ${SIDECAR_KINDS.join(", ")}`);
  }
  if (!sanitizeId(boardId) || !sanitizeId(cardId)) {
    throw new Error("board e cardId são obrigatórios (slug: a-z0-9-)");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SIDECAR_BYTES) {
    throw new Error(`sidecar grande demais: ${bytes} bytes (teto ${MAX_SIDECAR_BYTES})`);
  }
  const file = sidecarPathForKind(kind, boardId, cardId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, content);
  return { path: path.relative(boardDir(boardId), file).split(path.sep).join("/"), bytes };
}

/** Delete a consumed proposal sidecar (on accept). Idempotent — a missing file is fine. */
export async function deleteProposal(boardId: string, containerId: string): Promise<void> {
  try {
    await fs.unlink(proposalPath(boardId, containerId));
  } catch {
    // already gone — nothing to do
  }
}

// --- Governance drafts (story-w9n03r) -----------------------------------------
// GovernanceDraft sidecars: boards/<board>/governance/<draftId>.json.
// Distinct from proposals/ (smart-capture, per-card) to avoid naming collisions.
// The pure coerce/apply/conflict functions live in governance.ts.

export async function readGovernanceDraft(boardId: string, draftId: string): Promise<GovernanceDraft | null> {
  try {
    const raw = await fs.readFile(governancePath(boardId, draftId), "utf8");
    return coerceGovernanceDraft(draftId, JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writeGovernanceDraft(boardId: string, draft: GovernanceDraft): Promise<void> {
  await fs.mkdir(governanceDir(boardId), { recursive: true });
  await fs.writeFile(governancePath(boardId, draft.id), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  // #2: the governance sidecar (propose/approve/reject) is board data edited LIVE by the bancada but never
  // committed — version it via the debounced scoped flush (the same choke-point pattern as writeBoardConfig).
  scheduleBoardDataFlush();
}

/** List all GovernanceDraft sidecars for a board (all statuses). */
export async function listGovernanceDrafts(boardId: string): Promise<GovernanceDraft[]> {
  try {
    const dir = governanceDir(boardId);
    const files = await fs.readdir(dir);
    const drafts = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const draftId = f.slice(0, -5); // strip .json
          try {
            const raw = await fs.readFile(path.join(dir, f), "utf8");
            return coerceGovernanceDraft(draftId, JSON.parse(raw));
          } catch {
            return null;
          }
        }),
    );
    return drafts.filter((d): d is GovernanceDraft => d !== null);
  } catch {
    return []; // governance/ dir doesn't exist yet — no drafts
  }
}

/** Delete a governance draft sidecar (after approve/reject). Idempotent. */
export async function deleteGovernanceDraft(boardId: string, draftId: string): Promise<void> {
  try {
    await fs.unlink(governancePath(boardId, draftId));
  } catch {
    // already gone — nothing to do
  }
}
