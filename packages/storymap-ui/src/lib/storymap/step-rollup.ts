// step-rollup.ts — PURE per-step rollup of a card's execution history + pipeline state.
//
// Deciding "should I RUN this card or MOVE it" needs two things the system keeps apart, read
// together: the DURABLE run ledger (telemetry — when each skill ran, its cost/turns, its outcome)
// and the card's OWN FIELDS (what each step LEFT — narrative, RICE, wireframe, blockers, qaPassed,
// i.e. whether its gate is satisfied). This module folds both, per pipeline STEP, into one ordered
// `StepRollup[]` that three render densities consume (full table / compact stage-trail / tooltip).
//
// PURE: no React, no node:fs (telemetry/journal are imported `type`-only, so the server-only fs
// modules never enter the client bundle) → node-unit-testable. BOARD-AGNOSTIC: step identity +
// order come from the board config; the per-step "left" signal + ✓/✗ verdict come from a small
// declarative spec that REUSES the gate predicates (gate-core) — so the verdict never drifts from
// the actual move gates — with a run-summary/outcome fallback for any skill the spec doesn't name.

import { GATES, hasNarrative } from "./gates";
import { selfBoardId } from "./self-board";
import { terminalStatusIds } from "./views";
import { liveOpenBlockers } from "./runner/findings";
import { hasUiSurface } from "./gate-core";
import { isDispensable, routeSkip } from "./skip-routing";
import { formatRiceScore, riceScore } from "./rice";
import { openQuestions } from "./questions";
import type { StoryType } from "./frameworks";
import type { BoardConfig, Card, StatusDef, ToolConfigDef } from "./types";
import type { TelemetryRecord } from "./runner/telemetry";
import type { Transition } from "./runner/transitions";
import type { RunOutcome } from "./runner/journal";

/**
 * The GATE axis ("can this card move past the step?") — ADDITIVE to the movement gate, never demoting a
 * gate-ok step to pending (that would re-introduce an inverted lie). ✓ ok delivered · ✗ blocked ran/needs
 * action · · pending not done yet · WS5: – `exempt` (the step's gate doesn't apply to this card — e.g. harness-qa
 * on a non-UI technical story, gate = suite not the visual sweep) · ⊘ `skipped` (this card's route bypasses
 * the step — skipForTypes OR routing.skips). exempt/skipped are NOT "done" — the X/Y counter excludes them.
 */
export type StepGate = "ok" | "blocked" | "pending" | "exempt" | "skipped";

/** A high-value capability a run may exercise — surfaced per step so the operator sees whether the
 *  skill ran AS EXPECTED (e.g. did QA actually drive the browser? did review use graphify?). */
export type Capability = "graphify" | "browser" | "subagents" | "devServer";

export interface StepCapability {
  id: Capability;
  label: string;
  /** the step's run(s) actually invoked a tool of this capability. */
  used: boolean;
  /** the step's config makes this capability available → unused is a soft anomaly (⚠). */
  expected: boolean;
}

export const CAPABILITY_LABEL: Record<Capability, string> = {
  graphify: "graphify",
  browser: "navegador",
  subagents: "subagentes",
  devServer: "servidor",
};

/** Stable display order for capability markers. */
const CAPABILITY_ORDER: Capability[] = ["graphify", "browser", "subagents", "devServer"];

/** Map raw tool names (telemetry `toolsUsed`) → the capabilities they evidence. Pure. */
export function classifyTools(tools: readonly string[]): Set<Capability> {
  const caps = new Set<Capability>();
  for (const name of tools) {
    if (/^mcp__graphify__/.test(name)) caps.add("graphify");
    else if (/^mcp__chrome-devtools__/.test(name) || /^mcp__playwright__/.test(name)) caps.add("browser");
    else if (name === "Task" || name === "Workflow") caps.add("subagents");
    else if (name === "local-dev-server") caps.add("devServer");
  }
  return caps;
}

