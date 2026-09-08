// story-c5uhes (onda 2) — as DUAS CLASSES de recusa de `_base/board.yaml`, e por que elas NÃO podem
// ter o mesmo desfecho.
//
// A onda 1.5 pediu fail-closed para "`_base` recusado" sem qualificar, e `readBaseRaw` passou a LANÇAR
// em QUALQUER recusa do chokepoint — inclusive `invalid-yaml`. Efeito colateral medido: um typo de
// indentação no `_base` (arquivo que agentes e skills editam todo dia) fazia `listBoards` pular TODOS
// os boards e `getBoard` devolver null, ou seja, a UI inteira virava "board não encontrado" — a
// mensagem ERRADA, porque o arquivo existe e o board também.
//
// O pedido original era fail-closed para RECUSA POR CONTROLE DE SEGURANÇA (too-large / too-many-nodes /
// too-deep / forbidden-key / engine-forbidden): ali o modo de falha não pode ser "os gates
// desaparecem". YAML torto é erro HUMANO de digitação — merece alarme alto nomeando arquivo e linha, e
// o caminho de ESCRITA fechado (um save contra base ilegível re-inlina o pipeline canônico e severa a
// herança PARA SEMPRE), não a demolição da leitura.
//
// Nota sobre o mock de `./paths`: espalha o módulo REAL e relocaliza só a raiz para um tmp (mesmo
// padrão de frontmatter.test.ts) — jamais um dir de board vivo.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = path.join(os.tmpdir(), "ah-base-refusal-test");
vi.mock("./paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("./paths")>();
  const boardDir = (boardId: string) => path.join(TMP_ROOT, "boards", real.sanitizeId(boardId));
  return {
    ...real,
    boardsDir: () => path.join(TMP_ROOT, "boards"),
    boardDir,
    cardsDir: (b: string) => path.join(boardDir(b), "cards"),
    cardPath: (b: string, c: string) => path.join(boardDir(b), "cards", `${real.sanitizeId(c)}.md`),
    boardConfigPath: (b: string) => path.join(boardDir(b), "board.yaml"),
    baseBoardConfigPath: () => path.join(TMP_ROOT, "boards", "_base", "board.yaml"),
  };
});

import { deriveBoardConfigForPersist, getBoard, listBoards, readBoardConfig } from "./repo";
import type { BoardConfig } from "./types";

/** O board de teste declara UM passo próprio e herda o resto do `_base`. */
const OWN_BOARD = "id: acme\nname: Nest\nstatuses:\n  - id: triage\n    name: Triagem\n";

/** Um `_base` sadio que carrega um GATE — é o gate que não pode desaparecer numa degradação. */
const BASE_COM_GATE = "statuses:\n  - id: triage\n    name: Triagem\n  - id: desenvolver\n    name: Desenvolver\n    gate: hasTasks\n";

/** Um typo de indentação REAL (o que uma skill produz ao editar o arquivo na pressa). */
const BASE_COM_TYPO = "statuses:\n  - id: triage\n    name: Triagem\n   gate: hasTasks\n";

let mtimeSeq = 0;

/** Escreve o `_base` com mtime ÚNICO: `readBaseRaw` memoiza por mtime, e dois arquivos escritos no
 *  mesmo milissegundo dariam cache hit cruzado entre testes (o bug seria invisível). */
async function writeBase(raw: string): Promise<void> {
  const p = path.join(TMP_ROOT, "boards", "_base", "board.yaml");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, raw, "utf8");
  const t = new Date(Date.UTC(2026, 0, 1 + ++mtimeSeq));
  await fs.utimes(p, t, t);
}

async function writeBoard(id: string, raw: string): Promise<void> {
  const p = path.join(TMP_ROOT, "boards", id, "board.yaml");
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, raw, "utf8");
}

let erros: string[];

