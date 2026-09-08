// `updateBoardConfigOnDisk` — a escrita ATÔMICA do board.yaml.
//
// O que este arquivo trava é UMA regressão concreta, e vale contá-la porque ela não deu erro nenhum:
// o Arquiteto classificou as 7 personas do board numa tacada só, as 7 gravações responderam
// `ok: true`, e sobrou o tipo de UMA. `writeBoardConfig` sempre trancou a GRAVAÇÃO — mas quem lê fora
// do lock, muta o snapshot e grava está numa corrida de lost update. Com escritores HUMANOS (um
// clique de cor, um rename) as janelas nunca se cruzavam; um modelo emite vários `tool_use` numa
// mensagem só e o cliente MCP os despacha em PARALELO, e aí se cruzam todas.
//
// O teste roda a função REAL (com o `withKeyedLock` real) contra um disco de mentira que INTRODUZ
// LATÊNCIA na leitura — sem essa latência o teste passaria mesmo na implementação quebrada, porque o
// event loop de um só thread esconde a corrida.

import { beforeEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";

// O "disco": uma string YAML. `readBoardConfig` a lê (com atraso) e `atomicWriteFile` a substitui —
// exatamente a topologia real, sem fs.
let disk = "";

vi.mock("./repo", () => ({
  readBoardConfig: vi.fn(async () => {
    // Modela uma leitura LENTA de verdade: os bytes que você recebe são os bytes do INSTANTE em que a
    // leitura começou — por isso o snapshot é capturado ANTES do atraso, não depois.
    //
    // Isto é o teste inteiro. Capturando depois, cada leitura já enxergaria a gravação anterior (o
    // event loop drena os microtasks entre callbacks de timer) e o teste passava até na implementação
    // QUEBRADA — verificado: com a leitura fora do lock, ele ficava verde. Um teste de corrida que não
    // reproduz a corrida é pior que nenhum: ele assina embaixo do bug.
    const snapshot = disk;
    await new Promise((r) => setTimeout(r, 5));
    return yaml.load(snapshot) as never;
  }),
  deriveBoardConfigForPersist: vi.fn(async (_boardId: string, config: unknown) => config),
  readCard: vi.fn(),
}));
vi.mock("./atomic-write", () => ({
  atomicWriteFile: vi.fn(async (_path: string, contents: string) => {
    disk = contents;
  }),
}));
vi.mock("./runner/board-data-flush", () => ({ scheduleBoardDataFlush: vi.fn() }));

import { updateBoardConfigOnDisk } from "./write";
import type { BoardConfig, Persona } from "./types";

const PERSONAS = ["operador", "orquestrador", "bruno", "marina", "renata", "caio", "leticia"];

beforeEach(() => {
  disk = yaml.dump({
    id: "storymap",
    name: "AgileHarness",
    statuses: [],
    releases: [],
    linkTypes: [],
    systems: [],
    personas: PERSONAS.map((id) => ({ id, name: id, color: "#888" })),
  });
});

function current(): BoardConfig {
  return yaml.load(disk) as BoardConfig;
}

describe("updateBoardConfigOnDisk", () => {
  it("N escritas CONCORRENTES se acumulam — nenhuma perde a da outra (a regressão das 7 personas)", async () => {
    await Promise.all(
      PERSONAS.map((id) =>
        updateBoardConfigOnDisk("storymap", (config) => ({
          ...config,
          personas: config.personas.map((p: Persona) =>
            p.id === id ? { ...p, kind: id === "operador" || id === "orquestrador" ? "Interna" : "Segmento de mercado" } : p,
          ),
        })),
      ),
    );

    const kinds = current().personas.map((p) => p.kind);
    expect(kinds.filter(Boolean)).toHaveLength(PERSONAS.length); // era 1 antes do lock cobrir a leitura
    expect(current().personas.find((p) => p.id === "operador")?.kind).toBe("Interna");
    expect(current().personas.find((p) => p.id === "leticia")?.kind).toBe("Segmento de mercado");
  });

  it("escritas em CAMPOS DIFERENTES da mesma linha também se acumulam", async () => {
    await Promise.all([
      updateBoardConfigOnDisk("storymap", (c) => ({
        ...c,
        personas: c.personas.map((p: Persona) => (p.id === "bruno" ? { ...p, kind: "Segmento de mercado" } : p)),
      })),
      updateBoardConfigOnDisk("storymap", (c) => ({
        ...c,
        personas: c.personas.map((p: Persona) => (p.id === "bruno" ? { ...p, color: "#ff0000" } : p)),
      })),
    ]);

    const bruno = current().personas.find((p) => p.id === "bruno")!;
    expect(bruno.kind).toBe("Segmento de mercado");
    expect(bruno.color).toBe("#ff0000");
  });

  it("`mutate` devolvendo null NÃO grava — e a função devolve null (a entidade não existe)", async () => {
    const before = disk;
    const res = await updateBoardConfigOnDisk("storymap", () => null);
    expect(res).toBeNull();
    expect(disk).toBe(before);
  });

  it("um `mutate` que LANÇA aborta sem gravar e propaga (o gate recusando)", async () => {
    const before = disk;
    await expect(
      updateBoardConfigOnDisk("storymap", () => {
        throw new Error("recusado pelo gate");
      }),
    ).rejects.toThrow("recusado pelo gate");
    expect(disk).toBe(before);
  });
});
