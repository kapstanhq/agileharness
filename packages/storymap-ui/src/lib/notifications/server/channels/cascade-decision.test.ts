import { describe, expect, it } from "vitest";
import { decideCascade, decideForward } from "./cascade-decision";
import { coerceCard } from "@/lib/storymap/repo";
import type { StoryType } from "@/lib/storymap/frameworks";
import type { BoardConfig, StatusDef } from "@/lib/storymap/types";

const cfg = (statuses: StatusDef[]): BoardConfig => ({
  id: "b",
  name: "B",
  statuses,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
});

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

// The autorun cascade's RUN / FORWARD / STOP decision — the automation heart. An
// inverted branch either fires harness-do unprompted or freezes the board (silently,
// since the dispatcher swallows channel errors). Tested here as a pure kernel.
const pipeline = cfg([
  { id: "enriquecer", name: "Enriquecer", trigger: "harness-enrich", autorun: true },
  { id: "refinada", name: "Refinada", gate: "hasRefinement", autorun: true }, // gated landing, no trigger → FORWARD
  { id: "quebrar-tasks", name: "Quebrar tasks", trigger: "harness-tasks", autorun: true },
  { id: "com-design", name: "Com design", autorun: false }, // manual → STOP
  { id: "concluida", name: "Concluída", terminal: true },
]);

const fullNarrative = { role: "Como X", want: "quero Y", soThat: "para Z" };

describe("decideCascade", () => {
  it("RUN: a status with a trigger spawns that skill", () => {
    expect(decideCascade(card({ status: "enriquecer" }), pipeline)).toEqual({
      action: "run",
      trigger: "harness-enrich",
    });
  });

  it("STOP (manual): a status with autorun !== true", () => {
    expect(decideCascade(card({ status: "com-design" }), pipeline)).toEqual({
      action: "stop",
      reason: "manual",
    });
  });

  it("1.7 — does NOT forward a card a human placed in a status its OWN route skips (respects the placement)", () => {
    // design-ux is dispensable (column "prepare"). storyType user → NOT structurally skipped; but the card's
    // route lists design-ux as skipped. A human moved the card INTO design-ux (autorun:false). Before the fix
    // the cascade would forward it past (routeSkip'd resting status) → undoing the placement; now it STOPs.
    const routed = cfg([
      { id: "design-ux", name: "Jornada", column: "prepare", autorun: false, skipForTypes: ["technical", "bug", "chore", "spike"] },
      { id: "plano-tecnico", name: "Plano", trigger: "harness-plan", autorun: true },
      { id: "concluida", name: "Concluída", terminal: true },
    ]);
    const c = card({
      status: "design-ux",
      storyType: "user",
      narrative: fullNarrative,
      routing: { skips: ["design-ux"], decidedBy: "human", decidedAt: "2026-07-10" },
    });
    expect(decideCascade(c, routed)).toEqual({ action: "stop", reason: "manual" });
  });

  it("STOP (manual): a status id not present in the board config", () => {
    expect(decideCascade(card({ status: "fantasma" }), pipeline)).toEqual({
      action: "stop",
      reason: "manual",
    });
  });

  it("STOP (no-status): a card with no status", () => {
    expect(decideCascade(card({ status: null }), pipeline)).toEqual({
      action: "stop",
      reason: "no-status",
    });
  });

  it("FORWARD: a gated landing (no trigger) whose next-status gate passes", () => {
    // refinada → quebrar-tasks (no gate on quebrar-tasks) → forward
    const refined = card({ status: "refinada", narrative: fullNarrative, acceptance: ["ac"] });
    expect(decideCascade(refined, pipeline)).toEqual({ action: "forward", to: "quebrar-tasks" });
  });
});

