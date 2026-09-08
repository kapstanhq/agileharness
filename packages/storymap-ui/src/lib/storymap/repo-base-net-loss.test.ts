// CENÁRIO: a REDE que segura os gates herdados desaparece sem ninguém ver.
//
// A onda 1.6 fechou o restart com um snapshot em disco do último `_base` bom (repo-base-lastgood.test.ts).
// Mas a escrita desse snapshot falha ABERTO — `persistBaseLastGood` só logava um `console.warn` —, então
// uma instalação que JÁ parseou o `_base` com sucesso pode ficar SEM cópia em disco (disco cheio,
// permissão, corrida entre dois processos) e voltar ao modo de falha que a onda 1.6 tinha eliminado: o
// próximo restart com o `_base` torto desliga a herança inteira, todo gate que só vive no `_base`
// desaparece e o board segue parecendo funcional.
//
// Pior: o alarme do caminho residual AFIRMAVA que isso só era alcançável numa instalação em que o `_base`
// nunca parseou ("erro de instalação, não perda de um estado que funcionava") — uma leitura errada do
// próprio código, que mandava o operador caçar um typo de YAML quando o problema era o disco.
//
// Estes testes medem as duas metades do remédio: a perda da rede é ALARMADA nomeando a consequência (e o
// alarme diz a verdade sobre a causa), e ela é RE-TENTADA — uma causa transitória não deixa a instalação
// descoberta até a próxima edição do `_base`.
//
// Nota sobre o mock de `./paths`: espalha o módulo REAL e relocaliza só a raiz para um tmp (mesmo padrão
// de repo-base-lastgood.test.ts) — jamais um dir de board vivo, e jamais o `.runner` do serviço.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = path.join(os.tmpdir(), "ah-base-net-loss-test");
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

/** O board declara UM passo próprio SEM gate e herda o resto: é essa ausência que torna a perda da
 *  herança mensurável — se ela cair, não sobra nenhuma verificação no pipeline. */
const OWN_BOARD = "id: acme\nname: Nest\nstatuses:\n  - id: triage\n    name: Triagem\n";
const BASE_COM_GATE =
  "statuses:\n  - id: triage\n    name: Triagem\n  - id: desenvolver\n    name: Desenvolver\n    gate: hasTasks\n";
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

/**
 * Faz a ESCRITA do snapshot falhar sem tocar em permissão: um DIRETÓRIO no lugar do arquivo.
 *
 * `chmod` não serve aqui — o serviço (e a suíte) roda como root, e root ignora o bit de permissão. Um
 * diretório no caminho do snapshot faz o `rename` final estourar EISDIR, que é fielmente a classe de
 * falha real (o caminho existe mas não é gravável para nós), e ainda deixa a LEITURA do snapshot
 * inutilizável — exatamente o estado "não há rede".
 */
async function quebraAEscritaDoSnapshot(): Promise<void> {
  await fs.mkdir(baseLastGoodSnapshotPath(), { recursive: true });
}

async function conserta(): Promise<void> {
  await fs.rm(baseLastGoodSnapshotPath(), { recursive: true, force: true });
}

/** O reset mais próximo de um PROCESSO NOVO sem recarregar o módulo: com o `_base` ausente, `readBaseRaw`
 *  zera o último-bom em memória. Depois disto, tudo que a leitura seguinte souber veio do DISCO. */
async function reiniciaProcesso(): Promise<void> {
  await fs.rm(BASE_FILE(), { force: true });
  await readBoardConfig("acme");
}

let erros: string[];
let avisos: string[];

beforeEach(async () => {
  delete process.env.STORYMAP_FRONTMATTER_MAX_BYTES;
  erros = [];
  avisos = [];
  const junta = (destino: string[]) => (...args: unknown[]) =>
    void destino.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  vi.spyOn(console, "error").mockImplementation(junta(erros));
  vi.spyOn(console, "warn").mockImplementation(junta(avisos));
  await fs.mkdir(path.join(TMP_ROOT, "boards", "acme"), { recursive: true });
  await fs.writeFile(path.join(TMP_ROOT, "boards", "acme", "board.yaml"), OWN_BOARD, "utf8");
});

