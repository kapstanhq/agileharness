import type { BugReport, Card, GateId, Refinement, ReopenMode, Retirement } from "./types";

// The three reopen blocks a card can carry (exactly ONE non-null at a time — the active reopen).
type ReopenBlocks = Pick<Card, "refinement" | "bugReport" | "retirement">;

/** The Card field a reopen mode populates (the others are NULLed). */
type ReopenBlockKey = keyof ReopenBlocks;

// The full per-reopen state a fresh reopen wipes: the three reopen blocks PLUS the per-instance
// routing override (`routing`). The routing skip set is computed FOR a SPECIFIC reopen instance
// (a given mode + refinement.kinds), so it MUST NOT survive a new reopen — a stale skip decision
// tied to a previous refine's kinds would otherwise let the new reopen silently bypass steps it
// should traverse. `applyReopen` NULLs every key here, then sets only the active block.
type ClearedReopenState = ReopenBlocks & Pick<Card, "routing">;

/**
 * One reopen LANE — the full per-mode relationship (status / gate / block) that used to be scattered
 * as literals across the three reopen actions, acceptRoute, BRANCH_GATES and the card-UI buttons.
 */
export interface ReopenKind {
  /** the CardMode stamped onto the card */
  mode: ReopenMode;
  /** the executor/entry status the card lands in */
  status: string;
  /** the entry gate that status carries — pre-satisfied by the brief/pointer this reopen stamps */
  gate: GateId;
  /** the Card field this mode populates; {@link applyReopen} NULLs the other reopen blocks */
  block: ReopenBlockKey;
  /** retire only: where the card lands when there is NOTHING to remove (no level) — skips the
   *  executor straight to the graveyard. Undefined for refine/fix (they always run their executor). */
  noOpStatus?: string;
}

/**
 * THE single source of the reopen lanes (the AGENTS-registry pattern, for reopen). Adding a 4th
 * reopen lane = ONE entry here (+ its action's input shape) instead of editing the action, acceptRoute,
 * BRANCH_GATES and ~3 UI components in lockstep. `Record<ReopenMode, …>` → the compiler forces an entry
 * per mode. Everything below DERIVES from this.
 */
export const REOPEN_KINDS: Record<ReopenMode, ReopenKind> = {
  refine: { mode: "refine", status: "refinar", gate: "hasRefineBrief", block: "refinement" },
  fix: { mode: "fix", status: "corrigir", gate: "hasBugReport", block: "bugReport" },
  retire: { mode: "retire", status: "descontinuar", gate: "hasRetireBrief", block: "retirement", noOpStatus: "arquivados" },
};

/** The gates guarding the reopen lanes — DERIVED from {@link REOPEN_KINDS}. move-targets' BRANCH_GATES
 *  unions this with the triage `hasDuplicateOf` so the move recommendation steps past inactive lanes. */
export const REOPEN_GATES: ReadonlySet<GateId> = new Set(Object.values(REOPEN_KINDS).map((k) => k.gate));

/**
 * Statuses a SHIPPED story can be REOPENED from — the human QA checkpoint (`revisao`) and the shipped
 * state (`concluida`). The single source for the "Refinar" / "Reportar bug" buttons (drawer +
 * RunnerStatusProvider) and the discontinue "shipped vs abandoned" disposition default. NOTE: `retire`
 * can leave from ANY status, so it is NOT bounded by this set (only refine/fix are).
 */
export const REOPENABLE_STATUSES: ReadonlySet<string> = new Set(["revisao", "concluida"]);

/** Can this card be reopened to improve (refine) or fix a regression — a delivered story in QA/shipped? */
export function isReopenableStatus(card: Pick<Card, "type" | "status">): boolean {
  return card.type === "story" && card.status != null && REOPENABLE_STATUSES.has(card.status);
}

/**
 * The build-flow columns a refine/fix reopen can land DIRECTLY into (reabertura R1 — "volta para a
 * coluna específica"). The operator picks ONE; the card lands there carrying `mode`+brief and the
 * cascade's mode-aware override runs harness-refine/harness-fix THERE (triggerForCard), instead of parking in a
 * dedicated reentry column. Discovery=re-specify, Design=re-do UX/UI, Em desenvolvimento=re-code.
 */
