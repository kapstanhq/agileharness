// steward.ts — WS-8 (D11) — the AUTÔNOMO copiloto as the STEWARD OF INTEGRATION.
//
// NO NEW POWER. Not one. Every playbook below is a PLAN over the risk matrix that `tier.ts` already projects
// and `mcp/guard.ts` already enforces per call: `merge-resolve` unparks the train, `write-board` moves a card
// through a gate it factually satisfies, `run` re-drives. What the steward adds is that somebody ASKS the
// question — the three blockages that today sit waiting for the Operator to notice them:
//
//   8.1  a conflict PARKED on the train              → classify → re-try / climb the ladder / escalate
//   8.2  a claim whose session DIED, or is expiring  → converge / offer a redrive / a courtesy ping
//   8.3  a card stuck on a gate it ALREADY satisfies → move it (through the gate, never around it)
//
// ── THE LINE THIS MODULE DOES NOT CROSS ──────────────────────────────────────────────────────────────────
//  1. THE STEWARD IS NOT A SECOND INTEGRATOR. It never merges, never writes stage/main, never touches a
//     branch. EVERY resolution materializes as an ENTRY OF THE TRAIN ({@link ParkedConflictPlan} "retry" asks
//     the train to re-integrate; the train then runs ITS OWN disposition — WS-2's element-level merge for
//     board data, WS-10's ladder for code). The train stays the single path to stage/main. That is also why
//     this module has NO ladder of its own: re-parking an entry re-enters the disposition that ALREADY
//     climbs (merge-queue.ts `climbSemanticLadder`), so rung 0 (`already-landed`, $0) and rungs 1/2 come for
//     free and CANNOT drift from the train's own behaviour. A second ladder here would be the duplicated
//     ruler that D15 warns about.
//  2. GATES ARE NEVER BYPASSED. "Unblocking" means satisfying the gate or resolving the fact — never moving
//     a card around one. {@link planGateSatisfied} REQUIRES a passing gate verdict as its input and the move
//     still goes through `move_card`, which validates the gate again. This is the LEGITIMATE "advance outside
//     the pipeline": outside the CASCADE (which only reacts to events), never outside the GATES.
//  3. `run-free` (a shell) and `destructive` are NEVER_AUTO in EVERY tier — the kernel clamp in
//     `dispositionFor` — and no plan here names them. Deploy happens ONLY through the ritual (deploy_plan
//     dry-run → scoped risk → the esteira); no plan here deploys, and {@link planGateSatisfied} REFUSES a
//     move whose target column would FIRE a deploy unless `deploy` itself resolves to auto.
//  4. NEVER DISCARD A BRANCH. {@link OrphanClaimPlan} has no "discard" member — not as a policy, as a TYPE.
//     A dead session's preserved worktree is the 3rd re-implementation of the qb8z2c fix; the steward exists
//     BECAUSE that work was thrown away, so it may not be expressible here.
//  5. LOOP-GUARD: a playbook re-tries only on a CHANGE OF FACT. The counters are PERSISTED on the entry
//     ({@link StewardEntry.stewardAttempts}, the exact sibling of `driveCount`/`semanticAttempts`) so they
//     survive a restart. Same unchanged text + same base ⇒ the steward already answered; asking again is a
//     loop, not a retry.
//  6. DOUBT ⇒ THE HUMAN, WITH THE ANALYSIS. Every escalation carries the judge's `resolutionAnalysis` so the
//     operator decides ONE digested hunk, not a raw diff — and then the steward is SILENT (no re-try without
//     a new fact). Fail-closed, the same asymmetry as convergence.ts: whoever ACTS needs proof.
//
// EVERY PLAN CONSULTS `dispositionFor` PER CALL, never a cached tier: in Copiloto (deploy:ask) or Chat
// NOTHING here runs beyond what the matrix allows TODAY. That is an acceptance criterion, not a hope — the
// planners take the policy as an argument precisely so a test can drive all three tiers through them.
//
// ── WHY THE STEWARD DOES NOT SPAWN AGENT SESSIONS (and why "just let it" is a security REGRESSION) ────────
//
// Someone reading D9 ("AgileHarness is the fleet's spawner/arbiter") next to this module will eventually
// notice that the steward cannot call `claude_new`, decide that is an oversight, and 'fix' it by adding
// `run-free` to the `orch` token's classes — or by carving out "just for the steward". THAT IS THE HOLE THIS
// PROJECT ALREADY AUDITED AND CLOSED. Do not reopen it. If you believe you need it, STOP and ask the operator.
//
// The facts, as the code states them today:
//   • `claude_new` is `run-free` (mcp/register.ts) — the class register.ts describes as "UMA chamada =
//     execução arbitrária ⇒ contornaria todos os outros cadeados deste arquivo. NUNCA auto, NUNCA montada
//     abaixo de `full`. É a fronteira."
//   • `run-free` ∈ `NEVER_AUTO_RISK_CLASSES` (types.ts), so `dispositionFor` CLAMPS it to `ask` in EVERY tier
//     — Autônomo included — even if a hand-edited board.yaml says `auto`.
//   • `LEVEL_CLASSES.orch` (register.ts) deliberately omits `run-free`, so the tick's scoped token never even
//     MOUNTS the tool. Widening that table is not a convenience: it hands one MCP call full Bash, which
//     renders the risk matrix, the gates, the approvals, the rate limit and the audit ledger decorative.
//   • register.ts's own doctrine (see `claude_recycle`): a NARROW SIGNATURE does not downgrade the class —
//     "a fronteira deste arquivo é o que a chamada EXECUTA, não quão estreito é o argumento". So "but the
//     steward would only spawn a resolver" does not make it safe either.
//
// And the steward does not NEED it, because the one spawn WS-8 causes goes through a different door:
//   • The `harness-resolve` judge is spawned by the TRAIN's conflict disposition — INFRA, always-on, the same door
//     the RedriveHandler has always used (WS-10 invariant 6 records the precedent explicitly: the redrive
//     ALREADY spawns an LLM with no Jido involved). Infra spawning on its own schedule and an AGENT
//     spawning through a tool it holds are different threat models: the first has no prompt surface an LLM can
//     steer. {@link ParkedConflictPlan}'s `retry` is how this module reaches that door — it hands the entry
//     back and the train decides. The steward never names a model, a prompt or a session.
//   • DISPATCHING an agent session stays the HUMAN's (D9: "o humano orquestra POR INTENÇÃO"). The copiloto
//     SUGGESTS (`suggest_work`, read-only); the human dispatches. WS-8 is stewardship of INTEGRATION, not
//     populating the fleet — nothing in the three playbooks needs a new session to exist.
//
// PURE (the planners) + DI (the executor), like release.ts / convergence.ts / semantic-resolution.ts: every
// decision is unit-testable with no git, no disk and no LLM. {@link runStewardPass} NEVER throws — a steward
// that crashes the tick would be strictly worse than a steward that does nothing.

