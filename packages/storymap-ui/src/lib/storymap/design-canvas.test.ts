import { describe, expect, it } from "vitest";
import {
  artifactFeedback,
  canvasArtifacts,
  canvasWideFeedback,
  designReturnTarget,
  hasCanvasContent,
  JOURNEY_FEEDBACK_ID,
  orderedCanvasArtifacts,
  unresolvedChanges,
  wireframeDocTextView,
} from "./design-canvas";
import type { DesignArtifact, DesignFeedbackEntry, WireframeDoc, WireframeOption } from "./types";

const opt = (id: string, over: Partial<WireframeOption> = {}): WireframeOption => ({
  id,
  label: `Opção ${id}`,
  direction: "on-brand",
  rationale: "por quê",
  format: "ascii",
  viewport: "mobile",
  state: "populated",
  heightHint: null,
  content: "[ tela ]",
  ...over,
});

const art = (id: string, over: Partial<DesignArtifact> = {}): DesignArtifact => ({
  id,
  kind: "screen",
  title: `Tela ${id}`,
  note: "",
  format: "text",
  viewport: "mobile",
  state: "populated",
  content: "[ tela ]",
  ...over,
});

const fb = (id: string, over: Partial<DesignFeedbackEntry> = {}): DesignFeedbackEntry => ({
  id,
  artifactId: null,
  kind: "change",
  note: "muda isso",
  by: "human",
  at: "2026-07-22",
  resolvedAt: null,
  ...over,
});

const doc = (over: Partial<WireframeDoc> = {}): WireframeDoc => ({
  cardId: "story-x",
  status: "draft",
  chosenOptionId: null,
  generatedBy: "harness-ui",
  updated: null,
  journey: null,
  options: [],
  artifacts: [],
  feedback: [],
  ...over,
});

describe("canvasArtifacts — the RENDER-ONLY legacy bridge", () => {
  it("authored artifacts win; the bridge never mixes the two", () => {
    const d = doc({ options: [opt("o1")], artifacts: [art("a1")] });
    expect(canvasArtifacts(d).map((a) => a.id)).toEqual(["a1"]);
  });

  it("derives screen artifacts from legacy options in memory (label→title, rationale→note)", () => {
    const d = doc({ options: [opt("o1"), opt("o2", { format: "html", content: "<div>x</div>" })] });
    const arts = canvasArtifacts(d);
    expect(arts.map((a) => a.id)).toEqual(["o1"]); // legacy html stays on the note path, never bridged
    expect(arts[0].kind).toBe("screen");
    expect(arts[0].title).toBe("Opção o1");
    expect(arts[0].note).toBe("por quê");
  });

  it("orders the primary first, then kind (screen, component, flow, note)", () => {
    const d = doc({
      chosenOptionId: "a2",
      artifacts: [art("n1", { kind: "note" }), art("a1"), art("a2"), art("c1", { kind: "component", state: null })],
    });
    expect(orderedCanvasArtifacts(d).map((a) => a.id)).toEqual(["a2", "a1", "c1", "n1"]);
  });

  it("hasCanvasContent is true for options OR artifacts (the design-stop gate)", () => {
    expect(hasCanvasContent(doc())).toBe(false);
    expect(hasCanvasContent(doc({ options: [opt("o1")] }))).toBe(true);
    expect(hasCanvasContent(doc({ artifacts: [art("a1")] }))).toBe(true);
  });
});

describe("feedback selectors — the P1 iteration loop", () => {
  it("a dangling artifactId is KEPT and falls back to the canvas-wide thread", () => {
    const d = doc({ artifacts: [art("a1")], feedback: [fb("f1", { artifactId: "sumiu" })] });
    expect(canvasWideFeedback(d).map((f) => f.id)).toEqual(["f1"]);
  });

  it("the three scopes stay DISTINCT: artifact · journey · whole-design", () => {
    const d = doc({
      artifacts: [art("a1")],
      feedback: [
        fb("f-art", { artifactId: "a1" }),
        fb("f-jor", { artifactId: JOURNEY_FEEDBACK_ID }),
        fb("f-all", { artifactId: null }),
      ],
    });
    expect(artifactFeedback(d, "a1").map((f) => f.id)).toEqual(["f-art"]);
    expect(artifactFeedback(d, JOURNEY_FEEDBACK_ID).map((f) => f.id)).toEqual(["f-jor"]);
    // the whole-design thread carries ONLY null (journey anchors on the journey card, never here)
    expect(canvasWideFeedback(d).map((f) => f.id)).toEqual(["f-all"]);
  });

  it("journey-targeted unresolved changes route the redesign through design-ux (the flow may change)", () => {
    const d = doc({ artifacts: [art("a1")], feedback: [fb("f1", { artifactId: JOURNEY_FEEDBACK_ID })] });
    expect(designReturnTarget(d)).toBe("design-ux");
  });

  it("unresolvedChanges counts only kind=change without resolvedAt (approve never triggers regen)", () => {
    const d = doc({
      feedback: [
        fb("f1"),
        fb("f2", { resolvedAt: "2026-07-22" }),
        fb("f3", { kind: "approve", note: "aprovado" }),
      ],
    });
    expect(unresolvedChanges(d).map((f) => f.id)).toEqual(["f1"]);
  });

  it("routes screen-only feedback to design-ui and canvas-wide/dangling feedback to design-ux", () => {
    const base = { artifacts: [art("a1")] };
    expect(designReturnTarget(doc({ ...base, feedback: [fb("f1", { artifactId: "a1" })] }))).toBe("design-ui");
    expect(designReturnTarget(doc({ ...base, feedback: [fb("f1", { artifactId: null })] }))).toBe("design-ux");
    expect(designReturnTarget(doc({ ...base, feedback: [fb("f1", { artifactId: "fantasma" })] }))).toBe("design-ux");
    // resolved entries don't route anywhere
    expect(designReturnTarget(doc({ ...base, feedback: [fb("f1", { artifactId: null, resolvedAt: "2026-07-22" }), fb("f2", { artifactId: "a1" })] }))).toBe("design-ui");
  });
});

describe("wireframeDocTextView — the lean LLM projection", () => {
  it("keeps only content projections (no dsl/html/graph sources) and rides the feedback thread", () => {
    const d = doc({
      artifacts: [
        art("a1", { format: "html", html: "<div>x</div>", content: "outline seguro", journeyRef: "abre" }),
      ],
      feedback: [fb("f1", { artifactId: "a1" })],
    });
    const view = wireframeDocTextView(d) as { artifacts: Record<string, unknown>[]; feedback: unknown[] };
    expect(view.artifacts[0].content).toBe("outline seguro");
    expect(view.artifacts[0].journeyRef).toBe("abre");
    expect("html" in view.artifacts[0]).toBe(false);
    expect("dsl" in view.artifacts[0]).toBe(false);
    expect("graph" in view.artifacts[0]).toBe(false);
    expect(view.feedback).toHaveLength(1);
  });
});
