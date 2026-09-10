import { promises as fs } from "node:fs";
import path from "node:path";
// O parse de bytes de board (frontmatter de card + board.yaml) passa TODO pelo chokepoint de
// ./frontmatter — este arquivo não importa `gray-matter`/`js-yaml` direto de propósito (ver o
// cabeçalho de frontmatter.ts: `---js` executava `eval` no processo ao LER um card).
import {
  FrontmatterError,
  assertStatWithinByteCap,
  describeFrontmatterError,
  parseFrontmatter,
  parseYamlMap,
  type FrontmatterRejection,
} from "./frontmatter";
import { baseBoardConfigPath, boardConfigPath, boardsDir, cardPath, cardsDir, runnerStateDir } from "./paths";
import { parseBoardConfig, parseCard } from "./contracts";
import { coerceCanvas as coerceCanvasKernel, coerceCanvasTags as coerceCanvasTagsKernel } from "./canvas";
import { coerceStyleGuidePointer } from "./style-guide";
import { coerceWsjf } from "./wsjf";
import { DEPLOY_STEP_ID, releaseModeOf, withDerivedDeployAutorun } from "./release-policy";
import { mergeById } from "./gate-core";
import {
  isBugSeverity,
  isBugFrequency,
  isDisposition,
  isExperimentStatus,
  isFunnelStage,
  isImprovementKind,
  isKanoCategory,
  isIdeaStatus,
  isOwner,
  isRemovalLevel,
  isRemovalScope,
  isStoryType,
} from "./frameworks";
import type {
  Bet,
  Board,
  BoardConfig,
  BoardDeployConfig,
  BoardSummary,
  BugReport,
  Card,
  CardLink,
  CardQuestion,
  CardRouting,
  CardType,
  ColumnDef,
  CommitRange,
  CriterionSpec,
  DiffSnapshot,
  FailureClass,
  Finding,
  GateId,
  ModelTier,
  EffortLevel,
  IdeaFields,
  Persona,
  PriorityCall,
  OrchestratorMode,
  OrchestratorPolicy,
  Refinement,
  Retirement,
  ReleaseDef,
  RiskClass,
  RiskDisposition,
  Rice,
  RouteProfile,
  SpecialistDef,
  StatusDef,
  StepToolkit,
  StoryNarrative,
  SystemDef,
  Task,
  ToolConfigDef,
  ToolExpectLevel,
  ToolExpectCondition,
  ToolExpectation,
  TriggerId,
} from "./types";
import {
  COLUMN_TRIGGER_IDS,
  EFFORT_LEVELS,
  ENTRY_EFFECTS_IDS,
  FAILURE_CLASSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  GATE_IDS,
  isCardProvenance,
  isReopenMode,
  isRoutingDecidedBy,
  MODEL_TIERS,
  ORCHESTRATOR_MODES,
  QUESTION_STATUSES,
  REVIEW_LENSES,
  RISK_CLASSES,
  RISK_DISPOSITIONS,
} from "./types";

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** YAML 1.1 parses bare `2026-06-02` as a Date — normalize back to YYYY-MM-DD. */
function toDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function coerceLinks(raw: unknown): CardLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l === "object")
    .map((l) => ({ rel: String((l as any).rel ?? ""), to: String((l as any).to ?? "") }))
    .filter((l) => l.to);
}

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x)).filter(Boolean);
}

function coerceTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t === "object")
    .map((t, i) => ({
      id: (t as any).id != null && String((t as any).id) ? String((t as any).id) : `t${i + 1}`,
      title: (t as any).title != null ? String((t as any).title) : "",
      done: (t as any).done === true,
    }))
    .filter((t) => t.title);
}

/** YAML may omit any RICE field; missing → null. effort/0 stays null-equivalent downstream. */
function coerceRiceNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function coerceRice(raw: unknown): Rice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    reach: coerceRiceNumber(r.reach),
    impact: coerceRiceNumber(r.impact),
    confidence: coerceRiceNumber(r.confidence),
    effort: coerceRiceNumber(r.effort),
  };
}

/** A narrative clause is null when absent/empty/literal "null". */
function coerceNarrativeClause(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" || s.toLowerCase() === "null" ? null : s;
}

function coerceNarrative(raw: unknown): StoryNarrative {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    role: coerceNarrativeClause(r.role),
    want: coerceNarrativeClause(r.want),
    soThat: coerceNarrativeClause(r.soThat),
  };
}

function coerceGate(value: unknown): GateId | undefined {
  return GATE_IDS.includes(value as GateId) ? (value as GateId) : undefined;
}

function coerceTrigger(value: unknown): TriggerId | undefined {
  // Only column triggers are valid on a board.yaml status — harness-sync-card is on-demand.
  return COLUMN_TRIGGER_IDS.includes(value as TriggerId) ? (value as TriggerId) : undefined;
}

function coerceModel(value: unknown): ModelTier | undefined {
  return MODEL_TIERS.includes(value as ModelTier) ? (value as ModelTier) : undefined;
}

function coerceEffort(value: unknown): EffortLevel | undefined {
  return EFFORT_LEVELS.includes(value as EffortLevel) ? (value as EffortLevel) : undefined;
}

/** Code-review findings — tolerant: unknown enum values fall back, never throw. */
function coerceFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && typeof f === "object")
    .map((f, i) => {
      const o = f as Record<string, unknown>;
      const finding: Finding = {
        id: o.id != null && String(o.id) ? String(o.id) : `f${i + 1}`,
        lens: REVIEW_LENSES.includes(o.lens as Finding["lens"]) ? (o.lens as Finding["lens"]) : "general",
        severity: FINDING_SEVERITIES.includes(o.severity as Finding["severity"])
          ? (o.severity as Finding["severity"])
          : "medium",
        title: o.title != null ? String(o.title) : "",
        status: FINDING_STATUSES.includes(o.status as Finding["status"]) ? (o.status as Finding["status"]) : "open",
      };
      if (o.detail != null) finding.detail = String(o.detail);
      if (o.file != null) finding.file = String(o.file);
      const line = Number(o.line);
      if (Number.isFinite(line)) finding.line = line;
      if (o.suggestion != null) finding.suggestion = String(o.suggestion);
      // ADR-063 (4d): preserve a valid failure class; a malformed value is dropped (stays sparse).
      if (o.failureClass != null && FAILURE_CLASSES.includes(o.failureClass as FailureClass)) {
        finding.failureClass = o.failureClass as FailureClass;
      }
      // WS-2 (2.3): who/when last changed the status. Absent = never triaged / pre-dates the field.
      // `statusAt` goes through toDateString because YAML 1.1 parses a bare 2026-07-16 as a Date — a
      // raw String() would persist "Thu Jul 16 2026 …" back into the frontmatter.
      if (o.statusBy != null && String(o.statusBy)) finding.statusBy = String(o.statusBy);
      const statusAt = toDateString(o.statusAt);
      if (statusAt) finding.statusAt = statusAt;
      return finding;
    })
    .filter((f) => f.title);
}

/**
 * ADR-063 (2c): coerce the acceptance→spec map. Tolerant + sparse — drops entries without a
 * criterion string, returns undefined when none so lean cards stay lean. `specPath` is optional
 * (absent = not yet authored → gate hasCriteriaSpecs routes back).
 */
function coerceCriteriaSpecs(raw: unknown): CriterionSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const o = s as Record<string, unknown>;
      const spec: CriterionSpec = { criterion: o.criterion != null ? String(o.criterion) : "" };
      if (o.specPath != null && String(o.specPath).trim()) spec.specPath = String(o.specPath);
      return spec;
    })
    .filter((s) => s.criterion.trim());
  return out.length ? out : undefined;
}

/** Coerce the card's HITL questions (tolerant; drops text-less entries). Returns undefined when none
 * so the field stays sparse on lean cards (mirrors labels/severity). */
function coerceQuestions(raw: unknown): CardQuestion[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((q) => q && typeof q === "object")
    .map((q, i) => {
      const o = q as Record<string, unknown>;
      const question: CardQuestion = {
        id: o.id != null && String(o.id) ? String(o.id) : `q${i + 1}`,
        text: o.text != null ? String(o.text) : "",
        status: QUESTION_STATUSES.includes(o.status as CardQuestion["status"])
          ? (o.status as CardQuestion["status"])
          : "open",
      };
      if (o.askedBy != null && String(o.askedBy)) question.askedBy = String(o.askedBy);
      const askedAt = o.askedAt != null ? toDateString(o.askedAt) : null;
      if (askedAt) question.askedAt = askedAt;
      if (o.answer != null && String(o.answer)) question.answer = String(o.answer);
      const answeredAt = o.answeredAt != null ? toDateString(o.answeredAt) : null;
      if (answeredAt) question.answeredAt = answeredAt;
      if (o.answeredBy != null && String(o.answeredBy)) question.answeredBy = String(o.answeredBy); // F6.3
      // Agent-suggested options + pick mode + the human's structured selection (HITL with suggestions).
      if (Array.isArray(o.options)) {
        const opts = o.options
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x, j) => {
            const pros = Array.isArray(x.pros) ? x.pros.map((p) => String(p)).filter(Boolean) : [];
            const cons = Array.isArray(x.cons) ? x.cons.map((c) => String(c)).filter(Boolean) : [];
            return {
              id: x.id != null && String(x.id) ? String(x.id) : `o${j + 1}`,
              label: x.label != null ? String(x.label) : "",
              ...(pros.length ? { pros } : {}),
              ...(cons.length ? { cons } : {}),
              ...(x.recommended === true ? { recommended: true } : {}),
            };
          })
          .filter((x) => x.label);
        if (opts.length) question.options = opts;
      }
      if (o.mode === "single" || o.mode === "multi") question.mode = o.mode;
      if (Array.isArray(o.selectedOptionIds)) {
        const ids = o.selectedOptionIds.filter((x) => x != null).map((x) => String(x)).filter(Boolean);
        if (ids.length) question.selectedOptionIds = ids;
      }
      // Agent decision support: the "why" (context) + a prose recommendation for a pure free-text question.
      if (o.context != null && String(o.context)) question.context = String(o.context);
      if (o.recommendation != null && String(o.recommendation))
        question.recommendation = String(o.recommendation);
      return question;
    })
    .filter((q) => q.text);
  return out.length ? out : undefined;
}

/** Refine brief — tolerant: a block with no brief coerces to null (treated as absent). */
function coerceRefinement(raw: unknown): Refinement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const brief = r.brief != null ? String(r.brief).trim() : "";
  if (!brief) return null; // a refinement with no brief is meaningless
  // kinds: prefer the array; fall back to a legacy singular `kind`. Dedup; default ux.
  const rawKinds = Array.isArray(r.kinds) ? r.kinds : r.kind != null ? [r.kind] : [];
  const kinds = Array.from(new Set(rawKinds.filter(isImprovementKind)));
  return {
    brief,
    kinds: kinds.length ? kinds : ["ux"],
    target: r.target != null && String(r.target).trim() ? String(r.target).trim() : null,
    screenshot: r.screenshot != null && String(r.screenshot).trim() ? String(r.screenshot).trim() : null,
    openedAt: r.openedAt != null ? toDateString(r.openedAt) : null,
  };
}

/**
 * Per-instance routing override (PIPELINE-OWNED) — tolerant: a block with no skipped status ids
 * coerces to null (treated as absent → the deterministic rules decide live). `skips` is kept as a
 * deduped string[] of ids (validated against the board's real statuses by the lints, not here, to stay
 * tolerant like duplicateOf/serves); `decidedBy` defaults to `rules`; `decidedAt` normalises a YAML Date.
 */
function coerceRouting(raw: unknown): CardRouting | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const skips = Array.from(new Set(coerceStringArray(r.skips)));
  // WS4 — a routing block is meaningful when it carries a skip set OR a profile OR a model/effort cap
  // (an `express` card may cap the model with no explicit skips beyond the static skipForTypes). Only a
  // block with NONE of those (e.g. a stray rationale) coerces to null → the deterministic rules decide live.
  const profile = r.profile != null && String(r.profile).trim() ? String(r.profile).trim() : undefined;
  const modelCap = coerceModel(r.modelCap);
  const effortCap = coerceEffort(r.effortCap);
  if (!skips.length && !profile && !modelCap && !effortCap) return null;
  const routing: CardRouting = {
    skips,
    decidedBy: isRoutingDecidedBy(r.decidedBy) ? r.decidedBy : "rules",
    decidedAt: toDateString(r.decidedAt) ?? "",
  };
  if (profile) routing.profile = profile;
  if (modelCap) routing.modelCap = modelCap;
  if (effortCap) routing.effortCap = effortCap;
  if (r.rationale != null && String(r.rationale).trim()) routing.rationale = String(r.rationale).trim();
  return routing;
}

/** WS6 (F5) — the explicit "sem lugar no mapa" acknowledgement ({by, at}). Tolerant: needs a non-empty
 *  `by` to be meaningful; `at` normalises a YAML Date. Returns undefined when absent/off-shape (sparse). */
