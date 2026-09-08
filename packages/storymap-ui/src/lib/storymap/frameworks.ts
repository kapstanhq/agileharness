import { OWNER } from "./ownership.js";

// Canonical prioritization frameworks — KANO (satisfaction shape) and the
// AAARRR pirate funnel (business objective). These are FIXED, board-agnostic
// vocabularies (unlike personas/systems/statuses in board.yaml): every board
// classifies with the same categories so humans and agents stay consistent and
// the agent rubric (storymap/frameworks.md) stays stable.
//
// RICE answers "how much bang per buck"; KANO answers "what kind of bet is it"
// (must-have baseline vs linear lever vs delighter); the funnel answers "which
// growth objective does it move" (acquisition … retention/churn … revenue).

export type KanoCategory = "must-be" | "performance" | "attractive" | "indifferent" | "reverse";

export interface KanoDef {
  id: KanoCategory;
  /** PT-BR display name */
  name: string;
  /** one-line meaning */
  short: string;
  /** what to do with stories in this category */
  action: string;
  color: string;
}

// Ordered from foundational → delight → cut. The lanes view renders in this order.
export const KANO_CATEGORIES: KanoDef[] = [
  {
    id: "must-be",
    name: "Must-be / Básico",
    short: "Esperado: a ausência irrita, a presença não encanta.",
    action: "Garanta todos — é o piso de qualidade.",
    color: "#cc8585",
  },
  {
    id: "performance",
    name: "Performance / Linear",
    short: "Quanto melhor, mais satisfação (proporcional).",
    action: "Invista para competir; priorize por RICE.",
    color: "#7e9ac2",
  },
  {
    id: "attractive",
    name: "Attractive / Encantador",
    short: "Surpreende; a ausência não frustra.",
    action: "Diferencie com alguns — gera encantamento e fidelidade.",
    color: "#b08fc0",
  },
  {
    id: "indifferent",
    name: "Indiferente",
    short: "Presença ou ausência não muda a satisfação.",
    action: "Evite investir — não move a agulha.",
    color: "#8f99a8",
  },
  {
    id: "reverse",
    name: "Reverso",
    short: "Pode atrapalhar / irritar se presente ou exagerado.",
    action: "Remova ou repense.",
    color: "#9d9488",
  },
];

export const KANO_BY_ID: Record<KanoCategory, KanoDef> = Object.fromEntries(
  KANO_CATEGORIES.map((k) => [k.id, k]),
) as Record<KanoCategory, KanoDef>;

// AAARRR pirate funnel (Dave McClure + leading Awareness). Churn ↔ Retenção;
// viralidade ↔ Referência.
export type FunnelStage =
  | "awareness"
  | "acquisition"
  | "activation"
  | "retention"
  | "referral"
  | "revenue";

export interface FunnelDef {
  id: FunnelStage;
  name: string;
  short: string;
  color: string;
  /** funnel sequence position */
  order: number;
}

export const FUNNEL_STAGES: FunnelDef[] = [
  { id: "awareness", name: "Consciência", short: "Descobre que o produto existe.", color: "#9889c6", order: 10 },
  { id: "acquisition", name: "Aquisição", short: "Vira usuário (signup, primeiro acesso).", color: "#5fa6a0", order: 20 },
  { id: "activation", name: "Ativação", short: "Tem o primeiro valor (aha moment).", color: "#7daa76", order: 30 },
  { id: "retention", name: "Retenção", short: "Volta e mantém o hábito (anti-churn).", color: "#9bab69", order: 40 },
  { id: "referral", name: "Referência", short: "Convida e traz outros (viral / k-factor).", color: "#c4a261", order: 50 },
  { id: "revenue", name: "Receita", short: "Paga / monetiza.", color: "#c389ab", order: 60 },
];

export const FUNNEL_BY_ID: Record<FunnelStage, FunnelDef> = Object.fromEntries(
  FUNNEL_STAGES.map((f) => [f.id, f]),
) as Record<FunnelStage, FunnelDef>;

