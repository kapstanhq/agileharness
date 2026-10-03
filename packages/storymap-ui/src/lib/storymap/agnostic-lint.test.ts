// AGNOSTIC LINT — o código da ferramenta não cita o produto de quem a opera.
//
// A ferramenta nasceu dentro do monorepo de um produto e foi extraída para ser genérica: `src/**` não pode trazer nome de
// produto, de serviço nem de pessoa de uma instalação. Este teste lia uma lista desses nomes escrita AQUI — e a lista, num
// repositório público, era o próprio vazamento. Agora os nomes vêm de onde o gate de publicação os lê: o arquivo de termos
// privados do OPERADOR, fora do repositório (`scripts/oss/publication-gate.mjs`). Quem não tem o arquivo (um contribuidor)
// não tem nome privado a vazar, e o teste é pulado; quem publica tem, e o gate o exige (`--require-terms`).
//
// O registro de débito que este arquivo guardava está ZERADO (o último valor de configuração do
// consumidor embutido no fonte virou knob no `.env.example`), então a régua é a mais simples: nenhuma linha de código de
// `src/**` cita um termo privado. Comentários e testes são cobertos pelo gate em modo `--tree`, sobre a árvore inteira.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as gate from "../../../../../scripts/oss/publication-gate.mjs";

const g = gate as unknown as {
  defaultTermsFile: () => string;
  loadPrivateTerms: (file: string) => Array<{ re: RegExp; term: string }> | null;
};

/** Fora da varredura: teste, snapshot, tipos e fixture — o gate os cobre na árvore inteira. */
const isSkipped = (p: string) => /\.test\.(ts|tsx)$|__snapshots__|\.snap$|\.d\.ts$|\/(?:__)?fixtures?(?:__)?\//.test(p);

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js)$/.test(p) && !isSkipped(p)) acc.push(p);
  }
  return acc;
}

const isCommentLine = (t: string) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

const terms = g.loadPrivateTerms(g.defaultTermsFile());

describe("agnostic-lint — nenhuma linha de CÓDIGO de src/** cita um termo privado do operador", () => {
  it.skipIf(!terms?.length)("zero ocorrências fora de comentário (sem arquivo de termos privados o teste é pulado)", () => {
    const offenders: string[] = [];
    // UMA expressão por conjunto de flags: a lista do operador tem centenas de termos, e testar um por um em cada linha
    // do produto custava dezenas de segundos (estourava o tempo do teste com a máquina ocupada). O termo exato só é
    // procurado na linha que casou.
    const byFlags = new Map<string, string[]>();
    for (const r of terms!) byFlags.set(r.re.flags, [...(byFlags.get(r.re.flags) ?? []), `(?:${r.re.source})`]);
    const any = [...byFlags].map(([flags, sources]) => new RegExp(sources.join("|"), flags));
    for (const f of walk("src")) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((ln, i) => {
          const t = ln.trim();
          if (isCommentLine(t) || /oss-allow:\s*\S/.test(t)) return;
          if (!any.some((re) => re.test(t))) return;
          const hit = terms!.find((r) => r.re.test(t));
          if (hit) offenders.push(`${f.replace(/\\/g, "/")}:${i + 1} [${hit.term}] → ${t.slice(0, 100)}`);
        });
    }
    expect(offenders, "Nome privado numa linha de código — injete-o por board.yaml/settings ou por um id opaco; o código da ferramenta não conhece o produto de quem a opera.").toEqual([]);
  });

  it("a varredura enxerga o código (a pasta existe e tem arquivos) — um lint que não lê nada passa sempre", () => {
    expect(walk("src").length).toBeGreaterThan(200);
  });
});
