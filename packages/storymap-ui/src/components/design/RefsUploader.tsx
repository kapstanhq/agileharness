"use client";

// 🟥 Style Guide (bloco de Design, WS-2) — the intake's reference-image dropzone. Downscale/re-encode
// is CLIENT-side (idiom `SmartCaptureModal.downscaleToDataUrl`): longest edge 1568px (Claude's
// recommended vision ceiling), re-encoded webp ~0.85 quality — the server (`/api/design/upload`) only
// VALIDATES (magic bytes, size, per-batch cap), it never processes images (D12). Uploads run
// SEQUENTIALLY (never Promise.all) — the server assigns `ref-<n>` by counting what's already in the
// batch dir, so a serial client is what keeps that count race-free without any server-side locking.
import { useRef, useState } from "react";
import { ImageUp, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";

/** What the view keeps per uploaded ref: the canonical relative path (what rides on the guide/proposal)
 *  and the URL to actually display it (the GET route). */
export interface UploadedRef {
  path: string; // "refs/<batchId>/ref-N.ext"
  url: string; // "/api/design/ref?board=...&batch=...&file=..."
}

const MAX_DIM = 1568;
const MAX_REFS = 12;

async function downscaleToBlob(file: File): Promise<Blob> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("Falha ao ler a imagem."));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Imagem inválida."));
    im.src = dataUrl;
  });
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponível para redimensionar.");
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (blob) return blob;
  // A browser without webp encoding support — fall back to the original bytes (still under the
  // server's 500KB cap for most reference photos; the server will 413 the rare exception).
  return await file.arrayBuffer().then((buf) => new Blob([buf], { type: file.type || "image/png" }));
}

export function RefsUploader({
  boardId,
  refs,
  onChange,
  disabled,
}: {
  boardId: string;
  refs: UploadedRef[];
  onChange: (next: UploadedRef[]) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const batchIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadOne = async (file: File): Promise<UploadedRef> => {
    const blob = await downscaleToBlob(file);
    const fd = new FormData();
    fd.append("board", boardId);
    if (batchIdRef.current) fd.append("batch", batchIdRef.current);
    // The filename here is COSMETIC ONLY — the server never reads it (sniffs bytes, generates its own).
    fd.append("file", blob, "ref.webp");
    const res = await fetch("/api/design/upload", { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error ?? "falha no upload");
    batchIdRef.current = body.batchId;
    return { path: body.path as string, url: body.url as string };
  };

  const handleFiles = async (files: FileList | File[] | null | undefined): Promise<void> => {
    if (!files || files.length === 0) return;
    setError(null);
    const room = MAX_REFS - refs.length;
    if (room <= 0) {
      setError(`Máximo de ${MAX_REFS} referências por lote.`);
      return;
    }
    const list = Array.from(files).slice(0, room);
    setBusy(true);
    const next = [...refs];
    for (const file of list) {
      try {
        next.push(await uploadOne(file)); // sequential on purpose — see the file header note.
      } catch (e) {
        setError(e instanceof Error ? e.message : "falha no upload");
        break;
      }
    }
    onChange(next);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void handleFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          if (e.clipboardData?.files?.length) void handleFiles(e.clipboardData.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-muted p-4 text-center transition hover:border-accent/50",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <ImageUp className="h-5 w-5 text-fg-subtle" />
        <span className="text-[12px] text-fg-muted">Arraste, cole ou anexe imagens de referência</span>
        <span className="text-[10px] text-fg-subtle">até {MAX_REFS} imagens · máx 500KB cada</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          capture="environment"
          className="hidden"
          disabled={disabled}
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </div>

      {busy && (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-fg-subtle">
          <Loader2 className="h-3 w-3 animate-spin" /> Enviando…
        </p>
      )}
      {error && <p className="text-[11px] text-rose-600 dark:text-rose-300">{error}</p>}

      {refs.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {refs.map((r, i) => (
            <div key={r.path} className="group relative aspect-square overflow-hidden rounded-md border border-line-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, not next/image-optimizable */}
              <img src={r.url} alt={`referência ${i + 1} do guia`} className="h-full w-full object-cover" />
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(refs.filter((_, idx) => idx !== i));
                }}
                aria-label={`Remover referência ${i + 1}`}
                className="absolute right-0.5 top-0.5 hidden rounded-full bg-black/60 p-0.5 text-white group-hover:block"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
