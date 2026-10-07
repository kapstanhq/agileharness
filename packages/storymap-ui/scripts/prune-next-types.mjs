#!/usr/bin/env node
// prune-next-types.mjs — tira de `.next/types/app` os arquivos de tipo de ROTAS QUE NÃO EXISTEM MAIS, antes do `tsc`.
//
// POR QUE EXISTE. O `tsconfig.json` inclui `.next/types/**/*.ts` (é onde o build gera o contrato de props de cada
// página). Quando uma rota é renomeada, o arquivo gerado para o nome antigo fica para trás num diretório de build
// reaproveitado, e o `tsc` passa a falhar com TS2307 apontando para uma página que ninguém escreveu — medido num
// clone de release (`vocabulario/[kind]/[id]` → `vocabulario/[...rest]`). Apagar `.next/types` inteiro não serve: o
// `next-env.d.ts` que o build escreve referencia arquivos dali, e o contrato das rotas VIVAS se perderia.
//
// O que ele faz: para cada `<distDir>/types/app/<rota>/<arquivo>.ts`, confere se a fonte `src/app/<rota>/<arquivo>.{tsx,ts,jsx,js}`
// existe; se não existe, apaga o gerado. Vale para os DOIS distDirs que o tsconfig inclui (`.next` e o `.next-staging`
// do build de staging — o include deste fica: o próprio `next build` o recoloca no tsconfig quando falta).
//
// O PAR DE ROTAS do Next 15.5: `<distDir>/types/validator.ts` importa a fonte de CADA página/rota
// (`import("../../src/app/<rota>/page.js")`) e `<distDir>/types/routes.d.ts` lista as rotas. Renomeada uma rota depois do
// último build, o validator segue importando a página antiga e o `tsc` falha com TS2307 — o caso MAIS comum. Os dois
// nascem juntos (o validator importa `./routes.js`), então quando UM deles cita uma fonte que não existe mais, os DOIS
// saem — e a linha `/// <reference path="./<distDir>/types/routes.d.ts" />` do `next-env.d.ts` (gerado, fora do git)
// sai junto, senão o `tsc` falharia com TS6053 no arquivo apagado. O próximo `next build`/`next typegen` os recria.
// Nada mais é tocado. Sem o diretório, não faz nada.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTS = [".tsx", ".ts", ".jsx", ".js"];

export const DIST_DIRS = [".next", ".next-staging"];

/** Os arquivos gerados em `<pkg>/<distDir>/types/app` cuja fonte em `<pkg>/src/app` sumiu. Só lê o disco. */
export function staleNextTypes(pkgDir, distDir = ".next") {
  const typesApp = path.join(pkgDir, distDir, "types", "app");
  const srcApp = path.join(pkgDir, "src", "app");
  if (!existsSync(typesApp)) return [];
  const stale = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".ts")) {
        const rel = path.relative(typesApp, abs).slice(0, -".ts".length);
        if (!SOURCE_EXTS.some((ext) => existsSync(path.join(srcApp, rel + ext)))) stale.push(abs);
      }
    }
  };
  walk(typesApp);
  return stale;
}

const hasSource = (absNoExt) => SOURCE_EXTS.some((ext) => existsSync(absNoExt + ext));

/** As rotas que `src/app` serve hoje (página, handler ou layout), no formato do `routes.d.ts` (`/a/[b]`). Só lê o disco. */
export function appRoutesOf(pkgDir) {
  const srcApp = path.join(pkgDir, "src", "app");
  const routes = new Set();
  if (!existsSync(srcApp)) return routes;
  const walk = (dir, segs) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        // grupo `(x)` e slot paralelo `@x` não aparecem no caminho da rota
        const hidden = /^\(.*\)$/.test(e.name) || e.name.startsWith("@");
        walk(path.join(dir, e.name), hidden ? segs : [...segs, e.name]);
      } else if (/^(page|route|layout)\.(tsx|ts|jsx|js)$/.test(e.name)) routes.add("/" + segs.join("/"));
    }
  };
  walk(srcApp, []);
  return routes;
}

/** As rotas que o `routes.d.ts` declara como servidas pelo app (páginas, handlers e layouts — não redirect/rewrite). */
function declaredRoutes(routesDts) {
  const out = [];
  for (const m of routesDts.matchAll(/^type (?:AppRoutes|AppRouteHandlerRoutes|LayoutRoutes) = (.+)$/gm)) {
    for (const lit of m[1].matchAll(/"([^"]*)"/g)) out.push(lit[1]);
  }
  return out;
}

/**
 * O par `validator.ts` + `routes.d.ts` de `<pkg>/<distDir>/types`, quando UM deles cita uma fonte de `src/app` que
 * sumiu (o validator importa a página; o routes.d.ts nomeia a rota). Devolve os arquivos a apagar (os dois que existem)
 * ou nada. Só lê o disco.
 */
export function staleRouteTypes(pkgDir, distDir = ".next") {
  const typesDir = path.join(pkgDir, distDir, "types");
  const validator = path.join(typesDir, "validator.ts");
  const routesDts = path.join(typesDir, "routes.d.ts");
  const srcApp = path.join(pkgDir, "src", "app");
  let stale = false;
  if (existsSync(validator)) {
    for (const m of readFileSync(validator, "utf8").matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const abs = path.resolve(typesDir, m[1]);
      if (!abs.startsWith(srcApp + path.sep)) continue;
      if (!hasSource(abs.replace(/\.(js|jsx|ts|tsx)$/, ""))) {
        stale = true;
        break;
      }
    }
  }
  if (!stale && existsSync(routesDts)) {
    const live = appRoutesOf(pkgDir);
    stale = declaredRoutes(readFileSync(routesDts, "utf8")).some((r) => !live.has(r));
  }
  return stale ? [validator, routesDts].filter((f) => existsSync(f)) : [];
}

/** O `next-env.d.ts` sem a referência ao `routes.d.ts` deste distDir (o resto intacto). PURA. */
export function nextEnvWithoutRoutesRef(content, distDir) {
  const ref = `./${distDir}/types/routes.d.ts`;
  return content
    .split("\n")
    .filter((l) => !(l.trim().startsWith("///") && l.includes(`path="${ref}"`)))
    .join("\n");
}

/** Apaga o que está velho nos dois distDirs (e a referência órfã do `next-env.d.ts`). Devolve o que apagou. */
export function pruneNextTypes(pkgDir) {
  const removed = [];
  for (const d of DIST_DIRS) {
    const routePair = staleRouteTypes(pkgDir, d);
    for (const f of [...staleNextTypes(pkgDir, d), ...routePair]) {
      rmSync(f, { force: true });
      removed.push(f);
    }
    const nextEnv = path.join(pkgDir, "next-env.d.ts");
    if (routePair.some((f) => f.endsWith("routes.d.ts")) && existsSync(nextEnv)) {
      const before = readFileSync(nextEnv, "utf8");
      const after = nextEnvWithoutRoutesRef(before, d);
      if (after !== before) writeFileSync(nextEnv, after);
    }
  }
  return removed;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const removed = pruneNextTypes(pkgDir);
  if (removed.length) process.stderr.write(`prune-next-types: ${removed.length} tipo(s) gerado(s) de rota que não existe mais removido(s) de <distDir>/types\n`);
}
