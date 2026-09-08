// steward-deps.ts — WS-8 — the IO half of the integration steward: it wires `copilot/steward.ts`'s pure
// playbooks to the real train, the real claim registry, the real board and the real diary. The same split as
// fleet-deps.ts / orchestrator-run.ts: the DECISIONS live in the pure kernel (unit-tested with fakes, no git,
// no tmux, no disk), and this file only knows how to fetch a fact and how to perform an already-decided act.
//
// It exists as its OWN module (rather than inline in orchestrator-run.ts) for the reason fleet-deps.ts does:
// the kernel must stay importable from a test — and from the AgileHarness extraction — without dragging the
// train, the MCP surface and the Next server actions into the graph behind it.

import { findRepoRoot } from "@/lib/storymap/paths";
import { readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import { runDeployRecoveryPass, runStewardPass, type GateCandidate, type StewardEntry, type StewardPorts, type StewardReport, conflictedFilesFromDetail } from "@/lib/storymap/copilot/steward";
import { appendCopilotActivity } from "@/lib/storymap/copilot/activity";
import { getCardClaims } from "./claims";
import { loadRunnerConfig } from "./config";
import { deltaLanded, expectedDeltaOf } from "./convergence";
import { collectActionableCockpit } from "@/lib/storymap/cockpit-collect";
import { getMergeQueue } from "./merge-queue";
import { itemsInNoopBackoff, markObservedFact, readOrchestratorState, writeOrchestratorState } from "./orchestrator-state";
import { rearmNoopItem, type RearmProof } from "./noop-rearm";
import { measureDeployRecovery } from "./deploy-recovery";
import { makeGitContains, readLastDeploySha } from "./deploy-reconcile";
import { resolveCanaryCommand, runFaceCanary } from "./face-probe";
import { defaultExec, type ExecFn } from "./worktree";
import { isSafeSessionName, listClaudeProcesses, listPaneOwners } from "@/lib/vps/tmux";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** The steward's identity in every audit surface (the ledger, the claim registry, the train's log line). ONE
 *  string, because three places must agree on it byte-for-byte — the same lesson as `sessionClaimActor`. */
export const STEWARD_ACTOR = "copilot:steward";

/**
 * The tmux session an ACTOR maps to, or null. Only `session:<agentId>` actors have one: a `run:*` actor is the
 * engine's (its claims are freed on boot) and `copilot:*` is us. The name is validated to the SAME strict slug
 * `isSafeSessionName` enforces everywhere else — an actor string is free-form by design (claims.ts keeps it
 * open so the fleet's namespace can grow), so it is UNTRUSTED input to a process call and must be proven safe
 * here rather than assumed. `-` prefixes are rejected too: an actor named `-X` would become a tmux FLAG.
 */
function sessionOf(actor: string): string | null {
  if (!actor.startsWith("session:")) return null;
  const agentId = actor.slice("session:".length);
  return isSafeSessionName(agentId) ? agentId : null;
}

/**
 * Is the claim's holder a LIVE CLAUDE AGENT — not just a live tmux session?
 *
 * The identity check (`isClaudeProcess` over the pane's own pid, via the same ancestry-walking attribution the
 * /processes page uses) is a CONTAINMENT, not a nicety, and it is what {@link notifyActor} rests on: see that
 * function's header. A pane running a human's ROOT SHELL is NOT a valid ping target, and "has-session says
 * yes" cannot tell the two apart.
 *
 * FAIL-CLOSED: an unreadable tmux/ps answers "no", and a "no" means no ping. The wrong side of this error is
 * free (a session misses a courtesy warning; its claim lapses and the card returns to the queue — the designed
 * behaviour); the other side types into a pane we could not identify.
 */
async function actorAlive(actor: string): Promise<boolean> {
  const session = sessionOf(actor);
  if (!session) return false;
  try {
    const [owners, claudes] = await Promise.all([listPaneOwners(), listClaudeProcesses()]);
    const pids = new Set(owners.filter((o) => o.session === session).map((o) => o.pid));
    if (pids.size === 0) return false;
    return claudes.some((p) => pids.has(p.pid));
  } catch {
    return false;
  }
}

