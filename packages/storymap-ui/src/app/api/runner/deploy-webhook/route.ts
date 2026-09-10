// POST /api/runner/deploy-webhook — the DURABLE twin of the in-process
// (trigger-runner-channel, G3). A deploy that OUTLIVES the storymap process (a detached self-deploy, an
// external CI run) can't rely on the in-process `whenDone` callback — the service may have restarted
// mid-deploy. This route lets the deploy/CI POST its result back so the cascade still reacts: on FAILURE
// it REVERTS the card (reopen mode:'fix' → re-fire harness-fix) so the optimistically-terminal card stops
// lying "No ar" with un-published code. The single mechanism the ADK has and our model lacked.
//
// AUTH (story-h8tmzh / story-m9jflb): `Authorization: Bearer <token>` é o caminho PREFERIDO — o `curl` do
// self-deploy (runner/deploy.ts) ainda POSTa com `?secret=`, e query string é gravada por todo
// intermediário (174 gravações do token medidas no journal do Caddy, story-u4yf1i). A query segue aceita e
// DEPRECADA: quebrá-la pararia o settle que está no ar. Como esta rota MUTA (reverte card, avança para
// terminal), ela exige nível `orch` — um handle de leitura vazado não dirige o deploy. Fail-closed em
// AGILEHARNESS_MCP_TOKEN ausente/fraco, trava + rastro em `../perimeter`. SERVER-ONLY (Node runtime — touches
// the card on disk + re-evaluates the cascade).

import { revertCardOnDeployFailure } from "@/lib/storymap/runner/deploy-revert";
import { settleDeploySuccess } from "@/lib/storymap/runner/deploy-reconcile";
import { redispatchPendingSelfDeploy } from "@/lib/storymap/runner/entry-effects";
import { RUNNER_SURFACE_AUTH, authorizeRunnerRequest } from "../perimeter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 1.5 — a self-deploy SETTLE means the in-flight `storymap-deploy` unit is finishing (THIS POST is its last
// step), so any card parked behind it can now re-dispatch. Deferred (fire-and-forget after a short delay) so
// the settling unit — still alive executing this very curl — has EXITED and been --collect'd before we try to
// start the fixed unit again; an immediate re-dispatch would collide with the not-yet-reaped unit and fall to
// the watchdog fallback. Best-effort; a no-op when nothing is parked.
const SELF_DEPLOY_REDISPATCH_DELAY_MS = 4000;
function scheduleSelfDeployRedispatch(): void {
  void (async () => {
    await new Promise((r) => setTimeout(r, SELF_DEPLOY_REDISPATCH_DELAY_MS));
    await redispatchPendingSelfDeploy().catch((err) =>
      console.error("[deploy-webhook] re-disparo do self-deploy pendente falhou:", err instanceof Error ? err.message : err),
    );
  })();
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authorizeRunnerRequest(request, RUNNER_SURFACE_AUTH.deployWebhook);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "corpo JSON inválido" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  // WS1.1 — versioned payload: IGNORE an unknown version (a NEWER detached script posting to an OLDER route
  // after a bad restart, or vice-versa) instead of mis-handling its shape. Absent `v` = a legacy caller
  // (the in-process twin / an external CI without the field) → treated as v1. 202 = accepted-but-ignored.
  if (typeof b.v === "number" && b.v !== 1) {
    console.warn(`[deploy-webhook] payload de versão desconhecida (v=${String(b.v)}) — ignorado`);
    return Response.json({ ok: true, action: "ignored-unknown-version" }, { status: 202 });
  }

  const board = typeof b.board === "string" ? b.board : null;
  const cardId = typeof b.cardId === "string" ? b.cardId : null;
  const status = b.status === "ok" || b.status === "failed" ? b.status : null;
  if (!board || !cardId || !status) {
    return Response.json(
      { ok: false, error: "campos obrigatórios: board, cardId, status (ok|failed)" },
      { status: 400 },
    );
  }

  if (status === "ok") {
    // deploy-truth WS-3 — the DURABLE settle-success path. The card no longer advanced optimistically: it
    // is WAITING in the deploy step ("Publicando") for exactly this confirmation. settleDeploySuccess reads
    // EVERYTHING from disk (card, config, deploy state) — mandatory, because the storymap SELF-deploy's
    // settle arrives at the FRESH process post-restart, with zero in-memory state. It measures the ancestry
    // proof (releasedSha ⊆ published sha — the single deploy-reconcile ruler; for a self-deploy, published
    // sha = the checkout HEAD the build ran from), stamps `deployProof`, resolves the stale deploy-failure
    // finding and advances deploy → terminal through the GATED path (checkGate). Fail-closed: an ok settle
    // WITHOUT proof leaves the card in Publicando with the deploy-unsettled watchdog armed. Best-effort:
    // never throws; an absent board/card is a safe no-op — the ACK is unconditional (the CI caller retries
    // on non-2xx, and there is nothing it could do better).
    await settleDeploySuccess(board, cardId, {
      source: "settle-webhook",
      selfDeploy: b.phase === "self-deploy",
    });
    scheduleSelfDeployRedispatch(); // 1.5 — the unit is free now: re-dispatch any card parked behind it
    return Response.json({ ok: true, action: "settled" });
  }

  const pkg = typeof b.pkg === "string" ? b.pkg : undefined;
  const exitCode = typeof b.exitCode === "number" ? b.exitCode : undefined;
  // WS1.1 — a self-deploy failure names its own phase + carries the build/restart logTail (base64 → robust
  // against arbitrary log bytes). Decode it here (Node runtime) so the finding gets the WHY, not just "falhou".
  const phase = b.phase === "self-deploy" ? "self-deploy" : undefined;
  const logTail = decodeLogTail(b.logTailB64);
  // AWAIT so the durable card write lands before we ACK (the cascade re-eval inside is itself
  // fire-and-forget). revertCardOnDeployFailure is best-effort and NEVER throws, so the ACK is safe.
  await revertCardOnDeployFailure(board, cardId, { pkg, exitCode, phase, logTail });
  scheduleSelfDeployRedispatch(); // 1.5 — the unit is free now: re-dispatch any card parked behind it
  return Response.json({ ok: true, action: "reverted" });
}

/** Decode the base64 build/restart logTail into a bounded UTF-8 string (forensics). Tolerant: any non-string
 *  or malformed input → undefined (the finding just omits the tail). */
function decodeLogTail(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return decoded ? decoded.slice(-4000) : undefined;
  } catch {
    return undefined;
  }
}
