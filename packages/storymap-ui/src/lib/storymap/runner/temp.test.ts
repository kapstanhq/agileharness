// A RAIZ DE SCRATCH — e as provas de que ela não troca órfão por corrupção.
//
// A afirmação perigosa desta peça não é "limpa"; é "limpa SÓ o que pode". Um ceifador por idade
// apontado para o diretório errado, ou com janela curta demais, apaga o scratch de um processo VIVO —
// e isso é pior que os 1044 órfãos que ele existe para remover. Por isso metade das provas aqui é
// sobre o que ele NÃO toca.

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_TEMP_DIRNAME,
  VARREDURA_IDADE_MINIMA_MS,
  harnessTempRoot,
  makeHarnessTempDir,
  sweepHarnessTempRoot,
  withHarnessTempDir,
} from "./temp";

// Toda escrita deste arquivo acontece sob um TMPDIR próprio, para a varredura nunca alcançar o
// scratch real da máquina (inclusive o do serviço vivo, que roda enquanto a suíte roda).
const original = process.env.TMPDIR;
const areias: string[] = [];
function areiaPropria(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "temp-test-"));
  areias.push(dir);
  process.env.TMPDIR = dir;
  return dir;
}

afterEach(() => {
  if (original === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = original;
  while (areias.length > 0) rmSync(areias.pop() as string, { recursive: true, force: true });
});

describe("a raiz é UMA, e é derivada do TMPDIR", () => {
  it("um endereço só responde 'o que o harness deixou aqui?'", () => {
    const areia = areiaPropria();
    expect(harnessTempRoot()).toBe(path.join(areia, HARNESS_TEMP_DIRNAME));
  });

  it("segue o TMPDIR — é o que faz a jaula (que troca TMPDIR por run) continuar contida", () => {
    const a = areiaPropria();
    const raizA = harnessTempRoot();
    const b = areiaPropria();
    // O PAR: se a raiz fosse um literal `/tmp/agileharness`, as duas seriam iguais e a jaula
    // escreveria FORA do próprio TMPDIR.
    expect(harnessTempRoot()).not.toBe(raizA);
    expect(raizA.startsWith(a) && harnessTempRoot().startsWith(b)).toBe(true);
  });

  it("um prefixo hostil não escapa da raiz (ele vira NOME DE CAMINHO)", async () => {
    const areia = areiaPropria();
    const dir = await makeHarnessTempDir("../../fora");
    expect(dir.startsWith(harnessTempRoot()), `escapou: ${dir}`).toBe(true);
    expect(existsSync(path.join(areia, "fora"))).toBe(false);
  });
});

describe("withHarnessTempDir — o idioma que não vaza", () => {
  it("remove no caminho feliz E quando o corpo LANÇA (é o `finally` que importa)", async () => {
    areiaPropria();
    let visto = "";
    await withHarnessTempDir("ok", async (d) => {
      visto = d;
      expect(existsSync(d)).toBe(true);
    });
    expect(existsSync(visto), "não removeu no caminho feliz").toBe(false);

    // O PAR — e é o lado que separa este helper de um `rm` no fim da função: os 3 sites que vazaram
    // TINHAM remoção, só que num caminho que a exceção pulava.
    let doLanco = "";
    await expect(
      withHarnessTempDir("boom", async (d) => {
        doLanco = d;
        throw new Error("estourou no meio");
      }),
    ).rejects.toThrow(/estourou no meio/);
    expect(existsSync(doLanco), "o corpo lançou e o scratch ficou — é exatamente o defeito original").toBe(false);
  });

  it("uma falha ao LIMPAR não transforma trabalho bem-sucedido em exceção", async () => {
    areiaPropria();
    const r = await withHarnessTempDir("val", async (d) => {
      await fs.rm(d, { recursive: true, force: true }); // some por baixo do helper
      return 42;
    });
    expect(r).toBe(42);
  });
});

describe("a varredura remove o abandonado e NÃO toca no vivo", () => {
  it("remove o velho, preserva o recente — e o par é a mesma chamada", async () => {
    areiaPropria();
    const velho = await makeHarnessTempDir("orch");
    const recente = await makeHarnessTempDir("orch");
    const antigo = Date.now() - 48 * 60 * 60_000;
    await fs.utimes(velho, new Date(antigo), new Date(antigo));

    const r = await sweepHarnessTempRoot(24 * 60 * 60_000);
    expect(existsSync(velho), "não removeu o abandonado").toBe(false);
    expect(existsSync(recente), "removeu um scratch RECENTE — isso é apagar coisa viva").toBe(true);
    expect(r.removidos).toEqual([path.basename(velho)]);
  });

  it("a janela tem PISO — uma chamada desatenta não consegue varrer abaixo do teto de um run", async () => {
    areiaPropria();
    const dir = await makeHarnessTempDir("orch");
    // Idade menor que o piso, mas MAIOR que a janela pedida: sem o piso, isto seria removido.
    const idade = Date.now() - (VARREDURA_IDADE_MINIMA_MS - 60_000);
    await fs.utimes(dir, new Date(idade), new Date(idade));

    expect((await sweepHarnessTempRoot(1_000)).removidos, "o piso não segurou — varreu abaixo do teto de um run").toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("usa mtime, não nascimento: um scratch ANTIGO que ainda está sendo escrito sobrevive", async () => {
    areiaPropria();
    const dir = await makeHarnessTempDir("orch");
    const nascimento = Date.now() - 72 * 60 * 60_000;
    await fs.utimes(dir, new Date(nascimento), new Date(nascimento));
    // Um processo vivo escreve nele AGORA.
    await fs.writeFile(path.join(dir, "vivo.txt"), "x");
    await fs.utimes(dir, new Date(), new Date());
    expect((await sweepHarnessTempRoot(24 * 60 * 60_000)).removidos).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("raiz inexistente é silêncio, não erro — o primeiro boot de uma instalação nova", async () => {
    areiaPropria();
    expect(existsSync(harnessTempRoot())).toBe(false);
    await expect(sweepHarnessTempRoot()).resolves.toEqual({ removidos: [], erros: 0 });
  });

  it("NÃO alcança nada fora da raiz — o vizinho em /tmp não é problema dela", async () => {
    const areia = areiaPropria();
    const vizinho = path.join(areia, "orch-de-outra-ferramenta");
    await fs.mkdir(vizinho, { recursive: true });
    const antigo = Date.now() - 72 * 60 * 60_000;
    await fs.utimes(vizinho, new Date(antigo), new Date(antigo));
    await makeHarnessTempDir("orch"); // garante que a raiz existe
    await sweepHarnessTempRoot(24 * 60 * 60_000);
    expect(existsSync(vizinho), "varreu FORA da própria raiz").toBe(true);
  });
});
