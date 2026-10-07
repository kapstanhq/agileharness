// A escrita do ARQUITETO no vocabulário — o que a tool `write_vocab` acaba chamando.
//
// O que estes testes travam é a CONTENÇÃO, que é o argumento inteiro para esta escrita ser montável
// num token de LEITURA: a linha tem de existir, o alcance é o prompt (+ tipo e resumo), o default
// ACRESCENTA, campo vazio não apaga nada, e uma linha ainda em campos legados não perde o que a tela
// mostrava. Cada um destes já foi, em algum sistema, o bug de "o agente apagou o meu texto".

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storymap/repo", () => ({ readBoardConfig: vi.fn(), readCards: vi.fn() }));
vi.mock("@/lib/storymap/write", () => ({ updateBoardConfigOnDisk: vi.fn() }));

import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateBoardConfigOnDisk } from "@/lib/storymap/write";
import { appendToVocabAction } from "./vocab-actions";
import type { BoardConfig } from "@/lib/storymap/types";

const base = (): BoardConfig => ({
  id: "storymap",
  name: "AgileHarness",
  statuses: [],
  releases: [],
  personas: [
    { id: "leitor", name: "Leitor Assíduo", color: "#b5651d", prompt: "Compra três livros por mês e relê os favoritos." },
    { id: "legado", name: "Persona Legada", color: "#888", role: "Professora aposentada", jobs: ["Achar edições esgotadas"] },
  ],
  systems: [{ id: "vitrine", name: "Vitrine Online", color: "#2f7f86", kind: "Canal" }],
  linkTypes: [],
});

/**
 * O "disco" do teste. A action escreve por `updateBoardConfigOnDisk` (read-modify-write DENTRO do
 * lock), então o dublê guarda o estado e aplica o `mutate` — assim as asserções leem o que de fato
 * ficou gravado, e uma segunda chamada enxerga o resultado da primeira, como no disco de verdade.
 * A ATOMICIDADE em si é testada onde ela mora: `lib/storymap/board-config-atomic.test.ts`.
 */
let board: BoardConfig;
function persisted(): BoardConfig {
  return board;
}

beforeEach(() => {
  board = base();
  vi.mocked(readBoardConfig).mockReset().mockImplementation(async () => board);
  vi.mocked(readCards).mockReset().mockResolvedValue([]);
  vi.mocked(updateBoardConfigOnDisk)
    .mockReset()
    .mockImplementation(async (_boardId: string, mutate: (c: BoardConfig) => BoardConfig | null) => {
      const next = mutate(board);
      if (next) board = next;
      return next;
    });
});

describe("appendToVocabAction", () => {
  it("ACRESCENTA por default — nunca substitui o que já estava escrito", async () => {
    const res = await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "leitor",
      prompt: "## Dores\n\n- Comparar preço em cinco lojas e largar o carrinho",
    });
    expect(res.ok).toBe(true);
    const p = persisted().personas.find((x) => x.id === "leitor")!;
    expect(p.prompt).toContain("Compra três livros por mês");
    expect(p.prompt).toContain("## Dores");
  });

  it("`replace` substitui — mas só quando NOMEADO na chamada", async () => {
    await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "leitor",
      prompt: "Texto novo inteiro.",
      mode: "replace",
    });
    const p = persisted().personas.find((x) => x.id === "leitor")!;
    expect(p.prompt).toBe("Texto novo inteiro.");
    expect(p.prompt).not.toContain("três livros por mês");
  });

  it("a NOTA entra assinada e datada — é o que separa o apurado do decidido", async () => {
    const res = await appendToVocabAction({
      boardId: "storymap",
      kind: "system",
      id: "vitrine",
      note: "Cupom vale só no primeiro pedido (api/cupom.ts:88).",
      actor: "arquiteto",
    });
    expect(res.ok).toBe(true);
    const s = persisted().systems.find((x) => x.id === "vitrine")!;
    expect(s.prompt).toMatch(/> _arquiteto · \d{4}-\d{2}-\d{2}_/);
    expect(s.prompt).toContain("Cupom vale só");
  });

  it("uma linha LEGADA parte da composição dos campos antigos — acrescentar não pode apagá-los da tela", async () => {
    await appendToVocabAction({ boardId: "storymap", kind: "persona", id: "legado", prompt: "Nota nova." });
    const p = persisted().personas.find((x) => x.id === "legado")!;
    expect(p.prompt).toContain("Professora aposentada");
    expect(p.prompt).toContain("Achar edições esgotadas");
    expect(p.prompt).toContain("Nota nova.");
  });

  it("preenche tipo e resumo — e o resumo cai no campo certo de cada lado", async () => {
    await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "leitor",
      type: "Segmento de mercado",
      summary: "Leitor de ficção, 30–50",
    });
    const p = persisted().personas.find((x) => x.id === "leitor")!;
    expect(p.kind).toBe("Segmento de mercado");
    expect(p.role).toBe("Leitor de ficção, 30–50");

    vi.mocked(readBoardConfig).mockResolvedValue(base());
    await appendToVocabAction({ boardId: "storymap", kind: "system", id: "vitrine", summary: "Onde o leitor vê o catálogo." });
    const s = persisted().systems.find((x) => x.id === "vitrine")!;
    expect(s.description).toBe("Onde o leitor vê o catálogo.");
  });

  it("campo VAZIO nunca limpa nada — e uma chamada sem conteúdo é recusada, não gravada", async () => {
    const res = await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "leitor",
      prompt: "   ",
      type: "",
      summary: "  ",
    });
    expect(res.ok).toBe(false);
    // Recusada ANTES de sequer abrir a seção crítica — nada de tomar o lock para não escrever nada.
    expect(updateBoardConfigOnDisk).not.toHaveBeenCalled();
  });

  it("RECUSA um id que não existe — esta escrita nunca cria linha", async () => {
    const antes = JSON.stringify(persisted());
    const res = await appendToVocabAction({ boardId: "storymap", kind: "persona", id: "fantasma", note: "oi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("leitor"); // diz quais existem
    // Aqui o lock É tomado (só lá dentro se sabe que o id não existe) — mas nada é gravado.
    expect(JSON.stringify(persisted())).toBe(antes);
  });

  it("não alcança nome, cor nem id — o patch preserva a identidade da linha", async () => {
    await appendToVocabAction({ boardId: "storymap", kind: "persona", id: "leitor", note: "nota" });
    const p = persisted().personas.find((x) => x.id === "leitor")!;
    expect(p.name).toBe("Leitor Assíduo");
    expect(p.color).toBe("#b5651d");
    // e não mexe na OUTRA linha
    expect(persisted().personas.find((x) => x.id === "legado")!.prompt).toBeUndefined();
  });
});
