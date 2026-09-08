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
import { appendToVocabAction, vocabChatContextAction } from "./vocab-actions";
import type { BoardConfig } from "@/lib/storymap/types";

const base = (): BoardConfig => ({
  id: "storymap",
  name: "AgileHarness",
  statuses: [],
  releases: [],
  personas: [
    { id: "curioso", name: "Curioso Cultural", color: "#7e9ac2", prompt: "Você é o Curioso Cultural." },
    { id: "legado", name: "Persona Legada", color: "#888", role: "Adulto urbano", jobs: ["Descobrir eventos"] },
  ],
  systems: [{ id: "wa", name: "Canal WhatsApp", color: "#4FA873", kind: "Canal" }],
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
      id: "curioso",
      prompt: "## Dores\n\n- Rolar cinco apps e sair sem decidir",
    });
    expect(res.ok).toBe(true);
    const p = persisted().personas.find((x) => x.id === "curioso")!;
    expect(p.prompt).toContain("Você é o Curioso Cultural.");
    expect(p.prompt).toContain("## Dores");
  });

  it("`replace` substitui — mas só quando NOMEADO na chamada", async () => {
    await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "curioso",
      prompt: "Texto novo inteiro.",
      mode: "replace",
    });
    const p = persisted().personas.find((x) => x.id === "curioso")!;
    expect(p.prompt).toBe("Texto novo inteiro.");
    expect(p.prompt).not.toContain("Curioso Cultural.");
  });

  it("a NOTA entra assinada e datada — é o que separa o apurado do decidido", async () => {
    const res = await appendToVocabAction({
      boardId: "storymap",
      kind: "system",
      id: "wa",
      note: "Janela de 24h da API oficial (api/whatsapp.ts:88).",
      actor: "arquiteto",
    });
    expect(res.ok).toBe(true);
    const s = persisted().systems.find((x) => x.id === "wa")!;
    expect(s.prompt).toMatch(/> _arquiteto · \d{4}-\d{2}-\d{2}_/);
    expect(s.prompt).toContain("Janela de 24h");
  });

  it("uma linha LEGADA parte da composição dos campos antigos — acrescentar não pode apagá-los da tela", async () => {
    await appendToVocabAction({ boardId: "storymap", kind: "persona", id: "legado", prompt: "Nota nova." });
    const p = persisted().personas.find((x) => x.id === "legado")!;
    expect(p.prompt).toContain("Adulto urbano");
    expect(p.prompt).toContain("Descobrir eventos");
    expect(p.prompt).toContain("Nota nova.");
  });

  it("preenche tipo e resumo — e o resumo cai no campo certo de cada lado", async () => {
    await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "curioso",
      type: "Segmento de mercado",
      summary: "Adulto urbano, 28–45",
    });
    const p = persisted().personas.find((x) => x.id === "curioso")!;
    expect(p.kind).toBe("Segmento de mercado");
    expect(p.role).toBe("Adulto urbano, 28–45");

    vi.mocked(readBoardConfig).mockResolvedValue(base());
    await appendToVocabAction({ boardId: "storymap", kind: "system", id: "wa", summary: "Ponto de contato." });
    const s = persisted().systems.find((x) => x.id === "wa")!;
    expect(s.description).toBe("Ponto de contato.");
  });

  it("campo VAZIO nunca limpa nada — e uma chamada sem conteúdo é recusada, não gravada", async () => {
    const res = await appendToVocabAction({
      boardId: "storymap",
      kind: "persona",
      id: "curioso",
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
    if (!res.ok) expect(res.error).toContain("curioso"); // diz quais existem
    // Aqui o lock É tomado (só lá dentro se sabe que o id não existe) — mas nada é gravado.
    expect(JSON.stringify(persisted())).toBe(antes);
  });

  it("não alcança nome, cor nem id — o patch preserva a identidade da linha", async () => {
    await appendToVocabAction({ boardId: "storymap", kind: "persona", id: "curioso", note: "nota" });
    const p = persisted().personas.find((x) => x.id === "curioso")!;
    expect(p.name).toBe("Curioso Cultural");
    expect(p.color).toBe("#7e9ac2");
    // e não mexe na OUTRA linha
    expect(persisted().personas.find((x) => x.id === "legado")!.prompt).toBeUndefined();
  });
});

describe("vocabChatContextAction", () => {
  it("descreve as duas metades, marca quem está sem tipo e quem está em branco", async () => {
    const ctx = await vocabChatContextAction("storymap");
    expect(ctx).toContain("## Personas (2)");
    expect(ctx).toContain("## Sistemas (1)");
    expect(ctx).toContain("SEM TIPO declarado"); // a persona `curioso` não tem kind
    expect(ctx).toContain("VAZIO"); // o sistema `wa` não tem prompt
  });

  it("com FOCO, o prompt daquela linha vai INTEIRO e o resto continua listado", async () => {
    const ctx = await vocabChatContextAction("storymap", { kind: "persona", id: "curioso" });
    expect(ctx).toContain("Persona em foco: `curioso`");
    expect(ctx).toContain("Você é o Curioso Cultural.");
    expect(ctx).toContain("## Sistemas (1)"); // a comparação com as outras não se perde
  });

  it("é à prova de falha: um erro de leitura vira um bloco de aviso, não uma exceção", async () => {
    vi.mocked(readBoardConfig).mockRejectedValue(new Error("board.yaml torto"));
    await expect(vocabChatContextAction("storymap")).resolves.toContain("board.yaml torto");
  });
});
