// Núcleo PURO da árvore de proposta de captura — extraído do CockpitView (F0) para ser a ÚNICA fonte da
// hierarquia activity→step→story exibida tanto no modal síncrono quanto no Inbox. Transforma o
// ProposedItem[] PLANO numa árvore agrupada por onde cada raiz pendura no backbone existente, e provê os
// helpers de SELEÇÃO EM CASCATA DURA (parent-closed): marcar um filho liga os ancestrais; desmarcar um
// pai desliga toda a subárvore — assim nunca existe filho marcado sob pai desmarcado (zero órfãos).

import type { StoryType } from "../frameworks";
import type { ProposedItem } from "./types";

export interface ProposalTreeNode {
  item: ProposedItem;
  /** the EXISTING card id this node hangs under (root-level only), else null */
  existingParent: string | null;
  children: ProposalTreeNode[];
}

/** Sort key: backbone order (activity → step → story → idea), then original index for stability. */
const TYPE_ORDER: Record<ProposedItem["type"], number> = { activity: 0, step: 1, story: 2, idea: 3 };

export function buildProposalTree(items: ProposedItem[]): {
  /** roots grouped by the existing card id they hang under (null = unplaced backlog). */
  groups: { existingParent: string | null; roots: ProposalTreeNode[] }[];
} {
  const tempIds = new Set(items.map((i) => i.tempId));
  const origIndex = new Map(items.map((i, idx) => [i.tempId, idx] as const));

  // children buckets keyed by the in-proposal parent tempId
  const childrenOf = new Map<string, ProposedItem[]>();
  const roots: ProposedItem[] = [];

  for (const it of items) {
    const p = it.parent ?? null;
    // A child is one whose parent is ANOTHER item in this batch. Everything else is a root:
    // null parent, an existing-card id, or a dangling tempId (parent not in the batch).
    if (p && tempIds.has(p) && p !== it.tempId) {
      const bucket = childrenOf.get(p) ?? [];
      bucket.push(it);
      childrenOf.set(p, bucket);
    } else {
      roots.push(it);
    }
  }

  const sortItems = (a: ProposedItem, b: ProposedItem) => {
    const t = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
    if (t !== 0) return t;
    return (origIndex.get(a.tempId) ?? 0) - (origIndex.get(b.tempId) ?? 0);
  };

  // Recursively materialize a node, depth-capped against cycles.
  const seen = new Set<string>();
  const MAX_DEPTH = 8;
  const toNode = (it: ProposedItem, depth: number, existingParent: string | null): ProposalTreeNode => {
    if (seen.has(it.tempId) || depth >= MAX_DEPTH) {
      return { item: it, existingParent, children: [] };
    }
    seen.add(it.tempId);
    const kids = (childrenOf.get(it.tempId) ?? [])
      .slice()
      .sort(sortItems)
      .map((k) => toNode(k, depth + 1, null));
    return { item: it, existingParent, children: kids };
  };

  // Group roots by the existing card id they hang under. A root's existingParent is its
  // parent when that parent is NOT a tempId of the batch (i.e. a live card id); null otherwise.
  const groupKey = (it: ProposedItem): string | null => {
    const p = it.parent ?? null;
    if (p && !tempIds.has(p)) return p; // points at a real, existing card → live backbone anchor
    return null; // unplaced (null) or dangling tempId → no live anchor
  };

  const byGroup = new Map<string | null, ProposedItem[]>();
  for (const r of roots.slice().sort(sortItems)) {
    const k = groupKey(r);
    const bucket = byGroup.get(k) ?? [];
    bucket.push(r);
    byGroup.set(k, bucket);
  }

  // Emit unplaced group first (null), then existing-anchor groups in first-seen order.
  const groups: { existingParent: string | null; roots: ProposalTreeNode[] }[] = [];
  if (byGroup.has(null)) {
    groups.push({
      existingParent: null,
      roots: byGroup.get(null)!.map((r) => toNode(r, 0, null)),
    });
  }
  for (const [k, rs] of byGroup) {
    if (k === null) continue;
    groups.push({ existingParent: k, roots: rs.map((r) => toNode(r, 0, k)) });
  }

  // Defensive: an item unreachable in the tree (a parent CYCLE A↔B drops both to children with no
  // root, or a depth-cap cutoff) would vanish from the list yet stay default-checked and get created
  // on "Aceitar" — a present-but-invisible mismatch. Collect every rendered tempId and append the
  // leftovers as a flat fallback group so what you SEE is exactly what gets created.
  const rendered = new Set<string>();
  const walk = (n: ProposalTreeNode) => {
    rendered.add(n.item.tempId);
    n.children.forEach(walk);
  };
  groups.forEach((g) => g.roots.forEach(walk));
  const orphans = items.filter((i) => !rendered.has(i.tempId));
  if (orphans.length) {
    groups.push({
      existingParent: null,
      roots: orphans.slice().sort(sortItems).map((it) => ({ item: it, existingParent: null, children: [] })),
    });
  }

  return { groups };
}

// ── Hard-cascade selection (parent-closed) ───────────────────────────────────────────────────────────
// The selection is a Set of tempIds = exactly the cards that WILL be created. We keep it "parent-closed":
// every selected node's in-batch parent is also selected. This makes orphans impossible (a selected story
// always has its selected step/activity), so "Aceitar e criar (N)" never lies about the blast radius.

