import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildWireframeSrcDoc, htmlToText, sanitizeWireframeHtml, WIREFRAME_IFRAME_SANDBOX } from "./index";

describe("sanitizeWireframeHtml — the depth layer (vectors stripped even though sandbox+CSP already contain them)", () => {
  it("drops script/iframe/object/embed subtrees entirely", () => {
    const out = sanitizeWireframeHtml(
      `<div>ok</div><script>fetch('/api/vps')</script><iframe src="x"></iframe><object data="x"></object><embed src="x">`,
    );
    expect(out).toContain("ok");
    for (const bad of ["script", "iframe", "object", "embed", "fetch"]) expect(out.toLowerCase()).not.toContain(bad);
  });

  it("strips every on* handler regardless of quoting", () => {
    const out = sanitizeWireframeHtml(`<div onclick="x()" onmouseover='y()' onfocus=z()>oi</div>`);
    expect(out).not.toMatch(/on[a-z]+\s*=/i);
    expect(out).toContain("oi");
  });

  it("strips URL-carrying attributes and neutralizes javascript: leftovers", () => {
    const out = sanitizeWireframeHtml(`<a href="javascript:alert(1)">x</a><img src="https://evil/x.png"><div style="background:url(https://evil/t.gif)">y</div>`);
    expect(out).not.toContain("href=");
    expect(out).not.toContain("src=");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("https://evil");
  });

  it("reduces a full document to a body fragment (our CSP meta can never be reparented out of head)", () => {
    const out = sanitizeWireframeHtml(
      `<!doctype html><html><head><title>t</title><meta charset="x"><link rel="stylesheet" href="e"></head><body><section>conteúdo</section></body></html>`,
    );
    expect(out).toBe("<section>conteúdo</section>");
  });

  it("keeps wireframe structure + inline styles (the quality lean)", () => {
    const src = `<div style="display:flex;gap:8px"><button style="background:#111;color:#fff">CTA</button><span>rótulo</span></div>`;
    expect(sanitizeWireframeHtml(src)).toBe(src);
  });

  it("strips autofocus and @import", () => {
    const out = sanitizeWireframeHtml(`<input autofocus="autofocus"><style>@import url(x); .a{color:red}</style>`);
    expect(out).not.toContain("autofocus");
    expect(out).not.toContain("@import");
    expect(out).toContain(".a{color:red}");
  });
});

describe("buildWireframeSrcDoc — explicit skeleton, CSP inside <head>", () => {
  it("emits doctype + CSP meta in head + sanitized fragment in body", () => {
    const doc = buildWireframeSrcDoc(`<html><head><meta x></head><body><p>tela</p><script>evil()</script></body></html>`);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    const head = doc.slice(0, doc.indexOf("</head>"));
    expect(head).toContain(`http-equiv="Content-Security-Policy"`);
    expect(head).toContain("default-src 'none'");
    const body = doc.slice(doc.indexOf("<body>"));
    expect(body).toContain("<p>tela</p>");
    expect(body).not.toContain("script");
    expect(body).not.toContain("Content-Security-Policy"); // only OUR meta exists, and only in head
  });
});

describe("the sandbox contract — EMPTY, locked", () => {
  it("the constant is the empty string (no allow-* token, ever)", () => {
    expect(WIREFRAME_IFRAME_SANDBOX).toBe("");
  });

  it("HtmlArtifactFrame renders sandbox from the constant and never an allow-* literal (source lock)", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "..", "..", "components", "wireframe", "HtmlArtifactFrame.tsx"),
      "utf8",
    );
    expect(src).toContain("WIREFRAME_IFRAME_SANDBOX");
    expect(src).toContain(`referrerPolicy="no-referrer"`);
    expect(src).not.toMatch(/allow-(scripts|same-origin|forms|top-navigation|popups)/);
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });

  it("FlowGraphView renders labels as JSX text only (no foreignObject, no dangerouslySetInnerHTML)", () => {
    const src = readFileSync(
      path.join(__dirname, "..", "..", "..", "components", "wireframe", "FlowGraphView.tsx"),
      "utf8",
    );
    expect(src).not.toContain("foreignObject");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("htmlToText — the safe text projection", () => {
  it("never emits raw markup", () => {
    const out = htmlToText(`<section><h2>Agenda</h2><p>Hoje &amp; amanhã</p><ul><li>Sarau</li><li>Feira</li></ul></section>`);
    expect(out).not.toContain("<");
    expect(out).toContain("Agenda");
    expect(out).toContain("Hoje & amanhã");
    expect(out.split("\n")).toContain("Sarau");
  });

  it("bounds pathological input", () => {
    const out = htmlToText(Array.from({ length: 500 }, (_, i) => `<p>linha ${i}</p>`).join(""));
    expect(out.split("\n").length).toBeLessThanOrEqual(61);
  });
});
