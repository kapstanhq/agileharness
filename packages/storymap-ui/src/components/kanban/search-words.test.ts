import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEARCH_ARIA_LABEL, SEARCH_NARROW_QUERY, SEARCH_PLACEHOLDER, SEARCH_PLACEHOLDER_SHORT, searchPlaceholder } from "./search-words";

// A busca do Kanban em 390px: o placeholder longo era cortado no meio de uma palavra («… ou i»). O rig é node sem DOM:
// a escolha é testada na função pura e, contra o fonte, que o campo a usa.
const box = readFileSync(fileURLToPath(new URL("./KanbanSearchBox.tsx", import.meta.url)), "utf8");

describe("o placeholder da busca do Kanban", () => {
  it("no celular a palavra curta; no computador a frase inteira (o computador não muda)", () => {
    expect(searchPlaceholder(true)).toBe(SEARCH_PLACEHOLDER_SHORT);
    expect(searchPlaceholder(false)).toBe("Buscar funcionalidade ou item…");
    expect(SEARCH_PLACEHOLDER_SHORT).toBe("Buscar");
    // a palavra curta cabe no campo de 390px (~20 caracteres de 16px), a longa não
    expect(SEARCH_PLACEHOLDER_SHORT.length).toBeLessThan(12);
    expect(SEARCH_PLACEHOLDER.length).toBeGreaterThan(20);
  });
  it("o celular é abaixo do `md` (768px) — a mesma quebra das classes da barra", () => {
    expect(SEARCH_NARROW_QUERY).toBe("(max-width: 767px)");
  });
  it("o campo escolhe pela largura e mantém o nome inteiro para o leitor de tela", () => {
    expect(box).toMatch(/const narrow = useMediaQuery\(SEARCH_NARROW_QUERY\);/);
    expect(box).toMatch(/placeholder=\{searchPlaceholder\(narrow\)\}/);
    expect(box).toMatch(/aria-label=\{SEARCH_ARIA_LABEL\}/);
    expect(SEARCH_ARIA_LABEL).toContain("Buscar funcionalidade ou item");
  });
});
