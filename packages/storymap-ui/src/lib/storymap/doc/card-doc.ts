// 📄 card-doc — bidirectional projection Card ⇄ DocModel (the "card" docType).
//
// The CARD stays the source of truth (cards/<id>.md via updateCardAction). The doc has three
// BOUND regions — properties (read-only mirror), the narrative hero section (read-bound: its text
// is composed FROM narrative and edits to it are ignored — parsing prose back into role/want/soThat
// would be lossy guessing), and the acceptance region (the contiguous todo-run right after the
// `binding:"acceptance"` heading) — plus ONE free region: everything else, which maps 1:1 to
// `card.body` through the canonical codec.
//
// No-op ≡ no-write: commit(project(card), card) returns changed:false and preserves every byte —
// including a NON-canonical body (if the reassembled body only differs from the previous one by
// codec canonicalization, the previous bytes win). Golden-tested in card-doc.test.ts.

import type { Card, Persona } from "../types";
import { blockIdFactory, type DocBlock, type DocModel, type PropEntry } from "./doc-model";
import { parseDocMd, serializeDocMd } from "./md-codec";

export const CARD_DOC_TYPE = "card";

/** Blocks the card doc's editor offers (slash/side-menu). `properties` is projection-owned. */
export const CARD_ALLOWED_BLOCKS: DocBlock["kind"][] = [
  "heading",
  "paragraph",
  "bullet",
  "numbered",
  "todo",
  "toggle",
  "quote",
  "code",
  "table",
  "divider",
  "image",
  "section",
];
export const NARRATIVE_BINDING = "narrative";
export const ACCEPTANCE_BINDING = "acceptance";
export const ACCEPTANCE_LABEL = "Critérios de aceite";

export interface CardDocDeps {
  /** Board vocabulary — colors the persona chips. */
  personas?: Persona[];
  /** Status display name (falls back to the raw status id). */
  statusName?: string | null;
}

export function projectCardDoc(card: Card, deps: CardDocDeps = {}): DocModel {
  const nextId = blockIdFactory();
  const blocks: DocBlock[] = [];

  const entries: PropEntry[] = [];
  if (card.storyType) {
    entries.push({
      key: "storyType",
      label: "Tipo",
      icon: "tag",
      value: { kind: "badge", text: card.storyType },
    });
  }
  if (card.status) {
    entries.push({
      key: "status",
      label: "Status",
      icon: "activity",
      value: { kind: "status", text: deps.statusName ?? card.status },
    });
  }
  if (card.personas?.length) {
    entries.push({
      key: "personas",
      label: "Personas",
      icon: "users",
      value: {
        kind: "chips",
        chips: card.personas.map((id) => {
          const persona = deps.personas?.find((p) => p.id === id);
          return { text: persona?.name ?? id, color: persona?.color };
        }),
      },
    });
  }
  if (card.priorityCall?.rank != null) {
    entries.push({
      key: "priority",
      label: "Prioridade",
      icon: "signal",
      value: { kind: "text", text: `P${card.priorityCall.rank}` },
    });
  }
  if (entries.length) blocks.push({ kind: "properties", id: nextId(), entries });

  const narrative = card.narrative;
  if (narrative && (narrative.role || narrative.want || narrative.soThat)) {
    blocks.push({
      kind: "section",
      id: nextId(),
      label: "Declaração da story",
      tone: "hero",
      binding: NARRATIVE_BINDING,
      body: [
        {
          kind: "paragraph",
          id: nextId(),
          text: `Como **${narrative.role ?? "?"}**, quero ${narrative.want ?? "?"}, para ${narrative.soThat ?? "?"}.`,
        },
      ],
    });
  }

  if (card.acceptance?.length) {
    blocks.push({
      kind: "heading",
      id: nextId(),
      level: 2,
      text: ACCEPTANCE_LABEL,
      icon: "list-checks",
      binding: ACCEPTANCE_BINDING,
    });
    for (const criterion of card.acceptance) {
      blocks.push({
        kind: "todo",
        id: nextId(),
        text: criterion,
        checked: card.qaPassed === true,
        readOnlyCheck: true,
      });
    }
  }

  const body = parseDocMd(card.body ?? "", { docType: CARD_DOC_TYPE });
  // Re-id body blocks into this doc's sequence so ids stay unique across regions.
  blocks.push(...reId(body.blocks, nextId));

  return { docType: CARD_DOC_TYPE, title: card.title ?? "", blocks };
}

export interface CommitCardDocResult {
  card: Card;
  changed: boolean;
}

/**
 * Reassemble the card from an edited doc. Bound regions: narrative section edits are IGNORED
 * (read-bound), the acceptance todo-run becomes `acceptance[]`, everything unbound becomes `body`.
 */
export function commitCardDoc(model: DocModel, prev: Card): CommitCardDocResult {
  const free: DocBlock[] = [];
  let acceptance: string[] | null = null;
  let inAcceptance = false;

  // Anchor rule: the binding wins; the LABEL is only a second net for when an editor surface
  // dropped heading bindings (see reattachBindings in doc-model.ts) — and then only the FIRST
  // matching heading anchors, so a body that legitimately contains its own "Critérios de aceite"
  // heading never hijacks (or duplicates into) the bound region.
  const hasBoundHeading = model.blocks.some(
    (b) => b.kind === "heading" && b.binding === ACCEPTANCE_BINDING,
  );
  let anchorUsed = false;

  for (const block of model.blocks) {
    if (block.kind === "properties") continue;
    if (block.kind === "section" && block.binding === NARRATIVE_BINDING) {
      inAcceptance = false;
      continue;
    }
    const anchors =
      block.kind === "heading" &&
      !anchorUsed &&
      (hasBoundHeading ? block.binding === ACCEPTANCE_BINDING : block.text === ACCEPTANCE_LABEL);
    if (anchors) {
      acceptance = [];
      inAcceptance = true;
      anchorUsed = true;
      continue;
    }
    if (inAcceptance && block.kind === "todo") {
      acceptance!.push(block.text);
      continue;
    }
    inAcceptance = false;
    free.push(block);
  }

  const title = model.title.trim() || (prev.title ?? "");
  const nextAcceptance = acceptance ?? prev.acceptance ?? [];
  let body = serializeDocMd({ docType: model.docType, title: "", blocks: free });
  const prevBody = prev.body ?? "";
  // Canonicalization alone never counts as a change: if the previous body parses+serializes to the
  // SAME bytes we just produced, the user didn't touch the free region — keep the original bytes.
  if (body !== prevBody) {
    const prevCanonical = serializeDocMd({
      docType: model.docType,
      title: "",
      blocks: parseDocMd(prevBody, { docType: model.docType }).blocks,
    });
    if (prevCanonical === body) body = prevBody;
  }

  const changed =
    title !== (prev.title ?? "") ||
    body !== prevBody ||
    JSON.stringify(nextAcceptance) !== JSON.stringify(prev.acceptance ?? []);

  const card: Card = { ...prev, title, acceptance: nextAcceptance, body };
  return { card, changed };
}

function reId(blocks: DocBlock[], nextId: () => string): DocBlock[] {
  return blocks.map((block) => {
    const withId = { ...block, id: nextId() } as DocBlock;
    if (withId.kind === "toggle") withId.children = reId(withId.children, nextId);
    if (withId.kind === "section") withId.body = reId(withId.body, nextId);
    return withId;
  });
}
