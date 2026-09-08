// B1 — Zod contracts for the AgileHarness domain. A single TOLERANT schema per core entity
// (Card, BoardConfig + their sub-types) describing the validated/coerced shape. Why Zod here:
// cards and board configs are SPECS edited by humans AND agents (free-form .md/.yaml), and they
// also cross process boundaries (headless runs, the MCP server, SSE). A declared schema gives one
// place that says "this is a valid card" — checkable at any boundary via safeParse, and the source
// the TS types derive from (z.infer) once the migration lands.
//
// DESIGN — the documented `interface Card` in types.ts stays the TYPE + DOCS source (its ~140
// lines of field-level JSDoc are real domain documentation a `z.infer` swap would erase); this
// schema is the RUNTIME VALIDATOR, and the mutual-assignability drift guard (contracts.test.ts)
// keeps the two provably in lockstep — change one and `tsc` forces the other. So a boundary that
// receives an UNKNOWN value (a run-result, an MCP payload, a freshly parsed .md) validates it via
// parseCard/parseBoardConfig below; the typed code keeps the documented interface.
//
// The schemas describe the COERCED shape (post-coerceCard): enums are already valid ids, RICE
// fields are finite-or-null, etc. Enum membership is validated against the SAME id-arrays/guards
// the rest of the app uses (frameworks.ts / types.ts) — no duplicated vocab. (Routing coerceCard's
// per-field coercion THROUGH a tolerant variant of these schemas is a future step; for now coerce
// stays and these prove/validate its output.)

import { z } from "zod";
import {
  isStoryType,
  isKanoCategory,
  isFunnelStage,
  KANO_IDS,
  FUNNEL_IDS,
  STORY_TYPE_IDS,
  IMPROVEMENT_KIND_IDS,
  BUG_SEVERITY_IDS,
  BUG_FREQUENCY_IDS,
  DISPOSITION_IDS,
  REMOVAL_LEVEL_IDS,
  REMOVAL_SCOPE_IDS,
  IDEA_STATUS_IDS,
  EXPERIMENT_STATUS_IDS,
  OWNER_IDS,
} from "./frameworks";
import {
  CARD_TYPES,
  CARD_MODES,
  CARD_PROVENANCES,
  GATE_IDS,
  COLUMN_TRIGGER_IDS,
  MODEL_TIERS,
  EFFORT_LEVELS,
  ENTRY_EFFECTS_IDS,
  REVIEW_LENSES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FAILURE_CLASSES,
  QUESTION_STATUSES,
  QUESTION_MODES,
  ROUTING_DECIDED_BY,
  NODE_KIND_IDS,
  ORCHESTRATOR_MODES,
  RELEASE_MODES,
  RISK_CLASSES,
  RISK_DISPOSITIONS,
} from "./types";

/** A value that must be one of `ids` (a known vocabulary). Output type = the id union, so z.infer
 *  yields the exact branded enum (StoryType, GateId, …) — no duplicated literal lists. */
const oneOf = <T extends string>(ids: readonly T[]) =>
  z.custom<T>((v) => typeof v === "string" && (ids as readonly string[]).includes(v));

