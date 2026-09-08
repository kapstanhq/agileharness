import { describe, it, expect } from "vitest";
import {
  coerceNode,
  countNodes,
  dslToText,
  vocabularyMarkdown,
  PRIMITIVE_SPECS,
  PRIMITIVE_TYPES,
  type WireframeNode,
} from "./index";
import { coerceWireframeDoc } from "../sidecars";

// A representative screen exercising containers + leaves + an array-valued prop (tabbar items).
const SAMPLE: WireframeNode = {
  type: "screen",
  children: [
    { type: "appbar", props: { leading: "menu", title: "Porto Alegre", trailing: "avatar" } },
    { type: "input", props: { icon: "search", placeholder: "Buscar na mosaico" } },
    {
      type: "section",
      props: { eyebrow: "Curadoria para você" },
      children: [
        { type: "grid", props: { cols: 2, gap: 2 }, children: [
          { type: "card", props: { aspect: "3:4" }, children: [{ type: "image", props: { aspect: "3:4", label: "capa" } }] },
          { type: "card", props: { aspect: "3:4" }, children: [{ type: "image", props: { aspect: "3:4" } }] },
        ] },
      ],
    },
    { type: "button", props: { label: "Ver tudo", variant: "primary", full: true } },
    { type: "tabbar", props: { items: [ { icon: "home", label: "Início", active: true }, { icon: "search", label: "Buscar" }, { icon: "user", label: "Você" } ] } },
  ],
};

describe("coerceNode — tolerant + bounded", () => {
  it("round-trips a valid tree", () => {
    const n = coerceNode(SAMPLE);
    expect(n).not.toBeNull();
    expect(n!.type).toBe("screen");
    expect(countNodes(n)).toBe(countNodes(SAMPLE));
  });

  it("maps an unknown type to a labeled placeholder (nothing is lost)", () => {
    const n = coerceNode({ type: "carousel3000", props: { foo: "bar" } });
    expect(n!.type).toBe("placeholder");
    expect(n!.props?.label).toBe("carousel3000");
  });

  it("drops children on leaf primitives", () => {
    const n = coerceNode({ type: "text", props: { value: "x" }, children: [{ type: "text", props: { value: "y" } }] });
    expect(n!.children).toBeUndefined();
  });

  it("drops non-JSON prop values but keeps JSON ones", () => {
    const n = coerceNode({ type: "text", props: { value: "ok", fn: () => 1, n: 3, b: true } as unknown });
    expect(n!.props).toEqual({ value: "ok", n: 3, b: true });
  });

  it("returns null for structurally empty input", () => {
    expect(coerceNode(null)).toBeNull();
    expect(coerceNode("nope")).toBeNull();
    expect(coerceNode([])).toBeNull();
  });

  it("bounds a pathologically deep tree (no stack blow-up)", () => {
    let deep: unknown = { type: "text", props: { value: "leaf" } };
    for (let i = 0; i < 100; i++) deep = { type: "stack", children: [deep] };
    const n = coerceNode(deep);
    expect(n).not.toBeNull();
    expect(countNodes(n)).toBeLessThanOrEqual(500);
  });
});

describe("dslToText — code-generated alignment (THE guarantee)", () => {
  it("emits lines that are ALL exactly equal width", () => {
    const text = dslToText(coerceNode(SAMPLE)!, { viewport: "mobile" });
    const lines = text.split("\n");
    expect(lines.length).toBeGreaterThan(5);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1); // every column lines up — the ASCII failure mode is impossible
  });

  it("never emits double-width / emoji glyphs (which desync monospace columns)", () => {
    const text = dslToText(coerceNode(SAMPLE)!, { viewport: "desktop" });
    // no astral-plane code points (emoji/surrogate pairs)
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).toBe(false);
    for (const ch of text) expect(ch.codePointAt(0)!).toBeLessThan(0x10000);
  });

  it("covers EVERY primitive type (each renders non-empty, still aligned)", () => {
    for (const type of PRIMITIVE_TYPES) {
      const node: WireframeNode = { type, props: { value: "x", label: "x", title: "x" } };
      const out = dslToText(node, { viewport: "mobile" });
      expect(out.length, `${type} produced empty text`).toBeGreaterThan(0);
      const widths = new Set(out.split("\n").map((l) => l.length));
      expect(widths.size, `${type} produced ragged lines`).toBe(1);
    }
  });
});

describe("vocabularyMarkdown — single source of truth", () => {
  it("documents every primitive exactly once", () => {
    const md = vocabularyMarkdown();
    for (const t of PRIMITIVE_TYPES) expect(md).toContain(`\`${t}\``);
    // every documented prop appears too (guards silent drift between doc + spec)
    for (const t of PRIMITIVE_TYPES) {
      for (const prop of Object.keys(PRIMITIVE_SPECS[t].props)) expect(md).toContain(`\`${prop}\``);
    }
  });
});

