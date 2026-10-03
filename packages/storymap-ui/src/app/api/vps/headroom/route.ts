// Server-side probe of the headroom compression proxy. Called by HeadroomChip every 30s.
// Reads the board config for the canonical `headroom` entry, resolves the URL, probes liveness,
// and returns a compact status the UI can render without knowing anything about the VPS.

import { readBoardConfig } from "@/lib/storymap/repo";
import { selfBoardId } from "@/lib/storymap/self-board";
import { probeHeadroomCached, resolveHeadroomUrl } from "@/lib/storymap/runner/headroom";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type HeadroomStatus = {
  /** `true` sempre que o tráfego seria roteado — hoje o default é LIGADO; só `headroom.enabled:false`
   *  no board.yaml ou AGILEHARNESS_HEADROOM_URL=off devolvem `false`. */
  configured: boolean;
  /** Proxy URL that would be injected, or null when headroom is off. */
  url: string | null;
  /** Whether the proxy answered within the probe timeout (only meaningful when configured). */
  alive: boolean;
};

export async function GET(): Promise<Response> {
  try {
    // Sem board próprio declarado, resta o env (`AGILEHARNESS_HEADROOM_URL`), que vence a config do
    // board de qualquer forma — ver resolveHeadroomUrl.
    const proprio = selfBoardId();
    const config = proprio ? await readBoardConfig(proprio) : null;
    const url = resolveHeadroomUrl(config, process.env);
    if (!url) {
      return Response.json({ configured: false, url: null, alive: false } satisfies HeadroomStatus);
    }
    // Sonda MEMOIZADA de propósito: o chip pergunta a cada 30s, e cada resposta também AQUECE o
    // espelho síncrono que `headroomUrlIfKnownAlive` lê — é o que mantém o único spawn site que não
    // pode esperar uma sonda (o agente de deploy) roteando enquanto o serviço está de pé.
    const alive = await probeHeadroomCached(url);
    return Response.json({ configured: true, url, alive } satisfies HeadroomStatus);
  } catch {
    return Response.json({ configured: false, url: null, alive: false } satisfies HeadroomStatus);
  }
}
