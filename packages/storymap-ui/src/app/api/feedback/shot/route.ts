// /api/feedback/shot — the region SCREENSHOT of a feedback annotation (6b). Two methods, one file:
//
//   POST  { board, dataUrl }        → stores the image, returns its same-origin serve URL
//   GET   ?board=&batch=&file=      → streams those bytes back (the card's <img> src)
//
// WHY a dedicated pair instead of stuffing bytes in the batch: the keystone AnnotationBatch stays
// bytes-free (anchor.screenshotRef was always specced as "a path, never raw bytes"), and the upload
// is decoupled from card creation — a triage batch has NO card until the sink mints one, so a
// card-keyed store would need a move + a rewrite of the reference afterwards.
//
// GET exists because the sidecar zone (`storymap/`) is otherwise WRITE-only — Next serves `public/`
// only — the same gap `/api/design/ref` fills for style-guide refs, whose guards this mirrors.
//
// NEVER CORS, on either method: the read would otherwise let any page hotlink a screenshot of the
// operator's screen. The WRITE has exactly two callers — the board's own UI (same-origin, proven by
// the operator's SESSION cookie checked in this file: the route is public/self-auth since story-14xvpa
// step 2, so the middleware no longer stands in front of it) and a product app's server RELAY
// presenting a board-scoped ingest token (F6). The READ is same-origin + session only. A relay is server-to-server, so it needs no CORS
// header to work — which is why the same-origin invariant for BROWSERS survives this lane intact.
//
// The relay lane exists so a region capture keeps its image end-to-end: without it, feedback coming
// from a product app would silently degrade to DOM-only, and "send the picture" was the whole point of
// drawing a box. A relayed shot is written into the board bound to its TOKEN — never a payload-chosen
// board — so no token can write into a foreign board's sidecar zone.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { selfBoardId } from "@/lib/storymap/self-board";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { checkSameOrigin, checkSameOriginJson } from "@/lib/feedback/guard";
import { INGEST_HEADER, makeIngestResolver, parseIngestTokens } from "@/lib/feedback/ingest";
import { createRateLimiter } from "@/lib/feedback/rate-limit";
import { hasBoardSession, SESSION_REQUIRED_ERROR } from "@/lib/feedback/session-gate";
import { decodeImageDataUrl, isShotSizeOk, isValidShotFilename, shotUrl } from "@/lib/feedback/shots";
import { isValidSlugId, refContentType, sniffImageExt } from "@/lib/storymap/design-upload-guard";
import { feedbackShotsDir } from "@/lib/storymap/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PINNED server-side for the board's own UI (same as the destinations catalog) — never a client-chosen
// board, so no request can write into a foreign board's sidecar zone. A fonte é o env desta
// instalação (`lib/storymap/self-board.ts`); sem board próprio declarado esta lane não tem onde
// escrever, e a rota RECUSA em vez de inventar um destino.

// One batch may legitimately carry several images (one per drawn region), so this ceiling is looser
// than the intake's — it exists to bound DISK, not to count batches. Per board, in-process.
const RELAY_SHOT_LIMIT = 60;
const RELAY_SHOT_WINDOW_MS = 60_000;
const relayShotLimiter = createRateLimiter({ limit: RELAY_SHOT_LIMIT, windowMs: RELAY_SHOT_WINDOW_MS });

export async function POST(request: Request): Promise<Response> {
  // Lane split. A relay ANNOUNCES itself with a token (it has no Origin, so it would otherwise look
  // same-origin — the same hazard classifyIntake closes for the batch endpoint); everything else must
  // pass the same-origin guard exactly as before.
  const ingestToken = request.headers.get(INGEST_HEADER);
  let board = selfBoardId();
  if (ingestToken) {
    const resolved = makeIngestResolver(parseIngestTokens(process.env.AGILEHARNESS_FEEDBACK_INGEST_TOKENS))(ingestToken);
    if (!resolved) {
      return Response.json({ ok: false, error: "token de repasse inválido ou lane desligada" }, { status: 401 });
    }
    const verdict = relayShotLimiter.take(`shot:${resolved}`, Date.now());
    if (!verdict.ok) {
      return Response.json(
        { ok: false, error: "muitas imagens seguidas — tente de novo em instantes" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(verdict.retryAfterMs / 1000)) } },
      );
    }
    board = resolved;
  } else {
    const guard = checkSameOriginJson(request.headers);
    if (!guard.ok) return Response.json({ ok: false, error: guard.error }, { status: guard.status });
    // Same-origin proves the CALLER is a browser on the board's origin; the SESSION proves it is the
    // operator's. Both, before a byte of image is decoded.
    if (!(await hasBoardSession(request.headers))) {
      return Response.json({ ok: false, error: SESSION_REQUIRED_ERROR }, { status: 401 });
    }
    // Sem board próprio declarado não há destino: recusar é a resposta honesta. A lane de repasse
    // (acima) não passa por aqui — ela traz o board DENTRO do token.
    if (!board) {
      return Response.json(
        { ok: false, error: "nenhum board próprio declarado nesta instalação (AGILEHARNESS_SELF_BOARD)" },
        { status: 503 },
      );
    }
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, error: "corpo JSON inválido" }, { status: 400 });
  }

  const dataUrl = (raw as { dataUrl?: unknown } | null)?.dataUrl;
  const bytes = decodeImageDataUrl(dataUrl);
  if (!bytes) {
    return Response.json({ ok: false, error: "dataUrl de imagem inválida (png/jpeg/webp base64)" }, { status: 400 });
  }
  if (!isShotSizeOk(bytes.byteLength)) {
    return Response.json({ ok: false, error: "imagem grande demais" }, { status: 413 });
  }
  // The declared mime proved nothing — sniff the REAL type from the decoded bytes.
  const ext = sniffImageExt(bytes);
  if (!ext) {
    return Response.json({ ok: false, error: "conteúdo não é png/jpeg/webp" }, { status: 415 });
  }

  // SERVER-generated batch id + filename: no part of the write path is client-controlled.
  const batchId = randomBytes(8).toString("hex");
  const file = `shot-1.${ext}`;
  const dir = feedbackShotsDir(board, batchId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), bytes);
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "falha ao gravar a imagem" },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, batchId, file, url: shotUrl(board, batchId, file) });
}

export async function GET(request: Request): Promise<Response> {
  const guard = checkSameOrigin(request.headers);
  if (!guard.ok) return Response.json({ ok: false, error: guard.error }, { status: guard.status });
  // A screenshot of the operator's screen: same-origin AND the operator's session, always.
  if (!(await hasBoardSession(request.headers))) {
    return Response.json({ ok: false, error: SESSION_REQUIRED_ERROR }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const boardId = searchParams.get("board") ?? "";
  const batchId = searchParams.get("batch") ?? "";
  const file = searchParams.get("file") ?? "";

  if (!isValidSlugId(boardId) || !isValidSlugId(batchId)) {
    return Response.json({ ok: false, error: "board/batch inválido" }, { status: 400 });
  }
  if (!isValidShotFilename(file)) {
    return Response.json({ ok: false, error: "arquivo inválido" }, { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = await readFile(path.join(feedbackShotsDir(boardId, batchId), file));
  } catch {
    return Response.json({ ok: false, error: "não encontrado" }, { status: 404 });
  }

  // `new Uint8Array(buf)`: @types/node's generic Buffer isn't structurally assignable to BodyInit.
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { "Content-Type": refContentType(file), "Cache-Control": "private, max-age=300" },
  });
}
