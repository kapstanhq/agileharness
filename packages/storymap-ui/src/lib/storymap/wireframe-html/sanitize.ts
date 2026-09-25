// Sanitizer for the `html` design-artifact format — DEFENSE IN DEPTH, not the load-bearing wall.
//
// Threat model (flow-v2-hardening): agent-authored sidecar content rendered in the operator's
// browser, whose basic_auth session reaches exec/deploy API routes. The HARD guarantees are the
// two layers the renderer owns (frame.ts):
//   1. <iframe sandbox=""> — empty sandbox: no scripts, no same-origin, no navigation. This is the
//      HISTORIC contract of the F2-era renderer (CardPipelineArtifacts, commit 23bf236b3) — that
//      renderer was removed to go ASCII-only/low-fi, NOT because the sandbox failed.
//   2. a CSP <meta> in the srcdoc <head> (`default-src 'none'; style-src 'unsafe-inline'`) — no
//      network egress (img/font/css/@import) even if something slips past this file.
// This pass is the third layer: it strips the known-active vectors so the content is inert even if
// a future refactor weakens a layer above. It runs at RENDER time (content can reach disk via git
// pull / MCP write_sidecar, so write-time sanitization alone can be bypassed) and is pure string →
// string, importable from client components.

/** Tags whose ENTIRE subtree is dropped (content and all). */
const DROP_WITH_CONTENT = ["script", "iframe", "object", "embed", "noscript", "template", "head", "title"];
/** Tags dropped but with their children kept (wrappers + inert-but-noisy structure). */
const UNWRAP = ["html", "body", "form", "foreignobject", "use", "image"];
/** Attributes stripped wherever they appear (fetch/navigation/behavior vectors). */
const DROP_ATTRS = ["src", "href", "srcset", "poster", "background", "action", "formaction", "xlink:href", "autofocus"];

const VOID_DROP = ["link", "meta", "base"]; // void tags — dropping the tag IS dropping the subtree

function dropTagWithContent(html: string, tag: string): string {
  // Paired form first (lazy across newlines), then any dangling open/close tag.
  return html
    .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), "")
    .replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "");
}

function unwrapTag(html: string, tag: string): string {
  return html.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "");
}

/**
 * Reduce agent-authored HTML to an inert BODY FRAGMENT:
 * - strips doctype/html/head/body wrappers (a stray <head> would otherwise let the browser reparent
 *   OUR CSP <meta> out of the head we build in frame.ts, silently voiding layer 2) — KEEPING the head's
 *   `<style>` blocks, lifted to the top of the fragment (the only part of a head a wireframe needs);
 * - drops script/iframe/object/embed/link/meta/base subtrees, all on* handlers, all URL-carrying
 *   attributes, javascript:/vbscript: leftovers, and non-data url() in inline CSS.
 * Pure and deliberately conservative: wireframes need structure + inline style, never real
 * links/images/scripts (the skill tells the agent placeholders are styled divs).
 */
export function sanitizeWireframeHtml(raw: string): string {
  let html = String(raw ?? "");
  html = html.replace(/<!doctype[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  // A `<style>` authored inside `<head>` is the NATURAL place to write it in a full html document — and the head
  // is dropped whole below (a stray head would let the browser reparent OUR CSP meta out of the frame's head).
  // Dropping it silently took the artifact's whole styling with it: the variant rendered unstyled and the human
  // compared layouts that were never the ones drawn. So the head's styles are LIFTED to the top of the fragment
  // before the head goes — they then pass through every inline-CSS rule below (@import and url() stripped) like
  // any body `<style>`, and nothing else from the head (meta/link/title/script) survives.
  const headStyles: string[] = [];
  html = html.replace(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi, (_whole, inner: string) => {
    for (const m of inner.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi)) headStyles.push(m[0]);
    return "";
  });
  if (headStyles.length) html = headStyles.join("\n") + html;
  for (const tag of DROP_WITH_CONTENT) html = dropTagWithContent(html, tag);
  for (const tag of VOID_DROP) html = html.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
  for (const tag of UNWRAP) html = unwrapTag(html, tag);
  // Event handlers: on*=… in double/single/no quotes.
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // URL-carrying attributes, wholesale (a wireframe has no business fetching or navigating).
  for (const attr of DROP_ATTRS) {
    html = html.replace(new RegExp(`\\s${attr}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi"), "");
  }
  // Scheme leftovers inside any remaining attribute value.
  html = html.replace(/(javascript|vbscript)\s*:/gi, "blocked:");
  // Inline CSS: url(...) that isn't a data: image → none (CSP blocks the fetch anyway; belt+braces),
  // and @import dropped.
  html = html.replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\1\)/gi, "none");
  html = html.replace(/@import[^;]+;?/gi, "");
  return html.trim();
}