// ── leaf / sub-entity schemas ──────────────────────────────────────────────
const CardLinkSchema = z.object({ rel: z.string(), to: z.string() });
const CriterionSpecSchema = z.object({ criterion: z.string(), specPath: z.string().nullable().optional() });
const TaskSchema = z.object({ id: z.string(), title: z.string(), done: z.boolean() });
const RiceSchema = z.object({
  reach: z.number().nullable(),
  impact: z.number().nullable(),
  confidence: z.number().nullable(),
  effort: z.number().nullable(),
});
const StoryNarrativeSchema = z.object({
  role: z.string().nullable(),
  want: z.string().nullable(),
  soThat: z.string().nullable(),
});
const RefinementSchema = z.object({
  brief: z.string(),
  kinds: z.array(oneOf(IMPROVEMENT_KIND_IDS)),
  target: z.string().nullable(),
  screenshot: z.string().nullable(),
  openedAt: z.string().nullable(),
});
const BugReportSchema = z.object({
  brief: z.string(),
  severity: oneOf(BUG_SEVERITY_IDS),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  steps: z.array(z.string()),
  target: z.string().nullable(),
  screenshot: z.string().nullable(),
  // story-cl1mi9: additive multi-image evidence (capture path). Optional so every existing card
  // on disk (which has no `screenshots`) still parses; `screenshot` stays the single primary.
  screenshots: z.array(z.string()).optional(),
  openedAt: z.string().nullable(),
});
const RetirementSchema = z.object({
  brief: z.string(),
  disposition: oneOf(DISPOSITION_IDS),
  level: oneOf(REMOVAL_LEVEL_IDS).nullable(),
  scope: z.array(oneOf(REMOVAL_SCOPE_IDS)),
  target: z.string().nullable(),
  screenshot: z.string().nullable(),
  fromStatus: z.string().nullable(),
  dataDeletionApproved: z.boolean(),
  openedAt: z.string().nullable(),
});
const CardRoutingSchema = z.object({
  skips: z.array(z.string()),
  decidedBy: oneOf(ROUTING_DECIDED_BY),
  decidedAt: z.string(),
  // WS4 — profile label + per-card model/effort ceilings + rationale (all additive/optional).
  profile: z.string().optional(),
  modelCap: oneOf(MODEL_TIERS).optional(),
  effortCap: oneOf(EFFORT_LEVELS).optional(),
  rationale: z.string().optional(),
});
const CommitRangeSchema = z.object({ base: z.string(), head: z.string() });
const DiffSnapshotSchema = z.object({ base: z.string(), mergeCommit: z.string() });
const FindingSchema = z.object({
  id: z.string(),
  lens: oneOf(REVIEW_LENSES),
  severity: oneOf(FINDING_SEVERITIES),
  title: z.string(),
  detail: z.string().optional(),
  file: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  suggestion: z.string().optional(),
  status: oneOf(FINDING_STATUSES),
  failureClass: oneOf(FAILURE_CLASSES).optional(),
  // WS-2 (2.3): authorship of the last status change — sparse (absent = never triaged). Forensic only:
  // it rides along with its element in the element-level merge, it never arbitrates it.
  statusBy: z.string().optional(),
  statusAt: z.string().optional(),
});

/**
 * The AUTHORABLE subset of a Finding — the exact shape a harness-review lens sub-agent emits in its
 * `finding-batch` JSON block: `{ lens, severity, title, detail?, file?, line?, suggestion? }`. It
 * OMITS `id` and `status`, which the board assigns on upsert (stable per-runId id; `status: open`) —
 * the sub-agent never authors them.
 *
 * Unlike `FindingSchema` (which validates the COERCED, post-`coerceFindings` shape and is part of the
 * tolerant general read path), this is the STRICT cooperative gate: `.strict()` rejects any extra key
 * so a typo/hallucinated field can't slip through silently. It reuses the SAME `oneOf(REVIEW_LENSES)`/
 * `oneOf(FINDING_SEVERITIES)` enums as `FindingSchema` — no duplicated vocab. The runtime validator is
 * `parseFindingBatch` (runner/findings.ts); the skill prose mirrors it cooperatively.
 */
export const FindingBatchItemSchema = z
  .object({
    lens: oneOf(REVIEW_LENSES),
    severity: oneOf(FINDING_SEVERITIES),
    title: z.string().min(1),
    detail: z.string().optional(),
    file: z.string().nullable().optional(),
    line: z.number().nullable().optional(),
    suggestion: z.string().optional(),
    failureClass: oneOf(FAILURE_CLASSES).optional(),
  })
  .strict();

/** A single sub-agent-authored finding (the `finding-batch` block element) — `id`/`status` excluded. */
export type FindingBatchItem = z.infer<typeof FindingBatchItemSchema>;

const QuestionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
  recommended: z.boolean().optional(),
});
const CardQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  askedBy: z.string().optional(),
  askedAt: z.string().optional(),
  status: oneOf(QUESTION_STATUSES),
  answer: z.string().optional(),
  answeredAt: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
  mode: oneOf(QUESTION_MODES).optional(),
  selectedOptionIds: z.array(z.string()).optional(),
  context: z.string().optional(),
  recommendation: z.string().optional(),
});

// ── OST schemas ───────────────────────────────────────────────────────────
// Prioridade argumentada (reasoning-first) — o sinal primário que substitui o alcance×impacto.
const FibSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);
/** Os ordinais WSJF que sustentam o rank — sub-bloco ADITIVO (ver lib/storymap/wsjf.ts). */
const WsjfCallSchema = z.object({
  value: FibSchema,
  urgency: FibSchema,
  unlock: FibSchema,
  size: FibSchema,
  basis: z.array(z.string()),
  cohortSize: z.number(),
  cohortAt: z.string(),
});
const PriorityCallSchema = z.object({
  rank: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  rationale: z.string(),
  riskiestAssumption: z.string().nullable().optional(),
  source: z.enum(["agent", "human"]),
  assessedAt: z.string(),
  wsjf: WsjfCallSchema.nullable().optional(),
});
const IdeaFieldsSchema = z.object({
  // personas live on Card.personas (single source of truth) — not duplicated here.
  statement: z.string(),
  evidence: z.string().nullable(),
  status: oneOf(IDEA_STATUS_IDS),
  discardReason: z.string().nullable().optional(),
  // OST light (Fatia 2) — sparse/optional, backward-compatible with legacy idea cards.
  candidateSolutions: z.array(z.string()).optional(),
  keyAssumption: z.string().nullable().optional(),
  successSignal: z.string().nullable().optional(),
  valueSize: z.object({ reach: z.number().nullable(), impact: z.number().nullable() }).nullable().optional(),
  priorityCall: PriorityCallSchema.nullable().optional(),
});
const BetSchema = z.object({
  assumptions: z.array(z.string()),
  riskiestAssumption: z.string().nullable(),
  experimentStatus: oneOf(EXPERIMENT_STATUS_IDS),
});

