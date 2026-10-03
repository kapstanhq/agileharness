"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A small, consistent confirmation dialog — the in-app replacement for `window.confirm`.
 * Used to guard any action that's hard to undo or easy to fire by accident (deleting a
 * card, a non-drag move). `tone="danger"` paints the confirm button red and shows a
 * warning icon. Optional `children` render extra context (e.g. a "de → para" preview).
 * Dismiss on the backdrop, Escape, or Cancelar.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "default",
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** trava o botão de confirmar durante uma ação em andamento (mostra opacidade reduzida). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5">
          {tone === "danger" && (
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">{title}</p>
            {description && <p className="mt-0.5 text-[12px] leading-snug text-fg-muted">{description}</p>}
          </div>
        </div>

        {children && <div className="mt-3">{children}</div>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-fg-muted transition hover:bg-surface-hover"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold shadow-sm transition disabled:opacity-50",
              tone === "danger"
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-primary text-primary-fg hover:bg-primary-hover",
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A compact "de coluna → para coluna" preview, shared by the move confirmations. */
export function MovePreview({
  fromName,
  fromColor,
  toName,
  toColor,
}: {
  fromName: string;
  fromColor: string;
  toName: string;
  toColor: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-inset px-3 py-2.5">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: fromColor }} />
        <span className="truncate text-[12px] text-fg-muted">{fromName}</span>
      </span>
      <span className="shrink-0 text-fg-subtle">→</span>
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: toColor }} />
        <span className="truncate text-[12px] font-medium text-fg">{toName}</span>
      </span>
    </div>
  );
}
