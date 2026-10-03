// A TRAVA dos links do Inbox, no estilo do agnostic-lint: nenhum arquivo monta
// à mão um `…/inbox?focus=…` ou um `` `/inbox/${…}` ``. Eram 7 sítios, cada um com a sua forma — o popover do cabeçalho,
// a pílula do card no Kanban, o toast do Kanban, o rodapé do card, o registry (2×) e o template do overlay —, uns
// sem encodar o id, todos card-scoped (acendiam o PRIMEIRO item do card). O link de um item é construído em UM
// lugar: deep-links.ts (`inboxItemHref`, `inboxListItemHref`, `inboxHref`).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const OWNER = path.join(SRC, "lib", "storymap", "deep-links.ts");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("links do Inbox só em deep-links.ts", () => {
  it("nenhum `/inbox?focus=` nem `` `/inbox/${…}` `` montado à mão fora de deep-links.ts", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (file === OWNER) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/\/inbox\?focus=/.test(line) || /\/inbox\/\$\{/.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
