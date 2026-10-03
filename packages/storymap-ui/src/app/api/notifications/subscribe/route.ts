// Subscription endpoint — the browser POSTs its PushSubscription here after the user
// opts into phone push (and DELETEs it on opt-out). Stored in the gitignored runner
// state dir via push-store. Server-only (node:fs through push-store).

import { addSubscription, removeSubscription } from "@/lib/notifications/server/push-store";
import type { PushSubscription } from "web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const sub = (await req.json()) as PushSubscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return Response.json({ error: "invalid subscription" }, { status: 400 });
    }
    addSubscription(sub);
    return Response.json({ ok: true }, { status: 201 });
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { endpoint } = (await req.json()) as { endpoint?: string };
    if (!endpoint) return Response.json({ error: "missing endpoint" }, { status: 400 });
    removeSubscription(endpoint);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
}
