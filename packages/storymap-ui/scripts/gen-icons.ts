#!/usr/bin/env bun
// GERA os ícones do navegador/PWA a partir da MESMA arte do mascote que a tela usa.
//
// Por que este arquivo existe: os PNGs de `public/` foram assados à mão uma vez (c48753be9) e
// **nunca tiveram produtor**. Quando o desenho do Jido mudou, o app passou a mostrar o mascote novo
// e a aba do navegador continuou com o velho — deriva silenciosa, do tipo que ninguém vê porque
// favicon a gente não olha, a gente reconhece. Com um gerador commitado, mexer em `mascot.ts` e
// rodar `bun run gen-icons` mantém as duas superfícies na mesma verdade.
//
// Ele NÃO usa navegador nem dependência nova: escreve o PNG na mão (RGB8 + zlib do próprio node),
// o que também é o jeito de garantir a única coisa que importa em pixel-art — **escala inteira**.
// Jogar a arte num resampler para chegar a 192px daria célula fracionária e devolveria a borra que a
// grade existe para impedir. Aqui um alvo declara só o ENQUADRAMENTO que a prancha pede (67% da
// largura no quadrado cheio, 52% no maskable) e a célula sai DERIVADA daí (`cellFor`) — o maior
// inteiro que mais se aproxima. O que sobra vira margem, e `buildTarget` recusa um alvo que fuja da
// tolerância; o teste ainda prova que nenhum outro inteiro chegaria mais perto.
//
// Duas artes, como na prancha (o porquê longo está no topo de `mascot.ts`): a MESTRA de 50 células
// para os ícones de app (≥180px) e a MICRO de 16 para a aba (≤48px), onde a mestra colapsaria.
//
// Uso: `bun run gen-icons` (de packages/storymap-ui). Sobrescreve os arquivos de public/.
// Mexeu na arte? `bun run gen-icons` **e** (para as telas de abertura) `bun run build && bun run
// gen-splash` — o `mascot-icons.test.ts` reprova o commit que esquecer o primeiro.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, BODY, MICRO, MICRO_GRID, RESTING, pathOf, type Pixel } from "../src/lib/storymap/copilot/mascot";

// A cara da MARCA (dois olhos, sem boca — o card 3a/5a da prancha), a mesma do login. O ícone é
// identidade, não estado do copiloto: um humor aqui prometeria que o app está sentindo alguma coisa
// enquanto ninguém o abriu.
const ART = RESTING;

/** #191919 — o fundo dos cards 5a–5g e o `background_color` do manifest.webmanifest. */
const BG: RGB = [0x19, 0x19, 0x19];
/** #FFFFFF — a tinta do mascote nos cards 5a–5f, literal. (O `#F5F3EE` da prancha é do SPLASH, card
 *  5g, onde o desenho é grande e o branco puro pesaria; num ícone de 16px ele só apagaria contraste.) */
const FG: RGB = [0xff, 0xff, 0xff];

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

/**
 * QUAL DAS DUAS ARTES o alvo desenha — a mesma escada que a prancha do ícone descreve.
 *
 * `macro` é a mestra de 50 células (o corpo inteiro, cards 5a–5c); `micro` é o redesenho na grade de
 * 16 (card 5d). A régua é o tamanho: "de 32px para baixo as pernas e a antena colapsam; por isso
 * existe o 5d". Abaixo de 180px este conjunto usa a micro; de 180 para cima, a mestra.
 *
 * São só estas DUAS. Quando um tamanho apertar, o caminho é a `MICRO` — nunca um terceiro
 * enquadramento por CORTE (já houve um "busto" sem braços nem pernas aqui, e ele custava as pernas
 * do bicho justamente na superfície mais vista, a aba).
 */
type Art = "macro" | "micro";

interface Target {
  file: string;
  size: number;
  art: Art;
  /** Só `macro`: a fração da largura da moldura que o DESENHO ocupa, como manda a prancha (5a = 67%,
   *  5c = 52%). A `micro` não tem: ela enquadra a GRADE inteira de 16, que já traz a margem do 5d. */
  ratio?: number;
  /**
   * FUNDO TRANSPARENTE (PNG com canal alfa) em vez do quadrado `#191919`.
   *
   * Existe para UM caso, e é um caso real: o `badge` de notificação. O Android descarta a cor do
   * badge e usa **só o canal alfa** como estêncil — um PNG opaco vira, na barra de status, um
   * CÍRCULO BRANCO CHAPADO, sem mascote nenhum. Era o que acontecia (o `sw.js` apontava o badge para
   * o `icon-192.png`, opaco): a notificação do AgileHarness não tinha cara. Com alfa, o estêncil é a
   * silhueta do Jido — e os olhos, que aqui são furo, viram furo no estêncil também.
   */
  alpha?: boolean;
}