/** WS3 (F2) — map a board toolConfig to a display Capability by its mount path / match regex, REUSING
 *  the legacy heuristic so a declarative `toolkit.use: [codegraph]` (mcp `…graphify…`) keeps lighting the
 *  graphify marker after the _base mcpConfig→toolkit migration. Returns null for a consumer capability
 *  outside the fixed display vocabulary (no marker, but never an error). Pure. */
function capabilityOfToolConfig(tc: ToolConfigDef | undefined): Capability | null {
  if (!tc) return null;
  const hay = `${tc.mcp ?? ""} ${tc.match ?? ""}`;
  if (/graphify/i.test(hay)) return "graphify";
  if (/chrome|playwright|devtools/i.test(hay)) return "browser";
  return null;
}

/** Which capabilities a step is EXPECTED to exercise — from its config. Reads BOTH the declarative
 *  `toolkit` facet (WS3: each use'd/expected toolConfig, classified via {@link capabilityOfToolConfig})
 *  AND the legacy `mcpConfig` regex (boards not yet migrated), so the step-trail markers survive the
 *  _base migration. Board-agnostic. The QA visual-sweep capabilities (browser + dev-server) apply ONLY to
 *  USER stories (a non-user story is exempt from QA, so it legitimately uses neither → no false anomaly);
 *  the dev-server applies only to the board this installation declares as its OWN (selfBoardId()) —
 *  it is the dogfood surface, and pinning our board id here made the rule true on one machine. Pure. */
export function expectedCapabilities(
  step: StatusDef | null | undefined,
  boardId: string,
  storyType: StoryType | null,
  toolConfigs?: Record<string, ToolConfigDef>,
): Set<Capability> {
  const caps = new Set<Capability>();
  if (!step) return caps;
  const isQa = step.trigger === "harness-qa";
  const userStory = storyType === "user";
  // WS3 declarative path: classify each toolConfig the step's toolkit uses/expects.
  if (step.toolkit && toolConfigs) {
    const ids = new Set<string>([...(step.toolkit.use ?? []), ...(step.toolkit.expect ?? []).map((e) => e.tool)]);
    for (const id of ids) {
      const cap = capabilityOfToolConfig(toolConfigs[id]);
      // a browser capability stays QA-visual-sweep-gated (only user stories that run QA) — same as legacy.
      if (cap === "browser" && isQa && !userStory) continue;
      if (cap) caps.add(cap);
    }
  }
  // Legacy mcpConfig regex (boards still on per-step mcpConfig, e.g. orbit / qa-mcp).
  const mc = step.mcpConfig ?? "";
  if (/graphify/i.test(mc)) caps.add("graphify");
  if ((/qa-mcp/i.test(mc) || /chrome|playwright/i.test(mc)) && (!isQa || userStory)) caps.add("browser");
  if (isQa && userStory && boardId === selfBoardId()) caps.add("devServer");
  return caps;
}

/** Fold the used (telemetry) + expected (config) capabilities into the per-step marker list — only
 *  the capabilities that are expected OR used, in stable order. Pure. */
export function stepCapabilities(
  step: StatusDef | null | undefined,
  boardId: string,
  storyType: StoryType | null,
  toolsUsed: readonly string[],
  toolConfigs?: Record<string, ToolConfigDef>,
): StepCapability[] {
  const used = classifyTools(toolsUsed);
  const expected = expectedCapabilities(step, boardId, storyType, toolConfigs);
  return CAPABILITY_ORDER.filter((id) => used.has(id) || expected.has(id)).map((id) => ({
    id,
    label: CAPABILITY_LABEL[id],
    used: used.has(id),
    expected: expected.has(id),
  }));
}

