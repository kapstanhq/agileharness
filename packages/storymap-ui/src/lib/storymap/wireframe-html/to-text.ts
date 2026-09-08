// htmlToText — the code-derived SAFE text projection of an html artifact (MUST-HOLD: raw HTML never
// flows into cardDocumentMarkdown / terminal / copilot prompts; text surfaces read this outline).

const MAX_LINES = 60;
const MAX_CHARS = 2400;

/** Strip an html artifact down to a plain-text outline: tags removed, entities decoded (the common
 *  ones), whitespace collapsed, block boundaries kept as line breaks, bounded. Pure. */
export function htmlToText(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // Block-level closers/openers become newlines so the outline keeps its structure.
  s = s.replace(/<\/(p|div|section|article|header|footer|nav|main|li|tr|h[1-6])\s*>/gi, "\n");
  s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const lines = s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let out = lines.slice(0, MAX_LINES).join("\n");
  if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS - 1)}…`;
  else if (lines.length > MAX_LINES) out = `${out}\n…`;
  return out;
}