import type { BoardConfig, Card, OrchestratorPolicy, RiskClass } from "@/lib/storymap/types";
import { moveRiskClass } from "@/lib/storymap/entry-effect";
import { evaluateGate, gateForStatus } from "@/lib/storymap/gates";
import { mayActAutonomously } from "@/lib/storymap/runner/orchestrator-policy";
import { isJudgeableFile } from "@/lib/storymap/runner/semantic-resolution";
import type { CardClaim } from "@/lib/storymap/runner/claims";
import type { DeltaLandedResult } from "@/lib/storymap/runner/convergence";
import type { DeployRecoveryMeasurement } from "@/lib/storymap/runner/deploy-recovery";
import type { RearmProof } from "@/lib/storymap/runner/noop-rearm";

/**
 * Invariant 5 — ONE steward re-try per parked entry. The train's own disposition already carries two
 * independent loop-guards (`driveCount` for the redrive, `semanticAttempts` for the judge); this is the
 * steward's, and it answers a different question: "have I ALREADY handed this entry back to the train?".
 * A second hand-back over the same unchanged text buys nothing — the train would reach the same conflict,
 * spend the same rungs and park again. A genuine retry arrives as a NEW entry (a new base = a new fact),
 * which starts at 0. Deliberately not configurable, for the same reason SEMANTIC_ATTEMPT_CAP isn't.
 */
export const STEWARD_RETRY_CAP = 1;

/**
 * How close to expiry a live claim gets the courtesy ping (8.2). Long enough that a working session can
 * actually renew before it lapses, short enough not to nag a session that just started. The ping is CHEAP
 * (a tmux send-keys) and its whole value is avoiding a claim fight — so erring long costs nothing.
 */
export const CLAIM_NOTICE_WINDOW_MS = 5 * 60_000;

// ── 8.1 — a conflict parked on the train ─────────────────────────────────────────────────────────────────

/**
 * WHAT diverged. Deterministic, path-based, and DELIBERATELY reusing {@link isJudgeableFile} — the same
 * `storymap/boards/**` boundary the split train (ADR-057) and the semantic ladder (WS-10 invariant 5) route
 * by. A second, cleverer classifier here would be a third ruler for one question, which is exactly how the
 * canary bug (story-b3es7k) was born.
 */
export type ConflictScope =
  /** cards/sidecars only — WS-2's element-level 3-way owns this, deterministically. NEVER the judge. */
  | "board-data"
  /** arbitrary code text — the WS-10 ladder's business. */
  | "code"
  /** both halves at once — nobody's to split, so nobody's to auto-resolve. */
  | "mixed"
  /** nothing measured. Proves nothing (the asymmetry contract), so it authorizes nothing. */
  | "empty";

/** PURE. See {@link ConflictScope}. */
export function classifyConflictScope(files: readonly string[]): ConflictScope {
  const real = files.filter((f) => f.trim());
  if (real.length === 0) return "empty";
  const code = real.filter((f) => isJudgeableFile(f));
  if (code.length === real.length) return "code";
  if (code.length === 0) return "board-data";
  return "mixed";
}

/**
 * The DIVERGENT paths of a parked entry, read out of the git output the train already recorded on it
 * (`conflictDetail`). PURE.
 *
 * Why parse stderr instead of measuring the tree: the classification must describe THE CONFLICT, and the only
 * record of which paths actually collided is the message git printed when they did. Re-deriving it from the
 * entry's own delta (`baseCommit..branch`) would answer a DIFFERENT question — "what does this branch touch?"
 * — and get it wrong in the worst direction: every normal harness-* run touches code AND its card, so every park
 * would classify `mixed` and escalate to the human. That is the duplicated-ruler bug (D15) with an escalation
 * attached.
 *
 * The two forms this train produces:
 *   `CONFLICT (content): Merge conflict in <path>`   — the 3-way merge (stage sync, merge-back)
 *   `error: patch failed: <path>:<line>`             — `git apply` (the split's code half, the release)
 *
 * FAIL-CLOSED (the asymmetry contract): an unrecognized message parses to ZERO files ⇒ {@link classifyConflictScope}
 * answers `empty` ⇒ the steward stands down and the human keeps the entry. A parser that guessed on an
 * unfamiliar message would be a classifier acting on text it does not understand, which is precisely the
 * failure this whole WS exists to avoid.
 */
export function conflictedFilesFromDetail(detail: string | undefined): string[] {
  if (!detail?.trim()) return [];
  const out = new Set<string>();
  for (const line of detail.split("\n")) {
    const merge = /^\s*CONFLICT\s*\([^)]*\):\s*Merge conflict in\s+(.+?)\s*$/.exec(line);
    if (merge?.[1]) {
      out.add(merge[1]);
      continue;
    }
    // `git apply` names the path then a line number; the path itself may contain no colon-digit suffix, so
    // anchoring on the trailing `:<digits>` is what keeps a path like `a/b:c.ts` intact.
    const apply = /^\s*error:\s*patch failed:\s*(.+?):\d+\s*$/.exec(line);
    if (apply?.[1]) out.add(apply[1]);
  }
  return [...out];
}

/** The slice of a train entry a playbook decides on. Structural (no merge-queue import) so the kernel stays
 *  free of the train's module graph — the same discipline convergence.ts uses to travel without the board model. */
