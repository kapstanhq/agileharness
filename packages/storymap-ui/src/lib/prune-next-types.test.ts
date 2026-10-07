// O `typecheck` poda os tipos gerados de rotas que não existem mais (scripts/prune-next-types.mjs): um diretório de
// build reaproveitado guardava `.next/types/app/<rota antiga>/page.ts` e o `tsc` falhava com TS2307 numa página que
// ninguém escreveu. A poda é estreita de propósito: só o que perdeu a fonte, só dentro de `<distDir>/types/app`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneNextTypes, staleNextTypes, staleRouteTypes } from "../../scripts/prune-next-types.mjs";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const touch = (rel: string, content = ""): void => {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

describe("staleNextTypes — só o tipo gerado cuja rota sumiu", () => {
  it("rota renomeada: o gerado da antiga sai; o da viva, o layout e o que mora fora de types/app ficam", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ah-next-types-"));
    touch("src/app/layout.tsx");
    touch("src/app/board/[boardId]/vocabulario/[...rest]/page.tsx");
    touch("src/app/api/health/route.ts");
    touch(".next/types/app/layout.ts");
    touch(".next/types/app/board/[boardId]/vocabulario/[...rest]/page.ts");
    touch(".next/types/app/board/[boardId]/vocabulario/[kind]/[id]/page.ts");
    touch(".next/types/app/api/health/route.ts");
    touch(".next/types/routes.d.ts");
    expect(staleNextTypes(dir).map((f: string) => path.relative(dir, f))).toEqual([path.join(".next/types/app/board/[boardId]/vocabulario/[kind]/[id]/page.ts")]);
  });

  it("vale para o distDir do staging, e sem o diretório não há nada a podar", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ah-next-types-"));
    touch(".next-staging/types/app/sumiu/page.ts");
    expect(staleNextTypes(dir, ".next-staging")).toHaveLength(1);
    expect(staleNextTypes(dir)).toEqual([]);
  });
});

// O Next 15.5 gera `types/validator.ts` (importa a fonte de cada página) e `types/routes.d.ts` (lista as rotas). Rota
// renomeada depois do build ⇒ o validator importa a página antiga ⇒ TS2307 — o caso mais comum, que a poda de
// `types/app` não pegava.
describe("staleRouteTypes / pruneNextTypes — o par validator.ts + routes.d.ts", () => {
  const validatorFor = (pages: string[]): string =>
    'import type { AppRoutes } from "./routes.js"\n' +
    pages.map((p) => `// Validate ../../src/app/${p}.tsx\n{ const handler = {} as typeof import("../../src/app/${p}.js") }`).join("\n");
  const routesFor = (routes: string[]): string => `type AppRoutes = ${routes.map((r) => `"${r}"`).join(" | ")}\ntype RedirectRoutes = "/velho-redirect"\n`;
  const NEXT_ENV = '/// <reference types="next" />\n/// <reference path="./.next/types/routes.d.ts" />\n\n// NOTE: This file should not be edited\n';

  const fresh = (): void => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ah-next-types-"));
    touch("src/app/page.tsx");
    touch("src/app/(grupo)/board/[boardId]/page.tsx");
    touch("src/app/api/health/route.ts");
  };

  it("tudo vivo (inclusive rota dentro de grupo e o redirect) ⇒ nada a podar", () => {
    fresh();
    touch(".next/types/validator.ts", validatorFor(["page", "(grupo)/board/[boardId]/page", "api/health/route"]));
    touch(".next/types/routes.d.ts", routesFor(["/", "/board/[boardId]", "/api/health"]));
    expect(staleRouteTypes(dir)).toEqual([]);
  });

  it("o validator importa uma página que sumiu ⇒ validator.ts E routes.d.ts saem, e a referência do next-env também", () => {
    fresh();
    touch(".next/types/validator.ts", validatorFor(["page", "vocabulario/[kind]/[id]/page"]));
    touch(".next/types/routes.d.ts", routesFor(["/"]));
    touch(".next/types/cache-life.d.ts");
    touch("next-env.d.ts", NEXT_ENV);
    expect(staleRouteTypes(dir).map((f: string) => path.relative(dir, f)).sort()).toEqual([".next/types/routes.d.ts", ".next/types/validator.ts"]);
    pruneNextTypes(dir);
    expect(existsSync(path.join(dir, ".next/types/validator.ts"))).toBe(false);
    expect(existsSync(path.join(dir, ".next/types/routes.d.ts"))).toBe(false);
    expect(existsSync(path.join(dir, ".next/types/cache-life.d.ts"))).toBe(true);
    const env = readFileSync(path.join(dir, "next-env.d.ts"), "utf8");
    expect(env).not.toContain("routes.d.ts");
    expect(env).toContain('/// <reference types="next" />');
  });

  it("só o routes.d.ts nomeia uma rota que sumiu ⇒ o par sai (no distDir do staging também)", () => {
    fresh();
    touch(".next-staging/types/validator.ts", validatorFor(["page"]));
    touch(".next-staging/types/routes.d.ts", routesFor(["/", "/sumiu/[id]"]));
    expect(staleRouteTypes(dir, ".next-staging")).toHaveLength(2);
    expect(staleRouteTypes(dir)).toEqual([]);
  });
});
