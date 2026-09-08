// A TRAVA DE DERIVA entre o mascote da tela e o mascote da aba do navegador.
//
// Este teste existe por causa de um bug concreto: os PNGs de `public/` foram assados à mão uma vez
// e nunca tiveram produtor, então quando a arte do Jido mudou o app passou a mostrar o desenho novo
// e a aba/PWA continuaram com o velho. Ninguém percebeu porque favicon não se lê, se reconhece — e
// um desenho errado que você reconhece é pior que um ausente.
//
// A régua é byte a byte contra o que `scripts/gen-icons.ts` produz AGORA, a partir de `mascot.ts`.
// Mexeu na arte e não rodou `bun run gen-icons`? Vermelho aqui, antes do merge. É o teste de
// PRODUTOR que faltava: não basta o gerador existir, ele tem de ser o dono dos bytes que estão no
// repositório.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ICO_SIZES, PUBLIC_DIR, TARGETS, buildAll, buildTarget, cellFor, occupancy, svgIcon } from "../../../../scripts/gen-icons";
import { ARMS, BODY, MICRO_GRID, RESTING, pathOf, type Pixel } from "./mascot";
// A MESMA transcrição que o mascot.test.ts consome — os 67%/52% não podem ser dois literais soltos.
import { PRANCHA } from "./prancha.fixture";

/**
 * Decodifica um PNG do NOSSO encoder (RGB8, filtro None, sem entrelace) para os pixels crus.
 *
 * A comparação é de PIXEL, não de byte, e isso é decisão e não conveniência: o arquivo commitado
 * sai do `bun run gen-icons` e o teste roda no node, cujo zlib comprime o mesmo conteúdo em bytes
 * diferentes. Um teste byte-a-byte ficaria vermelho por causa do compressor — e um teste que falha
 * por algo que não é o defeito acaba desligado. O que ele precisa provar é que o DESENHO na aba é
 * o desenho de `mascot.ts`; isso são os pixels.
 */
function pixels(buf: Buffer): { w: number; h: number; rgb: Buffer } {
  let off = 8; // pula a assinatura
  let w = 0;
  let h = 0;
  let canais = 3;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect(data[8], "profundidade de bit").toBe(8);
      expect([2, 6], "tipo de cor (2 = truecolor, 6 = + alfa)").toContain(data[9]);
      canais = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * canais;
  const rgb = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    expect(raw[row], `linha ${y}: filtro`).toBe(0);
    raw.copy(rgb, y * stride, row + 1, row + 1 + stride);
  }
  return { w, h, rgb };
}