export interface StewardEntry {
  runId: string;
  board: string;
  cardId?: string;
  /** `session` entries never reach the steward (D3 — a LIVE session resolves its own conflict). */
  kind?: "run" | "session";
  status: string;
  /** invariant 5 — how many steward re-tries this entry has already spent. */
  stewardAttempts?: number;
  /** WS-10's own counter — a spent semantic attempt means the ladder has ALREADY judged this text. */
  semanticAttempts?: number;
  /** the git output the train recorded when it parked — the source {@link conflictedFilesFromDetail} reads. */
  conflictDetail?: string;
  /** the judge's per-hunk verdicts, when the ladder ran and escalated. Rides the question (invariant 6). */
  resolutionAnalysis?: { detail: string; outcome: string; hunks: Array<{ file: string; hunk: string; verdict: string; rationale: string }> };
}

export type ParkedConflictPlan =
  /** hand the entry BACK to the train (invariant 1): board data re-merges by element, code climbs the ladder. */
  | { action: "retry"; scope: ConflictScope; reason: string }
  /** the human decides — WITH the analysis attached (invariant 6). The steward then goes SILENT. */
  | { action: "escalate"; scope: ConflictScope; reason: string }
  /** the matrix says no, or this is not the steward's to touch. Not a failure — the system working. */
  | { action: "stand-down"; scope: ConflictScope; reason: string };

/**
 * 8.1 — decide what to do with ONE parked entry. PURE.
 *
 * The order of the guards is the argument: the MATRIX first (a Copiloto/Chat board never reaches the
 * playbook at all — acceptance 4), then D3 (a live session owns its conflict and is a better-positioned LLM
 * than any judge), then the loop-guard, and only then the classification. Reading the policy last would let
 * a bug in the classifier act on a board that never authorized the steward.
 */
export function planParkedConflict(input: {
  entry: StewardEntry;
  /** the divergent paths, as the train recorded them. */
  files: readonly string[];
  policy: OrchestratorPolicy | null | undefined;
}): ParkedConflictPlan {
  const scope = classifyConflictScope(input.files);
  const { entry } = input;

  // The matrix, per call — never a cached tier. `merge-resolve` is the EXISTING class for unparking the
  // train (auto in both active tiers, `ask` by default). Chat (mode off) fails `mayActAutonomously`
  // outright, so one check covers both halves of acceptance 4.
  if (!mayActAutonomously(input.policy, "merge-resolve")) {
    return { action: "stand-down", scope, reason: "a matriz não autoriza `merge-resolve` sozinho neste board — o conflito fica com o humano" };
  }
  // D3 — a LIVE session resolves its own conflict (`worktree_refresh` costs seconds and it has the context).
  // A session entry never parks anyway; this is the invariant's teeth, not a live path.
  if (entry.kind === "session") {
    return { action: "stand-down", scope, reason: "conflito de sessão VIVA — ela resolve o próprio conflito (D3), o steward não intervém" };
  }
  if (scope === "empty") {
    return { action: "stand-down", scope, reason: "nenhum arquivo divergente registrado — nada medido não prova nada" };
  }
  // Invariant 5 — already handed back once. The train reached this same text with the same base and parked;
  // asking it again is the loop, not the retry.
  if ((entry.stewardAttempts ?? 0) >= STEWARD_RETRY_CAP) {
    return {
      action: "escalate",
      scope,
      reason: `já devolvi esta entry ao train ${entry.stewardAttempts}× e ela parqueou de novo — só re-tento com base nova (mudança de FATO)`,
    };
  }
  // "Misto" is not the steward's to split: half of it is WS-2's deterministic merge and half is the judge's
  // text, and resolving either half alone leaves a tree nobody validated. Tudo-ou-nada, like WS-10 invariant 2.
  if (scope === "mixed") {
    return { action: "escalate", scope, reason: "conflito MISTO (board-data + código) — nenhuma das duas metades resolve sozinha; decisão humana" };
  }
  if (scope === "board-data") {
    // The overwhelming majority of these parks are the OLD field-level merge bug (colisão #2): the whole
    // `findings` array of one side winning and reverting what it never touched. Post-WS-2 the re-try merges
    // by element and the conflict dies by construction. Board data NEVER goes to the judge (WS-10 inv. 5).
    return { action: "retry", scope, reason: "conflito só de board-data — o 3-way por ELEMENTO (WS-2) resolve por construção; devolvendo ao train" };
  }
  // Code. The ladder has ALREADY judged this text if the counter is spent — re-parking it would only buy a
  // second judgement of the same unchanged text, which WS-10 invariant 3 forbids.
  if ((entry.semanticAttempts ?? 0) > 0) {
    return {
      action: "escalate",
      scope,
      reason: "a escada semântica já julgou este texto e escalou — um 2º julgamento do mesmo texto é loop (WS-10 inv. 3)",
    };
  }
  return { action: "retry", scope, reason: "conflito de CÓDIGO — devolvendo ao train para subir a escada (degrau 0 convergência → 1 whitespace → 2 juiz)" };
}

/**
 * The escalation's text, carrying the analysis (invariant 6). This is the deliverable of the whole WS: the
 * operator opens Inbox and reads "hunk X é substantivo PORQUE …", not a `git merge` stderr. Capped by the
 * analysis itself (semantic-resolution.ts already applies MAX_ANALYSIS_HUNKS × HUNK_TEXT_CAP). PURE.
 */
export function conflictQuestionText(entry: StewardEntry, plan: ParkedConflictPlan): string {
  const head = `A integração de \`${entry.runId}\` está parqueada no train e eu não posso resolvê-la sozinho: ${plan.reason}.`;
  const analysis = entry.resolutionAnalysis;
  if (!analysis) return `${head}\n\nComo quer seguir? (resolver à mão e marcar como integrada, ou abortar e preservar o branch)`;
  const hunks = analysis.hunks
    .map((h) => `- \`${h.file}\` — **${h.verdict}**: ${h.rationale}`)
    .join("\n");
  return [
    head,
    "",
    `Análise do juiz semântico (${analysis.outcome}): ${analysis.detail}`,
    hunks ? `\n${hunks}` : "",
    "",
    "Decida por hunk: integro do seu jeito, ou aborto preservando o branch? (o branch NUNCA é descartado)",
  ].join("\n");
}

// ── 8.2 — claims and orphan sessions ─────────────────────────────────────────────────────────────────────

