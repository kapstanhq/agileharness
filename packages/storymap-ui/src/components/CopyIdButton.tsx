"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Copy a card id to the clipboard with a brief visual confirmation (Copy → Check).
 * The id is now permanent + immutable for a card's whole life (see id.ts → pinCardId),
 * so a copied id is a durable reference for parent/links, run branches and chat —
 * which is exactly why the card-id-immutability fix adds this affordance. Stops event
 * propagation so it never triggers the card's open/drag handlers, and degrades to a
 * no-op when the clipboard API is unavailable (insecure context).
 */
export function CopyIdButton({ id, className }: { id: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard?.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked (insecure context / denied) — silently no-op */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      // dnd-kit listeners live on the card container; swallow the pointer so a click
      // on the copy button never starts a drag or focuses/opens the card.
      onPointerDown={(e) => e.stopPropagation()}
      title={copied ? "Id copiado!" : "Copiar id"}
      aria-label={copied ? "Id copiado" : `Copiar id ${id}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded p-0.5 text-fg-subtle transition hover:bg-surface-hover hover:text-fg-muted",
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-700 dark:text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