/**
 * Quantos pixels vale UMA CÉLULA neste alvo. É DERIVADO, nunca declarado — e essa é a diferença
 * entre um número certo e um número que alguém acertou uma vez.
 *
 * A conta tem duas restrições que brigam: a prancha pede uma FRAÇÃO da largura (67% / 52%) e a
 * pixel-art exige célula INTEIRA. Como não existe inteiro que dê exatamente 67% em toda moldura,
 * alguém tem de ceder — e quem cede é a fração, sempre, porque célula fracionária devolve ao ícone a
 * borra que a grade existe para impedir. Arredondar é portanto a resposta ÓTIMA, não um chute: de
 * todos os inteiros possíveis, este é o que menos se afasta do pedido do design. (Ex.: no
 * apple-touch de 180px o ideal seria 2,87px/célula; 3 dá 70,0% e 2 daria 46,7% — 3 é o melhor que
 * existe, e o teste de tolerância confirma que "o melhor" ainda é perto o bastante.)
 */
export function cellFor(t: Target): number {
  if (t.art === "micro") return t.size / MICRO_GRID; // 16/32/48 → 1/2/3, exato por construção
  return Math.max(1, Math.round((t.ratio! * t.size) / frame("macro").w));
}

/** O que a prancha pede em cada enquadramento, e a folga que a célula inteira nos custa. */
const RATIO_FULL = 0.67; // cards 5a/5b — quadrado cheio e squircle do iOS
const RATIO_MASKABLE = 0.52; // card 5c — o mínimo seguro para o recorte circular do Android
/** Tolerância entre o pedido da prancha e o que a célula INTEIRA permite. Célula fracionária
 *  devolveria a borra que a grade proíbe, então quem cede é a fração — nunca a nitidez. */
const RATIO_TOLERANCE = 0.04;

export const TARGETS: Target[] = [
  // A ABA (≤48px) — a arte MICRO, corpo inteiro, cada célula um pixel cheio (1, 2 e 3px).
  { file: "favicon-16.png", size: 16, art: "micro" },
  { file: "favicon-32.png", size: 32, art: "micro" },
  { file: "favicon-48.png", size: 48, art: "micro" },
  // O ÍCONE DE APP (≥180px) — a mestra, a 67% da largura como no card 5a.
  { file: "apple-touch-icon.png", size: 180, art: "macro", ratio: RATIO_FULL },
  { file: "icon-192.png", size: 192, art: "macro", ratio: RATIO_FULL },
  { file: "icon-512.png", size: 512, art: "macro", ratio: RATIO_FULL },
  // MASKABLE (card 5c): o launcher recorta em círculo/squircle e só garante os 80% centrais (⌀410 em
  // 512). A 6px/célula o desenho dá 252×192, cuja DIAGONAL (317) cabe folgada nesse círculo — a conta
  // que importa é a diagonal, não o lado: um quadrado que "cabe" pela largura ainda tem os cantos
  // decepados. `buildTarget` confere essa diagonal, não a nossa palavra.
  { file: "icon-maskable-512.png", size: 512, art: "macro", ratio: RATIO_MASKABLE },
  // BADGE da notificação (Android): estêncil de ALFA, não imagem. 96px na grade micro dá 6px/célula
  // exatos, e é o tamanho que o Android reamostra para os 24dp da barra de status sem inventar borda.
  { file: "badge-96.png", size: 96, art: "micro", alpha: true },
];

/** O `.ico` da aba embala estes três (PNG dentro de ICO — suportado por todo navegador atual). */
export const ICO_SIZES = [16, 32, 48];

// ── pintura ─────────────────────────────────────────────────────────────────

/** As peças de cada arte: o que pinta (`solids`) e o que fura (`cuts`). */
function artOf(art: Art): { solids: readonly Pixel[]; cuts: readonly Pixel[] } {
  if (art === "micro") return { solids: MICRO.solids, cuts: MICRO.cuts };
  const [armL, armR] = ARMS[ART.arms];
  return { solids: [...BODY, armL, armR], cuts: ART.cuts };
}

/**
 * A CAIXA de enquadramento — e os dois enquadramentos são diferentes de propósito.
 *
 * `macro` enquadra pela caixa que o DESENHO ocupa (a bbox), porque a prancha fala em fração do
 * desenho ("o mascote ocupa 67% da largura"): medir pela grade faria a margem morta da viewBox virar
 * borda do ícone e o bicho encolher sem ninguém pedir.
 *
 * `micro` enquadra pela GRADE inteira de 16 — que é literalmente o card 5d: a viewBox `0 0 16 16` a
 * 16px, com a margem de 1 célula nas laterais e 3 no topo fazendo parte do desenho. Recortar pela
 * bbox aqui coloraria o bicho até a borda e mataria o ar que faz o quadrado preto ter presença na
 * aba (card 5e).
 */