export type OrphanClaimPlan =
  /** convergence PROVED the work is in the target ⇒ close the cycle (build evidence / GC harvest). */
  | { action: "close-cycle"; reason: string; proof: RearmProof }
  /** the work is NOT in the target and the branch is preserved ⇒ offer a MECHANICAL redrive (8.1.3's profile). */
  | { action: "offer-redrive"; reason: string }
  /** anything else — including every `unknown`/`partial` verdict. The human decides; the branch stays. */
  | { action: "escalate"; reason: string }
  | { action: "stand-down"; reason: string };

/**
 * 8.2 — a claim released as `session-died`: the card is free AND its holder is never coming back. That is the
 * steward's highest-signal input, and the one the qb8z2c incident kept getting wrong — four re-implementations
 * of a fix that was sitting on a preserved branch nobody asked about.
 *
 * The asymmetry from convergence.ts is honored VERBATIM: only `landed` (positive proof, by CONTENT) closes a
 * cycle. `partial`/`unknown`/`absent` never authorize an advance — they route to work (a redrive) or to the
 * human, and NEVER to discarding anything. PURE.
 */
export function planOrphanClaim(input: {
  claim: CardClaim;
  /** the convergence verdict for the card's expected delta. Absent ⇒ nothing to measure (no recorded delta). */
  landed: DeltaLandedResult | null;
  policy: OrchestratorPolicy | null | undefined;
}): OrphanClaimPlan {
  const { claim } = input;
  if (claim.released !== "session-died") {
    return { action: "stand-down", reason: `claim liberado como \`${claim.released ?? "vivo"}\` — só uma sessão MORTA vira trabalho do steward` };
  }
  if (input.landed?.verdict === "landed") {
    // Closing the cycle is board data (stamping evidence / letting the card advance) — `write-board`.
    if (!mayActAutonomously(input.policy, "write-board")) {
      return { action: "escalate", reason: "a matriz não autoriza `write-board` sozinho — o ciclo fecha com o humano" };
    }
    return {
      action: "close-cycle",
      reason: `a sessão morreu mas o trabalho ATERRISSOU: ${input.landed.detail} — fechando o ciclo (evidência/GC), zero re-implementação`,
      // The same proof re-arms the item's anti-noop streak (WS-12.3): the fact that blocked it demonstrably changed.
      proof: { kind: "delta-landed", detail: input.landed.detail },
    };
  }
  // Not landed. NEVER discard the branch (invariant 4) — offer to re-drive over it. A redrive spawns a skill:
  // the `run` class.
  if (!mayActAutonomously(input.policy, "run")) {
    return { action: "escalate", reason: "a sessão morreu com trabalho não aterrissado e a matriz não autoriza `run` sozinho — o branch fica preservado, a decisão é sua" };
  }
  return {
    action: "offer-redrive",
    reason: `sessão morta, trabalho NÃO aterrissado (${input.landed?.detail ?? "sem delta registrado p/ medir"}) — redrive MECÂNICO sobre o branch preservado (nunca re-implementar do zero)`,
  };
}

export type ClaimNoticePlan =
  | { action: "notify"; reason: string; text: string }
  | { action: "stand-down"; reason: string };

/** Reduce an id to the slug charset the board/card ids actually use, bounded. Anything else is DROPPED (not
 *  escaped): the ping's slots are for naming a card, and a value that is not id-shaped has nothing to say
 *  there. PURE. */
