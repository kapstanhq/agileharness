"use client";

// AsciiFigure (F2) — an ASCII art block (a journey flow, a wireframe, a diagram) rendered
// as a pan/zoom figure INLINE in the card document, replacing the old isolated iframe gallery
// and the loose <pre>. ASCII-only by design: zero HTML/iframe → zero injection surface, ~16kB
// of pan/zoom (react-zoom-pan-pinch) over a <pre>. Wide diagrams pan; dense ones zoom; the
// <pre> underneath stays readable even if the gesture layer is ignored.
//
// MOBILE SCROLL-TRAP FIX: react-zoom-pan-pinch preventDefaults the touchmove while panning, which
// would TRAP the page's vertical scroll behind a full-width figure on a phone. So single-finger PAN
// is gated behind a zoom-in (panning.disabled while scale ≤ 1): at rest a vertical swipe scrolls the
// DOCUMENT; only once the user zooms in does pan turn on to move around the magnified figure
// (limitToBounds keeps it from being dragged off-screen, recoverable via the reset button anyway).

import { useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

const MAX_H = 440;

export function AsciiFigure({ ascii, caption }: { ascii: string; caption?: string | null }) {
  const text = ascii.replace(/\s+$/, "");
  const [zoomedIn, setZoomedIn] = useState(false);
  return (
    <figure className="not-prose my-4 overflow-hidden rounded-lg border border-line bg-inset">
      <TransformWrapper
        minScale={0.4}
        maxScale={4}
        initialScale={1}
        centerOnInit={false}
        limitToBounds
        wheel={{ step: 0.08 }}
        doubleClick={{ step: 0.7 }}
        panning={{ velocityDisabled: true, disabled: !zoomedIn }}
        onTransformed={(_, state) => {
          const z = state.scale > 1.01;
          setZoomedIn((prev) => (prev === z ? prev : z));
        }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <div className="flex items-center gap-1 border-b border-line-muted bg-surface/60 px-2 py-1">
              {caption && <span className="mr-auto truncate text-[10px] font-medium text-fg-subtle">{caption}</span>}
              <ZoomBtn onClick={() => zoomOut()} label="Diminuir zoom"><Minus className="h-3.5 w-3.5" /></ZoomBtn>
              <ZoomBtn onClick={() => zoomIn()} label="Aumentar zoom"><Plus className="h-3.5 w-3.5" /></ZoomBtn>
              <ZoomBtn onClick={() => resetTransform()} label="Reajustar"><Maximize2 className="h-3.5 w-3.5" /></ZoomBtn>
            </div>
            <div className="overflow-hidden" style={{ maxHeight: MAX_H }}>
              <TransformComponent
                wrapperStyle={{ width: "100%", height: "100%", maxHeight: MAX_H, cursor: zoomedIn ? "grab" : "auto" }}
                contentStyle={{ width: "100%" }}
              >
                <pre className="w-full whitespace-pre p-3 font-mono text-[11px] leading-tight text-fg-muted">{text}</pre>
              </TransformComponent>
            </div>
          </>
        )}
      </TransformWrapper>
    </figure>
  );
}

function ZoomBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
    >
      {children}
    </button>
  );
}