// ── Card ───────────────────────────────────────────────────────────────────
export const CardSchema = z.object({
  id: z.string(),
  type: oneOf(CARD_TYPES),
  title: z.string(),
  storyType: oneOf(STORY_TYPE_IDS).nullable(),
  mode: oneOf(CARD_MODES).optional(),
  reopenPending: z.boolean().optional(),
  refinement: RefinementSchema.nullable().optional(),
  bugReport: BugReportSchema.nullable().optional(),
  retirement: RetirementSchema.nullable().optional(),
  idea: IdeaFieldsSchema.nullable().optional(),
  bet: BetSchema.nullable().optional(),
  owner: oneOf(OWNER_IDS).nullable().optional(),
  status: z.string().nullable(),
  parent: z.string().nullable(),
  serves: z.string().nullable().optional(),
  routing: CardRoutingSchema.nullable().optional(),
  release: z.string().nullable(),
  unplaced: z.boolean().optional(),
  via: oneOf(CARD_PROVENANCES).optional(), // WS6 (F5) — creation provenance
  unplacedAck: z.object({ by: z.string(), at: z.string() }).optional(), // WS6 (F5) — explicit "sem lugar" ack
  personas: z.array(z.string()),
  systems: z.array(z.string()),
  links: z.array(CardLinkSchema),
  narrative: StoryNarrativeSchema,
  acceptance: z.array(z.string()),
  tasks: z.array(TaskSchema),
  rice: RiceSchema,
  kano: oneOf(KANO_IDS).nullable(),
  funnelStage: oneOf(FUNNEL_IDS).nullable(),
  priorityCall: PriorityCallSchema.nullable().optional(),
  severity: oneOf(BUG_SEVERITY_IDS).nullable().optional(),
  frequency: oneOf(BUG_FREQUENCY_IDS).nullable().optional(),
  hasWorkaround: z.boolean().nullable().optional(),
  labels: z.array(z.string()).optional(),
  duplicateOf: z.string().nullable().optional(),
  needsHumanReview: z.boolean().optional(),
  capture: z.boolean().optional(),
  container: z.literal("style").optional(), // D7 — style guide generation container (never `capture`)
  questions: z.array(CardQuestionSchema).optional(),
  techPlanReady: z.boolean().optional(),
  wireframeChosen: z.string().nullable().optional(),
  findings: z.array(FindingSchema),
  reviewedAt: z.string().nullable().optional(),
  reviewCommit: z.string().nullable().optional(),
  qaPassed: z.boolean().optional(),
  qaRanAt: z.string().nullable().optional(),
  qaCommit: z.string().nullable().optional(),
  // D14 — style-guide conformance stamp (WS-3); mutually assignable with the hand-written inline
  // Card.styleGuideCheck type (types.ts) — keep this shape exactly in lockstep by hand.
  styleGuideCheck: z
    .object({ version: z.number(), hash: z.string(), passed: z.boolean(), at: z.string() })
    .optional(),
  hasUiSurface: z.boolean().optional(),
  // Superfície de UI MEDIDA pelo engine sobre o diff do run (types.ts UiSurfaceEvidence); mantenha o
  // shape em lockstep à mão. Escrita SÓ pelo engine que tem o diff — nunca por agente/drawer.
  uiSurfaceEvidence: z
    .object({
      touched: z.boolean(),
      at: z.string(),
      paths: z.array(z.string()).optional(),
      runId: z.string().optional(),
    })
    .optional(),
  // O QUE o carimbo de QA provou (types.ts QaEvidence): suíte e/ou tela. Existe porque `qaPassed`
  // sozinho não distingue "vitest verde" de "alguém olhou a tela".
  qaEvidence: z
    .object({
      suite: z.boolean().optional(),
      visual: z.boolean().optional(),
      at: z.string(),
      by: z.string().optional(),
    })
    .optional(),
  criteriaSpecs: z.array(CriterionSpecSchema).optional(),
  commitRange: CommitRangeSchema.nullable().optional(),
  // WS-5.2 — proof-carrying build stamp (types.ts BuildEvidence); keep the shape in lockstep by hand.
  // Written ONLY by the engine holding a `deltaLanded === "landed"` proof — never by an agent/tool.
  buildEvidence: z
    .object({
      provenance: z.literal("already-landed"),
      at: z.string(),
      range: z.string().optional(),
      target: z.string().optional(),
      runId: z.string().optional(),
    })
    .optional(),
  diffSnapshot: DiffSnapshotSchema.optional(),
  stagedAt: z.string().optional(),
  releasedAt: z.string().optional(),
  releasedSha: z.string().optional(), // sha de main que PROVA o código promovido (deploy-reconcile)
  deployTargets: z.array(z.string()).optional(), // alvos de product-deploy que tornam este card vivo
  deployFiredAt: z.string().optional(), // WS1.1 — ISO ts the deploy fired but hasn't settled
  // deploy-truth WS-1 — server-stamped production proof (types.ts DeployProof); keep the shape in
  // lockstep by hand. Written ONLY by the settle/reconcile handlers holding an ancestry measurement.
  deployProof: z
    .object({
      sha: z.string(),
      targets: z.array(z.string()),
      at: z.string(),
      source: z.enum(["settle-webhook", "registry-ondone", "reconcile-evidence"]),
    })
    .optional(),
  order: z.number(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  updatedMs: z.number().optional(),
  body: z.string(),
});

// ── BoardConfig ──────────────────────────────────────────────────────────────
const NamedColorShape = { id: z.string(), name: z.string(), color: z.string().optional() };

// WS3 (F2) — declarative toolkit facets. Additive: every field optional, so a board.yaml with no
// toolkit/toolConfigs validates unchanged (byte-identical legacy load).
const ToolConfigDefSchema = z.object({
  mcp: z.string().optional(),
  match: z.string().optional(),
  cli: z.string().optional(),
  description: z.string().optional(),
  // CAPABILITY CONTRACT (declare → prove → degrade). Additive: a board with none of these validates
  // unchanged. `provides` is free-form so a consumer names its own capabilities with zero code here.
  provides: z.string().optional(),
  probe: z.string().optional(),
  probeTimeoutMs: z.number().int().positive().optional(),
  fallback: z.string().optional(),
  // Quarta perna do contrato: este provedor trabalha FORA da jaula do run (ver ToolConfigDef). É
  // DECLARAÇÃO, não medição — alcançabilidade é propriedade da CHAMADA, não do host, e por isso
  // nenhum probe pode respondê-la.
  outsideRunSandbox: z.boolean().optional(),
});
const StepToolkitSchema = z.object({
  use: z.array(z.string()).optional(),
  expect: z
    .array(
      z.object({
        tool: z.string(),
        level: z.enum(["required", "expected", "advisory", "off"]),
        when: z.enum(["uiSurface"]).optional(),
      }),
    )
    .optional(),
  guidance: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  specialists: z.array(z.string()).optional(),
});
// WS4 — routing profiles + specialist registry. Additive: a board.yaml with neither validates unchanged.
const RouteProfileSchema = z.object({
  skips: z.array(z.string()),
  modelCap: oneOf(MODEL_TIERS).optional(),
  effortCap: oneOf(EFFORT_LEVELS).optional(),
  description: z.string().optional(),
});
const SpecialistDefSchema = z.object({
  agent: z.string(),
  when: z.string(),
});

const StatusDefSchema = z.object({
  ...NamedColorShape,
  short: z.string().optional(),
  gate: oneOf(GATE_IDS).optional(),
  trigger: oneOf(COLUMN_TRIGGER_IDS).optional(),
  autorun: z.boolean().optional(),
  terminal: z.boolean().optional(),
  delivered: z.boolean().optional(), // subconjunto ESTRITO de terminal — "no ar" (ver delivered.ts)
  autoEnterTerminal: z.boolean().optional(),
  laneStep: z.boolean().optional(),
  hidden: z.boolean().optional(),
  staging: z.boolean().optional(),
  column: z.string().optional(),
  skipForTypes: z.array(oneOf(STORY_TYPE_IDS)).optional(),
  dispensable: z.boolean().optional(), // WS4 — declarative dispensability (routing facet; never on load-bearing)
  onEnter: oneOf(ENTRY_EFFECTS_IDS).optional(),
  model: oneOf(MODEL_TIERS).optional(),
  effort: oneOf(EFFORT_LEVELS).optional(),
  maxTurns: z.number().optional(),
  costGuard: z.boolean().optional(),
  mcpConfig: z.string().optional(),
  toolkit: StepToolkitSchema.optional(),
  description: z.string().optional(),
});
const ColumnDefSchema = z.object({
  ...NamedColorShape,
  owner: z.enum(["human", "agent", "system"]).optional(),
  description: z.string().optional(),
  threadSession: z.boolean().optional(),
  system: z.boolean().optional(),
  /** id da view do board que aprofunda esta fase — vira a porta no cabeçalho da coluna. Ver ColumnDef.tool. */
  tool: z.string().optional(),
});
const PersonaSchema = z.object({
  ...NamedColorShape,
  prompt: z.string().optional(),
  /** Tipo da persona ("Segmento de mercado" / "Interna") — agrupa a listagem, como `kind` no sistema. */
  kind: z.string().optional(),
  role: z.string().optional(),
  description: z.string().optional(),
  jobs: z.array(z.string()).optional(),
  pains: z.array(z.string()).optional(),
  gains: z.array(z.string()).optional(),
  /** Avatar image — a public path (/avatars/<board>/<id>.png) or absolute URL; shown as the round actor token. */
  avatar: z.string().optional(),
});
const SystemDefSchema = z.object({
  ...NamedColorShape,
  prompt: z.string().optional(),
  description: z.string().optional(),
  kind: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  syncedCommit: z.string().optional(),
});
const ReleaseDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number(),
  outcome: z.string().optional(),
  metric: z.string().optional(),
});
const LinkTypeDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  from: z.array(oneOf(NODE_KIND_IDS)).optional(),
  to: z.array(oneOf(NODE_KIND_IDS)).optional(),
});