describe("coerceWireframeDoc — dsl option integration (end-to-end)", () => {
  it("derives an aligned `content` projection from a dsl tree + keeps format:dsl", () => {
    const doc = coerceWireframeDoc("story-x", {
      options: [{ id: "opt-1", format: "dsl", viewport: "mobile", dsl: SAMPLE, content: "" }],
    });
    expect(doc.options).toHaveLength(1);
    const o = doc.options[0];
    expect(o.format).toBe("dsl");
    expect(o.dsl).toBeTruthy();
    expect(o.content.trim().length).toBeGreaterThan(0); // derived, not the empty input
    const widths = new Set(o.content.split("\n").map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("degrades an invalid dsl tree to the ascii text path", () => {
    const doc = coerceWireframeDoc("story-y", {
      options: [{ id: "opt-1", format: "dsl", dsl: null, content: "plain ascii" }],
    });
    expect(doc.options[0].format).toBe("ascii");
    expect(doc.options[0].content).toBe("plain ascii");
    expect(doc.options[0].dsl).toBeUndefined();
  });
});

describe("coerceWireframeDoc — design canvas (Canvas v2)", () => {
  const GRAPH = {
    nodes: [
      { id: "entra", label: "Entra pelo perfil", kind: "start" },
      { id: "abre", label: "Abre a agenda", kind: "step" },
    ],
    edges: [{ from: "entra", to: "abre" }],
  };

  it("coerces artifacts: dsl derives content, chosenOptionId validates against screen artifacts", () => {
    const doc = coerceWireframeDoc("story-x", {
      chosenOptionId: "tela-1",
      artifacts: [
        { id: "tela-1", kind: "screen", title: "Agenda", dsl: SAMPLE },
        { id: "nota-1", kind: "note", title: "Racional", note: "por que assim" },
      ],
    });
    expect(doc.artifacts).toHaveLength(2);
    expect(doc.artifacts[0].format).toBe("dsl");
    expect(doc.artifacts[0].content.trim().length).toBeGreaterThan(0);
    expect(doc.artifacts[1].format).toBe("text");
    expect(doc.artifacts[1].content).toBe("por que assim");
    expect(doc.chosenOptionId).toBe("tela-1"); // screen artifact satisfies the primary pointer
    expect(doc.status).toBe("chosen");
  });

  it("NEVER infers html — a bare string artifact coerces to text; explicit html derives htmlToText content", () => {
    const doc = coerceWireframeDoc("story-x", {
      artifacts: [
        { id: "a1", kind: "screen", title: "Malformada", content: "<div>oi</div>" },
        { id: "a2", kind: "screen", title: "Rica", format: "html", html: "<section><h2>Agenda</h2></section>" },
      ],
    });
    expect(doc.artifacts[0].format).toBe("text");
    expect(doc.artifacts[0].html).toBeUndefined();
    expect(doc.artifacts[1].format).toBe("html");
    expect(doc.artifacts[1].html).toContain("<section>");
    expect(doc.artifacts[1].content).toContain("Agenda"); // derived outline
    expect(doc.artifacts[1].content).not.toContain("<");
  });

  it("enforces the hard html byte cap at coerce time (oversize degrades to text, blob dropped)", () => {
    const big = `<div>${"x".repeat(40 * 1024)}</div>`;
    const doc = coerceWireframeDoc("story-x", {
      artifacts: [{ id: "a1", kind: "screen", title: "Gigante", format: "html", html: big }],
    });
    expect(doc.artifacts[0].format).toBe("text");
    expect(doc.artifacts[0].html).toBeUndefined();
    expect(doc.artifacts[0].content.length).toBeGreaterThan(0);
  });

  it("a graph journey derives flow BEFORE the emptiness check (graph-only journey is never dropped)", () => {
    const doc = coerceWireframeDoc("story-x", { journey: { graph: GRAPH } });
    expect(doc.journey).not.toBeNull();
    expect(doc.journey!.format).toBe("graph");
    expect(doc.journey!.graph!.nodes).toHaveLength(2);
    expect(doc.journey!.flow).toContain("Entra pelo perfil");
    expect(doc.journey!.flow).toContain("→");
  });

  it("graph coerce issues surface on the journey AND inside the derived flow text", () => {
    const doc = coerceWireframeDoc("story-x", {
      journey: { graph: { nodes: GRAPH.nodes, edges: [{ from: "entra", to: "fantasma" }] } },
    });
    expect(doc.journey!.issues!.some((i) => i.includes("fantasma"))).toBe(true);
    expect(doc.journey!.flow).toContain("⚠");
  });

  it("round-trip FIXPOINT: authored artifacts/feedback/journey.graph survive coerce→serialize→coerce", () => {
    const authored = {
      chosenOptionId: "tela-1",
      journey: { graph: GRAPH, narrative: "como usa" },
      artifacts: [
        { id: "tela-1", kind: "screen", title: "Agenda", note: "reusa X", dsl: SAMPLE, journeyRef: "abre", state: "populated" },
        { id: "flx-1", kind: "flow", title: "Sub-fluxo", format: "graph", graph: GRAPH },
      ],
      feedback: [
        { id: "fb1", artifactId: "tela-1", kind: "change", note: "menos denso", by: "human", at: "2026-07-22", resolvedAt: null },
        { id: "fb2", artifactId: "sumiu", kind: "approve", note: "ok", by: "human", at: null, resolvedAt: "2026-07-22" },
      ],
    };
    const once = coerceWireframeDoc("story-x", authored);
    const twice = coerceWireframeDoc("story-x", JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once); // anything coerce fails to copy is ERASED on the next human action
    expect(twice.feedback).toHaveLength(2); // dangling artifactId KEPT — the thread survives regens
    expect(twice.artifacts[0].journeyRef).toBe("abre");
  });
});