/** Map of in-batch parent → children tempIds (only edges INSIDE the batch). */
function childIndex(items: ProposedItem[]): Map<string, string[]> {
  const tempIds = new Set(items.map((i) => i.tempId));
  const m = new Map<string, string[]>();
  for (const it of items) {
    const p = it.parent ?? null;
    if (p && tempIds.has(p) && p !== it.tempId) {
      const b = m.get(p) ?? [];
      b.push(it.tempId);
      m.set(p, b);
    }
  }
  return m;
}

/** In-batch parent of a tempId, or null when it's a root (null/existing-card/dangling parent). */
function parentIndex(items: ProposedItem[]): Map<string, string> {
  const tempIds = new Set(items.map((i) => i.tempId));
  const m = new Map<string, string>();
  for (const it of items) {
    const p = it.parent ?? null;
    if (p && tempIds.has(p) && p !== it.tempId) m.set(it.tempId, p);
  }
  return m;
}

/** All in-batch descendants of `tempId` (BFS, cycle-safe). */
export function descendantTempIds(items: ProposedItem[], tempId: string): Set<string> {
  const kids = childIndex(items);
  const out = new Set<string>();
  const queue = [...(kids.get(tempId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const k of kids.get(id) ?? []) queue.push(k);
  }
  return out;
}

/** The chain of in-batch ancestors of `tempId` (nearest first), cycle-safe. */
export function ancestorTempIds(items: ProposedItem[], tempId: string): string[] {
  const parents = parentIndex(items);
  const out: string[] = [];
  const seen = new Set<string>([tempId]);
  let cur = parents.get(tempId);
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parents.get(cur);
  }
  return out;
}

/** The default selection = everything (the agent proposed it; the human prunes). */
export function selectAll(items: ProposedItem[]): Set<string> {
  return new Set(items.map((i) => i.tempId));
}

/**
 * Toggle a node with HARD CASCADE (parent-closed): turning ON adds the node, all its descendants AND its
 * ancestor chain (so the parent is always selected); turning OFF removes the node and its whole subtree.
 * Returns a NEW Set.
 */
export function cascadeSelect(
  items: ProposedItem[],
  selected: Set<string>,
  tempId: string,
  on: boolean,
): Set<string> {
  const next = new Set(selected);
  const desc = descendantTempIds(items, tempId);
  if (on) {
    next.add(tempId);
    desc.forEach((d) => next.add(d));
    ancestorTempIds(items, tempId).forEach((a) => next.add(a));
  } else {
    next.delete(tempId);
    desc.forEach((d) => next.delete(d));
  }
  return next;
}

/** Tri-state of a node for display: on (self + all descendants), off (not selected), or indeterminate
 * (selected, but at least one descendant is not). Under parent-closed cascade an unselected node has no
 * selected descendants, so "off" is always a clean unselected subtree. */
export function nodeCheckState(
  items: ProposedItem[],
  selected: Set<string>,
  tempId: string,
): "on" | "off" | "indeterminate" {
  if (!selected.has(tempId)) return "off";
  const desc = descendantTempIds(items, tempId);
  if (desc.size === 0) return "on";
  for (const d of desc) if (!selected.has(d)) return "indeterminate";
  return "on";
}

/** The REAL number of cards that will be created (parent-closed → exactly the selected set). */
export function effectiveSelectedCount(selected: Set<string>): number {
  return selected.size;
}

// ── Reancoragem de 1 clique ──────────────────────────────────────────────────────────────────────
// "Isto parece a mesma coisa que X" só é útil se o humano puder responder ali mesmo: «então é trabalho
// DE X». Nenhum round-trip de LLM — é uma troca de âncora sobre o item, aplicada ANTES do commit (as
// duas superfícies de revisão mandam os itens que estão na tela para acceptProposal/commitProposal).

/** A nova âncora que uma ação de 1 clique aplica a um item. Campo ausente = não mexe. */
export interface ReanchorPatch {
  parent?: string | null;
  serves?: string | null;
  storyType?: StoryType | null;
  targetCardId?: string | null;
}

/**
 * Aplica a reancoragem ao item `tempId` e devolve uma lista NOVA. Uma definição só, para o modal
 * síncrono e o Inbox não divergirem — inclusive na parte fácil de esquecer: a suspeita de duplicata
 * foi RESOLVIDA pela reancoragem (o item deixa de ser "outro igual" e passa a ser trabalho DAQUELE
 * card), então mantê-la seria mentir sobre o que vai ser criado.
 */
export function applyReanchor(items: ProposedItem[], tempId: string, patch: ReanchorPatch): ProposedItem[] {
  return items.map((i) =>
    i.tempId === tempId
      ? {
          ...i,
          ...(patch.parent !== undefined ? { parent: patch.parent } : {}),
          ...(patch.serves !== undefined ? { serves: patch.serves } : {}),
          ...(patch.storyType !== undefined ? { storyType: patch.storyType } : {}),
          ...(patch.targetCardId !== undefined ? { targetCardId: patch.targetCardId } : {}),
          duplicateOf: null,
        }
      : i,
  );
}