// 🟨 Lean Canvas — a block is a bag of ITEMS, each optionally tagged with the board's canvas
// vocabulary (CanvasTag). A legacy flat string block is promoted to one item by coerceCanvas BEFORE
// the config reaches this schema, so the contract only ever sees the structured shape.
const CanvasItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  tags: z.array(z.string()).optional(),
  group: z.string().nullable().optional(),
  highlight: z.boolean().optional(),
});
const CanvasBlockSchema = z.object({
  items: z.array(CanvasItemSchema),
});
const CanvasTagSchema = z.object({ ...NamedColorShape });

// D10 — the board.yaml Style Guide pointer. Path-free (version+hash only); z.infer must stay mutually
// assignable with the hand-written `StyleGuidePointer` interface (style-guide.ts) — the contracts.test
// drift guard covers BoardConfig as a whole, so keep this shape exactly in lockstep by hand.
const StyleGuidePointerSchema = z.object({
  version: z.number(),
  hash: z.string(),
  updatedAt: z.string().optional(),
});

// Deploy agnóstico (D-AG1) — the board's optional deploy DESCRIPTOR (types.ts BoardDeployConfig; keep the
// shape in lockstep by hand — the contracts.test drift guard covers BoardConfig as a whole). Additive:
// absent ⇒ byte-identical legacy load/routing. The refine turns a half-declared block into a LEGIBLE
// config error at the validation boundary (parseBoardConfig) instead of a silent no-op deploy at runtime:
// a kind that names a mechanism must carry that mechanism's one required field.
// The SHAPE is exported (not just the refined schema) so a lockstep test can assert coerceBoardDeploy
// (repo.ts) covers EVERY field declared here — the guard against the "declared but inert" regression:
// a schema field the hand-written coercer forgets is silently dropped on read (that is how deploy.surfaces
// went inert, tripping the release out-of-scope revert). New field here ⇒ coercer + that test, or CI reds.
export const boardDeployConfigShape = {
  kind: z.enum(["auto", "command", "agent"]).optional(),
  command: z.string().optional(),
  description: z.string().optional(),
  healthUrl: z.string().optional(),
  canaryCommand: z.string().optional(),
  timeoutMinutes: z.number().positive().optional(),
  // story-zr1cmf — deployable surfaces outside `package`: each `prefix` routed to stage by the split
  // (must also be in staging.codePrefixes — lint) + an optional `deployCmd` published by the self-deploy.
  surfaces: z
    .array(z.object({ prefix: z.string().min(1), deployCmd: z.string().optional() }))
    .optional(),
};
// EXPORTADO (e não só a SHAPE, que já era) porque o registro de um board novo — `board-registry.ts` —
// precisa do schema COM o superRefine para RECUSAR um descritor meio-declarado. É o único ponto da
// árvore onde esse refine morde de verdade num board que ainda não existe: `writeBoardConfig` não
// valida, e o alarme de contrato em `readBoardConfig` é log-only por desenho. Exportar o schema em vez
// de reimplementar a regra lá é o que impede a régua de virar duas.
export const BoardDeployConfigSchema = z
  .object(boardDeployConfigShape)
  .superRefine((v, ctx) => {
    if (v.kind === "command" && !v.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "deploy.kind=command exige `command` (o shell que publica este app, ex.: \"vercel deploy --prod\")",
      });
    }
    if (v.kind === "agent" && !v.description?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["description"],
        message: "deploy.kind=agent exige `description` (texto livre: como se deploya este app)",
      });
    }
  });