function coerceUnplacedAck(raw: unknown): { by: string; at: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const by = r.by != null ? String(r.by).trim() : "";
  if (!by) return undefined; // an ack with no author is meaningless
  return { by, at: toDateString(r.at) ?? "" };
}

/** Bug report — tolerant: a block with no brief coerces to null (treated as absent). */
function coerceBugReport(raw: unknown): BugReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const brief = r.brief != null ? String(r.brief).trim() : "";
  if (!brief) return null; // a bug report with no brief is meaningless
  return {
    brief,
    severity: isBugSeverity(r.severity) ? r.severity : "medium",
    expected: r.expected != null && String(r.expected).trim() ? String(r.expected).trim() : null,
    actual: r.actual != null && String(r.actual).trim() ? String(r.actual).trim() : null,
    steps: coerceStringArray(r.steps),
    target: r.target != null && String(r.target).trim() ? String(r.target).trim() : null,
    screenshot: r.screenshot != null && String(r.screenshot).trim() ? String(r.screenshot).trim() : null,
    openedAt: r.openedAt != null ? toDateString(r.openedAt) : null,
  };
}

/** Coerce a `{reach, impact}` value-size block — null when neither axis is a finite number. */
function coerceValueSize(raw: unknown): { reach: number | null; impact: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const reach = num(r.reach);
  const impact = num(r.impact);
  if (reach == null && impact == null) return null;
  return { reach, impact };
}

/** Prioridade argumentada (reasoning-first) — tolerante: bloco inválido (sem rank/rationale) → null.
 *  Esparso: só retido quando presente no disco. ⚠️ Reconstrói campo-a-campo (igual coerceIdea). */
function coercePriorityCall(raw: unknown): PriorityCall | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rank = r.rank;
  if (rank !== 0 && rank !== 1 && rank !== 2 && rank !== 3) return null;
  const rationale = r.rationale != null ? String(r.rationale).trim() : "";
  if (!rationale) return null;
  const out: PriorityCall = {
    rank,
    rationale,
    source: r.source === "human" ? "human" : "agent",
    assessedAt: r.assessedAt != null ? String(r.assessedAt) : "",
  };
  if (r.riskiestAssumption != null && String(r.riskiestAssumption).trim()) {
    out.riskiestAssumption = String(r.riskiestAssumption).trim();
  }
  // Ordinais WSJF — esparsos e TOLERANTES: um sub-bloco corrompido (ordinal fora da escala) é
  // descartado, mas o `rank` + `rationale` do call SOBREVIVEM. Perder a razão é degradar; perder o
  // tier seria destravar um card para fora do gate hasPrioritization.
  const wsjf = coerceWsjf(r.wsjf);
  if (wsjf) out.wsjf = wsjf;
  return out;
}

/** Idea fields — tolerant: a block with no statement coerces to null (treated as absent).
 *  ⚠️ This rebuilds the object field-by-field, so a NEW IdeaFields key that isn't read HERE is
 *  silently dropped on every read. The OST-light fields (Fatia 2) are sparse: only retained when present. */
function coerceIdea(raw: unknown): IdeaFields | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const statement = r.statement != null ? String(r.statement).trim() : "";
  if (!statement) return null;
  const out: IdeaFields = {
    statement,
    evidence: r.evidence != null && String(r.evidence).trim() ? String(r.evidence).trim() : null,
    status: isIdeaStatus(r.status) ? r.status : "open",
  };
  if (r.discardReason != null && String(r.discardReason).trim()) out.discardReason = String(r.discardReason).trim();
  // OST light (Fatia 2) — sparse: keep a field only when it carries content (keeps the card .md lean).
  const candidateSolutions = coerceStringArray(r.candidateSolutions);
  if (candidateSolutions.length) out.candidateSolutions = candidateSolutions;
  if (r.keyAssumption != null && String(r.keyAssumption).trim()) out.keyAssumption = String(r.keyAssumption).trim();
  if (r.successSignal != null && String(r.successSignal).trim()) out.successSignal = String(r.successSignal).trim();
  const valueSize = coerceValueSize(r.valueSize);
  if (valueSize) out.valueSize = valueSize;
  const priorityCall = coercePriorityCall(r.priorityCall);
  if (priorityCall) out.priorityCall = priorityCall;
  return out;
}

/** Bet block — tolerant: a block with no assumptions coerces to null (treated as absent). */
function coerceBet(raw: unknown): Bet | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const assumptions = coerceStringArray(r.assumptions);
  if (!assumptions.length) return null;
  return {
    assumptions,
    riskiestAssumption:
      r.riskiestAssumption != null && String(r.riskiestAssumption).trim()
        ? String(r.riskiestAssumption).trim()
        : null,
    experimentStatus: isExperimentStatus(r.experimentStatus) ? r.experimentStatus : "untested",
  };
}

/** Retirement brief — tolerant: a block with no brief coerces to null (treated as absent). */
function coerceRetirement(raw: unknown): Retirement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const brief = r.brief != null ? String(r.brief).trim() : "";
  if (!brief) return null; // a retirement with no brief is meaningless
  const disposition = isDisposition(r.disposition) ? r.disposition : "descontinuado";
  const level = isRemovalLevel(r.level) ? r.level : null;
  const scope = Array.isArray(r.scope) ? Array.from(new Set(r.scope.filter(isRemovalScope))) : [];
  return {
    brief,
    disposition,
    // postergado never removes code → level is always null regardless of what's on disk.
    level: disposition === "postergado" ? null : level,
    scope,
    target: r.target != null && String(r.target).trim() ? String(r.target).trim() : null,
    screenshot: r.screenshot != null && String(r.screenshot).trim() ? String(r.screenshot).trim() : null,
    fromStatus: r.fromStatus != null && String(r.fromStatus).trim() ? String(r.fromStatus).trim() : null,
    dataDeletionApproved: r.dataDeletionApproved === true,
    openedAt: r.openedAt != null ? toDateString(r.openedAt) : null,
  };
}

/**
 * Coerce the durable `{ base, head }` review/QA range (SM-05). Both fields are
 * required SHAs; a half-written range (missing either) is dropped so a malformed
 * frontmatter never resurfaces a broken diff link.
 */
function coerceCommitRange(raw: unknown): CommitRange | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const base = r.base != null ? String(r.base).trim() : "";
  const head = r.head != null ? String(r.head).trim() : "";
  if (!base || !head) return undefined;
  return { base, head };
}

/**
 * WS-5.2 — coerce the proof-carrying build stamp. STRICT on the two fields that MAKE it evidence: an
 * unknown `provenance` (the only value the engine ever writes is `already-landed`) or a missing `at`
 * drops the whole stamp, so a hand-authored / malformed frontmatter can never manufacture build evidence
 * and walk a card through the hasBuildEvidence gate. The audit fields (range/target/runId) are optional
 * prose — a missing one weakens the trail, never the proof.
 */
function coerceBuildEvidence(raw: unknown): Card["buildEvidence"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (String(r.provenance ?? "").trim() !== "already-landed") return undefined;
  const at = r.at != null ? String(r.at).trim() : "";
  if (!at) return undefined;
  const opt = (v: unknown) => {
    const s = v != null ? String(v).trim() : "";
    return s || undefined;
  };
  return {
    provenance: "already-landed",
    at,
    ...(opt(r.range) ? { range: opt(r.range)! } : {}),
    ...(opt(r.target) ? { target: opt(r.target)! } : {}),
    ...(opt(r.runId) ? { runId: opt(r.runId)! } : {}),
  };
}

/**
 * Coerce a superfície de UI MEDIDA. STRICT no que a torna evidência: `touched` precisa ser booleano
 * DE VERDADE e `at` não-vazio — senão o objeto inteiro cai. Um frontmatter escrito à mão não fabrica
 * medição, e (mais importante) um objeto meia-boca não vira `touched: false` implícito, que EXIMIRIA
 * o card do QA visual. Na dúvida a evidência some e o gate volta ao caminho declarativo de sempre.
 */
function coerceUiSurfaceEvidence(raw: unknown): Card["uiSurfaceEvidence"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.touched !== "boolean") return undefined;
  const at = r.at != null ? String(r.at).trim() : "";
  if (!at) return undefined;
  const paths = Array.isArray(r.paths)
    ? r.paths.map((p) => String(p).trim()).filter(Boolean)
    : [];
  const runId = r.runId != null ? String(r.runId).trim() : "";
  return {
    touched: r.touched,
    at,
    ...(paths.length ? { paths } : {}),
    ...(runId ? { runId } : {}),
  };
}

/**
 * Coerce o QUE o QA provou. `at` é obrigatório (um carimbo sem data não é carimbo); `suite`/`visual`
 * só sobrevivem como booleanos reais. Um `visual` malformado vira AUSENTE, não `false`: ausente é
 * "não sei" e deixa o gate decidir pelo caminho conservador, enquanto um `false` inventado acusaria o
 * card de ter pulado a tela. Ausência ≠ negativa — a distinção é o ponto do campo.
 */
function coerceQaEvidence(raw: unknown): Card["qaEvidence"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const at = r.at != null ? String(r.at).trim() : "";
  if (!at) return undefined;
  const by = r.by != null ? String(r.by).trim() : "";
  return {
    ...(typeof r.suite === "boolean" ? { suite: r.suite } : {}),
    ...(typeof r.visual === "boolean" ? { visual: r.visual } : {}),
    at,
    ...(by ? { by } : {}),
  };
}

/**
 * deploy-truth WS-1 — coerce the server-stamped production proof. STRICT on everything that makes it
 * evidence: an empty `sha`, a `source` outside the three settle/reconcile handlers, or a missing `at`
 * drops the WHOLE stamp — a hand-authored frontmatter can never manufacture deploy proof (the gate
 * hasDeployProof would then pass on a claim nobody measured, which is the exact lie deploy-truth
 * removes). Date-tolerant on `at` (gray-matter's YAML parses an unquoted ISO timestamp into a Date —
 * same round-trip hazard as deployFiredAt). `targets` degrades to [] (informational, not load-bearing).
 */
const DEPLOY_PROOF_SOURCES = ["settle-webhook", "registry-ondone", "reconcile-evidence"] as const;
function coerceDeployProof(raw: unknown): Card["deployProof"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const sha = r.sha != null ? String(r.sha).trim() : "";
  if (!sha) return undefined;
  const source = DEPLOY_PROOF_SOURCES.find((s) => s === r.source);
  if (!source) return undefined;
  const at = typeof r.at === "string" ? r.at.trim() : r.at instanceof Date ? r.at.toISOString() : "";
  if (!at) return undefined;
  const targets = Array.isArray(r.targets) ? r.targets.map((t) => String(t)).filter(Boolean) : [];
  return { sha, targets, at, source };
}

function coerceDiffSnapshot(raw: unknown): DiffSnapshot | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const base = r.base != null ? String(r.base).trim() : "";
  const mergeCommit = r.mergeCommit != null ? String(r.mergeCommit).trim() : "";
  if (!base || !mergeCommit) return undefined;
  return { base, mergeCommit };
}

/**
 * D14 — coerce the style-guide conformance stamp (WS-3). `version` must be a positive number and
 * `hash`/`at` non-empty; `passed` defaults to false when malformed rather than dropping the whole
 * stamp (a recorded-but-failing check is still meaningful — unlike CommitRange, where a half-written
 * pair is meaningless). A stamp missing its version/hash/at is dropped entirely (nothing worth keeping).
 */
function coerceStyleGuideCheck(raw: unknown): Card["styleGuideCheck"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const version = Number(r.version);
  const hash = r.hash != null ? String(r.hash).trim() : "";
  const at = r.at != null ? String(r.at).trim() : "";
  if (!Number.isFinite(version) || version <= 0 || !hash || !at) return undefined;
  return { version: Math.floor(version), hash, passed: r.passed === true, at };
}

const TOOL_EXPECT_LEVELS: readonly ToolExpectLevel[] = ["required", "expected", "advisory", "off"];
const TOOL_EXPECT_CONDITIONS: readonly ToolExpectCondition[] = ["uiSurface"];

/**
 * WS3 (F2) — coerce a StatusDef's `toolkit` facet. Fixed key order (use/expect/guidance/allowedTools/
 * specialists) so deriveBoardConfigForPersist's JSON-stringify delta compare stays deterministic. Drops
 * empty/off-shape fields; returns undefined when nothing survives (so the field is omitted, not `{}`).
 */