export type ReopenDestination = "enriquecer" | "design-ux" | "desenvolver";
export const REOPEN_DESTINATIONS: ReadonlySet<string> = new Set<string>(["enriquecer", "design-ux", "desenvolver"]);
export function isReopenDestination(v: unknown): v is ReopenDestination {
  return typeof v === "string" && REOPEN_DESTINATIONS.has(v);
}

/**
 * Disarm the ONE-SHOT reopen override: clear `reopenPending` (the flag that makes the cascade run the
 * dedicated reopen skill at the destination) WITHOUT touching `mode`. The reopen executor skill
 * (harness-refine/harness-fix) applies this on its FIRST pass, so the SAME run's downstream cascade entries run
 * the column's OWN mode-aware skill (harness-do/harness-review) instead of re-firing harness-refine/harness-fix — while
 * `mode` PERSISTS through the flow for those skills to scope their work (harness-qa is the only station that
 * clears `mode`). This is the canonical clear the unit tests pin (don't trust prose-only clears). Pure.
 */
export function clearReopenPending(card: Card): Card {
  return { ...card, reopenPending: undefined };
}

/**
 * Stamp a REOPEN onto a card: set `mode`, attach the mode's block, and NULL every OTHER reopen block
 * AND the stale per-instance routing override.
 *
 * Enforces the "a card carries ONE reopen block at a time" invariant in ONE place instead of three
 * hand-written sibling-clears across refineCardAction / reportBugAction / discontinueCardAction. That
 * invariant is load-bearing: gate-core reads `.refinement`/`.bugReport`/`.retirement` `.brief` for the
 * hasRefinement/hasBugReport/hasRetirement gates, and the card badges render them — a missed clear
 * leaves a STALE block a gate/badge still reads (a real source-of-truth drift). The old code even
 * diverged: refine/fix cleared only ONE sibling (refine nulled bugReport but not retirement); this
 * clears ALL non-matching blocks, which is the correct, generalized rule.
 *
 * It ALSO clears `routing` — the per-instance skip override (CardRouting). That skip set is computed
 * FOR a specific reopen (its mode + refinement.kinds); a brand-new reopen must recompute its own
 * routing from the FRESH brief, never inherit the previous instance's verdict. Leaving it would let a
 * prior refine's `routing.skips` (authoritative when present) silently bypass build/discovery steps the
 * new reopen should traverse — the same source-of-truth drift as a stale block. This is the single
 * chokepoint, so every reopen lane gets the clear for free.
 *
 * Um FIX também RE-TIPA a story como `bug`. Não é cosmético: é o invariante que o lint de
 * classificação cobra ("a fix / bug-report MUST be typed bug, so it leaves the map for the Kanban" —
 * story-classification.test.ts, regra 3), e o caminho da TRIAGEM já o cumpria (`report_issue` grava
 * `storyType: "bug"` junto do `mode: "fix"`). Só o `reportBugAction` não cumpria, e o resultado foi
 * board-data inválido em produção: quatro stories `technical`/`chore` com `mode: fix`, que deixaram o
 * lint vermelho e, com ele, o merge train fechado para TODAS as sessões. Aqui — no chokepoint — toda
 * lane de fix passa a gravar o par completo, que é o que o doc-comment acima já promete para o clear.
 *
 * `status` stays the CALLER's responsibility — it differs per action (refine→refinar, fix→corrigir,
 * retire→descontinuar|arquivados by level), so the action spreads it after. Pure.
 */
export function applyReopen(
  card: Card,
  reopen:
    | { mode: "refine"; refinement: Refinement }
    | { mode: "fix"; bugReport: BugReport }
    | { mode: "retire"; retirement: Retirement },
): Card {
  const cleared: ClearedReopenState = { refinement: null, bugReport: null, retirement: null, routing: null };
  const block: Partial<ReopenBlocks & Pick<Card, "storyType">> =
    reopen.mode === "refine"
      ? { refinement: reopen.refinement }
      : reopen.mode === "fix"
        ? // `storyType` só existe em story (backbone o carrega null) — re-tipar um activity/step
          // inventaria um campo que o schema dele não tem.
          { bugReport: reopen.bugReport, ...(card.type === "story" ? { storyType: "bug" as const } : {}) }
        : { retirement: reopen.retirement };
  return { ...card, mode: reopen.mode, ...cleared, ...block };
}
