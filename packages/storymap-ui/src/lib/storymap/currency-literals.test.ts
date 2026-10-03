// A CATRACA da moeda: o código de produção NÃO escreve a moeda de ninguém. «R$» e «BRL» só moram onde a grafia legada é
// LIDA ou preservada (o dado antigo carrega a moeda no nome do campo) e no módulo que formata dinheiro. Um literal novo
// fora desta lista é a dívida voltando — a moeda vem de `target.currency` / `autonomy.budget.currency` (currency.ts).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// «R$» literal (o `R${…}` de um template string não conta: é um identificador terminado em R seguido de interpolação).
const LITERAL = /R\$(?!\{)|\bBRL\b|[a-z]BRL\b/;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Onde o literal é legítimo (cada um com o porquê). */
const ALLOWED: Record<string, string> = {
  "lib/storymap/currency.ts": "o núcleo da moeda: o teto lido por chave legada implica BRL; o golden do formato curto",
  "lib/storymap/cost-impact.ts": "a leitura-alias do teto e da projeção (grafia legada) e a escrita legada de BRL",
  "lib/storymap/types.ts": "os campos da grafia legada (@deprecated, lidos para sempre)",
  "lib/storymap/contracts.ts": "o esquema aceita as duas grafias",
  "lib/storymap/repo.ts": "o coerce lê as duas grafias e devolve a que leu",
  "lib/storymap/write.ts": "o serializer devolve ao disco a grafia que o card tem",
  "lib/storymap/target-profile.ts": "o exemplo de código ISO na mensagem de descarte",
  "lib/storymap/mcp/tools.ts": "record_cost_projection: o alias antigo (DEPRECATED) do condutor",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".next") sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|fixture|spec)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("a moeda não é escrita no código de produção", () => {
  it("«R$» e «BRL» só aparecem nos arquivos da lista (a grafia legada e o formatador)", () => {
    const offenders = sources(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
      .filter((rel) => !(rel in ALLOWED))
      .filter((rel) => LITERAL.test(readFileSync(path.join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("a lista não envelhece: cada arquivo permitido ainda tem o literal (senão sai da lista)", () => {
    const stale = Object.keys(ALLOWED).filter((rel) => !LITERAL.test(readFileSync(path.join(SRC, rel), "utf8")));
    expect(stale).toEqual([]);
  });
});
