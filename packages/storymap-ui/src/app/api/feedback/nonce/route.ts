// POST /api/feedback/nonce — mint the capability that opens the cross-origin embed lane (F5).
// DELETE                    — revoke every nonce (the panic button).
//
// SAME-ORIGIN ONLY, and that is the entire authorisation model: this route is reachable only from
// the board itself, which in production sits behind the Caddy basic_auth catch-all. So "can mint" ==
// "is the operator". A page on mosaico.app can never mint its own capability — it can only spend one
// the operator handed it.
//
// NEVER emits CORS: minting cross-origin would defeat the point.

import { checkSameOriginJson } from "@/lib/feedback/guard";
import { parseEmbedOrigins } from "@/lib/feedback/embed";
import { mintNonce, revokeAllNonces } from "@/lib/feedback/nonce-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = checkSameOriginJson(request.headers);
  if (!guard.ok) return Response.json({ ok: false, error: guard.error }, { status: guard.status });

  // Minting while no origin is allowlisted would hand out a key to a door that doesn't exist — say so
  // instead of returning a token that can never work.
  const allowed = parseEmbedOrigins(process.env.STORYMAP_FEEDBACK_EMBED_ORIGINS);
  if (allowed.length === 0) {
    // NOTE: no example hostname here on purpose — this tool is app-agnostic (agnostic-lint), so the
    // consumer's own origins live in its config (.env.example documents the format), never in code.
    return Response.json(
      {
        ok: false,
        error:
          "nenhuma origem de embed configurada — defina STORYMAP_FEEDBACK_EMBED_ORIGINS com as origens permitidas (separadas por vírgula, sem path)",
      },
      { status: 409 },
    );
  }

  let label: string | undefined;
  try {
    const body = (await request.json()) as { label?: unknown } | null;
    if (body && typeof body.label === "string" && body.label.trim()) label = body.label.trim().slice(0, 80);
  } catch {
    // body is optional — a bare POST mints an unlabelled nonce
  }

  const { token, expiresAt } = await mintNonce(Date.now(), label);
  return Response.json({ ok: true, nonce: token, expiresAt, allowedOrigins: allowed });
}

export async function DELETE(request: Request): Promise<Response> {
  // No body on a DELETE → the JSON variant's content-type requirement doesn't apply; the origin check
  // is what matters. checkSameOriginJson would 415 a bodyless revoke, so use the read guard.
  const { checkSameOrigin } = await import("@/lib/feedback/guard");
  const guard = checkSameOrigin(request.headers);
  if (!guard.ok) return Response.json({ ok: false, error: guard.error }, { status: guard.status });
  await revokeAllNonces();
  return Response.json({ ok: true, revoked: true });
}