function slug(id: string): string {
  return (id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "?";
}

/**
 * 8.2 — the courtesy ping. A LIVE session whose reservation is about to lapse gets told BEFORE the sweep
 * frees the card, so it can renew or hand it back. Pure courtesy — a claim is anti-waste state, never a lock
 * (claims.ts's header is emphatic about it), so this NEVER blocks and NEVER releases: it just avoids two
 * agents discovering they both own a card by colliding in the train. PURE.
 */
export function planExpiringClaimNotice(input: {
  claim: CardClaim;
  /** the fleet probe's answer. A DEAD actor gets no ping (nobody is reading it) — its claim is 8.2's other half. */
  actorAlive: boolean;
  now: number;
  windowMs?: number;
}): ClaimNoticePlan {
  const { claim } = input;
  if (claim.released) return { action: "stand-down", reason: "claim já liberado — não há a quem avisar" };
  if (!input.actorAlive) return { action: "stand-down", reason: "o dono do claim está MORTO — o aviso iria para ninguém (vira o playbook de sessão órfã)" };
  const expiresAt = Date.parse(claim.expiresAt);
  if (!Number.isFinite(expiresAt)) return { action: "stand-down", reason: "expiresAt ilegível — nada a prever" };
  const left = expiresAt - input.now;
  const window = input.windowMs ?? CLAIM_NOTICE_WINDOW_MS;
  if (left <= 0 || left > window) {
    return { action: "stand-down", reason: left <= 0 ? "claim já expirou — o sweep o libera" : "ainda longe do vencimento" };
  }
  const mins = Math.max(1, Math.round(left / 60_000));
  // The text is TYPED INTO A PANE (steward-deps.ts `notifyActor`), so its only two variables are bounded here
  // rather than trusted: `board`/`cardId` are free-form strings in the claim schema, and this is the one place
  // that decides what they may contribute. Slug-only + capped ⇒ the message stays a fixed template with two
  // inert slots. Nothing here is a channel a caller can steer — see notifyActor's header for why that is the
  // property (not the syscall) that separates this from `claude_send`.
  const where = `${slug(claim.board)}/${slug(claim.cardId)}`;
  return {
    action: "notify",
    reason: `claim de ${where} vence em ~${mins}min e a sessão está viva`,
    text: `[storymap] seu claim de ${where} expira em ~${mins}min — renove (heartbeat) ou libere. Depois disso o card volta para a fila e outro agente pode pegá-lo.`,
  };
}

/** 8.2 (adendo, consumes WS-12.3) — may the steward re-arm this item's backoff? The proof is the whole gate:
 *  `rearmAllowed` in noop-rearm.ts owns the rule ("no proof ⇒ the item stays with the human"); this only adds
 *  the MATRIX check, because re-arming means "the tick will try to ACT on this again". PURE. */
export function planNoopRearm(input: {
  itemId: string;
  proof: RearmProof | undefined;
  policy: OrchestratorPolicy | null | undefined;
}): { action: "rearm"; proof: RearmProof; reason: string } | { action: "stand-down"; reason: string } {
  if (!input.proof?.detail.trim()) {
    return { action: "stand-down", reason: "sem PROVA de que o fato mudou — o item continua com o humano (dúvida ⇒ não re-arma)" };
  }
  if (!mayActAutonomously(input.policy, "run")) {
    return { action: "stand-down", reason: "a matriz não autoriza `run` sozinho — re-arme pelo Inbox" };
  }
  return { action: "rearm", proof: input.proof, reason: `o fato que bloqueava \`${input.itemId}\` mudou: ${input.proof.detail}` };
}

// ── 8.4 — an item stuck in backoff whose DEPLOY FACT recovered ───────────────────────────────────────────

export type DeployRecoveryPlan =
  /** the fact TRANSITIONED (false → true) ⇒ ask 8.2's gate (`planNoopRearm`) to authorize the re-arm. */
  | { action: "rearm"; proof: RearmProof; reason: string }
  /** first sighting of this item's fact ⇒ WRITE the baseline and do nothing else. Never re-arms. */
  | { action: "observe"; deployProven: boolean; reason: string }
  | { action: "stand-down"; reason: string };

/**
 * 8.4 — may the steward re-arm THIS item because the deploy fact of its card recovered? PURE.
 *
 * This is the producer that `RearmProof.kind: "deploy-recovered"` never had. Its consequence was concrete:
 * an item that fell into the per-item anti-noop backoff had exactly two exits — its own progress (which the
 * backoff forbids) and a human click. An EXTERNAL change of fact freed nothing, so a card whose deploy was
 * fixed by someone else's release stayed frozen with everything it needed.
 *
 * THE EDGE, NOT THE LEVEL — the guard order is the whole argument:
 *   1. no card ⇒ a board-level item has no deploy fact to measure;
 *   2. no measurement ⇒ doubt is not evidence (fail-closed, the same asymmetry as convergence.ts);
 *   3. the cap ⇒ ONE machine re-arm per item per doctrine version, so an oscillating fact costs one spawn;
 *   4. no baseline ⇒ OBSERVE. The first reading can only be written, never acted on: `measured === true`
 *      with nothing to compare against is a LEVEL, and the level was already true at the give-ups that
 *      motivated this. This guard is what stops "every card on the board re-arms on deploy day";
 *   5. baseline already `true` ⇒ nothing transitioned — the tick gave up for some OTHER reason, and this
 *      producer has nothing to say about it;
 *   6. still not proven ⇒ the retry would fail the same way;
 *   7. `false → true` ⇒ re-arm.
 *
 * The RISK MATRIX is deliberately NOT checked here: {@link planNoopRearm} is the gate (it owns
 * `mayActAutonomously(policy, "run")`), and the caller composes the two. One predicate, one responsibility —
 * a second copy of the matrix rule is the duplicated ruler that D15 warns about.
 */
export function planDeployRecoveredRearm(input: {
  itemId: string;
  cardId: string;
  /** the fact as it was when the tick gave up. `null` = never observed. */
  observedDeployProven: boolean | null;
  /** this item already spent its machine re-arm under the doctrine in force. */
  stewardRearmed: boolean;
  measured: DeployRecoveryMeasurement | null;
}): DeployRecoveryPlan {
  if (!input.cardId) {
    return { action: "stand-down", reason: "item sem card (item de board) — não há fato de deploy a medir" };
  }
  if (input.measured === null) {
    return { action: "stand-down", reason: "não consegui MEDIR o fato de deploy deste card — dúvida não é evidência, o item continua com o humano" };
  }
  if (input.stewardRearmed) {
    return { action: "stand-down", reason: "já gastei o re-arm de máquina deste item sob a doutrina em vigor — o teto não se enfraquece, ele é re-emitido quando a doutrina muda" };
  }
  if (input.observedDeployProven === null) {
    return {
      action: "observe",
      deployProven: input.measured.deployProven,
      reason: `primeira observação deste item (deploy provado: ${input.measured.deployProven}) — gravo a baseline; a primeira leitura NUNCA re-arma`,
    };
  }
  if (input.observedDeployProven === true) {
    return { action: "stand-down", reason: "o deploy JÁ estava provado quando desisti — isto é NÍVEL, não borda; re-armar aqui é o loop" };
  }
  if (!input.measured.deployProven) {
    return { action: "stand-down", reason: `o deploy deste card continua NÃO provado: ${input.measured.detail}` };
  }
  return {
    action: "rearm",
    proof: { kind: "deploy-recovered", detail: input.measured.detail },
    reason: `o deploy deste card era NÃO provado quando desisti e agora está provado: ${input.measured.detail}`,
  };
}

// ── 8.3 — a card stuck on a gate it already satisfies ────────────────────────────────────────────────────

export type GateSatisfiedPlan =
  | { action: "move"; to: string; riskClass: RiskClass; reason: string }
  | { action: "stand-down"; reason: string };

/**
 * 8.3 — the "the technical gate is already satisfied but nobody re-evaluated it" case: build evidence stamped
 * AFTER the card got stuck, a blocker closed by hand, QA that went green on a later run. The CASCADE only
 * reacts to EVENTS, so a fact that changed with no event to carry it leaves the card frozen with everything
 * it needs. This is the LEGITIMATE advance "outside the pipeline": outside the cascade, never outside the gate.
 *
 * The gate is not re-implemented here — {@link evaluateGate} (gate-core, the same isomorphic source the
 * pre-write hook and `move_card` run) is the ONLY judge, and its verdict is an INPUT. A `null` verdict means
 * it passes; anything else and the steward stands down. The move itself still goes through `move_card`, which
 * validates the gate AGAIN — so a bug here cannot bypass one, it can only waste a call.
 *
 * The RISK CLASS is the target column's DYNAMIC one ({@link moveRiskClass}): a column with an `onEnter`
 * (promote-stage/deploy-board) resolves `deploy`, an autorun column resolves `run`, a manual one
 * `write-board`. THIS is what makes acceptance 4 real: in Copiloto (deploy:ask) the steward will happily move
 * a card into a manual column and REFUSE to move the same card into the release column — the exact bit that
 * separates the two active tiers. PURE.
 */
export function planGateSatisfied(input: {
  card: Card;
  /** the status the card is stuck in. */
  from: string;
  /** the status it would advance to. */
  to: string;
  config: BoardConfig;
  policy: OrchestratorPolicy | null | undefined;
  /** WS-4: another actor holds this card ⇒ not the steward's to move (it would collide with live work). */
  claimedByOther: boolean;
}): GateSatisfiedPlan {
  if (input.claimedByOther) {
    return { action: "stand-down", reason: "outro ator tem o claim deste card — o steward não mexe em trabalho vivo alheio" };
  }
  if (input.from === input.to) return { action: "stand-down", reason: "sem coluna seguinte a avaliar" };
  // The gate is the point: a target column with NO gate is not this playbook's business at all. Moving a card
  // just because it CAN move is the cascade's job (and it is deliberately event-driven); the steward only
  // unblocks a card that is stuck DESPITE having satisfied a real gate.
  if (!gateForStatus(input.config, input.to)) {
    return { action: "stand-down", reason: "a coluna-alvo não tem gate — avançar por avançar é da cascata, não do steward" };
  }
  const verdict = evaluateGate(input.card, input.to, input.config);
  if (verdict) {
    return { action: "stand-down", reason: `o gate \`${verdict.gate}\` NÃO passa: ${verdict.message}` };
  }
  const riskClass = moveRiskClass(input.config, input.to, input.from);
  if (!mayActAutonomously(input.policy, riskClass)) {
    return {
      action: "stand-down",
      reason: `o gate passa, mas mover para \`${input.to}\` resolve como \`${riskClass}\` e a matriz não o autoriza sozinho — parei e deixei com você`,
    };
  }
  return { action: "move", to: input.to, riskClass, reason: `o gate da coluna \`${input.to}\` já está factualmente satisfeito e ninguém re-avaliou — movendo pelo move_card (o gate roda de novo)` };
}

// ── The executor ─────────────────────────────────────────────────────────────────────────────────────────

/** One card the tick offers to 8.3: where it is, where it would go, and the board config that judges it. */
export interface GateCandidate {
  card: Card;
  from: string;
  to: string;
}

/** What ONE steward pass did — the return value tests assert on and the diary summarizes. Counting the
 *  stand-downs too is deliberate: "the steward looked and correctly did nothing" and "the steward never ran"
 *  are different facts, and collapsing them is how the copiloto's silence became indistinguishable from a
 *  defect (colisão #7). */
export interface StewardReport {
  retried: string[];
  escalated: string[];
  moved: string[];
  notified: string[];
  cyclesClosed: string[];
  redrivesOffered: string[];
  rearmed: string[];
  standDowns: number;
  errors: string[];
}

/** The ports ONE pass needs. All injected — this module does no IO of its own, so every playbook is testable
 *  against fakes with no git, no tmux, no disk and no LLM. */
export interface StewardPorts {
  board: string;
  /** re-read PER PASS (never cached): the matrix is the single source of truth and the guard re-reads it too. */
  policy: () => Promise<OrchestratorPolicy | null>;
  config: () => Promise<BoardConfig>;
  now?: () => number;

  // 8.1
  parkedEntries: () => Promise<StewardEntry[]>;
  /** the divergent paths of a parked entry, as the train recorded them. */
  conflictFiles: (entry: StewardEntry) => Promise<string[]>;
  /** hand the entry BACK to the train (invariant 1). The train re-runs ITS disposition; we never merge. */
  retryEntry: (entry: StewardEntry) => Promise<{ ok: boolean; detail: string }>;

  // 8.2
  releasedClaims: () => Promise<CardClaim[]>;
  liveClaims: () => Promise<CardClaim[]>;
  actorAlive: (actor: string) => Promise<boolean>;
  notifyActor: (actor: string, text: string) => Promise<boolean>;
  deltaLandedForCard: (cardId: string) => Promise<DeltaLandedResult | null>;
  /** WS-12.3 — the items in per-item backoff for a card, so a PROVEN change of fact re-arms them. */
  backoffItemsFor: (cardId: string) => Promise<string[]>;
  /** Returns the DECISION. It used to return void, so a REJECTED re-arm (no proof / unreadable state) still
   *  landed in `report.rearmed` — the copiloto reporting work it had not done. */
  rearm: (itemId: string, proof: RearmProof) => Promise<{ ok: boolean; error?: string }>;

  // 8.4 — the deploy fact of items stuck in backoff.
  /** EVERY item of this board in per-item backoff, with its card and the item's own memory. Board-wide on
   *  purpose: the set is defined by the durable state, not by walking cards (and never by `gateCandidates`,
   *  which answers a different question and would couple two playbooks through one port). */
  backoffItems: () => Promise<
    Array<{
      itemId: string;
      /** empty for a board-level item — the kernel stands down on it. */
      cardId: string;
      observedDeployProven: boolean | null;
      stewardRearmed: boolean;
    }>
  >;
  /** Measure this card's deploy fact NOW. `null` = did not measure (fail-closed — never coerced to false). */
  deployRecoveryFor: (cardId: string) => Promise<DeployRecoveryMeasurement | null>;
  /** Persist the baseline for an item that had none. Observes only — it must NOT re-arm. */
  recordObservedFact: (itemId: string, deployProven: boolean) => Promise<void>;

  // 8.3
  gateCandidates: () => Promise<GateCandidate[]>;
  claimedCardIds: () => Promise<Set<string>>;
  moveCard: (cardId: string, to: string) => Promise<{ ok: boolean; error?: string }>;

  // shared
  askQuestion: (cardId: string, text: string) => Promise<void>;
  diary: (entry: { kind: "acted" | "asked" | "stood-down" | "error"; text: string; detail?: string }) => Promise<void>;
}

const empty = (): StewardReport => ({
  retried: [], escalated: [], moved: [], notified: [], cyclesClosed: [], redrivesOffered: [], rearmed: [], standDowns: 0, errors: [],
});

/**
 * Run ONE steward pass over a board: the three playbooks, in cost order (a parked train blocks everything
 * behind it; an orphan claim wastes a card; a stuck card wastes a day). $0 — no LLM is spawned here; the
 * expensive rungs live inside the TRAIN's own disposition, which the retry re-enters.
 *
 * NEVER throws (invariant: a steward that breaks the tick is worse than no steward) and each playbook is
 * independently guarded, so one broken port can't silence the other two.
 */
/**
 * SÓ o playbook 8.4 (recuperação por borda do fato de deploy), para o caminho em que o tick decide
 * `skipped-no-work`.
 *
 * POR QUE ISTO EXISTE — o deadlock que o passe completo não podia resolver: `runStewardPass` roda DEPOIS do
 * `hasWork` (orchestrator-tick), e isso é deliberado — os playbooks 8.1/8.2/8.3 AGEM (8.3 chega a mover card),
 * e agir num board que os gates disseram não merecer atenção seria "um segundo tick sem budget". Mas quando
 * TODOS os itens caem no backoff anti-noop, `hasWork` é false para sempre ⇒ o passe nunca roda ⇒ o único
 * mecanismo capaz de destravá-los nunca é alcançado. A recuperação ficava atrás exatamente da condição que
 * ela existe para recuperar (medido em 2026-07-18: acme parado em `skipped-no-work` por horas, com o fato de
 * mundo já mudado e ninguém para observá-lo).
 *
 * O comentário do tick aponta a saída certa ao dizer que alcançar item abandonado "o WS-12 resolve na régua
 * certa": esta função É essa régua. Ela NÃO fura os gates dos outros playbooks — 8.1/8.2/8.3 seguem exigindo
 * `hasWork`. O que ela faz é $0, não spawna, e só age sob PROVA (borda observada→medida, com teto por item e
 * a matriz consultada em `planNoopRearm`). Sem prova, o item continua com o humano, como antes.
 */
export async function runDeployRecoveryPass(ports: StewardPorts): Promise<StewardReport> {
  const report = empty();
  const policy = await ports.policy().catch(() => null);
  await backoffRecoveryPlaybook(ports, policy, report).catch((e) => report.errors.push(`8.4: ${msg(e)}`));
  return report;
}

export async function runStewardPass(ports: StewardPorts): Promise<StewardReport> {
  const report = empty();
  const policy = await ports.policy().catch(() => null);
  const now = ports.now ?? Date.now;

  await parkedConflictPlaybook(ports, policy, report).catch((e) => report.errors.push(`8.1: ${msg(e)}`));
  await claimsPlaybook(ports, policy, report, now()).catch((e) => report.errors.push(`8.2: ${msg(e)}`));
  // 8.4 runs AFTER 8.2 (which already re-arms on its own `close-cycle` branch — 8.4 skips whatever it
  // touched, so one item is never written twice in a pass) and BEFORE 8.3 (a move by 8.3 turns the item into
  // residue, and re-arming residue writes state the next bump prunes). Never before 8.1: the order is cost,
  // and an item in backoff is the least urgent thing on the board — it is already with the human.
  await backoffRecoveryPlaybook(ports, policy, report).catch((e) => report.errors.push(`8.4: ${msg(e)}`));
  await gatePlaybook(ports, policy, report).catch((e) => report.errors.push(`8.3: ${msg(e)}`));

  return report;
}

function msg(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 200);
}

