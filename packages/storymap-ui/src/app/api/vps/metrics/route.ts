// Point read of the VPS health snapshot (RAM/disk/load + Claude usage window). Used for
// the initial server render of the Processos page and any manual refresh; the live feed
// rides the shared SSE stream as `metrics` events.

import { getMetricsHub } from "@/lib/vps/metrics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const metrics = await getMetricsHub().current();
  return Response.json(metrics);
}
