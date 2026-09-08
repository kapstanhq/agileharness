// ADR-063 item 3c SCAFFOLD — test for the pure discovery generator.
// The storymap-ui vitest include glob is `src/**/*.test.ts` (scripts/ is excluded),
// so this test lives here and imports buildDiscovery from ../../../scripts/gen-qa-discovery.
import { describe, it, expect } from "vitest";
import { buildDiscovery, type QaDiscovery } from "../../../scripts/gen-qa-discovery";

describe("buildDiscovery — route derivation", () => {
  it("maps app-router page.tsx paths to routes", () => {
    const out = buildDiscovery("storymap-ui", [
      { path: "src/app/page.tsx", content: "" },
      { path: "src/app/perguntas/page.tsx", content: "" },
      { path: "src/app/processes/[id]/page.tsx", content: "" },
      { path: "src/app/board/[boardId]/kanban/page.tsx", content: "" },
    ]);
    const routes = out.routes.map((r) => r.route);
    expect(routes).toContain("/");
    expect(routes).toContain("/perguntas");
    expect(routes).toContain("/processes/[id]");
    expect(routes).toContain("/board/[boardId]/kanban");
  });

  it("ignores non-page files (layout, route handlers, components)", () => {
    const out = buildDiscovery("x", [
      { path: "src/app/layout.tsx", content: "" },
      { path: "src/app/api/foo/route.ts", content: "" },
      { path: "src/components/Card.tsx", content: 'data-testid="ignored"' },
      { path: "src/app/page.tsx", content: "" },
    ]);
    expect(out.routes.map((r) => r.route)).toEqual(["/"]);
    // testids only come from page files
    expect(out.testids).toEqual([]);
  });

  it("strips route groups (group) and parallel-route @slot segments from the URL", () => {
    const out = buildDiscovery("x", [
      { path: "src/app/(marketing)/about/page.tsx", content: "" },
      { path: "src/app/@modal/login/page.tsx", content: "" },
    ]);
    const routes = out.routes.map((r) => r.route);
    expect(routes).toContain("/about");
    expect(routes).toContain("/login");
  });
});

describe("buildDiscovery — testid extraction", () => {
  it("extracts data-testid occurrences per route and dedupes", () => {
    const out = buildDiscovery("x", [
      {
        path: "src/app/page.tsx",
        content: `<div data-testid="header" /><button data-testid="save" /><span data-testid="header" />`,
      },
    ]);
    const entry = out.routes.find((r) => r.route === "/");
    expect(entry?.testids).toEqual(["header", "save"]);
  });

  it("supports single-quoted testids too", () => {
    const out = buildDiscovery("x", [
      { path: "src/app/page.tsx", content: `data-testid='alpha'` },
    ]);
    expect(out.routes[0].testids).toEqual(["alpha"]);
  });

  it("builds a deduped, sorted global testid registry across routes", () => {
    const out = buildDiscovery("x", [
      { path: "src/app/a/page.tsx", content: `data-testid="zeta" data-testid="alpha"` },
      { path: "src/app/b/page.tsx", content: `data-testid="alpha" data-testid="beta"` },
    ]);
    expect(out.testids).toEqual(["alpha", "beta", "zeta"]);
  });
});

describe("buildDiscovery — determinism", () => {
  const files = [
    { path: "src/app/board/[boardId]/kanban/page.tsx", content: `data-testid="k2" data-testid="k1"` },
    { path: "src/app/page.tsx", content: `data-testid="home"` },
    { path: "src/app/perguntas/page.tsx", content: `data-testid="q"` },
  ];

  it("sorts routes and testids deterministically regardless of input order", () => {
    const a = buildDiscovery("storymap-ui", files);
    const b = buildDiscovery("storymap-ui", [...files].reverse());
    expect(a).toEqual(b);
    expect(a.routes.map((r) => r.route)).toEqual([
      "/",
      "/board/[boardId]/kanban",
      "/perguntas",
    ]);
    // per-route testids sorted
    const kanban = a.routes.find((r) => r.route === "/board/[boardId]/kanban");
    expect(kanban?.testids).toEqual(["k1", "k2"]);
  });

  it("carries the pkg name and a stable generatedFrom, with no time/random fields", () => {
    const out: QaDiscovery = buildDiscovery("storymap-ui", files);
    expect(out.pkg).toBe("storymap-ui");
    expect(out.generatedFrom).toBe("packages/storymap-ui/src/app");
    // reproducible: serialization is byte-identical across runs
    expect(JSON.stringify(out)).toBe(JSON.stringify(buildDiscovery("storymap-ui", files)));
  });
});
