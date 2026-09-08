import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";
import {
  ANNOTATION_SCHEMA_VERSION,
  coerceAnnotationBatch,
  isSafeScreenshotRef,
  renderBatchMarkdown,
} from "./schema";

const validPin = { note: "botão some no dobra da tela", anchor: { selector: "main > button.cta" } };

describe("annotation schema (the producer↔sink seam)", () => {
  it("exposes a stable version", () => {
    expect(ANNOTATION_SCHEMA_VERSION).toBe(1);
  });

  it("accepts a minimal valid batch and applies the documented defaults", () => {
    const r = coerceAnnotationBatch({ link: { board: "storymap" }, pins: [validPin] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.pins[0].kind).toBe("change");
    expect(r.batch.link.kind).toBe("none");
    expect(r.batch.link.board).toBe("storymap");
    expect(r.batch.producer).toBe("agileharness-overlay");
  });

  it("rejects an empty pins array", () => {
    const r = coerceAnnotationBatch({ link: { board: "storymap" }, pins: [] });
    expect(r.ok).toBe(false);
  });

  it("caps the batch size (rejects > 50 pins at the boundary, not downstream)", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ note: `n${i}`, anchor: { selector: `#e${i}` } }));
    const r = coerceAnnotationBatch({ link: { board: "storymap" }, pins: many });
    expect(r.ok).toBe(false);
  });

  it("caps an oversized note", () => {
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [{ note: "x".repeat(2001), anchor: { selector: "#e" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a pin without a selector (not locatable → not a pin)", () => {
    const r = coerceAnnotationBatch({ pins: [{ note: "x", anchor: { selector: "" } }] });
    expect(r.ok).toBe(false);
  });

  it("rejects a pin without a note (feedback IS its note)", () => {
    const r = coerceAnnotationBatch({ pins: [{ note: "", anchor: { selector: "a.b" } }] });
    expect(r.ok).toBe(false);
  });

  it("preserves link.kind=card + a second approve pin with text", () => {
    const r = coerceAnnotationBatch({
      link: { kind: "card", board: "storymap", cardId: "story-x" },
      pins: [validPin, { note: "manter", kind: "approve", anchor: { selector: "#hero", text: "Olá" } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.link.kind).toBe("card");
    expect(r.batch.link.cardId).toBe("story-x");
    expect(r.batch.pins).toHaveLength(2);
    expect(r.batch.pins[1].kind).toBe("approve");
    expect(r.batch.pins[1].anchor.text).toBe("Olá");
  });

  it("renders a faithful markdown projection (note + selector survive)", () => {
    const r = coerceAnnotationBatch({ link: { board: "storymap" }, pins: [validPin] });
    if (!r.ok) return;
    const md = renderBatchMarkdown(r.batch);
    expect(md).toContain("botão some no dobra da tela");
    expect(md).toContain("main > button.cta");
    expect(md).toContain("1 anotação");
  });

  it("accepts a REGION pin (container selector + rect + covered elements)", () => {
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [
        {
          note: "esse bloco está apertado",
          anchor: {
            selector: "main > section.toolbar",
            region: true,
            rect: { x: 10, y: 20, w: 300, h: 80 },
            covered: [{ selector: "button.save", label: "Salvar" }, { selector: "input.search" }],
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.pins[0].anchor.region).toBe(true);
    expect(r.batch.pins[0].anchor.covered).toHaveLength(2);
  });

  it("caps `covered` at 12 (a huge box can't bloat the batch)", () => {
    const covered = Array.from({ length: 13 }, (_, i) => ({ selector: `#c${i}` }));
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [{ note: "área grande", anchor: { selector: "#wrap", region: true, covered } }],
    });
    expect(r.ok).toBe(false);
  });

  it("renders a region pin: marks it a região, labels the selector Contêiner, lists what it covers", () => {
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [
        {
          note: "layout torto",
          anchor: {
            selector: "section.head",
            region: true,
            rect: { x: 0, y: 0, w: 200, h: 50 },
            covered: [{ selector: "a.logo", label: "Logo" }],
          },
        },
      ],
    });
    if (!r.ok) return;
    const md = renderBatchMarkdown(r.batch);
    expect(md).toContain("região (área desenhada)");
    expect(md).toContain("**Contêiner:**");
    expect(md).toContain("Logo (`a.logo`)");
    expect(md).not.toContain("**Seletor:**"); // a region uses "Contêiner", not "Seletor"
  });
});

describe("screenshotRef — only a same-origin path may reach a card", () => {
  it("accepts a root-relative same-origin path", () => {
    expect(isSafeScreenshotRef("/api/feedback/shot?board=storymap&batch=ab12&file=shot-1.png")).toBe(true);
  });

  it("rejects external, protocol-relative and script refs (a card render must never beacon out)", () => {
    expect(isSafeScreenshotRef("https://evil.example/track.png")).toBe(false);
    expect(isSafeScreenshotRef("//evil.example/track.png")).toBe(false); // protocol-relative = other origin
    expect(isSafeScreenshotRef("javascript:alert(1)")).toBe(false);
    expect(isSafeScreenshotRef("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeScreenshotRef("")).toBe(false);
    expect(isSafeScreenshotRef(null)).toBe(false);
    expect(isSafeScreenshotRef("/x\n/y")).toBe(false);
  });

  it("the SCHEMA rejects a batch carrying an unsafe screenshotRef (loud, not silently stripped)", () => {
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [{ note: "x", anchor: { selector: "#e", screenshotRef: "https://evil.example/p.png" } }],
    });
    expect(r.ok).toBe(false);
  });

  it("a safe ref survives and renders as a markdown IMAGE (so the card shows the region)", () => {
    const ref = "/api/feedback/shot?board=storymap&batch=ab12&file=shot-1.png";
    const r = coerceAnnotationBatch({
      link: { board: "storymap" },
      pins: [{ note: "olha isso", anchor: { selector: "#e", region: true, screenshotRef: ref } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.pins[0].anchor.screenshotRef).toBe(ref);
    expect(renderBatchMarkdown(r.batch)).toContain(`![Captura da região](${ref})`);
  });
});

describe("markdown do card × markdown do handoff — a paridade que já quebrou 3 vezes", () => {
  // The overlay is a static IIFE served to the browser: it CANNOT import this module, so its copy of
  // the projection is kept in parity BY HAND. Every time that drifted, the operator paid: the picture
  // missing from the handoff, the raw multi-line `Texto` that ended the markdown list early, and
  // "1 anotações". A comment saying "mirrors the server" did not hold — this does.
  const root = findRepoRoot();
  const serverSrc = readFileSync(join(root, "packages/storymap-ui/src/lib/feedback/schema.ts"), "utf8");
  const clientSrc = readFileSync(join(root, "packages/storymap-ui/public/ah-overlay.js"), "utf8");

  /** The `- **Label:**` field names emitted inside one function's source. */
  function fieldsOf(src: string, from: string, to: string): string[] {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start);
    expect(start, `âncora não encontrada: ${from}`).toBeGreaterThan(-1);
    expect(end, `âncora não encontrada: ${to}`).toBeGreaterThan(start);
    const body = src.slice(start, end);
    return [...body.matchAll(/\*\*([^*:]{1,24}):\*\*/g)].map((m) => m[1]).sort();
  }

  it("os dois emitem exatamente os mesmos campos", () => {
    const server = fieldsOf(serverSrc, "export function renderPinMarkdown", "export function renderBatchMarkdown");
    const client = fieldsOf(clientSrc, "function pinMd(", "function handoffMd(");
    expect(server.length).toBeGreaterThan(4); // a âncora achou o corpo de verdade, não uma casca vazia
    expect(client).toEqual(server);
  });

  it("os dois embutem a captura como IMAGEM markdown", () => {
    for (const src of [serverSrc, clientSrc]) expect(src).toContain("![Captura da região](");
  });

  it("os dois colapsam espaço em branco — um bullet só tem UMA linha", () => {
    expect(serverSrc).toMatch(/replace\(\/\\s\+\/g, " "\)/);
    expect(clientSrc).toMatch(/replace\(\/\\s\+\/g, " "\)/);
  });

  it("os dois concordam no singular de anotação", () => {
    for (const src of [serverSrc, clientSrc]) expect(src).toContain(`"anotação" : "anotações"`);
  });
});
