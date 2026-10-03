// 🟥 Style Guide (bloco de Design, WS-2) — pure guards for the two `/api/design/*` routes (D12). No
// fs/network here on purpose: every check a route needs BEFORE touching disk lives in this module so
// it's unit-testable without spinning up a Request/Response pair. Mirrors the discipline of the rest
// of the kernel (style-guide.ts) — tolerant where useful, but these are boolean gates, not coercers.
//
// D12 — no server-side image-processing dependency in v1 (sharp is only on disk via hoisting from
// OTHER packages; never trust it's there). The only defense against a mislabeled/malicious upload is
// sniffing the REAL file type from its first bytes — the client-declared `Blob.type` (and certainly a
// client-supplied filename) is never trusted.

import { sanitizeId } from "./paths";

export type DesignRefExt = "png" | "jpg" | "webp";

/** Per-file cap (D12) — generous for a downscaled 1568px reference, small enough that 12 of them are
 *  a bounded git diff (refs are committed, D12). */
export const MAX_REF_BYTES = 500 * 1024;

/** Per-batch cap (D12) — a batch is immutable once refs exist in it, so this bounds one generation's cost. */
export const MAX_REFS_PER_BATCH = 12;

/** Server-generated filenames only: `ref-<n>.<ext>` — NEVER the client's name. Anchored both ends, so
 *  `..`, a nested path, or a stray query fragment folded into the value all fail closed. */
export const REF_FILENAME_RE = /^ref-\d+\.(png|jpe?g|webp)$/;

export function isValidRefFilename(name: string): boolean {
  return typeof name === "string" && REF_FILENAME_RE.test(name);
}

/** A board/batch id is valid when the RAW value survives `sanitizeId` unchanged — anything that would
 *  be silently stripped (`..`, `/`, a space) is rejected outright instead of quietly truncated into a
 *  different (but plausible-looking) id. */
export function isValidSlugId(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 100 && sanitizeId(raw) === raw;
}

export function isRefSizeOk(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_REF_BYTES;
}

/** Has this batch already reached the per-batch cap? Pure over the count so the route's readdir result
 *  is trivially testable without touching a filesystem. */
export function batchIsFull(existingRefCount: number): boolean {
  return existingRefCount >= MAX_REFS_PER_BATCH;
}

/** The 1-based index the NEXT ref in this batch gets — contiguous with whatever's already on disk. */
export function nextRefIndex(existingRefCount: number): number {
  return existingRefCount + 1;
}

const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpg: [0xff, 0xd8, 0xff],
} as const;

/**
 * Sniff the REAL image type from its first bytes — png/jpg/webp only (the whitelist the whole
 * upload path enforces). Returns null for anything else (svg, gif, heic, a renamed .exe, …), which the
 * route turns into a 415. Never throws on a short/empty buffer.
 */
export function sniffImageExt(buf: Uint8Array): DesignRefExt | null {
  if (buf.length >= MAGIC.png.length && MAGIC.png.every((b, i) => buf[i] === b)) return "png";
  if (buf.length >= MAGIC.jpg.length && MAGIC.jpg.every((b, i) => buf[i] === b)) return "jpg";
  // WEBP = a RIFF container: bytes 0-3 "RIFF", 8-11 "WEBP".
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

export const REF_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Content-Type for a validated `ref-N.<ext>` filename — falls back to a safe generic octet-stream for
 *  anything the (already-enforced) whitelist wouldn't have let through in the first place. */
export function refContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return REF_CONTENT_TYPE[ext] ?? "application/octet-stream";
}
