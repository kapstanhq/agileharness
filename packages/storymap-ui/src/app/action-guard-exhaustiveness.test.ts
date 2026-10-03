import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// EXAUSTIVIDADE DO GUARD DE SESSÃO — o mesmo padrão de `gate-exhaustiveness.test.ts` e
// `public-routes.test.ts`.
//
// O QUE ESTE TESTE IMPEDE: que uma Server Action NOVA nasça sem `requireSession()` — aberta a
// qualquer chamador que alcance o boundary — e que ninguém perceba. Guardar 122 actions à mão é um
// evento; MANTER as 122 guardadas é um invariante, e invariante que não é testado apodrece na
// primeira action escrita com pressa. Aqui a fricção é deliberada: adicionar uma action passa a
// exigir a linha do guard, e ISENTAR uma passa a exigir editar este arquivo com uma justificativa.

const appDir = fileURLToPath(new URL(".", import.meta.url));
const srcDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Actions deliberadamente SEM guard. Vazio, e que continue assim: qualquer entrada aqui é uma porta
 * aberta com nome e endereço. Uma action que precise ser alcançável antes da sessão não é uma
 * exceção deste teste — é uma rota, e rota se declara em `lib/auth/public-routes.ts`.
 */
const EXEMPT: readonly string[] = [];

/**
 * Todo arquivo `.ts`/`.tsx` sob `src/`, exceto testes.
 *
 * `.tsx` entra porque a diretiva `"use server"` também vale DENTRO de uma função de componente — uma
 * action inline num `.tsx` é uma action de verdade, e um varredor que só olha `.ts` a deixaria nascer
 * sem guard sem ninguém ficar vermelho.
 */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * A diretiva `"use server"` como INSTRUÇÃO (não uma menção em comentário).
 *
 * A flag `m` não é cosmética: sem ela o `^` ancorava no início do ARQUIVO, e neste repo o estilo
 * dominante é abrir o arquivo com um bloco de comentário. Um módulo novo escrito
 * `// por que este arquivo existe\n"use server";` — perfeitamente válido para o Next, que aceita
 * comentários antes da diretiva — ficava INVISÍVEL para este varredor: as actions dele nasciam sem
 * `requireSession()` e o teste de exaustividade seguia verde. Com `m`, a diretiva é reconhecida em
 * qualquer linha, o que também pega a forma INLINE (`"use server"` dentro do corpo de uma função).
 * Comentário não casa: uma linha de comentário começa por `//`, nunca pela aspa.
 */
function isServerActionModule(src: string): boolean {
  return /^\s*["']use server["'];/m.test(src);
}

/** O índice do `{` que abre o corpo da função cuja assinatura começa em `sigStart`. */
function bodyBraceIndex(src: string, sigStart: number): number {
  let i = src.indexOf("(", sigStart);
  let paren = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") paren++;
    else if (src[i] === ")" && --paren === 0) {
      i++;
      break;
    }
  }
  // Um `{` dentro de `<...>` pertence ao TIPO de retorno (`Promise<{ ok: true }>`), não ao corpo.
  let angle = 0;
  for (; i < src.length; i++) {
    if (src[i] === "<") angle++;
    else if (src[i] === ">") angle = Math.max(0, angle - 1);
    else if (src[i] === "{" && angle === 0) return i;
  }
  return -1;
}

interface Action {
  file: string;
  name: string;
  /** o começo do corpo, para conferir a PRIMEIRA instrução. */
  bodyHead: string;
}

const modules = collectSources(srcDir)
  .map((file) => ({ file, src: readFileSync(file, "utf8") }))
  .filter(({ src }) => isServerActionModule(src));

const actions: Action[] = modules.flatMap(({ file, src }) =>
  [...src.matchAll(/^export async function (\w+)\(/gm)].map((m) => {
    const brace = bodyBraceIndex(src, m.index);
    return { file: path.relative(appDir, file), name: m[1], bodyHead: src.slice(brace + 1, brace + 160) };
  }),
);

describe("toda Server Action verifica a sessão DENTRO do boundary", () => {
  it("o teste enxerga os módulos 'use server' de verdade", () => {
    // Auto-checagem: sem isto, um bug na descoberta faria o teste passar com ZERO actions — a
    // "capacidade declarada com zero produtores" que este repo já pagou uma vez.
    expect(modules.length).toBeGreaterThanOrEqual(9);
    expect(actions.length).toBeGreaterThanOrEqual(120);
    expect(actions.map((a) => a.name)).toContain("deleteCardAction");
    expect(actions.map((a) => a.name)).toContain("publishStagedAction");
  });

  it("a PRIMEIRA instrução de cada action é `await requireSession(<nome>)`", () => {
    const semGuard = actions
      .filter((a) => !EXEMPT.includes(a.name))
      .filter((a) => !new RegExp(`^\\s*await requireSession\\("${a.name}"\\);`).test(a.bodyHead))
      .map((a) => `${a.file}: ${a.name}`);
    // Primeira instrução, não "em algum lugar do corpo": um guard depois do primeiro `await` já
    // deixou o efeito acontecer, e um guard dentro do `try` viraria um `{ok:false}` engolido.
    expect(semGuard).toEqual([]);
  });

  it("todo módulo de action importa o guard de uma única fonte", () => {
    for (const { file, src } of modules) {
      expect(src, path.relative(appDir, file)).toContain('import { requireSession } from "@/lib/auth/action-guard";');
    }
  });

  it("nenhuma isenção silenciosa — a lista de exceções está vazia", () => {
    expect(EXEMPT).toEqual([]);
  });
});
