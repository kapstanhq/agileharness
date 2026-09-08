// 🟥 Style Guide — drift audit (D15). PURE: receives file CONTENTS, never touches fs itself — the
// caller (the `sincronizar` assistant mode, the WS-4 view panel, or the read-only MCP tool
// `styleguide_drift`) is the one that reads the board's real CSS off disk and hands the bytes here.
// Reports, never auto-corrects: the real triple divergence a guide can surface (brandbook says one
// hex, a hand-tuned aesthetics skill says another, the shipped code says a third) is a HUMAN decision
// — this module only makes the mismatch visible and mechanical to compute.

import type { StyleGuideDoc } from "./style-guide";

export interface DriftFinding {
  /** the ColorToken.role this finding is about. */
  role: string;
  /** the value the guide DECLARES for this role. */
  declared: string;
  /** the value actually found in the file (absent for "missing-var"/"unreadable"). */
  found?: string;
  file: string;
  kind: "mismatch" | "missing-var" | "unreadable";
  /**
   * D6: a finding computed WITHOUT a declared `tokenBindings` entry (the fallback heuristic guesses
   * `--<role>` as the CSS var name) is marked low-confidence — it may be guessing the wrong variable
   * entirely. A `tokenBindings`-driven finding has no `confidence` (it's a mechanical, data-driven diff).
   */
  confidence?: "low";
}

export interface DriftReport {
  findings: DriftFinding[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the value a token BINDS to out of a file's text — supporting BOTH conventions a `tokenBindings`
 * entry (or the `--<role>` fallback) may name:
 *   • a CSS custom property (`--foreground`) → the `--x: value;` declaration (globals.css / any CSS).
 *   • a config OBJECT path (`colors.mosaico.bg`, or SCSS `$brand`) → the LAST key, matched as a quoted
 *     value `bg: "#E8E6E0"` (tailwind.config.ts / any JS/TS/JSON token source). Without this, a board
 *     that declares its tokens in a Tailwind config (common) could only ever read "missing-var".
 * Pragmatic on the object-path (report-only drift): a wrong-key guess surfaces as a REVIEWABLE
 * mismatch, never a silent pass. Returns the trimmed value, or null when the ref isn't found.
 */
function extractTokenValue(text: string, ref: string): string | null {
  if (ref.startsWith("--")) {
    const m = new RegExp(`${escapeRegExp(ref)}\\s*:\\s*([^;]+);`).exec(text);
    return m ? m[1].trim() : null;
  }
  const lastKey = ref.split(".").pop()!.replace(/^\$/, "");
  if (!lastKey) return null;
  const m = new RegExp(`(?:^|[^\\w-])${escapeRegExp(lastKey)}\\s*:\\s*['"]([^'"]+)['"]`).exec(text);
  return m ? m[1].trim() : null;
}

/**
 * Loose equivalence for two color strings coming from two different authorities (the guide's token
 * vs. a CSS declaration) — strips the wrapping function (`hsl(`/`rgb(`/`oklch(`), case and comma/space
 * noise, then compares the core numbers. Deliberately NOT a full color-space conversion (that would
 * hide a real format mismatch as a false "no drift") — a guide declaring `hsl(220 90% 50%)` against a
 * CSS var literally holding `220 90% 50%` (the shadcn/Tailwind bare-triplet convention feeding
 * `hsl(var(--x))`) is the one wrapper-only case this is meant to catch.
 */
function normalizeColorForCompare(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^(hsl|hsla|rgb|rgba|oklch)\(/, "")
    .replace(/\)$/, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function colorValuesEquivalent(a: string, b: string): boolean {
  return normalizeColorForCompare(a) === normalizeColorForCompare(b);
}

/**
 * Audit the guide's color tokens against the board's real CSS. With `tokenBindings` declared (D6),
 * the diff is MECHANICAL: for each bound role, read `binding.cssVar` out of `binding.file` and
 * compare. Without bindings, falls back to a heuristic guess (`--<role>`) searched across every
 * supplied file — every such finding is marked `confidence: "low"` (it may be the wrong variable).
 */
export function auditTokensAgainstCss(
  doc: StyleGuideDoc,
  files: { path: string; text: string }[],
): DriftReport {
  const findings: DriftFinding[] = [];
  const fileByPath = new Map(files.map((f) => [f.path, f.text]));
  const bindings = doc.tokenBindings;

  if (bindings && Object.keys(bindings).length > 0) {
    for (const [role, binding] of Object.entries(bindings)) {
      const token = doc.color.tokens.find((t) => t.role === role);
      if (!token) continue; // a binding for a role the guide no longer declares — nothing to compare
      const text = fileByPath.get(binding.file);
      if (text == null) {
        findings.push({ role, declared: token.value, file: binding.file, kind: "unreadable" });
        continue;
      }
      const found = extractTokenValue(text, binding.cssVar);
      if (found == null) {
        findings.push({ role, declared: token.value, file: binding.file, kind: "missing-var" });
      } else if (!colorValuesEquivalent(found, token.value)) {
        findings.push({ role, declared: token.value, found, file: binding.file, kind: "mismatch" });
      }
    }
    return { findings };
  }

  // No tokenBindings — heuristic fallback by conventional var name, low-confidence, over every file.
  for (const token of doc.color.tokens) {
    const varName = `--${token.role}`;
    for (const file of files) {
      const found = extractTokenValue(file.text, varName);
      if (found == null) continue;
      if (!colorValuesEquivalent(found, token.value)) {
        findings.push({
          role: token.role,
          declared: token.value,
          found,
          file: file.path,
          kind: "mismatch",
          confidence: "low",
        });
      }
    }
  }
  return { findings };
}