export function coerceToolkit(raw: unknown): StepToolkit | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const tk: StepToolkit = {};
  const use = coerceStringArray(r.use);
  if (use.length) tk.use = use;
  if (Array.isArray(r.expect)) {
    const expect = r.expect
      .filter((e) => e && typeof e === "object")
      .map((e) => {
        const tool = String((e as any).tool ?? "").trim();
        const level = (e as any).level;
        if (!tool || !TOOL_EXPECT_LEVELS.includes(level)) return null;
        // An UNRECOGNISED `when` is dropped rather than kept: keeping it would silently widen the
        // expectation to every card (absent = applies always), which for a `required` entry means a typo
        // could stop cards that never needed the capability. Dropping narrows to the documented default.
        const when = TOOL_EXPECT_CONDITIONS.includes((e as any).when) ? ((e as any).when as ToolExpectCondition) : undefined;
        return { tool, level: level as ToolExpectLevel, ...(when ? { when } : {}) };
      })
      .filter((e): e is ToolExpectation => e != null);
    if (expect.length) tk.expect = expect;
  }
  if (r.guidance != null && String(r.guidance).trim()) tk.guidance = String(r.guidance).trim();
  const allowed = coerceStringArray(r.allowedTools);
  if (allowed.length) tk.allowedTools = allowed;
  const specialists = coerceStringArray(r.specialists);
  if (specialists.length) tk.specialists = specialists;
  return Object.keys(tk).length ? tk : undefined;
}

/**
 * WS3 (F2) — coerce the board-level `toolConfigs` record (id → mount/match/cli/description + the
 * CAPABILITY CONTRACT facet provides/probe/probeTimeoutMs/fallback). Fixed key order per entry for
 * deterministic persist. Returns undefined when empty so a board with none omits the field entirely
 * (byte-identical legacy load).
 */
export function coerceToolConfigs(raw: unknown): Record<string, ToolConfigDef> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, ToolConfigDef> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const def: ToolConfigDef = {};
    if (r.mcp != null && String(r.mcp).trim()) def.mcp = String(r.mcp).trim();
    if (r.match != null && String(r.match).trim()) def.match = String(r.match).trim();
    if (r.cli != null && String(r.cli).trim()) def.cli = String(r.cli).trim();
    if (r.description != null) def.description = String(r.description);
    // Capability contract — same trim-and-drop-empty discipline as the fields above, so a blank
    // `probe:`/`provides:` in YAML is indistinguishable from an absent one (never a half-declared
    // provider that the probe layer would then treat as provable).
    if (r.provides != null && String(r.provides).trim()) def.provides = String(r.provides).trim();
    if (r.probe != null && String(r.probe).trim()) def.probe = String(r.probe).trim();
    const timeout = Number(r.probeTimeoutMs);
    if (Number.isFinite(timeout) && timeout > 0) def.probeTimeoutMs = Math.floor(timeout);
    if (r.fallback != null && String(r.fallback).trim()) def.fallback = String(r.fallback).trim();
    // `outsideRunSandbox` — booleano, e por isso NÃO segue a disciplina de trim-and-drop acima. Só o
    // literal `true` liga: qualquer outra coisa (ausente, false, string vazia, lixo) deixa o campo fora,
    // que é o default seguro — um provedor sem declaração continua sendo sondado como sempre foi. Este
    // coerce é o que PERSISTE o board: um campo que ele não conhecesse seria apagado em silêncio na
    // próxima gravação, e a declaração sumiria sem ninguém notar.
    if (r.outsideRunSandbox === true) def.outsideRunSandbox = true;
    out[id] = def;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * WS4 — coerce the board-level `routeProfiles` record (id → skips[]/modelCap?/effortCap?/description?).
 * Fixed key order per entry for deterministic persist. Drops off-shape entries; returns undefined when
 * empty (a board with no profiles omits the field → byte-identical legacy load). `skips` is always present
 * (defaults to []) so a profile with only a cap is still a valid, distinct profile.
 */
export function coerceRouteProfiles(raw: unknown): Record<string, RouteProfile> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, RouteProfile> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const def: RouteProfile = { skips: Array.from(new Set(coerceStringArray(r.skips))) };
    const modelCap = coerceModel(r.modelCap);
    if (modelCap) def.modelCap = modelCap;
    const effortCap = coerceEffort(r.effortCap);
    if (effortCap) def.effortCap = effortCap;
    if (r.description != null && String(r.description).trim()) def.description = String(r.description).trim();
    out[id] = def;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * WS4 — coerce the board-level `specialists` registry (id → {agent, when}). Both fields required + trimmed;
 * an entry missing either is DROPPED (an agent with no slug can't be delegated to; a slug with no `when`
 * gives the run no trigger). Fixed key order (agent/when). Returns undefined when empty (byte-identical
 * legacy load). The agent slug is NOT validated against SAFE_SLUG here (tolerant read) — the engine
 * re-validates it at compose time and a lint WARNs if `.claude/agents/<slug>.md` is missing.
 */
export function coerceSpecialists(raw: unknown): Record<string, SpecialistDef> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, SpecialistDef> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const agent = r.agent != null ? String(r.agent).trim() : "";
    const when = r.when != null ? String(r.when).trim() : "";
    if (!agent || !when) continue; // both required — a half-defined specialist is unusable
    out[id] = { agent, when };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * WS8 (F7) — coerce the board's orchestrator/copiloto POLICY. Tolerant: an invalid mode drops the whole
 * block (default off); an unknown riskMatrix class/disposition is dropped (the lint reproves it loudly at the
 * board-integrity layer, but the read stays tolerant). Returns undefined when absent/off-shape (byte-identical
 * legacy load — the copiloto is dormant unless a board opts in).
 */
export function coerceOrchestrator(raw: unknown): OrchestratorPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!(ORCHESTRATOR_MODES as readonly string[]).includes(r.mode as string)) return undefined;
  const out: OrchestratorPolicy = { mode: r.mode as OrchestratorMode };
  const max = Number(r.maxActionsPerHour);
  if (Number.isFinite(max) && max > 0) out.maxActionsPerHour = Math.floor(max);
  if (r.riskMatrix && typeof r.riskMatrix === "object" && !Array.isArray(r.riskMatrix)) {
    const matrix: Partial<Record<RiskClass, RiskDisposition>> = {};
    for (const [cls, disp] of Object.entries(r.riskMatrix as Record<string, unknown>)) {
      if ((RISK_CLASSES as readonly string[]).includes(cls) && (RISK_DISPOSITIONS as readonly string[]).includes(disp as string)) {
        matrix[cls as RiskClass] = disp as RiskDisposition;
      }
    }
    if (Object.keys(matrix).length) out.riskMatrix = matrix;
  }
  return out;
}

/**
 * Deploy agnóstico (D-AG1) — coerce the board's deploy DESCRIPTOR from raw yaml. Tolerant on shape
 * (invalid block ⇒ undefined ⇒ legacy routing — a board never goes dark over a malformed descriptor;
 * the B1 drift alarm below surfaces it via BoardConfigSchema), strict on VALUES: an unknown `kind` or a
 * non-positive timeout drops the field rather than smuggling it through, mirroring coerceOrchestrator.
 * Without this coerce the descriptor authored in board.yaml is dropped SILENTLY on read (deploy is
 * optional in the schema, so not even B1 fires) — the exact "declared but inert" class the deploy-truth
 * work exists to kill.
 */
export function coerceBoardDeploy(raw: unknown): BoardDeployConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: BoardDeployConfig = {};
  if (["auto", "command", "agent"].includes(r.kind as string)) out.kind = r.kind as BoardDeployConfig["kind"];
  if (typeof r.command === "string" && r.command.trim()) out.command = r.command;
  if (typeof r.description === "string" && r.description.trim()) out.description = r.description;
  if (typeof r.healthUrl === "string" && r.healthUrl.trim()) out.healthUrl = r.healthUrl;
  if (typeof r.canaryCommand === "string" && r.canaryCommand.trim()) out.canaryCommand = r.canaryCommand;
  const t = Number(r.timeoutMinutes);
  if (Number.isFinite(t) && t > 0) out.timeoutMinutes = t;
  // story-zr1cmf — deployable SURFACES outside `package`. Tolerant on shape (a non-array or a malformed
  // entry is dropped, never throws), strict on VALUES (an entry needs a non-empty `prefix`, mirroring the
  // schema's `min(1)`; `deployCmd` optional). Omitting this made the whole surfaces capability DECLARED-BUT-
  // INERT: the read dropped it, so the promote scope (fireReleaseStaged) never saw the surface and a change
  // staged under it tripped the out-of-scope revert instead of publishing — the exact "declared but inert"
  // class this coerce exists to kill. The schema↔coerce lockstep test now guards EVERY field against this.
  if (Array.isArray(r.surfaces)) {
    const surfaces = r.surfaces
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && !Array.isArray(s))
      .map((s) => {
        const prefix = typeof s.prefix === "string" ? s.prefix.trim() : "";
        if (!prefix) return null;
        const surf: { prefix: string; deployCmd?: string } = { prefix };
        if (typeof s.deployCmd === "string" && s.deployCmd.trim()) surf.deployCmd = s.deployCmd.trim();
        return surf;
      })
      .filter((s): s is { prefix: string; deployCmd?: string } => s !== null);
    if (surfaces.length) out.surfaces = surfaces;
  }
  return Object.keys(out).length ? out : undefined;
}

export function coerceStatuses(raw: unknown): StatusDef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => s && typeof s === "object")
    .map((s) => {
      const def: StatusDef = {
        id: String((s as any).id ?? ""),
        name: String((s as any).name ?? (s as any).id ?? ""),
      };
      if ((s as any).color != null) def.color = String((s as any).color);
      // VIEW-only sigla for the step-trail chips (allow-list: dropped on read unless mapped here).
      if ((s as any).short != null && String((s as any).short).trim()) def.short = String((s as any).short).trim();
      const gate = coerceGate((s as any).gate);
      if (gate) def.gate = gate;
      const trigger = coerceTrigger((s as any).trigger);
      if (trigger) def.trigger = trigger;
      if (typeof (s as any).autorun === "boolean") def.autorun = (s as any).autorun;
      if (typeof (s as any).terminal === "boolean") def.terminal = (s as any).terminal;
      // "no ar" — subconjunto ESTRITO de terminal, lido por deliveredIndex (delivered.ts). Só `true`
      // é significativo: a régua é fail-closed, então ausência já significa "não sei, não afirme".
      if ((s as any).delivered === true) def.delivered = true;
      // ADR-059 — auto-entrada no terminal (default-off); lido só no forward (cascade-decision/advance).
      if (typeof (s as any).autoEnterTerminal === "boolean") def.autoEnterTerminal = (s as any).autoEnterTerminal;
      // VIEW-only flags (allow-list: dropped on read unless mapped here). laneStep = delivery stepper lane;
      // hidden = vestigial reentry lane hidden from the kanban. Kernel/gates/autorun never read them.
      if (typeof (s as any).laneStep === "boolean") def.laneStep = (s as any).laneStep;
      if (typeof (s as any).hidden === "boolean") def.hidden = (s as any).hidden;
      if (typeof (s as any).staging === "boolean") def.staging = (s as any).staging;
      // B3 — efeito-ao-entrar declarativo (substitui promotesStage/deploysBoard). Valor inválido é dropado.
      if (ENTRY_EFFECTS_IDS.includes((s as any).onEnter)) def.onEnter = (s as any).onEnter;
      // STAGE grouping (presentational) + data-driven storyType skip (routing).
      if ((s as any).column != null && String((s as any).column).trim())
        def.column = String((s as any).column).trim();
      if (Array.isArray((s as any).skipForTypes)) {
        const skips = (s as any).skipForTypes.filter((t: unknown) => isStoryType(t));
        if (skips.length) def.skipForTypes = skips;
      }
      // WS4 — declarative dispensability (routing facet). Only `true` is meaningful; false/absent omit it.
      if ((s as any).dispensable === true) def.dispensable = true;
      // Per-column automation policy — invalid values are dropped, never throw.
      const model = coerceModel((s as any).model);
      if (model) def.model = model;
      const effort = coerceEffort((s as any).effort);
      if (effort) def.effort = effort;
      const maxTurns = Number((s as any).maxTurns);
      if (Number.isFinite(maxTurns) && maxTurns > 0) def.maxTurns = Math.floor(maxTurns);
      if (typeof (s as any).costGuard === "boolean") def.costGuard = (s as any).costGuard;
      if ((s as any).mcpConfig != null && String((s as any).mcpConfig).trim())
        def.mcpConfig = String((s as any).mcpConfig).trim();
      // WS3 (F2) — the declarative toolkit facet (drops to undefined when empty/off-shape).
      const toolkit = coerceToolkit((s as any).toolkit);
      if (toolkit) def.toolkit = toolkit;
      if ((s as any).description != null) def.description = String((s as any).description);
      return def;
    })
    .filter((s) => s.id);
}

function coerceNamed(raw: unknown): { id: string; name: string; color?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  if (!id) return null;
  const out: { id: string; name: string; color?: string } = { id, name: String(r.name ?? id) };
  if (r.color != null) out.color = String(r.color);
  return out;
}

