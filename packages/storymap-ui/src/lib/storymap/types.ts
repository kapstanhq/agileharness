// Domain model for User Story Mapping (Jeff Patton).
//
// Three card levels form the canonical map:
//   - activity : backbone (big user goals), left→right narrative (top row)
//   - step     : tasks composing an activity (parent = activity)
//   - story    : detail card in the body (parent = step), placed in a release slice
//
// Persistence: one Markdown file per card (frontmatter = metadata, body = markdown)
// under storymap/boards/<board>/cards/<id>.md, plus board.yaml for vocabularies.

import type { WireframeNode } from "./wireframe-dsl";
import type { FlowGraph } from "./flow-graph";
import type { StyleGuidePointer } from "./style-guide";
import type { WsjfCall } from "./wsjf";
import type {
  KanoCategory,
  FunnelStage,
  StoryType,
  ImprovementKind,
  BugSeverity,
  BugFrequency,
  Disposition,
  RemovalLevel,
  RemovalScope,
  IdeaStatus,
  ExperimentStatus,
  Owner,
} from "./frameworks";

export type CardType = "activity" | "step" | "story" | "idea";

export const CARD_TYPES: CardType[] = ["activity", "step", "story", "idea"];

export interface CardLink {
  /** linkType id (see BoardConfig.linkTypes) */
  rel: string;
  /** target card id */
  to: string;
}

/** A unit of work derived from a story by the `harness-plan` automation (plano-tecnico step). */
export interface Task {
  /** stable id, unique within the card */
  id: string;
  title: string;
  done: boolean;
}

/**
 * RICE prioritization inputs (Reach, Impact, Confidence, Effort).
 * Each is null until filled. The score is DERIVED (see lib/storymap/rice.ts),
 * never persisted.
 */
export interface Rice {
  reach: number | null;
  impact: number | null;
  confidence: number | null;
  effort: number | null;
}

/**
 * Agile story narrative — the three-part user story (Connextra) or its
 * enabler/technical variant. The connectors that frame each field depend on the
 * card's `storyType` (see frameworks.ts STORY_TYPE_DEFS):
 *   user/bug → "Como <role>, quero <want>, para <soThat>"
 *   technical/spike/chore → "Para <role>, precisamos <want>, de modo que <soThat>"
 * Each part is null until written. Stories only (activity/step leave them null).
 */
export interface StoryNarrative {
  /** the actor/objective clause — "Como <persona>" / "Para viabilizar <sistema>" */
  role: string | null;
  /** the capability clause — "quero <ação>" / "precisamos <trabalho>" */
  want: string | null;
  /** the benefit clause — "para <benefício>" / "de modo que <resultado>" */
  soThat: string | null;
}

/** Execution mode of a card: a fresh build, a refinement of shipped work, a fix of a regression, or a retirement (remove/archive). */
export type CardMode = "build" | "refine" | "fix" | "retire";
export const CARD_MODES: CardMode[] = ["build", "refine", "fix", "retire"];

/** Who decided a card's per-instance routing (the {@link CardRouting} skip set). `human` (WS4) = the
 *  `set_card_route` MCP tool / drawer editor wrote it explicitly (vs the deterministic `rules` default or
 *  the `agent` = harness-enrich/harness-refine). */
export type RoutingDecidedBy = "rules" | "agent" | "human";
export const ROUTING_DECIDED_BY = ["rules", "agent", "human"] as const;
export function isRoutingDecidedBy(v: unknown): v is RoutingDecidedBy {
  return typeof v === "string" && (ROUTING_DECIDED_BY as readonly string[]).includes(v);
}

/**
 * PER-INSTANCE pipeline routing override (sparse; PIPELINE-OWNED — set by the deterministic skip
 * router or `harness-refine`, NEVER the drawer). `skips` lists the status ids THIS card instance
 * bypasses in the build cascade, persisted so the PURE cascade kernel reads a precomputed boolean
 * instead of ever calling an LLM (storymap-ui has no in-process LLM SDK — the only LLM path is a
 * headless `claude -p` spawn). It is the seam where a light agent's verdict for a genuinely ambiguous
 * refine (a mixed visual+non-visual `kinds`) lands out-of-band: when present it is AUTHORITATIVE for
 * the listed steps (read by `routeSkip` in skip-routing.ts); when absent the deterministic rules
 * compute the skip live. `decidedBy` records the source (`rules` = the deterministic default,
 * `agent` = `harness-refine` wrote it); `decidedAt` is the YYYY-MM-DD stamp. Empty/absent ⇒ no override.
 */
export interface CardRouting {
  /** status ids THIS instance skips in the cascade (authoritative when present, but ONLY for dispensable
   *  steps — a load-bearing build/QA step is never skipped, see routeSkip in skip-routing.ts). */
  skips: string[];
  /** who decided this skip set — the deterministic rules, the harness-refine/harness-enrich agent, or a human. */
  decidedBy: RoutingDecidedBy;
  /** when the decision was made (YYYY-MM-DD). */
  decidedAt: string;
  /**
   * WS4 — the named {@link RouteProfile} (BoardConfig.routeProfiles) harness-enrich chose for this card
   * (e.g. `express` for a trivial technical change). Informational/traceability: the actual traversal is
   * DERIVED from `skips` + the step facets, never from this label (a snapshot label rots). Optional.
   */
  profile?: string;
  /**
   * WS4 — per-card model CEILING (teto-sob-teto): the run's model is capped at the LOWER of the column's
   * `model` and this. Lets an `express` route pay a trivial card in sonnet even on an opus column, without
   * skipping the (load-bearing) step. Absent = no card-level cap (column pair stands). See model-routing.ts.
   */
  modelCap?: ModelTier;
  /** WS4 — per-card effort CEILING, same teto-sob-teto semantics as {@link modelCap}. */
  effortCap?: EffortLevel;
  /** WS4 — free-text WHY this route was chosen (harness-enrich/human), surfaced in the WS5 history. Optional. */
  rationale?: string;
}

/**
 * WS4 — a NAMED routing profile declared on `BoardConfig.routeProfiles` (in `_base`, inherited). harness-enrich
 * picks one by the classification it already does (storyType + hasUiSurface) and STAMPS the card's
 * {@link CardRouting} from it (`profile` + `skips` + `modelCap`/`effortCap`). The profile is authoring
 * sugar — the persisted card carries the resolved skips/caps, so the kernel never reads the profile.
 * A profile that skips `priorizar` obliges the enrich writer to also stamp a minimal `priorityCall` in the
 * SAME run (coherence rule — the gate stays fail-closed).
 */
export interface RouteProfile {
  /** dispensable step ids this profile bypasses (on top of the static skipForTypes). Empty = none. */
  skips: string[];
  /** model ceiling applied to EVERY step of a card on this profile (teto-sob-teto). */
  modelCap?: ModelTier;
  /** effort ceiling applied to every step of a card on this profile. */
  effortCap?: EffortLevel;
  /** human-readable purpose (when to pick this profile). */
  description?: string;
}

/**
 * WS4 — a board-level SPECIALIST registry entry (`BoardConfig.specialists`, keyed by an OPAQUE id): the
 * indirection id → agent slug is what keeps storymap-ui AGNOSTIC (it never hardcodes agent names). A step's
 * `toolkit.specialists: string[]` references these ids; the engine composes a delegation note naming the
 * `agent` + `when` into the run's system prompt (the run delegates via the Task tool `subagent_type`). The
 * `agent` slug resolves to `.claude/agents/<slug>.md` in the CONSUMER repo checkout.
 */
export interface SpecialistDef {
  /** the sub-agent slug to delegate to (`.claude/agents/<slug>.md`); filtered by SAFE_SLUG at compose. */
  agent: string;
  /** WHEN to engage this specialist — the human-readable trigger, injected into the delegation note. */
  when: string;
}

/**
 * The REOPEN modes — a shipped card re-entering the pipeline (refine/fix/retire), vs the default
 * `build`. The single source for "is this a reopen?": the read coercion (repo.ts) and the write
 * filter (write.ts) derive their membership test from here instead of open-coding the 3-way
 * `=== "refine" || === "fix" || === "retire"` disjunction in lockstep (a new reopen mode would have
 * to be added to both literals, which can silently diverge). See also [[applyReopen]] (reopen.ts).
 */
export const REOPEN_MODES = ["refine", "fix", "retire"] as const;
export type ReopenMode = (typeof REOPEN_MODES)[number];
export function isReopenMode(v: unknown): v is ReopenMode {
  return typeof v === "string" && (REOPEN_MODES as readonly string[]).includes(v);
}

/**
 * Refinement brief — captured by the "Refinar" action when a story in `revisao`
 * (human QA) or `concluida` (shipped) is reopened for improvement. It tells every downstream `harness-*` skill that
 * the work IMPROVES existing code (do NOT recreate from scratch) and, via `kinds`,
 * biases the deep-skill roster + the entry column `harness-refine` routes to. The
 * free-text `brief` carries the intent AND the intensity (conservative polish ↔
 * aggressive redesign) — `harness-refine` infers how far to go from it. A screenshot
 * of the current state lives in the sidecar `refine/<id>/`, never inline.
 */
export interface Refinement {
  /** the user's free-text feedback — what to improve and why (intensity inferred) */
  brief: string;
  /** which dimensions this refinement targets — one or more (routes the card + picks the roster) */
  kinds: ImprovementKind[];
  /** the surface under work: a route/screen hint (e.g. "/eventos/[id]"); null = whole story */
  target: string | null;
  /** filename of the current-state screenshot under refine/<id>/; null = none */
  screenshot: string | null;
  /** when the refinement was opened (YYYY-MM-DD) */
  openedAt: string | null;
}

/**
 * Bug report — captured by the "Reportar bug" action when a story in `revisao`
 * (human QA) or `concluida` (shipped) regressed. The sibling of {@link Refinement}
 * for the FIX flow: it tells every downstream `harness-*` skill the work CORRECTS
 * broken behaviour in EXISTING code (do NOT rebuild from scratch). The free-text
 * `brief` is the report; `severity` triages urgency; `expected`/`actual`/`steps`
 * ground the `harness-fix` reproduction (the failing test). A screenshot of the broken
 * state lives in the sidecar `bugs/<id>/`, never inline. Whereas a refinement
 * improves something that works, a bug restores something that broke.
 */
export interface BugReport {
  /** the user's free-text report — what's broken and the context */
  brief: string;
  /** how bad it is — triage severity (crítico → baixo) */
  severity: BugSeverity;
  /** the behaviour that SHOULD happen; null = unstated */
  expected: string | null;
  /** the behaviour that happens instead; null = unstated */
  actual: string | null;
  /** ordered reproduction steps; [] = none given */
  steps: string[];
  /** the surface under fix: a route/screen/env hint (e.g. "/eventos/[id]"); null = whole story */
  target: string | null;
  /** filename of the broken-state screenshot under bugs/<id>/; null = none */
  screenshot: string | null;
  /** story-cl1mi9 — additive: filenames of extra context screenshots under bugs/<id>/
   *  (context-N.<ext>). The capture path retains multiple pasted images here; the single
   *  `screenshot` above stays the primary (reopen flow). Absent/[] = none. */
  screenshots?: string[];
  /** when the bug was reported (YYYY-MM-DD) */
  openedAt: string | null;
}

/**
 * Retirement brief — captured by the "Descontinuar" action when a card LEAVES the
 * active pipeline for the graveyard (`arquivados`). The third sibling of
 * {@link Refinement}/{@link BugReport}, for the REMOVE flow: whereas refine improves
 * and fix restores, retire DESTROYS — it tells `harness-retire` to remove the live
 * feature at the chosen `level` (deactivate ↔ delete). Unlike refine/fix (which only
 * reopen shipped stories), retire can leave from ANY status: a postergado/abandonado
 * card with no live code skips the executor and lands straight in `arquivados`; a
 * card with a `level` routes through the `descontinuar` executor first. A
 * current-state screenshot lives in the sidecar `retire/<id>/`, never inline; the
 * removal plan the agent writes lives in `retire/<id>/plan.md`.
 */
export interface Retirement {
  /** the user's free-text reason — why it's leaving + nuances (e.g. "guarde os dados 30 dias") */
  brief: string;
  /** WHY it's leaving — drives the graveyard chip + reversibility (postergado is revivable) */
  disposition: Disposition;
  /** HOW HARD to cut the live feature; null = nothing to remove (postergado) → skips the executor */
  level: RemovalLevel | null;
  /** WHICH surfaces to touch (code/route/data/flag/functions); [] = unspecified */
  scope: RemovalScope[];
  /** the surface under removal: a route/feature hint (e.g. "/perfil/salvos"); null = whole story */
  target: string | null;
  /** filename of the current-state screenshot under retire/<id>/; null = none */
  screenshot: string | null;
  /** the status the card came FROM (so a postergado revive returns it there) */
  fromStatus: string | null;
  /** human go-ahead for the IRREVERSIBLE data cut (only excluir-tudo + scope `dados`) */
  dataDeletionApproved: boolean;
  /** when the retirement was opened (YYYY-MM-DD) */
  openedAt: string | null;
}

/**
 * A DURABLE commit range `<base>..<head>` (both immutable SHAs) — the delta a
 * review or QA pass validated. Unlike a lone HEAD sha (`reviewCommit`/`qaCommit`),
 * which becomes meaningless once `main` advances, a base+head pair stays
 * reconstructable forever: `git diff base..head` reproduces the exact change set
 * no matter where `main` is today (SM-05). `base` is the parent of the card's
 * earliest commit (or the empty-tree SHA when that commit is the repo root).
 */
export interface CommitRange {
  /** SHA of the commit immediately BEFORE the card's first commit (its parent). */
  base: string;
  /** SHA of the card's last commit (HEAD at the moment of the review/QA). */
  head: string;
}

/**
 * deploy-truth WS-1 — the SERVER-STAMPED proof that a card's code is published (see Card.deployProof).
 * `source` names WHICH settle/reconcile handler ran the ancestry measurement:
 *   - "settle-webhook":     the durable /api/runner/deploy-webhook settle (self-deploy / external CI) —
 *                           works on a FRESH process post-restart, reading everything from disk;
 *   - "registry-ondone":    the in-process ProductDeployRegistry onDone settle (orch-deploy / face);
 *   - "reconcile-evidence": the evidence sweep (deploy-reconcile) proved it from the deploy state files —
 *                           the publish happened OUTSIDE the board (e.g. operator CLI), no settle event.
 */
export interface DeployProof {
  /** the main sha PROVEN (by ancestry) to be contained in every measured target's published sha. */
  sha: string;
  /** the publish targets the proof covers ("self" = the storymap self-deploy, measured vs checkout HEAD). */
  targets: string[];
  /** ISO timestamp the proof was stamped. */
  at: string;
  source: "settle-webhook" | "registry-ondone" | "reconcile-evidence";
}

/**
 * PROOF that this card's build already exists — carried by the stamp itself, never inferred.
 *
 * The `hasBuildEvidence` gate (gate-core.js) exists so a card can NEVER reach `revisar-codigo` without an
 * implementation (C2/ny4v26). Its original evidence was a PROXY: "every declared task is done". That proxy
 * has a blind spot the colisão #4 of 2026-07-16 hit head-on — when a card's fix ALREADY LANDED in a prior
 * run, the correct behaviour of the next run is to implement NOTHING, so no task flips, no evidence
 * appears, and the gate deadlocks the card in Desenvolver forever (story-uae2ag).
 *
 * This stamp is the OTHER, stronger evidence: the engine writes it ONLY when {@link deltaLanded} returns
 * `landed` — POSITIVE PROOF BY CONTENT that the card's expected delta is in the run's base. So the gate is
 * not weakened, it is completed: it still demands evidence, and now accepts the direct proof instead of
 * only the proxy. NOTHING but the engine holding a convergence proof ever writes it.
 */
/**
 * Proof-carrying answer to "did this card's code touch a user-visible surface?", measured by the
 * engine over the run's changed paths (runner/staging.ts `pathsTouchUiSurface`). Written ONLY by the
 * engine holding the diff — never by an agent or the card drawer, exactly like {@link BuildEvidence}.
 *
 * `touched: false` is a MEASUREMENT, not a missing value: it means the engine looked and found no UI
 * path, which legitimately exempts the card from visual QA. Absence of the whole object means nobody
 * measured — a different thing, and the gate treats it differently.
 */
export interface UiSurfaceEvidence {
  /** did the run's diff touch a path classified as a user-visible surface? */
  touched: boolean;
  /** ISO timestamp of the measurement. */
  at: string;
  /** a few of the matching paths (capped) — so a blocked operator sees WHICH file decided this. */
  paths?: string[];
  /** the run that measured it (audit trail). */
  runId?: string;
}

/**
 * WHAT a QA stamp actually proved. Splits the single `qaPassed` bit into the two independent proofs
 * the pipeline can produce, so a gate can require the one it cares about:
 *  - `suite` — the package's automated suite ran green.
 *  - `visual` — a human or a headless browser actually LOOKED at the rendered surface.
 * A suite-only QA is a legitimate, complete proof for a card with no screen; it is NOT a proof of a
 * screen. Before this split, both stamped the same bit and the difference was unrecoverable.
 */
export interface QaEvidence {
  /** the package's automated test suite ran green. */
  suite?: boolean;
  /** the rendered surface was actually inspected (headless sweep or a human saying they looked). */
  visual?: boolean;
  /** ISO timestamp of the stamp. */
  at: string;
  /** who/what recorded it — the skill trigger, or `human` for an approve_qa. */
  by?: string;
}

export interface BuildEvidence {
  /** why we know the build exists. `already-landed` = a prior run's code is provably in the base. */
  provenance: "already-landed";
  /** ISO timestamp of the stamp. */
  at: string;
  /** the delta that was proven, as `<base>..<head>` (human-readable audit trail). */
  range?: string;
  /** the ref/sha the delta was proven to be contained in (the run's base). */
  target?: string;
  /** the run that established the proof. */
  runId?: string;
}

/**
 * A persisted snapshot of the SHAs needed to reconstruct a card's run diff AFTER
 * its `run/<sessionId>` branch is force-deleted post-merge (SM-04). The diff shown
 * in the card modal is otherwise 100% ephemeral — recomputed live via
 * `git diff main...run/<sessionId>` — so it vanishes the moment the merge train
 * runs `git branch -D`. Captured immediately before that deletion, `base..mergeCommit`
 * reproduces the exact change set the operator reviewed during the pipeline:
 * `git diff <base>..<mergeCommit>`.
 */
export interface DiffSnapshot {
  /** SHA of the main tip immediately BEFORE the merge (= HEAD^1 of the merge commit). */
  base: string;
  /** SHA of the merge commit that integrated the run branch into main. */
  mergeCommit: string;
}

