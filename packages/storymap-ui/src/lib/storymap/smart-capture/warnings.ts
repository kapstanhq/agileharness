// Fase 4.1 — PURE correlation of a batch commit's CardCommitWarnings to a human-facing view. Each warning
// (a placement the proposal asked for that commitProposalAction couldn't honor) is paired with the created
// card's TITLE (from the proposed item it came from, by tempId) and its real id (resolved server-side via the
// commit's tempId→id map and exposed as warning.cardId) so the capture HUB / Inbox can list
// "«title» — detail" with a "Ver card" link. Node-unit-testable (no React/IO).

import type { CardCommitWarning } from "@/lib/storymap/types";

export interface CaptureWarningView {
  code: CardCommitWarning["code"];
  detail: string;
  /** the created card's title (from the proposed item, by tempId) — the human-readable subject. */
  title: string;
  /** the created card's real id when resolvable (→ a "Ver card" link); null when it couldn't be paired. */
  cardId: string | null;
}

/**
 * Pair each warning with its proposed item's title + the created card id. `cardId` comes RESOLVED on the
 * warning (server-side tempToReal in commitProposalAction); `title` is looked up from the items by tempId,
 * with the same empty-title fallback ("Sem título") the commit itself uses (actions.ts:670,824) so the
 * subject reads identically. Order is preserved.
 */
export function correlateCommitWarnings(
  items: readonly { tempId: string; title: string }[],
  warnings: readonly CardCommitWarning[],
): CaptureWarningView[] {
  return warnings.map((w) => {
    const item = items.find((i) => i.tempId === w.tempId);
    return {
      code: w.code,
      detail: w.detail,
      title: item?.title.trim() || "Sem título",
      cardId: w.cardId ?? null,
    };
  });
}