afterEach(async () => {
  await conserta(); // o diretório plantado no caminho do snapshot não pode vazar para o próximo teste
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("perder a REDE do último `_base` bom não pode ser silencioso", () => {
  it("[ATAQUE] a falha de escrita do snapshot ALARMA nomeando os gates que ficam sem rede", async () => {
    // O estado: `_base` saudável, board servindo normalmente — e a rede que o restart usaria NÃO foi
    // escrita. Um `console.warn` com o errno não é alarme: quem lê "não foi possível persistir" não tem
    // como saber que acabou de perder a única cópia que mantém os gates de pé depois de um restart.
    await quebraAEscritaDoSnapshot();
    await writeBase(BASE_COM_GATE);

    const config = await readBoardConfig("acme");

    // A capacidade não pode ser removida: o board saudável continua resolvendo com a herança.
    expect(config.statuses.find((s) => s.id === "desenvolver")?.gate).toBe("hasTasks");

    const log = erros.join("\n");
    expect(log, "a perda da rede saiu só como warn/errno — o operador não é avisado do que deixou de valer").toContain(
      "FALHA AO PERSISTIR",
    );
    expect(log, "o alarme não diz o que a falha CUSTA (os gates herdados num restart)").toContain("SEM REDE");
    expect(log).toContain("gates");
  });

  it("[ATAQUE] com a rede perdida, um restart com o `_base` torto acusa a ESCRITA, não um typo", async () => {
    // A combinação proibida: os gates herdados desaparecem e o alarme manda o operador para o lugar
    // errado. Antes, este caminho afirmava ser "erro de INSTALAÇÃO, não perda de um estado que
    // funcionava" — falso justamente quando a escrita do snapshot falhou.
    await quebraAEscritaDoSnapshot();
    await writeBase(BASE_COM_GATE);
    await readBoardConfig("acme"); // parseou bem, mas não deixou rede
    await reiniciaProcesso(); // e agora nem memória
    await writeBase(BASE_COM_TYPO);

    const config = await readBoardConfig("acme");

    // O desfecho segue sendo degradar (derrubar todos os boards por um typo foi o incidente da onda
    // anterior) — mas o alarme tem de dizer a verdade sobre a causa.
    expect(config.statuses.find((s) => s.id === "desenvolver")).toBeUndefined();
    const log = erros.join("\n");
    expect(log, "sem esta frase o operador não sabe que os gates herdados sumiram").toContain(
      "NÃO estão sendo aplicados",
    );
    expect(log, "o alarme culpa a instalação/YAML quando a causa real foi a ESCRITA do snapshot").toContain(
      "falha de ESCRITA",
    );
  });

  it("a rede se restabelece sozinha quando a causa passa — sem esperar uma edição do `_base`", async () => {
    // O memo do `_base` é por MTIME: sem uma re-tentativa, uma falha transitória (ENOSPC que passou,
    // corrida entre dois processos) congelava a instalação SEM rede até alguém editar o arquivo. Dias
    // descoberta por um erro que já tinha ido embora.
    await quebraAEscritaDoSnapshot();
    await writeBase(BASE_COM_GATE);
    await readBoardConfig("acme");
    await conserta();

    // A janela de re-tentativa é de 30s — o relógio anda, o `_base` NÃO é editado (mesmo mtime).
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    await readBoardConfig("acme");

    expect(
      await fs.readFile(baseLastGoodSnapshotPath(), "utf8").catch(() => null),
      "a rede não foi refeita: a instalação segue sem a cópia que mantém os gates de pé num restart",
    ).toBe(BASE_COM_GATE);
  });

  it("re-tentativa não vira write por request: dentro da janela a leitura ainda usa o memo", async () => {
    // O remédio não pode virar o problema — um `_base` re-lido e re-escrito a cada request seria o DoS
    // que a memoização por mtime existe para evitar.
    await quebraAEscritaDoSnapshot();
    await writeBase(BASE_COM_GATE);
    await readBoardConfig("acme");
    const alarmesDepoisDaPrimeira = erros.length;
    await conserta();

    await readBoardConfig("acme"); // mesmo instante, mesma mtime → memo
    await readBoardConfig("acme");

    expect(
      await fs.stat(baseLastGoodSnapshotPath()).catch(() => null),
      "persistiu dentro da janela — a re-tentativa está rodando a cada leitura",
    ).toBeNull();
    expect(erros.length, "o alarme repetiu por leitura — ruído é a forma mais comum de um aviso ser ignorado").toBe(
      alarmesDepoisDaPrimeira,
    );
  });
});