/**
 * Deliver the courtesy ping (8.2) — and the ONE place in WS-8 that touches a tmux pane, so the reasoning for
 * why it is not `run-free` lives here, in full.
 *
 * `claude_send` IS `run-free` (mcp/register.ts: "send-keys em QUALQUER sessão tmux, inclusive um shell humano
 * com permissão total"), and this function performs the same syscall. It is NOT the same capability, and the
 * difference is exactly the one register.ts draws — what the call EXECUTES:
 *
 *   • `claude_send` takes a CALLER-SUPPLIED `text`. An agent holding it types ARBITRARY characters into an
 *     arbitrary pane: one call = arbitrary execution. That is the whole reason for the class.
 *   • This function has NO caller-supplied text on the authorized path. The string is a fixed template built
 *     by `planExpiringClaimNotice` (a PURE function whose only variables are a board id, a card id and a
 *     minute count read from OUR OWN claim registry). There is no channel for the LLM — or anyone else — to
 *     choose what gets typed. The steward cannot express "send this text"; it can only express "warn this
 *     holder", and the words are the code's.
 *
 * The remaining locks, because "the template is safe" must not be the only one:
 *   1. the target is a live claim's holder — never an arbitrary session name;
 *   2. {@link sessionOf} validates it to a strict slug (no injection, no flag-shaped name);
 *   3. {@link actorAlive} proves the pane is running the CLAUDE BINARY, so a human's shell is never a target;
 *   4. `-l --` sends the text literally, through an execFile ARRAY (shell:false) — nothing is ever parsed.
 *
 * If you ever add a `text` parameter to this function, it becomes `claude_send` and this reasoning is void.
 * Don't. Returns false on any failure: a ping is a courtesy, never a gate.
 */
