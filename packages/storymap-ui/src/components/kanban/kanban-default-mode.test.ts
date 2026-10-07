import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KANBAN_DEFAULT_MODE, isKanbanShowMode } from "./show-mode";

// O recorte com que o Kanban abre é TUDO (decisão do dono, 07/10): «Exceções» como padrão deixava um board parado ou
// sem nada fora do trilho com as colunas vazias — estranho e inesperado. «Exceções» segue no menu «Mostrar».
const here = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8");

describe("o recorte padrão do Kanban", () => {
  it("é Tudo", () => {
    expect(KANBAN_DEFAULT_MODE).toBe("all");
  });

  it("o board começa no padrão e só troca pela escolha guardada da pessoa, validada", () => {
    const board = read("../KanbanBoard.tsx");
    expect(board).toMatch(/useState<KanbanShowMode>\(KANBAN_DEFAULT_MODE\)/);
    expect(board).not.toMatch(/useState<KanbanShowMode>\("exc"\)/);
    expect(board).toMatch(/isKanbanShowMode\(saved\)/);
  });

  it("o menu lista Tudo primeiro e mantém Exceções como opção", () => {
    const menu = read("./KanbanFilterMenu.tsx");
    expect(menu).toMatch(/\[\{ id: "all" \}, \{ id: "exc", sep: true \}/);
  });

  it("valida o valor guardado no navegador", () => {
    expect(isKanbanShowMode("all")).toBe(true);
    expect(isKanbanShowMode("exc")).toBe(true);
    expect(isKanbanShowMode("tudo")).toBe(false);
    expect(isKanbanShowMode("")).toBe(false);
  });
});
