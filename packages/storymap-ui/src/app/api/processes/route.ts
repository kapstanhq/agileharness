// The unified list of running Claude services on the box (runner runs + tmux sessions).
// force-dynamic so it always reflects the live registry/journal/tmux state. The Processos
// page renders an initial server snapshot and a client island re-polls this for the rows
// that aren't on the SSE stream (tmux sessions), while runner runs update via SSE instantly.

import { listRunningServices } from "@/lib/vps/processes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const services = await listRunningServices();
  return Response.json({ services, at: Date.now() });
}
