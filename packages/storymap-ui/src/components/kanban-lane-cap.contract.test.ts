import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A raia do fim do fluxo («No ar») não desenha centenas de cards. Sem isto a página do Kanban de um board maduro pesava o
// dobro (HTML do servidor e hidratação). No quadro novo a raia No ar não é uma lista de cards: mostra só o que CHEGOU desde
// a última visita e, sob pedido, o histórico — com teto. A busca recorta as duas listas pelo que casou.
const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8");

describe("raia «No ar» com teto", () => {
  it("o Kanban desenha a raia terminal pela coluna No ar — nunca como lista de cards por funcionalidade", () => {
    const board = read("KanbanBoard.tsx");
    expect(board).toMatch(/\} else if \(lane\.role === "live"\) \{\s*body = <LiveColumn /);
    // e o papel «live» é o da raia cujos status são todos terminais (quando o id não é o do _base)
    expect(read("../lib/storymap/kanban-features.ts")).toMatch(/defs\.every\(\(d\) => d!\.terminal === true\)\) return "live"/);
  });

  it("o histórico abre no lugar, cortado nos últimos HISTORY_CAP (20) — a busca TIRA o teto (mostra tudo o que casou)", () => {
    const col = read("kanban/LiveColumn.tsx");
    expect(col).toMatch(/export const HISTORY_CAP = 20;/);
    expect(col).toMatch(/const historyUncapped = searching \|\| allHistory;/);
    expect(col).toMatch(/const shownHistory = historyUncapped \? sorted : sorted\.slice\(0, HISTORY_CAP\);/);
    expect(col).toMatch(/\[\.\.\.cards\]\.filter\(query\)/);
    expect(col).toMatch(/Ver histórico \(\$\{sorted\.length\} no ar\)/);
    // o Kanban avisa a coluna quando há busca
    expect(read("KanbanBoard.tsx")).toMatch(/<LiveColumn [^>]*searching=\{searching\}/);
  });

  it("as novidades também têm teto: um board revisitado semanas depois não desenha centenas de cards", () => {
    const col = read("kanban/LiveColumn.tsx");
    expect(col).toMatch(/const fresh = allFresh \? freshAll : freshAll\.slice\(0, HISTORY_CAP\);/);
    expect(col).toMatch(/\{fresh\.map\(/);
    expect(col).not.toMatch(/\{freshAll\.map\(/);
  });

  it("a chegada ao ar é a transição do ledger, nunca a última escrita do card", () => {
    const col = read("kanban/LiveColumn.tsx");
    expect(col).toMatch(/const arrivedAt = \(c: Card\) => arrivals\.get\(c\.id\) \?\? null;/);
    expect(col).not.toMatch(/updatedMs/);
  });

  it("a última visita mora no localStorage COM try/catch (janela privada não derruba a raia)", () => {
    const col = read("kanban/LiveColumn.tsx");
    expect(col).toMatch(/try \{\s*const v = window\.localStorage\.getItem/);
    expect(col).toMatch(/try \{\s*window\.localStorage\.setItem/);
  });
});