function frame(art: Art): { x: number; y: number; w: number; h: number } {
  if (art === "micro") return { x: 0, y: 0, w: MICRO_GRID, h: MICRO_GRID };
  const rects = artOf("macro").solids;
  const x = Math.min(...rects.map((r) => r[0]));
  const y = Math.min(...rects.map((r) => r[1]));
  const x2 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y2 = Math.max(...rects.map((r) => r[1] + r[3]));
  return { x, y, w: x2 - x, h: y2 - y };
}

export function render(t: Target): Buffer {
  const { size, art } = t;
  const cell = cellFor(t);
  const { solids, cuts } = artOf(art);
  const box = frame(art);

  // 4 canais quando o alvo é estêncil (RGBA), 3 quando é o quadrado opaco da prancha (RGB).
  const ch = t.alpha ? 4 : 3;
  const px = new Uint8Array(size * size * ch);
  const clear: RGBA = t.alpha ? [0, 0, 0, 0] : [...BG, 255];
  for (let i = 0; i < size * size; i++) for (let k = 0; k < ch; k++) px[i * ch + k] = clear[k];

  // sobra dividida igualmente em CADA eixo → a figura (mais larga que alta) fica centrada nos dois,
  // como nos cards 5a/5c, onde o mascote tem a MESMA folga em cima e embaixo.
  const padX = Math.floor((size - box.w * cell) / 2);
  const padY = Math.floor((size - box.h * cell) / 2);
  const paint = (rects: readonly Pixel[], c: RGBA) => {
    for (const [x, y, w, h] of rects) {
      for (let j = 0; j < h * cell; j++) {
        for (let i = 0; i < w * cell; i++) {
          const gx = padX + (x - box.x) * cell + i;
          const gy = padY + (y - box.y) * cell + j;
          if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
          const o = (gy * size + gx) * ch;
          for (let k = 0; k < ch; k++) px[o + k] = c[k];
        }
      }
    }
  };
  paint(solids, [...FG, 255]);
  // os olhos são FURO: revelam o fundo no ícone, e no estêncil viram alfa 0 — que é o que faz o
  // Android desenhar um olho de verdade em vez de um borrão preenchido.
  paint(cuts, clear);
  return png(px, size, size, ch);
}

// ── O favicon VETORIAL ──────────────────────────────────────────────────────
// Todo navegador atual prefere um `icon.svg` quando existe, e é a única forma do ícone da aba ficar
// nítido em QUALQUER densidade de tela e em qualquer zoom — o PNG de 32 num monitor a 175% é
// reamostrado pelo navegador, o SVG não. O desenho é o MESMO card 5d (a arte micro), então aba
// vetorial e aba rasterizada mostram o mesmo bicho; os PNGs continuam commitados como fallback.
//
// E ele segue a MESMA regra do resto do app: nada de `shape-rendering: crispEdges` (a trava vive em
// `components/pixel-art-rendering.test.ts`, que varre inclusive este script e o SVG que ele escreve).
// A aba parece o lugar onde o modo "crisp" finalmente valeria — é pixel-art pura, sem layout ao redor
// —, mas é justamente ali que a escala fracionária MORA: o navegador rasteriza 16px CSS em 16, 32 ou
// 48 device px (DPR 1/2/3, onde crisp e padrão dão o mesmo bitmap) **e também** em 20 ou 28 (telas a
// 125% e 175%), onde o modo crisp arredonda cada aresta por conta própria e devolve um olho maior que
// o outro. Meio-tom simétrico é melhor que pixel duro e torto — ainda mais num desenho de 16 células,
// onde um olho de 2 células que vira 3 é 50% de erro.