describe("ícones do navegador/PWA — gerados da MESMA arte do mascote", () => {
  it("todo PNG commitado em public/ tem os MESMOS pixels que o gerador produz hoje", () => {
    for (const [file, expected] of buildAll()) {
      if (file.endsWith(".ico") || file.endsWith(".svg")) continue; // conferidos abaixo, cada um a seu modo
      const a = pixels(readFileSync(join(PUBLIC_DIR, file)));
      const b = pixels(expected);
      expect([a.w, a.h], `${file}: dimensões`).toEqual([b.w, b.h]);
      expect(
        a.rgb.equals(b.rgb),
        `${file} está DEFASADO do desenho — rode \`bun run gen-icons\` (mascot.ts mudou e o ícone não)`,
      ).toBe(true);
    }
  });

  it("todo alvo usa um número INTEIRO de pixels por célula", () => {
    // A regra que faz pixel-art sobreviver ao redimensionamento: nada de resampler, nada de fração.
    // Um alvo com célula fracionária devolveria ao ícone exatamente a borra que a grade proíbe.
    for (const t of TARGETS) {
      const cell = cellFor(t);
      expect(Number.isInteger(cell), `${t.file}: célula ${cell}`).toBe(true);
      expect(cell, `${t.file}: célula abaixo de 1px`).toBeGreaterThanOrEqual(1);
      expect(() => buildTarget(t), `${t.file}: não cabe na moldura`).not.toThrow();
    }
  });

  it("a célula escolhida é a ÓTIMA — nenhum outro inteiro chega mais perto da prancha", () => {
    // A prancha pede 67% / 52%; a célula inteira quase nunca dá o número exato. O que este teste
    // prova é que a diferença que sobra é IRREDUTÍVEL, e não desleixo: varremos todos os inteiros que
    // cabem na moldura e conferimos que nenhum se aproxima mais do pedido do design. (Sem isto, um
    // `cell` chutado passaria calado enquanto estivesse dentro da tolerância.)
    for (const t of TARGETS.filter((x) => x.art === "macro")) {
      const alvo = t.ratio!;
      const escolhido = Math.abs(occupancy(t) - alvo);
      const larguraEmCelulas = (occupancy(t) * t.size) / cellFor(t); // = a bbox, em células
      for (let c = 1; c * larguraEmCelulas <= t.size; c++) {
        const dist = Math.abs((c * larguraEmCelulas) / t.size - alvo);
        expect(dist, `${t.file}: ${c}px/célula chegaria mais perto de ${alvo}`).toBeGreaterThanOrEqual(
          escolhido - 1e-9,
        );
      }
    }
  });

  it("os números do enquadramento são os da PRANCHA, não uma preferência nossa", () => {
    // Sem esta checagem, `RATIO_FULL`/`RATIO_MASKABLE` em `gen-icons.ts` seriam dois números que
    // alguém escolheu, indistinguíveis de fidelidade ao design. Os valores esperados NÃO são
    // literais aqui: vêm da mesma transcrição que o `mascot.test.ts` usa para a anatomia
    // (`prancha.fixture.ts`), porque duas cópias da prancha divergem tão bem quanto duas cópias
    // do desenho — foi o que uma revisão independente apontou nesta própria suíte.
    const { quadradoCheio, maskable } = PRANCHA.enquadramento;
    const cheio = TARGETS.filter((t) => t.file !== "icon-maskable-512.png" && t.art === "macro");
    for (const t of cheio) expect(t.ratio, `${t.file}: o card 5a pede ${quadradoCheio * 100}%`).toBe(quadradoCheio);
    expect(TARGETS.find((t) => t.file === "icon-maskable-512.png")?.ratio, "o card 5c pede 52%").toBe(maskable);
  });

  it("o ENQUADRAMENTO é o da prancha: ~67% no quadrado cheio, ~52% no maskable", () => {
    // Este é o número que estava errado e ninguém via: o conjunto anterior desenhava o mascote a 87%
    // da largura — colado nas bordas, sem o ar que o card 5a mostra. A célula INTEIRA é inegociável,
    // então quem cede é a fração; a folga aceita é de 4 pontos percentuais, e `buildTarget` recusa
    // qualquer alvo fora dela (aqui só confirmamos que os alvos declarados vivem dentro da régua).
    for (const t of TARGETS.filter((x) => x.art === "macro")) {
      const got = occupancy(t);
      expect(Math.abs(got - t.ratio!), `${t.file}: ocupa ${(got * 100).toFixed(1)}%, prancha pede ${t.ratio! * 100}%`)
        .toBeLessThanOrEqual(0.04);
    }
  });

  it("os favicons usam a arte MICRO e fecham EXATO na grade de 16 (nada de busto)", () => {
    const abas = TARGETS.filter((t) => t.size <= 48);
    expect(abas.length, "16/32/48").toBe(3);
    for (const t of abas) {
      expect(t.art, `${t.file}: a aba é a arte do card 5d`).toBe("micro");
      expect(MICRO_GRID * cellFor(t), `${t.file}: a grade micro não fecha no tamanho`).toBe(t.size);
    }
    // e nenhum alvo grande usa a micro (seria o bicho de 16 células esticado num ícone de 512).
    for (const t of TARGETS.filter((x) => x.size >= 180)) expect(t.art, `${t.file}`).toBe("macro");
  });

  it("o mascote do overlay de feedback é o MESMO desenho, unidade por unidade", () => {
    // `public/ah-overlay.js` é vanilla de propósito — ele viaja para um embed que não tem React nem
    // este módulo, então carrega a SUA cópia da arte. Cópia sem trava é a definição de deriva: foi
    // assim que a aba e o app passaram meses mostrando bichos diferentes. A trava é esta — a cópia
    // vale, o desvio não. O overlay desenha na grade de 100 da prancha, que é a nossa × 2.
    const dobro = (p: Pixel): Pixel => [p[0] * 2, p[1] * 2, p[2] * 2, p[3] * 2];
    const solidos = pathOf([...BODY, ...ARMS[RESTING.arms]].map(dobro), []);
    const furos = pathOf([], RESTING.cuts.map(dobro));
    const overlay = readFileSync(join(PUBLIC_DIR, "ah-overlay.js"), "utf8");

    expect(overlay, `a silhueta do overlay divergiu de mascot.ts — esperado: ${solidos}`).toContain(solidos);
    expect(overlay, `os olhos do overlay divergiram — esperado: ${furos}`).toContain(furos);
    // e o furo é GEOMETRIA, não `<mask>`: máscara rasteriza num buffer próprio e devolve alpha
    // parcial na borda, o que a 17px pintava os olhos de cinza em vez de vazá-los. A régua é o USO
    // (`mask="url(...)"`), não a palavra — o comentário do próprio arquivo explica por que não usar.
    expect(overlay, "voltou a mascarar os olhos em vez de furar o caminho").not.toContain('mask="url(');
  });

  it("o icon.svg commitado é o que o gerador escreve — e sem `crispEdges`", () => {
    // O favicon vetorial é o que TODO navegador atual prefere: se ele driftar, a aba mostra um bicho
    // e o PNG de fallback mostra outro. Aqui a régua é o texto inteiro, não uma heurística.
    const disco = readFileSync(join(PUBLIC_DIR, "icon.svg"), "utf8");
    expect(disco, "icon.svg DEFASADO — rode `bun run gen-icons`").toBe(svgIcon());
    expect(disco, "a viewBox é a grade micro").toContain(`viewBox="0 0 ${MICRO_GRID} ${MICRO_GRID}"`);
    // a trava geral vive em components/pixel-art-rendering.test.ts; esta é a específica da aba, que
    // é justamente onde a escala fracionária (telas a 125%/175%) deformaria o desenho.
    expect(disco).not.toContain("crispEdges");
  });

  it("o favicon.ico embala os três PNGs declarados, e o cabeçalho ICO bate", () => {
    const ico = readFileSync(join(PUBLIC_DIR, "favicon.ico"));
    expect(ico.readUInt16LE(0), "reservado").toBe(0);
    expect(ico.readUInt16LE(2), "tipo (1 = ícone)").toBe(1);
    expect(ico.readUInt16LE(4), "quantidade de imagens").toBe(ICO_SIZES.length);
    for (const [i, size] of ICO_SIZES.entries()) {
      const entry = 6 + i * 16;
      expect(ico[entry], `entrada ${i}: largura`).toBe(size);
      expect(ico[entry + 1], `entrada ${i}: altura`).toBe(size);
      const len = ico.readUInt32LE(entry + 8);
      const off = ico.readUInt32LE(entry + 12);
      expect(off + len, `entrada ${i}: payload fora do arquivo`).toBeLessThanOrEqual(ico.length);
      // e o payload é MESMO um PNG (assinatura), não um BMP legado que navegador nenhum quer
      const payload = ico.subarray(off, off + len);
      expect([...payload.subarray(0, 4)], `entrada ${i}: sem assinatura PNG`).toEqual([0x89, 0x50, 0x4e, 0x47]);
      // e o que ele desenha é o mesmo mascote do PNG solto daquele tamanho
      const target = TARGETS.find((t) => t.size === size)!;
      expect(pixels(payload).rgb.equals(pixels(buildTarget(target)).rgb), `entrada ${i}: desenho defasado`).toBe(
        true,
      );
    }
  });
});