export const BoardConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  package: z.string().optional(),
  sharedPackages: z.array(z.string()).optional(),
  // A ÚNICA declaração da política de release (ausente ⇒ `manual`, o default seguro). O `autorun` do
  // passo `deploy` deriva daqui — ver runner/release-policy.ts e BoardConfig.release.
  release: z.object({ mode: oneOf(RELEASE_MODES) }).optional(),
  // D-AG1 — optional deploy descriptor (absent ⇒ legacy package-derived routing, byte-identical).
  deploy: BoardDeployConfigSchema.optional(),
  brandbook: z.string().optional(),
  /** URL pública da superfície publicada por este board (o canary sonda ESTA) — ver BoardConfig.faceUrl. */
  faceUrl: z.string().optional(),
  statuses: z.array(StatusDefSchema),
  toolConfigs: z.record(z.string(), ToolConfigDefSchema).optional(),
  routeProfiles: z.record(z.string(), RouteProfileSchema).optional(), // WS4
  specialists: z.record(z.string(), SpecialistDefSchema).optional(), // WS4
  columns: z.array(ColumnDefSchema).optional(),
  releases: z.array(ReleaseDefSchema),
  personas: z.array(PersonaSchema),
  systems: z.array(SystemDefSchema),
  linkTypes: z.array(LinkTypeDefSchema),
  headroom: z.object({ enabled: z.boolean(), proxyUrl: z.string() }).optional(),
  positioning: z.string().nullable().optional(),
  businessMetric: z.string().nullable().optional(),
  desiredOutcome: z.string().nullable().optional(),
  canvas: z.record(CanvasBlockSchema.nullable()).nullable().optional(),
  canvasTags: z.array(CanvasTagSchema).nullable().optional(),
  // story-fr5bnt: per-board autorun kill-switch. When true, evaluateAutorunOnEntry never auto-fires a
  // skill on this board (move/accept/cascade) — a human still runs skills manually. Used by `storymap`
  // (the dogfood board). Absent/false = normal autorun.
  autorunDisabled: z.boolean().optional(),
  // WS8 — orchestrator/copiloto policy (mode + riskMatrix). Additive/optional (absent ⇒ mode off).
  orchestrator: z
    .object({
      mode: oneOf(ORCHESTRATOR_MODES),
      maxActionsPerHour: z.number().optional(),
      riskMatrix: z.record(oneOf(RISK_CLASSES), oneOf(RISK_DISPOSITIONS)).optional(),
    })
    .optional(),
  // D10 — Style Guide pointer (additive/optional; absent = board has no guide yet).
  styleGuide: StyleGuidePointerSchema.optional(),
});

/** Inferred shapes — provably ≡ the documented `Card`/`BoardConfig` interfaces (the drift guard in
 *  contracts.test.ts asserts mutual assignability). Used as the helpers' return type. */
export type CardContract = z.infer<typeof CardSchema>;
export type BoardConfigContract = z.infer<typeof BoardConfigSchema>;

/** Validation result: the typed value on success, or the Zod issues on failure. Never throws. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: z.ZodIssue[] };

/**
 * Validate an UNKNOWN value against the card contract — the reusable boundary check for data
 * arriving from another system (a headless run-result, an MCP payload, a freshly parsed .md)
 * before it is trusted as a Card. Never throws; returns the typed card or the Zod issues.
 */
export function parseCard(input: unknown): ParseResult<CardContract> {
  const r = CardSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: r.error.issues };
}

/** Validate an UNKNOWN value against the board-config contract (e.g. a parsed board.yaml). */
export function parseBoardConfig(input: unknown): ParseResult<BoardConfigContract> {
  const r = BoardConfigSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: r.error.issues };
}