beforeEach(() => {
  delete process.env.STORYMAP_FRONTMATTER_MAX_BYTES;
  erros = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    erros.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
});

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("TYPO no `_base`: um erro de digitação não pode apagar TODOS os boards da UI", () => {
  it("o board continua carregando — e o alarme NOMEIA o arquivo e a LINHA (não 'board não encontrado')", async () => {
    await writeBase(BASE_COM_TYPO);
    await writeBoard("acme", OWN_BOARD);

    // A UI viva é exatamente isto: o switcher lista o board e a página o encontra.
    expect((await listBoards()).map((b) => b.id)).toContain("acme");
    expect(await getBoard("acme")).not.toBeNull();

    // E o operador tem como CONSERTAR: o alarme diz o arquivo, o motivo e onde o YAML quebrou.
    const log = erros.join("\n");
    expect(log).toContain("_base/board.yaml");
    expect(log).toContain("invalid-yaml");
    expect(log, "sem a linha/coluna o operador caça o typo às cegas").toMatch(/\(\d+:\d+\)/);
  });

  it("o alarme fala UMA vez por versão do arquivo — um erro por requisição afoga o aviso que importa", async () => {
    await writeBase(BASE_COM_TYPO);
    await writeBoard("acme", OWN_BOARD);

    for (let i = 0; i < 4; i++) await readBoardConfig("acme");

    expect(erros.filter((l) => l.includes("_base/board.yaml"))).toHaveLength(1);
  });

  it("os GATES não desaparecem: com um `_base` já lido e BOM, a herança serve o último parse bom", async () => {
    // O caso real: serviço de longa duração, `_base` já lido, um agente salva o arquivo com um typo.
    // Cair para "sem herança" aqui seria trocar um typo por um downgrade de segurança silencioso — o
    // board resolveria o próprio pipeline, SEM os gates que só existem no `_base`.
    await writeBase(BASE_COM_GATE);
    await writeBoard("acme", OWN_BOARD);
    const bom = await readBoardConfig("acme");
    expect(bom.statuses.find((s) => s.id === "desenvolver")?.gate).toBe("hasTasks");

    await writeBase(BASE_COM_TYPO);

    const degradado = await readBoardConfig("acme");
    expect(degradado.statuses.find((s) => s.id === "desenvolver")?.gate).toBe("hasTasks");
    expect(erros.join("\n")).toContain("_base/board.yaml");
  });

  it("o SAVE fica FECHADO enquanto o `_base` está ilegível — um save assim severa a herança para sempre", async () => {
    // Leitura degrada; ESCRITA não. `deriveBoardConfigForPersist` calcula o delta contra o `_base`:
    // sem base legível ele persiste o config RESOLVIDO inteiro, re-inlinando o pipeline canônico no
    // board.yaml — e isso é IRREVERSÍVEL por um restart, ao contrário de uma leitura degradada.
    await writeBase(BASE_COM_TYPO);
    await writeBoard("acme", OWN_BOARD);
    const resolvido = { id: "acme", name: "Nest", statuses: [], columns: [] } as unknown as BoardConfig;

    await expect(deriveBoardConfigForPersist("acme", resolvido)).rejects.toMatchObject({
      name: "FrontmatterError",
      reason: "invalid-yaml",
    });
  });
});

describe("RECUSA POR CONTROLE DE SEGURANÇA no `_base`: segue fail-CLOSED", () => {
  it("chave que sequestra protótipo (`__proto__`) derruba a leitura, com o motivo nomeado", async () => {
    // Aqui o modo de falha NÃO pode ser "os gates desaparecem": a recusa veio de um guard, e um guard
    // que degrada em silêncio é um guard que o atacante desliga escolhendo o payload.
    await writeBase("__proto__:\n  polluted: true\nstatuses:\n  - id: triage\n    name: Triagem\n");
    await writeBoard("acme", OWN_BOARD);

    await expect(readBoardConfig("acme")).rejects.toMatchObject({
      name: "FrontmatterError",
      reason: "forbidden-key",
    });
    expect(await listBoards(), "nenhum board carrega SEM os gates quando o arquivo que os define é suspeito").toEqual([]);
  });

  it("`_base` acima do teto de bytes também derruba a leitura (o teto é do operador, a recusa é dura)", async () => {
    process.env.STORYMAP_FRONTMATTER_MAX_BYTES = "512";
    await writeBase(`pad: "${"a".repeat(2048)}"\n`);
    await writeBoard("acme", OWN_BOARD);

    await expect(readBoardConfig("acme")).rejects.toMatchObject({
      name: "FrontmatterError",
      reason: "too-large",
    });
  });

  it("uma recusa por controle NÃO é servida pelo último parse bom — o cinto não cede por ter cedido antes", async () => {
    await writeBase(BASE_COM_GATE);
    await writeBoard("acme", OWN_BOARD);
    expect((await readBoardConfig("acme")).statuses.map((s) => s.id)).toContain("desenvolver");

    await writeBase("__proto__:\n  polluted: true\n");

    await expect(readBoardConfig("acme")).rejects.toMatchObject({ reason: "forbidden-key" });
  });
});
