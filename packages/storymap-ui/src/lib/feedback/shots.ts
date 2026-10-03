// Region-screenshot guards for the feedback overlay (6b). PURE — no fs, no Request — so every check
// the two `/api/feedback/shot` routes make BEFORE touching disk is unit-testable on its own. Mirrors
// the discipline of design-upload-guard.ts (whose sniffImageExt/isValidSlugId/refContentType this
// REUSES rather than re-implements): never trust a client-declared mime, never a client filename.
//
// The image travels OUT-OF-BAND (its own upload) and only its URL rides in the AnnotationBatch — the
// keystone stays bytes-free, exactly as anchor.screenshotRef was designed for ("a path, never raw
// bytes here"). That also decouples the upload from card creation: a triage batch has no card yet.

/** Server-generated filenames only: `shot-<n>.<ext>`. Anchored both ends → `..`, a nested path or a
 *  stray query fragment folded into the value all fail closed. */
export const SHOT_FILENAME_RE = /^shot-\d+\.(png|jpe?g|webp)$/;

export function isValidShotFilename(name: unknown): name is string {
  return typeof name === "string" && SHOT_FILENAME_RE.test(name);
}

/** Per-image cap. A cropped region PNG is small; this bounds a hostile/huge paste well below the
 *  point where it would bloat the board repo. */
export const MAX_SHOT_BYTES = 3 * 1024 * 1024;

export function isShotSizeOk(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_SHOT_BYTES;
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Decode a `data:image/...;base64,...` URL into bytes. Returns null for anything that isn't one of
 * the three whitelisted image types (an svg/gif/heic data URL, a `javascript:` string, junk base64).
 * The DECODED bytes are still sniffed by the caller — a valid-looking prefix proves nothing.
 */
export function decodeImageDataUrl(raw: unknown): Uint8Array | null {
  if (typeof raw !== "string" || raw.length < 32) return null;
  const m = DATA_URL_RE.exec(raw.trim());
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], "base64");
    return buf.length ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

/** The serve URL for a stored shot — the value that lands in `anchor.screenshotRef` and therefore in
 *  the card's markdown. Same-origin PATH (never absolute), so the card renders it without reaching
 *  out to any other host. */
export function shotUrl(boardId: string, batchId: string, file: string): string {
  const q = new URLSearchParams({ board: boardId, batch: batchId, file });
  return `/api/feedback/shot?${q.toString()}`;
}

// NOTE: the "is this screenshotRef safe to embed in a card" guard lives in schema.ts (isSafeScreenshotRef)
// — it is a SCHEMA-boundary concern and schema.ts is deliberately dependency-free (this module reaches
// for node's Buffer), so keeping it there avoids dragging a server-only import into the keystone.
