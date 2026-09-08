// A REGRA, num lugar só: nenhum SVG de pixel-art deste app declara `shape-rendering: crispEdges`.
//
// Ela parece o oposto do que se espera — "pixel-art quer aresta dura" — e por isso já foi escrita duas
// vezes no código e vai ser tentada de novo. O que ela de fato faz é ARREDONDAR CADA ARESTA
// INDEPENDENTEMENTE para o pixel de tela mais próximo. Consequências, medidas em Chrome headless:
//
//   • Onde a escala é INTEIRA (célula = número cheio de device pixels) o resultado é IDÊNTICO ao
//     padrão. Ela não ganha nada — a aresta já cai em pixel cheio e não há cobertura parcial.
//   • Onde a escala é FRACIONÁRIA ela DEFORMA. Peças do mesmo tamanho saem com tamanhos diferentes:
//       – mascote (grade 20, 40px, zoom 90% ou tela a 125%/175%): erro de espelhamento de 7,2% —
//         nó da antena descentrado, um olho maior que o outro, um pé mais largo;
//       – wordmark (grid 68×10 a size 13 = 1,3px por unidade, fracionário em QUALQUER tela): as duas
//         hastes do H rendendo 3px e 2px, uma 50% mais grossa que a outra.
//     Sem o atributo, a fração vira meio-tom: levemente suave, mas SIMÉTRICO e proporcional.
//
// Ou seja: o modo "crisp" custa zero onde não faz falta e cobra caro onde faz. Trocamos "duro e
// deformado" por "macio e fiel". Se for reintroduzir, MEÇA os dois nas duas escalas primeiro — e
// então esta trava vira a conversa, em vez de o defeito voltar calado até alguém abrir um print.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname; // packages/storymap-ui/src/
const PKG = join(SRC, ".."); // packages/storymap-ui/

/** Toda a pixel-art commitada, em qualquer forma: componente (JSX), gerador (o script que ESCREVE
 *  arte) e o asset já escrito (o SVG em public/). Antes isto varria só `.tsx`, e o buraco era real —
 *  o `icon.svg` do favicon nasce de `scripts/gen-icons.ts`, e nenhum dos dois é `.tsx`: dava para
 *  reintroduzir o modo crisp na superfície MAIS exposta do app (a aba) sem o teste piscar. */
const ESCOPO: ReadonlyArray<{ dir: string; ext: readonly string[] }> = [
  { dir: SRC, ext: [".tsx", ".ts"] },
  { dir: join(PKG, "scripts"), ext: [".ts"] },
  // `public` cobre .svg E .js: o `ah-overlay.js` carrega a SUA cópia do mascote (é vanilla de
  // propósito, para viajar até um embed que não tem React) — e era justamente lá que o modo crisp
  // sobrevivia, a 17px numa grade de 100, ou seja 0,17px por unidade: fração em qualquer tela.
  { dir: join(PKG, "public"), ext: [".svg", ".js"] },
];

/** Os arquivos que EMBARCAM. Testes ficam de fora de propósito — este aqui precisa citar a string
 *  como fixture (o caso positivo logo abaixo), e um teste não desenha nada na tela de ninguém. */
function files(dir: string, ext: readonly string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.some((e) => entry.endsWith(e)) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/** Casa as DUAS grafias: o atributo JSX (`shapeRendering="crispEdges"`) e o do SVG cru/gerado
 *  (`shape-rendering="crispEdges"`), com ou sem chaves e aspas no meio. */
const CRISP = /shape-?[rR]endering\s*[=:]\s*[{"']*\s*["']?crispEdges/;

/**
 * Tira COMENTÁRIOS antes de procurar — e isto não é detalhe, é o que torna a varredura possível.
 * Meia dúzia de arquivos deste pacote EXPLICAM por que o modo crisp está proibido, e a explicação
 * cita a string. Sem tirar comentário, a regra reprovaria justamente quem a documenta, e o reflexo
 * seria estreitar a regex até ela não pegar mais nada. `(^|[^:])//` preserva `http://…`.
 */
function semComentarios(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("pixel-art: nada de shape-rendering crisp", () => {
  it("nenhum componente, gerador ou asset declara crispEdges", () => {
    // Varre as árvores INTEIRAS em vez de citar arquivos: assim uma pixel-art NOVA (um ícone, um
    // selo, um sprite gerado) já nasce coberta, sem ninguém lembrar de estender o teste.
    const culpados = ESCOPO.flatMap(({ dir, ext }) => files(dir, ext))
      .filter((f) => CRISP.test(semComentarios(readFileSync(f, "utf8"))))
      .map((f) => f.slice(PKG.length));
    expect(culpados, `crispEdges de volta em: ${culpados.join(", ")} — leia o topo deste arquivo`).toEqual([]);
  });

  it("a varredura PEGA o defeito — a regex casa as duas grafias, fora de comentário", () => {
    // Uma trava que nunca viu um positivo é uma trava que ninguém sabe se funciona. Estes são os
    // dois jeitos reais de reintroduzir o atributo (JSX e SVG cru), mais o caso que deve passar.
    expect(CRISP.test(semComentarios(`<svg shapeRendering="crispEdges">`))).toBe(true);
    expect(CRISP.test(semComentarios(`<svg shape-rendering="crispEdges"/>`))).toBe(true);
    expect(CRISP.test(semComentarios(`// nada de shape-rendering="crispEdges" aqui`))).toBe(false);
  });

  it("o escopo da varredura é REAL — cada árvore declarada existe e tem arquivos", () => {
    // Um caminho errado aqui faria o teste passar varrendo o vazio, que é o pior estado possível:
    // verde sem cobrir nada. (Foi assim que `scripts/` e `public/` ficaram de fora por meses.)
    for (const { dir, ext } of ESCOPO) {
      expect(files(dir, ext).length, `${dir}: nenhum arquivo ${ext.join("/")} — escopo quebrado`).toBeGreaterThan(0);
    }
  });
});
