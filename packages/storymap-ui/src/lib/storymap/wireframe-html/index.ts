// Wireframe HTML — pure core barrel (no React). The iframe renderer lives in
// components/wireframe/HtmlArtifactFrame.tsx and imports from here.

export { sanitizeWireframeHtml } from "./sanitize";
export { buildWireframeSrcDoc, WIREFRAME_IFRAME_SANDBOX } from "./frame";
export { htmlToText } from "./to-text";

/** Hard per-artifact cap for `html` content, enforced at COERCE time (sidecars.ts): the sidecar-wide
 *  cap is 512KB, so without this a single artifact could carry a parse-DoS-sized blob; the skill's
 *  "~10KB por artefato" guidance is advisory — this is the enforced ceiling. Over the cap the
 *  artifact degrades to `text` (htmlToText projection survives; the blob does not). */
export const MAX_HTML_ARTIFACT_BYTES = 32 * 1024;
