// write-time validation of a wireframes sidecar's `html` artifacts — the CLEAR ERROR the agent never got.
//
// The render path is forgiving by design (sidecars.ts coerces: an html artifact over the cap degrades to its text
// projection, a missing html degrades to text, the sanitizer strips what it must). That is right for READING —
// a board never goes dark over one bad artifact — and wrong as the only feedback to the WRITER: an agent that
// wrote a 40KB variant, or one whose markup the sanitizer reduces to nothing, got `{ok: true}` and a canvas that
// silently shows an outline instead of its design. This runs on `write_sidecar` (kind `wireframes`) and turns
// those silent degradations into a refusal that names the artifact and the rule — and the survivable-but-lossy
// cases (a script, an external URL, a fixed width past the phone) into WARNINGS in the tool's answer.
// PURE (string → verdict); importable anywhere.

import { sanitizeWireframeHtml } from "./sanitize";
import { WIREFRAME_MOBILE_WIDTH_PX } from "./frame";

/** Mirrors `MAX_HTML_ARTIFACT_BYTES` (index.ts) — duplicated as a literal to avoid an import cycle; the test
 *  pins both to the same value. */
const MAX_HTML_BYTES = 32 * 1024;

export type WireframeValidation = { ok: true; warnings: string[] } | { ok: false; error: string };

/** What the sanitizer will remove from `html`, named for the author (warnings, never errors). PURE. */
function lossyWarnings(id: string, html: string, viewport: unknown): string[] {
  const out: string[] = [];
  if (/<script\b/i.test(html)) out.push(`${id}: <script> é removido na renderização (o frame não roda JS)`);
  if (/\son[a-z]+\s*=/i.test(html)) out.push(`${id}: handlers on*= são removidos (o frame não roda JS)`);
  if (/\s(src|href|srcset)\s*=/i.test(html)) out.push(`${id}: atributos src/href/srcset são removidos (sem rede; imagens são divs estilizadas)`);
  if (/url\(\s*['"]?(?!data:image\/)/i.test(html) || /@import/i.test(html)) {
    out.push(`${id}: url(...)/@import externos são removidos (CSP default-src 'none')`);
  }
  if (/<link\b|<meta\b|<iframe\b|<object\b|<embed\b/i.test(html)) out.push(`${id}: link/meta/iframe/object/embed são removidos`);
  if (viewport !== "desktop") {
    for (const m of html.matchAll(/(?:^|[;{\s"'])(?:min-)?width\s*:\s*(\d{3,5})px/gi)) {
      const px = Number(m[1]);
      if (px > WIREFRAME_MOBILE_WIDTH_PX) {
        out.push(`${id}: largura fixa de ${px}px num artefato mobile — o canvas renderiza em ${WIREFRAME_MOBILE_WIDTH_PX}px; use layout fluido (width:100%; max-width:${WIREFRAME_MOBILE_WIDTH_PX}px)`);
        break;
      }
    }
  }
  return out;
}

/**
 * Validate the CONTENT of a wireframes sidecar before it is written. Refuses (with the artifact id) when:
 *   • the content is not a JSON object;
 *   • an artifact declared `format: "html"` carries no html (it would silently render as text);
 *   • an html artifact exceeds the per-artifact cap (it would silently degrade to its text projection);
 *   • the sanitizer reduces an html artifact to NOTHING (every element was a stripped vector).
 * Warns (the write proceeds) about what the sanitizer will strip and about fixed widths past the phone. PURE.
 */
export function validateWireframeDocContent(content: string): WireframeValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    return { ok: false, error: `wireframes precisa ser JSON válido: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "wireframes precisa ser um objeto JSON ({cardId, options, artifacts, …})" };
  const artifacts = (doc as { artifacts?: unknown }).artifacts;
  if (artifacts != null && !Array.isArray(artifacts)) return { ok: false, error: "`artifacts` precisa ser uma lista" };
  const warnings: string[] = [];
  for (const [i, raw] of (Array.isArray(artifacts) ? artifacts : []).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (a.format !== "html") continue;
    const id = typeof a.id === "string" && a.id.trim() ? a.id : `artifacts[${i}]`;
    if (typeof a.html !== "string" || !a.html.trim()) {
      return { ok: false, error: `${id}: format "html" sem o campo \`html\` (string não vazia) — o canvas mostraria só texto` };
    }
    const bytes = Buffer.byteLength(a.html, "utf8");
    if (bytes > MAX_HTML_BYTES) {
      return {
        ok: false,
        error: `${id}: html com ${bytes} bytes passa do teto de ${MAX_HTML_BYTES} por artefato — acima dele o html é DESCARTADO e só uma projeção em texto sobrevive; enxugue (alvo ≤ 10KB)`,
      };
    }
    if (!sanitizeWireframeHtml(a.html).replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "").trim()) {
      return { ok: false, error: `${id}: depois da sanitização não sobra conteúdo visível (só vetores removidos: script/iframe/head/…) — o canvas ficaria em branco` };
    }
    warnings.push(...lossyWarnings(id, a.html, a.viewport));
  }
  return { ok: true, warnings };
}