/** Aggregated run + state of ONE pipeline step for a card. */
export interface StepRollup {
  /** the skill trigger that processes the step (e.g. "harness-review"). */
  trigger: string;
  /** the StatusDef id this step is (e.g. "revisar-codigo"). null for a telemetry-only step. */
  statusId: string | null;
  /** friendly step label (e.g. "Revisão de código"). */
  step: string;
  /** position in the board pipeline (config.statuses index); telemetry-only steps sort last. */
  order: number;
  /** part of this card's FORWARD build path (vs a reentry/maintenance skill surfaced because it ran). */
  onPath: boolean;
  /** the card currently sits on this step. */
  isCurrent: boolean;
  /** a run of this step is in flight right now (live). */
  live: boolean;
  /** how many settled runs this step has. */
  runs: number;
  /** epoch ms of the most-recent settled run, or null when it never ran. */
  lastRunAt: number | null;
  /** outcome of the most-recent settled run, or null when it never ran. */
  lastStatus: RunOutcome | null;
  /** what the step LEFT — the signal from the card's fields ("narrativa + 3 AC", "2 bloqueadores",
   *  "RICE 8.4", "QA aprovado"…), falling back to the latest run's decision summary, or null. */
  left: string | null;
  /** ✓/✗/·/–/⊘ verdict — derived from the step's deliverable (gate) + whether it ran + this card's route. */
  gate: StepGate;
  /** WS5 — why the step is `exempt`/`skipped`, or a stale-skip note (e.g. "rota: express", "tipo: technical",
   *  "isento — sem UI; gate = suíte", "skip ignorado (config mudou)"). Absent for a normal ok/blocked/pending. */
  reason?: string;
  /** WS5 — the EXECUTION axis: the step's gate is satisfied but NO run/transition ever executed it (the field
   *  was authored directly, e.g. a captured card born with acceptance). Marks an honest "✓ satisfeito sem
   *  execução" instead of implying a run happened. Only meaningful when gate === "ok" and runs === 0. */
  satisfiedWithoutRun?: boolean;
  /** WS5 — a real EVENT touched this step, from the WS2 transitions ledger: when + who (human/agent/system).
   *  Distinguishes a step the card genuinely PASSED THROUGH from a retroactive gate-ok projection. Absent when
   *  no ledger transition reached this step (a legacy card with no ledger, or a step never entered). */
  visited?: { at: string; actor: string };
  /** the LATEST run's agent (model·effort) + metrics, plus the cumulative cost across ALL of the
   *  step's runs (`totalCostUSD`) — so the hover stays internally consistent (every field is the
   *  latest run) while still surfacing how much the step cost in total. null when it never ran. */
  metrics: {
    model: string | null;
    effort: string | null;
    durationMs: number | null;
    turns: number | null;
    tokens: number | null;
    /** the latest run's cost (consistent with the other latest-run fields). */
    costUSD: number | null;
    /** sum of costUSD across every run of this step (equals costUSD when it ran once). */
    totalCostUSD: number;
  } | null;
  /** capability markers for this step — graphify/browser/subagents/server, each used×expected — so
   *  the operator sees whether the skill exercised what its config wired (✓ used · ◇ expected-but-not).
   *  Empty when the step neither expects nor used any tracked capability. */
  capabilities: StepCapability[];
}

// ── presentation maps (single source — CardDocument + the components import these) ────────────

/**
 * FALLBACK de rótulo por trigger — usado SÓ quando não há `StatusDef` (um trigger telemetry-only: a skill
 * rodou, mas não é step DESTE board). Quando o step existe, o nome vem do BOARD (`StatusDef.name`), que é a
 * fonte da verdade.
 *
 * Este mapa já foi um ESPELHO dos nomes do board ("mirrors the board's step names") — e espelho é cópia, e
 * cópia deriva. Derivou em 4: `harness-capture` "Captura"≠"Capturando", `harness-plan` "Plano técnico"≠"Plano &
 * Tarefas", `harness-qa` "QA automatizado"≠"QA / Testes" e — o pior — `harness-ux` como **"Wireframe"**, o nome exato
 * da coisa que essa skill existe para NÃO fazer (ela entrega a "Jornada"; wireframe é o harness-ui).
 *
 * O lint `step-label-consistency.test.ts` agora TRAVA a divergência: toda entrada cujo trigger é step de algum
 * board tem de bater com o `name` daquele board.
 */