// ADR-059: the Deploy step is `autorun:false` (the human click is the trigger) BUT sets
// `autoEnterTerminal` so, once the card is IN it, the cascade auto-forwards into `concluida`
// (No ar). This must run BEFORE the manual guard — otherwise the autorun:false Deploy would
// STOP and never reach the terminal. A plain autorun:false step (no flag) still STOPS manual.
describe("decideCascade — autoEnterTerminal forwards from an autorun:false step (the Deploy → No ar)", () => {
  const deployPipeline = cfg([
    { id: "release", name: "Liberar", autorun: false }, // the resting point — plain manual STOP
    { id: "deploy", name: "Publicar", autorun: false, autoEnterTerminal: true },
    { id: "concluida", name: "No ar", terminal: true },
  ]);

  it("FORWARDS deploy → concluida even though deploy is autorun:false (autoEnterTerminal wins)", () => {
    expect(decideCascade(card({ status: "deploy" }), deployPipeline)).toEqual({
      action: "forward",
      to: "concluida",
    });
  });

  it("STOPS manual at `release` (autorun:false, no autoEnterTerminal) — the ready-but-not-live rest", () => {
    expect(decideCascade(card({ status: "release" }), deployPipeline)).toEqual({
      action: "stop",
      reason: "manual",
    });
  });
});