export function coercePersonas(raw: unknown): Persona[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => {
      const base = coerceNamed(p);
      if (!base) return null;
      const r = p as Record<string, unknown>;
      const persona: Persona = { ...base };
      // The persona-as-system-prompt (primary representation, story personas-as-prompt). Coerced FIRST
      // so it round-trips; the structured fields below stay for back-compat/migration.
      if (r.prompt != null) persona.prompt = String(r.prompt);
      // O TIPO da persona ("Segmento de mercado" × "Interna") — o mesmo conceito que `SystemDef.kind`
      // logo abaixo, e o que agrupa a listagem. Ele FALTAVA aqui, e a falta era invisível de todos os
      // outros lados: o campo estava no tipo, estava no schema Zod (que é ALARME de drift, log-only,
      // não o leitor) e a gravação o escrevia direitinho — mas TODA leitura o descartava, então o
      // próximo read-modify-write o apagava do disco. Sintoma: o agente classificou 7 personas, as 7
      // gravações responderam ok, e sobrou 1. Campo novo de vocabulário precisa das TRÊS portas:
      // tipo (types.ts) + schema (contracts.ts) + ESTA coerção.
      if (r.kind != null) persona.kind = String(r.kind);
      if (r.role != null) persona.role = String(r.role);
      if (r.description != null) persona.description = String(r.description);
      const jobs = coerceStringArray(r.jobs);
      const pains = coerceStringArray(r.pains);
      const gains = coerceStringArray(r.gains);
      if (jobs.length) persona.jobs = jobs;
      if (pains.length) persona.pains = pains;
      if (gains.length) persona.gains = gains;
      // O AVATAR (a imagem do token de ator no mapa) caía na MESMA armadilha do `kind`, e era ANTERIOR
      // a ele: quem definia o avatar de uma persona o perdia no primeiro save de qualquer outro campo
      // dela — o upload dizia "pronto", a imagem aparecia, e sumia no próximo toque. Achado pela
      // guarda de round-trip COMPLETO no teste, não por alguém reclamando; é o argumento inteiro para
      // aquela guarda existir em vez de um teste por campo.
      if (r.avatar != null) persona.avatar = String(r.avatar);
      return persona;
    })
    .filter((p): p is Persona => p !== null);
}

export function coerceSystems(raw: unknown): SystemDef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      const base = coerceNamed(s);
      if (!base) return null;
      const r = s as Record<string, unknown>;
      const sys: SystemDef = { ...base };
      // The system-as-prompt (primary representation). Coerced FIRST so it round-trips; the structured
      // fields below stay for back-compat/migration.
      if (r.prompt != null) sys.prompt = String(r.prompt);
      if (r.description != null) sys.description = String(r.description);
      if (r.kind != null) sys.kind = String(r.kind);
      const capabilities = coerceStringArray(r.capabilities);
      const constraints = coerceStringArray(r.constraints);
      if (capabilities.length) sys.capabilities = capabilities;
      if (constraints.length) sys.constraints = constraints;
      // Drift-detection anchors (story system-resync): the code globs + the SHA the prompt was synced at.
      const paths = coerceStringArray(r.paths);
      if (paths.length) sys.paths = paths;
      if (r.syncedCommit != null) sys.syncedCommit = String(r.syncedCommit);
      return sys;
    })
    .filter((s): s is SystemDef => s !== null);
}

export function coerceCard(
  id: string,
  data: Record<string, any>,
  body: string,
  updatedMs?: number,
): Card {
  // Shim de leitura do ADR-066 (`opportunity` → `idea`): um card gravado antes da renomeação traz
  // `type: opportunity` e o bloco sob a chave `opportunity:`. Aceitamos os dois na LEITURA para que
  // nenhum card legado (ou proposal/sidecar antigo) deixe de abrir; a ESCRITA já é só `idea` — então
  // o arquivo se normaliza sozinho no primeiro save. Não remover enquanto houver `opp-*` no disco.
  const rawType = data.type === "opportunity" ? "idea" : data.type;
  const type = (["activity", "step", "story", "idea"].includes(rawType) ? rawType : "story") as CardType;
  const labels = coerceStringArray(data.labels);
  return {
    id,
    type,
    title: data.title != null ? String(data.title) : id,
    // storyType applies to stories only; legacy/missing stories default to "user".
    storyType: type === "story" ? (isStoryType(data.storyType) ? data.storyType : "user") : null,
    // Reopen mode — default "build" (undefined); only "refine"/"fix"/"retire" survive.
    mode: isReopenMode(data.mode) ? data.mode : undefined,
    // Reabertura R1 one-shot override gate (allow-list: dropped on read unless preserved here).
    reopenPending: data.reopenPending === true ? true : undefined,
    refinement: coerceRefinement(data.refinement),
    bugReport: coerceBugReport(data.bugReport),
    retirement: coerceRetirement(data.retirement),
    idea: coerceIdea(data.idea ?? data.opportunity),
    bet: coerceBet(data.bet),
    owner: isOwner(data.owner) ? data.owner : undefined,
    status: data.status != null ? String(data.status) : null,
    // WS6 review fix: collapse an empty/whitespace parent to null (mirrors the `serves` coercion). An
    // empty-string parent is no real placement (no step has id "") yet `parent != null` would let it evade
    // the hasPlacement gate + the unplaced flag + the orphan lint — a silent orphan into construction.
    parent: data.parent != null && String(data.parent).trim() ? String(data.parent).trim() : null,
    // Dual-track attribution override (sparse, delivery stories) — tolerant, mirrors duplicateOf.
    // A dangling/invalid serves survives the read (surfaced by the lint), never throws.
    serves:
      data.serves != null && String(data.serves).trim() ? String(data.serves).trim() : undefined,
    // Per-instance routing override (pipeline-owned) — sparse: null when no skip set is persisted.
    routing: coerceRouting(data.routing),
    release: data.release != null ? String(data.release) : null,
    // SM-02: sparse flag — only retained when explicitly true on disk.
    unplaced: data.unplaced === true ? true : undefined,
    // WS6 (F5): provenance (dedicated enum) + explicit unplaced acknowledgement — both sparse.
    via: isCardProvenance(data.via) ? data.via : undefined,
    unplacedAck: coerceUnplacedAck(data.unplacedAck),
    personas: coerceStringArray(data.personas),
    systems: coerceStringArray(data.systems),
    links: coerceLinks(data.links),
    narrative: coerceNarrative(data.narrative),
    acceptance: coerceStringArray(data.acceptance),
    tasks: coerceTasks(data.tasks),
    rice: coerceRice(data.rice),
    kano: isKanoCategory(data.kano) ? data.kano : null,
    funnelStage: isFunnelStage(data.funnelStage) ? data.funnelStage : null,
    // Prioridade argumentada (reasoning-first) — esparso: só retido quando presente no disco.
    priorityCall: coercePriorityCall(data.priorityCall) ?? undefined,
    // Triage/intake (ADR-056) — optional + lean: only retained when present on disk.
    severity: isBugSeverity(data.severity) ? data.severity : undefined,
    // Bug priority axes (Fase 2) — optional, only retained when present on disk.
    frequency: isBugFrequency(data.frequency) ? data.frequency : undefined,
    hasWorkaround: typeof data.hasWorkaround === "boolean" ? data.hasWorkaround : undefined,
    labels: labels.length ? labels : undefined,
    duplicateOf:
      data.duplicateOf != null && String(data.duplicateOf).trim() ? String(data.duplicateOf).trim() : undefined,
    needsHumanReview: data.needsHumanReview === true ? true : undefined,
    capture: data.capture === true ? true : undefined,
    // D7 — style guide generation container (NOT `capture`; see types.ts Card.container doc).
    container: data.container === "style" ? "style" : undefined,
    questions: coerceQuestions(data.questions),
    techPlanReady: data.techPlanReady === true ? true : undefined,
    wireframeChosen:
      data.wireframeChosen != null && String(data.wireframeChosen) ? String(data.wireframeChosen) : undefined,
    findings: coerceFindings(data.findings),
    reviewedAt: data.reviewedAt != null ? toDateString(data.reviewedAt) : undefined,
    reviewCommit: data.reviewCommit != null ? String(data.reviewCommit) : undefined,
    qaPassed: data.qaPassed === true ? true : undefined,
    qaRanAt: data.qaRanAt != null ? toDateString(data.qaRanAt) : undefined,
    qaCommit: data.qaCommit != null ? String(data.qaCommit) : undefined,
    // D14 — style-guide conformance stamp (WS-3): sparse, only retained when a well-formed stamp is on disk.
    styleGuideCheck: coerceStyleGuideCheck(data.styleGuideCheck),
    // sparse boolean: keep true AND false (false = "declared UI-less" → exempt); anything else → unset.
    hasUiSurface: typeof data.hasUiSurface === "boolean" ? data.hasUiSurface : undefined,
    // Superfície MEDIDA (engine) e o QUE o QA provou — ambos esparsos e tolerantes: um objeto
    // malformado no disco vira `undefined` (= "ninguém mediu"), nunca um veredito inventado.
    uiSurfaceEvidence: coerceUiSurfaceEvidence(data.uiSurfaceEvidence),
    qaEvidence: coerceQaEvidence(data.qaEvidence),
    // ADR-063 (2c): acceptance→spec map — sparse, only retained when a spec-authoring skill wrote it.
    criteriaSpecs: coerceCriteriaSpecs(data.criteriaSpecs),
    commitRange: coerceCommitRange(data.commitRange),
    // WS-5.2: proof-carrying build stamp — sparse, and dropped unless the provenance is one the engine writes.
    buildEvidence: coerceBuildEvidence(data.buildEvidence),
    diffSnapshot: coerceDiffSnapshot(data.diffSnapshot),
    // Fase 4b staged release dates (pipeline-owned) — round-trip the merge train's / release action's stamps.
    stagedAt: data.stagedAt != null ? (toDateString(data.stagedAt) ?? undefined) : undefined,
    releasedAt: data.releasedAt != null ? (toDateString(data.releasedAt) ?? undefined) : undefined,
    // WS1.1 — deployFiredAt is a full ISO TIMESTAMP (minute-granular watchdog), NOT a YYYY-MM-DD date:
    // keep the FULL time (toDateString would truncate it). Date-tolerant: gray-matter's YAML parses an
    // unquoted ISO timestamp in frontmatter into a Date, so accept BOTH a raw string (fresh stamp) and a
    // Date (round-tripped through the .md) — else the watchdog field would be dropped on every read-back.
    deployFiredAt:
      typeof data.deployFiredAt === "string"
        ? data.deployFiredAt
        : data.deployFiredAt instanceof Date
          ? data.deployFiredAt.toISOString()
          : undefined,
    // A EVIDÊNCIA lida pelo deploy-reconcile. O footgun do campo novo tem QUATRO camadas — types, Zod,
    // cardToFrontmatter (write) e ESTE coerce (read) — e esquecer qualquer uma o faz voltar `undefined` para
    // sempre. `releasedSha` é sempre string: um sha só-dígitos ("123456…") seria coagido a número pelo YAML,
    // então normalizamos via String() em vez de checar typeof.
    releasedSha:
      data.releasedSha != null && data.releasedSha !== "" ? String(data.releasedSha) : undefined,
    deployTargets: Array.isArray(data.deployTargets)
      ? data.deployTargets.map((t: unknown) => String(t)).filter(Boolean)
      : undefined,
    // deploy-truth WS-1 — the production PROOF the terminal gate reads. Strict like coerceBuildEvidence:
    // a malformed/hand-authored stamp (empty sha, unknown source, missing at) is DROPPED whole, so
    // frontmatter can never manufacture deploy proof the settle handler didn't measure.
    deployProof: coerceDeployProof(data.deployProof),
    order: typeof data.order === "number" ? data.order : Number(data.order) || 0,
    created: toDateString(data.created),
    updated: toDateString(data.updated),
    // Transient: the file's mtime in epoch ms (set by readCards) — drives the kanban
    // "most-recently-updated on top" sort. Never written back to frontmatter.
    updatedMs,
    body: (body ?? "").trim(),
  };
}

function coerceReleases(raw: unknown): ReleaseDef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const o = r as Record<string, unknown>;
      const def: ReleaseDef = {
        id: String(o.id ?? ""),
        name: String(o.name ?? o.id ?? ""),
        order: typeof o.order === "number" ? o.order : Number(o.order) || 0,
      };
      if (o.outcome != null) def.outcome = String(o.outcome);
      if (o.metric != null) def.metric = String(o.metric);
      return def;
    })
    .filter((r) => r.id);
}

function coerceColumns(raw: unknown): ColumnDef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cols = raw
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const o = c as Record<string, unknown>;
      const def: ColumnDef = {
        id: String(o.id ?? ""),
        name: String(o.name ?? o.id ?? ""),
      };
      if (o.color != null) def.color = String(o.color);
      if (o.owner === "human" || o.owner === "agent" || o.owner === "system") def.owner = o.owner;
      if (o.description != null) def.description = String(o.description);
      if (o.threadSession === true) def.threadSession = true;
      if (o.system === true) def.system = true;
      // Este coerce é uma ALLOWLIST: campo que não é copiado aqui chega ao app como `undefined`
      // mesmo estando escrito no board.yaml e válido no Zod — foi assim que `deploy.surfaces`
      // nasceu inerte. Campo novo em ColumnDef ⇒ uma linha AQUI também.
      if (typeof o.tool === "string" && o.tool.trim()) def.tool = o.tool.trim();
      return def;
    })
    .filter((c) => c.id);
  return cols.length ? cols : undefined;
}

