// The MEDIDORES of the running services — work state, context burned, cost and diff.
//
// SEPARATE from /api/processes for the reason service-meters.ts documents at length: that route is polled
// every 8s and already costs several tmux/ps spawns, while a meter costs a transcript pread plus two git
// spawns per session with a worktree. This one is polled at 15s and pauses while the tab is hidden.
//
// It re-lists the services itself rather than taking ids from the client: the meter for a service the box
// no longer hosts is not a thing we should be able to be asked for, and the list is the memoised call.

import { listRunningServices } from "@/lib/vps/processes";
import { collectServiceMeters } from "@/lib/vps/service-meters-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const services = await listRunningServices();
  const meters = await collectServiceMeters(services);
  return Response.json({ meters, at: Date.now() });
}
