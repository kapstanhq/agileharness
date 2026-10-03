"use client";

// JourneyView — the ONE journey renderer both design surfaces share (CardDocument drawer +
// CockpitView Inbox), so the format branches never fork again: `graph` renders the real SVG
// diagram (FlowGraphView, coerce issues surfaced); legacy `mermaid`/`ascii` render exactly as
// always (raw source through the pan/zoom AsciiFigure).

import { AsciiFigure } from "../AsciiFigure";
import { FlowGraphView } from "./FlowGraphView";
import type { WireframeJourney } from "@/lib/storymap/types";

export function JourneyView({ journey, compact = false }: { journey: WireframeJourney; compact?: boolean }) {
  const hasFlow = journey.format === "graph" ? journey.graph != null : journey.flow.trim().length > 0;
  if (!hasFlow && !journey.narrative.trim()) return null;

  return (
    <div>
      {journey.narrative.trim() && (
        <p className={compact ? "whitespace-pre-wrap text-[12px] leading-snug text-fg-muted" : "my-2 text-[13px] leading-relaxed text-fg"}>
          {journey.narrative}
        </p>
      )}
      {journey.format === "graph" && journey.graph ? (
        <FlowGraphView graph={journey.graph} issues={journey.issues ?? []} />
      ) : (
        hasFlow && (
          <AsciiFigure ascii={journey.flow} caption={journey.format === "mermaid" ? "fluxo · mermaid (fonte)" : undefined} />
        )
      )}
    </div>
  );
}