/**
 * Campos de um card `type: "idea"` — uma IDEIA: o artefato de EXPLORAÇÃO do board (ADR-066).
 *
 * A régua que a separa de uma Tarefa: **"sei o que precisa ser feito?"** Se sim, é card de
 * trabalho e entra no pipeline. Se ainda não — se é hipótese, dúvida, incômodo ou intuição —
 * é Ideia: fica FORA do pipeline (sem `status`, sem gate, sem autorun) e amadurece como
 * DOCUMENTO até virar decisão. Vale para qualquer natureza: funcionalidade nova, suspeita de
 * bug, dúvida de arquitetura, questão de negócio.
 *
 * O artefato é o **corpo** (`Card.body`, projetado por `doc/idea-doc.ts`): os campos abaixo são
 * seções OPCIONAIS ancoradas nele (`binding`), não um formulário obrigatório. Quem quer rigor
 * OST preenche; quem só quer pensar escreve livre. Foi o formulário-espelho-de-story que fazia
 * a Oportunidade se confundir com a user story — ver o Context do ADR-066.
 *
 * Born `owner:proposable` (an agent may propose; a human promotes to canonical).
 */
export interface IdeaFields {
  /** o enunciado curto do que se está explorando — a dor, a dúvida ou a intuição.
   *  NÃO é espelho do título (o acoplamento statement→title foi desfeito pelo ADR-066). */
  statement: string;
  /**
   * Personas that experience this pain are the card's own `Card.personas` (single
   * source of truth) — NOT duplicated here. See AC1 / the answered design question.
   */
  /** o que ancora a ideia na realidade: entrevistas, suporte, analytics, um print, um achado no código */
  evidence: string | null;
  /** estágio da EXPLORAÇÃO (não do pipeline) */
  status: IdeaStatus;
  /** por que foi descartada — obrigatório de fato quando `status === "discarded"` (ADR-066 §4):
   *  ideia morta sem motivo registrado volta a ser proposta pelo próximo que tiver a mesma intuição. */
  discardReason?: string | null;
  // ── OST light (Fatia 2) — seções opcionais do documento, todas esparsas → retrocompatíveis. ──
  /** caminhos de solução considerados (ainda hipóteses — nenhuma virou compromisso) */
  candidateSolutions?: string[];
  /** the riskiest assumption this idea rests on — the premise to validate before betting */
  keyAssumption?: string | null;
  /** the leading signal that tells us the pain is being addressed (the outcome to watch) */
  successSignal?: string | null;
  /** value sizing of the pain (dual-track: stories inherit this instead of carrying their own reach/impact).
   * LEGADO: substituído pela prioridade argumentada (`priorityCall`); mantido para cards que ainda o têm. */
  valueSize?: { reach: number | null; impact: number | null } | null;
  /** prioridade argumentada da dor (reasoning-first) — o sinal primário que substitui o alcance×impacto.
   * As stories que endereçam esta dor herdam este tier quando não têm o seu próprio. */
  priorityCall?: PriorityCall | null;
}

/**
 * A bet block on a story — the Lean-validated hypothesis the team is testing by
 * building this story. `assumptions[]` enumerates every assumption the story rests on;
 * `riskiestAssumption` singles out the one most likely to invalidate the bet if wrong;
 * `experimentStatus` tracks where the Lean cycle is.
 */
export interface Bet {
  /** all assumptions the story rests on (what must be true for the story to succeed) */
  assumptions: string[];
  /** the single assumption whose failure would invalidate the whole bet */
  riskiestAssumption: string | null;
  /** where the experiment cycle is */
  experimentStatus: ExperimentStatus;
}

/**
 * Prioridade ARGUMENTADA (reasoning-first) — o sinal PRIMÁRIO de prioridade, em ideias E stories.
 * Em vez de números de alcance/RICE inventados (precisão falsa num produto pré-escala), o agente OU o
 * humano atribui um TIER defendido por um argumento curto, raciocinando sobre o card + as irmãs + o
 * posicionamento/resultado-alvo do board. Quando presente, VENCE o WSJF legado em `priorityTier()`; o
 * WSJF segue como fallback para cards sem o bloco. Esparso/opcional → cards legados não o têm.
 */
export interface PriorityCall {
  /** tier na MESMA escala da régua do kanban: 0 Baixa · 1 Média · 2 Alta · 3 Crítica */
  rank: 0 | 1 | 2 | 3;
  /** o porquê — "por que agora / por que antes de X", 1–3 frases */
  rationale: string;
  /** a suposição mais arriscada a derrubar primeiro (Lean). null/omitido = não declarada */
  riskiestAssumption?: string | null;
  /** quem atribuiu: "agent" (avaliação) ou "human" (override — manda sobre o agente) */
  source: "agent" | "human";
  /** ISO timestamp da avaliação */
  assessedAt: string;
  /**
   * Os ORDINAIS WSJF que sustentam o `rank` (ver lib/storymap/wsjf.ts). Sub-bloco ADITIVO e opcional:
   * os calls legados (só rank + rationale) seguem válidos e não precisam de migração — para eles
   * `wsjfRatio` devolve null e a ordem cai no `rank`.
   *
   * `rank` continua GRAVADO mesmo sendo derivável do wsjf, e isso é deliberado: o gate isomórfico
   * (gate-core.js) e o `suggest_work` leem o YAML cru e não podem calcular uma razão. O teste que
   * amarra os dois é a invariante `rank === wsjfTier(wsjfRatio(wsjf))`.
   */
  wsjf?: WsjfCall | null;
}

/**
 * WS6 (F5) — a card's creation PROVENANCE (which surface minted it): `mcp` (create_card), `capture`
 * (usm_capture / smart-capture proposal), `triage` (report_issue → triador), `ui` (the "+ Novo item"
 * drawer), `skill` (a harness-* skill authored it). Dedicated field — never reuse `rationale`. Board-agnostic.
 */
export const CARD_PROVENANCES = ["mcp", "capture", "triage", "ui", "skill"] as const;
export type CardProvenance = (typeof CARD_PROVENANCES)[number];
export function isCardProvenance(v: unknown): v is CardProvenance {
  return typeof v === "string" && (CARD_PROVENANCES as readonly string[]).includes(v);
}

/**
 * WS6 (F5) — a STRUCTURED degradation warning from a batch commit (commitProposalAction): the placement
 * the proposal asked for could NOT be honored, so the card was created with a weaker one — surfaced instead
 * of dropped in silence. `parent-dropped` = a dangling parent id resolved to null (→ unplaced);
 * `serves-dropped` = a delivery's `serves` target didn't resolve; `forced-created` = a cyclic/unresolvable
 * item was force-created parentless on the last pass. The MCP create_card/usm_capture repass these.
 */
export interface CardCommitWarning {
  tempId: string;
  code: "parent-dropped" | "forced-created" | "serves-dropped" | "duplicate-suspected" | "idea-ignored";
  detail: string;
  /** Fase 4.1 — the REAL minted id of the card this warning is about (resolved from the commit's internal
   *  tempId→id map before returning). Lets a human surface link straight to the created card ("Ver card").
   *  Sparse: absent for placement codes only if the item was never minted (should not happen there); ALWAYS
   *  absent for `idea-ignored` (WS-9), where by design NO card is minted — the ◆ is barred, and the
   *  human is pointed at the Ideias bench instead. */
  cardId?: string;
}

export interface Card {
  /** stable id; equals the markdown filename stem */
  id: string;
  type: CardType;
  title: string;
  /** nature of the work — picks the narrative template (stories only); null for activity/step */
  storyType: StoryType | null;
  /** execution mode (default "build"); "refine" reopens a shipped story for improvement */
  mode?: CardMode;
  /**
   * Reabertura R1 — a ONE-SHOT flag set when a card is reopened (refine/fix) DIRECTLY into a chosen
   * build column. While true, the cascade's mode-aware override runs the DEDICATED reopen skill
   * (harness-refine/harness-fix) at that column instead of the column's normal trigger; the skill clears this
   * flag on its first pass (clearReopenPending) so every SUBSEQUENT column runs its OWN mode-aware skill
   * (harness-do/harness-review/harness-qa) — `mode` itself PERSISTS through the flow (harness-qa is the only station that
   * clears it). Without the one-shot gate the override would hijack the entire downstream flow. Transient.
   */
  reopenPending?: boolean;
  /** refinement brief — present only while a card is in/through the refine flow */
  refinement?: Refinement | null;
  /** bug report — present only while a card is in/through the fix flow (mode "fix") */
  bugReport?: BugReport | null;
  /** retirement brief — present only while a card is in/through the retire flow (mode "retire") */
  retirement?: Retirement | null;
  /**
   * OST idea fields — present ONLY on cards with `type: "idea"`.
   * Schema-only (phase 1): populating real ideas is the interview agent's job (phase 2).
   * null/undefined = not an idea card.
   */
  idea?: IdeaFields | null;
  /**
   * Bet block — the Lean hypothesis this story is testing (schema-only, phase 1).
   * Present on stories that have stated their risk explicitly via the bet author flow.
   * null/undefined = no bet stated yet.
   */
  bet?: Bet | null;
  /**
   * Authorship class of this artefact (OST layer). Derived from ownership.js.
   * `proposable`: an agent proposed it, awaiting human confirmation (default for idea cards).
   * `human`: canonically authored by a human.
   * `agent`: freely written by an agent (stories/tasks).
   * undefined = field absent (legacy cards; treated as `agent` by convention).
   */
  owner?: Owner | null;
  /** kanban status id (see BoardConfig.statuses) */
  status: string | null;
  /** parent card id (activity for a step, step for a story); null for activities */
  parent: string | null;
  /**
   * Dual-track attribution OVERRIDE (sparse; delivery stories only): the map node a DELIVERY
   * story (storyType technical/bug/chore/spike) hangs under in the outline — a step, activity,
   * or user-story id. It is an override ON TOP of `parent`,
   * never a replacement: the effective target is `servesTarget(card) = card.serves ?? card.parent`
   * (see lib/storymap/unplaced.ts), so a delivery story with no explicit `serves` is attributed via
   * its existing `parent` (the 100%-covered case → zero data churn). null/omitted for user stories
   * and activity/step cards. Human/drawer-owned (deliberately NOT a PIPELINE_OWNED_FIELD); it never
   * enters a gate/trigger/cascade kernel — pure view/attribution metadata, invisible to the pipeline.
   */
  serves?: string | null;
  /**
   * PER-INSTANCE pipeline routing override (sparse; PIPELINE-OWNED — set by the deterministic skip
   * router or `harness-refine`, NEVER the drawer). Holds the steps THIS card instance skips in the build
   * cascade, so the PURE kernel reads a precomputed verdict (it never calls an LLM). It is the seam
   * where a light agent's per-instance decision for an ambiguous mixed-kind refine lands out-of-band.
   * See {@link CardRouting} + `routeSkip` (skip-routing.ts). null/omitted = no override (rules decide live).
   */
  routing?: CardRouting | null;
  /** release slice id (stories only); null = unscheduled */
  release: string | null;
  /**
   * SM-02 hierarchy gate (sparse, only persisted when true): the story was created
   * without a step parent and routed to the "Backlog não-mapeado" lane instead of
   * silently vanishing from the map (o outline só ancora story com passo-pai).
   * undefined/false = a normal mapped story (or a legacy orphan, if also parent:null).
   */
  unplaced?: boolean;
  /**
   * WS6 (F5) — PROVENANCE: which creation surface minted this card. Stamped at the two real chokepoints
   * (commitProposalAction covers create_card/usm_capture/SmartCaptureModal/acceptProposal → `mcp`/`capture`;
   * createCardAction/makeDraftCard covers triage + the UI "+ Novo item" → `triage`/`ui`; a skill-authored
   * card → `skill`). Sparse — a legacy card has none (parses fine). Audit/observability only; no gate reads it.
   */
  via?: CardProvenance;
  /**
   * WS6 (F5) — EXPLICIT acknowledgement that this story has NO place on the map (no parent, no serves). The
   * human/agent decided "sem lugar" deliberately (or the WS6 backfill grandfathered a pre-existing orphan
   * with `by: "backfill-ws6"`). Satisfies the `hasPlacement` gate — an orphan may circulate through
   * triage/discovery, but only an ACKNOWLEDGED one enters construction. Sparse audit trail; absent = never
   * acknowledged (a brand-new unplaced story the gate will hold at plano-tecnico until decided).
   */
  unplacedAck?: { by: string; at: string };
  personas: string[];
  systems: string[];
  links: CardLink[];
  /** Agile narrative (Connextra / enabler variant); part of the hasRefinement gate (priorizar entry). Stories only. */
  narrative: StoryNarrative;
  /** acceptance criteria (part of the hasRefinement gate, priorizar entry); filled by the harness-enrich automation */
  acceptance: string[];
  /** work breakdown (hasTasks gate, desenvolver entry); filled by the harness-plan automation in the same run as the plan */
  tasks: Task[];
  /** RICE inputs (part of the `pronta` gate); the score is derived, not stored */
  rice: Rice;
  /** KANO category — satisfaction shape (part of the `pronta` gate). null = unset */
  kano: KanoCategory | null;
  /** AAARRR funnel stage — business objective (part of the `pronta` gate). null = unset */
  funnelStage: FunnelStage | null;
  /**
   * Prioridade ARGUMENTADA (reasoning-first) — o sinal PRIMÁRIO de prioridade. Quando presente, vence o
   * WSJF derivado de RICE/severidade em `priorityTier()` e satisfaz o gate `hasPrioritization` (ninguém é
   * forçado a inventar alcance). Esparso: omitido em cards que ainda não foram avaliados. Ver {@link PriorityCall}.
   */
  priorityCall?: PriorityCall | null;
  // --- Triage / intake (ADR-056) ---------------------------------------------
  /**
   * Triage severity — FIRST-CLASS, distinct from `bugReport.severity` (which only
   * exists on a reopened story). Lets a bug born in `triage` (a new card, not a
   * reopen) carry urgency so the Inbox can sort by it. null/undefined = unset.
   */
  severity?: BugSeverity | null;
  /**
   * Bug PRIORITY axis (type-aware prioritization, Fase 2) — how OFTEN the defect
   * bites. Paired with `severity` (how bad) and `hasWorkaround` to compute the
   * `bug` kind's WSJF `priorityScore` (see lib/storymap/priority.ts). First-class so
   * a triage-born bug carries it without a `bugReport`. null/undefined = unset.
   */
  frequency?: BugFrequency | null;
  /**
   * Bug PRIORITY axis (Fase 2) — is there a workaround? `true` lowers the Cost of
   * Delay (less urgent); `false`/unset = no workaround (worst case). Feeds the `bug`
   * WSJF `priorityScore`. null/undefined = unset (treated as no workaround).
   */
  hasWorkaround?: boolean | null;
  /** Free-form classification labels (area, regression, needs-info…), orthogonal to
   * the single-valued `storyType`. undefined/[] = none. */
  labels?: string[];
  /**
   * O card canônico que este SUSPEITA duplicar (ou, quando `status === "duplicado"`, o que ele CONFIRMOU
   * duplicar). null/undefined = sem suspeita.
   *
   * O campo sozinho é um AVISO, não um veredito — a captura o preenche quando "parece duplicata" e o card
   * entra na Triagem normal com `needsHumanReview`, exibindo o badge "Dup · X". Só a decisão explícita de um
   * humano (ou do Jido autônomo) — a ação "Marcar duplicado" — move o card para o status `duplicado`
   * (terminal, gate `hasDuplicateOf`, que este campo já satisfaz). O commit da captura NÃO arquiva sozinho:
   * fazia isso antes, e capturas viravam cards invisíveis sem que ninguém tivesse decidido nada.
   */
  duplicateOf?: string | null;
  /** The triage agent left this for a human (low-confidence classification). */
  needsHumanReview?: boolean;
  /**
   * Human-in-the-loop questions (HITL) — an agent (harness-grill) surfaces the unknowns that most change
   * scope/design; a human answers them on the /perguntas queue. STRUCTURED (not prose in the body) so
   * the cross-board queue can aggregate/sort/answer them, they round-trip as part of the card spec, and
   * a later skill (harness-enrich) reads the answers as context. Sparse: omitted when the card has none.
   */
  questions?: CardQuestion[];
  /** Capture container marker — an ephemeral card holding the free text the user wants captured;
   * harness-capture turns it into a proposal sidecar (proposals/<id>.json). Present ONLY on containers. */
  capture?: boolean;
  /**
   * Style-guide container marker (a DEDICATED flag, deliberately NOT `capture`). LEGACY: the async
   * style-guide GENERATION lane was removed — the guide is now a plain source-of-truth document a human
   * authors directly (design-actions.ts). Nothing creates a `"style"` container anymore; the field is
   * retained so any pre-existing container card still round-trips (write.ts/repo.ts) instead of silently
   * dropping the flag. Kept distinct from `capture` so such a card is never collected as a smart-capture
   * proposal-review item (cockpit-collect.ts collects `capture:true`). `"style"` is the only value.
   */
  container?: "style";
  /**
   * LIGHT pipeline pointers (Fase C/D) — the heavy content lives in sidecars
   * (plans/<id>.md, wireframes/<id>.json), only these flags ride in the card.
   */
  /** harness-plan wrote the technical plan sidecar → gate hasTechPlan. */
  techPlanReady?: boolean;
  /** id of the wireframe option the human/agent chose → gate hasWireframe. null = none yet. */
  wireframeChosen?: string | null;
  /** code-review findings (harness-review); an open `blocker` fails gate hasNoBlockers. */
  findings: Finding[];
  /** when the last review ran (YYYY-MM-DD) + the commit/HEAD it reviewed. */
  reviewedAt?: string | null;
  reviewCommit?: string | null;
  /**
   * harness-qa proved the acceptance criteria end-to-end (E2E + headless visual) →
   * gate hasQaPassed. Only `user` stories with a UI-observable criterion require
   * it; technical/spike/chore/bug pass the gate freely (no deadlock on infra cards).
   */
  qaPassed?: boolean;
  /** when the last QA run ran (YYYY-MM-DD) + the commit/HEAD it validated. */
  qaRanAt?: string | null;
  qaCommit?: string | null;
  /**
   * D14 — style-guide conformance stamp, written by harness-qa's visual sweep on a board that HAS a
   * published guide (fail-open: a board without one never gets a stamp). `version`/`hash` mirror the
   * board.yaml `styleGuide` pointer (style-guide.ts `StyleGuidePointer`) at the moment of the check —
   * NOT re-verified here, just recorded, so "did this screen follow the guide v3?" is answerable from
   * the card alone. `passed` is the CONFORMANCE verdict (colors/typo/spacing vs. the guide's tokens,
   * `debt[]` consulted before flagging) — a `false` still writes the stamp (a non-blocking `design`
   * finding is what records the violation; the gate `hasStyleGuideCheck` is a documented v2 extension,
   * D16, not wired here). Sparse: only present once harness-qa has run on a guide-bearing board.
   */
  styleGuideCheck?: { version: number; hash: string; passed: boolean; at: string };
  /**
   * Does this card touch a USER-VISIBLE UI surface? Drives the gate hasQaPassed: a card WITH a UI
   * surface must pass the VISUAL QA sweep regardless of storyType (so a `bug` fixing a visual
   * regression can't ship unproven, and a UI-less `user` story isn't forced into a pointless visual
   * QA). SPARSE: when absent the gate falls back to `storyType === "user"` — zero-migration parity
   * with the old user-only rule. Written by /harness-enrich (frontmatter-direct, like priorityCall) and
   * the regression flip — never the drawer; pipeline-owned (card-merge.ts) so a Save can't clobber it.
   */
  hasUiSurface?: boolean;
  /**
   * The MEASURED answer to "does this card touch a screen?", stamped by the ENGINE from the run's real
   * diff — never by an agent, never by the drawer (pipeline-owned). It OUTRANKS `hasUiSurface` in the
   * gate: a declaration is an opinion, this is what the code actually changed.
   *
   * Exists because the declaration above was authored on 1 of 311 real cards, so the gate always fell
   * through to `storyType === "user"` and any non-`user` card that rewrote a component shipped with no
   * visual QA. Sparse: only on disk once a code run measured it.
   */
  uiSurfaceEvidence?: UiSurfaceEvidence;
  /**
   * WHAT the QA that stamped `qaPassed` actually proved. `qaPassed` alone is one bit for two very
   * different proofs (browser sweep vs. package suite), so it can't carry "the screen was checked" —
   * this can. Written by whoever ran the QA (the skill, or a human via approve_qa). Sparse: absent on
   * every card stamped before this field existed, and the gate reads that absence as UNKNOWN, not as
   * a failure.
   */
  qaEvidence?: QaEvidence;
  /**
   * ADR-063 (2c) shift-left: the acceptance→spec map harness-tests/harness-do author as they write specs, so
   * QA becomes a RUNNER (a missing spec ROUTES BACK, not re-authored). Gate `hasCriteriaSpecs` (entry
   * to revisar-codigo) is DEFAULT-SATISFIED when absent/empty (zero-migration — never freezes legacy)
   * and only blocks a UI-surface card whose declared criteriaSpecs has an entry missing its specPath.
   * Sparse: only on disk once a spec-authoring skill wrote it.
   */
  criteriaSpecs?: CriterionSpec[];
  /**
   * Durable `{ base, head }` range of the last review/QA — supersedes the lone
   * `reviewCommit`/`qaCommit` SHAs so the validated delta stays reconstructable
   * (`git diff base..head`) even after `main` advances (SM-05). Lean: only on disk
   * once a review/QA run records it; older cards keep just the lone shas.
   */
  commitRange?: CommitRange | null;
  /**
   * WS-5.2 — the proof-carrying build stamp the `hasBuildEvidence` gate accepts ALONGSIDE the tasks proxy
   * (see {@link BuildEvidence}). SPARSE: only on disk once the engine PROVED, by content, that the card's
   * delta already landed in the run's base — the case the tasks proxy structurally cannot see. Written by
   * the C2 guard / the redrive pre-check, never the drawer.
   */
  buildEvidence?: BuildEvidence;
  /**
   * Persisted SHAs to reconstruct the run diff after the `run/<sessionId>` branch is
   * force-deleted post-merge (SM-04). Captured by the merge train right before
   * `git branch -D`; the diff modal falls back to `git diff base..mergeCommit` when
   * the branch is gone. Lean: only on disk for cards that have been merged.
   */
  diffSnapshot?: DiffSnapshot;
  /**
   * Fase 4b staged release (pipeline-owned — set by the merge train / release action, NEVER the drawer).
   * `stagedAt` (YYYY-MM-DD): the run's CODE was integrated onto the `stage` branch by the split → gate
   * hasStaged. `releasedAt`: a human promoted `stage` → `main` (code went live on the released branch) →
   * gate hasReleased guards Deploy/Live. Lean: only on cards that produced code (board-only cards stage nothing).
   */
  stagedAt?: string;
  releasedAt?: string;
  /**
   * A EVIDÊNCIA de que o código deste card está em `main`: o sha de `main` logo APÓS a promoção bem-sucedida
   * (stage → main). Qualquer deploy rodado num commit DESCENDENTE deste sha necessariamente carrega o código
   * do card — é essa relação de ancestralidade que permite RECONCILIAR um `deploy-failure` contra a realidade
   * (deploy-reconcile.ts), em vez de depender de quem disparou o deploy.
   *
   * Por que não reusar `commitRange.head`: aquele é o head do branch do RUN, e a promoção aplica um PATCH em
   * main — o sha muda. Medido: 2 de 3 shas de `commitRange`/`diffSnapshot` dos cards travados NÃO eram
   * ancestrais de main, embora o código estivesse lá. Sha de branch não prova nada sobre main; este prova.
   * Day-granular seria inútil aqui (precisamos da ordem topológica, não da data). Só em cards que promoveram.
   */
  releasedSha?: string;
  /**
   * Os alvos de product-deploy cuja publicação torna ESTE card vivo — carimbados quando o deploy dispara
   * (ex.: `["acmeapp", "mosaico-site"]` quando o diff também toca a face mosaico.app). É o outro lado da evidência:
   * sem eles, reconciliar exigiria adivinhar quais unidades importam, e "todas" seria estrito demais (uma
   * unidade sem drift nunca é republicada, e o card nunca sararia).
   */
  deployTargets?: string[];
  /**
   * WS1.1 (pipeline-owned — set by the deploy onEnter effect, NEVER the drawer). ISO timestamp the
   * board's deploy was FIRED (systemd-run self-deploy / orch-deploy) but has not yet SETTLED (the
   * deploy-webhook has not posted ok/failed back). Since deploy-truth, EVERY card-triggered deploy
   * stamps it (not only the self-deploy that armed a webhook): the card now WAITS in `deploy`
   * ("Publicando") until the settle proves the publish, so a settle that never arrives would strand it
   * there silently — the stamp is what lets the `deploy-unsettled` watchdog surface a card STUCK in
   * `deploy` past its SLA (and, for historical era-otimista cards, one lying terminal). Cleared when a
   * settle lands a PROOF (or fails → revert clears it); an ok settle WITHOUT proof deliberately keeps
   * it, so "settled but unproven" still escalates. Minute-granular (unlike day-granular stagedAt).
   */
  deployFiredAt?: string;
  /**
   * deploy-truth WS-1 — a PROVA CARIMBADA de que o código deste card está publicado, escrita SÓ pelos
   * handlers de settle/reconcile do servidor (nunca por agente/drawer). A medição é a MESMA régua de
   * ancestralidade do deploy-reconcile (`releasedSha` ⊆ sha publicado por alvo, git merge-base
   * --is-ancestor) — nenhuma régua nova; o gate `hasDeployProof` (gate-core.js) só exige o carimbo,
   * nunca roda git. `sha` = o sha de main provadamente contido em TODOS os alvos; `targets` = os alvos
   * medidos ("self" para o self-deploy do storymap, medido contra o HEAD do checkout de runtime);
   * `at` = ISO do carimbo; `source` = qual handler mediu. Fail-closed por construção: sem medição não
   * há carimbo, e sem carimbo um card com código não entra em "No ar".
   */
  deployProof?: DeployProof;
  /** sparse ordering key among siblings (10, 20, 30…); drag inserts midpoints */
  order: number;
  created: string | null;
  updated: string | null;
  /**
   * Transient recency signal — the card FILE's mtime in epoch ms, set by readCards
   * (NEVER persisted to frontmatter). Drives the kanban columns' "most-recently-
   * updated on top" sort (see byUpdatedDesc): unlike the day-granular `updated`
   * frontmatter, mtime is sub-second and bumped by EVERY write (human edit, drag,
   * or harness-* skill run), so a touched card rises instantly even multiple times the
   * same day. `Date.now()` is the same epoch-ms unit, so the optimistic client stamp
   * sorts correctly against server mtimes. undefined for in-memory drafts / stat fail.
   */
  updatedMs?: number;
  /** markdown body (description / acceptance criteria / notes) */
  body: string;
}