export const STEP_LABEL_BY_TRIGGER: Record<string, string> = {
  "harness-capture": "Capturando",
  "harness-grill": "Dúvidas",
  "harness-enrich": "Especificar",
  "harness-interview": "Entrevista",
  "harness-prioritize": "Estimar",
  "harness-ux": "Jornada",
  "harness-ui": "Telas",
  "harness-plan": "Plano & Tarefas",
  "harness-tasks": "Quebrar em tasks",
  "harness-do": "Desenvolver",
  "harness-review": "Revisão de código",
  "harness-qa": "QA / Testes",
  "harness-sync-card": "Sincronizar", // não é step de board (só telemetria) → livre
  "harness-refine": "Refinar",
  "harness-fix": "Corrigir",
  "harness-retire": "Descontinuar",
};

/** Run outcome → PT-BR label (the full table's Status column). */
export const RUN_STATUS_LABEL_PT: Record<RunOutcome, string> = {
  ok: "ok",
  error: "erro",
  timeout: "travou",
  exit: "saiu",
  "oom-killed": "estourou memória",
  "no-op": "no-op",
  cancelled: "cancelado",
  "max-turns": "limite de turnos",
};

/** A hard failure (renders red) vs a neutral/success stop (ok/no-op/cancelled/max-turns). */
const FAILURE_OUTCOMES: ReadonlySet<RunOutcome> = new Set(["error", "timeout", "exit", "oom-killed"]);

/** Reentry/maintenance skills — off the default FORWARD trail; still surfaced if they ran. */
const REENTRY_TRIGGERS: ReadonlySet<string> = new Set([
  "harness-capture",
  "harness-sync-card",
  "harness-refine",
  "harness-fix",
  "harness-retire",
]);

export function stepLabel(trigger: string): string {
  return STEP_LABEL_BY_TRIGGER[trigger] ?? trigger;
}

export function runStatusLabel(status: RunOutcome | null): string | null {
  return status ? RUN_STATUS_LABEL_PT[status] ?? status : null;
}

export const GATE_ICON: Record<StepGate, string> = { ok: "✓", blocked: "✗", pending: "·", exempt: "–", skipped: "⊘" };

/** WS5 — the GATE states that DON'T count toward "done" in the X/Y step counter (exempt/skipped are neither
 *  done nor pending — the card legitimately never has to satisfy them). ok is the only "done" state. */
export const COUNTED_DONE_GATES: ReadonlySet<StepGate> = new Set<StepGate>(["ok"]);
export const UNCOUNTED_GATES: ReadonlySet<StepGate> = new Set<StepGate>(["exempt", "skipped"]);

/**
 * WS5 — the honest X/Y step progress for a card's FORWARD path: `done` = gate ok, `total` = forward steps
 * MINUS the exempt/skipped ones (the card legitimately never has to satisfy those). Fixes the inflated
 * denominator (a technical card's QA-exempt step used to sit in the total forever, so X/Y never reached
 * Y). PURE — the single source the trail footer + any progress badge consume. Only on-path steps count.
 */
export function stepProgress(rollups: readonly StepRollup[]): { done: number; total: number } {
  const counted = rollups.filter((r) => r.onPath && !UNCOUNTED_GATES.has(r.gate));
  return { done: counted.filter((r) => COUNTED_DONE_GATES.has(r.gate)).length, total: counted.length };
}

function shortSha(sha: string | null | undefined): string | null {
  const s = (sha ?? "").trim();
  return s ? s.slice(0, 7) : null;
}

// ── the per-step declarative spec ────────────────────────────────────────────────────────────
//
// Each named step contributes a `left` (the human-readable signal it produced, from the card) and a
// `state` (its ✓/✗/· verdict, REUSING the gate predicate so it can't drift). A step the spec does
// not name falls back to the run's decision summary + an outcome-based verdict — so a new skill
// works without a code change here (board-agnostic).

interface StepSpec {
  /** the signal the step left, from the card's fields (null = nothing to show). `isTerminal` = the card is
   *  in a terminal status, so residual mechanism blockers are stale (see liveOpenBlockers). */
  left?: (card: Card, ran: boolean, isTerminal: boolean) => string | null;
  /** the ✓/✗/· verdict for the step. */
  state?: (card: Card, ran: boolean, isTerminal: boolean) => StepGate;
}

