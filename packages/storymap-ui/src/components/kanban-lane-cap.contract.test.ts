import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A raia do fim do fluxo, na vista em raias, não desenha centenas de cards: os mais recentes e «Mostrar todos»; a busca
// mostra tudo o que casou. Sem isto a página do Kanban de um board maduro pesava o dobro (HTML do servidor e hidratação).
const src = readFileSync(path.join(__dirname, "KanbanBoard.tsx"), "utf8");

describe("raia «No ar» com teto na vista em raias", () => {
  it("só a raia cujos status são todos terminais é cortada, nunca durante a busca, e abre no lugar", () => {
    expect(src).toMatch(/lane\.statuses\.every\(\(id\) => config\.statuses\.find\(\(st\) => st\.id === id\)\?\.terminal === true\)/);
    expect(src).toMatch(/const capDone = terminalLane && !filtering && !showAllDone && sorted\.length > TERMINAL_LANE_CAP;/);
    expect(src).toMatch(/Mostrar todos \(\{sorted\.length\}\)/);
  });
});