export interface NamedColor {
  id: string;
  name: string;
  color?: string;
}

// ── Lean Canvas (Ash Maurya) ────────────────────────────────────────────────
// The canvas is no longer a wall of prose per block: a block holds ITEMS (the sticky notes of the
// physical canvas), and each item may carry TAGS from the board's own canvas vocabulary. The tag is
// what STITCHES one item to the segment/theme it belongs to — the same colour reappearing across
// Problema / Solução / Canais is how a human reads a canvas as a coherent system instead of 9 silos.

/**
 * A colour TAG of the Lean Canvas — the board's own vocabulary for identifying and grouping items
 * (typically the customer segments: Descobridor / Organizador / Venue …, but free-form on purpose:
 * a board may tag by theme, risk or hypothesis). Extends NamedColor, so it renders through the same
 * chip + swatch machinery as personas/systems. owner:human — governed (propose→approve).
 */
export type CanvasTag = NamedColor;

/** One item ("sticky note") inside a Lean Canvas block. */
export interface CanvasItem {
  /** Stable id, unique within its block (the governance diff and the UI key both ride on it). */
  id: string;
  /** The content — ONE idea. Splitting prose into items is the whole point of the model. */
  text: string;
  /** Ids of CanvasTag this item belongs to. First tag drives the item's colour. */
  tags?: string[];
  /** Optional in-block group heading (e.g. "Demanda" / "Oferta"); groups order by first appearance. */
  group?: string | null;
  /** The block's headline (e.g. the UVP one-liner) — rendered as a hero note. */
  highlight?: boolean;
}

/** One block of the Lean Canvas (problem, solution, …) — a bag of ordered items. */
export interface CanvasBlock {
  items: CanvasItem[];
}

/**
 * A persona — who the story is for. Modeled on the Value Proposition Canvas
 * (Strategyzer) + Jobs-to-be-Done, so humans AND agents can ground a story in
 * the persona's jobs/pains/gains when authoring or enriching it.
 */
export interface Persona extends NamedColor {
  /**
   * The persona as a single, cohesive SYSTEM PROMPT (PT-BR, 2nd person, "Você é…") — the PRIMARY
   * representation. An agent can ADOPT it to reason/write/decide AS this person; the operator edits it
   * on the bench via the AssistedEditor (direct OR ask-agent), the same co-editing mechanism the
   * skills/strategy-ladder/Canvas use. The structured fields below are LEGACY/optional, kept for
   * back-compat + migration (the UI composes them into a draft prompt when `prompt` is still unset).
   */
  prompt?: string;
  /**
   * O TIPO da persona — o mesmo conceito que `SystemDef.kind`, e o que agrupa a listagem:
   * "Segmento de mercado" (quem o produto quer conquistar) × "Interna" (operação, automação).
   * Texto livre (um board pode ter o seu vocabulário); ausente ⇒ a linha cai no grupo "Sem tipo".
   *
   * A distinção não é decorativa: uma persona interna descreve QUEM OPERA o produto, e um agente
   * que a adote como se fosse um segmento de mercado escreve para o público errado.
   */
  kind?: string;
  /** segment headline, e.g. "Profissional urbano, 30–45, sem filhos" */
  role?: string;
  /** proto-persona: who they are and their relationship to the product */
  description?: string;
  /** Jobs-to-be-Done: functional/social/emotional jobs they want done */
  jobs?: string[];
  /** Pains: frustrations, obstacles and risks they face today (VPC) */
  pains?: string[];
  /** Gains: outcomes and benefits they want (VPC) */
  gains?: string[];
  /**
   * Avatar image for the round actor token on the Story Map — a public path
   * (`/avatars/<board>/<id>.png`) or an absolute URL. Editable in the persona panel
   * (upload/URL now; AI doodle generation later). Falls back to coloured initials when unset.
   */
  avatar?: string;
}

/**
 * A system / touchpoint involved in delivering a story. Described as a capability
 * so agents know what it owns and the constraints they must respect.
 */
export interface SystemDef extends NamedColor {
  /**
   * The system as a single, cohesive PROMPT — what this touchpoint/capability owns and the limits an
   * agent MUST respect, written so a run can adopt it. PRIMARY representation (edited on the bench via
   * the AssistedEditor, incl. `sincronizar` to derive it from the real code). The structured fields
   * below are LEGACY/optional, kept for back-compat + migration (composed into a draft when unset).
   */
  prompt?: string;
  /** what this system/touchpoint is and does */
  description?: string;
  /** category, e.g. "Canal", "Serviço", "Integração", "Dados", "UI" */
  kind?: string;
  /** capabilities/responsibilities this system owns */
  capabilities?: string[];
  /** known limits, gotchas and constraints agents must respect */
  constraints?: string[];
  /**
   * Repo-root-relative globs of the CODE this system maps to (e.g. the engine →
   * `packages/storymap-ui/src/lib/storymap/runner/engine.ts`). The drift detector uses these to know
   * when the underlying code changed since the prompt was last derived. Set once (or proposed by the
   * sincronizar agent); rarely changes.
   */
  paths?: string[];
  /**
   * The git SHA the current `prompt` was derived from (stamped on every sincronizar/save). A system is
   * STALE ⟺ there are commits touching its `paths` since this SHA — the signal the Inbox drift
   * panel reads to offer a one-click re-sync. Absent ⇒ "never synced" (not flagged as drift).
   */
  syncedCommit?: string;
}

/**
 * Gate ids validated when a card ENTERS a status (see lib/storymap/gates.ts → gate-core.js).
 * GATE_IDS is the SINGLE SOURCE: the GateId type derives from it and repo.ts validates against it.
 *
 * EXHAUSTIVENESS IS RUNTIME-CHECKED, NOT COMPILER-CHECKED: the GATES predicate map lives in
 * gate-core.js (`@ts-nocheck` CommonJS, shadowed by gate-core.d.ts which DECLARES it as
 * `Record<GateId, GateSpec>`). The .js never has to satisfy that declaration, so a new GATE_ID with no
 * predicate would compile clean and `evaluateGate` would silently ALLOW the transition (gate-core.js:
 * `const spec = GATES[gate]; if (!spec) return null`). The guard that keeps GATES ≡ GATE_IDS is the
 * RUNTIME test `gate-exhaustiveness.test.ts`, not the typechecker. (By contrast EntryEffect and the
 * AGENTS registry ARE genuinely compiler-exhaustive — real `Record<…>` over TS-checked sources.)
 */
export const GATE_IDS = [
  "hasAcceptance",
  "hasRefinement",
  "hasTasks",
  "hasRice",
  "hasPrioritization",
  "hasTechPlan", // techPlanReady set by harness-plan (plano-tecnico); not an entry gate after the Plano&Tarefas merge — desenvolver gates on hasTasks
  "hasWireframe", // com-design: harness-ux picked a wireframe option
  "hasCriteriaSpecs", // revisar-codigo (ADR-063 2c): every UI-observable acceptance criterion has an authored spec (shift-left; default-satisfied on absent)
  "hasBuildEvidence", // revisar-codigo (C2/ny4v26): every declared task done + delegates hasCriteriaSpecs — build evidence before review; via the pre-write hook it binds ANY writer, including a manual status flip
  "hasNoBlockers", // qa-automatizado: code review left no open blocker
  "hasQaPassed", // revisao: automated acceptance/E2E + visual QA is green (user stories)
  "hasRefineBrief", // refinar: a refinement must carry a free-text brief
  "hasBugReport", // corrigir: a bug fix must carry a free-text report
  "hasRetireBrief", // descontinuar: a retirement must carry a free-text reason
  "hasDuplicateOf", // duplicado: a duplicate must point at its canonical card (ADR-056)
  "hasStaged", // Fase 4b: the run's code was integrated onto the `stage` branch (split)
  "hasReleased", // Fase 4b (fail-closed since deploy-truth): `releasedAt` stamped OR the card positively declares no code (no stagedAt AND no commitRange) — guards the terminal of a board without delivery steps
  "hasDeployProof", // deploy-truth WS-1: the SETTLE handler measured (ancestry) that the card's code is in the published sha and stamped `deployProof` — guards the terminal "No ar"; a no-code card passes by the same positive rule as hasReleased
  "hasPlacement", // WS6 (F5): a story entering construction has a parent, a serves, OR an explicit unplacedAck (no silent orphan)
] as const;
export type GateId = (typeof GATE_IDS)[number];

/**
 * Automation skill ids. Most are triggered while a card SITS in a status (the
 * pipeline columns). `harness-sync-card` is the exception: it is NEVER a column
 * trigger — it runs ON DEMAND on a single card (the per-card "Sincronizar"
 * button), reconciling the card with the real code regardless of status.
 *
 * TRIGGER_IDS is the SINGLE SOURCE for the TriggerId type. The engine derives each
 * skill's headless command by convention (`/<triggerId>`, see commandForTrigger in
 * runner/engine.ts — B2 removed the old hand-maintained COMMAND Record), and the
 * exhaustive AGENTS registry (runner/skill-registry.ts, `Record<TriggerId, AgentDef>`)
 * forces an entry per id at compile time. COLUMN_TRIGGER_IDS is the subset a board.yaml
 * column may declare (everything except the on-demand harness-sync-card) — repo.ts validates
 * a status `trigger` against it.
 */
export const TRIGGER_IDS = [
  "harness-capture", // capturando: free text → proposal sidecar (async smart capture, human accepts in Inbox)
  "harness-enrich",
  "harness-grill", // grill: ask the human context questions (human-in-the-loop; does NOT advance)
  "harness-interview", // interview: simulate 3 persona interviews (1 critical lens) — discovery for user stories
  "harness-tasks",
  "harness-prioritize",
  "harness-plan", // plano-tecnico: write the technical plan sidecar
  "harness-ux", // design-ux: generate low-fi wireframe options
  "harness-ui", // design-ui: spec the main components/screens from the chosen wireframe
  "harness-do",
  "harness-review", // revisar-codigo: review + self-repair the diff
  "harness-qa", // qa-automatizado: run acceptance E2E + headless visual QA before human review
  "harness-refine", // refinar: diagnose shipped code + respec the delta + route
  "harness-fix", // corrigir: diagnose the regression + respec expected×actual + route
  "harness-retire", // descontinuar: diagnose the live feature + plan + remove it at the chosen level
  "harness-sync-card", // on-demand: reconcile ONE card with the live code + reposition it
  "harness-resolve", // WS-10/D14: COLUMN-LESS semantic judge of a text divergence (cosmetic × substantive)
] as const;
export type TriggerId = (typeof TRIGGER_IDS)[number];

