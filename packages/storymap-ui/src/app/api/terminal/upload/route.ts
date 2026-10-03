// Image upload for the web terminal (/terminal). The mobile/desktop terminal page can't
// paste images into the tmux stream (the ttyd websocket only carries text), so instead it
// POSTs the image here; we persist it under `.artifacts/screenshots/` (the repo convention
// for ephemeral captures) and return the absolute path. The page then types that path into
// the active Claude session, where the Read tool can open it.
//
// Reachable only through Caddy's catch-all `handle {}` block, which is behind basic_auth +
// TLS — same trust boundary as the board itself. The filename is fully server-generated
// (never derived from client input) so the write can't escape the screenshots dir.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for phone photos, bounds memory.

// mime → extension whitelist. Anything else is rejected (no arbitrary file writes).
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
};

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return Response.json({ ok: false, error: "missing 'file'" }, { status: 400 });
  }

  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return Response.json({ ok: false, error: `unsupported type '${file.type || "unknown"}'` }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: `too large (${file.size} > ${MAX_BYTES} bytes)` }, { status: 413 });
  }

  const dir = path.join(findRepoRoot(), ".artifacts", "screenshots");
  await mkdir(dir, { recursive: true });

  // Server-generated name — never the client filename — so the path is unguessable and
  // confined to the screenshots dir. `term-` prefix marks the web-terminal source.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const name = `term-${stamp}-${rand}.${ext}`;
  const abs = path.join(dir, name);

  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(abs, buf);

  return Response.json({
    ok: true,
    path: abs,
    rel: path.join(".artifacts", "screenshots", name),
    bytes: buf.length,
  });
}
