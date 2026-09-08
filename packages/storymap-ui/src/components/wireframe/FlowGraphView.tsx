"use client";

// FlowGraphView — the deterministic SVG renderer for a FlowGraph (the journey as a real diagram).
// Same contract as WireframeDSL: the LLM declared semantic structure (nodes/edges), CODE does the
// pixels (layoutFlowGraph). Labels are agent-authored text and render EXCLUSIVELY as JSX text
// children of <text> — never raw markup, no HTML-in-SVG escape hatches (locked by the source-scan
// test in wireframe-html.test.ts). Coerce issues are surfaced as a warning strip so a repaired
// graph can never look complete at the approval stop.

import { cn } from "@/lib/cn";
import { layoutFlowGraph, type FlowGraph, type FlowNodeKind } from "@/lib/storymap/flow-graph";

const KIND_STYLE: Record<FlowNodeKind, { rx: number; dash?: string; emphasis?: boolean }> = {
  start: { rx: 999, emphasis: true },
  step: { rx: 8 },
  decision: { rx: 3 },
  error: { rx: 8, dash: "4 3" },
  end: { rx: 999, emphasis: true },
};

export function FlowGraphView({
  graph,
  issues = [],
  className,
}: {
  graph: FlowGraph;
  issues?: string[];
  className?: string;
}) {
  const l = layoutFlowGraph(graph);

  return (
    <figure className={cn("not-prose my-4 overflow-hidden rounded-lg border border-line bg-inset", className)}>
      {issues.length > 0 && (
        <div className="border-b border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          {issues.map((i) => (
            <p key={i}>⚠ {i}</p>
          ))}
        </div>
      )}
      <div className="max-h-[520px] overflow-auto p-3 text-fg-muted">
        <svg
          width={l.width}
          height={l.height}
          viewBox={`0 0 ${l.width} ${l.height}`}
          role="img"
          aria-label="fluxo da jornada"
          className="mx-auto block"
        >
          <defs>
            <marker id="fg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" opacity="0.55" />
            </marker>
          </defs>

          {l.edges.map((e) => (
            <g key={`${e.from}->${e.to}`}>
              <path
                d={`M ${e.path.x1} ${e.path.y1} C ${e.path.c1x} ${e.path.c1y}, ${e.path.c2x} ${e.path.c2y}, ${e.path.x2} ${e.path.y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.25}
                strokeOpacity={0.5}
                strokeDasharray={e.back ? "4 3" : undefined}
                markerEnd="url(#fg-arrow)"
              />
              {e.label && (
                <text x={e.lx} y={e.ly - 4} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.75}>
                  {e.label}
                </text>
              )}
            </g>
          ))}

          {l.nodes.map((n) => {
            const s = KIND_STYLE[n.kind];
            const cx = n.x + n.w / 2;
            const noteY = n.y + n.h - 7;
            return (
              <g key={n.id}>
                {n.kind === "decision" ? (
                  <polygon
                    points={`${cx},${n.y - 4} ${n.x + n.w + 6},${n.y + n.h / 2} ${cx},${n.y + n.h + 4} ${n.x - 6},${n.y + n.h / 2}`}
                    fill="transparent"
                    stroke="currentColor"
                    strokeWidth={1.25}
                    strokeOpacity={0.8}
                  />
                ) : (
                  <rect
                    x={n.x}
                    y={n.y}
                    width={n.w}
                    height={n.h}
                    rx={s.rx}
                    fill="transparent"
                    stroke="currentColor"
                    strokeWidth={s.emphasis ? 1.75 : 1.25}
                    strokeOpacity={s.emphasis ? 0.95 : 0.7}
                    strokeDasharray={s.dash}
                  />
                )}
                {n.lines.map((line, i) => (
                  <text
                    key={i}
                    x={cx}
                    y={n.y + 9 + 12 + i * 15 - (n.note ? 5 : 0)}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={s.emphasis ? 600 : 450}
                    fill="currentColor"
                  >
                    {line}
                  </text>
                ))}
                {n.note && (
                  <text x={cx} y={noteY} textAnchor="middle" fontSize={9.5} fill="currentColor" opacity={0.6}>
                    {n.note}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
