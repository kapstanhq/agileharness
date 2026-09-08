// 📐 LINT ANTI-OVERFIT da Camada 2. Guarda mecanicamente a regra que o sistema de documento inteiro
// depende de manter:
//
//   **Nenhum termo do SCHEMA pode existir só porque uma view existe.**
//
// A dívida que este lint impede é concreta e já aconteceu uma vez: o registro de blocos do Lean
// Canvas carregava `cell: "order-2 lg:col-start-1 lg:row-span-2"` — strings de grid Tailwind DENTRO
// do contrato que descreve conteúdo. Com isso, trocar o quadro de 5 para 4 colunas exigia editar a
// descrição do CONTEÚDO, e qualquer view nova nascia herdando as decisões visuais da anterior.
//
// Os dois testes são os que o relatório de arquitetura nomeou:
//   · APAGAMENTO       — apague a view de quadro: sobra algum termo órfão no schema?
//   · TERCEIRA ENTIDADE — o contrato descreve canvas, card e persona sem UMA palavra que só faça
//                         sentido em um dos três?
//
// O que NÃO é banido, e por quê: `color` no frontmatter de um schema. A cor de um segmento é DADO
// autoral (o operador a escolhe, ela viaja no documento e QUALQUER view a usa — ponto do kanban,
// borda do cartão, tarja da tabela). Layout é como a tela ARRUMA as coisas; cor de um datum é o
// datum. A linha é essa, e é deliberada.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** O contrato em si — o arquivo que precisa ser universal. */
const CONTRACT = "src/lib/storymap/doc/doc-schema.ts";
/** As instâncias — podem nomear a própria entidade, mas não podem descrever tela. */
const SCHEMAS_DIR = "src/lib/storymap/doc/schemas";

function schemaFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
    }
  };
  walk(SCHEMAS_DIR);
  return out;
}

const isCommentLine = (t: string) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

/** Linhas de código (comentário é prosa — pode e deve explicar as views). */
function codeLines(file: string): { n: number; text: string }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => !isCommentLine(text.trim()));
}

/**
 * Vocabulário de LAYOUT: classe utilitária, breakpoint, célula de grade, nome de view, biblioteca de
 * ícone. Se aparecer no schema, a Camada 3 vazou para a Camada 2.
 */
const LAYOUT_VOCAB: { re: RegExp; why: string }[] = [
  { re: /\b(col|row)-(start|span|end)\b/, why: "célula de grid (Tailwind) — vai no layout da view" },
  { re: /\b(sm|md|lg|xl|2xl):[a-z-]+/, why: "breakpoint Tailwind — vai no layout da view" },
  { re: /\bclassName\b/, why: "classe de CSS — a Camada 2 não renderiza nada" },
  { re: /\b(px|py|pt|pb|pl|pr|mx|my|gap|w|h)-\[?\d/, why: "espaçamento/tamanho — vai no layout da view" },
  { re: /\bcell\b/i, why: "célula é posição numa tela, não uma propriedade do conteúdo" },
  { re: /\bitemStyle\b/i, why: "estilo do item é decisão da view" },
  { re: /\bpost-?it\b/i, why: "post-it é uma RENDERIZAÇÃO de `items` — a view escolhe, o schema não" },
  { re: /\bkanban\b/i, why: "nome de view dentro do contrato de conteúdo" },
  { re: /\blucide\b/i, why: "biblioteca de ícone — Camada 3" },
  { re: /\bicon\b/i, why: "ícone é decoração da view" },
];

/** Nomes de ENTIDADE — proibidos no contrato universal (as instâncias podem, é o assunto delas). */
const ENTITY_VOCAB = /\b(canvas|persona|wireframe|kanban|ideia|storymap)\b/i;

/** Módulos que tornariam a Camada 2 não-importável pelo cliente (o `tsc --noEmit` NÃO pega isto). */
const SERVER_ONLY_IMPORTS = /from\s+["'](node:|fs|path|gray-matter|react|next\/)/;

describe("Camada 2 — teste do APAGAMENTO (nenhum vocabulário de view no schema)", () => {
  it("o contrato e as instâncias não descrevem tela", () => {
    const offenders: string[] = [];
    for (const file of [CONTRACT, ...schemaFiles()]) {
      for (const { n, text } of codeLines(file)) {
        for (const { re, why } of LAYOUT_VOCAB) {
          if (re.test(text)) offenders.push(`${file}:${n} → ${text.trim().slice(0, 70)}  [${why}]`);
        }
      }
    }
    expect(
      offenders,
      "Vocabulário de LAYOUT num schema de conteúdo. Mova para components/doc/views/board-layouts/<docType>.ts — a view importa o layout, o schema nunca.",
    ).toEqual([]);
  });
});

describe("Camada 2 — teste da TERCEIRA ENTIDADE (o contrato é universal)", () => {
  it("doc-schema.ts não nomeia nenhuma entidade concreta", () => {
    const offenders = codeLines(CONTRACT)
      .filter(({ text }) => ENTITY_VOCAB.test(text))
      .map(({ n, text }) => `${CONTRACT}:${n} → ${text.trim().slice(0, 70)}`);
    expect(
      offenders,
      "O contrato de conteúdo nomeou uma entidade. Ele descreve QUALQUER documento — o específico vai numa instância em doc/schemas/.",
    ).toEqual([]);
  });

  it("o vocabulário do contrato descreve as três entidades sem termo específico", () => {
    // A prova positiva do mesmo princípio: as primitivas de conteúdo bastam para os três casos
    // reais e nenhuma delas foi inventada para um deles.
    const source = readFileSync(CONTRACT, "utf8");
    for (const kind of ["prose", "items", "checklist", "table", "groups"]) {
      expect(source, `primitiva ${kind}`).toContain(`"${kind}"`);
    }
  });
});

describe("Camada 2 — pureza (o cliente importa isto)", () => {
  it("nenhum schema importa módulo de servidor", () => {
    const offenders: string[] = [];
    for (const file of [CONTRACT, ...schemaFiles()]) {
      for (const { n, text } of codeLines(file)) {
        if (SERVER_ONLY_IMPORTS.test(text)) offenders.push(`${file}:${n} → ${text.trim()}`);
      }
    }
    expect(
      offenders,
      "Import de servidor na Camada 2 — o cliente importa o schema para decidir as views, e isto reprova o `next build` (o tsc não vê).",
    ).toEqual([]);
  });
});
