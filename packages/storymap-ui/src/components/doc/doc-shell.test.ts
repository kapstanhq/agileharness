import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// This package's vitest rig is node-env with no DOM renderer, and — per the .tsx-render-test gotcha
// already documented on kanban-card-footer.test.ts / QuickActionButton.contract.test.ts — even a plain
// (non-rendering) `.tsx` file fails Vite's import-analysis under this repo's rolldown-vite pipeline
// (tsconfig's `"jsx": "preserve"` leaves JSX untouched, which the downstream plain-JS parser can't
// read), so `resolveDefaultView` can't be `import`ed from "./DocShell" directly.
//
// Rather than fall back to asserting mere source-text presence (weaker than real behaviour), this
// extracts the function's own source slice — self-contained, references only its own parameters, no
// JSX and no module imports — and transpiles + runs THAT with the TypeScript compiler already a
// project devDependency. The ACTUAL committed logic executes; a future edit to resolveDefaultView is
// exercised for real, not just grepped.
const source = readFileSync(fileURLToPath(new URL("./DocShell.tsx", import.meta.url)), "utf8");

function extractFunctionSource(name: string): string {
  const start = source.indexOf(`export function ${name}`);
  expect(start, `${name} source present`).toBeGreaterThan(-1);
  const bodyOpen = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = bodyOpen; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `${name} closing brace found`).toBeGreaterThan(bodyOpen);
  return source.slice(start, end + 1);
}

function loadResolveDefaultView(): (views: { id: string }[], saved: string | null) => string {
  const fnSource = extractFunctionSource("resolveDefaultView");
  const js = ts.transpileModule(fnSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exportsObj: Record<string, unknown> = {};
  new Function("exports", js)(exportsObj);
  const fn = exportsObj.resolveDefaultView;
  expect(typeof fn, "resolveDefaultView compiled to a callable function").toBe("function");
  return fn as (views: { id: string }[], saved: string | null) => string;
}

const resolveDefaultView = loadResolveDefaultView();

function view(id: string) {
  return { id };
}

describe("resolveDefaultView (DocShell)", () => {
  it("keeps the saved view when it still names a real view", () => {
    const views = [view("overview"), view("history")];
    expect(resolveDefaultView(views, "history")).toBe("history");
  });

  it("falls back to views[0] when the saved id is null", () => {
    const views = [view("overview"), view("history")];
    expect(resolveDefaultView(views, null)).toBe("overview");
  });

  it("falls back to views[0] when the saved id no longer names a view", () => {
    const views = [view("overview"), view("history")];
    expect(resolveDefaultView(views, "removed-view")).toBe("overview");
  });

  it("returns an empty string when there are no views", () => {
    expect(resolveDefaultView([], "anything")).toBe("");
    expect(resolveDefaultView([], null)).toBe("");
  });
});