/** 8.1 — every parked entry: classify, hand back to the train, or escalate WITH the analysis then go silent. */
async function parkedConflictPlaybook(ports: StewardPorts, policy: OrchestratorPolicy | null, report: StewardReport): Promise<void> {
  for (const entry of await ports.parkedEntries()) {
    const files = await ports.conflictFiles(entry).catch(() => [] as string[]);
    const plan = planParkedConflict({ entry, files, policy });
    if (plan.action === "stand-down") {
      report.standDowns += 1;
      continue;
    }
    if (plan.action === "retry") {
      const r = await ports.retryEntry(entry).catch((e) => ({ ok: false, detail: msg(e) }));
      if (!r.ok) {
        report.errors.push(`retry ${entry.runId}: ${r.detail}`);
        continue;
      }
      report.retried.push(entry.runId);
      await ports.diary({
        kind: "acted",
        text: `Devolvi a integração de \`${entry.runId}\` ao train: ${plan.reason}.`,
        detail: `${plan.scope} · ${r.detail}`,
      }).catch(() => {});
      continue;
    }
    // Escalate — the analysis rides the question (invariant 6), and then we are SILENT: no re-try without a
    // new fact. A card-less entry (D2) has no card to carry a question; its `resolutionAnalysis` already
    // rides the parked entry on the cockpit, so the diary is the honest surface rather than inventing a card.
    report.escalated.push(entry.runId);
    if (entry.cardId) {
      await ports.askQuestion(entry.cardId, conflictQuestionText(entry, plan)).catch((e) => report.errors.push(`ask ${entry.runId}: ${msg(e)}`));
    }
    await ports.diary({
      kind: "asked",
      text: `Parei em \`${entry.runId}\`: ${plan.reason}. ${entry.cardId ? "Perguntei no Inbox com a análise por hunk." : "A análise está no item parqueado."}`,
      detail: entry.resolutionAnalysis?.detail,
    }).catch(() => {});
  }
}

