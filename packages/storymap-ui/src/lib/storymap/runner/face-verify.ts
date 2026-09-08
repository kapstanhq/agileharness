// face-verify.ts — the VERIFY seam of a published-face deploy: a publish command exiting 0 does NOT
// prove the CDN serves the new bundle. A stale edge — or a build that silently never ran — keeps
// serving the OLD bytes while the deploy reports success, and the card claims "No ar" while users
// still see yesterday's UI.
//
// THE RULER CHANGED, AND THAT IS THE POINT (acme/story-w3y6ml, 2026-07-22). This module used to ask
// "does the sha served at the BOARD's declared surface CONTAIN this card's `releasedSha`?" — a
// question it had no business answering, and answered wrongly twice over (wrong surface, wrong
// reference; the full incident record lives in the header of `face-probe.ts`). It reverted cards
// that were provably live — three times across three cards — and each time `deploy-reconcile`
// immediately contradicted it.
//
// It now delegates to the DEPLOYMENT'S OWN canary (declared in `settings.yaml` as
// `deploy.canaryCommand`) and merely relays the verdict. The deployment is the only party that knows
// its published topology, so it is the only party that can compare "what we published for surface S"
// against "what S serves". This module holds NO product name, NO URL and NO notion of a card's
// `releasedSha` — which is why it is no longer registered coupling debt in `agnostic-lint`.
//
// The card's LIVENESS is not decided here, and never should have been: `measureDeployAncestry`
// (deploy-reconcile) owns that, over the card's declared deploy targets. This is a CDN check on top.
//
// FAIL-OPEN: no command declared, an unreadable canary, or any throw ⇒ keep the card (the settle
// proceeds and ancestry stays the authority). Only a CONFIRMED-stale surface reverts. Best-effort:
// it logs and NEVER throws. SERVER-ONLY.

import { defaultExec } from "./worktree";
import { findRepoRoot } from "@/lib/storymap/paths";
import { readBoardConfig } from "@/lib/storymap/repo";
import { loadRunnerConfig } from "./config";
import { revertCardOnDeployFailure } from "./deploy-revert";
import { describeStale, resolveCanaryCommand, runFaceCanary } from "./face-probe";

/**
 * The onDone action for a SUCCESSFUL face publish: run the deployment's fidelity canary and, when it
 * CONFIRMS a surface serving bytes we did not publish, revert the card like any deploy failure
 * (deploy-revert, phase "face-stale").
 *
 * deploy-truth WS-3 — RETURNS whether it REVERTED, because the caller (the registry onDone settle in
 * trigger-runner-channel) runs canary-THEN-settle: a reverted card must NOT be settle-advanced, and
 * settling would resolve the very face-stale finding the revert just stamped. `false` = card kept —
 * the settle may proceed.
 *
 * `pkg` is the deploy target that just settled, passed IN by the caller rather than imported from a
 * product module: importing `product-deploy.ts` for that constant would drag in a manifest read AT
 * MODULE LOAD that THROWS when absent — the landmine that forced the `face-probe.ts` split.
 */
export async function verifyFaceAndRevert(board: string, cardId: string, pkg?: string): Promise<boolean> {
  try {
    const repoRoot = findRepoRoot();
    const config = await readBoardConfig(board).catch(() => null);
    const command = resolveCanaryCommand(config, loadRunnerConfig());
    const result = await runFaceCanary(defaultExec, { repoRoot, command });

    if (!result.measured) {
      console.warn(
        `[face-verify ${board}/${cardId}] canário de publicação não mediu ` +
          `(${command ? "saída ilegível" : "nenhum deploy.canaryCommand declarado no board nem em settings.yaml"}) — ` +
          `mantendo o card (fail-open); a ancestralidade segue sendo a autoridade`,
      );
      return false;
    }
    if (result.ok) {
      console.log(
        `[face-verify ${board}/${cardId}] canário OK — ${result.surfaces.length} superfície(s) servem ` +
          `exatamente o que foi publicado`,
      );
      return false;
    }

    const detail = describeStale(result);
    await revertCardOnDeployFailure(board, cardId, { pkg: pkg ?? "face", phase: "face-stale", reason: detail });
    console.warn(
      `[face-verify ${board}/${cardId}] canário CONFIRMOU superfície stale (${detail}) → revertido para Liberar`,
    );
    return true;
  } catch (err) {
    console.error(`[face-verify ${board}/${cardId}] verify falhou:`, err instanceof Error ? err.message : err);
    return false;
  }
}
