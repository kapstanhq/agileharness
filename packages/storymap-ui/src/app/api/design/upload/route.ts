// 🟥 Style Guide (bloco de Design, WS-2) — POST /api/design/upload: persists ONE reference image for
// the async guide generation (D7/D8). Clone enxuto de `api/copilot/upload/route.ts`, com uma diferença
// deliberada (D12): NENHUMA dependência de imagem server-side (sharp existe no node_modules só por
// hoisting de outros packages — não confiar) e o mime NUNCA é o `Blob.type` declarado pelo cliente —
// é sniffado dos primeiros bytes (design-upload-guard.ts). Downscale/re-encode a 1568px é CLIENT-side
// (idioma `SmartCaptureModal.downscaleToDataUrl`).
//
// Refs são IMUTÁVEIS por batch (D12): a PRIMEIRA chamada (sem `batch` no form) gera um `batchId`
// server-side e o devolve; chamadas seguintes reenviam esse `batchId` para acumular no MESMO lote.
// Filename 100% server-generated (`ref-<n>.<ext>`) — o nome do arquivo do cliente NUNCA é lido.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { designRefsDir } from "@/lib/storymap/paths";
import {
  batchIsFull,
  isRefSizeOk,
  isValidRefFilename,
  isValidSlugId,
  MAX_REF_BYTES,
  MAX_REFS_PER_BATCH,
  nextRefIndex,
  sniffImageExt,
} from "@/lib/storymap/design-upload-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }

  const boardRaw = form.get("board");
  const boardId = typeof boardRaw === "string" ? boardRaw : "";
  if (!isValidSlugId(boardId)) {
    return Response.json({ ok: false, error: "board inválido" }, { status: 400 });
  }

  const batchRaw = form.get("batch");
  const suppliedBatch = typeof batchRaw === "string" ? batchRaw : "";
  if (suppliedBatch && !isValidSlugId(suppliedBatch)) {
    return Response.json({ ok: false, error: "batch inválido" }, { status: 400 });
  }
  // First call of a generation → mint a fresh batch id; the caller carries it into every later call so
  // the whole upload session lands in the SAME immutable batch dir (D12).
  const batchId = suppliedBatch || randomUUID().replace(/-/g, "").slice(0, 16);

  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return Response.json({ ok: false, error: "missing 'file'" }, { status: 400 });
  }
  if (!isRefSizeOk(file.size)) {
    return Response.json(
      { ok: false, error: `arquivo fora do limite (máx ${Math.round(MAX_REF_BYTES / 1024)}KB)` },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // NEVER trust `file.type` (client-declared) — sniff the real bytes (D12).
  const ext = sniffImageExt(buf);
  if (!ext) {
    return Response.json(
      { ok: false, error: "tipo de imagem não suportado (use PNG, JPEG ou WEBP)" },
      { status: 415 },
    );
  }

  const dir = designRefsDir(boardId, batchId);
  await mkdir(dir, { recursive: true });
  const existing = (await readdir(dir).catch(() => [] as string[])).filter(isValidRefFilename);
  if (batchIsFull(existing.length)) {
    return Response.json(
      { ok: false, error: `máx ${MAX_REFS_PER_BATCH} referências por lote` },
      { status: 413 },
    );
  }

  const filename = `ref-${nextRefIndex(existing.length)}.${ext}`;
  await writeFile(path.join(dir, filename), buf);

  return Response.json({
    ok: true,
    batchId,
    file: filename,
    // relative path stored on the guide/proposal (D8/D12 shape: "refs/<batchId>/ref-N.ext")
    path: `refs/${batchId}/${filename}`,
    url: `/api/design/ref?board=${encodeURIComponent(boardId)}&batch=${encodeURIComponent(batchId)}&file=${encodeURIComponent(filename)}`,
    bytes: buf.length,
  });
}