async function notifyActor(actor: string, text: string): Promise<boolean> {
  const session = sessionOf(actor);
  if (!session) return false;
  try {
    await pexec("tmux", ["send-keys", "-t", session, "-l", "--", text], { timeout: 10_000 });
    await pexec("tmux", ["send-keys", "-t", session, "Enter"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The cards 8.3 offers the kernel: every card of the board, paired with the status it would advance to.
 *
 * The "next status" is the board's OWN pipeline order — the same sequence the cascade walks. Deliberately
 * ONLY the immediate next step (never a scan for "the furthest column whose gate passes"): a card that is
 * genuinely N columns behind has N gates to satisfy, and each one's step is where its work happens. Skipping
 * to the end would be exactly the "advance around the pipeline" this playbook is defined against.
 *
 * Terminal/hidden steps are left out by construction (they have no `next`), and the kernel throws away
 * everything whose target column has no gate — so this list is a cheap superset, not a decision.
 */
async function gateCandidates(board: string): Promise<GateCandidate[]> {
  const config = await readBoardConfig(board);
  const order = config.statuses.map((s) => s.id);
  const out: GateCandidate[] = [];
  for (const card of await readCards(board)) {
    const from = card.status;
    if (!from) continue;
    const i = order.indexOf(from);
    if (i < 0 || i + 1 >= order.length) continue;
    const to = order[i + 1];
    out.push({ card, from, to });
  }
  return out;
}

/** Ask the board's own move surface to advance a card — `move_card`'s server-side twin, which validates the
 *  gate AGAIN and fires the onEnter effects. The steward never writes a status by hand: a gate that is
 *  re-validated at the moment of the write is the only one that can't be raced. */
async function moveCard(board: string, cardId: string, to: string): Promise<{ ok: boolean; error?: string }> {
  // Lazy: actions.ts is a "use server" module that pulls the whole board/effects graph. Importing it eagerly
  // would put that graph behind every consumer of the tick (and behind the pure kernel's tests).
  const { moveCardAction } = await import("@/app/actions");
  const r = await moveCardAction({ boardId: board, cardId, status: to });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

async function askQuestion(board: string, cardId: string, text: string): Promise<void> {
  const { askQuestionsAction } = await import("@/app/actions");
  await askQuestionsAction({ boardId: board, cardId, texts: [text], askedBy: STEWARD_ACTOR });
}

/** The card's expected delta (`commitRange`, else `diffSnapshot` — expectedDeltaOf owns the precedence),
 *  measured against `main` by the ONE convergence ruler. `null` when the card records no delta: nothing to
 *  measure proves nothing, and inventing a range is the loose heuristic convergence.ts refuses. */
async function deltaLandedForCard(board: string, cardId: string) {
  const card = await readCard(board, cardId).catch(() => null);
  const range = expectedDeltaOf(card);
  if (!range) return null;
  const repoRoot = findRepoRoot();
  // convergence.ts reads the EXIT CODE to tell "the answer is no" (1) from "the question was malformed" (128),
  // so the exec must let a non-zero exit REJECT with `code`/`stdout` attached — which is exactly what execFile
  // does. Collapsing a failure into an empty stdout here would turn a broken git into a `landed` verdict.
  const exec: ExecFn = async (cmd, opts) => {
    const r = await pexec("bash", ["-lc", cmd], { cwd: opts?.cwd ?? repoRoot, timeout: opts?.timeout ?? 60_000 });
    return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  };
  return deltaLanded(exec, repoRoot, { range, target: "main" });
}

/**
 * 8.4 — measure ONE card's deploy fact against the world, right now.
 *
 * Three facts, one ruler each, all already owned by somebody else: `readLastDeploySha` (what the deploy
 * orchestrator recorded per target, whoever invoked it), `makeGitContains` (the single ancestry primitive),
 * and the DECLARED fidelity canary (`resolveCanaryCommand` — board first, deployment default second, and
 * NEVER a surface the harness picked for itself: probing a surface nobody declared measures another app,
 * which is how the motivating incident reverted a live card three times).
 *
 * The face probe is passed as a THUNK so `measureDeployRecovery` can short-circuit it: when ancestry already
 * fails, the answer is known and the network is never touched. Any throw ⇒ `null` (did not measure).
 */
async function deployRecoveryFor(board: string, cardId: string) {
  const card = await readCard(board, cardId);
  if (!card) return null; // card unreadable/absent ⇒ did not measure (never a `false`)
  const repoRoot = findRepoRoot();
  const command = resolveCanaryCommand(await readBoardConfig(board).catch(() => null), loadRunnerConfig());
  return measureDeployRecovery({
    releasedSha: card.releasedSha,
    deployTargets: card.deployTargets,
    deployedShaFor: (target) => readLastDeploySha(repoRoot, target),
    faceDeclared: command !== null,
    faceFidelity: async () => {
      if (!command) return null;
      const r = await runFaceCanary(defaultExec, { repoRoot, command });
      return r.measured ? (r.ok ? "fresh" : "stale") : "unknown";
    },
    contains: makeGitContains(defaultExec, repoRoot),
  });
}

/** Build the real ports for ONE board. Every fetch is fail-open (an unreadable fact yields "nothing to do",
 *  never an exception): the steward's whole contract is that it can't break the tick. */
export function buildStewardPorts(board: string): StewardPorts {
  return {
    board,
    policy: async () => (await readBoardConfig(board).catch(() => null))?.orchestrator ?? null,
    config: () => readBoardConfig(board),

    // 8.1 — the train.
    parkedEntries: async () => {
      const snap = getMergeQueue().getSnapshot();
      return snap.entries
        .filter((e) => e.board === board && (e.status === "conflict" || e.status === "gate-failed"))
        .map(
          (e): StewardEntry => ({
            runId: e.runId,
            board: e.board,
            cardId: e.cardId,
            kind: e.kind,
            status: e.status,
            stewardAttempts: e.stewardAttempts,
            semanticAttempts: e.semanticAttempts,
            // A gate-failed park's git output is in `gateLog`; a merge conflict's is in `conflictDetail`.
            // Neither is a superset of the other, so the kernel gets whichever the train actually wrote.
            conflictDetail: e.conflictDetail ?? e.gateLog,
            resolutionAnalysis: e.resolutionAnalysis,
          }),
        );
    },
    conflictFiles: async (entry) => conflictedFilesFromDetail(entry.conflictDetail),
    retryEntry: (entry) => getMergeQueue().retryParkedEntry(entry.runId, STEWARD_ACTOR),

    // 8.2 — claims.
    releasedClaims: () => getCardClaims().listReleased(board).catch(() => []),
    liveClaims: () => getCardClaims().list(board).catch(() => []),
    actorAlive,
    notifyActor,
    deltaLandedForCard: (cardId) => deltaLandedForCard(board, cardId).catch(() => null),
    backoffItemsFor: async (cardId) => {
      const inBackoff = itemsInNoopBackoff(await readOrchestratorState(board));
      // A cockpit item id is `<cardId>:<kind>:<…>` — the card's items are its prefix's.
      return [...inBackoff].filter((id) => id === cardId || id.startsWith(`${cardId}:`));
    },
    // The DECISION travels back to the kernel: `rearmNoopItem` can legitimately REFUSE (no proof), and
    // swallowing that made the copiloto report a re-arm it never performed.
    rearm: (itemId: string, proof: RearmProof) => rearmNoopItem({ board, itemId, by: "steward", proof }),

    // 8.4 — the deploy fact of stranded items.
    backoffItems: async () => {
      const state = await readOrchestratorState(board);
      const inBackoff = itemsInNoopBackoff(state);
      if (inBackoff.size === 0) return [];
      // The item→card mapping comes from the SAME source the tick uses (`collectActionableCockpit.itemCards`),
      // never from parsing the item id: the id shape is the cockpit's business, and a parser here would be a
      // second, silently-drifting copy of it. An item with no pair is residue ⇒ empty cardId ⇒ the kernel
      // stands down on it.
      const { itemCards } = await collectActionableCockpit(board).catch(() => ({ itemCards: [] as Array<{ id: string; cardId: string }> }));
      const cardOf = new Map(itemCards.map((i) => [i.id, i.cardId]));
      return [...inBackoff].map((itemId) => {
        const entry = state.noopByItem?.[itemId];
        return {
          itemId,
          cardId: cardOf.get(itemId) ?? "",
          observedDeployProven: entry?.observed ? entry.observed.deployProven : null,
          stewardRearmed: !!entry?.rearmedByStewardAt,
        };
      });
    },
    deployRecoveryFor: (cardId) => deployRecoveryFor(board, cardId).catch(() => null),
    recordObservedFact: async (itemId, deployProven) => {
      const state = await readOrchestratorState(board);
      await writeOrchestratorState(board, markObservedFact(state, itemId, deployProven));
    },

    // 8.3 — the board.
    gateCandidates: () => gateCandidates(board).catch(() => []),
    claimedCardIds: () => getCardClaims().claimedCardIds(board, STEWARD_ACTOR).catch(() => new Set<string>()),
    moveCard: (cardId, to) => moveCard(board, cardId, to),

    // shared.
    askQuestion: (cardId, text) => askQuestion(board, cardId, text),
    diary: (entry) => appendCopilotActivity(board, entry),
  };
}

/**
 * Run ONE steward pass for `board` with the real ports. Best-effort by contract — the tick calls this on the
 * spawn path, and a steward that threw there would trade a copiloto run for an `error` outcome, which is a
 * strictly worse board than one with no steward at all.
 */
/**
 * O passe de RECUPERAÇÃO do caminho `skipped-no-work`: só o playbook 8.4, $0, sem spawn. Ver
 * `runDeployRecoveryPass` para o porquê (o steward completo roda depois do `hasWork` e por isso nunca
 * alcança um board cujos itens estão TODOS em backoff). Best-effort igual ao irmão: nunca lança.
 */
export async function runBoardRecoveryPass(board: string): Promise<StewardReport | null> {
  try {
    const report = await runDeployRecoveryPass(buildStewardPorts(board));
    if (report.rearmed.length > 0) console.log(`[recovery ${board}] re-armado por prova: ${report.rearmed.join(", ")}`);
    for (const err of report.errors) console.warn(`[recovery ${board}] ${err}`);
    return report;
  } catch (err) {
    console.warn(`[recovery ${board}] passe falhou (não-fatal):`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function runBoardStewardPass(board: string): Promise<StewardReport | null> {
  try {
    const report = await runStewardPass(buildStewardPorts(board));
    const acted = report.retried.length + report.moved.length + report.cyclesClosed.length + report.rearmed.length + report.notified.length;
    if (acted > 0 || report.escalated.length > 0) {
      console.log(
        `[steward ${board}] retry=${report.retried.length} move=${report.moved.length} ciclo=${report.cyclesClosed.length} ` +
          `rearm=${report.rearmed.length} aviso=${report.notified.length} escalado=${report.escalated.length}`,
      );
    }
    for (const err of report.errors) console.warn(`[steward ${board}] ${err}`);
    return report;
  } catch (err) {
    console.error(`[steward ${board}] passe falhou:`, err instanceof Error ? err.message : err);
    return null;
  }
}
