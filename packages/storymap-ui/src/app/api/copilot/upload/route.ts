// F4.1 — upload de imagem colada/arrastada/anexada no chat do Jido. Clone enxuto da terminal/upload:
// persiste sob `.artifacts/screenshots/` (convenção de capturas efêmeras) e devolve o path ABSOLUTO, que a
// sessão headless do chat (F1, --dangerously-skip-permissions) abre com a tool Read.
//
// AUTH: alcançável só pelo catch-all `handle {}` do Caddy (basic_auth + TLS) — mesma fronteira do board.
// O filename é 100% gerado no servidor (nunca do cliente) → a escrita não escapa do dir de screenshots.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generoso p/ foto de celular, limita memória.

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

  // Nome gerado no servidor (nunca o filename do cliente) — path inguessável, confinado ao dir. `copilot-` marca a origem.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const name = `copilot-${stamp}-${rand}.${ext}`;
  const abs = path.join(dir, name);

  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(abs, buf);

  return Response.json({ ok: true, path: abs, rel: path.join(".artifacts", "screenshots", name), bytes: buf.length });
}
