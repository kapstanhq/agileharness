"use client";

// WS-0 (copilot-actionability, §0.4) — thin sugar over the `escalate` case for surfaces that only want the
// HITL button (D14: /processes and /perguntas get no chat of their own; the button navigates to the board
// with the drawer seeded). No network of its own — it just composes the escalate QuickAction and hands it
// to the single dispatcher.

import { buildEscalateAction } from "@/lib/storymap/quick-actions";
import type { EscalationRef } from "@/lib/storymap/copilot/escalation";
import { QuickActionButton } from "../QuickActionButton";

export function EscalateButton({
  target,
  label = "Jido",
  size,
  surface,
  className,
}: {
  /** NOT named `ref` — reserved by React. */
  target: EscalationRef;
  label?: string;
  size?: "sm" | "md";
  surface: string;
  className?: string;
}) {
  // The destination board comes from target.boardId (no separate boardId prop).
  return (
    <QuickActionButton
      action={buildEscalateAction(target, label)}
      boardId={target.boardId}
      surface={surface}
      size={size}
      className={className}
    />
  );
}
