// srcdoc builder for the `html` design-artifact format — the two LOAD-BEARING layers live here.
//
// The skeleton is EXPLICIT (doctype + <head> + <body>), never a bare concat like the historic
// renderer: a CSP <meta> is only honored inside <head>, and agent HTML carrying its own wrappers
// could otherwise reparent our meta into <body> and silently void it — which is also why
// sanitizeWireframeHtml reduces the content to a body FRAGMENT before it gets here.
//
// Base CSS: a neutral low-fi floor (system font, grayscale, spacing), NOT !important-forced — the
// user's quality lean means the agent MAY style over it; what the agent can never do is script,
// navigate, or fetch (sandbox + CSP), so "hi-fi drift" is a taste boundary, not a security one.

import { sanitizeWireframeHtml } from "./sanitize";

/** The iframe sandbox value. EMPTY IS THE CONTRACT — no allow-scripts, no allow-same-origin, no
 *  allow-forms, no allow-top-navigation. Locked by wireframe-html.test.ts (source scan + this
 *  constant); weakening it turns agent-authored sidecar HTML into code running against the
 *  operator's basic_auth session (which reaches exec/deploy routes). */
export const WIREFRAME_IFRAME_SANDBOX = "";

/** No network egress from inside the frame, styles inline-only. */
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'";

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
         font-size: 13px; line-height: 1.45; color: #27272a; background: #fafafa; }
  h1, h2, h3, h4 { margin: 0 0 .35em; line-height: 1.25; }
  p { margin: 0 0 .6em; }
  button, input, select, textarea { font: inherit; }
  img, svg, video { max-width: 100%; }
`;

/** Assemble the complete srcdoc for an html artifact: sanitize → explicit skeleton with CSP in head. */
export function buildWireframeSrcDoc(rawHtml: string): string {
  const body = sanitizeWireframeHtml(rawHtml);
  return [
    "<!doctype html>",
    "<html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    `<style>${BASE_CSS}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("\n");
}