// deploy-truth WS-3 (D-DT3): the LIVE _base board.yaml no longer sets `autoEnterTerminal` on the deploy
// step — the card WAITS in "Publicando" until the SETTLE handler (settleDeploySuccess) proves the publish
// and advances it through the gate. The autoEnterTerminal MECHANISM above stays intact (only the wiring
// left the yaml), so this pins the NEW-model shape: with the flag absent, NO cascade path re-advances the
// card out of `deploy` on its own — the kernel stops manual, and the terminal entry belongs to the settle.
describe("decideCascade — deploy-truth: the settle-gated deploy step (no flag) STOPS, never self-advances", () => {
  const settleGated = cfg([
    { id: "release", name: "Liberar", autorun: false },
    { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" }, // the new _base wiring
    { id: "concluida", name: "No ar", gate: "hasDeployProof", terminal: true },
  ]);

  it("STOPS manual at `deploy` — the card waits in Publicando for the settle (no optimistic forward)", () => {
    expect(decideCascade(card({ status: "deploy" }), settleGated)).toEqual({
      action: "stop",
      reason: "manual",
    });
  });

  it("even a card CARRYING the proof does not cascade out of deploy by itself (the advance is the settle's act)", () => {
    const proven = card({
      status: "deploy",
      deployProof: { sha: "abc1234", targets: ["acmeapp"], at: "2026-07-17T12:00:00Z", source: "registry-ondone" },
    } as never);
    expect(decideCascade(proven, settleGated)).toEqual({ action: "stop", reason: "manual" });
  });
});

describe("decideCascade — suppressTrigger loop guard (run-completion re-eval)", () => {
  it("STOPS when the card still rests in the column whose trigger JUST ran (no retry loop)", () => {
    // A run finished but did NOT advance the card → re-firing the same skill would loop.
    expect(decideCascade(card({ status: "enriquecer" }), pipeline, { suppressTrigger: "harness-enrich" })).toEqual({
      action: "stop",
      reason: "already-ran",
    });
  });

  it("RUNS the next skill when the card advanced into a DIFFERENT autorun column", () => {
    // harness-enrich finished and moved the card to quebrar-tasks → continue with harness-tasks.
    expect(decideCascade(card({ status: "quebrar-tasks" }), pipeline, { suppressTrigger: "harness-enrich" })).toEqual({
      action: "run",
      trigger: "harness-tasks",
    });
  });

  it("an absent suppressTrigger preserves the event-path behaviour (RUN)", () => {
    expect(decideCascade(card({ status: "enriquecer" }), pipeline)).toEqual({
      action: "run",
      trigger: "harness-enrich",
    });
  });
});

describe("decideForward — the cascade bridge", () => {
  it("forwards to the next status when its entry gate passes (or has none)", () => {
    const config = cfg([{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    expect(decideForward(card({ status: "a" }), config.statuses[0], config)).toEqual({
      action: "forward",
      to: "b",
    });
  });

  it("STOPS at the last status (no next)", () => {
    const config = cfg([{ id: "a", name: "A" }]);
    expect(decideForward(card({ status: "a" }), config.statuses[0], config)).toEqual({
      action: "stop",
      reason: "no-next-or-terminal",
    });
  });

  it("STOPS before a terminal/done column (closing is an explicit act)", () => {
    const config = cfg([{ id: "a", name: "A" }, { id: "done", name: "Done", terminal: true }]);
    expect(decideForward(card({ status: "a" }), config.statuses[0], config)).toEqual({
      action: "stop",
      reason: "no-next-or-terminal",
    });
  });

  // ADR-059: the ONE exception — a SOURCE step that sets `autoEnterTerminal` (the deploy/Publicar step)
  // auto-advances INTO the terminal. Default-off everywhere else, so the kernel stays column-agnostic.
  it("FORWARDS into a terminal when the SOURCE step sets autoEnterTerminal (the Deploy → No ar case)", () => {
    const config = cfg([
      { id: "deploy", name: "Publicar", autoEnterTerminal: true },
      { id: "concluida", name: "No ar", terminal: true },
    ]);
    expect(decideForward(card({ status: "deploy" }), config.statuses[0], config)).toEqual({
      action: "forward",
      to: "concluida",
    });
  });

  it("a NORMAL terminal is NOT auto-entered even from an autoEnterTerminal step if the SOURCE lacks the flag", () => {
    // Only the SOURCE step's flag matters: a plain step before a terminal still STOPS.
    const config = cfg([{ id: "a", name: "A" }, { id: "concluida", name: "No ar", terminal: true }]);
    expect(decideForward(card({ status: "a" }), config.statuses[0], config)).toEqual({
      action: "stop",
      reason: "no-next-or-terminal",
    });
  });

  it("STOPS when the next status's entry gate fails (never forwards past a gate)", () => {
    const config = cfg([{ id: "a", name: "A" }, { id: "b", name: "B", gate: "hasTasks" }]);
    const noTasks = card({ status: "a", tasks: [] });
    const out = decideForward(noTasks, config.statuses[0], config);
    expect(out.action).toBe("stop");
    expect((out as { reason: string }).reason).toMatch(/^gate:/);
  });

  it("forwards past a gate the card satisfies", () => {
    const config = cfg([{ id: "a", name: "A" }, { id: "b", name: "B", gate: "hasTasks" }]);
    const withTasks = card({ status: "a", tasks: [{ id: "t1", title: "fazer", done: false }] });
    expect(decideForward(withTasks, config.statuses[0], config)).toEqual({ action: "forward", to: "b" });
  });
});

// The storyType branch: a story with no UI surface (technical/chore/spike/bug) skips
// the design block (design-ux → com-design) so infra cards advance without a human
// dragging them past columns that have nothing to design. A `user` story is untouched
// (regression guard — the full path must stay intact). Mirrors the real pipeline slice.
describe("decideCascade — storyType-aware design skip", () => {
  const designPipeline = cfg([
    { id: "pronta", name: "Pronta", autorun: true }, // autorun:true so the kernel decides (board toggles are operational)
    { id: "design-ux", name: "Design UI/UX", trigger: "harness-ux", autorun: true },
    { id: "com-design", name: "Com design", gate: "hasWireframe", autorun: false },
    { id: "plano-tecnico", name: "Plano técnico", trigger: "harness-plan", autorun: true },
    { id: "concluida", name: "Concluída", terminal: true },
  ]);

  const NON_USER = ["technical", "chore", "spike", "bug"] as const;

  it("user: RUNS harness-ux in design-ux (the design block is intact)", () => {
    expect(decideCascade(card({ status: "design-ux", storyType: "user" }), designPipeline)).toEqual({
      action: "run",
      trigger: "harness-ux",
    });
  });

  it.each(NON_USER)("%s: FORWARDS design-ux → plano-tecnico (skips harness-ux + com-design)", (storyType) => {
    expect(decideCascade(card({ status: "design-ux", storyType }), designPipeline)).toEqual({
      action: "forward",
      to: "plano-tecnico",
    });
  });

  it.each(NON_USER)("%s: FORWARDS pronta → plano-tecnico in one hop (no manual drag)", (storyType) => {
    // pronta has no trigger → decideForward, which for a non-user story skips the
    // whole design block (design-ux + com-design) and lands on plano-tecnico.
    expect(decideCascade(card({ status: "pronta", storyType }), designPipeline)).toEqual({
      action: "forward",
      to: "plano-tecnico",
    });
  });

  it("user: pronta → design-ux (regression: the full path still runs the design block)", () => {
    expect(decideCascade(card({ status: "pronta", storyType: "user" }), designPipeline)).toEqual({
      action: "forward",
      to: "design-ux",
    });
  });

  // The storyType skip is evaluated BEFORE the manual guard ON PURPOSE: a non-user
  // story has no UI surface, so a design column is never a resting place for it — the
  // cascade forwards it past the block even under autorun:false (so the auto-skip works
  // on every board, not only where design-ux is autorun:true). The manual guard still
  // governs every NON-skip status and every `user` story. Three cases pin that contract.
  describe("the design skip forwards past a manual (autorun:false) design column", () => {
    const manual = cfg([
      { id: "pronta", name: "Pronta", autorun: false }, // non-skip go/no-go → manual still wins
      { id: "design-ux", name: "Design", trigger: "harness-ux", autorun: false }, // skip-status, manual
      { id: "plano-tecnico", name: "Plano", autorun: true },
    ]);

    it("(a) skip-status + non-user + autorun:false → FORWARDS past the design block", () => {
      // design-ux is autorun:false, but a technical story skips it regardless → plano-tecnico.
      expect(decideCascade(card({ status: "design-ux", storyType: "technical" }), manual)).toEqual({
        action: "forward",
        to: "plano-tecnico",
      });
    });

    it("(b) NON-skip status + autorun:false → STOP manual (the go/no-go gate still governs)", () => {
      // `pronta` is not a design column → the manual guard still stops it under autorun:false.
      expect(decideCascade(card({ status: "pronta", storyType: "technical" }), manual)).toEqual({
        action: "stop",
        reason: "manual",
      });
    });

    it("(c) user story in a skip-status + autorun:false → STOP manual (user is never skipped)", () => {
      // skipsStatusForType is false for `user` → it falls through to the manual guard.
      expect(decideCascade(card({ status: "design-ux", storyType: "user" }), manual)).toEqual({
        action: "stop",
        reason: "manual",
      });
    });
  });

  // Edge guard: reordering the skip branch ahead of the manual guard must not break the
  // early-returns. A card with no status stops as `no-status` at the very top; a card whose
  // status id is unknown to the board (`!status`) must STOP `manual` WITHOUT crashing on the
  // `status.id` access inside skipsStatusForType (which now runs before the autorun check).
  describe("reordering keeps the early-return edge guards intact", () => {
    it("no status → STOP no-status (top early-return, before any status lookup)", () => {
      expect(decideCascade(card({ status: null, storyType: "technical" }), designPipeline)).toEqual({
        action: "stop",
        reason: "no-status",
      });
    });

    it("unknown status id → STOP manual without touching status.id in the skip branch", () => {
      expect(decideCascade(card({ status: "fantasma", storyType: "technical" }), designPipeline)).toEqual({
        action: "stop",
        reason: "manual",
      });
    });
  });
});

// The mode/kinds branch (story-rl5v03): a REOPENED refine of a `user` story skips steps a fresh build
// runs — the discovery interview always, the design block when the refinement is TEXT/BEHAVIOUR-only
// (copy/functionality). A refine with a visual kind (ui/ux) KEEPS the design block. This is the SM-1
// token saving: a copy/behaviour refine no longer burns a harness-interview + harness-ux + harness-ui spawn.
describe("decideCascade — mode/kinds-aware skip (refine)", () => {
  const SKIP: StoryType[] = ["technical", "chore", "spike", "bug"];
  const reopenPipeline = cfg([
    { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true, column: "discovery" },
    { id: "interview", name: "Entrevista", trigger: "harness-interview", autorun: true, column: "discovery", skipForTypes: SKIP },
    { id: "priorizar", name: "Estimar", gate: "hasRefinement", trigger: "harness-prioritize", autorun: true, column: "discovery" },
    { id: "pronta", name: "A fazer", autorun: true, column: "todo" }, // autorun:true so the kernel decides
    { id: "design-ux", name: "Jornada", trigger: "harness-ux", autorun: true, column: "prepare", skipForTypes: SKIP },
    { id: "design-ui", name: "Telas", trigger: "harness-ui", autorun: true, column: "prepare", skipForTypes: SKIP },
    { id: "com-design", name: "Aprovar design", gate: "hasWireframe", autorun: false, column: "prepare", skipForTypes: SKIP },
    { id: "ready", name: "Pronto p/ dev", autorun: false, column: "ready", skipForTypes: SKIP },
    { id: "plano-tecnico", name: "Plano & Tarefas", trigger: "harness-plan", autorun: true, column: "in-progress" },
    { id: "concluida", name: "No ar", terminal: true, column: "live" },
  ]);

  const refine = (kinds: string[], extra: Record<string, unknown> = {}) =>
    card({ storyType: "user", mode: "refine", refinement: { brief: "melhorar", kinds }, ...extra });

  it("AC1: refine[functionality] FORWARDS pronta → plano-tecnico (skips the whole design+ready run)", () => {
    expect(decideCascade(refine(["functionality"], { status: "pronta", narrative: fullNarrative, acceptance: ["ac"] }), reopenPipeline)).toEqual({
      action: "forward",
      to: "plano-tecnico",
    });
  });

  it("AC1: refine[functionality] FORWARDS past the interview at enriquecer → priorizar (when its gate passes)", () => {
    // priorizar gates on hasRefinement (full narrative + ≥1 acceptance) — satisfy it so the forward lands.
    const c = refine(["functionality"], { status: "interview", narrative: fullNarrative, acceptance: ["ac"] });
    expect(decideCascade(c, reopenPipeline)).toEqual({ action: "forward", to: "priorizar" });
  });

  it("AC2: refine[ui] still RUNS harness-ux at design-ux (the design block is intact)", () => {
    expect(decideCascade(refine(["ui"], { status: "design-ux" }), reopenPipeline)).toEqual({
      action: "run",
      trigger: "harness-ux",
    });
  });

  it("AC2: refine[ux] FORWARDS pronta → design-ux (visual refine keeps the design block)", () => {
    expect(decideCascade(refine(["ux"], { status: "pronta", narrative: fullNarrative, acceptance: ["ac"] }), reopenPipeline)).toEqual({
      action: "forward",
      to: "design-ux",
    });
  });

  it("a refine card sitting in `interview` FORWARDS past it (the interview is always skipped on reopen)", () => {
    const c = refine(["ui"], { status: "interview", narrative: fullNarrative, acceptance: ["ac"] });
    expect(decideCascade(c, reopenPipeline)).toEqual({ action: "forward", to: "priorizar" });
  });

  it("regression: a plain user BUILD story RUNS harness-interview at interview (no skip)", () => {
    expect(decideCascade(card({ status: "interview", storyType: "user" }), reopenPipeline)).toEqual({
      action: "run",
      trigger: "harness-interview",
    });
  });

  it("AC4: card.routing.skips makes the design block skippable for a visual refine (agent decision wins)", () => {
    const c = refine(["ui"], {
      status: "pronta",
      narrative: fullNarrative,
      acceptance: ["ac"],
      routing: { skips: ["design-ux", "design-ui", "com-design", "ready"], decidedBy: "agent", decidedAt: "2026-06-16" },
    });
    expect(decideCascade(c, reopenPipeline)).toEqual({ action: "forward", to: "plano-tecnico" });
  });
});

// MODE-AWARE TRIGGER OVERRIDE (reabertura R1) — a card REOPENED for refine/fix runs its DEDICATED skill
// (harness-refine/harness-fix) on its FIRST pass at the chosen destination, gated by the ONE-SHOT `reopenPending`
// flag. The loop-guard keys on the EFFECTIVE trigger: a reopen skill that JUST ran and did NOT advance
// (suppressTrigger === effectiveTrigger) STOPs. Case (h) is the LOAD-BEARING one: once `reopenPending`
// clears, a card whose `mode:fix` STILL PERSISTS (the flow keeps it until harness-qa) runs the column's OWN
// skill — the override is one-shot and never hijacks harness-do/harness-review/harness-qa downstream.
describe("decideCascade — mode-aware trigger override (reabertura R1, one-shot)", () => {
  const SKIP: StoryType[] = ["technical", "chore", "spike", "bug"];
  // Mirrors _base: `desenvolver` is autorun:FALSE (only discovery/design steps autorun). The override must
  // STILL fire there for a reopen (the explicit human reopen is the trigger) — that is the whole point.
  const cfgR1 = cfg([
    { id: "design-ux", name: "Jornada", trigger: "harness-ux", autorun: true, column: "prepare", skipForTypes: SKIP },
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: false, column: "in-progress" },
    { id: "revisar-codigo", name: "Revisão", trigger: "harness-review", autorun: true, column: "in-progress" },
    { id: "concluida", name: "No ar", terminal: true, column: "live" },
  ]);
  const at = (mode: string, status: string, extra: Record<string, unknown> = {}) =>
    card({ storyType: "user", mode, status, ...extra });
  const pending = (mode: string, status: string, extra: Record<string, unknown> = {}) =>
    at(mode, status, { reopenPending: true, ...extra });

  it("(a) fix reopened INTO desenvolver RUNS harness-fix — even though desenvolver is autorun:FALSE (the reopen IS the trigger)", () => {
    // Blocker fix: the override is evaluated BEFORE the manual guard, so a reopen lands+runs on an
    // autorun:false destination (desenvolver, the DEFAULT bug destination) instead of stranding.
    expect(decideCascade(pending("fix", "desenvolver"), cfgR1)).toEqual({ action: "run", trigger: "harness-fix" });
  });
  it("(b) refine reopened INTO desenvolver RUNS harness-refine (autorun:false destination still fires)", () => {
    const c = pending("refine", "desenvolver", { refinement: { brief: "x", kinds: ["functionality"] } });
    expect(decideCascade(c, cfgR1)).toEqual({ action: "run", trigger: "harness-refine" });
  });
  it("(c) refine reopened INTO design-ux RUNS harness-refine — the chosen destination is never auto-skipped", () => {
    // a functionality-only refine WOULD skip the design block; the own-destination guard keeps it here so
    // the operator's explicit choice (reopen INTO design-ux) runs harness-refine there instead of forwarding past.
    const c = pending("refine", "design-ux", { refinement: { brief: "x", kinds: ["functionality"] } });
    expect(decideCascade(c, cfgR1)).toEqual({ action: "run", trigger: "harness-refine" });
  });
  it("(d) LOOP-GUARD: a just-ran harness-fix that did NOT advance STOPs (suppress keyed on effectiveTrigger)", () => {
    expect(decideCascade(pending("fix", "desenvolver"), cfgR1, { suppressTrigger: "harness-fix" })).toEqual({
      action: "stop",
      reason: "already-ran",
    });
  });
  it("(e) the column-trigger suppress (harness-do) does NOT suppress the reopen override — harness-fix still runs", () => {
    expect(decideCascade(pending("fix", "desenvolver"), cfgR1, { suppressTrigger: "harness-do" })).toEqual({
      action: "run",
      trigger: "harness-fix",
    });
  });
  it("(f) a non-reopen card at autorun:false desenvolver STOPs manual (the override never relaxes the guard for build)", () => {
    expect(decideCascade(at("build", "desenvolver"), cfgR1)).toEqual({ action: "stop", reason: "manual" });
  });
  it("(g) ONE-SHOT no-hijack: a card STILL in mode:fix but reopenPending CONSUMED runs the downstream column's OWN harness-review, not harness-fix", () => {
    // Load-bearing: mode:fix PERSISTS through the flow (harness-qa clears it). On a downstream autorun column
    // (revisar-codigo) with reopenPending already cleared, the override is OFF → the column's own skill
    // runs. Without the one-shot gate this would re-fire harness-fix on every downstream column.
    const c = at("fix", "revisar-codigo"); // mode:fix, reopenPending UNSET, autorun:true column
    expect(decideCascade(c, cfgR1)).toEqual({ action: "run", trigger: "harness-review" });
  });
});
