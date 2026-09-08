// deriveLink — the ONE place a destination link is normalised from a (possibly partial) intent into
// a linkSchema-valid AnnotationLink. Every producer resolves to the SAME rules here: the vanilla
// overlay's mount-time logic today (mirrored by hand, like renderBatchMarkdown, since the IIFE can't
// import TS), the send-step PICKER in a later slice, and a CLI/adapter in Fase 4. The broker also
// runs it defensively so a sloppy producer can't route wrong. Pure: no DOM, no fs → unit-testable.
//
// Rules — routing stays link.kind-only; this NEVER invents a second routing signal:
//   - an EXPLICIT kind (card|session|none) is respected; an unknown/absent kind is INFERRED from
//     which selection is present (cardId → card, sessionId → session, neither → none);
//   - a routed kind that lacks its target degrades to "none" (a card with no id can't be refined);
//   - only the fields that matter for the resolved kind are carried (board always, when present).

import { type AnnotationLink, linkSchema } from "./schema";

export interface DeriveLinkInput {
  kind?: string | null;
  board?: string | null;
  cardId?: string | null;
  sessionId?: string | null;
}

function clean(v: string | null | undefined): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length ? s : undefined;
}

export function deriveLink(input: DeriveLinkInput): AnnotationLink {
  const board = clean(input.board);
  const cardId = clean(input.cardId);
  const sessionId = clean(input.sessionId);

  const explicit = input.kind === "card" || input.kind === "session" || input.kind === "none";
  let kind: "card" | "session" | "none" = explicit
    ? (input.kind as "card" | "session" | "none")
    : cardId
      ? "card"
      : sessionId
        ? "session"
        : "none";

  // A routed kind MUST carry its target — otherwise it can't route, so degrade to "none".
  if (kind === "card" && !cardId) kind = "none";
  if (kind === "session" && !sessionId) kind = "none";

  const link: AnnotationLink = { kind };
  if (board) link.board = board;
  if (kind === "card") link.cardId = cardId;
  if (kind === "session") link.sessionId = sessionId;

  // Self-checking seam: the output is guaranteed linkSchema-valid (and strips anything foreign).
  return linkSchema.parse(link);
}
