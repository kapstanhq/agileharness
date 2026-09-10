// TETO DE BYTES NA LEITURA DE CARD — os dois sítios do runner que o chokepoint (frontmatter.ts) não
// cobria ANTES do read (story-t9k1jf).
//
// ATAQUE: um card gigante entra na máquina por um caminho JÁ AUTENTICADO — a worktree do próprio run
// (a skill grava lá) ou um branch que o merge train integra. Não é preciso credencial nova: basta que
// o arquivo exista no instante em que o serviço for lê-lo. E o teto do chokepoint mede a STRING, que
// nesses dois sítios só existe DEPOIS de o processo materializar os bytes — recusar ali é recusar
// depois do dano, num serviço de longa duração que roda como root.
//
// O que cada caso crava (os dois sítios têm remédios DIFERENTES, e é o ponto):
//  - engine.ts (settle do run): a fonte é um ARQUIVO, logo existe `stat` → a recusa acontece ANTES do
//    `readFileSync`. O teste prova isso observando que o read NUNCA aconteceu — asserção sobre o
//    tamanho do resultado passaria mesmo com o furo aberto (os dois tetos devolvem o mesmo `null`).
//  - merge-queue.ts (3-way do split): a fonte é o STDOUT de um `git show`, logo NÃO existe `stat` — o
//    único ponto onde o volume ainda pode ser barrado é o `maxBuffer` do spawn. O teste crava que ele
//    é DECLARADO e igual ao teto do chokepoint; antes, o teto era o default de 1 MiB do
//    `child_process.exec` — um número acidental, que qualquer wrapper maior apaga em silêncio.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `readFileSync` é interceptado com PASSTHROUGH (o real é chamado, só registramos o caminho) porque a
// única prova de "recusou ANTES de ler" é a AUSÊNCIA do read: um arquivo acima do teto devolve `null`
// pelas duas rotas (stat-cap e parse-cap), então o desfecho não distingue nada. O contador vive DENTRO
// da factory (que é hoisted acima de qualquer `const` do módulo) e é lido de volta pela própria
// importação — nada de `vi.hoisted`, que não existe no runtime do Bun.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readPaths: string[] = [];
  const readFileSync = ((file: unknown, opts: unknown) => {
    readPaths.push(String(file));
    return (actual.readFileSync as (f: unknown, o: unknown) => unknown)(file, opts);
  }) as typeof actual.readFileSync;
  // O gêmeo ASSÍNCRONO conta no MESMO registro: os dois sítios leem a mesma árvore de run, e o teste
  // não pode passar por fechar só o caminho sync (foi essa meia-correção que a onda anterior evitou).
  const readFile = ((file: unknown, opts: unknown) => {
    readPaths.push(String(file));
    return (actual.promises.readFile as (f: unknown, o: unknown) => Promise<unknown>)(file, opts);
  }) as typeof actual.promises.readFile;
  const promises = { ...actual.promises, readFile };
  const patched = { ...actual, readFileSync, promises, __readPaths: readPaths };
  return { ...patched, default: patched };
});

import * as nodeFs from "node:fs";

import { frontmatterLimits } from "@/lib/storymap/frontmatter";
import { defaultReadCardStatus, readCardStatusFromTreeSync } from "./engine";
import { readCardAtRef } from "./merge-queue";
import type { ExecFn } from "./worktree";

const readPaths = (): string[] => (nodeFs as unknown as { __readPaths: string[] }).__readPaths;

/** Teto APERTADO só para o teste: um card real tem 55KB, e materializar 2MiB para provar a recusa
 *  seria testar o hardware, não o controle. O knob de env é o mesmo que o operador tem em produção. */
const TIGHT_CAP = 512;

const CARD = ["---", "id: story-teto", "title: Teto", "status: triage", "---", "corpo"].join("\n");

let tmpRoot: string;
let previousCap: string | undefined;

beforeEach(() => {
  previousCap = process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES;
  process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES = String(TIGHT_CAP);
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sm-bytecap-"));
  readPaths().length = 0;
});