function coerceHeadroom(raw: unknown): BoardConfig["headroom"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const proxyUrl = typeof r.proxyUrl === "string" ? r.proxyUrl.trim() : "";
  return {
    enabled: r.enabled === true,
    proxyUrl: proxyUrl || "http://127.0.0.1:8787",
  };
}

/**
 * Coerce a free-text strategy field (positioning / businessMetric / desiredOutcome) of a board
 * (owner:human — edited via the strategy bench / governance). Declared in BoardConfigSchema but
 * historically DROPPED on read — coerced here so it round-trips (write→read→deep-equal). Tolerant:
 * a blank/whitespace value normalizes to undefined (absent).
 */
export function coerceStrategyText(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  return s === "" ? undefined : s;
}

/**
 * Lean Canvas of a board — block key → the block's ITEMS (owner:human, edited on the bench through
 * governance). The coercion itself lives in the pure kernel (`./canvas`) because the read path, the
 * governance diff and the agent's proposal parser must all agree on ONE shape; re-exported here so
 * the historical import site (`repo.coerceCanvas`) keeps working.
 *
 * It is TOLERANT by design: a board whose YAML still carries the legacy flat string per block is
 * promoted to a single item on read — no board needs migrating before the feature works, and nothing
 * is ever destroyed (the previous coercer did `String(v)`, which would have turned an item list into
 * the literal "[object Object]").
 */
export { coerceCanvas, coerceCanvasTags } from "./canvas";

/**
 * Merge two id-keyed lists for board inheritance (B5): BASE order is preserved; a `board` item
 * with the same id SHALLOW-overrides the base item (board fields win, base fields fill the gaps);
 * a board-only item is appended in order. Items with no string id pass through (board's, then any
 * id-less base ones are kept by position). Pure — operates on the RAW parsed objects.
 *
 * Delegates to gate-core.js's `mergeById` — THE single isomorphic implementation, shared with the
 * pre-write gate hook so the app and the hook resolve the inherited pipeline identically (no drift).
 */
export function mergeRawById(base: unknown, board: unknown): unknown[] {
  return mergeById(base, board);
}

/**
 * WS3 (F2) — merge two id-keyed RECORDS for board inheritance: base fills, a board KEY wins (board's
 * value replaces base's for that id; base-only ids are kept). Returns undefined when NEITHER side is a
 * usable object (so the caller omits the key → byte-identical legacy load). Pure, on RAW parsed objects.
 */
export function mergeRawRecord(base: unknown, board: unknown): Record<string, unknown> | undefined {
  const b = base && typeof base === "object" && !Array.isArray(base) ? (base as Record<string, unknown>) : null;
  const o = board && typeof board === "object" && !Array.isArray(board) ? (board as Record<string, unknown>) : null;
  if (!b && !o) return undefined;
  return { ...(b ?? {}), ...(o ?? {}) };
}

/**
 * Deep-merge a board's RAW config OVER the shared _base template (B5). The base provides the
 * canonical Stage→Step pipeline (statuses/columns) + shared vocabulary; a board on that pipeline
 * declares only its DELTAS (overrides per-id) and supplies its own personas/systems/releases. With
 * no base (`null`) this is the identity on `board`, so a board with no _base — or the whole repo
 * before _base exists — loads exactly as before.
 *
 * PIPELINE OPT-OUT (`inheritPipeline: false`): a board whose pipeline is a different GENERATION
 * pending migration (the product boards before Fase 5 adopt the canonical Stage→Step pipeline) OWNS
 * its statuses+columns outright — no union with _base, no fallback to it — so it resolves
 * byte-identically to the pre-_base load. Default (unset/true) = the delta-merge above. The flag
 * gates ONLY the pipeline; vocab stays board-wins-else-base regardless.
 */
export function mergeRawConfig(base: Record<string, unknown> | null, board: Record<string, unknown>): Record<string, unknown> {
  if (!base) return board;
  const inheritsPipeline = board.inheritPipeline !== false;
  return {
    ...base,
    ...board,
    // pipeline: inherit (base order + per-id board overrides + board-only steps appended) OR, when
    // the board opts out, the board's OWN pipeline outright (undefined when it declares none).
    statuses: inheritsPipeline ? mergeRawById(base.statuses, board.statuses) : board.statuses,
    columns: inheritsPipeline ? mergeRawById(base.columns, board.columns) : board.columns,
    // WS3 (F2) — toolConfigs is a Record keyed by id: MERGE by key (base fills, a board key wins). A
    // board can add/override individual capabilities without dropping _base's (unlike the wholesale vocab
    // replace). Absent on both sides → undefined (no key emitted → byte-identical legacy load).
    toolConfigs: mergeRawRecord(base.toolConfigs, board.toolConfigs),
    // WS4 — routeProfiles REFERENCE pipeline steps, so they follow the pipeline opt-out: an inheriting board
    // gets _base's profiles (merged by key); an opt-out board (owns its pipeline) OWNS its profiles outright
    // (undefined when it declares none) — else it would inherit an `express` skip list naming steps its own
    // pipeline doesn't have. `specialists` is a pipeline-agnostic agent REGISTRY → inherit for all boards
    // (merged by key), harmless when a board's steps reference none.
    routeProfiles: inheritsPipeline ? mergeRawRecord(base.routeProfiles, board.routeProfiles) : board.routeProfiles,
    specialists: mergeRawRecord(base.specialists, board.specialists),
    // board-specific vocab: a board's own list wins outright; otherwise inherit the base's.
    releases: board.releases ?? base.releases,
    personas: board.personas ?? base.personas,
    systems: board.systems ?? base.systems,
    linkTypes: board.linkTypes ?? base.linkTypes,
  };
}

/**
 * AS DUAS CLASSES DE RECUSA de `_base/board.yaml` — a distinção É o controle, e é por isso que ela
 * está escrita como tabela EXAUSTIVA (`satisfies`): um `FrontmatterRejection` novo não compila até
 * alguém decidir em qual classe ele cai, em vez de silenciosamente herdar a mais frouxa.
 *
 *  - `controle`  → o chokepoint recusou por um TETO/GUARD de segurança (volume, alias bomb,
 *    profundidade, chave que sequestra protótipo, engine que executa o arquivo). Aqui o modo de falha
 *    NÃO pode ser "os gates desaparecem": se degradasse, o atacante escolheria o payload que desliga o
 *    guard. FAIL-CLOSED — a leitura do board lança.
 *  - `digitacao` → o YAML está TORTO (typo de indentação, mapa que virou lista). É erro HUMANO num
 *    arquivo que agentes e skills editam todo dia, não ataque — e derrubar TODOS os boards da UI por
 *    uma indentação (com a mensagem ERRADA, "board não encontrado", porque `listBoards` pula e
 *    `getBoard` devolve null) transforma um typo em incidente. FAIL-DEGRADADO na LEITURA.
 *
 * Honestidade sobre o alcance: um `_base` VÁLIDO e hostil (todo `gate:` removido) não é detectável por
 * parser nenhum — logo o valor do fail-closed acima não é "impedir a remoção de gates", é "uma recusa
 * por controle de segurança nunca pode ser indistinguível de ausência". Arquivo torto é outra coisa.
 */
const BASE_REFUSAL_CLASS = {
  "too-large": "controle",
  "too-many-nodes": "controle",
  "too-deep": "controle",
  "forbidden-key": "controle",
  "engine-forbidden": "controle",
  "invalid-yaml": "digitacao",
  "not-a-map": "digitacao",
} as const satisfies Record<FrontmatterRejection, "controle" | "digitacao">;

function baseRefusalClass(err: FrontmatterError): "controle" | "digitacao" {
  return BASE_REFUSAL_CLASS[err.reason] ?? "controle"; // motivo desconhecido = trate como controle
}

let _baseRawCache: { mtimeMs: number; raw: Record<string, unknown> | null; rejection?: FrontmatterError } | null = null;
/**
 * O último `_base` que PARSEOU — o que a degradação por typo serve no lugar dos bytes tortos.
 *
 * Sem isto a alternativa para um typo seria "sem herança", e aí um erro de digitação faria todo board
 * resolver o PRÓPRIO pipeline, sem os gates que só existem no `_base`: um downgrade silencioso
 * disparado por uma vírgula. Servir o último parse bom mantém a UI viva E os gates de pé, com o
 * alarme alto por cima. É ZERADO quando o arquivo é REMOVIDO: ausência é uma decisão legítima do
 * operador (herança no-op), e servir um base fantasma ali seria inventar config que ninguém declara.
 *
 * Isto é a fonte VOLÁTIL do último-bom, e sozinha ela não bastava: memória de processo morre no
 * restart, que é exatamente quando o typo é descoberto. A fonte DURÁVEL é o snapshot em disco — ver
 * {@link baseLastGoodSnapshotPath}.
 */
let _baseRawLastGood: Record<string, unknown> | null = null;

/** Nome do snapshot do último `_base` bom. Vive em `storymap/.runner/` (estado do runner, gitignorado):
 *  não viaja em PR, não entra no artefato OSS e não é board-data que um contribuidor externo mande. */
const BASE_LAST_GOOD_FILE = "base-board-lastgood.yaml";

/**
 * Onde o último `_base` bom é PERSISTIDO — o que faz a degradação por typo sobreviver a um restart.
 *
 * O buraco que isto fecha: `_baseRawLastGood` é memória de PROCESSO. Num processo FRIO (o restart que
 * um deploy faz, ou o crash de madrugada) não existe último parse bom, então a degradação por typo caía
 * em "sem herança" — a UI seguia plenamente funcional e TODO gate que só vive no `_base` desaparecia,
 * sem nada aparecer no rosto. Era a pior combinação: parece que funciona. Com o snapshot, o restart
 * serve a ÚLTIMA VERSÃO BOA e os gates continuam de pé.
 *
 * O diretório vem de `runnerStateDir()` — a régua única do estado efêmero do runner —, e NUNCA de um
 * `path.join` próprio: aquela função honra `AGILEHARNESS_RUNNER_STATE_DIR`, que o `vitest.setup.ts` aponta
 * SEMPRE para um tmp. Montar o caminho à mão pareceria equivalente e faria toda suíte que lê um board
 * escrever no estado do SERVIÇO VIVO — o exato estrago que o override existe para impedir.
 *
 * O snapshot é uma rede, e uma rede pode FALTAR: a escrita falha aberto (ver {@link persistBaseLastGood}),
 * então uma instalação que já parseou o `_base` pode ficar sem cópia em disco. O que NÃO é aceitável é a
 * combinação "gates sumiram + ninguém viu" — por isso a falha de escrita é `console.error` nomeando a
 * consequência e é RE-TENTADA na leitura seguinte, em vez de esperar a próxima edição do `_base`.
 *
 * EXPORTADO para o teste poder plantar o snapshot que "o boot anterior deixou": o cenário do ataque é
 * justamente o processo novo, e um teste que não consegue montar esse estado não mede nada.
 */
export function baseLastGoodSnapshotPath(): string {
  return path.join(runnerStateDir(), BASE_LAST_GOOD_FILE);
}

/**
 * A rede do último-bom foi PERDIDA? `true` = neste processo uma escrita do snapshot falhou sem haver
 * nenhuma cópia anterior em disco, e nenhuma escrita teve sucesso desde então.
 *
 * A marca é GRUDENTA de propósito: só um persist bem-sucedido a apaga. Um `_base` removido no meio do
 * caminho não conserta disco cheio nem permissão — zerar a marca ali (o que a primeira versão fazia)
 * fazia o alarme do caminho residual voltar a ser ambíguo exatamente no cenário em que ele mais
 * importa, porque a única forma de esvaziar o último-bom da MEMÓRIA é justamente o `_base` desaparecer.
 *
 * Existe porque a falha de escrita é fail-OPEN por desenho (o snapshot é rede, não pré-requisito) — e
 * um fail-open silencioso aqui produz o pior estado do sistema: uma instalação que JÁ parseou o `_base`
 * fica SEM cópia em disco, e o próximo restart com o arquivo torto desliga a herança inteira. Duas
 * coisas dependem desta marca: o alarme do caminho residual, que sem ela chamava de "erro de
 * instalação" o que foi PERDA de uma herança que funcionava, e a re-tentativa de persistência, que
 * impede que uma causa transitória (ENOSPC que passou, corrida entre dois processos, permissão
 * consertada) deixe a instalação sem rede até a próxima edição do `_base`.
 */
let _baseNetLost = false;
/** Quando a última tentativa de persistir falhou — o relógio da janela de re-tentativa. */
let _baseNetRetryAtMs = 0;
/** Janela mínima entre re-tentativas. Impede que a re-tentativa vire ela mesma um write por request
 *  enquanto a causa não passa (o remédio virando o problema). */
