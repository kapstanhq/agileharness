// ATAQUE: apagar todo gate herdado do board com UM caractere errado e um restart.
//
// A degradação por typo do `_base` (onda 1.6) serve "o último parse bom" no lugar dos bytes tortos —
// certo para um serviço vivo. Mas o último-bom morava SÓ na memória do processo, e num processo FRIO
// (o restart que um deploy faz, o systemd depois de um crash) ele não existe: a herança caía para
// DESLIGADA e todo gate que só vive no `_base` desaparecia, com a UI seguindo plenamente funcional. É a
// pior combinação possível — parece que funciona —, e é fail-OPEN, não degradação.
//
// A janela era realista: quem escreve board-data (agente, skill, PR de contribuidor no repo público)
// não precisa de credencial nova, só de um YAML torto no `_base` e de esperar o próximo restart. Daí em
// diante o pipeline resolvido é o que cada board.yaml declara — sem `gate:`, portanto sem nenhuma
// verificação entre passos.
//
// Estes testes medem o remédio pelo comportamento observável do board: com o `_base` torto e o processo
// FRIO, o gate herdado tem de continuar de pé porque a última versão boa está PERSISTIDA em disco. E o
// caso residual (nenhum último-bom em lugar nenhum) tem de gritar em letras o que deixou de valer, em
// vez de servir um board silenciosamente sem gates.
//
// Nota sobre o mock de `./paths`: espalha o módulo REAL e relocaliza só a raiz para um tmp (mesmo padrão
// de repo-base-refusal.test.ts) — jamais um dir de board vivo, e jamais o `.runner` do serviço.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = path.join(os.tmpdir(), "ah-base-lastgood-test");
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

import { baseLastGoodSnapshotPath, readBoardConfig } from "./repo";

/** O board de teste declara UM passo próprio, SEM gate, e herda o resto do `_base`. É essa ausência que
 *  torna o downgrade mensurável: se a herança cair, não sobra nenhuma verificação no pipeline. */
const OWN_BOARD = "id: acme\nname: Nest\nstatuses:\n  - id: triage\n    name: Triagem\n";

/** O `_base` bom carrega o GATE — o controle que não pode desaparecer num restart. */
const BASE_COM_GATE =
  "statuses:\n  - id: triage\n    name: Triagem\n  - id: desenvolver\n    name: Desenvolver\n    gate: hasTasks\n";

/** Um typo de indentação REAL (o que uma skill produz ao editar o arquivo na pressa). */
const BASE_COM_TYPO = "statuses:\n  - id: triage\n    name: Triagem\n   gate: hasTasks\n";

const BASE_FILE = () => path.join(TMP_ROOT, "boards", "_base", "board.yaml");

let mtimeSeq = 0;

/** Escreve o `_base` com mtime ÚNICO: `readBaseRaw` memoiza por mtime, e dois arquivos escritos no mesmo
 *  milissegundo dariam cache hit cruzado entre testes (o bug ficaria invisível). */
async function writeBase(raw: string): Promise<void> {
  const p = BASE_FILE();
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

/** Planta o snapshot que "o boot ANTERIOR deixou". É o estado que faz este teste medir um processo FRIO
 *  sem recarregar o módulo: o snapshot é a única memória que atravessa um restart. */
async function plantaSnapshot(raw: string): Promise<void> {
  const p = baseLastGoodSnapshotPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, raw, "utf8");
}

async function snapshotExiste(): Promise<boolean> {
  return fs
    .stat(baseLastGoodSnapshotPath())
    .then(() => true)
    .catch(() => false);
}

/**
 * O reset mais próximo de um PROCESSO NOVO que se consegue sem recarregar o módulo: com o `_base`
 * ausente, `readBaseRaw` zera o último-bom em memória (e o snapshot). Depois disto, tudo que a leitura
 * seguinte souber sobre o `_base` veio do DISCO — que é exatamente o que se quer medir.
 */
async function reiniciaProcesso(): Promise<void> {
  await fs.rm(BASE_FILE(), { force: true });
  await readBoardConfig("acme");
}