export const KANO_IDS = KANO_CATEGORIES.map((k) => k.id);
export const FUNNEL_IDS = FUNNEL_STAGES.map((f) => f.id);

export function isKanoCategory(v: unknown): v is KanoCategory {
  return typeof v === "string" && (KANO_IDS as string[]).includes(v);
}
export function isFunnelStage(v: unknown): v is FunnelStage {
  return typeof v === "string" && (FUNNEL_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Story type (nature of a story) — a FIXED, board-agnostic vocabulary like KANO
// and the funnel. RICE/KANO/funnel answer "how big / what bet / which objective";
// `storyType` answers "what KIND of story is this", which in turn picks the
// WRITING TEMPLATE for the narrative (Connextra for user-facing work; an
// enabler/technical variant for infrastructure that has no direct user face).
// Only `story` cards carry it (activities/steps are backbone, not work units).
// ---------------------------------------------------------------------------

export type StoryType = "user" | "technical" | "spike" | "bug" | "chore";

export interface StoryTypeDef {
  id: StoryType;
  /** PT-BR display name */
  name: string;
  /** one-line meaning */
  short: string;
  /** narrative connectors that frame the three-part template for this type */
  connectors: { role: string; want: string; soThat: string };
  /** canonical one-line template (role · want · soThat joined) for placeholders/docs */
  template: string;
  /**
   * How to phrase the card TITLE for this type. The title names the INTENT/OUTCOME
   * (the problem space), NEVER the mechanism/solution — that belongs to the plan.
   * `form` is the rule, `good`/`bad` a contrasting example. Single source: the
   * harness-capture/harness-enrich prompts mirror it and the UI surfaces it by the title field.
   */
  titleGuide: { form: string; good: string; bad: string };
  color: string;
}

// `user` first: it is the default and dominant kind. The others cover work that
// does NOT fit "Como <usuário> quero…" — infra (technical), research (spike),
// fixes (bug) and maintenance (chore).
export const STORY_TYPE_DEFS: StoryTypeDef[] = [
  {
    id: "user",
    name: "User Story",
    short: "Capacidade voltada ao usuário final (Connextra).",
    connectors: { role: "Como", want: "quero", soThat: "para" },
    template: "Como <persona>, quero <ação/capacidade>, para <benefício>.",
    titleGuide: {
      form: "o objetivo/resultado do usuário (≈ o want condensado), nunca o mecanismo — evite começar com verbo de dev (Criar/Adicionar/Implementar/Refatorar/Redesenhar/Remover/Configurar/Ajustar/Simplificar/Mover)",
      good: "Ler o estado de um run sem entrar em edição",
      bad: "Redesenhar modal com view leitura/edição",
    },
    color: "#7e9ac2",
  },
  {
    id: "technical",
    name: "Técnica",
    short: "Trabalho de infraestrutura que viabiliza valor de produto.",
    connectors: { role: "Para viabilizar", want: "precisamos", soThat: "de modo que" },
    template:
      "Para viabilizar <capacidade/sistema>, precisamos <trabalho técnico>, de modo que <resultado de produto observável>.",
    titleGuide: {
      form: "o resultado de produto que a infra habilita, não a tarefa técnica em si",
      good: "Runs não-UI sobem sem Chrome ocioso (-475MB)",
      bad: "Escopar chrome-devtools MCP — tirar do .mcp.json",
    },
    color: "#9889c6",
  },
  {
    id: "spike",
    name: "Spike",
    short: "Investigação time-boxed para reduzir incerteza antes de construir.",
    connectors: { role: "Para decidir", want: "precisamos investigar", soThat: "de modo que" },
    template:
      "Para decidir <questão>, precisamos investigar <hipótese/abordagem>, de modo que <decisão habilitada>.",
    titleGuide: {
      form: "a decisão/pergunta a responder, não 'spike de X'",
      good: "Decidir se graphify vale no harness-review",
      bad: "Spike de graphify",
    },
    color: "#c4a261",
  },
  {
    id: "bug",
    name: "Bug",
    short: "Correção de comportamento quebrado vs. o esperado.",
    connectors: { role: "Como", want: "quero", soThat: "para" },
    template: "Como <persona>, quero <que X volte a funcionar>, para <benefício restaurado>.",
    titleGuide: {
      form: "o comportamento quebrado na visão do usuário, não o conserto",
      good: "Card arquivado continua aparecendo na coluna",
      bad: "Adicionar filtro no readCards",
    },
    color: "#cc8585",
  },
  {
    id: "chore",
    name: "Chore",
    short: "Manutenção/tarefa sem valor direto de usuário (limpeza, upgrade).",
    connectors: { role: "Para manter", want: "precisamos", soThat: "de modo que" },
    template: "Para manter <área>, precisamos <tarefa>, de modo que <resultado sustentado>.",
    titleGuide: {
      form: "o estado-alvo de saúde/capacidade sustentada, não a tarefa",
      good: "Suíte do storymap roda em < 1 min",
      bad: "Paralelizar o vitest",
    },
    color: "#8f99a8",
  },
];

export const STORY_TYPE_BY_ID: Record<StoryType, StoryTypeDef> = Object.fromEntries(
  STORY_TYPE_DEFS.map((s) => [s.id, s]),
) as Record<StoryType, StoryTypeDef>;

export const STORY_TYPE_IDS = STORY_TYPE_DEFS.map((s) => s.id);

export function isStoryType(v: unknown): v is StoryType {
  return typeof v === "string" && (STORY_TYPE_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Improvement kind (REFINE mode) — what DIMENSION of an already-shipped story a
// refinement targets. Set on the card's `refinement` block by the Refinar action
// and read by the `harness-refine` triage to (a) ROUTE the card to the right entry
// column and (b) pick the deep-skill roster. Board-agnostic fixed vocab, like
// storyType. `routeHint` is the column harness-refine sends this kind into by default
// (visual kinds start at design-ux; text/behaviour kinds at desenvolver).
// ---------------------------------------------------------------------------

export type ImprovementKind = "ui" | "ux" | "copy" | "functionality";

export interface ImprovementKindDef {
  id: ImprovementKind;
  /** PT-BR display name */
  name: string;
  /** one-line meaning */
  short: string;
  /** default entry column harness-refine routes this kind into */
  routeHint: string;
  color: string;
}

export const IMPROVEMENT_KINDS: ImprovementKindDef[] = [
  {
    id: "ui",
    name: "UI / Visual",
    short: "Aparência: cor, tipografia, espaçamento, hierarquia, polish.",
    routeHint: "design-ux",
    color: "#c389ab",
  },
  {
    id: "ux",
    name: "UX / Fluxo",
    short: "Interação e jornada: passos, estados, fricção, clareza.",
    routeHint: "design-ux",
    color: "#9889c6",
  },
  {
    id: "copy",
    name: "Copywriting",
    short: "Texto e voz: microcopy, mensagens, CTA, tom de marca.",
    routeHint: "desenvolver",
    color: "#7e9ac2",
  },
  {
    id: "functionality",
    name: "Funcionalidade",
    short: "Comportamento: regras, capacidade, correção de fluxo.",
    routeHint: "desenvolver",
    color: "#cc8d63",
  },
];

export const IMPROVEMENT_KIND_BY_ID: Record<ImprovementKind, ImprovementKindDef> = Object.fromEntries(
  IMPROVEMENT_KINDS.map((k) => [k.id, k]),
) as Record<ImprovementKind, ImprovementKindDef>;

export const IMPROVEMENT_KIND_IDS = IMPROVEMENT_KINDS.map((k) => k.id);

export function isImprovementKind(v: unknown): v is ImprovementKind {
  return typeof v === "string" && (IMPROVEMENT_KIND_IDS as string[]).includes(v);
}

/**
 * The VISUAL improvement kinds — the ones that need the design block (Jornada → Telas →
 * Aprovar design) because they change WHAT THE USER SEES/DOES. `copy`/`functionality` are
 * TEXT/BEHAVIOUR kinds: they change wording or rules, with no wireframe to design. This is
 * the SINGLE SOURCE for the visual/non-visual partition the instance-aware skip router
 * (skip-routing.ts) keys off — so the "refine+functionality skips design, refine+ui keeps it"
 * rule stays data-driven, not a magic literal. Mirrors `routeHint: "design-ux"` (visual kinds
 * start at the design block) vs `routeHint: "desenvolver"` (text/behaviour kinds skip it).
 */
export const VISUAL_IMPROVEMENT_KINDS: ImprovementKind[] = ["ui", "ux"];

/** Is this an improvement kind that needs the design block (a VISUAL kind)? */
export function isVisualKind(k: ImprovementKind): boolean {
  return (VISUAL_IMPROVEMENT_KINDS as string[]).includes(k);
}

// ---------------------------------------------------------------------------
// Bug severity (FIX mode) — how bad a regression reported against an
// already-shipped story is. Set on the card's `bugReport` block by the "Reportar
// bug" action; read by `harness-fix` to triage urgency (no queue-jumping in v1) and
// shown as the card chip. Board-agnostic fixed vocab, like storyType/ImprovementKind.
// Distinct from FindingSeverity (a code-review OUTPUT): this is a human triage INPUT.
// Ordered worst → least so the modal/segmented control reads top-down.
// ---------------------------------------------------------------------------

export type BugSeverity = "blocker" | "high" | "medium" | "low";

export interface BugSeverityDef {
  id: BugSeverity;
  /** PT-BR display name */
  name: string;
  /** one-line meaning */
  short: string;
  color: string;
}

export const BUG_SEVERITIES: BugSeverityDef[] = [
  {
    id: "blocker",
    name: "Crítico",
    short: "Quebra total, perda de dado ou bloqueia o uso — corrigir já.",
    color: "#c2706b",
  },
  {
    id: "high",
    name: "Alto",
    short: "Funcionalidade importante quebrada, sem workaround simples.",
    color: "#cc8d63",
  },
  {
    id: "medium",
    name: "Médio",
    short: "Quebra parcial com workaround; incomoda mas dá pra usar.",
    color: "#c4a261",
  },
  {
    id: "low",
    name: "Baixo",
    short: "Cosmético ou caso de borda; impacto pequeno.",
    color: "#8f99a8",
  },
];

export const BUG_SEVERITY_BY_ID: Record<BugSeverity, BugSeverityDef> = Object.fromEntries(
  BUG_SEVERITIES.map((s) => [s.id, s]),
) as Record<BugSeverity, BugSeverityDef>;

export const BUG_SEVERITY_IDS = BUG_SEVERITIES.map((s) => s.id);

export function isBugSeverity(v: unknown): v is BugSeverity {
  return typeof v === "string" && (BUG_SEVERITY_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Bug frequency (PRIORITIZE — bug kind) — how OFTEN the defect bites. The second
// axis of a bug's Cost of Delay (severity × frequency × workaround), distinct from
// severity (how BAD when it bites). Board-agnostic fixed vocab, like BugSeverity.
// Set on the card's first-class `frequency` field (by the triage agent or harness-fix);
// feeds the WSJF `priorityScore` (see priority.ts + storymap/frameworks.md §4).
// Ordered worst → least so the segmented control reads top-down.
// ---------------------------------------------------------------------------

export type BugFrequency = "always" | "often" | "sometimes" | "rare";

export interface BugFrequencyDef {
  id: BugFrequency;
  /** PT-BR display name */
  name: string;
  /** one-line meaning */
  short: string;
  /** Cost-of-Delay multiplier (feeds the WSJF priorityScore) */
  weight: number;
  color: string;
}

export const BUG_FREQUENCIES: BugFrequencyDef[] = [
  { id: "always", name: "Sempre", short: "Acontece toda vez / para todo mundo.", weight: 1.5, color: "#c2706b" },
  { id: "often", name: "Frequente", short: "Acontece com frequência ou para muitos.", weight: 1.2, color: "#cc8d63" },
  { id: "sometimes", name: "Às vezes", short: "Intermitente ou em parte dos casos.", weight: 1.0, color: "#c4a261" },
  { id: "rare", name: "Raro", short: "Caso de borda ou pouquíssimos usuários.", weight: 0.6, color: "#8f99a8" },
];

export const BUG_FREQUENCY_BY_ID: Record<BugFrequency, BugFrequencyDef> = Object.fromEntries(
  BUG_FREQUENCIES.map((f) => [f.id, f]),
) as Record<BugFrequency, BugFrequencyDef>;

export const BUG_FREQUENCY_IDS = BUG_FREQUENCIES.map((f) => f.id);

export function isBugFrequency(v: unknown): v is BugFrequency {
  return typeof v === "string" && (BUG_FREQUENCY_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Disposition (RETIRE mode) — WHY a card is leaving the active pipeline for the
// graveyard. Set on the card's `retirement` block by the "Descontinuar" action;
// shown as the chip in the `arquivados` column. Board-agnostic fixed vocab, like
// storyType/ImprovementKind/BugSeverity. `revivable` flags the only disposition
// that can come BACK into the pipeline (postergado) — abandonado/descontinuado
// are definitive (a removed/never-built feature does not "un-leave").
// ---------------------------------------------------------------------------

export type Disposition = "postergado" | "abandonado" | "descontinuado";

export interface DispositionDef {
  id: Disposition;
  /** PT-BR display name */
  name: string;
  /** one-line meaning */
  short: string;
  /** can it return to the pipeline? (only postergado) */
  revivable: boolean;
  color: string;
}

export const DISPOSITIONS: DispositionDef[] = [
  {
    id: "postergado",
    name: "Postergado",
    short: "Ainda faz sentido, só não agora — pode voltar ao backlog.",
    revivable: true,
    color: "#c4a261",
  },
  {
    id: "abandonado",
    name: "Abandonado",
    short: "Entrou no fluxo mas decidimos não construir — nunca foi ao ar.",
    revivable: false,
    color: "#9d9488",
  },
  {
    id: "descontinuado",
    name: "Descontinuado",
    short: "Estava no ar e foi removido do app.",
    revivable: false,
    color: "#8f99a8",
  },
];

export const DISPOSITION_BY_ID: Record<Disposition, DispositionDef> = Object.fromEntries(
  DISPOSITIONS.map((d) => [d.id, d]),
) as Record<Disposition, DispositionDef>;

export const DISPOSITION_IDS = DISPOSITIONS.map((d) => d.id);

export function isDisposition(v: unknown): v is Disposition {
  return typeof v === "string" && (DISPOSITION_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Removal level (RETIRE mode) — HOW HARD the agent cuts a feature, from a
// reversible flag flip to an irreversible data wipe. Set on `retirement.level`
// by the "Descontinuar" action; read by `harness-retire` to bound the removal.
// Ordered soft → hard (the modal radios read top-down). `reversible` is a UI hint
// (excluir-tudo is the only one that destroys data → human-approval gated).
// A null level = nothing to remove (postergado) → the card skips the executor.
// ---------------------------------------------------------------------------

export type RemovalLevel = "desativar" | "despublicar" | "remover-codigo" | "excluir-tudo";

export interface RemovalLevelDef {
  id: RemovalLevel;
  name: string;
  short: string;
  /** reversible without data loss? (excluir-tudo is the only destructive one) */
  reversible: boolean;
  color: string;
}

export const REMOVAL_LEVELS: RemovalLevelDef[] = [
  {
    id: "desativar",
    name: "Desativar",
    short: "Desliga via feature flag — reversível, o código permanece.",
    reversible: true,
    color: "#7e9ac2",
  },
  {
    id: "despublicar",
    name: "Despublicar",
    short: "Tira da navegação/rota; o código fica dormente.",
    reversible: true,
    color: "#5fa6a0",
  },
  {
    id: "remover-codigo",
    name: "Remover código",
    short: "Deleta componentes/rotas/functions; os dados ficam (git reverte).",
    reversible: true,
    color: "#cc8d63",
  },
  {
    id: "excluir-tudo",
    name: "Excluir tudo",
    short: "Remove o código E apaga os dados de produção — irreversível.",
    reversible: false,
    color: "#c2706b",
  },
];

export const REMOVAL_LEVEL_BY_ID: Record<RemovalLevel, RemovalLevelDef> = Object.fromEntries(
  REMOVAL_LEVELS.map((l) => [l.id, l]),
) as Record<RemovalLevel, RemovalLevelDef>;

export const REMOVAL_LEVEL_IDS = REMOVAL_LEVELS.map((l) => l.id);

export function isRemovalLevel(v: unknown): v is RemovalLevel {
  return typeof v === "string" && (REMOVAL_LEVEL_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Removal scope (RETIRE mode) — WHICH surfaces of a feature to touch. Set on
// `retirement.scope` (multi) by the "Descontinuar" action; read by `harness-retire`
// to know what to cut. Board-agnostic fixed vocab. `dados` is the only scope that,
// combined with level=excluir-tudo, arms the data-deletion approval gate.
// ---------------------------------------------------------------------------

export type RemovalScope = "codigo" | "rota" | "dados" | "flag" | "functions";

export interface RemovalScopeDef {
  id: RemovalScope;
  name: string;
  short: string;
  color: string;
}

export const REMOVAL_SCOPES: RemovalScopeDef[] = [
  { id: "codigo", name: "Código", short: "Componentes, funções, módulos.", color: "#cc8d63" },
  { id: "rota", name: "Rota / navegação", short: "Páginas, entradas de menu, deep links.", color: "#9889c6" },
  { id: "dados", name: "Dados", short: "Coleções/documentos no Firestore.", color: "#c2706b" },
  { id: "flag", name: "Feature flag", short: "A flag que liga/desliga a feature.", color: "#7e9ac2" },
  { id: "functions", name: "Cloud Functions", short: "Functions/endpoints dedicados.", color: "#7daa76" },
];

export const REMOVAL_SCOPE_BY_ID: Record<RemovalScope, RemovalScopeDef> = Object.fromEntries(
  REMOVAL_SCOPES.map((s) => [s.id, s]),
) as Record<RemovalScope, RemovalScopeDef>;

export const REMOVAL_SCOPE_IDS = REMOVAL_SCOPES.map((s) => s.id);

export function isRemovalScope(v: unknown): v is RemovalScope {
  return typeof v === "string" && (REMOVAL_SCOPE_IDS as string[]).includes(v);
}

// ── Ideia — o artefato de EXPLORAÇÃO (ADR-066) ────────────────────────

// Ciclo de vida de uma Ideia: um documento sobre algo ainda NÃO DECIDIDO (nova funcionalidade,
// hipótese de bug, dúvida técnica, incômodo de negócio). Não é pipeline — a Ideia vive fora dos
// gates e do autorun; estes estados são o progresso da EXPLORAÇÃO, não de uma entrega.
//
// open = anotada, ainda não investigada · exploring = pesquisa em andamento (o Explorador está
// ampliando o documento) · addressed = decidida, já gerou as tarefas que a executam ·
// discarded = descartada com motivo (terminal — sem isto, ideia morta volta a ser proposta pelo
// próximo que tiver a mesma intuição, que era o buraco de só existir "deletar").
export type IdeaStatus = "open" | "exploring" | "addressed" | "discarded";

export interface IdeaStatusDef {
  id: IdeaStatus;
  name: string;
  short: string;
  color: string;
}

export const IDEA_STATUSES: IdeaStatusDef[] = [
  { id: "open", name: "Nova", short: "Anotada, ainda não investigada.", color: "#cc8585" },
  { id: "exploring", name: "Explorando", short: "Pesquisa em andamento — o documento está crescendo.", color: "#c4a261" },
  { id: "addressed", name: "Decidida", short: "Virou tarefa: as entregas que a executam já existem.", color: "#7daa76" },
  { id: "discarded", name: "Descartada", short: "Não vamos seguir — o motivo fica registrado.", color: "#8b8b8b" },
];

/** Estados em que a Ideia está ENCERRADA (não pede mais trabalho de exploração). */
export const IDEA_TERMINAL_STATUS_IDS: IdeaStatus[] = ["addressed", "discarded"];

export const IDEA_STATUS_BY_ID: Record<IdeaStatus, IdeaStatusDef> = Object.fromEntries(
  IDEA_STATUSES.map((s) => [s.id, s]),
) as Record<IdeaStatus, IdeaStatusDef>;

export const IDEA_STATUS_IDS = IDEA_STATUSES.map((s) => s.id);

export function isIdeaStatus(v: unknown): v is IdeaStatus {
  return typeof v === "string" && (IDEA_STATUS_IDS as string[]).includes(v);
}

// Lean-experiment lifecycle of the riskiest assumption on a story's bet block.
// untested = hypothesis stated, not yet run; testing = experiment in flight;
// validated = evidence confirmed; invalidated = refuted — team must pivot.
export type ExperimentStatus = "untested" | "testing" | "validated" | "invalidated";

export interface ExperimentStatusDef {
  id: ExperimentStatus;
  name: string;
  short: string;
  color: string;
}

export const EXPERIMENT_STATUSES: ExperimentStatusDef[] = [
  { id: "untested", name: "Não testado", short: "Hipótese ainda não testada.", color: "#8f99a8" },
  { id: "testing", name: "Testando", short: "Experimento em andamento.", color: "#c4a261" },
  { id: "validated", name: "Validado", short: "Hipótese confirmada por evidência.", color: "#7daa76" },
  { id: "invalidated", name: "Invalidado", short: "Hipótese refutada — precisa pivotar.", color: "#cc8585" },
];

export const EXPERIMENT_STATUS_BY_ID: Record<ExperimentStatus, ExperimentStatusDef> = Object.fromEntries(
  EXPERIMENT_STATUSES.map((s) => [s.id, s]),
) as Record<ExperimentStatus, ExperimentStatusDef>;

export const EXPERIMENT_STATUS_IDS = EXPERIMENT_STATUSES.map((s) => s.id);

export function isExperimentStatus(v: unknown): v is ExperimentStatus {
  return typeof v === "string" && (EXPERIMENT_STATUS_IDS as string[]).includes(v);
}

// Authorship class of an OST artefact — derived from ownership.js (SINGLE SOURCE)
// so the three classes stay in lockstep across both TS and the CJS pre-write hook.
//   human     : strategy ladder (positioning/businessMetric/desiredOutcome), canvas, personas (canonical; only humans write)
//   proposable: ideas proposed by agents — humans must confirm
//   agent     : stories / tasks / code (agents write freely)
export type Owner = (typeof OWNER)[keyof typeof OWNER];
export const OWNER_IDS: Owner[] = Object.values(OWNER) as Owner[];
export function isOwner(v: unknown): v is Owner {
  return typeof v === "string" && (OWNER_IDS as string[]).includes(v);
}