const BASE_NET_RETRY_MS = 30_000;

/** A rede foi perdida E a janela de re-tentativa já venceu? */
function deveRetentarRede(): boolean {
  return _baseNetLost && Date.now() - _baseNetRetryAtMs >= BASE_NET_RETRY_MS;
}

/**
 * Persiste os BYTES que acabaram de parsear — nunca o objeto. Reserializar em YAML/JSON introduziria
 * drift silencioso de tipo (uma data de YAML 1.2 voltaria como string), e o snapshot só tem valor se
 * reler dele produzir exatamente o mesmo mapa que o arquivo produzia.
 *
 * Falha de escrita NÃO derruba a leitura do board — o snapshot é uma rede, não um pré-requisito, e
 * transformá-lo em pré-requisito trancaria o operador fora de um board saudável por causa de um disco
 * cheio. Mas ela também não pode passar em silêncio: o que a falha CUSTA é a única cópia que mantém os
 * gates herdados de pé depois de um restart, então o desfecho é `console.error` nomeando a consequência
 * (não o errno) + a marca {@link _baseNetLost}, que faz a leitura seguinte RE-TENTAR.
 */
async function persistBaseLastGood(raw: string): Promise<void> {
  const dest = baseLastGoodSnapshotPath();
  // Lido ANTES do try porque o desfecho da falha depende dele: com um snapshot anterior em disco ainda
  // existe rede (desatualizada); sem nenhum, a instalação está descoberta.
  const anterior = await fs.readFile(dest, "utf8").catch(() => null);
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    if (anterior === raw) {
      _baseNetLost = false; // já é o mesmo byte a byte — a rede existe e está em dia
      return;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // tmp+rename com o pid no nome: dois processos (serviço + um script) podem estar persistindo o mesmo
    // `_base` ao mesmo tempo, e um rename atômico nunca deixa o snapshot meio escrito para o próximo boot.
    await fs.writeFile(tmp, raw, "utf8");
    await fs.rename(tmp, dest);
    _baseNetLost = false;
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {}); // o tmp órfão não acumula a cada re-tentativa
    _baseNetLost = anterior === null;
    _baseNetRetryAtMs = Date.now();
    console.error(
      `[storymap] FALHA AO PERSISTIR o último \`_base\` bom (${dest}) — ` +
        (anterior === null
          ? `a instalação está SEM REDE: se o processo reiniciar enquanto o \`_base\` estiver torto, a herança ` +
            `fica DESLIGADA e os gates que só existem no \`_base\` deixam de ser aplicados a TODOS os boards`
          : `a rede em disco continua na versão ANTERIOR: um restart com o \`_base\` torto vai servir herança ` +
            `DESATUALIZADA`) +
        `: ${describeFrontmatterError(err)}`,
    );
  }
}

/** Apaga o snapshot. Chamado SÓ quando o `_base` desapareceu de verdade: ausência é decisão legítima do
 *  operador (herança no-op), e servir depois um base que alguém apagou seria inventar config. */
async function dropBaseLastGood(): Promise<void> {
  await fs.rm(baseLastGoodSnapshotPath(), { force: true }).catch(() => {});
}

/** ENOENT/ENOTDIR — o arquivo REALMENTE não está lá. Qualquer outro erro de `stat` não é prova de
 *  ausência, e por isso não autoriza destruir o snapshot (o único último-bom que sobrevive ao restart). */
function isMissingPathError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Relê o snapshot pelo MESMO chokepoint do arquivo vivo (teto de bytes antes do read + `parseYamlMap`).
 * Um controle que vale para o `_base` e não vale para a cópia dele é meio controle — e o snapshot é um
 * arquivo em disco como outro qualquer. Snapshot ausente/ilegível → `null` (e aí a degradação volta a ser
 * "sem herança", com o alarme escalado em `readBaseRaw`).
 */
