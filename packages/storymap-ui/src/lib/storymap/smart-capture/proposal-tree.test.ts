import { describe, it, expect } from "vitest";
import {
  buildProposalTree,
  descendantTempIds,
  ancestorTempIds,
  cascadeSelect,
  nodeCheckState,
  selectAll,
  effectiveSelectedCount,
} from "./proposal-tree";
import type { ProposedItem } from "./types";

const mk = (tempId: string, type: ProposedItem["type"], parent: string | null = null, extra: Partial<ProposedItem> = {}): ProposedItem =>
  ({ tempId, type, title: tempId, parent, ...extra }) as ProposedItem;

// a1 ─ s1 ─ st1, st2   (uma atividade → um step → duas stories)
const TREE = [mk("a1", "activity"), mk("s1", "step", "a1"), mk("st1", "story", "s1"), mk("st2", "story", "s1")];

describe("buildProposalTree — hierarquia agrupada", () => {
  it("monta atividade→step→story numa raiz não-encaixada", () => {
    const { groups } = buildProposalTree(TREE);
    expect(groups).toHaveLength(1);
    expect(groups[0].existingParent).toBeNull();
    const a = groups[0].roots[0];
    expect(a.item.tempId).toBe("a1");
    expect(a.children[0].item.tempId).toBe("s1");
    expect(a.children[0].children.map((c) => c.item.tempId)).toEqual(["st1", "st2"]);
  });

  it("agrupa raízes pelo card EXISTENTE em que penduram (parent fora do lote)", () => {
    const items = [mk("st1", "story", "step-feed"), mk("st2", "story", "step-feed")];
    const { groups } = buildProposalTree(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].existingParent).toBe("step-feed");
    expect(groups[0].roots.map((r) => r.item.tempId)).toEqual(["st1", "st2"]);
  });

  it("não perde itens em ciclo (fallback de órfãos)", () => {
    const cycle = [mk("x", "story", "y"), mk("y", "story", "x")];
    const { groups } = buildProposalTree(cycle);
    const rendered = new Set<string>();
    const walk = (n: { item: ProposedItem; children: { item: ProposedItem; children: unknown[] }[] }) => {
      rendered.add(n.item.tempId);
      n.children.forEach((c) => walk(c as never));
    };
    groups.forEach((g) => g.roots.forEach((r) => walk(r as never)));
    expect(rendered.has("x")).toBe(true);
    expect(rendered.has("y")).toBe(true);
  });
});

describe("descendantTempIds / ancestorTempIds", () => {
  it("descendentes de a1 = s1, st1, st2", () => {
    expect(descendantTempIds(TREE, "a1")).toEqual(new Set(["s1", "st1", "st2"]));
  });
  it("ancestrais de st1 = s1, a1 (mais próximo primeiro)", () => {
    expect(ancestorTempIds(TREE, "st1")).toEqual(["s1", "a1"]);
  });
});

describe("cascadeSelect — cascata DURA (parent-closed, zero órfãos)", () => {
  it("desmarcar o pai desliga TODA a subárvore", () => {
    const next = cascadeSelect(TREE, selectAll(TREE), "a1", false);
    expect(next.size).toBe(0);
  });

  it("desmarcar um step desliga só as stories dele (atividade segue marcada)", () => {
    const next = cascadeSelect(TREE, selectAll(TREE), "s1", false);
    expect(next).toEqual(new Set(["a1"]));
  });

  it("marcar um filho a partir do vazio LIGA os ancestrais (parent-closed)", () => {
    const next = cascadeSelect(TREE, new Set(), "st1", true);
    expect(next).toEqual(new Set(["st1", "s1", "a1"]));
  });

  it("nunca deixa filho marcado sob pai desmarcado", () => {
    // desliga tudo, religa só uma story → o pai e o avô voltam juntos
    const off = cascadeSelect(TREE, selectAll(TREE), "a1", false);
    const on = cascadeSelect(TREE, off, "st2", true);
    expect(on.has("s1")).toBe(true);
    expect(on.has("a1")).toBe(true);
  });
});

describe("nodeCheckState — tri-state visual", () => {
  it("tudo marcado → pai 'on'", () => {
    expect(nodeCheckState(TREE, selectAll(TREE), "a1")).toBe("on");
  });
  it("uma story de fora → pai 'indeterminate'", () => {
    const sel = cascadeSelect(TREE, selectAll(TREE), "st2", false);
    expect(nodeCheckState(TREE, sel, "a1")).toBe("indeterminate");
    expect(nodeCheckState(TREE, sel, "s1")).toBe("indeterminate");
    expect(nodeCheckState(TREE, sel, "st2")).toBe("off");
    expect(nodeCheckState(TREE, sel, "st1")).toBe("on");
  });
  it("nó folha sem descendentes → on/off direto", () => {
    expect(nodeCheckState(TREE, new Set(["st1"]), "st1")).toBe("on");
    expect(nodeCheckState(TREE, new Set(), "st1")).toBe("off");
  });
});

describe("effectiveSelectedCount", () => {
  it("é o tamanho do conjunto selecionado (parent-closed = cards a criar)", () => {
    expect(effectiveSelectedCount(selectAll(TREE))).toBe(4);
    expect(effectiveSelectedCount(cascadeSelect(TREE, selectAll(TREE), "s1", false))).toBe(1);
  });
});