/** 8.2 — dead sessions (converge / offer a redrive, NEVER discard) + the courtesy ping before a lapse. */
async function claimsPlaybook(ports: StewardPorts, policy: OrchestratorPolicy | null, report: StewardReport, now: number): Promise<void> {
  for (const claim of await ports.releasedClaims()) {
    if (claim.released !== "session-died" || !claim.cardId) continue;
    const landed = await ports.deltaLandedForCard(claim.cardId).catch(() => null);
    const plan = planOrphanClaim({ claim, landed, policy });
    if (plan.action === "stand-down") {
      report.standDowns += 1;
      continue;
    }
    if (plan.action === "close-cycle") {
      report.cyclesClosed.push(claim.cardId);
      await ports.diary({ kind: "acted", text: `A sessão de \`${claim.cardId}\` morreu, mas o trabalho já aterrissou — fechei o ciclo.`, detail: plan.reason }).catch(() => {});
      // The SAME proof re-arms whatever the dead session's failures put into backoff (WS-12.3): the blocking
      // fact demonstrably changed, and leaving the item in backoff would strand a card whose work is DONE.
      for (const itemId of await ports.backoffItemsFor(claim.cardId).catch(() => [])) {
        const rearm = planNoopRearm({ itemId, proof: plan.proof, policy });
        if (rearm.action !== "rearm") {
          report.standDowns += 1;
          continue;
        }
        const r = await ports.rearm(itemId, rearm.proof).catch((e) => ({ ok: false, error: msg(e) }));
        if (!r.ok) {
          report.errors.push(`rearm ${itemId}: ${r.error ?? "recusado"}`);
          continue;
        }
        report.rearmed.push(itemId);
      }
      continue;
    }
    if (plan.action === "offer-redrive") {
      report.redrivesOffered.push(claim.cardId);
      await ports.diary({ kind: "acted", text: `Sessão morta em \`${claim.cardId}\` com trabalho preservado — proponho um redrive mecânico sobre o branch.`, detail: plan.reason }).catch(() => {});
      continue;
    }
    report.escalated.push(claim.cardId);
    await ports.askQuestion(claim.cardId, `A sessão que segurava este card MORREU e ${plan.reason}. O branch está PRESERVADO (nunca descarto trabalho). Redrive mecânico sobre ele, ou você assume?`).catch(() => {});
    await ports.diary({ kind: "asked", text: `Sessão morta em \`${claim.cardId}\` — perguntei como seguir.`, detail: plan.reason }).catch(() => {});
  }

  for (const claim of await ports.liveClaims()) {
    const alive = await ports.actorAlive(claim.actor).catch(() => false);
    const plan = planExpiringClaimNotice({ claim, actorAlive: alive, now });
    if (plan.action !== "notify") {
      report.standDowns += 1;
      continue;
    }
    const sent = await ports.notifyActor(claim.actor, plan.text).catch(() => false);
    if (!sent) continue; // a ping nobody received is not an event worth reporting — it is courtesy, not a gate
    report.notified.push(claim.actor);
    await ports.diary({ kind: "acted", text: `Avisei ${claim.actor}: ${plan.reason}.` }).catch(() => {});
  }
}