afterEach(() => {
  if (previousCap === undefined) delete process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES;
  else process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES = previousCap;
  vi.restoreAllMocks();
  // A árvore do run é POR TESTE (o `beforeEach` acima cria uma nova). Sem esta remoção cada passada do
  // portão deixa um diretório em /tmp — a mesma dívida de inode que a revisão contou aos milhares. Vem
  // DEPOIS de restaurar os mocks: enquanto o `readFileSync` interceptado estiver de pé o teste ainda
  // pode tocar a árvore, e apagar antes trocaria lixo por erro de escrita intermitente.
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Planta um card na árvore de um run e devolve o caminho absoluto dele. */
function plantCard(board: string, cardId: string, body: string): string {
  const dir = path.join(tmpRoot, "storymap", "boards", board, "cards");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cardId}.md`);
  writeFileSync(file, body);
  return file;
}

describe("engine: card da worktree do run é recusado ANTES de entrar na memória", () => {
  it("card acima do teto NUNCA é lido do disco", () => {
    // O card hostil: frontmatter perfeitamente válido (o ataque não é YAML torto, é VOLUME), inflado
    // por um corpo que passa do teto. Sem o `stat`, o serviço carregava isto inteiro e só então recusava.
    const file = plantCard("storymap", "story-gigante", `${CARD}\n${"A".repeat(TIGHT_CAP * 4)}`);

    expect(readCardStatusFromTreeSync(tmpRoot, "storymap", "story-gigante")).toBeNull();
    expect(readPaths(), "os bytes do card acima do teto entraram no processo").not.toContain(file);
  });

  it("card dentro do teto continua sendo lido e avançando o run", () => {
    // O controle do controle: um teto que recusasse o card legítimo tiraria capacidade do agente (o
    // settle deixaria de ver o avanço da worktree e o run seria classificado como "não avançou").
    const file = plantCard("storymap", "story-normal", CARD);

    expect(readCardStatusFromTreeSync(tmpRoot, "storymap", "story-normal")).toBe("triage");
    expect(readPaths()).toContain(file);
  });

  it("o leitor ASSÍNCRONO da mesma árvore fecha o mesmo teto", async () => {
    // O settle usa o sync; o guard da falha-fantasma usa este. Mesma árvore de run, mesmo card, mesmo
    // ataque — fechar só um dos dois deixaria o card gigante entrar pelo outro e faria o comentário do
    // chokepoint mentir sobre engine.ts.
    const file = plantCard("storymap", "story-gigante-async", `${CARD}\n${"A".repeat(TIGHT_CAP * 4)}`);

    await expect(defaultReadCardStatus("storymap", "story-gigante-async", tmpRoot)).resolves.toBeNull();
    expect(readPaths(), "os bytes do card acima do teto entraram no processo").not.toContain(file);
  });

  it("card ausente na árvore do run segue sendo rotina (null, sem recusa)", () => {
    // `statSync` de arquivo ausente lança ENOENT — se o guard mudasse esse desfecho, todo run cujo card
    // não está na worktree passaria a parecer conteúdo hostil.
    expect(readCardStatusFromTreeSync(tmpRoot, "storymap", "story-inexistente")).toBeNull();
  });
});

describe("merge train: o teto do `git show` é DECLARADO no spawn, não herdado", () => {
  const CARD_REL = "storymap/boards/storymap/cards/story-teto.md";

  it("o `git show` do card roda com maxBuffer igual ao teto do chokepoint", async () => {
    // ATAQUE: um branch com um card de centenas de MB. O train LÊ esse card para decidir o 3-way, antes
    // de qualquer aterrissagem. Sem `maxBuffer` explícito o teto era o default do Node — e este mesmo
    // arquivo já eleva o maxBuffer a 64 MiB noutro caminho, então o número acidental não é confiável.
    const seen: { command: string; opts: Record<string, unknown> }[] = [];
    const exec: ExecFn = (async (command: string, opts: Record<string, unknown>) => {
      seen.push({ command, opts });
      return { stdout: CARD, stderr: "" };
    }) as unknown as ExecFn;

    const card = await readCardAtRef(exec, "/repo", "HEAD", CARD_REL);

    expect(card?.status).toBe("triage");
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toContain(`show "HEAD:${CARD_REL}"`);
    expect(seen[0].opts.maxBuffer, "o teto de bytes do `git show` não foi declarado").toBe(
      frontmatterLimits().maxBytes,
    );
  });

  it("estouro do teto vira null NOMEADO no log (não um card ausente silencioso)", async () => {
    // Quando o Node mata o `git` por volume, o desfecho tem de ser distinguível de "o card não existe
    // nesse lado": o primeiro é conteúdo hostil entrando pelo train, o segundo é rotina do merge.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec: ExecFn = (async () => {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    }) as unknown as ExecFn;

    expect(await readCardAtRef(exec, "/repo", "HEAD", CARD_REL)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("acima do teto de bytes");
  });

  it("card ausente no ref segue MUDO (o merge cai no patch de linhas, como sempre)", async () => {
    // Um `git show` de path deletado/renomeado sai não-zero. Isso é rotina em todo split; virar log
    // seria ruído que treina o operador a ignorar a linha que importa.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exec: ExecFn = (async () => {
      throw Object.assign(new Error("fatal: path does not exist"), { code: 128 });
    }) as unknown as ExecFn;

    expect(await readCardAtRef(exec, "/repo", "HEAD", CARD_REL)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