export function svgIcon(): string {
  const g = MICRO_GRID;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g} ${g}" width="${g}" height="${g}">`,
    `<title>AgileHarness</title>`,
    `<rect width="${g}" height="${g}" fill="${hex(BG)}"/>`,
    `<path fill="${hex(FG)}" fill-rule="nonzero" d="${pathOf(MICRO.solids, MICRO.cuts)}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

function hex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ── PNG (RGB8, sem filtro) ──────────────────────────────────────────────────

function png(pixels: Uint8Array, w: number, h: number, channels: 3 | 4 = 3): Buffer {
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filtro None
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type: 2 = truecolor, 6 = truecolor + alfa
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE: number[] | null = null;
function crc32(b: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** ICO = diretório + os PNGs inteiros embutidos (nada de BMP — é o formato que a web usa hoje). */
export function ico(images: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // 1 = ícone
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const dir: Buffer[] = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += img.png.length;
  }
  return Buffer.concat([head, ...dir, ...images.map((i) => i.png)]);
}

/** Onde os assets moram. Exportado para o teste de deriva comparar com o que está commitado.
 *  `fileURLToPath(import.meta.url)` e não `import.meta.dir`: o segundo é bun-ismo e sai `undefined`
 *  quando o vitest (node) importa este módulo — o teste morria no import antes de rodar. */
export const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** A fração da largura da moldura que o desenho REALMENTE ocupa neste alvo. É o número que a prancha
 *  cobra (67% / 52%), e ele é derivado — não declarado — para não haver como mentir no comentário. */
export function occupancy(t: Target): number {
  return (frame(t.art).w * cellFor(t)) / t.size;
}

/**
 * Valida o alvo e devolve os bytes. Fail-closed em quatro frentes, porque ninguém audita favicon — é
 * justamente por não se olhar que ele apodrece:
 *
 *  1. célula INTEIRA (a regra que faz pixel-art sobreviver ao redimensionamento);
 *  2. o desenho CABE na moldura (um alvo apertado cortaria pernas em silêncio);
 *  3. a `micro` fecha EXATO na moldura (16 células × N px = o tamanho — se sobrar, não é o card 5d);
 *  4. a `macro` fica dentro da tolerância do enquadramento da prancha, e o maskable cabe pela
 *     DIAGONAL no círculo de 80% que o Android garante.
 */
export function buildTarget(t: Target): Buffer {
  const cell = cellFor(t);
  if (cell < 1 || !Number.isInteger(cell)) throw new Error(`${t.file}: célula não-inteira (${cell})`);
  const box = frame(t.art);
  if (box.w * cell > t.size || box.h * cell > t.size) {
    throw new Error(`${t.file}: ${box.w}×${box.h} células a ${cell}px não cabem em ${t.size}px`);
  }
  if (t.art === "micro") {
    if (MICRO_GRID * cell !== t.size) {
      throw new Error(`${t.file}: a grade micro (${MICRO_GRID}) a ${cell}px dá ${MICRO_GRID * cell}px ≠ ${t.size}px`);
    }
  } else {
    if (t.ratio === undefined) throw new Error(`${t.file}: alvo macro sem enquadramento declarado`);
    const got = occupancy(t);
    if (Math.abs(got - t.ratio) > RATIO_TOLERANCE) {
      throw new Error(
        `${t.file}: ocupa ${(got * 100).toFixed(1)}% da largura, e a prancha pede ${(t.ratio * 100).toFixed(0)}% (±${RATIO_TOLERANCE * 100}pp)`,
      );
    }
    if (t.ratio === RATIO_MASKABLE) {
      // O launcher recorta em círculo: quem tem de caber é a DIAGONAL do desenho, não o lado.
      const diagonal = Math.hypot(box.w * cell, box.h * cell);
      const safe = t.size * 0.8;
      if (diagonal > safe) {
        throw new Error(`${t.file}: diagonal ${diagonal.toFixed(0)}px passa do círculo seguro de ${safe}px`);
      }
    }
  }
  return render(t);
}

/** O conjunto inteiro, em memória: nome do arquivo → bytes. É o que o teste compara com o disco. */
export function buildAll(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const bySize = new Map<number, Buffer>();
  for (const t of TARGETS) {
    const buf = buildTarget(t);
    out.set(t.file, buf);
    bySize.set(t.size, buf);
  }
  out.set("favicon.ico", ico(ICO_SIZES.map((size) => ({ size, png: bySize.get(size)! }))));
  out.set("icon.svg", Buffer.from(svgIcon(), "utf8"));
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
// Só escreve quando RODADO como script. Importado (pelo teste de deriva), o módulo é puro — um
// import com efeito colateral de escrever em public/ transformaria rodar a suíte em regenerar arte.

if (process.argv[1]?.includes("gen-icons")) {
  for (const [file, buf] of buildAll()) {
    writeFileSync(join(PUBLIC_DIR, file), buf);
    const t = TARGETS.find((x) => x.file === file);
    const detail = t
      ? `${t.size}px · ${cellFor(t)}px/célula · ${t.art} · ocupa ${(occupancy(t) * 100).toFixed(1)}% da largura`
      : file.endsWith(".svg")
        ? `vetorial · grade ${MICRO_GRID}`
        : `${ICO_SIZES.join("/")}px`;
    console.log(`  ${file.padEnd(24)} ${detail}`);
  }
}
