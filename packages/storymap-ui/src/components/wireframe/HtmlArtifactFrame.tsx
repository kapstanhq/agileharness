"use client";

// HtmlArtifactFrame — the ONLY surface that renders an `html` design artifact, inside an iframe
// whose sandbox attribute is the EMPTY string (the load-bearing guarantee: no scripts, no
// same-origin, no navigation — the historic contract of the F2-era renderer, which was removed to
// go ASCII-only, not because this contract failed). The srcdoc arrives pre-built by
// buildWireframeSrcDoc: sanitize → explicit skeleton with the CSP meta inside <head> (no network
// egress). Weakening the sandbox constant or adding a permissive token here is locked out by the
// source-scan test in wireframe-html.test.ts.

import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { buildWireframeSrcDoc, WIREFRAME_IFRAME_SANDBOX } from "@/lib/storymap/wireframe-html";

const MIN_H = 240;
const MAX_H = 900;

export function HtmlArtifactFrame({
  html,
  title,
  viewport = "mobile",
  heightHint,
  className,
}: {
  html: string;
  title: string;
  viewport?: "mobile" | "desktop";
  heightHint?: number | null;
  className?: string;
}) {
  const srcDoc = useMemo(() => buildWireframeSrcDoc(html), [html]);
  const height = Math.min(MAX_H, Math.max(MIN_H, heightHint ?? (viewport === "mobile" ? 640 : 480)));

  return (
    <div className={cn("not-prose w-full", className)}>
      <iframe
        sandbox={WIREFRAME_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        loading="lazy"
        srcDoc={srcDoc}
        title={title}
        style={{ height }}
        className={cn(
          "mx-auto block w-full overflow-hidden rounded-xl border border-line bg-white shadow-sm",
          viewport === "mobile" ? "max-w-[375px]" : "max-w-full",
        )}
      />
    </div>
  );
}