async function readBaseLastGoodSnapshot(): Promise<Record<string, unknown> | null> {
  const src = baseLastGoodSnapshotPath();
  let raw: string;
  try {
    assertStatWithinByteCap((await fs.stat(src)).size, BASE_LAST_GOOD_FILE);
    raw = await fs.readFile(src, "utf8");
  } catch (err) {
    if (!isMissingPathError(err)) {
      console.error(`[storymap] snapshot do último \`_base\` bom ilegível (${src}):`, describeFrontmatterError(err));
    }
    return null;
  }
  try {
    const parsed = parseYamlMap(raw, BASE_LAST_GOOD_FILE);
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch (err) {
    console.error(`[storymap] snapshot do último \`_base\` bom RECUSADO (${src}):`, describeFrontmatterError(err));
    return null;
  }
}

/** O resultado de ler o `_base`: o mapa herdado + se os bytes em disco estão ilegíveis. */
interface BaseRawRead {
  /** o mapa a herdar — `null` = sem herança (ausente, vazio, ou torto sem nenhum parse bom antes). */
  raw: Record<string, unknown> | null;
  /** presente ⇒ os bytes em disco estão TORTOS (classe `digitacao`) e `raw` é o último parse bom (ou null). */
  malformed?: FrontmatterError;
}

/**
 * Read the shared _base template (boards/_base/board.yaml), or null when it doesn't exist. Memoized
 * by MTIME (not forever): _base usually changes only on deploy, but an agent/skill edit or a
 * `git pull` can rewrite it under a long-running server. A forever-cache would then make
 * deriveBoardConfigForPersist diff a save against the STALE base and re-inline now-matching statuses
 * as bogus deltas into board.yaml — re-inlining the canonical pipeline and severing R1 inheritance
 * (the precise restart-footgun this hardens against). Mirrors readFileSettings (runner/config.ts).
 *
 * TRÊS falhas, TRÊS modos — de propósito:
 *  - `_base` AUSENTE → fail-OPEN (`{raw:null}`): estado legítimo (board sem template), herança no-op.
 *  - RECUSA POR CONTROLE (ver {@link BASE_REFUSAL_CLASS}) → fail-CLOSED: LANÇA a
 *    {@link FrontmatterError} nomeada. Antes disto, recusa e ausência viravam o MESMO `null` e todo
 *    board caía no próprio pipeline — possivelmente SEM GATES — em silêncio; pior, o save seguinte
 *    re-inlinava o pipeline canônico e SEVERAVA a herança.
 *  - YAML TORTO → fail-DEGRADADO: NÃO lança (a UI segue viva), serve o último-bom — memória
 *    ({@link _baseRawLastGood}) e, num processo FRIO, o snapshot em disco
 *    ({@link baseLastGoodSnapshotPath}) — e devolve o erro em `malformed` para o caminho de ESCRITA
 *    fechar. O alarme é um `console.error` com arquivo + motivo + a linha/coluna que o js-yaml aponta —
 *    sem isso o operador caça o typo às cegas enquanto a UI diz "board não encontrado". As DUAS fontes
 *    importam: só a memória fazia o restart transformar a degradação em fail-OPEN (herança desligada,
 *    board plenamente funcional, gates herdados sumindo sem ninguém ver).
 * A recusa (das duas classes) é MEMOIZADA junto com o mtime, não só o sucesso: sem isso um `_base` de
 * 500MB seria re-lido e re-recusado a cada request (a recusa viraria ela mesma o DoS) e o alarme do
 * typo sairia uma vez por requisição — ruído é a forma mais comum de um aviso ser ignorado.
 */
async function readBaseRaw(): Promise<BaseRawRead> {
  let mtimeMs = 0;
  let size: number | undefined;
  try {
    const st = await fs.stat(baseBoardConfigPath());
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch (err) {
    _baseRawCache = null;
    _baseRawLastGood = null;
    // O snapshot morre com o arquivo — pelo MESMO motivo que a memória é zerada aqui: ausência é uma
    // decisão do operador, e um base fantasma servido depois seria config que ninguém declarou. Só a
    // ausência COMPROVADA apaga; um `stat` que falhou por outro motivo não é prova e não destrói nada.
    if (isMissingPathError(err)) await dropBaseLastGood();
    // `_baseNetLost` NÃO é zerado aqui: remover o `_base` é decisão do operador, mas não conserta o
    // disco/permissão que fez a escrita falhar — e é este o caminho que esvazia o último-bom da memória,
    // ou seja, o degrau exato antes do modo de falha que a marca existe para explicar. Não há risco de
    // re-tentativa em looping: sem `_base` a leitura retorna aqui, antes do memo que consulta a marca.
    return { raw: null }; // no _base → inheritance is a no-op
  }
  if (_baseRawCache && _baseRawCache.mtimeMs === mtimeMs) {
    const cached = _baseRawCache.rejection;
    // O memo por mtime CEDE num caso só: parse bom em cache e a rede do último-bom comprovadamente em
    // falta. Sem essa exceção, uma falha transitória de escrita ficava congelada até alguém EDITAR o
    // `_base` (é o mtime que invalida o memo) — a instalação atravessava dias sem a única cópia que
    // mantém os gates de pé depois de um restart. Uma recusa memoizada NÃO cede: re-ler um `_base` de
    // 500MB por request faria da recusa o próprio DoS, e re-tentar a rede de um arquivo que não parseia
    // não persistiria nada.
    if (cached || !deveRetentarRede()) {
      if (cached && baseRefusalClass(cached) === "controle") throw cached;
      return cached ? { raw: _baseRawCache.raw, malformed: cached } : { raw: _baseRawCache.raw };
    }
  }
  try {
    // Teto ANTES do read (o `stat` já está feito): um `_base` gigante nunca entra na memória.
    assertStatWithinByteCap(size, "_base/board.yaml");
    const texto = await fs.readFile(baseBoardConfigPath(), "utf8");
    const parsed = parseYamlMap(texto, "_base/board.yaml");
    // Mapa VAZIO ≡ sem herança (o `null` que o `typeof === "object"` de antes já produzia para um
    // arquivo vazio/só-comentário) — mantém a herança um no-op em vez de virar um base `{}` que o
    // deriveBoardConfigForPersist trataria como base real.
    const raw = Object.keys(parsed).length > 0 ? parsed : null;
    _baseRawCache = { mtimeMs, raw };
    _baseRawLastGood = raw;
    // Persistir AQUI (e não no primeiro boot, nem num job) é o que torna "último parse bom" um fato
    // durável em vez de memória de processo: o arquivo só é relido quando o mtime muda, então esta
    // escrita acontece uma vez por versão do `_base`, não por requisição.
    if (raw) await persistBaseLastGood(texto);
    return { raw };
  } catch (err) {
    const rejection =
      err instanceof FrontmatterError
        ? err
        : new FrontmatterError("invalid-yaml", describeFrontmatterError(err), "_base/board.yaml");
    if (baseRefusalClass(rejection) === "controle") {
      // Um `_base` recusado por CONTROLE muda o pipeline resolvido de TODOS os boards: loga E propaga.
      console.error(`[storymap] _base/board.yaml recusado:`, describeFrontmatterError(rejection));
      _baseRawCache = { mtimeMs, raw: null, rejection };
      throw rejection;
    }
    // YAML torto: a leitura DEGRADA e o operador é avisado com o que precisa para consertar. O `raw`
    // degradado entra no cache para o alarme não repetir.
    //
    // A ORDEM das fontes do último-bom é o controle: memória do processo primeiro (é o estado mais
    // recente) e, quando ela está vazia — o processo FRIO, onde a degradação virava fail-open silencioso
    // —, o SNAPSHOT em disco. Sem essa segunda fonte um restart apagava todos os gates herdados sem
    // nenhum sinal no rosto.
    let servido = _baseRawLastGood;
    let origem = "ÚLTIMO PARSE BOM (memória do processo)";
    if (!servido) {
      servido = await readBaseLastGoodSnapshot();
      if (servido) {
        _baseRawLastGood = servido; // vira o último-bom em memória: o processo frio "lembra" a partir de agora
        origem = `ÚLTIMA VERSÃO BOA PERSISTIDA (${BASE_LAST_GOOD_FILE})`;
      }
    }
    console.error(
      servido
        ? `[storymap] _base/board.yaml ILEGÍVEL — herança SERVIDA DO ${origem} ` +
            `e nenhum save de board.yaml será aceito até o arquivo voltar a parsear: ${describeFrontmatterError(rejection)}`
        : // Sem NENHUM último-bom (nem memória, nem disco): a herança fica DESLIGADA e os gates que só
          // existem no `_base` não são aplicados. O desfecho é degradar (a UI viva, com o alarme dizendo
          // em letras o que deixou de valer) em vez de derrubar a leitura: derrubar trocaria um incidente
          // de UI real ("board não encontrado" para TODOS os boards) por zero ganho, já que não há
          // pipeline correta a servir de nenhum dos dois lados.
          //
          // DUAS causas, e o alarme NÃO pode confundi-las (a versão anterior afirmava que só a primeira
          // existia — leitura errada do próprio código, porque `persistBaseLastGood` falha ABERTO):
          //  (a) o `_base` nunca parseou nesta instalação ⇒ erro de INSTALAÇÃO, nada foi perdido;
          //  (b) ele JÁ parseou, mas a escrita do snapshot falhou (disco cheio, permissão, corrida) ⇒
          //      a herança que funcionava foi PERDIDA, e é isso que o operador precisa ler para saber
          //      que o remédio é o disco/permissão, não o YAML. A marca `_baseNetLost` prova (b)
          //      quando a falha aconteceu NESTE processo; num processo frio a distinção não sobrevive,
          //      e por isso o alarme cita as duas.
          `[storymap] _base/board.yaml ILEGÍVEL e SEM último-bom (nem em memória nem em ${BASE_LAST_GOOD_FILE}) — ` +
            `herança DESLIGADA: os gates que só existem no \`_base\` NÃO estão sendo aplicados a nenhum board, ` +
            `e nenhum save de board.yaml será aceito até o arquivo voltar a parsear. ` +
            (_baseNetLost
              ? `CAUSA: a persistência do último \`_base\` bom FALHOU neste processo — a herança que funcionava ` +
                `foi PERDIDA por falha de ESCRITA (disco/permissão), não por instalação nova; conserte o ` +
                `acesso a ${BASE_LAST_GOOD_FILE} além do YAML. `
              : `CAUSA: ou o \`_base\` nunca parseou nesta instalação, ou a escrita do snapshot falhou antes ` +
                `deste processo (disco/permissão) e a herança que funcionava foi perdida. `) +
            `Erro: ${describeFrontmatterError(rejection)}`,
    );
    _baseRawCache = { mtimeMs, raw: servido, rejection };
    return { raw: servido, malformed: rejection };
  }
}

export async function readBoardConfig(boardId: string): Promise<BoardConfig> {
  // Teto ANTES do read (mesma razão do readCards): o teto sobre a string protege o parser, não o read.
  assertStatWithinByteCap(
    (await fs.stat(boardConfigPath(boardId)).catch(() => null))?.size,
    `${boardId}/board.yaml`,
  );
  const raw = await fs.readFile(boardConfigPath(boardId), "utf8");
  // Recusa NOMEADA em vez do `as Record<string, unknown>` de antes: um board.yaml que não é mapa
  // (lista/escalar) passava o cast e resolvia como pipeline VAZIA — falha silenciosa. Agora
  // readBoardConfig rejeita (mesmo desfecho que um YAML malformado sempre teve: getBoard → null).
  const own = parseYamlMap(raw, `${boardId}/board.yaml`);
  return resolveBoardConfigFromOwnRaw(boardId, own);
}

/**
 * O `_base` RESOLVIDO — a pipeline canônica que TODO board novo herda, sem nenhum delta por cima.
 *
 * POR QUE ELE PRECISA DE UMA PORTA PRÓPRIA: `readBoardConfig("_base")` NÃO funciona, e não é descuido —
 * `boardConfigPath` passa o id por `sanitizeId`, que remove o `_`, então a leitura procura
 * `boards/base/board.yaml` e devolve ENOENT. O `_` é justamente o que mantém o template fora do espaço
 * de ids de board (`listBoards` também o pula). O efeito colateral era que o template ficava
 * inalcançável para QUALQUER consumidor — inclusive um que só queira MOSTRAR o que um board novo herda.
 * Esta função entra pelo mesmo resolvedor de `readBoardConfig`, com um delta VAZIO.
 */
export async function readBaseTemplateConfig(): Promise<BoardConfig> {
  return resolveBoardConfigFromOwnRaw("_base", {});
}

/** O corpo compartilhado: pega o raw PRÓPRIO de um board (ou `{}`) e resolve sobre o `_base`. */
async function resolveBoardConfigFromOwnRaw(
  boardId: string,
  own: Record<string, unknown>,
): Promise<BoardConfig> {
  // B5 — inherit the shared _base template (no-op when _base is absent → byte-identical load).
  // Uma recusa por CONTROLE já lançou dentro de readBaseRaw; um YAML torto chega aqui DEGRADADO (último
  // parse bom) de propósito — a leitura de board não morre por um typo, ver BASE_REFUSAL_CLASS.
  const parsed = mergeRawConfig((await readBaseRaw()).raw, own) as Partial<BoardConfig> & { headroom?: unknown };
  // Resolvido ANTES do literal porque duas coisas dependem dele: o campo `release` e o `autorun` do
  // passo `Publicar`, que é DERIVADO daqui em vez de autorado (ver `withDerivedDeployAutorun`).
  const releaseMode = releaseModeOf(parsed as Pick<BoardConfig, "release">);
  const config: BoardConfig = {
    id: parsed.id ?? boardId,
    name: parsed.name ?? boardId,
    package: parsed.package,
    // story-r4qdap — carry the board's extra shared-code packages through to the resolved config so
    // fireReleaseStaged can widen the release pathspec; dropped here it would be a silent no-op field.
    sharedPackages: parsed.sharedPackages,
    // A política de release — a ÚNICA declaração de "quem publica e se publica sozinho". Sem esta
    // linha o campo seria SILENCIOSAMENTE INERTE, o mesmo modo de falha que os três vizinhos aqui
    // já documentam (`deploy`, `sharedPackages`, `faceUrl`).
    release: { mode: releaseMode },
    // Deploy agnóstico (D-AG1) — without this the authored descriptor is silently inert (see coerce).
    deploy: coerceBoardDeploy((parsed as any).deploy),
    brandbook: parsed.brandbook != null ? String(parsed.brandbook) : undefined,
    // A superfície publicada que o canary sonda. Sem esta linha o campo é SILENCIOSAMENTE INERTE: o yaml o
    // declara, o Zod o aceita, o tipo o expõe — e o coerce (whitelist) o descarta, então `faceUrl` chega
    // `undefined` no `resolveFaceUrl`, que cai no default legado e sonda a superfície ERRADA. Foi exatamente
    // o que aconteceu em 2026-07-18: o canary mediu a raiz (outro app), viu um sha antigo e reverteu um card
    // que estava no ar. Mesmo modo de falha que os dois vizinhos aqui já documentam (`deploy`, `sharedPackages`).
    faceUrl: parsed.faceUrl != null ? String(parsed.faceUrl) : undefined,
    statuses: withDerivedDeployAutorun(coerceStatuses(parsed.statuses), releaseMode),
    toolConfigs: coerceToolConfigs((parsed as any).toolConfigs),
    routeProfiles: coerceRouteProfiles((parsed as any).routeProfiles), // WS4
    specialists: coerceSpecialists((parsed as any).specialists), // WS4
    columns: coerceColumns((parsed as any).columns),
    releases: coerceReleases(parsed.releases),
    personas: coercePersonas(parsed.personas),
    systems: coerceSystems(parsed.systems),
    linkTypes: parsed.linkTypes ?? [],
    headroom: coerceHeadroom(parsed.headroom),
    // Strategy bench artifacts (owner:human) — declared in BoardConfigSchema but historically dropped
    // here, which broke the governance round-trip (approve→write→read showed the stale value). Coerced +
    // persisted (deriveBoardConfigForPersist) so the strategy ladder (Posicionamento/Métrica/Resultado-alvo)
    // + Lean Canvas survive a save (SM-strategy).
    positioning: coerceStrategyText(parsed.positioning),
    businessMetric: coerceStrategyText(parsed.businessMetric),
    desiredOutcome: coerceStrategyText(parsed.desiredOutcome),
    canvas: coerceCanvasKernel(parsed.canvas),
    canvasTags: coerceCanvasTagsKernel((parsed as any).canvasTags),
    orchestrator: coerceOrchestrator((parsed as any).orchestrator), // WS8 — copiloto policy (default off)
    // D10 — Style Guide pointer (board-local; absent = no guide yet, byte-identical legacy load).
    styleGuide: coerceStyleGuidePointer((parsed as any).styleGuide),
    // story-fr5bnt per-board autorun kill-switch. D15 field-drop fix: declared in the contract and
    // consumed by autorun-eval, but never carried through this field-by-field build — the resolved
    // config always read undefined, so the kill-switch was DEAD even with the flag set on disk.
    // Conditional spread (not `?? undefined`) so boards without the flag carry no ghost key.
    ...((parsed as any).autorunDisabled === true ? { autorunDisabled: true } : {}),
  };
  // B1 — the Zod contract as a LIVE drift alarm: the coerced config (incl. the _base merge) must
  // satisfy BoardConfigSchema, proven for the real boards by contracts.test. If a bad _base or a
  // malformed board.yaml ever breaks that, surface it LOUDLY — but keep returning the coerced config
  // (log-only; the board never goes dark over a schema nit, the alarm just makes the drift visible).
  const check = parseBoardConfig(config);
  if (!check.ok) {
    console.error(
      `[storymap] board "${boardId}" não conforma ao contrato BoardConfig (B1 drift):`,
      JSON.stringify(check.issues).slice(0, 600),
    );
  }
  return config;
}

/**
 * Compute the RAW (delta) object to PERSIST for a board — the INVERSE of the `_base` inheritance that
 * readBoardConfig applies. The save-back server actions hand writeBoardConfig the FULLY RESOLVED
 * config (readBoardConfig output, with `_base`'s pipeline merged in). Dumping that verbatim would
 * (a) re-inline the entire inherited canonical pipeline into the board.yaml — reverting R1's
 * "authored once" invariant and SEVERING future `_base` propagation (the inlined statuses then
 * shadow `_base` per id) — and (b) DROP an opt-out board's `inheritPipeline:false` (not a BoardConfig
 * field), silently switching it onto the canonical pipeline (the deferred Fase 5). This strips back
 * to the board's genuine deltas so a save ROUND-TRIPS to the same resolved config:
 *   - PRESERVE `inheritPipeline:false` (read from the board's own raw); an opt-out board owns its
 *     pipeline, so persist its statuses/columns in full;
 *   - an inheriting board persists statuses/columns ONLY where they DIFFER from the coerced `_base`
 *     (a real per-id override) or are board-only — identical-to-base entries are omitted (inherited);
 *   - persist vocab (releases/personas/systems/linkTypes) only when it differs from `_base`'s;
 *   - keep id/name/package/headroom.
 * With no `_base` the config is returned as-is (legacy). Used by writeBoardConfig (the single write
 * chokepoint), so every save action is fixed at once. Comparison is JSON-stringify — valid because
 * both sides go through the SAME deterministic coercion (fixed key order).
 */
export async function deriveBoardConfigForPersist(
  boardId: string,
  config: BoardConfig,
): Promise<Record<string, unknown>> {
  const base = await readBaseRaw();
  // A ESCRITA não degrada, mesmo quando a leitura degrada (ver BASE_REFUSAL_CLASS): sem base legível
  // este cálculo persistiria o config RESOLVIDO inteiro, re-inlinando o pipeline canônico no board.yaml
  // e SEVERANDO a herança — e isso um restart não desfaz, ao contrário de uma leitura degradada. Vale
  // também quando servimos o último parse bom: o delta seria medido contra uma base que já não é a do
  // disco. Fail-closed aqui custa um save adiado; fail-open custa a herança do board.
  if (base.malformed) throw base.malformed;
  const baseRaw = base.raw;
  if (!baseRaw) return { ...config }; // no inheritance → nothing to strip (legacy/byte-identical)

  // The board's OWN raw, to recover authoring-only directives BoardConfig drops (inheritPipeline).
  let ownRaw: Record<string, unknown> = {};
  try {
    ownRaw = parseYamlMap(await fs.readFile(boardConfigPath(boardId), "utf8"), `${boardId}/board.yaml`);
  } catch {
    /* new board with no own raw yet → treat as inheriting */
  }
  const optOut = ownRaw.inheritPipeline === false;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const stripKey = (o: Record<string, unknown>, k: string): Record<string, unknown> => {
    if (!(k in o)) return o;
    const { [k]: _drop, ...rest } = o;
    return rest;
  };

  // audit #9: a per-id delta that keeps ONLY the keys whose value DIFFERS from the coerced base entry
  // (+ always `id`). Persisting the FULL resolved entry (the old behaviour) re-inlined every inherited
  // field into board.yaml, SHADOWING `_base` for that id — so a later canonical change to an untouched
  // field (description/maxTurns/trigger/…) silently never propagated to the board. A board-only entry
  // (no base match) is kept whole. Both sides are coerced (deterministic key order), so per-key JSON
  // compare is valid; re-resolving `{id, <changedKey>}` over `_base` reproduces the same resolved entry.
  const idDelta = <T extends { id: string }>(base: T | undefined, entry: T): T | Record<string, unknown> => {
    if (!base) return entry; // board-only → keep the whole entry
    const d: Record<string, unknown> = { id: entry.id };
    for (const k of Object.keys(entry)) {
      if (k === "id") continue;
      const ev = (entry as Record<string, unknown>)[k];
      if (!eq(ev, (base as Record<string, unknown>)[k])) d[k] = ev;
    }
    return d;
  };

  const out: Record<string, unknown> = { id: config.id, name: config.name };
  if (config.package != null) out.package = config.package;
  if (config.sharedPackages != null) out.sharedPackages = config.sharedPackages; // story-r4qdap — round-trip the shared-code declaration
  if (config.deploy != null) out.deploy = config.deploy; // deploy agnóstico (D-AG1) — a save must not strip the descriptor
  if (config.brandbook != null) out.brandbook = config.brandbook;
  if (config.faceUrl != null) out.faceUrl = config.faceUrl; // um save não pode apagar a superfície declarada
  // `release` só vira delta quando DIFERE do `_base` — persistir sempre re-inlinaria o default em todo
  // board.yaml e cortaria a propagação de uma mudança futura no canônico (audit #9, mesmo raciocínio).
  if (!eq(config.release?.mode, releaseModeOf(baseRaw as Pick<BoardConfig, "release">)))
    out.release = { mode: releaseModeOf(config) };
  if (optOut) out.inheritPipeline = false;

  if (optOut) {
    // Owns its pipeline (does not inherit) → persist in full, exactly as authored.
    out.statuses = config.statuses;
    if (config.columns) out.columns = config.columns;
  } else {
    // Inherits → keep only genuine per-id overrides + board-only steps; drop inherited-unchanged.
    // Each override is reduced to its CHANGED KEYS (idDelta) so it overrides one field without
    // shadowing the rest of the inherited step (audit #9).
    const baseStatuses = coerceStatuses(baseRaw.statuses);
    const statusDeltas = config.statuses
      .filter((s) => {
        const b = baseStatuses.find((x) => x.id === s.id);
        return !b || !eq(b, s);
      })
      .map((s) => idDelta(baseStatuses.find((x) => x.id === s.id), s))
      // O `autorun` do passo `Publicar` é DERIVADO de `release.mode` (withDerivedDeployAutorun), não
      // autorado. Sem esta poda, salvar um board `auto` gravaria `autorun: true` no passo — exatamente
      // a segunda verdade que a derivação existe para eliminar, e ela sobreviveria a uma troca futura
      // do modo (o valor gravado venceria o derivado na próxima leitura? não — mas ficaria mentindo no
      // yaml, que é SPEC e precisa refletir a realidade). Uma entrada que sobra só com `id` some.
      .map((d) => (d.id === DEPLOY_STEP_ID ? stripKey(d as Record<string, unknown>, "autorun") : d))
      .filter((d) => Object.keys(d).length > 1);
    if (statusDeltas.length) out.statuses = statusDeltas;
    const baseColumns = coerceColumns(baseRaw.columns) ?? [];
    const columnDeltas = (config.columns ?? [])
      .filter((c) => {
        const b = baseColumns.find((x) => x.id === c.id);
        return !b || !eq(b, c);
      })
      .map((c) => idDelta(baseColumns.find((x) => x.id === c.id), c));
    if (columnDeltas.length) out.columns = columnDeltas;
  }

  // Vocab — board-wins-else-base: persist only when it differs from the (coerced) base vocab.
  if (!eq(config.releases, coerceReleases(baseRaw.releases))) out.releases = config.releases;
  if (!eq(config.personas, coercePersonas(baseRaw.personas))) out.personas = config.personas;
  if (!eq(config.systems, coerceSystems(baseRaw.systems))) out.systems = config.systems;
  if (!eq(config.linkTypes, baseRaw.linkTypes ?? [])) out.linkTypes = config.linkTypes;

  // WS3 (F2) — toolConfigs (board-level, merged-by-key from _base). Persist ONLY when the resolved
  // record differs from the coerced base's, so an inheriting board that adds no capability of its own
  // omits it (inherited). A board that declares its own entries persists the merged record (v1: whole,
  // not per-id — acceptable since no board overrides _base's codegraph yet; the golden guards _base).
  if (!eq(config.toolConfigs, coerceToolConfigs(baseRaw.toolConfigs))) out.toolConfigs = config.toolConfigs;
  // WS4 — routeProfiles: an OPT-OUT board OWNS its profiles (mergeRawConfig gives it board.routeProfiles
  // ONLY, never _base's), so persist them WHOLE like statuses/columns — a diff-against-base test would drop
  // an opt-out board's profiles that happen to equal _base's, then the opt-out read never re-inherits them
  // (silent data loss — review CONFIRMED). An INHERITING board persists only its delta vs the coerced base.
  if (config.routeProfiles) {
    if (optOut) out.routeProfiles = config.routeProfiles;
    else if (!eq(config.routeProfiles, coerceRouteProfiles(baseRaw.routeProfiles))) out.routeProfiles = config.routeProfiles;
  }
  // specialists inherit for ALL boards (agnostic registry), so the diff-against-base persist is self-consistent.
  if (config.specialists && !eq(config.specialists, coerceSpecialists(baseRaw.specialists)))
    out.specialists = config.specialists;

  if (config.headroom) out.headroom = config.headroom;
  // story-fr5bnt kill-switch — board-local operational flag (never inherited from _base): persist when
  // set, else ANY board.yaml save (vocab/canvas/strategy) silently DELETED the line from disk (D15).
  if (config.autorunDisabled) out.autorunDisabled = true;
  // Strategy bench artifacts (board-local; _base has none) — persist when present so a governance
  // approve / direct edit actually lands on disk and round-trips through readBoardConfig.
  if (config.positioning != null) out.positioning = config.positioning;
  if (config.businessMetric != null) out.businessMetric = config.businessMetric;
  if (config.desiredOutcome != null) out.desiredOutcome = config.desiredOutcome;
  // Canvas: COERCE on the way out, then persist only the blocks that actually hold items — an empty
  // block is `null` in memory and simply ABSENT on disk (no husk keys).
  //
  // The coercion here is not belt-and-braces, it is the chokepoint: an agent's `propose_change` carries
  // `after: z.any()` and applyGovernanceChange sets it verbatim, so a canvas value can reach this
  // function as a raw string (the legacy shape an older agent still "knows"), or as junk. Normalizing
  // it HERE means every road into board.yaml — UI, governance approve, MCP — writes the same shape the
  // reader expects, instead of crashing the approve or writing a husk nobody can read back.
  const canvas = coerceCanvasKernel(config.canvas);
  if (canvas) {
    const blocks = Object.entries(canvas).filter(([, b]) => b != null && b.items.length > 0);
    if (blocks.length > 0) out.canvas = Object.fromEntries(blocks);
  }
  const canvasTags = coerceCanvasTagsKernel(config.canvasTags);
  if (canvasTags) out.canvasTags = canvasTags;
  if (config.orchestrator) out.orchestrator = config.orchestrator; // WS8 — board-local policy (default off)
  // D10 — Style Guide pointer: board-local (never inherited from `_base`), so persisted whole-when-
  // present like orchestrator/autorunDisabled — no base-diff needed. Re-COERCE here (not a raw
  // passthrough): the pointer is wire→disk a fixed point (invariant 7) — the same coercer as the read
  // path runs on the way OUT too, so a stray/malformed value that reached this function some other way
  // than the approve chokepoint (e.g. a governance `after` — deliberately never routed here, but belt
  // and braces) can never wedge a future `readBoardConfig` with junk.
  const styleGuide = coerceStyleGuidePointer(config.styleGuide);
  if (styleGuide) out.styleGuide = styleGuide;
  return out;
}

/**
 * Log-only drift alarm for a card READ off disk — the read-side counterpart to the WRITE check
 * (write.ts) and a mirror of the BoardConfig B1 alarm in readBoardConfig. Cards are the SOURCE OF
 * TRUTH but coerceCard is ~30 hand-rolled `as any` field reads; if its output doesn't satisfy
 * CardSchema, surface it LOUDLY so a coercion regression is visible at the read boundary too (not only
 * when the card is re-saved). NEVER drops the card — parseCard uses safeParse, never throws — so the
 * "a card never vanishes from the board over a schema nit" property holds. contracts.test proves every
 * real card parses clean, so this is silent on current data.
 */
function auditCardOnRead(boardId: string, card: Card): Card {
  const check = parseCard(card);
  if (!check.ok) {
    console.error(
      `[storymap] card "${boardId}/${card.id}" não conforma ao contrato Card (B1 drift):`,
      JSON.stringify(check.issues).slice(0, 600),
    );
  }
  return card;
}

export async function readCards(boardId: string): Promise<Card[]> {
  const dir = cardsDir(boardId);
  const files = (await readDirSafe(dir)).filter((f) => f.endsWith(".md"));
  const results = await Promise.all(
    files.map(async (file) => {
      const full = path.join(dir, file);
      const id = file.replace(/\.md$/, "");
      try {
        // `stat` ANTES do `readFile`, em série (não mais em paralelo): o teto de bytes do chokepoint
        // recebe uma string JÁ materializada, então protege o PARSER e não o READ — um card de 500MB
        // era carregado inteiro para a memória e só então recusado, ou seja, o DoS de volume
        // acontecia antes da recusa. O custo é 2 syscalls em série POR CARD; os cards seguem sendo
        // lidos em paralelo entre si.
        // O mtime, que já vinha daqui, é o sinal de recência que as colunas do kanban ordenam (mais
        // confiável e mais fino que o `updated` do frontmatter — ver Card.updatedMs / byUpdatedDesc).
        const stat = await fs.stat(full).catch(() => null);
        assertStatWithinByteCap(stat?.size, `${boardId}/${id}.md`);
        const raw = await fs.readFile(full, "utf8");
        const { data, content } = parseFrontmatter(raw, `${boardId}/${id}.md`);
        return auditCardOnRead(boardId, coerceCard(id, data as Record<string, any>, content, stat?.mtimeMs));
      } catch (err) {
        // ONE malformed/unreadable card (invalid YAML frontmatter an agent wrote, a
        // file briefly locked) must NOT take the whole board down — a bare Promise.all
        // would reject and getBoard() would return null ("board não encontrado").
        // Skip it (it re-reads fine on its next change) and log which file + why.
        // A recusa do chokepoint (`engine-forbidden`, `too-many-nodes`, …) cai AQUI: o card fica de
        // fora do board com o motivo nomeado no log — é a diferença entre um ataque visível e um card
        // que executa código em silêncio.
        console.error(
          `[storymap] ignorando card ilegível ${boardId}/${id}:`,
          describeFrontmatterError(err),
        );
        return null;
      }
    }),
  );
  return results.filter((c): c is Card => c !== null);
}

/**
 * Read ONE card fresh from disk — the source of truth for a read-modify-write that
 * must not clobber a concurrent writer (see updateCardOnDisk in write.ts). Returns
 * null when the file is absent or unreadable (same tolerance as readCards).
 */
export async function readCard(boardId: string, cardId: string): Promise<Card | null> {
  const full = cardPath(boardId, cardId);
  try {
    // Mesma ordem do readCards e pelo mesmo motivo: acima do teto, os bytes não entram na memória.
    const stat = await fs.stat(full).catch(() => null);
    assertStatWithinByteCap(stat?.size, `${boardId}/${cardId}.md`);
    const raw = await fs.readFile(full, "utf8");
    const { data, content } = parseFrontmatter(raw, `${boardId}/${cardId}.md`);
    return auditCardOnRead(boardId, coerceCard(cardId, data as Record<string, any>, content, stat?.mtimeMs));
  } catch (err) {
    // Mesma tolerância do readCards (ausente/ilegível → null), mas NUNCA muda: uma RECUSA do
    // chokepoint é registrada com o motivo. Um card recusado que desaparecesse sem log deixaria a
    // tentativa de execução (`---js`) invisível para o operador. Ausência de arquivo (ENOENT) é
    // rotina — não polui o log.
    if (!isMissingFile(err)) {
      console.error(`[storymap] card recusado ${boardId}/${cardId}:`, describeFrontmatterError(err));
    }
    return null;
  }
}

/** ENOENT/ENOTDIR — arquivo simplesmente não existe (caminho quente e rotineiro), não é recusa. */
function isMissingFile(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function listBoards(): Promise<BoardSummary[]> {
  const entries = await fs
    .readdir(boardsDir(), { withFileTypes: true })
    .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
  const boards: BoardSummary[] = [];
  for (const e of entries as any[]) {
    if (!e.isDirectory?.()) continue;
    if (typeof e.name === "string" && e.name.startsWith("_")) continue; // _base template, not a board (B5)
    // A directory without a readable board.yaml is NOT a board — skip it so a
    // half-created/empty board folder never poisons the switcher with a target
    // that getBoard() then 404s on (e.g. an abandoned `boards/<x>/` skeleton).
    const cfg = await readBoardConfig(e.name).catch(() => null);
    if (!cfg) continue;
    boards.push({ id: e.name, name: cfg.name });
  }
  boards.sort((a, b) => a.name.localeCompare(b.name));
  return boards;
}

export async function getBoard(boardId: string): Promise<Board | null> {
  try {
    const config = await readBoardConfig(boardId);
    const cards = await readCards(boardId);
    return { config, cards };
  } catch {
    return null;
  }
}
