// 🟥 Style Guide (bloco de Design, WS-2) — GET /api/design/ref?board=&batch=&file=: serves ONE
// reference image byte-for-byte. Today the sidecar zone (`storymap/`) is WRITE-only from the app's
// point of view — no route serves it (Next only serves `public/`), so without this the refs uploaded
// by /api/design/upload are invisible to the browser (upload writes, nothing reads).
//
// Guards (D12): `board`/`batch` through the SAME slug guard the upload route uses; `file` validated
// against the exact server-generated shape (`^ref-\d+\.(png|jpe?g|webp)$`) — NEVER treated as a path
// fragment. Short Cache-Control: refs are immutable per batch (D12), but a discarded/superseded
// proposal's refs are GC-eligible, so we don't cache aggressively client-side.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { designRefsDir } from "@/lib/storymap/paths";
import { isValidRefFilename, isValidSlugId, refContentType } from "@/lib/storymap/design-upload-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const boardId = searchParams.get("board") ?? "";
  const batchId = searchParams.get("batch") ?? "";
  const file = searchParams.get("file") ?? "";

  if (!isValidSlugId(boardId) || !isValidSlugId(batchId)) {
    return Response.json({ ok: false, error: "board/batch inválido" }, { status: 400 });
  }
  if (!isValidRefFilename(file)) {
    return Response.json({ ok: false, error: "arquivo inválido" }, { status: 400 });
  }

  const abs = path.join(designRefsDir(boardId, batchId), file);
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch {
    return Response.json({ ok: false, error: "não encontrado" }, { status: 404 });
  }

  // `new Uint8Array(buf)`: @types/node's generic `Buffer<ArrayBufferLike>` isn't structurally
  // assignable to the dom lib's `BodyInit` — a plain Uint8Array is.
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": refContentType(file),
      "Cache-Control": "private, max-age=300",
    },
  });
}
