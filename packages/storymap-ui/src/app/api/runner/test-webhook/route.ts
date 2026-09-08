// POST /api/runner/test-webhook — the DURABLE twin of the in-process
// test-queue completion (ADR-063 Fase 3b). A test that OUTLIVES the storymap process (a detached run whose
// storymap parent restarted mid-test, or an external CI run) can't rely on the in-process executor's
// `close` callback. This route lets that test POST its result back so the cascade still RESUMES: it feeds
// the outcome into getTestQueue().reportDone, which unpersists the ledger entry + fans out onDone — waking
// the SAME cascade subscription (trigger-runner-channel) the in-process path does. The mechanism the merge
// train has via /deploy-webhook, now for test execution.
//
// AUTH (story-h8tmzh / story-m9jflb): `Authorization: Bearer <token>` é o caminho PREFERIDO; `?secret=`
// segue aceito e DEPRECADO (query string vaza em log de acesso, `Referer` e histórico de proxy — 174
// gravações do token medidas em story-u4yf1i) porque um runner de CI externo pode não conseguir setar
// header, e quebrá-lo seria remoção de capacidade. Como esta rota MUTA (retoma a cascata, e com ela o
// próximo spawn/deploy), ela exige nível `orch`: um handle de leitura vazado não dispara pipeline.
// Fail-closed em STORYMAP_MCP_TOKEN ausente/fraco; trava + rastro de toda recusa em `../perimeter`.
// SERVER-ONLY (Node runtime — touches the durable ledger + re-evaluates the cascade).

import { getTestQueue } from "@/lib/storymap/runner/test-queue";
import { RUNNER_SURFACE_AUTH, authorizeRunnerRequest } from "../perimeter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Slug guard — board/cardId reach the ledger key + a cascade re-eval, never a shell; keep them clean. */
const SLUG = /^[a-z0-9-]+$/i;

export async function POST(request: Request): Promise<Response> {
  const auth = await authorizeRunnerRequest(request, RUNNER_SURFACE_AUTH.testWebhook);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "corpo JSON inválido" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const board = typeof b.board === "string" ? b.board : null;
  const cardId = typeof b.cardId === "string" ? b.cardId : null;
  const trigger = typeof b.trigger === "string" ? b.trigger : null;
  // `passed` accepted as a boolean, or as the string "passed"/"failed" (a CI runner may only send strings).
  const passed =
    typeof b.passed === "boolean"
      ? b.passed
      : b.status === "passed"
        ? true
        : b.status === "failed"
          ? false
          : null;
  if (!board || !cardId || !trigger || passed === null) {
    return Response.json(
      { ok: false, error: "campos obrigatórios: board, cardId, trigger, passed (bool) | status (passed|failed)" },
      { status: 400 },
    );
  }
  if (!SLUG.test(board) || !SLUG.test(cardId) || !SLUG.test(trigger)) {
    return Response.json({ ok: false, error: "board/cardId/trigger devem ser slugs [a-z0-9-]" }, { status: 400 });
  }

  // reportDone is synchronous (unpersist + fan out); the cascade re-eval it triggers is itself
  // fire-and-forget and NEVER throws out, so the ACK is safe.
  getTestQueue().reportDone({ board, cardId, trigger }, passed);
  return Response.json({ ok: true, action: passed ? "resumed-pass" : "resumed-fail" });
}