let erros: string[];

beforeEach(async () => {
  delete process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES;
  erros = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    erros.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await writeBoard("acme", OWN_BOARD);
});

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("o `_base` torto não pode levar os gates embora num RESTART (processo frio)", () => {
  it("[ATAQUE] com o `_base` torto e ZERO memória de processo, o gate herdado continua de pé", async () => {
    // O estado exato depois de um deploy: nada em memória, o snapshot do boot anterior no disco, e o
    // `_base` vivo torto. Antes, aqui a herança era DESLIGADA e `desenvolver` (com o gate) simplesmente
    // não existia no pipeline resolvido — o board seguia servindo, sem nenhuma verificação.
    await reiniciaProcesso();
    await plantaSnapshot(BASE_COM_GATE);
    await writeBase(BASE_COM_TYPO);

    const config = await readBoardConfig("acme");

    expect(
      config.statuses.find((s) => s.id === "desenvolver")?.gate,
      "o gate que só existe no `_base` desapareceu num processo frio — degradação virou fail-open",
    ).toBe("hasTasks");
  });

  it("o alarme NOMEIA que a herança veio do disco (o operador precisa saber que está servindo cópia)", async () => {
    await reiniciaProcesso();
    await plantaSnapshot(BASE_COM_GATE);
    await writeBase(BASE_COM_TYPO);

    await readBoardConfig("acme");

    const log = erros.join("\n");
    expect(log).toContain("_base/board.yaml");
    expect(log, "servir cópia sem dizer que é cópia esconde do operador que o arquivo vivo está torto").toContain(
      "ÚLTIMA VERSÃO BOA PERSISTIDA",
    );
  });

  it("um `_base` BOM persiste o snapshot — é isso que faz o restart ter o que servir", async () => {
    await reiniciaProcesso();
    await writeBase(BASE_COM_GATE);

    expect((await readBoardConfig("acme")).statuses.find((s) => s.id === "desenvolver")?.gate).toBe("hasTasks");
    // Os BYTES, não uma reserialização: reler o snapshot tem de produzir o mesmo mapa que o arquivo
    // produzia (um dump em YAML/JSON traria drift silencioso de tipo).
    expect(await fs.readFile(baseLastGoodSnapshotPath(), "utf8")).toBe(BASE_COM_GATE);
  });
});

describe("o snapshot não pode inventar herança que ninguém declarou", () => {
  it("`_base` REMOVIDO apaga o snapshot — um template apagado de propósito não volta a ser servido", async () => {
    await writeBase(BASE_COM_GATE);
    await readBoardConfig("acme");
    expect(await snapshotExiste()).toBe(true);

    // Remover o `_base` é decisão legítima do operador (herança no-op). Se o snapshot sobrevivesse, um
    // `_base` torto criado depois ressuscitaria o template apagado como se fosse config viva.
    await fs.rm(BASE_FILE(), { force: true });
    await readBoardConfig("acme");

    expect(await snapshotExiste(), "o snapshot sobreviveu ao `_base` apagado — herança fantasma").toBe(false);
  });

  it("snapshot ILEGÍVEL não é servido, e o alarme diz em letras que os gates não estão valendo", async () => {
    // O caso residual: nem memória, nem disco utilizável. O desfecho continua sendo a UI viva (derrubar
    // todos os boards por um typo foi o incidente que a onda anterior consertou), mas ele NÃO pode ser
    // silencioso — o alarme tem de dizer que o pipeline está sem os gates herdados.
    await reiniciaProcesso();
    await plantaSnapshot("statuses:\n  - id: triage\n   name: torto\n");
    await writeBase(BASE_COM_TYPO);

    const config = await readBoardConfig("acme");

    expect(config.statuses.find((s) => s.id === "desenvolver")).toBeUndefined();
    const log = erros.join("\n");
    expect(log, "sem esta frase o operador não tem como saber que os gates herdados sumiram").toContain(
      "NÃO estão sendo aplicados",
    );
  });
});
