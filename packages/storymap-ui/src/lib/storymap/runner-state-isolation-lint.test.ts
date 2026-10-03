// a TRAVA: nenhum arquivo de teste APAGA o override do diretório de estado do
// runner como instrução solta. Um `delete process.env.AGILEHARNESS_RUNNER_STATE_DIR` num afterAll desfaz o isolamento
// do setup para todo o resto do arquivo — um teste que o fez escreveu recibos de fixture no ledger vivo.
// Quem reaponta o diretório DEVOLVE o valor anterior. O idioma de restauração `if (<anterior> === undefined) delete …;
// else … = <anterior>` é restauração (devolve o que havia) e passa.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function tests(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tests(full));
    else if (/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("o isolamento do estado do runner não é desfeito por teste nenhum", () => {
  it("nenhum `delete process.env.AGILEHARNESS_RUNNER_STATE_DIR` solto em arquivo de teste", () => {
    const bare = new RegExp(`^\\s*${["delete process\\.env\\.", "AGILEHARNESS_RUNNER_STATE_DIR"].join("")}`);
    const offenders: string[] = [];
    for (const f of tests(SRC)) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (bare.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
