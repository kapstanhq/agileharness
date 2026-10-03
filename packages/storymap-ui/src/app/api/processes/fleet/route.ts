// WS-6.4 — the fleet, as JSON. The Processos page server-renders the first snapshot and its client island
// re-polls this (the fleet is tmux/registry state, not SSE runner state — the same posture the tmux rows
// already take). force-dynamic: it must always reflect the live registries.

import { defaultFleetDeps } from "@/lib/storymap/runner/fleet-deps";
import { collectFleet } from "@/lib/storymap/runner/fleet-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const fleet = await collectFleet(defaultFleetDeps()).catch(() => []);
  return Response.json({ fleet, at: Date.now() });
}