/**
 * Triggers a board.yaml column may declare — all EXCEPT the two that have no column by design:
 *   - `harness-sync-card` — on-demand (the per-card "Sincronizar" button), on any status.
 *   - `harness-resolve` (WS-10) — the semantic judge. It is born ONLY from the train's/release's conflict
 *     disposition, exactly as the redrive is born from the RedriveHandler: there is no "resolving" column
 *     and a card never sits in one. Wiring it to a column would let the PIPELINE spawn a judge with no
 *     divergence to judge — the guard in skill-board-consistency.test.ts is what keeps that true.
 * repo.ts validates a status `trigger` against this list, so the exclusion is enforced at config load,
 * not merely documented.
 */
export const COLUMN_TRIGGER_IDS: readonly TriggerId[] = TRIGGER_IDS.filter(
  (t) => t !== "harness-sync-card" && t !== "harness-resolve",
);

/**
 * Model tier passed to the headless `claude` CLI via `--model` when the runner
 * spawns a skill for a column. Aliases auto-resolve to the latest per plan.
 */
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Reasoning effort passed via `--effort`. Higher = deeper reasoning, more cost.
 * Mirrors the interactive `/effort` levels (no `--fast` headless → use `low`).
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// --- Code review (Fase D) --------------------------------------------------
/** Which lens produced a finding (maps to a domain review skill/agent). */
// ── Human-in-the-loop questions (HITL) ──────────────────────────────────────
/** open until a human answers it on /perguntas. */
export type QuestionStatus = "open" | "answered";
export const QUESTION_STATUSES: QuestionStatus[] = ["open", "answered"];

/** How the human picks among an agent's suggested answers — "single" (radio) or "multi" (checkbox).
 * A free-text answer is ALWAYS available regardless of mode. */
export type QuestionMode = "single" | "multi";
export const QUESTION_MODES: QuestionMode[] = ["single", "multi"];

/** One agent-suggested answer option on a question (harness-grill proposes; the human picks). */
export interface QuestionOption {
  /** stable id within the question (o1, o2, …) */
  id: string;
  /** the human-facing option text */
  label: string;
  /** why this path is good — short bullets the agent offers to help the human decide. */
  pros?: string[];
  /** the downside/cost of this path — short bullets. */
  cons?: string[];
  /** the agent's recommended pick (at most ONE option in a question should set this). */
  recommended?: boolean;
}

/** One HITL question on a card — see {@link Card.questions}. */
export interface CardQuestion {
  /** stable id within the card (q1, q2, …) */
  id: string;
  /** the question text (one crisp, open question) */
  text: string;
  /** who raised it — a trigger id ("harness-grill") or "operator" (a human follow-up). Lean: omitted if unset. */
  askedBy?: string;
  /** date the question was raised (YYYY-MM-DD). Lean: omitted if unset. */
  askedAt?: string;
  status: QuestionStatus;
  /** the human's answer (present once status === "answered"). */
  answer?: string;
  /** date the answer landed (YYYY-MM-DD). */
  answeredAt?: string;
  /** F6.3 — quem respondeu: "human" (default) ou "copilot" (o Jido apurou o fato e respondeu). Exibido
   *  na fila /perguntas e no panel do chat ("respondida pelo Jido"). Omitido = human (lean). */
  answeredBy?: string;
  /** agent-suggested answer options (harness-grill). The human picks 1 (single) / N (multi) AND/OR types a
   * free answer. Omitted when the agent suggested none (the question is pure free-text). */
  options?: QuestionOption[];
  /** how `options` are chosen — "single" (radio) or "multi" (checkbox). Default "single". A free-text
   * answer is ALWAYS available too. */
  mode?: QuestionMode;
  /** which option ids the human selected (structured, alongside the free-text `answer`). */
  selectedOptionIds?: string[];
  /** why the agent is asking — the context/stakes that help the human decide (one or two lines). */
  context?: string;
  /** the agent's recommended answer in prose, for a PURE free-text question (no discrete options). */
  recommendation?: string;
}

export type ReviewLens = "firestore" | "nextjs" | "perf" | "security" | "testing" | "general";
/** blocker gates `revisao`; high/medium/low only annotate. */
export type FindingSeverity = "blocker" | "high" | "medium" | "low";
/** open blocks the gate; the human clears it via fixed/wontfix (or re-running). */
export type FindingStatus = "open" | "acknowledged" | "fixed" | "wontfix";

export const REVIEW_LENSES: ReviewLens[] = ["firestore", "nextjs", "perf", "security", "testing", "general"];
export const FINDING_SEVERITIES: FindingSeverity[] = ["blocker", "high", "medium", "low"];
export const FINDING_STATUSES: FindingStatus[] = ["open", "acknowledged", "fixed", "wontfix"];

/**
 * ADR-063 (4d) — failure TAXONOMY for a QA/verification red, ORTHOGONAL to `lens` (review domain)
 * and to `RunOutcome` (process death). Answers "who owns this red": `infra` = the env/stack broke
 * (MODULE_NOT_FOUND, interactive emulator prompt, port in use, OOM) — NOT the card's fault; `test` =
 * the spec/selector is wrong (passes at another layer, bad locator); `app` = the criterion is
 * genuinely unmet by the product. Sparse/optional (old findings and review findings carry none).
 * Auto-attributed by `classifyFailure` (runner/findings.ts); the harness-qa skill stamps it on the blocker.
 */
export type FailureClass = "infra" | "test" | "app";
export const FAILURE_CLASSES: FailureClass[] = ["infra", "test", "app"];

/**
 * ADR-063 (2c) — one acceptance criterion mapped to the spec that proves it (the shift-left artifact
 * harness-tests/harness-do author). `specPath` absent/null = not yet authored → gate `hasCriteriaSpecs` routes
 * the card back instead of letting QA re-author it.
 */
export interface CriterionSpec {
  /** the acceptance criterion text this spec covers (verbatim, matches an entry in acceptance[]) */
  criterion: string;
  /** repo-relative path of the spec that proves it; null/absent = not yet authored */
  specPath?: string | null;
}

/** One code-review finding stored on a card (written by harness-review). */
export interface Finding {
  /** stable id, unique within the card */
  id: string;
  lens: ReviewLens;
  severity: FindingSeverity;
  title: string;
  detail?: string;
  /** file path the finding is about (repo-relative) */
  file?: string | null;
  line?: number | null;
  /** proposed fix (set when harness-review couldn't safely auto-apply it) */
  suggestion?: string;
  status: FindingStatus;
  /** ADR-063 (4d): auto-attributed failure class (infra|test|app) — sparse; absent on review findings. */
  failureClass?: FailureClass;
  /**
   * WS-2 (2.3) — WHO last changed `status`, and WHEN (YYYY-MM-DD). Sparse: both absent until someone
   * triages the finding (a freshly minted `open` is a mint, not a status CHANGE, so it stamps nothing).
   * Actors: "human" (the operator via the UI), "copilot" (an agent via the `triage_finding` MCP tool),
   * "train:<runId>" (a run's own blockers auto-resolved on integration), "audit:<trigger>" (the
   * capability audit clearing its advisory), "terminal:<status>" (residual mechanism blockers superseded
   * when the card entered a terminal status).
   *
   * Forensics, NOT merge input: the pair rides ALONG with its element through
   * {@link mergeIdentifiedArrayThreeWay} and never arbitrates it. It exists because the colisão #2
   * post-mortem could not answer "who closed this, and did it survive?" from the card alone. Unlike
   * `answeredBy` (omitted for a human, F6.3's lean default), "human" IS stamped: an absent `statusBy`
   * has to keep meaning "never triaged / pre-dates this field", which a lean default would erase.
   */
  statusBy?: string;
  /** WS-2 (2.3) — date (YYYY-MM-DD) of the last `status` change. Always written together with
   *  {@link Finding.statusBy}; sparse on the same terms. */
  statusAt?: string;
}

// --- Wireframes (Fase C) ----------------------------------------------------
// 1..N low-fi UI/UX options live in a SIDECAR (storymap/boards/<b>/wireframes/
// <id>.json), never in the card .md (HTML/ASCII are big + multi-line). The card
// keeps only `wireframeChosen` (the picked option id).
export type WireframeDirection = "on-brand" | "adjacent" | "fresh-slate";
// `dsl` (ADR-06x) is the CURRENT format: a structured UI tree (WireframeNode) the LLM emits instead
// of hand-typed ASCII (which it cannot column-align — see wireframe-dsl/types.ts). It renders as a
// deterministic flexbox layout for the human AND projects to aligned text (dslToText) for markdown/
// terminal/copilot. `ascii`/`mermaid` remain for legacy sidecars; `html` is legacy-only (not rendered).
export type WireframeFormat = "html" | "ascii" | "mermaid" | "dsl";
export type WireframeViewport = "mobile" | "desktop";
export type WireframeRenderState = "populated" | "empty" | "loading" | "error";

export interface WireframeOption {
  id: string;
  label: string;
  direction: WireframeDirection;
  rationale: string;
  format: WireframeFormat;
  viewport: WireframeViewport;
  /** which UI state this frame depicts (forces state-coverage thinking) */
  state: WireframeRenderState;
  /** px height hint for the iframe (sandbox blocks auto-resize) */
  heightHint: number | null;
  /** the HTML srcDoc / ASCII art / Mermaid source (for `dsl`, the code-generated aligned-text projection) */
  content: string;
  /** the structured UI tree — present + authoritative when `format === "dsl"`; `content` is derived from it */
  dsl?: WireframeNode | null;
}

/**
 * The usage JOURNEY harness-ux writes (the user flow + free-text narrative) BEFORE any screen
 * exists — the brief the harness-ui screens then realize in the SAME threaded session. Rendered
 * alongside the design canvas in the Inbox so the human approves flow + screens together.
 */
export interface WireframeJourney {
  /** flow format — `graph` (structured FlowGraph, rendered as a real SVG diagram) is the CURRENT
   *  format; `mermaid`/`ascii` remain for legacy sidecars (rendered as text source, as always) */
  format: "graph" | "mermaid" | "ascii";
  /** the text projection of the flow. For `graph` it is DERIVED (graphToText) on every read —
   *  never authored — so all text surfaces (markdown/terminal/copilot) stay faithful to the graph;
   *  for legacy formats it is the authored mermaid/ascii source, unchanged. */
  flow: string;
  /** the structured flow — present + authoritative when `format === "graph"` */
  graph?: FlowGraph | null;
  /** coerce diagnostics for `graph` (dropped edges, truncation) — DERIVED on every read and shown
   *  as a warning on every surface, so a repaired graph can never look complete (never silent) */
  issues?: string[];
  /** free-text PT-BR: how the user reaches/navigates/uses the feature + how it fits the rest of the app */
  narrative: string;
  generatedBy: string;
  updated: string | null;
}

// --- Design Canvas (Canvas v2) ----------------------------------------------
// The FREE CANVAS the harness-ui skill composes instead of N antagonistic single-choice options: typed
// artifacts (screens, components, sub-flows, notes) that TOGETHER express one design, plus a
// per-artifact human feedback thread. `options[]`/`chosenOptionId` stay for legacy sidecars (a
// pure selector derives canvas artifacts from them at render time — never persisted; see
// design-canvas.ts). The com-design gate is untouched: `wireframeChosen` now points at the PRIMARY
// screen artifact id.

export type DesignArtifactKind = "screen" | "component" | "flow" | "note";
/** `html` is ONLY honored when explicitly authored (never inferred — a malformed string must not
 *  drift into the sandboxed-iframe path); a bare string artifact coerces to `text`. */
export type DesignArtifactFormat = "dsl" | "html" | "graph" | "text";

export interface DesignArtifact {
  id: string;
  kind: DesignArtifactKind;
  /** human title (the card header on the canvas) */
  title: string;
  /** rationale/annotation — why this artifact, what it realizes, what it reuses */
  note: string;
  format: DesignArtifactFormat;
  viewport: WireframeViewport;
  /** which UI state a screen depicts; null for non-screen artifacts */
  state: WireframeRenderState | null;
  /** the structured UI tree — present + authoritative when `format === "dsl"` */
  dsl?: WireframeNode | null;
  /** simplified HTML source — present ONLY when `format === "html"` (≤ MAX_HTML_ARTIFACT_BYTES;
   *  rendered exclusively via the sandboxed HtmlArtifactFrame, projected via htmlToText) */
  html?: string | null;
  /** a sub-flow — present + authoritative when `format === "graph"` (the MAIN journey lives in
   *  `journey`, not here) */
  graph?: FlowGraph | null;
  /** the code-derived text projection (dslToText / graphToText / htmlToText / the note text) —
   *  what every text surface reads; never authored for dsl/graph/html */
  content: string;
  /** id of the journey graph node this screen realizes (badge + cross-link); null when unset */
  journeyRef?: string | null;
  /** px height hint for the html iframe (the sandbox blocks auto-resize) */
  heightHint?: number | null;
}

/** One entry of the human feedback thread on the canvas (sidecar-only — no card field). */
export interface DesignFeedbackEntry {
  id: string;
  /** the artifact it targets; null = the canvas/journey as a whole. A dangling id is KEPT (the
   *  thread survives a regen that re-minted ids) and rendered as canvas-wide history. */
  artifactId: string | null;
  /** `change` = a request the next design run must incorporate (unresolved until stamped);
   *  `approve` = an explicit keep signal — informational, never triggers a regen */
  kind: "change" | "approve";
  note: string;
  by: string;
  at: string | null;
  /** stamped by harness-ui at the end of the design pass that incorporated it; null = unresolved.
   *  A crash between reading and stamping just re-applies the feedback next run — benign. */
  resolvedAt: string | null;
}

export interface WireframeDoc {
  cardId: string;
  status: "draft" | "chosen";
  /** the primary artifact/option id (mirrored to card.wireframeChosen for the hasWireframe gate);
   *  validated against options[] ∪ artifacts[kind=screen] */
  chosenOptionId: string | null;
  generatedBy: string;
  updated: string | null;
  /** the usage journey (harness-ux); null until it runs — the canvas below realizes it */
  journey: WireframeJourney | null;
  /** LEGACY single-choice options (pre-canvas sidecars) — kept readable forever */
  options: WireframeOption[];
  /** the design canvas (harness-ui) — authored artifacts; [] on legacy sidecars */
  artifacts: DesignArtifact[];
  /** the human feedback thread (per-artifact + canvas-wide) */
  feedback: DesignFeedbackEntry[];
}

/** Efeito side-effectful disparado quando um card ENTRA num step (B3 — eixo declarativo, despachado
 * por ENTRY_EFFECTS em actions.ts). Lista exaustiva → um efeito novo é 1 valor aqui + 1 entry no map.
 *   - `promote-stage`: promove o código staged `stage` → `main` (promoteStageToMain) + stamp releasedAt.
 *   - `deploy-board`: publica para Live (deployBoard, board-aware: storymap = rebuild+restart detached).
 *   - `promote-and-deploy` (ADR-059): a CADEIA do Deploy (toque #2) — promote-stage E DEPOIS deploy-board,
 *     numa única ação. O modelo colapsado (`release` autorun:false, ponto de descanso "pronto-mas-não-no-ar")
 *     promove para main SÓ no clique de Deploy, não antes. */
export const ENTRY_EFFECTS_IDS = ["promote-stage", "deploy-board", "promote-and-deploy"] as const;
export type EntryEffect = (typeof ENTRY_EFFECTS_IDS)[number];

/**
 * A pipeline status (a STEP), decomposed into four cohesive facets — the ~17-field god-object that
 * grew over Fases 1→4c (ADR-057 "dívida conhecida"). Each facet groups fields read together by the
 * same consumer; `StatusDef` is their intersection, so it stays STRUCTURALLY IDENTICAL to the old
 * flat interface (every existing reference and the flat `coerceStatuses` spread keep compiling) — a
 * pure types refactor, zero API/runtime change. Read from board.yaml.
 *
 *   - {@link StatusCore}         identity (NamedColor) + structural lane/routing classification
 *   - {@link StatusPipeline}     cascade/automation behavior the engine kernel reads
 *   - {@link StatusRunPolicy}    per-column spawn policy → CLI flags
 *   - {@link StatusPresentation} human-facing copy
 */

/** Identity + STRUCTURAL classification of a step: what kind of lane it is (terminal/staging) and
 *  where it sits for display (column) / routing (skipForTypes). The shape the kernel keys off. */
