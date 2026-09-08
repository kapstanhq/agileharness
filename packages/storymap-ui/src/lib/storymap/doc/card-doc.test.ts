// card-doc projection invariants. The master law: commit(project(card), card) is a NO-OP —
// changed:false and every byte preserved, even when the body is NOT in canonical codec form
// (canonicalization alone never counts as an edit).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coerceCard } from "../repo";
import {
  ACCEPTANCE_BINDING,
  commitCardDoc,
  NARRATIVE_BINDING,
  projectCardDoc,
} from "./card-doc";
import { reattachBindings } from "./doc-model";
import type { DocBlock } from "./doc-model";

const canonicalBody = readFileSync(join(__dirname, "__fixtures__", "canonical-card.md"), "utf8");

const card = (over: Record<string, unknown> = {}, body = canonicalBody) =>
  coerceCard(
    "c1",
    {
      type: "story",
      title: "Recomendar eventos pela conversa",
      storyType: "user",
      status: "desenvolver",
      personas: ["curioso"],
      narrative: {
        role: "Curioso Cultural",
        want: "receber recomendações na conversa",
        soThat: "descobrir sem garimpar",
      },
      acceptance: ["A recomendação aparece sem pedir.", "Cada item traz imagem própria."],
      qaPassed: false,
      ...over,
    },
    body,
  );

describe("projectCardDoc", () => {
  it("projects properties + hero narrative + acceptance todos + free body", () => {
    const model = projectCardDoc(card(), {
      personas: [{ id: "curioso", name: "Curioso Cultural", color: "#0ea5e9" }],
    });
    expect(model.title).toBe("Recomendar eventos pela conversa");

    const props = model.blocks[0];
    expect(props.kind).toBe("properties");

    const hero = model.blocks.find(
      (b): b is Extract<DocBlock, { kind: "section" }> => b.kind === "section" && b.binding === NARRATIVE_BINDING,
    );
    expect(hero?.tone).toBe("hero");
    expect(hero?.body[0].kind).toBe("paragraph");

    const acHeading = model.blocks.find(
      (b): b is Extract<DocBlock, { kind: "heading" }> => b.kind === "heading" && b.binding === ACCEPTANCE_BINDING,
    );
    expect(acHeading).toBeTruthy();
    const idx = model.blocks.indexOf(acHeading!);
    expect(model.blocks[idx + 1].kind).toBe("todo");
    expect(model.blocks[idx + 2].kind).toBe("todo");

    // free body starts after the bound acceptance run — first fixture block is the Contexto heading
    expect(model.blocks.some((b) => b.kind === "heading" && b.text === "Contexto")).toBe(true);
  });

  it("acceptance checks mirror qaPassed and are read-only", () => {
    const passed = projectCardDoc(card({ qaPassed: true }));
    const todos = passed.blocks.filter(
      (b): b is Extract<DocBlock, { kind: "todo" }> => b.kind === "todo" && b.readOnlyCheck === true,
    );
    expect(todos.length).toBeGreaterThan(0);
    expect(todos.every((t) => t.checked)).toBe(true);
  });
});

describe("commitCardDoc — no-op ≡ no-write", () => {
  it("commit(project(card), card) changes nothing (canonical body)", () => {
    const prev = card();
    const { card: next, changed } = commitCardDoc(projectCardDoc(prev), prev);
    expect(changed).toBe(false);
    expect(next.title).toBe(prev.title);
    expect(next.body).toBe(prev.body);
    expect(next.acceptance).toEqual(prev.acceptance);
  });

  it("non-canonical body is preserved byte-for-byte on a no-op save", () => {
    const messy = "* bullet com asterisco\n\n\n\nParágrafo após 3 linhas em branco.\n\n1) lista estranha";
    const prev = card({}, messy);
    const { card: next, changed } = commitCardDoc(projectCardDoc(prev), prev);
    expect(changed).toBe(false);
    expect(next.body).toBe(messy);
  });
});

describe("commitCardDoc — edits land in the right field", () => {
  it("editing an acceptance todo rewrites acceptance[], not the body", () => {
    const prev = card();
    const model = projectCardDoc(prev);
    const idx = model.blocks.findIndex((b) => b.kind === "heading" && b.binding === ACCEPTANCE_BINDING);
    const todo = model.blocks[idx + 1];
    if (todo.kind !== "todo") throw new Error("expected todo");
    todo.text = "Critério reescrito pelo humano.";
    const { card: next, changed } = commitCardDoc(model, prev);
    expect(changed).toBe(true);
    expect(next.acceptance[0]).toBe("Critério reescrito pelo humano.");
    expect(next.body).toBe(prev.body);
  });

  it("adding a paragraph to the free region updates body only", () => {
    const prev = card();
    const model = projectCardDoc(prev);
    model.blocks.push({ kind: "paragraph", id: "novo", text: "Nota nova do humano." });
    const { card: next, changed } = commitCardDoc(model, prev);
    expect(changed).toBe(true);
    expect(next.body.endsWith("Nota nova do humano.\n")).toBe(true);
    expect(next.acceptance).toEqual(prev.acceptance);
  });

  it("narrative section edits are ignored (read-bound) and title edits stick", () => {
    const prev = card();
    const model = projectCardDoc(prev);
    const hero = model.blocks.find(
      (b): b is Extract<DocBlock, { kind: "section" }> => b.kind === "section" && b.binding === NARRATIVE_BINDING,
    )!;
    hero.body = [{ kind: "paragraph", id: "x", text: "tentativa de editar narrativa" }];
    model.title = "Título novo";
    const { card: next, changed } = commitCardDoc(model, prev);
    expect(changed).toBe(true);
    expect(next.title).toBe("Título novo");
    expect(next.narrative).toEqual(prev.narrative);
    expect(next.body).toBe(prev.body);
  });

  it("editor surface dropping heading bindings does NOT fold acceptance into the body", () => {
    // BlockNote's default heading spec has no binding prop — simulate the drop, run the
    // reattach pass the editor wrapper applies, and assert the no-op law still holds.
    const prev = card();
    const model = projectCardDoc(prev);
    const dropped = model.blocks.map((b) =>
      b.kind === "heading" ? { ...b, binding: undefined, icon: undefined } : b,
    );
    const reattached = reattachBindings(dropped, model.blocks);
    const { card: next, changed } = commitCardDoc({ ...model, blocks: reattached }, prev);
    expect(changed).toBe(false);
    expect(next.body).toBe(prev.body);
    expect(next.acceptance).toEqual(prev.acceptance);
  });

  it("without reattach, the label fallback still anchors the FIRST matching heading only", () => {
    const prev = card();
    const model = projectCardDoc(prev);
    const dropped = model.blocks.map((b) =>
      b.kind === "heading" ? { ...b, binding: undefined } : b,
    );
    const { card: next, changed } = commitCardDoc({ ...model, blocks: dropped }, prev);
    // The bound region is projected before the body, so the first "Critérios de aceite" heading
    // is the bound one — acceptance survives and the body's own same-label section stays put.
    expect(changed).toBe(false);
    expect(next.acceptance).toEqual(prev.acceptance);
    expect(next.body).toBe(prev.body);
  });

  it("removing an acceptance todo removes the criterion", () => {
    const prev = card();
    const model = projectCardDoc(prev);
    const idx = model.blocks.findIndex((b) => b.kind === "heading" && b.binding === ACCEPTANCE_BINDING);
    model.blocks.splice(idx + 1, 1);
    const { card: next } = commitCardDoc(model, prev);
    expect(next.acceptance).toEqual(["Cada item traz imagem própria."]);
  });
});
