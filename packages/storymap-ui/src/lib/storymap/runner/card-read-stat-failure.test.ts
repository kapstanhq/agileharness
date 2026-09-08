// ATAQUE: desarmar o teto de bytes fazendo o `stat` FALHAR.
//
// O teto que protege a leitura de card na worktree do run é `assertStatWithinByteCap(size, …)`, e ele
// ignora `size` indefinido DE PROPÓSITO — falta de sinal não pode recusar trabalho legítimo. O gêmeo
// assíncrono media o tamanho com `(await fsp.stat(file).catch(() => null))?.size`, ou seja, engolia
// TODO erro de stat e entregava `undefined` ao teto. Consequência: quem conseguisse fazer o stat falhar
// (permissão, mount plantado dentro da worktree, `EIO`, um symlink em laço) transformava o guard em
// no-op, e o `readFile` seguinte materializava o card inteiro na memória do serviço — o dano que o teto
// existe para não deixar acontecer.
//
// A worktree do run é escrita pelo próprio agente, então plantar a condição ali não exige credencial
// nova: é a mesma lane já autenticada de que o teto de bytes se defende.
//
// A régua destes testes é se os BYTES ENTRARAM (o `readFile` aconteceu), não o valor devolvido: as duas
// rotas — recusa por teto e stat quebrado — devolvem o mesmo `null`, então uma asserção sobre o
// resultado ficaria verde com o furo aberto.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `promises.stat` é interceptado com uma lista de caminhos que devem falhar (o resto passa direto para o
// real), e `promises.readFile` com PASSTHROUGH que só registra o caminho — é o registro que prova se os
// bytes entraram. Tudo dentro da factory (hoisted acima de qualquer `const` do módulo), lido de volta
// pela própria importação: nada de `vi.hoisted`, que não existe no runtime do Bun.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readPaths: string[] = [];
  const statFail: { paths: string[]; code: string } = { paths: [], code: "EACCES" };
  const stat = ((file: unknown, opts?: unknown) => {
    if (statFail.paths.includes(String(file))) {
      return Promise.reject(
        Object.assign(new Error(`${statFail.code}: stat forçado a falhar pelo teste`), { code: statFail.code }),
      );
    }
    return (actual.promises.stat as (f: unknown, o?: unknown) => Promise<unknown>)(file, opts);
  }) as typeof actual.promises.stat;
  const readFile = ((file: unknown, opts: unknown) => {
    readPaths.push(String(file));
    return (actual.promises.readFile as (f: unknown, o: unknown) => Promise<unknown>)(file, opts);
  }) as typeof actual.promises.readFile;
  const promises = { ...actual.promises, stat, readFile };
  const patched = { ...actual, promises, __readPaths: readPaths, __statFail: statFail };
  return { ...patched, default: patched };
});

import * as nodeFs from "node:fs";

import { defaultReadCardStatus } from "./engine";

const readPaths = (): string[] => (nodeFs as unknown as { __readPaths: string[] }).__readPaths;
const statFail = (): { paths: string[]; code: string } =>
  (nodeFs as unknown as { __statFail: { paths: string[]; code: string } }).__statFail;

/** Teto APERTADO só para o teste: um card real tem 55KB, e materializar 2MiB para provar a recusa seria
 *  testar o hardware, não o controle. O knob de env é o mesmo que o operador tem em produção. */
const TIGHT_CAP = 512;

const CARD = ["---", "id: story-stat", "title: Stat", "status: triage", "---", "corpo"].join("\n");

let tmpRoot: string;
let previousCap: string | undefined;
let avisos: string[];

beforeEach(() => {
  previousCap = process.env.STORYMAP_FRONTMATTER_MAX_BYTES;
  process.env.STORYMAP_FRONTMATTER_MAX_BYTES = String(TIGHT_CAP);
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sm-statfail-"));
  readPaths().length = 0;
  statFail().paths.length = 0;
  statFail().code = "EACCES";
  avisos = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    avisos.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
});

afterEach(() => {
  if (previousCap === undefined) delete process.env.STORYMAP_FRONTMATTER_MAX_BYTES;
  else process.env.STORYMAP_FRONTMATTER_MAX_BYTES = previousCap;
  vi.restoreAllMocks();
  // A árvore do run é POR TESTE (o `beforeEach` acima cria uma nova). Sem esta remoção cada passada do
  // portão deixa um diretório em /tmp — a mesma dívida de inode que a revisão contou aos milhares. Vem
  // DEPOIS de restaurar os mocks: enquanto o `stat` instrumentado estiver de pé o teste ainda pode tocar
  // a árvore, e apagar antes trocaria lixo por erro de escrita intermitente.
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function plantCard(board: string, cardId: string, body: string): string {
  const dir = path.join(tmpRoot, "storymap", "boards", board, "cards");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cardId}.md`);
  writeFileSync(file, body);
  return file;
}

describe("engine (leitor assíncrono): stat quebrado não pode virar teto cego", () => {
  it("[ATAQUE] com o `stat` falhando por EACCES, o card gigante NÃO é lido do disco", () => {
    const file = plantCard("storymap", "story-eacces", `${CARD}\n${"A".repeat(TIGHT_CAP * 4)}`);
    statFail().paths.push(file);

    return expect(defaultReadCardStatus("storymap", "story-eacces", tmpRoot))
      .resolves.toBeNull()
      .then(() => {
        expect(
          readPaths(),
          "o stat falhou, o teto ficou sem sinal e os bytes do card entraram no processo de qualquer forma",
        ).not.toContain(file);
      });
  });

  it("a recusa por stat quebrado APARECE no log (não é um card ausente silencioso)", async () => {
    const file = plantCard("storymap", "story-log", CARD);
    statFail().paths.push(file);

    expect(await defaultReadCardStatus("storymap", "story-log", tmpRoot)).toBeNull();

    // Distinguir "não consegui medir" de "o card não está nesta árvore" é o que dá ao operador a chance
    // de ver a condição sendo plantada, em vez de ler o run como "não avançou".
    expect(avisos.join("\n")).toContain("storymap/story-log");
  });

  it("EIO / ELOOP têm o mesmo desfecho — a régua é 'não é ausência', não uma lista de códigos", async () => {
    for (const code of ["EIO", "ELOOP", "EPERM"]) {
      readPaths().length = 0;
      statFail().paths.length = 0;
      statFail().code = code;
      const file = plantCard("storymap", `story-${code}`, `${CARD}\n${"A".repeat(TIGHT_CAP * 4)}`);
      statFail().paths.push(file);

      expect(await defaultReadCardStatus("storymap", `story-${code}`, tmpRoot)).toBeNull();
      expect(readPaths(), `stat ${code} deixou os bytes entrarem`).not.toContain(file);
    }
  });

  it("ausência do card segue sendo ROTINA: null, sem recusa e sem log", async () => {
    // O controle do controle. Se "não consigo medir" e "não existe" tivessem o mesmo tratamento, todo run
    // cujo card não está na worktree passaria a gerar aviso — e ruído treina o operador a ignorar a linha
    // que importa.
    expect(await defaultReadCardStatus("storymap", "story-nao-existe", tmpRoot)).toBeNull();
    expect(avisos).toEqual([]);
  });

  it("card dentro do teto com stat SADIO continua sendo lido (o teto não tira capacidade)", async () => {
    const file = plantCard("storymap", "story-ok", CARD);

    expect(await defaultReadCardStatus("storymap", "story-ok", tmpRoot)).toBe("triage");
    expect(readPaths()).toContain(file);
  });
});