export interface StatusCore extends NamedColor {
  /**
   * SHORT label (sigla) for the step — a compact code (≤6 chars, e.g. "DEV", "QA", "SPEC") shown in the
   * phase's step-trail chips on the kanban header, where the full `name` would wrap. VIEW-only; the kernel
   * never reads it. Declared in board.yaml; the UI falls back to `name` when absent. Keep it terse + upper.
   */
  short?: string;
  /**
   * Terminal/done state — the END of the delivery pipeline (e.g. `concluida`).
   * The prioritization "Em aberto" (open) scope hides cards in a terminal status.
   * Flagged EXPLICITLY in board.yaml because the terminal column is NOT guaranteed
   * to be `statuses[length-1]`: the pipeline carries a `refinar` re-entry column
   * near the tail, so a positional `statuses[length-1]` heuristic is unreliable.
   */
  terminal?: boolean;
  /**
   * DELIVERED state — this step means "shipped, live in the product". A STRICT SUBSET of `terminal`:
   * every terminal lane ends the pipeline, but only THIS one ended it by delivering. `arquivados`,
   * `duplicado`, `cancelado` and `capturado` are terminal and NOT delivered.
   *
   * Read by `deliveredIndex` (lib/storymap/delivered.ts) to describe what the product ALREADY DOES —
   * the context that keeps prioritization from re-proposing what exists. FAIL-CLOSED by design: a
   * board that doesn't declare it gets an EMPTY index and the section is omitted from the prompt,
   * because a signal that can lie about what shipped is worse than no signal. Never inferred from
   * `terminal` or from column position — both would classify a CANCELLED card as a live capability.
   */
  delivered?: boolean;
  /**
   * Staging lane (e.g. `triage`): an intake holding pen that is NOT a build column.
   * A staging status never catches a brand-new card (entryStatus skips it) and never
   * drives the autorun build cascade — items sit here until a human/agent resolves
   * them (accept / duplicate / decline). See ADR-056.
   */
  staging?: boolean;
  /**
   * STAGE grouping — the id of the visual COLUMN this step belongs to (see
   * BoardConfig.columns). A step is the atomic pipeline unit the engine walks; a
   * column groups consecutive steps for DISPLAY only (a column may hold one step
   * rendered as a plain column, or several steps as internal sub-lanes). Purely
   * presentational — the cascade kernel/gates/autorun never read it. Undefined =
   * ungrouped (legacy flat render, one column per status).
   */
  column?: string;
  /**
   * storyTypes that SKIP this step in the build cascade (e.g. the design steps skip
   * technical/chore/spike/bug — no UI surface). Generalizes the hardcoded
   * UI_DESIGN_STATUSES skip (pipeline-routing.ts) to a per-step, data-driven rule:
   * the cascade FORWARDS past a step whose `skipForTypes` includes the card's
   * storyType (statusSkipsForType). Empty/undefined = every type traverses it. Pure
   * routing/view metadata — no gate impact.
   */
  skipForTypes?: StoryType[];
  /**
   * WS4 — DECLARATIVE dispensability: when true, this step MAY be bypassed by a card's per-instance
   * `routing.skips` (a named RouteProfile's skip list) OR the reopen heuristic. Makes explicit what was a
   * heuristic (skipForTypes + column + hardcoded ids in skip-routing.ts): `_base` marks it on the discovery
   * interview, the design block, `ready`, and `priorizar`. It is a routing FACET only — it NEVER weakens a
   * gate, and it can NEVER apply to a LOAD_BEARING step (plano-tecnico/desenvolver/revisar-codigo/qa-*): the
   * kernel guard + a lint reject `dispensable:true` there. Absent/false = only the legacy fallback decides.
   */
  dispensable?: boolean;
  /**
   * ADR-059 — when true, the cascade MAY auto-advance FROM this step INTO the next one
   * even when that next step is `terminal`. By default the cascade NEVER enters a terminal
   * (closing the pipeline is an explicit human act): `decideForward`/`decideAdvance` stop
   * at `!next || next.terminal`. This flag is the one declarative exception — the `deploy`
   * (Publicar) step sets it so a successful Deploy auto-advances the card to `concluida`
   * (No ar). Default-OFF for EVERY other terminal (re-entry close, archived, …), so the
   * cascade kernel stays PURE/column-agnostic: it reads ONLY this flag on the SOURCE step,
   * declared in board.yaml, never a hardcoded id. Lido só no forward.
   */
  autoEnterTerminal?: boolean;
  /**
   * VIEW-only (ADR-059 entrega colapsada). When EVERY step of a column declares `laneStep:true`, the
   * kanban renders that column as ONE delivery lane with a per-card STEPPER (evolving status text +
   * step counter + the Aprovar/Publicar buttons) instead of N separate status lanes — so the 5 delivery
   * steps (revisao→merge→stage→release→deploy) read as a single "Entrega" card moving through its
   * internal steps. Read ONLY by the kanban render (StageColumn/KanbanCard); the cascade kernel / gates /
   * autorun NEVER read it. Declared in board.yaml.
   */
  laneStep?: boolean;
  /**
   * VIEW-only (reabertura R1 cosmetic). Hide this step's LANE from the kanban — for the vestigial reentry
   * executors (refinar/corrigir) that no longer receive cards now that a reopen lands DIRECTLY in its
   * chosen destination (the statuses are kept for the lint + the legacy in-flight path, but their lanes
   * are dead weight). Cards in a hidden status are filtered out of the board like a `system` column —
   * but UNLIKE `system` on a COLUMN, this is PER-STATUS, so a sibling executor in the SAME column that is
   * NOT hidden (e.g. `descontinuar`, a live harness-retire executor) stays fully visible and launchable. Read
   * ONLY by the kanban render; the kernel never reads it. Stray cards (migration) surface in the loose
   * no-status group rather than being lost.
   */
  hidden?: boolean;
}

/** Cascade/automation behavior the engine kernel reads to walk a card through the step: its entry
 *  gate, the skill that processes it, whether it auto-pilots, and any effect-on-entry. */
export interface StatusPipeline {
  /** gate validated when a card moves INTO this status; undefined = no gate */
  gate?: GateId;
  /** automation that processes cards sitting in this status; undefined = none */
  trigger?: TriggerId;
  /**
   * Auto-pilot flag (per-column toggle in the kanban). When true and a card
   * enters this status, the trigger-runner channel either RUNS the skill (if the
   * status has a `trigger`) or FORWARDS the card to the next status (a gated
   * landing with no trigger — the cascade bridge). Anything other than `true`
   * means manual: the card stops here. See trigger-runner-channel.ts.
   */
  autorun?: boolean;
  /**
   * Fase 4b/4c (B3) — EFEITO ao ENTRAR no step, declarativo: substitui os booleanos ad-hoc
   * promotesStage/deploysBoard por UM eixo extensível. moveCardAction despacha por um map único
   * (ENTRY_EFFECTS) — uma nova ação-ao-entrar = 1 valor no enum + 1 entry no map, não [boolean +
   * coerce + if clonado]. Só dispara numa MUDANÇA REAL de status; só faz efeito com `autorun.staging`.
   *   - `promote-stage`: promove o código staged `stage` → `main` (promoteStageToMain) + stamp releasedAt.
   *   - `deploy-board`: publica para Live (deployBoard, board-aware: storymap = rebuild+restart detached).
   *   - `promote-and-deploy` (ADR-059): a cadeia do Deploy — promote-stage E DEPOIS deploy-board numa ação.
   */
  onEnter?: EntryEffect;
}

/**
 * WS3 (F2) — a board-level CAPABILITY config, referenced by id from `StepToolkit.use[]`. Declarative
 * so a consumer with its OWN MCP servers adds a capability with ZERO code: the use-classification is a
 * `match` regex (not a hardcoded capability enum), and the mount is a templated `mcp` path. Lives on
 * `BoardConfig.toolConfigs` (inherited from `_base`, merged BY ID — a board override wins per key).
 */
export interface ToolConfigDef {
  /** repo-relative path to an MCP config JSON to mount (`--mcp-config`). Templates `{board}` and
   *  `{repoRoot}` are expanded at resolution (so `storymap/graphify/{board}.json` → the per-board graph). */
  mcp?: string;
  /** a regex (as a string) matching the tool NAMES this capability evidences in telemetry `toolsUsed`
   *  (e.g. `^mcp__graphify__`) — the DECLARATIVE use-classifier, no hardcoded capability enum. */
  match?: string;
  /** v1 INFORMATIONAL only: a CLI this step relies on — folded into the composed guidance, NOT
   *  classified as used (Bash calls aren't reliably attributable in `toolsUsed`). */
  cli?: string;
  /** human-readable purpose, surfaced in the composed guidance + the board-integrity lints. */
  description?: string;
  /**
   * CAPABILITY CONTRACT — the abstract capability id this config PROVIDES (e.g. `browser`, `codegraph`).
   * Two configs may provide the SAME capability: that is what makes {@link fallback} meaningful (one
   * capability, N interchangeable providers). Free-form by design — a consumer repo names its own
   * capabilities without touching this package's code.
   */
  provides?: string;
  /**
   * CAPABILITY CONTRACT — a shell command that PROVES this provider actually works on THIS host, exit 0
   * = available. Declared, never inferred: a mount file existing on disk says nothing about whether the
   * server can start or the binary it drives is installed (the `chrome-devtools` incident — the MCP
   * handshook fine while every tool call failed for want of a Chrome binary). Runs with a timeout, no
   * shell interpolation of card/run data. Absent ⇒ this provider is UNPROVABLE and can never be selected
   * as the active one when a rival provider has a probe (see `capability-probe.ts`).
   */
  probe?: string;
  /** timeout for {@link probe}, ms. Default {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
  /**
   * CAPABILITY CONTRACT — the id of ANOTHER toolConfig to fall back to when this one's probe fails. The
   * fallback must `provides` the same capability (enforced by {@link lintToolkit}). Chains are followed
   * transitively; cycles are a lint ERROR.
   */
  fallback?: string;
  /**
   * CAPABILITY CONTRACT, fourth leg — this provider does its work OUTSIDE the run's Bash sandbox, so under
   * containment it cannot see anything the run creates inside a Bash call.
   *
   * WHY THIS IS A DECLARATION AND NOT A PROBE. A probe answers "does this work on THIS HOST?". Reachability
   * is not a property of the host — it is a property of the CALL. No probe can measure that, because the
   * probe itself runs somewhere (here: the service process, on the host) and would only ever report on ITS
   * OWN topology.
   *
   * Two DISTINCT mechanisms, worth keeping apart because they mislead in different ways:
   *   · FROM A HOST-SIDE PROCESS, while the call is still running — a network namespace boundary. Measured
   *     in one run, same instant, same URL: the chrome-devtools MCP navigated to a host server fine while a
   *     Bash `curl` to it returned rc=7. Egress inside the jail goes through the ASRT proxy, which filters
   *     BY DOMAIN and is not an ingress route — putting `127.0.0.1` in `allowedDomains` changes nothing.
   *   · FROM THE NEXT CALL — not unreachability at all: the server is DEAD. The jail's PID-1 exits at the
   *     end of the call and takes the tree with it (`setsid`/`nohup` do not save it under `--unshare-pid`).
   *     Diagnosing this as "a routing problem" sends you hunting for a network knob that does not exist.
   *
   * A WARNING ABOUT THE INSTRUMENT, because it already fooled one measurement: `readlink /proc/self/ns/net`
   * does NOT prove per-call isolation. The inode is RECYCLED — `net:[4026532407]` comes back identical
   * across calls, across sessions, hours apart. It proves "not the host" and nothing more. The instrument
   * that works is to MARK the namespace (`ip addr add 127.0.0.9/8 dev lo` in call A, look for it in B).
   *
   * The concrete case this exists for is `browser` (chrome-devtools MCP). Its server is a child of the CLI
   * process, and the containment wraps Bash calls, not the CLI — measured, the whole Chrome tree sits in the
   * host's netns. Navigating to a server inside the jail returns net::ERR_CONNECTION_REFUSED while the same
   * server on the host answers. Worse, chrome-devtools reports that failure with `isError: false` (the error
   * is only in the content text), so even a probe aimed at the right URL would come back green.
   *
   * Effect: the capability preflight DROPS such a provider from the chain when the run will be contained —
   * before probing, so no verdict is ever cached for a topology it cannot answer for. The chain then falls
   * through to a provider that runs INSIDE the call (for `browser`: the Playwright script), which is the one
   * that can actually see the run's own screens.
   */
  outsideRunSandbox?: boolean;
}

/** Default timeout for a capability probe (ms) — generous enough for a cold `npx` download of an MCP
 *  server, short enough that a hung probe never wedges the dispatch path. */
export const DEFAULT_PROBE_TIMEOUT_MS = 90_000;

/**
 * Expectation level of a toolConfig at a step, from strongest to weakest:
 *  - `required` — the step CANNOT do its job without it. Enforced BEFORE the spawn by the capability
 *    preflight (the provider chain must prove itself on this host, or the run is settled $0 with an infra
 *    diagnosis). A `required` entry whose chain has no `probe` is a board LINT ERROR — that combination is
 *    the "declared capability with zero producers" shape, which is precisely what gets a card wedged.
 *  - `expected` — the step SHOULD exercise it; unused drives a SOFT, gate-free advisory (the toolGap
 *    audit). Never blocks, never probed. This is the historical level and its meaning is unchanged.
 *  - `advisory` — telemetry only. `off` — nothing.
 *
 * The split matters: `expected` is about whether the AGENT used a tool it had; `required` is about whether
 * the HOST can offer it at all. Conflating them would either force a probe onto every soft audit or leave
 * the hard requirement unenforced.
 */
export type ToolExpectLevel = "required" | "expected" | "advisory" | "off";

/**
 * A CARD predicate that narrows when an expectation applies. Closed set on purpose: the value names a
 * property the KERNEL already owns, never a product concept, so board.yaml stays declarative and this
 * package stays app-agnostic. Extending it is one entry here + one branch in `expectationApplies`.
 *  - `uiSurface` — only for cards with a UI surface, per the canonical evidence-first `hasUiSurface`.
 */
export type ToolExpectCondition = "uiSurface";

/** WS3 (F2) — one per-tool expectation entry: `tool` is a `BoardConfig.toolConfigs` id. */
export interface ToolExpectation {
  tool: string;
  level: ToolExpectLevel;
  /**
   * Restrict the expectation to cards matching this predicate. Load-bearing for `required`: the QA step
   * needs a browser for a card with screens and needs NOTHING of the sort for a technical chore — without
   * the condition, a host with no browser would stop cards that never wanted one, turning a targeted
   * guard into a pipeline-wide outage. Absent = applies to every card.
   */
  when?: ToolExpectCondition;
}

/**
 * WS3 (F2) — the TOOLKIT facet of a StatusDef: what a step MOUNTS (`use`), what it's EXPECTED to
 * exercise (`expect`), the usage GUIDANCE injected into the run's system prompt, an optional hard ACI
 * allow-list (`allowedTools`, O3.7), and the specialist ids it may delegate to (`specialists`, WS4). A
 * board override REPLACES the whole facet per step (shallow, like the other StatusDef facets). Fail-open
 * everywhere — a missing/partial toolkit degrades to the legacy `mcpConfig` behavior byte-for-byte.
 */
export interface StepToolkit {
  /** toolConfig ids (`BoardConfig.toolConfigs`) to MOUNT for this step → `--strict-mcp-config --mcp-config`. */
  use?: string[];
  /** per-tool expectation → the capability audit (SOFT finding) + telemetry `toolGap`. */
  expect?: ToolExpectation[];
  /** 1–3 lines injected into the run's system prompt (the compaction-proof channel) prescribing HOW to
   *  use the mounted tools. Lint-capped at 300 chars so it never inflates the per-turn prompt. */
  guidance?: string;
  /** opt-in HARD ACI: emit `--allowedTools` with EXACTLY these tool names (O3.7). Empty/absent = no flag. */
  allowedTools?: string[];
  /** WS4 — specialist registry ids this step may delegate to (composed into the guidance clause). */
  specialists?: string[];
}

/**
 * Per-column automation/spawn POLICY (overrides the global columnDefaults in settings.yaml). All
 * optional — an unset field falls back to the global default, then to the CLI's own default. The
 * runner turns these into `--model` / `--effort` / `--max-turns` / mcp flags at spawn time.
 */
export interface StatusRunPolicy {
  /** model tier for this column's skill (haiku cheap … opus capable) */
  model?: ModelTier;
  /** reasoning effort for this column's skill */
  effort?: EffortLevel;
  /** cap on agentic turns for this column's run (cost guard rail) */
  maxTurns?: number;
  /** opt-in watchdog: kill a code-skill run on this column even when the global
   * code-skill watchdog (timeouts.doMs) is off. Ignored for fast skills. */
  costGuard?: boolean;
  /**
   * Repo-relative path to an MCP config file for THIS column's spawn (emits
   * `--strict-mcp-config --mcp-config <path>`). A headless `claude -p` does NOT
   * auto-load the project .mcp.json (no TTY to trust project servers — verified
   * by spike), so a column that needs MCP tools (e.g. qa-automatizado driving
   * chrome-devtools) must point at its own minimal config. Per-column (not the
   * global extraArgs) so only this column pays the browser/npx spawn cost.
   */
  mcpConfig?: string;
  /**
   * WS3 (F2) — the declarative TOOLKIT facet: what this step mounts/expects, the usage guidance
   * injected into its system prompt, an optional hard ACI allow-list, and its specialist ids (WS4).
   * SUPERSEDES `mcpConfig` (kept as legacy sugar = a single `use` of one mount with no expect); when
   * both are set the resolver mounts BOTH (deduped). Board override replaces the whole facet per step.
   */
  toolkit?: StepToolkit;
}

/** Human-facing copy for the step — board.yaml prose surfaced in the kanban, never read by the engine. */
export interface StatusPresentation {
  /** human-readable purpose of this stage: what it is for and what happens here */
  description?: string;
}

/**
 * A pipeline status = the four facets above. Intersection (not `extends`) keeps it structurally
 * identical to the prior flat interface, so every consumer and the flat `coerceStatuses` literal
 * are unaffected. Add a field to the facet it belongs to; this alias needs no change.
 */
export type StatusDef = StatusCore & StatusPipeline & StatusRunPolicy & StatusPresentation;

export interface ReleaseDef {
  id: string;
  name: string;
  order: number;
  /** Patton: target outcome this release slice delivers (shown to the left of the slice) */
  outcome?: string;
  /** Patton: success metric — how we'll know the outcome happened */
  metric?: string;
}

/**
 * Vocabulário de tipos de nó — o "kind" de um artefato no grafo estratégia↔entrega.
 * Resolução: card type (activity/step/story) | persona id | release id | futuros artefatos
 * (desiredOutcome/inputMetric/idea/canvas) — seam declarado para as stories de artefato.
 */
export const NODE_KIND_IDS = [
  "activity", "step", "story",
  "persona", "release",
  "desiredOutcome", "inputMetric", "idea", "canvas",
] as const;
export type NodeKind = (typeof NODE_KIND_IDS)[number];
export function isNodeKind(v: unknown): v is NodeKind {
  return typeof v === "string" && (NODE_KIND_IDS as readonly string[]).includes(v);
}

export interface LinkTypeDef {
  id: string;
  name: string;
  /** tipos de nó permitidos na ORIGEM da aresta; ausente = sem restrição (legado). */
  from?: NodeKind[];
  /** tipos de nó permitidos no DESTINO da aresta; ausente = sem restrição. */
  to?: NodeKind[];
}

/**
 * A STAGE — the visual column that groups one or more consecutive pipeline steps
 * (StatusDef). Presentational + ownership metadata only; the engine walks STEPS,
 * not columns. A column with a single step renders as a plain column; with several,
 * as a phase holding internal step sub-lanes. `owner` hints who primarily acts in
 * this stage (human gate / agent automation / system) for UI affordances. Ordered
 * by array position in BoardConfig.columns.
 */