/**
 * 8.4 — items stranded in the anti-noop backoff whose card's DEPLOY FACT recovered.
 *
 * It iterates the BACKOFF SET (the durable state's own answer), never the board's cards: the question is
 * "which items did the tick give up on?", and only `noopByItem` knows. Measurement is done ONCE PER CARD and
 * shared by that card's items — the same card-level granularity `bumpNoopByAttempt` already uses, and the
 * reason the cost of this playbook is one measurement per stuck card, not one per stuck item.
 *
 * Accounting follows the siblings: a re-arm reports the ITEM; `observe`/`stand-down` are SILENT stand-downs
 * (a diary line per stand-down would flood Inbox, and the other three playbooks are silent for the same
 * reason). The re-arm's diary line is written by `rearmNoopItem` itself — writing another here would double
 * it.
 */
async function backoffRecoveryPlaybook(ports: StewardPorts, policy: OrchestratorPolicy | null, report: StewardReport): Promise<void> {
  const items = await ports.backoffItems();
  if (items.length === 0) return;
  // Whatever 8.2 already re-armed in THIS pass is done — re-arming it again would write the same item twice
  // and burn its one machine re-arm on a fact 8.2 already proved.
  const alreadyRearmed = new Set(report.rearmed);
  const measuredByCard = new Map<string, DeployRecoveryMeasurement | null>();

  for (const item of items) {
    if (alreadyRearmed.has(item.itemId)) continue;
    let measured: DeployRecoveryMeasurement | null = null;
    if (item.cardId) {
      if (!measuredByCard.has(item.cardId)) {
        measuredByCard.set(item.cardId, await ports.deployRecoveryFor(item.cardId).catch(() => null));
      }
      measured = measuredByCard.get(item.cardId) ?? null;
    }
    const plan = planDeployRecoveredRearm({
      itemId: item.itemId,
      cardId: item.cardId,
      observedDeployProven: item.observedDeployProven,
      stewardRearmed: item.stewardRearmed,
      measured,
    });
    if (plan.action === "stand-down") {
      report.standDowns += 1;
      continue;
    }
    if (plan.action === "observe") {
      // Writing the baseline is not acting on the item — it stays exactly as stuck as it was.
      report.standDowns += 1;
      await ports.recordObservedFact(item.itemId, plan.deployProven).catch((e) => report.errors.push(`observe ${item.itemId}: ${msg(e)}`));
      continue;
    }
    // The MATRIX gate lives in planNoopRearm (8.2's), consulted per call — not duplicated above.
    const gated = planNoopRearm({ itemId: item.itemId, proof: plan.proof, policy });
    if (gated.action !== "rearm") {
      report.standDowns += 1;
      continue;
    }
    const r = await ports.rearm(item.itemId, gated.proof).catch((e) => ({ ok: false, error: msg(e) }));
    if (!r.ok) {
      report.errors.push(`rearm ${item.itemId}: ${r.error ?? "recusado"}`);
      continue;
    }
    report.rearmed.push(item.itemId);
  }
}

/** 8.3 — cards frozen on a gate they already satisfy: move them THROUGH the gate (move_card re-validates). */
async function gatePlaybook(ports: StewardPorts, policy: OrchestratorPolicy | null, report: StewardReport): Promise<void> {
  const candidates = await ports.gateCandidates();
  if (candidates.length === 0) return;
  const [config, claimed] = await Promise.all([ports.config(), ports.claimedCardIds().catch(() => new Set<string>())]);
  for (const c of candidates) {
    const plan = planGateSatisfied({
      card: c.card,
      from: c.from,
      to: c.to,
      config,
      policy,
      claimedByOther: claimed.has(c.card.id),
    });
    if (plan.action === "stand-down") {
      report.standDowns += 1;
      continue;
    }
    const r = await ports.moveCard(c.card.id, plan.to).catch((e) => ({ ok: false, error: msg(e) }));
    if (!r.ok) {
      // The gate said yes and `move_card` said no — that is the gate being the authority, exactly as designed.
      // Report it, never work around it.
      report.errors.push(`move ${c.card.id} → ${plan.to}: ${r.error ?? "recusado"}`);
      continue;
    }
    report.moved.push(c.card.id);
    await ports.diary({ kind: "acted", text: `Movi \`${c.card.id}\` para \`${plan.to}\`: ${plan.reason}.`, detail: `risco ${plan.riskClass}` }).catch(() => {});
  }
}