const STEP_SPEC: Record<string, StepSpec> = {
  "harness-grill": {
    left: (c) => {
      const n = openQuestions(c).length;
      return n ? `${n} pergunta${n > 1 ? "s" : ""}` : null;
    },
    // open questions = a HITL demand → blocked (needs an answer); ran with none open → ok.
    state: (c, ran) => (openQuestions(c).length ? "blocked" : ran ? "ok" : "pending"),
  },
  "harness-enrich": {
    left: (c) => {
      const ac = c.acceptance?.length ?? 0;
      if (hasNarrative(c)) return `narrativa + ${ac} AC`;
      return ac ? `${ac} AC` : null;
    },
    state: (c, ran) => (GATES.hasRefinement.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
  "harness-prioritize": {
    left: (c) => {
      const score = formatRiceScore(riceScore(c.rice));
      return score != null ? `RICE ${score}` : null;
    },
    state: (c, ran) => (GATES.hasPrioritization.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
  "harness-ux": {
    left: (c) => (c.wireframeChosen ? "wireframe escolhido" : null),
    state: (c, ran) => (GATES.hasWireframe.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
  "harness-ui": {
    left: (c) => (c.wireframeChosen ? "wireframe escolhido" : null),
    state: (c, ran) => (GATES.hasWireframe.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
  "harness-plan": {
    left: (c) => {
      const t = c.tasks?.length ?? 0;
      if (t) return `${t} task${t > 1 ? "s" : ""}`;
      return c.techPlanReady ? "plano técnico" : null;
    },
    state: (c, ran) => (GATES.hasTechPlan.ok(c) && GATES.hasTasks.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
  "harness-tasks": {
    left: (c) => {
      const t = c.tasks?.length ?? 0;
      return t ? `${t} task${t > 1 ? "s" : ""}` : null;
    },
    state: (c, ran) => (GATES.hasTasks.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
  "harness-do": {
    left: (c) => {
      const sha = shortSha(c.commitRange?.head);
      return sha ? `commit ${sha}` : null;
    },
    // no gate field of its own → outcome-based (handled by the fallback): a failed build reads ✗.
  },
  "harness-review": {
    left: (c, ran, isTerminal) => {
      // liveOpenBlockers dropa os MECHANISM blockers stale num card terminal (o mesmo backstop de display do
      // selo Bloqueio) — para não-terminal é byte-idêntico ao filtro antigo (todos os blocker/open titulados).
      const open = liveOpenBlockers(c.findings, isTerminal).filter((f) => String(f.title ?? "").trim() !== "").length;
      if (open) return `${open} bloqueador${open > 1 ? "es" : ""}`;
      return ran ? "0 bloqueadores" : null;
    },
    state: (c, ran, isTerminal) => {
      if (!ran) return "pending";
      if (GATES.hasNoBlockers.ok(c)) return "ok";
      // Card terminal cujo ÚNICO blocker aberto é mechanism stale: não leia "blocked". O GATE não muda (preserva
      // infra-exempt etc. para cards ativos); aqui só rebaixa o display de um card já arquivado / No Ar.
      if (isTerminal && liveOpenBlockers(c.findings, true).filter((f) => String(f.title ?? "").trim() !== "").length === 0) return "ok";
      return "blocked";
    },
  },
  "harness-qa": {
    left: (c) => (c.qaPassed === true ? "QA aprovado" : null),
    // Reuse the gate so a NON-user story (technical/bug/chore/spike), which hasQaPassed exempts
    // entirely, reads ✓ (you may move past QA) instead of a perpetual ✗/· "QA lie".
    state: (c, ran) => (GATES.hasQaPassed.ok(c) ? "ok" : ran ? "blocked" : "pending"),
  },
};

/** Fallback verdict for a step the spec doesn't name — purely outcome-based. */
function fallbackState(ran: boolean, lastStatus: RunOutcome | null): StepGate {
  if (!ran) return "pending";
  return lastStatus && FAILURE_OUTCOMES.has(lastStatus) ? "blocked" : "ok";
}

/** The card's effective StoryType for `skipForTypes` filtering (a non-story card → null = no skip). */
function effectiveStoryType(card: Card): StoryType | null {
  return card.type === "story" ? card.storyType ?? "user" : null;
}

/** A telemetry record's tokens (input + output), or null when neither was reported. */
function recordTokens(r: TelemetryRecord): number | null {
  return r.inputTokens == null && r.outputTokens == null ? null : (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
}

/**
 * Fold a card's telemetry + fields into one ordered StepRollup[] — the model behind the three
 * history densities. `liveTrigger` is the skill of the run in flight right now (RunnerSnapshot), if
 * any; its step is flagged `live`. PURE.
 */
export function computeStepRollups(
  config: BoardConfig,
  card: Card,
  telemetry: TelemetryRecord[],
  liveTrigger?: string | null,
  opts?: { transitions?: Transition[] },
): StepRollup[] {
  // Group the ledger by trigger. Telemetry is most-recent-first, so within each group the first
  // record is the latest; we still derive lastRunAt by max for safety.
  const byTrigger = new Map<string, TelemetryRecord[]>();
  for (const r of telemetry) {
    const g = byTrigger.get(r.trigger);
    if (g) g.push(r);
    else byTrigger.set(r.trigger, [r]);
  }
  const ranTriggers = new Set(byTrigger.keys());
  const storyType = effectiveStoryType(card);
  const isTerminal = terminalStatusIds(config).has(card.status ?? "");
  const seen = new Set<string>();
  const rollups: StepRollup[] = [];

  // WS5 — the EXECUTION axis: the latest ledger transition that ENTERED each status (visited). Absent for a
  // legacy card with no ledger. `run:<trigger>` actor normalises to "agent"; the rest pass through.
  const visitedByStatus = new Map<string, { at: string; actor: string }>();
  for (const t of opts?.transitions ?? []) {
    const actor = t.actor.startsWith("run:") ? "agent" : t.actor;
    const prev = visitedByStatus.get(t.to);
    if (!prev || t.at > prev.at) visitedByStatus.set(t.to, { at: t.at, actor });
  }

  const build = (
    trigger: string,
    step: StatusDef | null,
    order: number,
    onPath: boolean,
    override?: { gate: StepGate; reason: string },
  ): StepRollup => {
    const statusId = step?.id ?? null;
    const recs = byTrigger.get(trigger) ?? [];
    const ran = recs.length > 0;
    const latest = recs.reduce<TelemetryRecord | null>((a, b) => (a == null || b.startedAt > a.startedAt ? b : a), null);
    const spec = STEP_SPEC[trigger];
    const lastStatus = latest?.status ?? null;
    // WS5 — the GATE axis. An explicit override (skipped, from the route walk) wins. Otherwise the spec/
    // fallback verdict, with two additive refinements: (a) harness-qa whose gate is satisfied ONLY because the
    // card is exempt (non-UI story → visual sweep N/A) with ZERO QA runs reads `exempt`, not a retroactive ✓
    // "QA lie"; (b) a gate-ok step that never ran/was-visited is flagged satisfiedWithoutRun (field authored
    // directly). NEVER demotes a real gate-ok to pending — the new states are additive.
    const baseGate = spec?.state ? spec.state(card, ran, isTerminal) : fallbackState(ran, lastStatus);
    const visited = statusId ? visitedByStatus.get(statusId) : undefined;
    let gate: StepGate = override?.gate ?? baseGate;
    let reason: string | undefined = override?.reason;
    if (!override && trigger === "harness-qa" && baseGate === "ok" && !ran && !hasUiSurface(card)) {
      gate = "exempt";
      reason = "isento — sem UI; gate = suíte";
    }
    const satisfiedWithoutRun = gate === "ok" && !ran && !visited;
    const specLeft = spec?.left ? spec.left(card, ran, isTerminal) : null;
    // Fall back to the run's own decision (F4 summary) when the step has no field-derived signal.
    const left = specLeft ?? (latest?.summary?.trim() ? latest.summary.trim() : null);
    const totalCost = recs.reduce((acc, r) => acc + (r.costUSD ?? 0), 0);
    return {
      trigger,
      statusId,
      // O NOME vem do BOARD, que é a fonte da verdade — não do espelho. O `StatusDef` já está aqui, no
      // parâmetro, e mesmo assim isto consultava STEP_LABEL_BY_TRIGGER (um mapa cujo próprio comentário dizia
      // "mirrors the board's step names"). Espelho é cópia, e cópia deriva: `harness-ux` aparecia como "Wireframe"
      // — o nome exato da coisa que essa skill existe para NÃO fazer (wireframe é o harness-ui; o harness-ux entrega a
      // "Jornada"). O mapa fica SÓ como fallback para trigger telemetry-only (skill que rodou mas não é step
      // deste board → `step` é null), e um lint agora impede que ele volte a divergir.
      step: step?.name ?? stepLabel(trigger),
      order,
      onPath,
      isCurrent: statusId != null && card.status === statusId,
      live: liveTrigger != null && liveTrigger === trigger,
      runs: recs.length,
      lastRunAt: latest?.startedAt ?? null,
      lastStatus,
      left,
      gate,
      ...(reason ? { reason } : {}),
      ...(satisfiedWithoutRun ? { satisfiedWithoutRun: true } : {}),
      ...(visited ? { visited } : {}),
      metrics: latest
        ? {
            model: latest.model ?? null,
            effort: latest.effort ?? null,
            durationMs: latest.durationMs,
            turns: latest.turns,
            tokens: recordTokens(latest),
            costUSD: latest.costUSD,
            totalCostUSD: totalCost,
          }
        : null,
      // Capabilities = the union of tools used across THIS step's runs, vs what the step's config wires.
      capabilities: stepCapabilities(step, config.id, storyType, recs.flatMap((r) => r.toolsUsed ?? []), config.toolConfigs),
    };
  };

  // 1) Walk the pipeline in order. A triggered, non-terminal, non-laneStep step is a FORWARD-path
  //    step when it applies to this card's type and isn't a reentry/maintenance skill. Reentry steps
  //    are included only if they actually ran (so a reopened card shows its refine/fix history).
  const routable = { storyType: card.storyType, mode: card.mode, refinement: card.refinement, routing: card.routing, status: card.status };
  config.statuses.forEach((s, i) => {
    const trigger = s.trigger;
    if (!trigger || s.terminal || s.laneStep || seen.has(trigger)) return;
    const isReentry = REENTRY_TRIGGERS.has(trigger);
    const typeApplicable = !storyType || !s.skipForTypes?.includes(storyType);
    // WS5 — a FORWARD build step this card's ROUTE bypasses is now VISIBLE as `skipped` + a reason (was
    // silently OMITTED, hiding the route). Two reasons: the static `skipForTypes` ("tipo: …") or the
    // per-instance `routing.skips` ("rota: …", WS4). A reentry step this card never ran stays omitted (it's
    // not "skipped" — it's an inapplicable maintenance skill).
    if (!isReentry) {
      if (!typeApplicable) {
        seen.add(trigger);
        rollups.push(build(trigger, s, i, false, { gate: "skipped", reason: `tipo: ${storyType}` }));
        return;
      }
      if (routeSkip(s, routable) && isDispensable(s)) {
        seen.add(trigger);
        const profile = card.routing?.profile;
        rollups.push(build(trigger, s, i, false, { gate: "skipped", reason: profile ? `rota: ${profile}` : "rota" }));
        return;
      }
      seen.add(trigger);
      rollups.push(build(trigger, s, i, true));
      return;
    }
    // reentry skill — only surface it if it actually ran (unchanged).
    if (!ranTriggers.has(trigger)) return;
    seen.add(trigger);
    rollups.push(build(trigger, s, i, false));
  });

  // 2) Any telemetry trigger with NO matching pipeline step (a skill that ran but isn't in this
  //    board's statuses) — append as a telemetry-only rollup so the history stays complete.
  const tail = config.statuses.length;
  let extra = 0;
  for (const trigger of ranTriggers) {
    if (seen.has(trigger)) continue;
    seen.add(trigger);
    rollups.push(build(trigger, null, tail + extra++, false));
  }

  return rollups;
}
