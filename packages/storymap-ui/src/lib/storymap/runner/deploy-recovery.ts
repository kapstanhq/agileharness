// deploy-recovery.ts — MEASURE, for one card, the world fact "this card's deploy is PROVEN", so the steward
// can re-arm an item stuck in the anti-noop backoff when — and only when — that fact TRANSITIONS from false
// to true. AGNOSTIC: no product name, no product import; every surface it reads arrives injected.
//
// ── WHY THIS SIGNAL, AND WHY NOT THE OBVIOUS ONES ────────────────────────────────────────────────────────
//
// The signal is `deployProven`: the SAME ruler that stamps a card "No ar" (measureDeployAncestry — every
// declared target ran a deploy at a commit that CONTAINS the card's `releasedSha`), conjoined with the
// declared face serving a sha that contains it. Read as an EDGE (`observed === false` → `measured === true`),
// never as a level. Three candidates were measured and rejected:
//
//   • "the face carries the release" as a LEVEL — measured TRUE at all three give-ups of the incident that
//     motivated this producer. Zero discriminating power: a predicate that was already true when the tick
//     gave up cannot explain why retrying now would go differently. It is also board-global, so publishing
//     card B would re-arm dead items of card A — "re-arm on deploy", rejected by name in noop-rearm.ts.
//   • the card's own `deploy-failure` finding being CLOSED — closed `statusBy: copilot`, i.e. self-granted.
//     That is the "fact-signature derived from card fields" noop-rearm.ts forbids: the churn of the failed
//     attempt itself moves those fields, so every attempt would look like a new fact.
//   • a TIME TTL ("re-arm after 6h") — not a fact at all; rejected in noop-rearm.ts.
//
// The property that makes `deployProven` the right one: THE PROOF IS SUFFICIENT FOR THE RETRY TO SUCCEED.
// It is the settle's own ruler, so re-arming exactly when it passes means the next attempt can actually
// stamp its proof and finish — by construction, this re-arm cannot buy back the no-op it is meant to end.
// And it cannot fabricate itself: a tick can only move this fact by publishing successfully, and a
// successful publish advances the card out of the actionable set (where the next bump prunes it).
//
// FAIL-CLOSED, and the distinction that carries it: `null` means "I DID NOT MEASURE" and is NEVER coerced to
// `false`. An unreadable fact is neither a baseline nor a proof — writing `false` from a failed read would
// manufacture the very edge the producer waits for, out of a broken git or a flaky network.

import { measureDeployAncestry } from "./deploy-reconcile";

/** The measurement of ONE card's deploy fact. `detail` is operator-facing: it becomes the `RearmProof.detail`
 *  the diary shows, so it must say WHAT was measured, never just "ok". Never empty (an empty detail is
 *  rejected downstream by `rearmAllowed` — a claim is not evidence). */
export interface DeployRecoveryMeasurement {
  deployProven: boolean;
  detail: string;
}

/**
 * Measure whether this card's code is PROVABLY deployed, right now.
 *
 * Returns `null` for "did not measure" — no `releasedSha`, no declared targets, a target whose deploy state
 * is unreadable, a face that answered nothing concrete, or an exec that rejected. Only ONE outcome is a
 * genuine negative measurement: a target whose last deploy ran at a commit that does NOT contain the card's
 * code. "Nothing to check" is not "everything passed", and "I could not read it" is not "it is false".
 *
 * COST SHORT-CIRCUIT (mandatory): ancestry is measured FIRST, because it is local and cheap. When it fails,
 * the answer is already `deployProven: false` and the network probe is NEVER invoked — which is why
 * `faceFidelity` is a THUNK rather than a value. In the motivating case this costs zero HTTP calls.
 */
export async function measureDeployRecovery(input: {
  releasedSha: string | null | undefined;
  deployTargets: readonly string[] | undefined;
  deployedShaFor: (target: string) => Promise<string | null>;
  /** true = this board HAS a publication-fidelity canary declared (board.yaml or settings). false ⇒ fidelity
   *  is not part of the conjunction — it is NEVER replaced by a harness-chosen default surface. */
  faceDeclared: boolean;
  /**
   * LAZY on purpose — see the cost short-circuit above. The FIDELITY verdict of the declared canary:
   * "stale" (some surface confirmed serving other bytes), "fresh" (all surfaces serve what was published),
   * or null/"unknown" (not measured).
   *
   * story-w3y6ml — this used to be `servedFaceSha` compared with `contains(ancestry.sha, seen)`: the SAME
   * unsound ruler that reverted live cards from the deploy path, quietly wired into the re-arm producer too.
   * It could only ever produce FALSE NEGATIVES (a diff-aware build legitimately serves an older artifact),
   * so it made the steward give up on items whose deploy was fine. Fidelity has no such failure mode.
   */
  faceFidelity: () => Promise<"fresh" | "stale" | "unknown" | null>;
  contains: (ancestor: string, descendant: string) => Promise<boolean>;
}): Promise<DeployRecoveryMeasurement | null> {
  const released = input.releasedSha?.trim();
  const targets = input.deployTargets?.filter(Boolean) ?? [];

  let ancestry;
  try {
    ancestry = await measureDeployAncestry(
      { releasedSha: released, deployTargets: [...targets] },
      input.deployedShaFor,
      input.contains,
    );
  } catch {
    return null; // git/state unreadable ⇒ did not measure
  }

  if (!ancestry.proven) {
    // The ONLY negative MEASUREMENT: every target answered, and one of them ran before this card's code.
    // Every other reason ("sem-released-sha", "sem-alvos", "alvo-sem-deploy", …) is an absence of evidence.
    if (ancestry.reason !== "deploy-anterior-ao-codigo") return null;
    return {
      deployProven: false,
      detail: `o deploy deste card NÃO está provado: algum alvo declarado (${targets.join(", ")}) rodou num commit anterior ao código (${released?.slice(0, 9)})`,
    };
  }

  const shortSha = ancestry.sha.slice(0, 9);
  const where = ancestry.targets.join(", ");
  if (!input.faceDeclared) {
    return {
      deployProven: true,
      detail: `todos os alvos declarados (${where}) carregam ${shortSha}; não há canário de fidelidade declarado, então a superfície não entra na conjunção`,
    };
  }

  let fidelity: "fresh" | "stale" | "unknown" | null;
  try {
    fidelity = await input.faceFidelity();
  } catch {
    return null;
  }
  // A canary that read nothing concrete is not a negative answer. Turning it into `deployProven: false`
  // would let a flaky network write the baseline the edge-detector later reads as "it was broken then".
  if (!fidelity || fidelity === "unknown") return null;

  return fidelity === "fresh"
    ? {
        deployProven: true,
        detail: `alvos (${where}) carregam ${shortSha} e toda superfície publicada serve o que foi publicado`,
      }
    : {
        deployProven: false,
        detail: `os alvos (${where}) carregam ${shortSha}, mas alguma superfície publicada serve bytes diferentes dos que publicamos`,
      };
}