export interface ColumnDef extends NamedColor {
  /** who primarily acts in this stage — drives UI affordances, not engine behavior */
  owner?: "human" | "agent" | "system";
  /** human-readable purpose of this stage */
  description?: string;
  /**
   * System column — a non-flow holding area (the archive tombstones: arquivados/duplicado/
   * cancelado/capturado). The kanban does NOT render it as a lane group; its steps are reached
   * via the board-header trash drawer instead (revive from there). Purely presentational — the
   * cascade kernel/gates/autorun never read it (terminal statuses keep their own `terminal` flag).
   */
  system?: boolean;
  /**
   * Session threading — "one agent, many hats". When true, consecutive AUTORUN steps of
   * THIS column reuse ONE `claude` session: the next step spawns with `--resume
   * <prevSessionId>` instead of a fresh one, so the agent carries its context + reasoning
   * across the theme's hats (e.g. Discovery: Especificar → Entrevista → Estimar) and the
   * warm prompt-cache makes the continuation cheap. Read ONLY by the side-effectful cascade
   * shell (evaluateAutorunOnEntry), never by the pure routing/gate kernel. Only honored for
   * back-to-back same-model NON-code steps; a human gate between steps breaks the chain
   * naturally (the cascade stops there, so no resume ever crosses an approval).
   */
  threadSession?: boolean;
  /**
   * A FERRAMENTA que aprofunda esta fase — o id de uma view do board (`BoardView`). Quando presente,
   * o cabeçalho da coluna no Kanban ganha uma porta para ela ("Ver na Esteira →"), com o ícone e o
   * rótulo que a própria view já publica em `nav/nav-groups`.
   *
   * Existe porque a pergunta nasce OLHANDO A COLUNA: quem vê 3 cards parados em Entrega quer saber
   * onde o código deles está — e a resposta é uma tela inteira, não um chip. A porta morava no rodapé
   * do popover de Processos, longe dos cards que a motivam e disputando o clique com o próprio
   * Processos; aqui ela encosta no que a provoca.
   *
   * DECLARATIVO de propósito (regra do pacote: "novo contexto por app → um campo em board.yaml, nunca
   * um mapa cravado no código"). Um `if (column.id === "entrega")` no Kanban seria acoplamento à
   * pipeline canônica — um board com outro desenho de colunas não teria como pendurar a sua.
   * Puramente presentacional: o kernel da cascata, os gates e o autorun nunca leem este campo.
   * Um id que não resolve para uma view é IGNORADO (a coluna só não ganha a porta).
   */
  tool?: string;
}

/**
 * Deploy agnóstico (D-AG1, docs/plans/deploy-agnostic/) — the board's OPTIONAL deploy DESCRIPTOR: how
 * THIS app is published, declared as board config instead of hardcoded per-app routing. Absent (every
 * current board) or `kind: "auto"` ⇒ the LEGACY byte-identical routing derived from `package`
 * (o próprio harness → self-deploy destacado; app na allowlist declarada em settings.yaml → `just orch-deploy`).
 * The descriptor is authored by a human in board.yaml (in the OSS target: by the onboarding agent) —
 * it is the SAME trust class as column triggers: board config, never caller free text.
 *
 * `kind` may be omitted: a block carrying `command` infers "command", one carrying only `description`
 * infers "agent" (the 01-arquitetura-alvo target format declares no kind). Both declared kinds plug
 * into the EXISTING settle→proof→advance cycle (ProductDeployRegistry job + onDone + deploy-truth
 * measurement) — never a parallel cycle.
 */
export interface BoardDeployConfig {
  /** explicit routing; omitted ⇒ inferred from the fields (command ⇒ "command", description ⇒ "agent", neither ⇒ "auto"). */
  kind?: "auto" | "command" | "agent";
  /** kind:"command" — the user's shell that publishes the app (e.g. `vercel deploy --prod`), run
   *  `bash -lc` from the repo root by the SAME registry/launcher as orch-deploy (tracked, logged, onDone). */
  command?: string;
  /** kind:"agent" — free text "how this app is deployed"; a bounded headless claude executes it and
   *  answers the strict {ok, liveSha?} verdict. The verdict NEVER stamps proof by itself — a claimed
   *  liveSha is re-measured by the settle's ancestry ruler before deployProof is stamped (D-AG4). */
  description?: string;
  /** optional health URL handed to the agent as confirmation context (not verified by the harness). */
  healthUrl?: string;
  /**
   * The PUBLICATION-FIDELITY canary for this board's published surface(s): a command that answers
   * "does what is SERVED match what we meant to serve?" and prints `FACE_CANARY {json}` as its last
   * stdout line (see runner/face-probe.ts for the contract).
   *
   * Per-board because a repository can publish several products to several surfaces; `settings.yaml`
   * `deploy.canaryCommand` is the DEFAULT for boards that declare none (a deployment where every
   * board shares one published face declares it once, there). Absent from both ⇒ no canary runs and
   * publication fidelity is simply not checked — never a legacy URL guessed by the harness.
   */
  canaryCommand?: string;
  /** wall-clock budget of the deploy agent, minutes (default 15 — DEPLOY_AGENT_TIMEOUT_MINUTES_DEFAULT). */
  timeoutMinutes?: number;
  /**
   * story-zr1cmf — DEPLOYABLE SURFACES this board owns that live OUTSIDE its `package` (e.g. a
   * Caddy-served static tool under `tools/`). The merge-train split has only two buckets — CODE
   * (`staging.codePrefixes`, e.g. `packages/`) and board DATA (everything else → main, live-by-mtime,
   * no gate). A surface here is the THIRD case: real deployable code whose home is not a package. Each entry:
   *  - `prefix` is treated as CODE by the split → routed to `stage`, so a surface change TRAVELS with the
   *    package code and is held behind the same human release gate (kills the skip-stage + half-landing).
   *    Declaring it here ALSO widens THIS board's release-promote scope (fireReleaseStaged) and excludes it
   *    from OTHER boards' out-of-scope probe. The prefix MUST also appear in the deployment's
   *    `staging.codePrefixes` (the classifier reads the global list; a board-integrity lint keeps them in sync).
   *  - `deployCmd` (optional) runs as a NON-FATAL post-build step of the storymap self-deploy (after a
   *    successful build+restart), so the surface is published WITHOUT a manual step. Honored ONLY on the
   *    self-deploy path (the board whose `package` is the tool itself) — the lint flags it elsewhere.
   * The concrete path/command live here in the SPEC, never hardcoded in engine code (AgileHarness is a
   * generic tool). Absent ⇒ byte-identical legacy behaviour.
   */
  surfaces?: { prefix: string; deployCmd?: string }[];
}

export interface BoardConfig {
  id: string;
  name: string;
  /** optional path to the related code package, e.g. "packages/orbit" */
  package?: string;
  /**
   * story-r4qdap — additional shared packages this board LEGITIMATELY touches beyond its own `package`
   * (e.g. the acme board fixing code that lives in packages/acme-shared/ or packages/orbit/). They
   * WIDEN the release pathspec (fireReleaseStaged codePrefixes) so a fix in a shared package is promoted
   * stage→main instead of being detected as out-of-scope and reverted. Promotion stays idempotent/safe
   * across boards that share a package: there is a SINGLE `stage` branch, so every board promotes the SAME
   * delta — the first wins, a second is a clean `already-promoted` no-op (promoteStageToMain `--3way` +
   * empty-commit guard). Follow-up of story-5vv8n1 (which scoped release to the board's OWN `package`).
   */
  sharedPackages?: string[];
  /**
   * A POLÍTICA DE RELEASE deste board — a ÚNICA declaração de "quem aperta o botão de publicar, e se
   * ele se aperta sozinho". Ausente ⇒ `manual` ({@link DEFAULT_RELEASE_MODE}), o default seguro.
   *
   * Substitui `autorun.publishQueue.boards` (settings), que respondia DUAS perguntas com uma flag:
   * desligá-la tirava tanto o "publica sozinho" quanto o "pode publicar", deixando trabalho de sessão
   * sem saída nenhuma. O `autorun` do passo `deploy` é DERIVADO daqui, nunca autorado por board.
   * Regras e derivações: `runner/release-policy.ts`.
   */
  release?: { mode: ReleaseMode };
  /**
   * Deploy agnóstico (D-AG1) — the optional deploy DESCRIPTOR ({@link BoardDeployConfig}). Absent or
   * kind:"auto" ⇒ legacy package-derived routing, byte-identical (every current board). Threaded by
   * fireDeployBoard into deployBoard, which routes command/agent through the SAME registry + settle cycle.
   */
  deploy?: BoardDeployConfig;
  /** optional repo-relative path to this board's brand-voice doc, injected into the spawn context
   *  note (engine.ts) so even a copy/UX skill honors brand voice. Per-app context that belongs in the
   *  spec, not hardcoded in code. Unset (storymap, nimbus, …) → only the package CLAUDE.md is injected. */
  brandbook?: string;
  /**
   * A URL PÚBLICA da superfície que este board publica — o que o canary de frescor sonda para decidir se o
   * código de um card está mesmo no ar. É a URL COMPLETA (`https://exemplo.com/app/`), não um path: o
   * harness é uma FERRAMENTA GENÉRICA e não pode presumir domínio nem topologia do consumidor. Qualquer
   * repositório declara a sua aqui; nenhum domínio nosso vive no código de decisão.
   *
   * POR QUE EXISTE: o canary sondava uma constante global para TODO board. Onde vários apps compartilham
   * origem e o build é diff-aware (a raiz serve um app e cada sub-caminho serve outro), uma entrega de
   * UM app não reconstrói os outros — a URL global segue servindo um sha antigo, o canary conclui "stale" e
   * REVERTE um card que está provadamente no ar. Medido em 2026-07-18: a raiz servia `e1a1eb291` enquanto a
   * superfície do card servia exatamente o seu `releasedSha`; o card foi revertido 3× e acabou em backoff.
   *
   * Ausente ⇒ cai no default legado do deployment (ver `LEGACY_FACE_URL`), preservando o comportamento
   * atual de quem ainda não declarou. Per-app context pertence à SPEC, nunca a um mapa hardcoded no código.
   */
  faceUrl?: string;
  /** ordered pipeline statuses (the STEPS); may carry gate/trigger/column */
  statuses: StatusDef[];
  /**
   * WS3 (F2) — board-level CAPABILITY registry, keyed by id: each entry declares an MCP mount and/or a
   * `match` regex that classifies a capability's use in telemetry. Steps reference these ids from their
   * `toolkit.use`/`toolkit.expect`. Inherited from `_base` and MERGED BY KEY (a board override wins per
   * id, base fills the rest). Absent = no declarative capabilities (legacy per-step `mcpConfig` still works).
   */
  toolConfigs?: Record<string, ToolConfigDef>;
  /**
   * WS4 — NAMED routing profiles, keyed by id (`full`/`standard`/`express`), declared in `_base` and
   * inherited (merged BY KEY, board override wins per id). harness-enrich picks one per card and stamps the
   * card's `routing` from it. Absent = no profiles (a card routes purely by the static skipForTypes).
   */
  routeProfiles?: Record<string, RouteProfile>;
  /**
   * WS4 — board SPECIALIST registry, keyed by an OPAQUE id → {@link SpecialistDef} (agent slug + when). A
   * step's `toolkit.specialists` references these ids; the engine composes a Task-delegation note. CONSUMER
   * data (the agent slugs live in the consumer's `.claude/agents/`). Merged BY KEY from `_base`. Absent =
   * no specialists (the toolkit note omits the delegation clause — byte-identical legacy prompt).
   */
  specialists?: Record<string, SpecialistDef>;
  /**
   * Optional STAGE grouping over the flat `statuses` (steps). When present, the
   * kanban renders these columns in order, each grouping the steps whose
   * `StatusDef.column` matches its id (steps with no/unknown column fall to a
   * trailing "ungrouped" lane). Absent = legacy flat render (one column per
   * status). Pure presentation — never read by the cascade/gates/autorun.
   */
  columns?: ColumnDef[];
  releases: ReleaseDef[];
  personas: Persona[];
  systems: SystemDef[];
  linkTypes: LinkTypeDef[];
  /**
   * Headroom proxy toggle (per-board, story-5m0r3n). When `enabled`, the engine
   * injects `ANTHROPIC_BASE_URL=<proxyUrl>` into the headless `claude` env so
   * traffic flows through the local headroom compression sidecar (60–95% token
   * reduction). ENV `AGILEHARNESS_HEADROOM_URL` overrides this entry. Probe failure
   * falls back to direct API (passthrough) — runs NEVER block on a broken proxy.
   */
  headroom?: {
    enabled: boolean;
    proxyUrl: string;
  };
  /**
   * 🟨 NEGÓCIO — Posicionamento estratégico (Kotler/Keller, STP): "Para [segmento], a [Marca] é a
   * [categoria] que [benefício] porque [razão]". Direciona marketing E produto (owner:human; propose_change).
   */
  positioning?: string | null;
  /**
   * 🟨 NEGÓCIO — Métrica-maior do negócio (lagging: CLV / participação de mercado / ARR). O "resultado
   * do resultado" que o Resultado-alvo de produto move como alavanca (owner:human; propose_change).
   */
  businessMetric?: string | null;
  /**
   * 🟩 PRODUTO — Resultado-alvo (Desired Outcome / Teresa Torres ≈ Product Goal do Scrum): o resultado
   * de comportamento/negócio que o board persegue agora. É o vértice ao qual as stories sobem; indicador
   * LEADING que prevê a métrica-maior de negócio (owner:human; propose_change).
   */
  desiredOutcome?: string | null;
  /**
   * 🟨 Lean Canvas (Ash Maurya) — block key → the block's ITEMS. An open record: the block keys carry
   * the meaning (problem/solution/…, declared in canvas-blocks.ts). A legacy flat string value is
   * PROMOTED to a single item on read (coerceCanvas), so a board that never migrated still renders.
   * owner:human — change via propose_change / the bench (governance).
   */
  canvas?: Record<string, CanvasBlock | null> | null;
  /**
   * 🟨 Lean Canvas — the board's colour vocabulary for tagging canvas items (the "Segmentos" legend).
   * owner:human — change via propose_change / the bench (governance).
   */
  canvasTags?: CanvasTag[] | null;
  /**
   * story-fr5bnt — per-board autorun kill-switch. When true, evaluateAutorunOnEntry NEVER auto-fires a
   * skill on this board (move/accept/cascade/post-merge/recovery all funnel through that chokepoint); a
   * human still runs skills EXPLICITLY via run_skill/enqueue (which bypass it). Set on `storymap` (the
   * tool's own dogfood board — always a manual guided session). Absent/false = normal autorun.
   */
  autorunDisabled?: boolean;
  /**
   * WS8 (F7) — per-board ORCHESTRATOR/copiloto POLICY (default OFF ⇒ byte-identical when absent). `mode`
   * (off/paired/autonomous) gates the copiloto; `riskMatrix` (O2.5 declarative) maps each risk CLASS to a
   * disposition (auto/ask/never) — the copiloto acts autonomously only on `auto` classes and escalates the
   * rest via ask_question. A board MAY declare `run`/`merge-resolve`/`deploy` as `auto` (F8: an orchestrator
   * that can't run the pipeline, unpark the train or publish can't deliver end-to-end); `run-free` and
   * `destructive` may NEVER be `auto` (business invariant — see {@link NEVER_AUTO_RISK_CLASSES}). Deployment
   * knobs (enabled/tick/budget/tokens) live in settings.yaml (RunnerSettings), not here — this is policy only.
   */
  orchestrator?: OrchestratorPolicy;
  /**
   * D10 — the Style Guide pointer: `{version, hash}` of the CANONICAL `design/style-guide.md`, path-
   * free by construction (the path is always derivable from the board slug — see `designDir`). Written
   * ONLY by the `promoteStyleGuideDoc` chokepoint (design-actions.ts — the single writer, called by the
   * human-authoring apply); NEVER inline content, NEVER via `GOVERNANCE_ARTIFACTS` (that road writes
   * `after` verbatim with no recompile — a side door that would desync pointer↔file). Absent = board has
   * no guide yet (fail-open, byte-identical legacy load). Redacted in the `board-base-pipeline` golden via
   * a DIRECT `VOLATILE_FIELDS` entry, same class as `systems`/`autorunDisabled`/`orchestrator` — it is
   * live operator state, not the pipeline.
   */
  styleGuide?: StyleGuidePointer;
}

/** WS8 — the copiloto's operating mode: `off` (dormant), `paired` (with a human session), `autonomous`. */
export const ORCHESTRATOR_MODES = ["off", "paired", "autonomous"] as const;
export type OrchestratorMode = (typeof ORCHESTRATOR_MODES)[number];

/**
 * WS8 — the risk CLASSES an orchestrator action falls into (O2.5). Each maps to a {@link RiskDisposition}.
 *
 * F8 splits the old single `run` class in two, because they have NOTHING in common but the word "execute":
 *  - `run`      — a PIPELINE verb: `enqueue`/`run_skill`/`cancel_run` take **(board, cardId)** and run the skill
 *                 the BOARD registered for that card's current column. No free text: the blast radius is the
 *                 card + the board's own pipeline. This is the human's everyday "Rodar agora" button.
 *  - `run-free` — a FREE verb: `run_task`/`claude_new`/`claude_send`/`term_new` take a **prompt or a command**
 *                 and spawn `claude --dangerously-skip-permissions` (full built-in Bash), or reach outside the
 *                 board (`git_commit_push`/`sync_repo`/`update_vps`). One call = arbitrary code execution.
 * Collapsing the two is what forced the pre-F8 kernel to forbid `run: auto` wholesale — and with it, any hope
 * of an orchestrator that actually drives the pipeline. The copiloto gets the human's BOARD powers, not a shell.
 *
 * ADR-065 adds `session` for the SAME reason F8 split `run`: a class was swallowing something it does not
 * describe. `run` is DEFINED as "takes (board, cardId)" — but the fleet's worktree lifecycle
 * (`worktree_open`/`submit`/`refresh`/`discard`) takes a **sessionId** and no board at all. It only landed in
 * `run` because the coarse `openWorldHint` preset put it there, and the per-call guard then REFUSED it for
 * lacking the very board its class definition assumes ("exige aprovação humana, mas a chamada não traz um
 * board para escopá-la") — an instruction the caller cannot follow, since there is no board parameter. Net
 * effect: under a scoped token the fleet could not integrate its own work, and ADR-065's whole flow was dead.
 *
 *  - `session`  — SESSION SELF-MANAGEMENT: the caller's own worktree/branch lifecycle. It executes git on a
 *                 session's OWN branch and nothing else: it spawns no agent (that is `run-free`), publishes
 *                 nothing (the split writes `stage`; main is a separate human "publish"), and cannot skip the
 *                 gate — `worktree_submit` merely ENQUEUES, and the merge train runs the full suite before any
 *                 split. The train IS the control, which is why this class defaults to `auto`: a bad submit is
 *                 caught by the gate and returned to the session, not published. A board that wants a human in
 *                 this loop still declares `session: ask` and the matrix wins (dispositionFor).
 *                 It is deliberately NOT `run-free`: the boundary of that class is "one call = arbitrary code
 *                 execution", and a git rebase of one's own branch is not that.
 *
 * autonomo-liberdade-humana (2026-07-18) adds two more classes for the SAME reason `session` was split off — a
 * class was carrying something it does not describe:
 *  - `peer-review` — REQUESTING an INDEPENDENT review of the caller's OWN pending proposal (`request_peer_review`
 *                 takes a draftId, not (board,cardId)→skill, so it is not `run`). It does NOT approve anything:
 *                 the infra spawns a fresh, blinded reviewer (runner/peer-review-spawn.ts) and only that
 *                 reviewer's `approve` verdict — executed BY the infra, attributed `peer:<runId>` — applies the
 *                 draft. The proponent never approves its own work; `approve_change`/`approve_action` stay
 *                 `destructive`/never and are never mounted below `full`. It is bounded (a timed, turn-capped
 *                 spawn) and fail-closed (no verdict ⇒ nothing applied, the draft waits for a human) — the whole
 *                 lock lives in the wrapper, not the reviewer's prompt.
 *  - `idea-write` — escrever DENTRO de um documento de Ideia (ADR-066): enunciado, o que sustenta, premissa,
 *                 sinal de sucesso, caminhos possíveis e o corpo livre. NÃO é `write-board` porque uma Ideia
 *                 vive FORA do pipeline: ela não tem status, não casa trigger, não move coluna e não dispara
 *                 autorun — escrever nela não altera estado de entrega nenhum. É a única escrita montável em
 *                 `ro` além do par ask/answer_question, e por isso a tool é estruturalmente escopada (recusa
 *                 qualquer card que não seja `type: "idea"`, e não alcança status/parent/links). Sem ela o
 *                 Explorador teria de receber o token `write` inteiro — mover card, triar, criar — para poder
 *                 escrever um parágrafo num rascunho.
 *  - `reversible-delete` — a SOFT delete of BOARD DATA (card file / persona / system object): the record moves to
 *                 `boards/<b>/.trash/` with a restore manifest, GC'd after 7 days, `restore_deleted` brings it
 *                 back. It is NOT `destructive` because it has an undo for a week; it is NOT `write-board` because
 *                 removing a card from the active board is a curation decision, not an edit, and should be
 *                 mountable at the orchestrator without being handed to the plain `write` token. PRODUCTION data
 *                 deletion (`approve_data_deletion`, a Firestore wipe) is genuinely irreversible and STAYS
 *                 `destructive`/human — the trash covers git-tracked board data, never a database.
 */
