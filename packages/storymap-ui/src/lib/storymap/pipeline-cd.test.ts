import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { checkGate } from "./gates";
import { coerceWireframeDoc } from "./sidecars";
import type { BoardConfig } from "./types";

const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "com-plano", name: "Com plano", gate: "hasTechPlan" },
    { id: "com-design", name: "Com design", gate: "hasWireframe" },
    { id: "qa-automatizado", name: "QA automatizado", gate: "hasNoBlockers" },
    { id: "revisao", name: "Revisão", gate: "hasQaPassed" },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

describe("coerceCard — Fase C/D pointers + findings", () => {
  it("reads techPlanReady and wireframeChosen", () => {
    const c = card({ techPlanReady: true, wireframeChosen: "opt-2" });
    expect(c.techPlanReady).toBe(true);
    expect(c.wireframeChosen).toBe("opt-2");
  });

  it("defaults findings to [] and coerces unknown enums leniently", () => {
    expect(card({}).findings).toEqual([]);
    const c = card({
      findings: [
        { id: "f1", lens: "security", severity: "blocker", title: "Regra aberta", status: "open" },
        { lens: "bogus", severity: "nope", title: "sem id", status: "weird", file: "a.ts", line: 9 },
        { severity: "low", status: "open" }, // no title → dropped
      ],
    });
    expect(c.findings).toHaveLength(2);
    expect(c.findings[0]).toMatchObject({ id: "f1", lens: "security", severity: "blocker", status: "open" });
    expect(c.findings[1]).toMatchObject({ id: "f2", lens: "general", severity: "medium", status: "open", line: 9 });
  });
});

describe("checkGate — Fase C/D gates", () => {
  it("hasTechPlan needs techPlanReady", () => {
    expect(checkGate(card({}), "com-plano", board)).toMatch(/harness-plan|plano/);
    expect(checkGate(card({ techPlanReady: true }), "com-plano", board)).toBeNull();
  });

  it("hasWireframe needs wireframeChosen", () => {
    expect(checkGate(card({}), "com-design", board)).toMatch(/wireframe/);
    expect(checkGate(card({ wireframeChosen: "opt-1" }), "com-design", board)).toBeNull();
  });

  it("hasNoBlockers (qa-automatizado entry) blocks only on an OPEN blocker", () => {
    const open = card({ findings: [{ id: "f1", lens: "security", severity: "blocker", title: "x", status: "open" }] });
    const fixed = card({ findings: [{ id: "f1", lens: "security", severity: "blocker", title: "x", status: "fixed" }] });
    const lowOpen = card({ findings: [{ id: "f1", lens: "perf", severity: "low", title: "x", status: "open" }] });
    expect(checkGate(open, "qa-automatizado", board)).toMatch(/blocker/);
    expect(checkGate(fixed, "qa-automatizado", board)).toBeNull();
    expect(checkGate(lowOpen, "qa-automatizado", board)).toBeNull(); // low never blocks
    expect(checkGate(card({}), "qa-automatizado", board)).toBeNull(); // no findings
  });

  it("hasQaPassed (revisao entry) requires qaPassed only for user stories", () => {
    // user story (the coerceCard default) without QA → blocked
    expect(checkGate(card({}), "revisao", board)).toMatch(/harness-qa|qaPassed|aceite/i);
    // user story with qaPassed → allowed
    expect(checkGate(card({ qaPassed: true }), "revisao", board)).toBeNull();
    // non-user stories pass freely (no deadlock on infra/chore/spike cards)
    expect(checkGate(card({ storyType: "technical" }), "revisao", board)).toBeNull();
    expect(checkGate(card({ storyType: "chore" }), "revisao", board)).toBeNull();
    expect(checkGate(card({ storyType: "spike" }), "revisao", board)).toBeNull();
  });
});

describe("coerceWireframeDoc — sidecar parsing", () => {
  it("keeps options with content, drops empty ones, and is draft until chosen", () => {
    const doc = coerceWireframeDoc("c", {
      options: [
        { id: "opt-1", label: "A", direction: "on-brand", format: "html", content: "<div>a</div>" },
        { id: "opt-2", content: "   " }, // empty content → dropped
        { content: "ascii art" }, // gets opt-N id
      ],
    });
    expect(doc.options).toHaveLength(2);
    expect(doc.options[0].id).toBe("opt-1");
    expect(doc.status).toBe("draft");
    expect(doc.chosenOptionId).toBeNull();
  });

  it("resolves chosenOptionId only when it matches an option", () => {
    const base = [{ id: "opt-1", content: "x" }];
    expect(coerceWireframeDoc("c", { chosenOptionId: "opt-1", options: base }).status).toBe("chosen");
    expect(coerceWireframeDoc("c", { chosenOptionId: "ghost", options: base }).chosenOptionId).toBeNull();
  });

  it("falls back enum fields defensively", () => {
    const doc = coerceWireframeDoc("c", { options: [{ id: "o", content: "x", direction: "bogus", format: "nope" }] });
    expect(doc.options[0].direction).toBe("on-brand");
    // F2 ASCII-only read surface (sidecars.ts): a missing/invalid format defaults to `ascii`, not html.
    expect(doc.options[0].format).toBe("ascii");
  });
});