/**
 * Como a publicação deste board é ORIGINADA. `manual` = acumula até um humano (ou um agente com
 * `riskMatrix.deploy: auto`) pedir; `auto` = o sistema pede sozinho quando há trabalho staged. Os dois
 * usam a MESMA máquina para servir o pedido. Ver `runner/release-policy.ts`.
 */
export const RELEASE_MODES = ["manual", "auto"] as const;
export type ReleaseMode = (typeof RELEASE_MODES)[number];

export const RISK_CLASSES = ["read", "idea-write", "doc-write", "write-board", "reversible-delete", "run", "session", "merge-resolve", "peer-review", "deploy", "run-free", "destructive"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** WS8 — what the copiloto may do with a risk class: `auto` (act), `ask` (escalate to a human), `never`. */
export const RISK_DISPOSITIONS = ["auto", "ask", "never"] as const;
export type RiskDisposition = (typeof RISK_DISPOSITIONS)[number];

/** WS8 / F5.0 / F8 — the risk classes that may NEVER be `auto`, whatever a board declares. A board-integrity
 *  lint reproves a riskMatrix that sets one of these to `auto`, and dispositionFor CLAMPS auto→ask (defense in
 *  depth: the lint can be bypassed by hand-editing board.yaml; the clamp can't).
 *  - `run-free`: one call (`run_task({prompt})`) = a child with full Bash ⇒ it would bypass every OTHER lock in
 *    this file (deploy guard, destructive guard, the whole matrix). It is the ONE capability that, if auto,
 *    makes the rest of the governance decorative. A human owns it.
 *  - `destructive`: irreversible data/decision loss (delete_card, claude_kill, approve_change…) — no undo.
 *  F8 REMOVED `run`/`merge-resolve`/`deploy` from this list (a board may now declare them `auto`): they are
 *  bounded, observable and recoverable (a bad run is cancelled+re-enqueued; an aborted merge preserves the
 *  branch as failed/run/<id>; a failed deploy REVERTS the card and now raises a first-class demand). What made
 *  it safe is that they can no longer smuggle a shell: that is `run-free`, and it stays human-only. */
export const NEVER_AUTO_RISK_CLASSES: readonly RiskClass[] = ["run-free", "destructive"];

/** F5.0 / F8 — the classes whose DEFAULT (matrix silent) is `never` rather than `ask`. `deploy` is here on
 *  purpose: a board that never opted in must not publish to production just because the copiloto woke up —
 *  auto-deploy is EXPLICIT (`deploy: auto`), never inherited. `run`/`merge-resolve` default to `ask` (escalate,
 *  don't refuse in silence); `read` defaults to `auto`; everything else to `ask`. */
export const DEFAULT_NEVER_RISK_CLASSES: readonly RiskClass[] = ["deploy", "run-free", "destructive"];

/** WS8 — the per-board orchestrator policy (BoardConfig.orchestrator). All optional; absent ⇒ mode off. */
export interface OrchestratorPolicy {
  mode: OrchestratorMode;
  /** hard cap on autonomous actions per hour (a runaway rail); absent = a conservative default applies. */
  maxActionsPerHour?: number;
  /** risk class → disposition (auto/ask/never). Absent classes fall to a conservative default (`ask`). */
  riskMatrix?: Partial<Record<RiskClass, RiskDisposition>>;
}

/** WS8 / F8 — server-side MCP authority LEVELS keyed by the URL token (settings.mcpTokens). A level MOUNTS a
 *  set of RISK CLASSES (register.ts `LEVEL_CLASSES`) — a tool outside the set is never registered, so the
 *  client can't even see it:
 *   - `ro`    → `read` (+ the ask/answer_question escalation pair)
 *   - `write` → `read` + `write-board` (a pure board writer; no exec, no deploy, no destructive)
 *   - `orch`  → `write` + `run` + `merge-resolve` + `deploy` — the AUTONOMOUS ORCHESTRATOR: it may drive the
 *     pipeline, unpark the merge train and publish, but NEVER `run-free` (no shell) or `destructive` (no undo).
 *     Mounting is only the first lock; the per-call guard still consults the board's riskMatrix (mcp/guard.ts).
 *   - `full`  → everything (the operator's own token). */
export const MCP_LEVELS = ["ro", "write", "orch", "full"] as const;
export type McpLevel = (typeof MCP_LEVELS)[number];

/**
 * TIER DE AUTONOMIA de um SPAWN (story-l9mac9) — o MESMO vocabulário de {@link MCP_LEVELS}, de propósito.
 *
 * O que este tipo NÃO faz: tirar poder de ninguém. A régua de referência (claude-hermes) tem 4 tiers
 * NOMEADOS e o de cima (`Unrestricted`) EXISTE — o ganho está em o nível ser EXPLÍCITO e AUDITÁVEL, não em
 * apertá-lo. Aqui o tier é o NOME do eixo que JÁ decidia a permissão do filho (`AgentDef.fullAutonomy` →
 * a flag do CLI, runner/engine.ts). Inventar um quinto vocabulário seria uma segunda régua de privilégio,
 * ou seja, uma segunda verdade — e a que apodrece. Reusar `MCP_LEVELS` mantém UMA.
 *
 * O que cada tier diz sobre as tools NATIVAS do filho (a superfície MCP é governada pelo mesmo nome em
 * {@link MCP_LEVELS}, que é o ponto de reusá-lo):
 *   - `full`  → tools nativas sem prompt (`--dangerously-skip-permissions`). É o `Unrestricted` do Hermes e
 *               ele CONTINUA EXISTINDO: é o que faz o autorun escrever código e rodar teste sozinho.
 *   - `orch`  → sem shell/editor nativo; a autoridade passa pelas tools MCP (é a postura do tick do copiloto).
 *   - `write` → edita arquivo sem prompt, sem shell irrestrito (`--permission-mode acceptEdits`).
 *   - `ro`    → não escreve nada (`--permission-mode plan`).
 *
 * A tradução tier → flags mora em UM lugar (runner/engine.ts `permissionArgs`), porque é lá que a auditoria
 * de flags do pacote já olha; aqui fica só o vocabulário.
 */
export const AUTONOMY_TIERS = MCP_LEVELS;
export type AutonomyTier = McpLevel;

// ── Governance (story-w9n03r) ────────────────────────────────────────────────
// Allows the orchestrator to PROPOSE changes to owner:human board fields
// (positioning/businessMetric/desiredOutcome/canvas/releases/personas) without ever touching the canonical value.
// A GovernanceDraft stays pending until the operator approves or rejects it in
// the Inbox. Draft files live at storymap/boards/<board>/governance/<id>.json.

/** Board fields owned by the human operator — safe to read, NOT safe to write directly. */
export const GOVERNANCE_ARTIFACTS = [
  /**
   * O PRD — o único artefato desta lista que NÃO é um campo do `board.yaml`: ele é o markdown em
   * `storymap/boards/<b>/docs/prd.md`, e o `field` de uma mudança é a CHAVE DA SEÇÃO.
   *
   * Por isso o núcleo puro (`applyGovernanceChange`, que opera sobre `BoardConfig`) não sabe
   * aplicá-lo e a casca impura despacha: config → `writeBoardConfig`; prd → o chokepoint de escrita
   * do documento. É o que evita repetir o defeito do canvas, em que o caminho governado grava um
   * campo YAML que `loadDoc` deixou de ler depois da migração e nada reconcilia os dois.
   */
  "prd",
  "positioning",
  "businessMetric",
  "desiredOutcome",
  "canvas",
  "canvasTags",
  "releases",
  "personas",
] as const;
export type GovernanceArtifact = (typeof GOVERNANCE_ARTIFACTS)[number];

export type GovernanceDraftStatus = "pending" | "approved" | "rejected";

/** A single proposed change to one field (or the whole artifact) within a GovernanceDraft. */
export interface GovernanceChange {
  artifact: GovernanceArtifact;
  /** Dotpath within the artifact (e.g. "propositionValue"); null = replace the whole artifact. */
  field?: string | null;
  /** Canonical value at the time the proposal was made (conflict-detection snapshot). */
  before: unknown;
  /** Proposed value — applied to the canonical when approved. */
  after: unknown;
  /** Short human-readable label for the diff UI (e.g. "canvas.propositionValue"). */
  label?: string | null;
}

/**
 * A governance proposal: one business decision grouping 1–N changes to owner:human
 * artifacts. 1 draft = 1 decision (AC6 — never field-by-field). The operator approves
 * or rejects it atomically in the Inbox.
 */
export interface GovernanceDraft {
  /** Stable slug id (also the sidecar filename stem). */
  id: string;
  board: string;
  status: GovernanceDraftStatus;
  /** Free-text rationale — the "why" the orchestrator proposed this change. */
  reason: string;
  /** Attribution: which skill and/or card triggered the proposal. */
  origin?: { skill?: string | null; cardId?: string | null } | null;
  changes: GovernanceChange[];
  /** ISO date the draft was created (YYYY-MM-DD). */
  createdAt: string;
  /** ISO date the draft was approved or rejected (YYYY-MM-DD); null while pending. */
  decidedAt?: string | null;
  /** WHO decided it (autonomo-liberdade-humana M1). `"human"` (the UI/operator path, the default), or
   *  `"peer:<runId>"` when an independent peer reviewer approved it via request_peer_review. The proponent is
   *  NEVER here — it cannot approve its own draft; this is the audit trail of the separation. */
  approvedBy?: string | null;
}

/** autonomo-liberdade-humana M2 — the restore manifest for one soft-deleted board entry (a sidecar JSON in
 *  `boards/<b>/.trash/`). It is what makes a delete REVERSIBLE for 7 days: `restore_deleted` reads it to put the
 *  entry back, and the trash GC prunes the pair once `at` is older than the window. Deliberately a SIDECAR (not a
 *  card field) because a trashed card's `.md` LEAVES `cards/` — so the card serializer/schema never see it. */
export interface TrashManifest {
  /** what was deleted — a card FILE, or a persona/system OBJECT inside board.yaml. */
  kind: "card" | "persona" | "system";
  /** the entry's id (card id, or persona/system id). */
  id: string;
  /** who deleted it: `"human"`, `"run:orch"`, `"peer:<runId>"` — the audit attribution. */
  by: string;
  /** ISO timestamp of the deletion — the GC ages the entry against THIS (not git time; trash is board data). */
  at: string;
  /** optional free-text reason. */
  reason?: string;
  /** CARD only — the path the `.md` is restored to (the original cardPath). */
  restorePath?: string;
  /** PERSONA/SYSTEM only — the removed YAML object, to re-insert on restore. */
  object?: unknown;
  /** PERSONA/SYSTEM only — card ids whose ref was stripped on delete (informational; restore does NOT re-add refs). */
  strippedRefs?: string[];
}

/**
 * Fallback model/effort/maxTurns applied to any autorun column that doesn't set
 * its own (StatusDef overrides these). Part of the global RunnerSettings.
 */
export interface RunnerColumnDefaults {
  model?: ModelTier;
  effort?: EffortLevel;
  maxTurns?: number;
}

/**
 * GLOBAL runner configuration — the editable, persisted form of what used to be
 * env-only (AGILEHARNESS_AUTORUN*). Lives at storymap/settings.yaml and is read by the
 * trigger-runner channel with precedence: hardcoded defaults < settings.yaml <
 * process.env (ENV always wins, so the operational kill switch is untouched).
 * Per-PIPELINE policy (which model column X uses) lives on StatusDef in
 * board.yaml; this holds only cross-board infra knobs + the column fallbacks.
 */
export interface RunnerSettings {
  /** schema version for future migration */
  version: number;
  autorun: {
    /** master switch; ENV AGILEHARNESS_AUTORUN=0 still forces this off */
    enabled: boolean;
    /** re-drive runs a crash interrupted on the next boot; ENV AGILEHARNESS_AUTORUN_RESUME_ON_BOOT=0 forces off */
    resumeOnBoot: boolean;
    /** max concurrent skill processes (ENV AGILEHARNESS_AUTORUN_MAX overrides) */
    maxConcurrent: number;
    /**
     * ADR-063 (4b) — same-column-no-progress LOOP-GUARD cap. The autorun cascade circuit-breaks a card
     * that keeps re-dispatching the SAME skill in the SAME status without ever advancing a column (the
     * story-olr777 burn: harness-qa re-fired every non-advancing integration, ~$15 with no verdict). Once a
     * card has run `noProgressMax` CONSECUTIVE non-advancing times for the same trigger, the shell writes
     * an operator finding and STOPS auto-dispatching (a move / manual run / raising the cap resets it).
     * Default 3; 0 DISABLES the guard. ENV AGILEHARNESS_AUTORUN_NO_PROGRESS_MAX overrides (0 disables). */
    noProgressMax: number;
    /**
     * ADR-063 (4a) — OPT-IN per-CARD lifetime $ backstop. When set (> 0), the shell sums the card's
     * telemetry `costUSD` across ALL its runs and STOPS auto-dispatching once the total reaches this
     * ceiling (writing an operator finding) — the budget the per-run maxTurnsResumeMax cap can't see (a
     * card burns $ ACROSS re-spawns, not within one run). DEFAULT undefined = DISABLED (no behaviour
     * change unless the operator opts in). ENV AGILEHARNESS_AUTORUN_CARD_BUDGET_USD overrides (a positive float). */
    cardBudgetUSD?: number;
    timeouts: {
      /** watchdog for fast skills (enrich/tasks/prioritize), ms */
      fastMs: number;
      /** watchdog for code skills (harness-do/harness-review), ms; null = off */
      doMs: number | null;
      /** last-resort wall-clock ceiling applied to ANY run regardless of classification —
       * the universal watchdog that keeps a code skill WITHOUT costGuard/doMs (e.g. refine)
       * from holding a concurrency slot forever. NEVER null (defaults guarantee a number,
       * generous enough not to kill a legit run). ENV AGILEHARNESS_AUTORUN_TIMEOUT_UNIVERSAL_MS overrides. */
      universalMs: number;
    };
    /** binary that resolves `claude` from PATH (ENV AGILEHARNESS_AUTORUN_CLAUDE_BIN overrides) */
    claudeBin: string;
    /** extra CLI flags appended to EVERY run (global escape hatch; ENV AGILEHARNESS_AUTORUN_EXTRA_ARGS overrides) */
    extraArgs: string[];
    /** isolate each run in an ephemeral git worktree (R1, harness paralelo). DEFAULT OFF — a
     * dormant capability until a merge-queue exists to integrate the per-run branches; with it
     * ON but no merge-back, each run's card edits are discarded. ENV AGILEHARNESS_AUTORUN_WORKTREE=1/0 overrides. */
    worktreeIsolation: boolean;
    /**
     * Integration gate (story-1k7els). Before the merge train applies `git merge --no-ff` on main, it
     * merges the run branch into a TEMPORARY staging worktree and runs `checkCommand` there — integrating
     * on main ONLY if green. Catches a SEMANTIC break between runs that each isolated per-run test passes.
     * DEFAULT OFF (`enabled: false`) — running the suite per integration has a cost. ENV
     * AGILEHARNESS_AUTORUN_MERGE_GATE=1/0 overrides. Optional/absent ⇒ disabled (pre-gate behavior). */
    mergeGate?: {
      /** master switch for the gate; default false */
      enabled: boolean;
      /** command run in `<staging>/packages/storymap-ui` (e.g. `"vitest run"`) */
      checkCommand: string;
      /** wall-clock ceiling for the check, ms (default 300_000) */
      timeoutMs: number;
      /** WS1.3 — when a NEW failure appears, re-run the WHOLE suite once; integrate if it doesn't reproduce
       *  (flaky quarantine), never let inter-worker pollution freeze the train. Default true. */
      retryOnNewFailure?: boolean;
      /**
       * Affected-only selection (perf). When present+enabled, the gate runs only the tests AFFECTED by the
       * entry's diff (`command`, with `{base}` = the pre-merge main sha) instead of the full `checkCommand`
       * — UNLESS a changed file matches `fullSuitePaths` (blast-radius kernel/config/fixtures), which forces
       * the full suite. Optional/absent ⇒ always full suite (pre-perf behavior). See runner/affected-gate.ts. */
      affected?: {
        enabled: boolean;
        /** command template; `{base}` → pre-merge sha; MUST pass on zero matches (e.g. `--passWithNoTests`). */
        command: string;
        /** repo-relative exact/`dir/`/glob patterns that force the full suite. */
        fullSuitePaths: string[];
      };
      /**
       * P-7 — QUAL suíte o gate roda, derivada do delta em vez de um caminho fixo no código. O gate
       * nascera com `packages/storymap-ui` LITERAL em três lugares, então uma sessão que mexia em
       * `packages/acmeapp` era validada pela suíte do harness: testes errados produzem confiança falsa,
       * que é pior que nenhuma validação (esta grita). Também é bloqueador direto do D13/extração OSS.
       *
       * Conservador por desenho: só um pacote EXPLICITAMENTE declarado aqui ganha unidade própria;
       * qualquer coisa fora do mapa cai no fallback (o pacote do harness), que é exatamente o
       * comportamento de hoje. Ausente ⇒ nada muda. Ver runner/gate-scope.ts. */
      scope?: {
        /** `<dir do pacote>` → comando de checagem; a chave casa por PREFIXO de diretório. */
        packages?: Record<string, string>;
        /** teto de suítes por entrada; acima disso colapsa no fallback (o slot serial não se multiplica) */
        maxUnits?: number;
        /** a suíte que roda quando o delta não casa o mapa (ou transborda). Ausente ⇒ o pacote da ferramenta —
         *  default histórico que só é válido num repositório onde a ferramenta MORA. Ver runner/gate-scope.ts. */
        fallback?: { cwd: string; command?: string };
      };
      /**
       * Typecheck como pergunta BINÁRIA por árvore, em canal PRÓPRIO — nunca misturado ao parse de
       * falhas da suíte. Motivo medido: a suíte transpila sem checar tipo (vitest/esbuild), e foi assim
       * que 2× TS2353 entraram na main em silêncio — quem os achou foi a extração OSS, que está de
       * saída. Roda `command` em cada unidade do escopo que tenha `tsconfig.json`, ANTES da suíte
       * (segundos decidem o que os ~2min do p90 decidiriam depois); unidade vermelha na MESCLADA é
       * re-medida na BASE e só vermelho NOVO reprova — pré-existente é perdoado e NOMEADO no log, a
       * mesma atribuição da suíte, mas por UNIDADE (nunca por chave de falha: o array compartilhado já
       * desarmou uma guarda). DEFAULT ON — D8: gate nunca cego; a atribuição torna o default seguro
       * (base vermelha nunca congela a fila). `enabled: false` desliga; `command` troca o verificador. */
      typecheck?: {
        enabled: boolean;
        /** Comando por unidade (default `"bunx tsc --noEmit"`). CONTRATO DE SAÍDA: o comando precisa
         *  emitir diagnósticos no formato do tsc (`TS<código>:`) — falha sem esse padrão é tratada como
         *  INCONCLUSIVA (infra), nunca como reprovação atribuível. */
        command: string;
      };
    };
    /**
     * Merge-train re-drive (story-92ldyt). When a run branch CONFLICTS on the merge-back and the entry
     * has a generating skill (`trigger`), the train re-runs that skill against the now-updated main
     * (regenerating the code over the new state) instead of pausing for a manual 3-way merge. `maxRedrives`
     * caps the re-drives per lineage before degrading to the legacy `conflict` pause (graceful fallback,
     * never an infinite loop). Optional/absent ⇒ default 2. */
    mergeTrain?: {
      /** max re-drives per conflict before degrading to `conflict`; default 2 */
      maxRedrives: number;
      /**
       * WS-10/D14 — the SEMANTIC LADDER a text divergence climbs before it reaches a human: convergence →
       * deterministic whitespace filter → the `harness-resolve` LLM judge → the human, WITH a per-hunk analysis.
       * A BOOT flag (not hot-reloaded), DEFAULT ON — D8 of the AgileHarness plan: a complete train out of
       * the box. `false` ⇒ TODAY's behaviour, byte-identical: the ladder short-circuits before any git
       * command runs, so the train parks and the release reports `apply-failed` exactly as they do now.
       * Turning it off is the kill switch, never a tuning knob. See runner/semantic-resolution.ts. */
      semanticResolution: boolean;
    };
    /**
     * Staged release integration (Fase 4a). When ON, the merge train routes a run branch that touches
     * CODE (`codePrefixes`, e.g. `packages/**`) into a dedicated `branch` (default `stage`) worktree
     * instead of merging it straight to main — so app code is held behind a human release gate. The
     * run's NON-code changes (board data under `storymap/**`, skills under `.claude/**`) still land on
     * main immediately so the live board + cascade keep advancing. A run with NO code paths is
     * unaffected (merges to main exactly as before — the common case, ~93% of runs empirically).
     * BOOT-FIXED: read once at queue construction, NOT hot-reloaded per entry (unlike `mergeGate.enabled`)
     * — so editing settings.yaml can never split ONE batch of runs across main/stage mid-flight. DEFAULT
     * OFF (`enabled: false`) ⇒ pre-staging behavior. ENV AGILEHARNESS_AUTORUN_STAGING=1/0 overrides. */
    staging?: {
      /** master switch; default false (boot-fixed, NOT hot-reloaded) */
      enabled: boolean;
      /** integration branch app code is staged on, awaiting the human release gate; default `"stage"` */
      branch: string;
      /** path prefixes treated as deployable CODE routed to `branch` (everything else → main); default `["packages/"]` */
      codePrefixes: string[];
      /**
       * Artifacts that LIVE under a `codePrefixes` path but are DERIVED FROM board data — so they belong
       * to the DATA half and are REGENERATED on main, never patched. Empty by default: a repo that
       * declares nothing keeps the pure path-prefix routing, byte-identical.
       *
       * Why this exists (measured in production, 2026-07-20). Routing by path tears a derived artifact
       * away from the source that defines it, and BOTH halves then go wrong at once: on `stage` the
       * artifact regenerates against main's UNCHANGED data and reverts, so the landing verifier reports a
       * lost implementation and hands the session back a conflict it cannot possibly resolve; on `main`
       * the new source lands WITHOUT its artifact and main's own suite goes red — and because the train's
       * gate is fail-closed, that freezes the entire queue. Worse, a data-only run skips the code gate
       * entirely, so nothing catches it. Regenerating on main closes both: the artifact is a pure function
       * of main's data, recomputed at the moment the data lands, so it is correct even when a concurrent
       * run changed the same source (a verbatim patch of the run's bytes would NOT be).
       */
      dataDerived?: {
        /** repo-relative path of the derived artifact (must sit under a `codePrefixes` path to matter) */
        artifact: string;
        /** data paths/prefixes whose change invalidates it — a touch here triggers regeneration */
        sources: string[];
        /** working directory for `regen`, repo-relative (e.g. `"packages/storymap-ui"`) */
        cwd: string;
        /** command that rewrites the artifact from its source (e.g. a `vitest run -u` of one spec) */
        regen: string;
      }[];
    };
    /**
     * Como o engine RECONHECE que um run tocou uma superfície visível ao usuário — a medição que
     * alimenta `uiSurfaceEvidence` e, por ela, o gate de QA visual.
     *
     * Mora na SPEC, não no código, porque "o que é tela" é fato do repo consumidor: outro projeto
     * usa `.vue`/`.svelte`, ou concentra UI sob um diretório próprio. O default é só por EXTENSÃO
     * (`.tsx`, `.css`, …) — fato da LINGUAGEM, não deste produto —, então um clone do AgileHarness
     * classifica certo sem configurar nada, e nenhum caminho/nome de app fica cravado aqui.
     *
     * Um padrão iniciado por `.` casa por SUFIXO; qualquer outro casa por SUBSTRING do path
     * (`src/components/`). Lista VAZIA ⇒ classificador inerte (ninguém é superfície) e o gate volta
     * inteiro ao caminho declarativo. Opcional/ausente ⇒ o default abaixo.
     */
    qa?: {
      /** padrões que marcam um path como superfície visível (sufixo `.ext` ou substring de path) */
      uiSurfacePatterns: string[];
    };
    /**
     * FILA DE PUBLICAÇÃO (runner/publish-queue) — "publique este sha quando o pipeline ficar ocioso".
     *
     * Fecha o único trecho da entrega que ainda exige card: o merge train já aceita trabalho de sessão
     * (`kind: session`), mas o promote+deploy é `onEnter` de um PASSO, e passo quem atravessa é card. Sem
     * ela, trabalho de sessão encalha em `stage` até alguém publicar na mão.
     *
     * Automatiza o MOMENTO, não a decisão: o pedido carrega um sha explícito. DEFAULT OFF, como toda
     * capacidade que age sozinha aqui (mergeGate/staging/sandbox nasceram assim).
     *
     * ⚠️ `boards` FOI REMOVIDO. Era uma lista por board que respondia DUAS perguntas — "pode publicar?"
     * e "publica sozinho?" — e tirar um board dela tirava as duas, deixando trabalho de sessão sem
     * saída nenhuma (7 commits do `acme` ficaram 6 dias em `stage` sem nada capaz de movê-los, porque a
     * mesma flag que daria o botão ao humano era a que tirava o humano do caminho). A política por board
     * agora é `release.mode` no board.yaml (`lib/storymap/release-policy.ts`); o que sobra aqui é o
     * KILL-SWITCH GLOBAL do mecanismo. A agnosticidade continua intacta — a decisão segue em config,
     * jamais num `if (board === "...")`, só que na config DO BOARD, que é onde ela pertence.
     */
    publishQueue?: {
      /** master switch GLOBAL do mecanismo (não é política por board). */
      enabled: boolean;
    };
    /**
     * Resource-aware admission (story-scheduler-lanes-recursos). Runs split into a LIGHT lane
     * (cheap .md-only skills) and a HEAVY lane (code/diagnose/browser skills) with independent
     * concurrency caps, and a heavy run is held while the VPS is over a RAM/CPU threshold. The
     * defaults are PERMISSIVE (lanes 99/99, thresholds 0/999) so a config lacking this section
     * behaves identically to the pre-scheduler engine. Tuned operationally in settings.yaml; each
     * field is ENV-overridable (AGILEHARNESS_AUTORUN_LANE_LIGHT_MAX / _LANE_HEAVY_MAX / _RAM_FREE_MB / _LOAD_AVG_1). */
    scheduler: {
      /** per-lane concurrency caps (within the global maxConcurrent ceiling) + the per-run
       * resource quota (SM-4 governor): `memoryMax` is a systemd `MemoryMax` value (e.g. "2G",
       * "8G") and `cpuQuota` a `CPUQuota` percentage (100 = 1 core, 300 = 3 cores). Both OPTIONAL —
       * absent ⇒ no systemd-run scope is applied for that lane (back-compat with the pre-governor
       * engine). ENV-overridable (AGILEHARNESS_AUTORUN_LANE_{LIGHT,HEAVY}_{MEMORY_MAX,CPU_QUOTA}). */
      lanes: {
        light: { maxConcurrent: number; memoryMax?: string; cpuQuota?: number };
        heavy: { maxConcurrent: number; memoryMax?: string; cpuQuota?: number };
      };
      /** a heavy run waits while free RAM is below ramFreeMb (MB) or the 1-min load is above the resolved
       *  ceiling (see `loadCeilingFor`: `loadAvg1PerCore` × cores when set, else the absolute `loadAvg1`) */
      thresholds: {
        ramFreeMb: number;
        loadAvg1: number;
        /** PORTABLE load ceiling, expressed per CPU core (1.0 = "load equal to the core count", the
         *  conventional Linux reading of a fully-used CPU). Takes precedence over the absolute `loadAvg1`
         *  when set. Exists because an absolute is meaningless across hosts — and a too-low absolute is
         *  invisible: it stalls the heavy lane and `worktree_open` while looking exactly like an idle
         *  pipeline (observed on this 6-core VPS with `loadAvg1: 3.5` against a 5–9 baseline). */
        loadAvg1PerCore?: number;
      };
    };
    /**
     * WS-1.5 (storymap-parallel-work) — AGENT SESSION worktrees (`worktree_open`). A session is admitted
     * like a HEAVY run (it builds + runs the suite), so it reuses `scheduler.thresholds` for the box; this
     * cap is the extra limit on how many session trees may exist AT ONCE. Disk is cheap (node_modules are
     * links) — simultaneous BUILDS are not, and admission is the only thing throttling a session (unlike a
     * run, nothing else queues it). Absent ⇒ the default cap. ENV: AGILEHARNESS_AUTORUN_SESSIONS_MAX_WORKTREES.
     */
    sessions: {
      maxWorktrees: number;
    };
  };
  /** model/effort/maxTurns fallback for autorun columns lacking their own */
  columnDefaults: RunnerColumnDefaults;
  /** Economy mode: caps all runs to sonnet/high and skips autorun for heavy triggers (harness-refine, harness-fix). */
  economyMode?: boolean;
  /**
   * WS8 (F7) — DEPLOYMENT config for the board copiloto/orchestrator (the POLICY is per-board in
   * board.yaml; this is the cross-board runtime knobs). DEFAULT OFF (`enabled:false`) ⇒ the tick never
   * fires, byte-identical to no Jido. `tickMinutes` = the in-process analysis cadence; `budget` caps
   * daily ticks/cost; `notifyBudget` rate-limits pings to the human.
   */
  orchestrator?: OrchestratorSettings;
  /**
   * WS8 (F7) — server-side MCP AUTHORITY tokens: each maps an env-var holding a token to an authority
   * {@link McpLevel}. register.ts resolves the request's URL token to a level and filters the tool surface
   * (ro < write < full). Absent ⇒ no token enforcement (legacy: every client is full). Deployment concern.
   */
  mcpTokens?: { tokenEnv: string; level: McpLevel }[];
  /**
   * DEPLOYMENT-wide deploy knobs. `canaryCommand`: the DEFAULT publication-fidelity canary for boards
   * that do not declare their own (`board.yaml` `deploy.canaryCommand` wins). A deployment where every
   * board publishes to ONE shared surface declares it once here; a repository publishing several
   * products to several surfaces declares it per board instead. Absent from both ⇒ fidelity is not
   * checked — the harness NEVER guesses a URL of its own (guessing one is what reverted live cards).
   */
  deploy?: {
    canaryCommand?: string;
    /**
     * ONDE OS NOMES DOS APPS DO DEPLOYMENT MORAM — e por que aqui, e não no código.
     *
     * Estes são os alvos que o caminho diff-aware legado publica (`just orch-deploy <alvo>`): o motor
     * resolve `BoardConfig.package` para o basename e só dispara quando o basename está NESTA lista.
     * A lista era um literal no fonte do motor, o que punha os nomes de produto de UM deployment no
     * CONTRATO PUBLICADO do protocolo MCP — três tools os expunham como `z.enum`. Um motor que vai ser
     * usado por outros repositórios não pode carregar o catálogo de apps de um deles.
     *
     * AUSENTE OU VAZIA ⇒ NENHUM alvo legado. Não é degradação: um adotante declara `deploy:` nos
     * próprios boards (o descritor `kind: command|agent`), que é o caminho agnóstico. A lista existe
     * para deployments que já publicavam por convenção antes de o descritor existir.
     *
     * ⚠️ ISTO É DADO, E DADO CHEGA EM `description` DE TOOL SE NINGUÉM PENEIRAR. A superfície de
     * instrução do MCP é lida pelo modelo do outro lado com autoridade de prompt (ver
     * `mcp/instruction-surface.test.ts`), então o carregador impõe FORMA DE SLUG e DESCARTA o que não
     * casa — uma frase aqui nunca vira instrução lá. A peneira é do carregador, não deste comentário.
     */
    targets?: string[];
    /**
     * A SUPERFÍCIE COMPOSTA deste deployment, quando existe: um artefato único construído a partir das
     * árvores web de VÁRIOS apps, publicado por uma receita própria FORA de qualquer manifesto de
     * pacote. Como `orch-deploy <alvo>` publica o backend e não a face, um release cujo diff toca um
     * caminho da face precisa encadear a publicação dela — senão o card diz "No ar" com uma face velha.
     *
     * AUSENTE ⇒ este deployment não tem superfície composta, e o motor responde `absent` (não há o que
     * encadear). Isso é diferente de "declarada e ilegível", que é `unreadable` e trata conservador.
     *   `target`   — a chave do job no registry (também gravada em `deployTargets` dos cards)
     *   `recipe`   — o argumento de `just` que publica a face
     *   `manifest` — o JSON, relativo à raiz do alvo, que declara quais caminhos COMPÕEM a face
     */
    composedFace?: { target: string; recipe: string; manifest: string };
  };
}

/** WS8 — the orchestrator deployment settings (settings.yaml). All optional; absent ⇒ enabled:false. */
export interface OrchestratorSettings {
  /** master kill-switch; default false. ENV AGILEHARNESS_ORCH_ENABLED=0 also forces off. */
  enabled: boolean;
  /** in-process tick cadence in minutes (the copiloto analyses the board every N min); default 30. */
  tickMinutes: number;
  /** daily budget rails: max ticks + max $ the copiloto may spend per day (soft — a tick over budget no-ops). */
  budget?: { maxTicksPerDay: number; maxCostPerDay: number };
  /** rate-limit on pings to the human (ask_question escalations) per day; default 12. */
  notifyBudget?: { maxPushesPerDay: number };
  /** F3.3 — model/effort do CHAT do Jido (paired). Default {model:"opus", effort:"high"}. A rota
   *  /api/copilot/turn resolve: request > este settings > default do purpose-registry. */
  chat?: { model?: string; effort?: string };
  /**
   * WAKE — o Jido autônomo ACORDA por EVENTO (não só pelo tick periódico): um card travado, um run que
   * morreu, uma pergunta/finding novo, um item que caiu no cockpit. A fonte é o MESMO barramento de
   * notificações que já vê qualquer escrita em `storymap/boards/**` (venha da UI ou de um agente headless),
   * mais o `onIdle` do engine (um run terminou). Todos os gates do tick continuam valendo — o wake só faz o
   * tick acontecer ANTES, nunca burla lease/budget/hasWork/backoff.
   *  - `debounceSeconds`: janela de coalescência (uma rajada de escritas = UM wake). Default 45.
   *  - `cooldownMinutes`: intervalo mínimo entre dois runs acordados por evento (anti-rajada). Default 5.
   */
  wake?: { enabled: boolean; debounceSeconds: number; cooldownMinutes: number };
  /**
   * A matriz de risco das ações de escopo REPO (mcp/scope.ts `REPO_SCOPED_TOOLS`): a branch `stage`, a suíte,
   * o serviço, o shell da caixa. Elas não têm board dono, então a matriz de NENHUM board.yaml as governa — sem
   * esta porta, a disposição delas caía sempre em `defaultDisposition` e um `ask` virava recusa com um conselho
   * impossível ("refaça com o board", num schema que não tem board).
   *
   * Mesma semântica de `OrchestratorPolicy.riskMatrix`, e sujeita ao MESMO clamp: `NEVER_AUTO_RISK_CLASSES`
   * (`run-free`/`destructive`) nunca resolve para `auto`, esteja o que estiver escrito aqui — então declarar
   * esta matriz não pode, por construção, entregar um shell ao agente. Classe ausente ⇒ default conservador.
   */
  riskMatrix?: Partial<Record<RiskClass, RiskDisposition>>;
}

export interface Board {
  config: BoardConfig;
  cards: Card[];
}

export interface BoardSummary {
  id: string;
  name: string;
}

/** Synthetic release id used in the UI/containers for unscheduled stories. */
export const NO_RELEASE = "none";
